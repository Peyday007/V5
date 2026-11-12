/**
 * Outbound buyer outreach through the owner's Instantly workspace (API v2).
 *
 * ---------------------------------------------------------------------------
 * Why Instantly, and what "sending" means there
 * ---------------------------------------------------------------------------
 *
 * The owner already runs Instantly (owner, 2026-11-09): warmed sending
 * accounts, campaigns and a unibox. Instantly does not send one email per API
 * call. A lead added to an **active** campaign is mailed by the campaign's
 * schedule from its sending accounts. So the CONTACT_BUYER effect here is:
 * add exactly one lead, carrying this offer's subject and body as its own
 * custom variables, to Brain's campaign — and activate that campaign if it is
 * not running. Both happen only inside the effect, and the effect runs only
 * under a standing CONTACT_BUYER grant (`perform.ts`), so no outreach is ever
 * activated without one.
 *
 * Everything else this module does sends nothing:
 *
 *  - reading the workspace (`readInstantlyWorkspace`): sending accounts, their
 *    health and daily limits, campaigns — the measured outreach capacity the
 *    quant engine reads;
 *  - preparing leads (`prepareInstantlyLeads`): a lead *list* is not a
 *    campaign, and nothing is mailed from one;
 *  - creating Brain's campaign (`ensureBrainCampaign`): created as a draft;
 *  - reading replies (`syncInstantlyReplies`): the unibox's received mail on
 *    Brain's campaign becomes `BUYER_REPLIED` observations on the deal the
 *    lead was added for, which `journey/learning.ts` turns into the measured
 *    reply rates the plan models.
 *
 * Brain never touches a campaign it did not create (its name starts with
 * `BRAIN_CAMPAIGN_PREFIX`) unless the deployment names one in
 * `BRAIN_INSTANTLY_CAMPAIGN_ID`: the owner's own campaigns keep running as
 * they are.
 *
 * ---------------------------------------------------------------------------
 * Effect class
 * ---------------------------------------------------------------------------
 *
 * EXTERNAL_OPAQUE, as for Resend: adding a lead has no idempotency key and the
 * engine's reconcile hook is asked by business id, which Instantly cannot be
 * searched by. One automated attempt; a timeout or 5xx is UNCERTAIN and waits
 * on a person. `skip_if_in_workspace` is always set, so a buyer the owner's
 * other campaigns already hold is never mailed twice across them.
 */
import type { AdapterHealth, EffectAdapter, EffectRequest, SendOutcome } from '../../effects/adapter.ts';
import { INSTANTLY_CAMPAIGN_ENV, INSTANTLY_KEY_ENV, messagingConfig, secretValue } from './config.ts';
import { providerRequest, type FetchLike, type ProviderAnswer } from './http.ts';
import { validateBuyerMessage } from './resend.ts';

export const INSTANTLY_ADAPTER_NAME = 'instantly.contact_buyer';
export const INSTANTLY_API = 'https://api.instantly.ai/api/v2';
/** Every campaign Brain creates is named with this, and only those are Brain's to change. */
export const BRAIN_CAMPAIGN_PREFIX = 'Brain · ';
export const BRAIN_CAMPAIGN_NAME = `${BRAIN_CAMPAIGN_PREFIX}buyer outreach`;
/** The campaign's one step mails each lead its own offer, from these custom variables. */
export const SUBJECT_VARIABLE = 'brain_subject';
export const BODY_VARIABLE = 'brain_body';
export const OPPORTUNITY_VARIABLE = 'brain_opportunity';

/** Account status 1 is Active; warmup -1 Banned, -3 Permanent suspension (Instantly v2). */
const HEALTHY_STATUS = 1;
const DEAD_WARMUP = new Set([-1, -3]);

interface Ctx {
  fetch: FetchLike;
  env: NodeJS.ProcessEnv;
}

