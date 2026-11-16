/**
 * What Brain's Instantly campaigns measured, written as outcomes the outreach
 * funnel can model (COM-13-3, §94, §107).
 *
 * The outreach funnel (`funnel.ts` `mechanismsFromRows`) reads `cash_outcomes`,
 * and until now the only writer of a `CONTACT_RESULT` was `learning.ts`, which
 * learns only from a deal's own `CONTACT_BUYER` action. Brain's real outreach —
 * The Neighbor Card, the expansion businesses' campaigns and every campaign the
 * sales desk feeds — runs through campaigns in the owner's Instantly workspace,
 * never creates a deal action, and so never reached the funnel: production had
 * outreach and the funnel had "no mechanism to model". This reads each of those
 * campaigns' leads back from Instantly and records one `CONTACT_RESULT` per lead
 * once the provider's own record states a terminal answer:
 *
 *   - bounced (lead status −1)                       → CONTACT_UNDELIVERABLE
 *   - interest status won                            → BUYER_ACCEPTED
 *   - interest status not interested / lost          → BUYER_DECLINED
 *   - unsubscribed (−2), or the sales desk recorded
 *     an opt-out on the lead's reply                 → BUYER_DECLINED
 *   - any reply on record                            → BUYER_REPLIED
 *   - the sequence completed (3) with no reply       → BUYER_SILENT
 *
 * A lead still in an active or paused sequence records nothing: silence is
 * learned only from a terminal provider state, never from a clock here. One row
 * per lead, keyed by the campaign and Instantly's lead id, so a second pass
 * writes nothing, and the first terminal answer stands — exactly as
 * `learning.ts` treats a deal's contact. Messages are never recorded: a lead is
 * a prospect, an answer is an answer, and neither is a buyer or revenue.
 *
 * The mechanism is the campaign's own name — whatever the workspace calls it,
 * no category list. Brain's deal campaign (the one `perform.ts` sends through,
 * whose replies `instantlySync.ts` reads onto deals) is left out, because
 * `learning.ts` already learns it from the deals' own rows.
 *
 * The rows go to one project: the earliest-activated cash project whose
 * standing commercial authority permits CONTACT_BUYER. Any other project's tick
 * records nothing, so a campaign is never counted twice; with no such project,
 * or no Instantly key, or a read that fails, nothing is written and the pass
 * says why. Read-only toward Instantly.
 */
import { getDb } from '../../../db/database.ts';
import { insertOutcome } from '../../../repos/cashJourney.ts';
import { BRAIN_PRINCIPAL, actionContext, checkCommercialAuthority } from '../authority.ts';
import { CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME, defaultDeps, instantly, itemsOf, type Deps } from '../neighborCard.ts';
import { EXPANSION_CAMPAIGNS } from '../expansionOutreach.ts';
import { BRAIN_CAMPAIGN_NAME, BRAIN_CAMPAIGN_PREFIX, answerFromInterestStatus } from '../providers/instantly.ts';
import { INSTANTLY_CAMPAIGN_ENV, secretValue } from '../providers/config.ts';

/** The channel every campaign row carries. */
export const CAMPAIGN_CHANNEL = 'email (Instantly)';

/** Instantly's lead statuses that end a lead's sequence. */
const LEAD_BOUNCED = -1;
const LEAD_UNSUBSCRIBED = -2;
const LEAD_COMPLETED = 3;

/** A workspace allows 20 requests a minute; a full read is a few hundred leads, so every few hours is plenty. */
export const CAMPAIGN_OUTCOMES_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * The most Instantly requests one pass may issue.
 *
 * The workspace allows 20 requests a minute and this pass shares them with the
 * sales desk's reply sync and the sends that run on the same tick. A read
 * without a bound issued up to 20 campaign-list pages plus 50 lead pages per
 * matched campaign in one pass, and `instantly()` waits out each 429 for 20 s
 * or more, so a large workspace held `advanceJourney` (and every deal pass
 * after it in operate.ts) for minutes. One pass now spends at most this many
 * requests, never waits on a refusal, and a read that does not finish
 * continues from where it stopped on a later pass.
 */
export const CAMPAIGN_OUTCOMES_REQUEST_BUDGET = 6;
/** How soon a pass that stopped partway, at its budget or at a refusal, may continue. */
export const CAMPAIGN_OUTCOMES_CONTINUE_MS = 5 * 60 * 1000;
/** At most this many pages of 100 leads per campaign per full read. */
const MAX_LEAD_PAGES = 50;
/** At most this many pages of campaigns per full read. */
const MAX_CAMPAIGN_PAGES = 20;

export type CampaignContactResult =
  | 'CONTACT_UNDELIVERABLE'
  | 'BUYER_ACCEPTED'
  | 'BUYER_DECLINED'
  | 'BUYER_REPLIED'
  | 'BUYER_SILENT';

export interface CampaignLead {
  id: string;
  email: string | null;
  status: number | null;
  replies: number;
  interestStatus: number | null;
}

export interface CampaignOutcomesReport {
  /** Campaigns read this pass. */
  campaigns: number;
  /** Leads read across them. */
  leads: number;
  /** New CONTACT_RESULT rows written this pass. */
  recorded: number;
  /** Leads still in their sequence with no answer: nothing recorded for them. */
  pending: number;
  /** Why nothing was read or written, when that is the case. */
  skipped: string | null;
  /** Campaigns whose read failed, with why. A failure writes nothing for that campaign. */
  failed: { campaign: string; reason: string }[];
  /** Instantly requests this pass issued; never more than CAMPAIGN_OUTCOMES_REQUEST_BUDGET. */
  requests: number;
  /**
   * Why the read stopped before the end of the workspace, when it did: the
   * pass's request budget, or a refusal it would otherwise have waited out.
   * The next pass continues from the same place.
   */
  stoppedEarly: string | null;
}

function emptyReport(): CampaignOutcomesReport {
  return { campaigns: 0, leads: 0, recorded: 0, pending: 0, skipped: null, failed: [], requests: 0, stoppedEarly: null };
}

/** Thrown inside a pass when it must stop now and continue later. */
class PassStop extends Error {}

/**
 * The pass's own handle on Instantly: counts every request against the budget,
 * and turns the helper's back-off sleep into a stop, so a 429, a 5xx or a
 * network failure ends the pass at once instead of holding the tick.
 */
interface Budgeted {
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Record<string, unknown>>;
  spent: () => number;
}

function budgeted(deps: Deps, budget: number): Budgeted {
  let spent = 0;
  const noWait: Deps = {
    ...deps,
    sleep: async () => {
      throw new PassStop('Instantly refused or did not answer; the next pass continues instead of waiting here');
    },
  };
  return {
    spent: () => spent,
    call: async (method, path, body) => {
      if (spent >= budget) throw new PassStop(`this pass's ${budget}-request budget is spent; the next pass continues`);
      spent += 1;
      return instantly(noWait, method, path, body);
    },
  };
}

/** Where an unfinished read stopped, so the next pass continues rather than starting over. */
interface ReadCursor {
  /** Campaigns found so far, and whether the listing reached its end. */
  campaigns: { id: string; name: string }[];
  listAfter: string | undefined;
  listPages: number;
  listed: boolean;
  /** The campaign being read, the next lead page and how many pages it has used. */
  index: number;
  leadAfter: string | undefined;
  leadPages: number;
}