function ctxOf(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Ctx {
  return { fetch: options.fetch ?? ((url, init) => fetch(url, init)), env: options.env ?? process.env };
}

async function call(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ProviderAnswer> {
  const key = secretValue(INSTANTLY_KEY_ENV, ctx.env);
  if (!key) return { kind: 'REFUSED', status: 0, category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `${INSTANTLY_KEY_ENV} is not configured, so nothing was sent` };
  return providerRequest({
    fetch: ctx.fetch,
    url: `${INSTANTLY_API}${path}`,
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function items(answer: ProviderAnswer): Record<string, unknown>[] {
  if (answer.kind !== 'OK') return [];
  const list = answer.body.items;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/* ------------------------------------------------------------------ */
/* Reading the workspace                                              */
/* ------------------------------------------------------------------ */

export interface InstantlyWorkspace {
  accounts: { email: string; status: number; warmupStatus: number | null; dailyLimit: number | null; healthy: boolean }[];
  campaigns: { id: string; name: string; status: number; brains: boolean }[];
  /** Sum of the healthy sending accounts' daily limits: the most the workspace can mail a day, shared by every campaign. */
  dailyCapacity: number;
  healthyAccounts: string[];
}

/** At most this many pages of each listing are read (100 a page). */
const MAX_PAGES = 5;

async function paged(ctx: Ctx, path: string): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const answer = await call(ctx, 'GET', `${path}${sep}limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    if (answer.kind !== 'OK') return { rows, error: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
    rows.push(...items(answer));
    const next = answer.body.next_starting_after;
    if (typeof next !== 'string' || next === '' || items(answer).length < 100) break;
    after = next;
  }
  return { rows, error: null };
}

/** Accounts and campaigns, read only. Never sends, never changes anything. */
export async function readInstantlyWorkspace(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: true; workspace: InstantlyWorkspace } | { ok: false; reason: string }> {
  const ctx = ctxOf(options);
  if (!secretValue(INSTANTLY_KEY_ENV, ctx.env)) return { ok: false, reason: `${INSTANTLY_KEY_ENV} is not configured` };
  const accounts = await paged(ctx, '/accounts');
  if (accounts.error) return { ok: false, reason: `reading sending accounts: ${accounts.error}` };
  const campaigns = await paged(ctx, '/campaigns');
  if (campaigns.error) return { ok: false, reason: `reading campaigns: ${campaigns.error}` };
  const acc = accounts.rows
    .filter((one) => typeof one.email === 'string')
    .map((one) => {
      const status = Number(one.status);
      const warmupStatus = one.warmup_status === null || one.warmup_status === undefined ? null : Number(one.warmup_status);
      const dailyLimit = typeof one.daily_limit === 'number' ? one.daily_limit : null;
      return { email: String(one.email), status, warmupStatus, dailyLimit, healthy: status === HEALTHY_STATUS && !(warmupStatus !== null && DEAD_WARMUP.has(warmupStatus)) };
    });
  const healthy = acc.filter((one) => one.healthy);
  return {
    ok: true,
    workspace: {
      accounts: acc,
      campaigns: campaigns.rows
        .filter((one) => typeof one.id === 'string')
        .map((one) => ({ id: String(one.id), name: String(one.name ?? ''), status: Number(one.status), brains: String(one.name ?? '').startsWith(BRAIN_CAMPAIGN_PREFIX) })),
      dailyCapacity: healthy.reduce((sum, one) => sum + (one.dailyLimit ?? 0), 0),
      healthyAccounts: healthy.map((one) => one.email),
    },
  };
}

/** The last workspace reading, so a plan read costs no request when one is fresh. */
let cachedCapacity: { at: number; value: { perDay: number; accounts: number } | null } | null = null;
export const CAPACITY_FRESH_MS = 10 * 60_000;

/**
 * The outreach a day the owner's healthy sending accounts can carry, measured
 * from Instantly — or null when Instantly is not the configured provider or
 * cannot be read. It is shared with the owner's other campaigns, so the plan
 * uses it as the top of the range it sweeps, never as Brain's own figure.
 */
export async function instantlyCapacity(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<{ perDay: number; accounts: number } | null> {
  const env = options.env ?? process.env;
  const reading = messagingConfig(env);
  if (reading.provider !== 'instantly' || !reading.configured) return null;
  const now = options.now ?? Date.now();
  if (cachedCapacity && now - cachedCapacity.at < CAPACITY_FRESH_MS) return cachedCapacity.value;
  const read = await readInstantlyWorkspace(options).catch(() => ({ ok: false as const, reason: 'unreadable' }));
  const value = read.ok && read.workspace.dailyCapacity > 0 ? { perDay: read.workspace.dailyCapacity, accounts: read.workspace.healthyAccounts.length } : null;
  cachedCapacity = { at: now, value };
  return value;
}

/**
 * The sending accounts in good standing out of all of them, from the same fresh workspace
 * reading `instantlyCapacity` uses: the reputation stage of an outreach funnel. Null when
 * Instantly is not the configured provider or cannot be read.
 */
export async function instantlySendingStanding(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<{ perDay: number; healthyAccounts: number; totalAccounts: number } | null> {
  const env = options.env ?? process.env;
  const reading = messagingConfig(env);
  if (reading.provider !== 'instantly' || !reading.configured) return null;
  const now = options.now ?? Date.now();
  if (cachedStanding && now - cachedStanding.at < CAPACITY_FRESH_MS) return cachedStanding.value;
  const read = await readInstantlyWorkspace(options).catch(() => ({ ok: false as const, reason: 'unreadable' }));
  const value = read.ok && read.workspace.accounts.length > 0
    ? { perDay: read.workspace.dailyCapacity, healthyAccounts: read.workspace.healthyAccounts.length, totalAccounts: read.workspace.accounts.length }
    : null;
  cachedStanding = { at: now, value };
  return value;
}
let cachedStanding: { at: number; value: { perDay: number; healthyAccounts: number; totalAccounts: number } | null } | null = null;

export function forgetInstantlyCapacity(): void {
  cachedCapacity = null;
  cachedRates = null;
  cachedStanding = null;
}

/** What the owner's own sends have measured, summed over every campaign in the workspace (§92). */
export interface InstantlyMeasuredRates {
  sent: number;
  replies: number;
  opportunities: number;
  bounced: number;
  /** Each campaign's own counts: what produced the record matters as much as the totals (§99). */
  campaigns: Array<{ name: string; sent: number; replies: number; opportunities: number; bounced: number; brainOwned: boolean }>;
}

/** Below this many sends a reply rate is noise, and the published range answers instead. */
export const MEASURED_RATES_MIN_SENT = 500;

let cachedRates: { at: number; value: InstantlyMeasuredRates | null } | null = null;

function count(row: Record<string, unknown>, key: string): number {
  const n = Number(row[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The reply and opportunity rates the owner's workspace has measured on its own
 * sends (read only: `GET /campaigns/analytics`), or null when Instantly is not
 * the configured provider (no request is made), cannot be read, or has sent too
 * few emails to say anything. An observed figure answers ahead of a published
 * estimate (§92); it is read at the same ten-minute freshness as the capacity.
 */
export async function instantlyMeasuredRates(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<InstantlyMeasuredRates | null> {
  const env = options.env ?? process.env;
  const reading = messagingConfig(env);
  if (reading.provider !== 'instantly' || !reading.configured) return null;
  const now = options.now ?? Date.now();
  if (cachedRates && now - cachedRates.at < CAPACITY_FRESH_MS) return cachedRates.value;
  const answer = await call(ctxOf(options), 'GET', '/campaigns/analytics').catch(() => null);
  let value: InstantlyMeasuredRates | null = null;
  if (answer && answer.kind === 'OK') {
    const body: unknown = answer.body;
    const rows = (Array.isArray(body) ? body : items(answer)) as unknown[];
    const total: InstantlyMeasuredRates = { sent: 0, replies: 0, opportunities: 0, bounced: 0, campaigns: [] };
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const one = row as Record<string, unknown>;
      const name = String(one['campaign_name'] ?? '');
      const c = { name, sent: count(one, 'emails_sent_count'), replies: count(one, 'reply_count_unique'), opportunities: count(one, 'total_opportunities'), bounced: count(one, 'bounced_count'), brainOwned: name.startsWith(BRAIN_CAMPAIGN_PREFIX) };
      total.sent += c.sent;
      total.replies += c.replies;
      total.opportunities += c.opportunities;
      total.bounced += c.bounced;
      total.campaigns.push(c);
    }
    value = total.sent >= MEASURED_RATES_MIN_SENT ? total : null;
  }
  // A failed read is not cached: the next plan asks again rather than trusting a gap for ten minutes.
  if (answer && answer.kind === 'OK') cachedRates = { at: now, value };
  return value;
}

/* ------------------------------------------------------------------ */
/* Brain's campaign (created as a draft) and lead lists               */
/* ------------------------------------------------------------------ */

/** The draft Brain's campaign is created as: one step mailing each lead its own offer. */
export function brainCampaignDefinition(input: { sendingAccounts: string[]; dailyLimit: number }): Record<string, unknown> {
  return {
    name: BRAIN_CAMPAIGN_NAME,
    campaign_schedule: {
      schedules: [
        {
          name: 'Weekdays',
          timing: { from: '09:00', to: '17:00' },
          days: { '1': true, '2': true, '3': true, '4': true, '5': true },
          timezone: 'America/Chicago',
        },
      ],
    },
    sequences: [{ steps: [{ type: 'email', delay: 0, variants: [{ subject: `{{${SUBJECT_VARIABLE}}}`, body: `{{${BODY_VARIABLE}}}` }] }] }],
    email_list: input.sendingAccounts,
    daily_limit: input.dailyLimit,
    stop_on_reply: true,
    link_tracking: false,
    open_tracking: false,
  };
}

/**
 * The campaign Brain's leads go to: the one the deployment names, else Brain's
 * own (found by name), else Brain's own created now as a draft — which mails
 * nobody until the authorized effect activates it.
 */
export async function ensureBrainCampaign(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; create?: boolean } = {}): Promise<{ ok: true; id: string; status: number | null; created: boolean } | { ok: false; reason: string }> {
  const ctx = ctxOf(options);
  const named = secretValue(INSTANTLY_CAMPAIGN_ENV, ctx.env);
  const read = await readInstantlyWorkspace(options);
  if (!read.ok) return read;
  if (named) {
    const found = read.workspace.campaigns.find((one) => one.id === named);
    if (!found) return { ok: false, reason: `${INSTANTLY_CAMPAIGN_ENV} names a campaign this workspace does not have` };
    return { ok: true, id: found.id, status: found.status, created: false };
  }
  const own = read.workspace.campaigns.find((one) => one.name === BRAIN_CAMPAIGN_NAME);
  if (own) return { ok: true, id: own.id, status: own.status, created: false };
  if (options.create === false) return { ok: false, reason: 'Brain has no campaign in this workspace yet' };
  if (read.workspace.healthyAccounts.length === 0) return { ok: false, reason: 'the workspace has no healthy sending account to mail from' };
  const answer = await call(ctx, 'POST', '/campaigns', brainCampaignDefinition({ sendingAccounts: read.workspace.healthyAccounts, dailyLimit: Math.max(1, Math.min(read.workspace.dailyCapacity, 300)) }));
  if (answer.kind !== 'OK' || typeof answer.body.id !== 'string') {
    return { ok: false, reason: `creating Brain's draft campaign: ${answer.kind === 'OK' ? 'no id returned' : answer.kind === 'REFUSED' ? answer.detail : answer.reason}` };
  }
  return { ok: true, id: answer.body.id, status: typeof answer.body.status === 'number' ? answer.body.status : 0, created: true };
}

export interface PreparedLead {
  email: string;
  companyName?: string | null;
  firstName?: string | null;
  website?: string | null;
  opportunityId?: string | null;
}

/**
 * Put leads Brain prepared into a lead list in the owner's workspace. A list
 * is not a campaign: nothing is mailed from it, so this needs no grant. Each
 * lead is skipped if the workspace already holds it.
 */
export async function prepareInstantlyLeads(input: { listName: string; leads: PreparedLead[]; fetch?: FetchLike; env?: NodeJS.ProcessEnv }): Promise<{ ok: true; listId: string; added: number; refused: number } | { ok: false; reason: string }> {
  const ctx = ctxOf(input);
  const lists = await paged(ctx, `/lead-lists?search=${encodeURIComponent(input.listName)}`);
  if (lists.error) return { ok: false, reason: lists.error };
  let listId = lists.rows.find((one) => one.name === input.listName)?.id as string | undefined;
  if (!listId) {
    const created = await call(ctx, 'POST', '/lead-lists', { name: input.listName });
    if (created.kind !== 'OK' || typeof created.body.id !== 'string') return { ok: false, reason: `creating the lead list: ${created.kind === 'OK' ? 'no id' : created.kind === 'REFUSED' ? created.detail : created.reason}` };
    listId = created.body.id;
  }
  let added = 0;
  let refused = 0;
  for (const lead of input.leads.slice(0, 500)) {
    const answer = await call(ctx, 'POST', '/leads', {
      list_id: listId,
      email: lead.email,
      company_name: lead.companyName ?? null,
      first_name: lead.firstName ?? null,
      website: lead.website ?? null,
      skip_if_in_workspace: true,
      custom_variables: lead.opportunityId ? { [OPPORTUNITY_VARIABLE]: lead.opportunityId } : {},
    });
    if (answer.kind === 'OK') added += 1;
    else refused += 1;
  }
  return { ok: true, listId, added, refused };
}

/* ------------------------------------------------------------------ */
/* The CONTACT_BUYER effect                                           */
/* ------------------------------------------------------------------ */

export function createInstantlyAdapter(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; namespace: string }): EffectAdapter {
  const ctx = (): Ctx => ctxOf({ fetch: options.fetch, env: options.env });
  return {
    name: INSTANTLY_ADAPTER_NAME,
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: options.namespace,
    validate: validateBuyerMessage,
    fingerprintInputs: (payload) => ({ requestKey: payload.requestKey, to: payload.to, subject: payload.subject, text: payload.text }),
    health(): AdapterHealth {
      const reading = messagingConfig(options.env ?? process.env);
      return reading.provider === 'instantly' && reading.configured
        ? { usable: true, reason: 'Instantly is configured with a workspace API key; leads go to Brain\'s campaign and are mailed from the workspace\'s sending accounts.' }
        : { usable: false, reason: `Instantly is not usable: missing or malformed ${reading.problems.join(', ')}.` };
    },
    async send(request: EffectRequest): Promise<SendOutcome> {
      const c = ctx();
      if (!secretValue(INSTANTLY_KEY_ENV, c.env)) {
        return { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `${INSTANTLY_KEY_ENV} is not configured, so nothing was sent` };
      }
      // Nothing is mailed until a lead sits in an active campaign; finding or drafting the campaign sends nothing.
      const campaign = await ensureBrainCampaign({ fetch: c.fetch, env: c.env });
      if (!campaign.ok) return { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `nothing was sent: ${campaign.reason}` };
      const payload = request.payload;
      const lead = await call(c, 'POST', '/leads', {
        campaign: campaign.id,
        email: payload.to,
        company_name: typeof payload.payer === 'string' ? payload.payer.slice(0, 200) : null,
        skip_if_in_workspace: true,
        custom_variables: {
          [SUBJECT_VARIABLE]: payload.subject,
          [BODY_VARIABLE]: payload.text,
          [OPPORTUNITY_VARIABLE]: request.businessId,
        },
      });
      if (lead.kind === 'REFUSED') return { kind: 'REJECTED', category: lead.category, retryable: lead.retryable, detail: lead.detail };
      if (lead.kind === 'UNKNOWN') return { kind: 'UNCERTAIN', reason: lead.reason };
      const leadId = lead.body.id;
      if (typeof leadId !== 'string' || leadId === '') {
        // Instantly skips a lead the workspace already holds, and then nobody new is mailed.
        return { kind: 'UNCERTAIN', reason: 'Instantly accepted the lead and returned no lead id (it may already be in the workspace)' };
      }
      // The lead is in the campaign; the campaign mails it only while active. Activated here, inside the granted effect.
      if (campaign.status !== 1) {
        const activated = await call(c, 'POST', `/campaigns/${campaign.id}/activate`, {});
        if (activated.kind === 'UNKNOWN') return { kind: 'UNCERTAIN', reason: `the lead was added (${leadId}) and activating the campaign gave no answer: ${activated.reason}` };
        if (activated.kind === 'REFUSED') {
          // The lead is held and nothing is mailed yet: a person must see that the campaign did not start.
          return { kind: 'UNCERTAIN', reason: `the lead was added (${leadId}) but the campaign did not activate (${activated.detail}), so it is not being mailed yet` };
        }
      }
      return { kind: 'CONFIRMED', receiptRef: leadId, receiptMeta: { provider: 'instantly', campaignId: campaign.id } };
    },
    redactReceipt: (meta) => ({ provider: meta.provider === 'instantly' ? 'instantly' : null, campaignId: typeof meta.campaignId === 'string' ? meta.campaignId : null }),
  };
}

/* ------------------------------------------------------------------ */
/* Replies                                                            */
/* ------------------------------------------------------------------ */

export interface InstantlyReply {
  emailId: string;
  leadId: string | null;
  lead: string | null;
  campaignId: string | null;
  at: string | null;
  autoReply: boolean;
}

/** Received mail on one campaign, newest first, read only. The unibox allows 20 requests a minute, so at most a few pages. */
export async function readInstantlyReplies(input: { campaignId: string; fetch?: FetchLike; env?: NodeJS.ProcessEnv; pages?: number }): Promise<{ ok: true; replies: InstantlyReply[] } | { ok: false; reason: string }> {
  const ctx = ctxOf(input);
  const out: InstantlyReply[] = [];
  let after: string | null = null;
  for (let page = 0; page < (input.pages ?? 3); page += 1) {
    const answer = await call(ctx, 'GET', `/emails?campaign_id=${encodeURIComponent(input.campaignId)}&email_type=received&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    if (answer.kind !== 'OK') return { ok: false, reason: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
    for (const one of items(answer)) {
      if (typeof one.id !== 'string') continue;
      // ue_type 2 is received; anything else on this filter is not a buyer's answer.
      if (one.ue_type !== undefined && one.ue_type !== null && Number(one.ue_type) !== 2) continue;
      out.push({
        emailId: one.id,
        leadId: typeof one.lead_id === 'string' ? one.lead_id : null,
        lead: typeof one.lead === 'string' ? one.lead : null,
        campaignId: typeof one.campaign_id === 'string' ? one.campaign_id : null,
        at: typeof one.timestamp_email === 'string' ? one.timestamp_email : typeof one.timestamp_created === 'string' ? one.timestamp_created : null,
        autoReply: Number(one.is_auto_reply ?? 0) === 1,
      });
    }
    const next = answer.body.next_starting_after;
    if (typeof next !== 'string' || next === '' || items(answer).length < 100) break;
    after = next;
  }
  return { ok: true, replies: out };
}

/**
 * A live, read-only check of the key and the workspace for an operator: what
 * Brain would mail from and with how much capacity, and whether Brain's
 * campaign exists. Sends nothing, creates nothing.
 */
export async function probeInstantly(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<{
  verdict: 'VERIFIED' | 'NOT_CONFIGURED' | 'REFUSED';
  detail: string;
  workspace?: InstantlyWorkspace;
}> {
  const env = options.env ?? process.env;
  const reading = messagingConfig(env);
  if (reading.provider !== 'instantly' || !reading.configured) {
    return { verdict: 'NOT_CONFIGURED', detail: reading.provider !== 'instantly' ? `BRAIN_MESSAGING_PROVIDER is ${reading.provider ?? 'unset'}, not instantly` : reading.problems.join(', ') };
  }
  const read = await readInstantlyWorkspace(options);
  if (!read.ok) return { verdict: 'REFUSED', detail: read.reason };
  const w = read.workspace;
  const brain = w.campaigns.find((one) => one.name === BRAIN_CAMPAIGN_NAME);
  return {
    verdict: 'VERIFIED',
    detail: `${w.healthyAccounts.length} of ${w.accounts.length} sending accounts healthy, ${w.dailyCapacity} a day between them; ${w.campaigns.length} campaign(s); Brain's campaign ${brain ? `${brain.id} status ${brain.status}` : 'not created yet (it is created as a draft at the first authorized contact)'}`,
    workspace: w,
  };
}

/* ------------------------------------------------------------------ */
/* One message to the owner                                           */
/* ------------------------------------------------------------------ */

export const INSTANTLY_OWNER_NOTICE_ADAPTER_NAME = 'instantly.notify_owner';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * One email to the owner, from one of the workspace's healthy sending accounts, through
 * Instantly's single-send endpoint (`POST /emails/test`) — never a lead, never a campaign,
 * so the owner's own notice is not outreach and touches no outreach figure.
 *
 * EXTERNAL_OPAQUE, as every send here is: Instantly offers no way to look a sent message up
 * by Brain's identity, so a timeout is UNCERTAIN and nothing resends it (invariant 26).
 */
export function createInstantlyOwnerNoticeAdapter(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; namespace: string }): EffectAdapter {
  const ctx = (): Ctx => ctxOf({ fetch: options.fetch, env: options.env });
  return {
    name: INSTANTLY_OWNER_NOTICE_ADAPTER_NAME,
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: options.namespace,
    validate: validateBuyerMessage,
    fingerprintInputs: (payload) => ({ requestKey: payload.requestKey, to: payload.to, subject: payload.subject, text: payload.text }),
    health(): AdapterHealth {
      return secretValue(INSTANTLY_KEY_ENV, options.env ?? process.env)
        ? { usable: true, reason: 'Instantly is configured with a workspace API key.' }
        : { usable: false, reason: `${INSTANTLY_KEY_ENV} is not configured.` };
    },
    async send(request: EffectRequest): Promise<SendOutcome> {
      const c = ctx();
      if (!secretValue(INSTANTLY_KEY_ENV, c.env)) {
        return { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `${INSTANTLY_KEY_ENV} is not configured, so nothing was sent` };
      }
      const accounts = await paged(c, '/accounts');
      if (accounts.error) return { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `nothing was sent: reading sending accounts: ${accounts.error}` };
      const sender = accounts.rows
        .filter((one) => typeof one.email === 'string' && Number(one.status) === HEALTHY_STATUS && !DEAD_WARMUP.has(Number(one.warmup_status)))
        .map((one) => String(one.email))
        .sort()[0];
      if (!sender) return { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: 'nothing was sent: the workspace has no healthy sending account' };
      const payload = request.payload;
      const text = String(payload.text);
      const answer = await call(c, 'POST', '/emails/test', {
        eaccount: sender,
        to_address_email_list: String(payload.to),
        subject: String(payload.subject),
        body: { text, html: `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>` },
      });
      if (answer.kind === 'REFUSED') return { kind: 'REJECTED', category: answer.category, retryable: answer.retryable, detail: answer.detail };
      if (answer.kind === 'UNKNOWN') return { kind: 'UNCERTAIN', reason: answer.reason };
      const id = typeof answer.body.id === 'string' && answer.body.id ? answer.body.id : `instantly-single-send:${String(payload.requestKey).slice(0, 80)}`;
      return { kind: 'CONFIRMED', receiptRef: id, receiptMeta: { provider: 'instantly' } };
    },
    redactReceipt: (meta) => ({ provider: meta.provider === 'instantly' ? 'instantly' : null }),
  };
}