function freshCursor(): ReadCursor {
  return { campaigns: [], listAfter: undefined, listPages: 0, listed: false, index: 0, leadAfter: undefined, leadPages: 0 };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The terminal answer Instantly's record of one lead states, or null while it
 * states none. `optedOut` is the sales desk's own reading of the lead's reply.
 */
export function contactResultOf(lead: CampaignLead, optedOut = false): CampaignContactResult | null {
  if (lead.status === LEAD_BOUNCED) return 'CONTACT_UNDELIVERABLE';
  const answer = answerFromInterestStatus(lead.interestStatus);
  if (answer) return answer;
  if (lead.status === LEAD_UNSUBSCRIBED || optedOut) return 'BUYER_DECLINED';
  if (lead.replies > 0) return 'BUYER_REPLIED';
  if (lead.status === LEAD_COMPLETED) return 'BUYER_SILENT';
  return null;
}

/**
 * The project campaign outcomes belong to: the earliest-activated cash project
 * whose standing authority permits CONTACT_BUYER, or why there is none.
 */
export async function campaignOutcomeProject(): Promise<{ ok: true; projectId: string } | { ok: false; reason: string }> {
  const modes = await getDb().all<{ project_id: string }>(
    `SELECT project_id FROM cash_modes ORDER BY activated_at, id`,
  );
  for (const { project_id: projectId } of modes) {
    const decision = await checkCommercialAuthority(
      { projectId, action: 'CONTACT_BUYER', ...actionContext({ principal: BRAIN_PRINCIPAL }) },
      { record: false },
    );
    if (decision.ok) return { ok: true, projectId };
  }
  return { ok: false, reason: 'no cash project holds standing commercial authority to contact buyers' };
}

/**
 * List Brain's outreach campaigns in the workspace into the cursor, by name or
 * by a sales-desk lead row, less the deal campaign. Continues a listing an
 * earlier pass left unfinished.
 */
async function listBrainCampaigns(deps: Deps, api: Budgeted, cursor: ReadCursor): Promise<void> {
  const named = new Set<string>([CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME, ...EXPANSION_CAMPAIGNS.map((c) => c.name)]);
  const deskRows = await getDb().all<{ campaign_id: string }>(
    `SELECT DISTINCT campaign_id FROM sales_leads WHERE campaign_id IS NOT NULL ORDER BY campaign_id`,
  );
  const deskIds = new Set(deskRows.map((row) => row.campaign_id));
  const dealCampaignId = secretValue(INSTANTLY_CAMPAIGN_ENV, deps.env);

  while (!cursor.listed) {
    const after = cursor.listAfter;
    const answer = await api.call('GET', `/campaigns?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    cursor.listPages += 1;
    const rows = itemsOf(answer);
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : null;
      const name = typeof row.name === 'string' ? row.name : '';
      if (!id) continue;
      if (name === BRAIN_CAMPAIGN_NAME || (dealCampaignId && id === dealCampaignId)) continue;
      if (cursor.campaigns.some((one) => one.id === id)) continue;
      if (named.has(name) || deskIds.has(id) || name.startsWith(BRAIN_CAMPAIGN_PREFIX)) cursor.campaigns.push({ id, name: name || id });
    }
    cursor.listAfter = typeof answer.next_starting_after === 'string' ? answer.next_starting_after : undefined;
    if (!cursor.listAfter || rows.length === 0 || cursor.listPages >= MAX_CAMPAIGN_PAGES) {
      cursor.listed = true;
      cursor.campaigns.sort((a, b) => a.name.localeCompare(b.name));
    }
  }
}

/** One page of a campaign's leads, and where the next one starts (undefined at the end). */
async function leadPage(api: Budgeted, campaignId: string, after: string | undefined): Promise<{ leads: CampaignLead[]; next: string | undefined }> {
  const answer = await api.call('POST', '/leads/list', { campaign: campaignId, limit: 100, ...(after ? { starting_after: after } : {}) });
  const rows = itemsOf(answer);
  const leads: CampaignLead[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    leads.push({
      id: row.id,
      email: typeof row.email === 'string' ? row.email.toLowerCase() : null,
      status: num(row.status),
      replies: Math.max(0, num(row.email_reply_count) ?? 0),
      interestStatus: num(row.lt_interest_status),
    });
  }
  const next = typeof answer.next_starting_after === 'string' && rows.length > 0 ? answer.next_starting_after : undefined;
  return { leads, next };
}

/** Lead addresses the sales desk recorded an opt-out for, on one campaign. */
async function optedOutOn(campaignId: string): Promise<Set<string>> {
  const rows = await getDb().all<{ lead_email: string }>(
    `SELECT DISTINCT lead_email FROM sales_replies WHERE campaign_id = ? AND opt_out IS NOT NULL AND opt_out <> '' AND opt_out <> 'null'`,
    [campaignId],
  );
  return new Set(rows.map((row) => row.lead_email.toLowerCase()));
}

/** The pass after this time may read; set from the pacing, or sooner when a read stopped partway. */
const nextPassAt = new Map<string, number>();
const cursors = new Map<string, ReadCursor>();

/**
 * One pass for `projectId`. Records only when it is the campaign-outcome
 * project (see `campaignOutcomeProject`); `ownerProjectId` states that answer
 * when the caller already has it. `force` ignores the pacing.
 *
 * A pass issues at most `requestBudget` Instantly requests (default
 * CAMPAIGN_OUTCOMES_REQUEST_BUDGET) and never sleeps: a refusal ends it. What
 * it read is recorded page by page, so a pass that stops keeps every answer it
 * got, and the next pass — CAMPAIGN_OUTCOMES_CONTINUE_MS later — continues from
 * the same campaign and lead page. Only a read that reaches the end of the
 * workspace waits the full CAMPAIGN_OUTCOMES_EVERY_MS.
 */
export async function recordCampaignOutcomes(
  projectId: string,
  options: { deps?: Deps; now?: Date; force?: boolean; ownerProjectId?: string; requestBudget?: number } = {},
): Promise<CampaignOutcomesReport> {
  const report = emptyReport();
  const deps = options.deps ?? defaultDeps();
  if (!secretValue('INSTANTLY_API_KEY', deps.env)) {
    report.skipped = 'INSTANTLY_API_KEY is not configured';
    return report;
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (!options.force && nowMs < (nextPassAt.get(projectId) ?? -Infinity)) {
    report.skipped = 'read recently; the next pass reads again';
    return report;
  }
  const owner = options.ownerProjectId
    ? { ok: true as const, projectId: options.ownerProjectId }
    : await campaignOutcomeProject();
  if (!owner.ok) {
    report.skipped = owner.reason;
    return report;
  }
  if (owner.projectId !== projectId) {
    report.skipped = `campaign outcomes are recorded on project ${owner.projectId}`;
    return report;
  }

  const api = budgeted(deps, Math.max(1, Math.trunc(options.requestBudget ?? CAMPAIGN_OUTCOMES_REQUEST_BUDGET)));
  const cursor = cursors.get(projectId) ?? freshCursor();
  cursors.set(projectId, cursor);
  const stopAt = (why: string) => {
    report.stoppedEarly = why;
    report.requests = api.spent();
    nextPassAt.set(projectId, nowMs + CAMPAIGN_OUTCOMES_CONTINUE_MS);
    return report;
  };

  try {
    await listBrainCampaigns(deps, api, cursor);
  } catch (error) {
    if (error instanceof PassStop) return stopAt(error.message);
    // A refusal that is not a rate limit: the listing starts over next time.
    cursors.delete(projectId);
    nextPassAt.set(projectId, nowMs + CAMPAIGN_OUTCOMES_CONTINUE_MS);
    report.requests = api.spent();
    report.skipped = `the workspace's campaigns could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`;
    return report;
  }

  while (cursor.index < cursor.campaigns.length) {
    const campaign = cursor.campaigns[cursor.index]!;
    const optedOut = await optedOutOn(campaign.id);
    let done = false;
    while (!done) {
      let page: { leads: CampaignLead[]; next: string | undefined };
      try {
        page = await leadPage(api, campaign.id, cursor.leadAfter);
      } catch (error) {
        if (error instanceof PassStop) return stopAt(error.message);
        report.failed.push({ campaign: campaign.name, reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
        break;
      }
      if (cursor.leadPages === 0) report.campaigns += 1;
      cursor.leadPages += 1;
      report.leads += page.leads.length;
      for (const lead of page.leads) {
        const result = contactResultOf(lead, lead.email !== null && optedOut.has(lead.email));
        if (!result) {
          report.pending += 1;
          continue;
        }
        const fresh = await insertOutcome({
          projectId,
          opportunityId: `instantly-lead:${lead.id}`,
          kind: 'CONTACT_RESULT',
          mechanism: campaign.name,
          channel: CAMPAIGN_CHANNEL,
          valueText: result,
          basis: `instantly campaign ${campaign.id}; lead ${lead.id}: status ${lead.status ?? 'none'}, replies ${lead.replies}, interest ${lead.interestStatus ?? 'none'}`,
          requestKey: `outcome:campaign:${campaign.id}:${lead.id}:CONTACT_RESULT`,
        });
        if (fresh) report.recorded += 1;
      }
      cursor.leadAfter = page.next;
      done = !page.next || cursor.leadPages >= MAX_LEAD_PAGES;
    }
    cursor.index += 1;
    cursor.leadAfter = undefined;
    cursor.leadPages = 0;
  }

  // The whole workspace was read: the next read starts over, after the full pacing.
  cursors.delete(projectId);
  report.requests = api.spent();
  nextPassAt.set(projectId, nowMs + CAMPAIGN_OUTCOMES_EVERY_MS);
  return report;
}

/** Test seam: forget the pacing. */
export function resetCampaignOutcomePacing(): void {
  nextPassAt.clear();
  cursors.clear();
}
