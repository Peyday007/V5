/**
 * The two places Brain buys sending inboxes (§110).
 *
 * - **Instantly** (`/api/v2/dfy-email-account-orders`): the only seller found,
 *   2026-11-14, whose *pre-warmed* inboxes can be ordered by a program. One
 *   pre-warmed domain is five Google inboxes: $65 now, $50 a month (quoted on
 *   the owner's workspace in simulation, nothing charged). It also sells new
 *   ones ($5 a mailbox a month + $15 a year a domain) and is the fallback for
 *   new inboxes when InboxKit is not connected. `simulation: true` returns the
 *   real price and validation without placing anything, so every order is
 *   quoted by the provider itself first.
 * - **InboxKit** (`api.inboxkit.com/v1/api`): the cheapest new inboxes with a
 *   full ordering API ($3 a mailbox a month, monthly billing). One order
 *   registers the domain, sets SPF/DKIM/DMARC, creates the mailboxes and
 *   exports them into the owner's Instantly through a connected sequencer;
 *   Instantly then warms them for free. It is paid from InboxKit's prepaid
 *   wallet, which refuses an order the wallet does not cover (HTTP 402) — so
 *   the wallet is a second, provider-held ceiling on top of Brain's own.
 *
 * Neither key ever leaves the request header (`providerRequest`, invariant 22).
 * A timeout or 5xx on an order is UNKNOWN, never "it did not happen" (26).
 */
import { providerRequest, type FetchLike, type ProviderAnswer } from '../cash/providers/http.ts';
import { INSTANTLY_API } from '../cash/providers/instantly.ts';
import { INSTANTLY_KEY_ENV, secretValue } from '../cash/providers/config.ts';

export const INBOXKIT_API = 'https://api.inboxkit.com/v1/api';
export const INBOXKIT_KEY_ENV = 'INBOXKIT_API_KEY';
export const INBOXKIT_WORKSPACE_ENV = 'INBOXKIT_WORKSPACE_ID';
/** WHOIS registrant for domains InboxKit registers: a JSON object of InboxKit's `contact_details` fields. */
export const INBOXKIT_CONTACT_ENV = 'INBOXKIT_CONTACT_JSON';
/** InboxKit's published Google/Microsoft mailbox price on monthly billing (inboxkit.com, 2026-11-14). */
export const INBOXKIT_MAILBOX_MONTHLY_CENTS = 300;
/** Google and Microsoft both cap a domain at five mailboxes, at every seller. */
export const MAILBOXES_PER_DOMAIN = 5;

export interface Ctx {
  fetch: FetchLike;
  env: NodeJS.ProcessEnv;
}

export function ctxOf(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Ctx {
  return { fetch: options.fetch ?? ((url, init) => fetch(url, init)), env: options.env ?? process.env };
}

export interface Mailbox {
  prefix: string;
  firstName: string;
  lastName: string;
}

/** A provider's own price for one domain's order, in cents. */
export interface Quote {
  valid: boolean;
  upfrontCents: number;
  monthlyCents: number;
  /** Why the provider would not take it, when it would not. */
  problem: string | null;
  raw: Record<string, unknown>;
}

export type OrderResult =
  | { kind: 'PLACED'; detail: string; receipt: Record<string, unknown> }
  | { kind: 'REFUSED'; detail: string; receipt: Record<string, unknown> }
  | { kind: 'UNKNOWN'; detail: string };

const cents = (dollars: unknown): number => Math.round(Number(dollars ?? 0) * 100);

function refusedOf(answer: Exclude<ProviderAnswer, { kind: 'OK' }>): OrderResult {
  return answer.kind === 'UNKNOWN' ? { kind: 'UNKNOWN', detail: answer.reason } : { kind: 'REFUSED', detail: answer.detail, receipt: {} };
}

/* ------------------------------------------------------------------ */
/* Instantly                                                           */
/* ------------------------------------------------------------------ */

async function instantly(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ProviderAnswer> {
  const key = secretValue(INSTANTLY_KEY_ENV, ctx.env);
  if (!key) return { kind: 'REFUSED', status: 0, category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `${INSTANTLY_KEY_ENV} is not configured` };
  return providerRequest({
    fetch: ctx.fetch,
    url: `${INSTANTLY_API}${path}`,
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 60_000,
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
}

export async function instantlyPrewarmedDomains(ctx: Ctx): Promise<{ ok: boolean; domains: string[]; detail: string }> {
  const answer = await instantly(ctx, 'POST', '/dfy-email-account-orders/domains/pre-warmed-up-list', {});
  if (answer.kind !== 'OK') return { ok: false, domains: [], detail: answer.kind === 'UNKNOWN' ? answer.reason : answer.detail };
  return { ok: true, domains: strings(answer.body.domains), detail: 'ok' };
}

export async function instantlySimilarDomains(ctx: Ctx, seed: string): Promise<string[]> {
  const answer = await instantly(ctx, 'POST', '/dfy-email-account-orders/domains/similar', { domain: seed, tlds: ['com', 'org'] });
  return answer.kind === 'OK' ? strings(answer.body.domains) : [];
}

/** The domains this workspace already holds through Instantly, cancelled or not. */
export async function instantlyOrderedDomains(ctx: Ctx): Promise<Set<string>> {
  const seen = new Set<string>();
  let after = '';
  for (let page = 0; page < 20; page += 1) {
    const answer = await instantly(ctx, 'GET', `/dfy-email-account-orders?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    if (answer.kind !== 'OK') break;
    const items = Array.isArray(answer.body.items) ? (answer.body.items as Record<string, unknown>[]) : [];
    for (const one of items) if (typeof one.domain === 'string') seen.add(one.domain.toLowerCase());
    after = typeof answer.body.next_starting_after === 'string' ? answer.body.next_starting_after : '';
    if (!after || items.length === 0) break;
  }
  return seen;
}

function instantlyOrderBody(kind: 'PREWARMED' | 'NEW', domain: string, mailboxes: Mailbox[], simulation: boolean): Record<string, unknown> {
  const item: Record<string, unknown> = { domain, email_provider: 1 };
  if (kind === 'NEW') {
    item.accounts = mailboxes.map((one) => ({ email_address_prefix: one.prefix, first_name: one.firstName, last_name: one.lastName }));
  }
  return { order_type: kind === 'PREWARMED' ? 'pre_warmed_up' : 'dfy', simulation, items: [item] };
}

const INSTANTLY_PROBLEM_LISTS = [
  'unavailable_domains', 'blacklist_domains', 'invalid_domains', 'missing_domain_orders', 'provider_mismatch_domains',
  'unsupported_provider_domains', 'unavailable_email_providers', 'domains_without_accounts', 'invalid_accounts',
] as const;

function instantlyProblem(body: Record<string, unknown>): string | null {
  const named = INSTANTLY_PROBLEM_LISTS.filter((field) => Array.isArray(body[field]) && (body[field] as unknown[]).length > 0);
  if (body.order_is_valid === true) return null;
  const error = typeof body.order_error === 'string' && /^[a-z_]{1,64}$/.test(body.order_error) ? body.order_error : 'invalid';
  return `Instantly would not take this order (${error}${named.length ? `: ${named.join(', ')}` : ''})`;
}

/**
 * Instantly's own quote. `total_price` is what is charged now (first month of
 * mailboxes plus a year of the domain); the monthly figure adds the domain's
 * yearly renewal spread over twelve months, rounded up, so the ceiling is
 * never under-counted.
 */
export function instantlyQuoteOf(body: Record<string, unknown>): Quote {
  const problem = instantlyProblem(body);
  const yearly = cents(body.total_domains_price_per_year);
  return {
    valid: problem === null,
    upfrontCents: cents(body.total_price),
    monthlyCents: cents(body.total_price_per_month) + Math.ceil(yearly / 12),
    problem,
    raw: pick(body, ['order_is_valid', 'number_of_domains_ordered', 'number_of_accounts_ordered', 'price_per_account_per_month', 'price_per_domain_per_year', 'total_price_per_month', 'total_price', 'total_discount', 'order_items']),
  };
}

function pick(body: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (body[field] !== undefined) out[field] = body[field];
  return out;
}

export async function instantlyQuote(ctx: Ctx, kind: 'PREWARMED' | 'NEW', domain: string, mailboxes: Mailbox[]): Promise<Quote | { error: string }> {
  const answer = await instantly(ctx, 'POST', '/dfy-email-account-orders', instantlyOrderBody(kind, domain, mailboxes, true));
  if (answer.kind !== 'OK') return { error: answer.kind === 'UNKNOWN' ? answer.reason : answer.detail };
  if (answer.body.simulation !== true || answer.body.order_placed === true) {
    // A quote that did not come back as a simulation is not a quote.
    return { error: 'Instantly did not confirm the request was a simulation; nothing further is sent' };
  }
  return instantlyQuoteOf(answer.body);
}

export async function instantlyOrder(ctx: Ctx, kind: 'PREWARMED' | 'NEW', domain: string, mailboxes: Mailbox[]): Promise<OrderResult> {
  const answer = await instantly(ctx, 'POST', '/dfy-email-account-orders', instantlyOrderBody(kind, domain, mailboxes, false));
  if (answer.kind !== 'OK') return refusedOf(answer);
  const receipt = pick(answer.body, ['order_placed', 'order_is_valid', 'number_of_domains_ordered', 'number_of_accounts_ordered', 'total_price', 'total_price_per_month', 'checkout_required', 'cart_order_id', 'order_items']);
  if (answer.body.order_placed === true) return { kind: 'PLACED', detail: `Instantly placed the order for ${domain}`, receipt };
  if (answer.body.checkout_required === true) {
    return { kind: 'REFUSED', detail: 'Instantly needs a payment method on the workspace before it will place this; nothing was charged', receipt };
  }
  return { kind: 'REFUSED', detail: instantlyProblem(answer.body) ?? 'Instantly did not place the order', receipt };
}

export interface InstantlyAccount {
  email: string;
  firstName: string | null;
  lastName: string | null;
  warmupStatus: number | null;
}

export async function instantlyAccounts(ctx: Ctx, search?: string): Promise<InstantlyAccount[]> {
  const out: InstantlyAccount[] = [];
  let after = '';
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (search) query.set('search', search);
    if (after) query.set('starting_after', after);
    const answer = await instantly(ctx, 'GET', `/accounts?${query.toString()}`);
    if (answer.kind !== 'OK') break;
    const items = Array.isArray(answer.body.items) ? (answer.body.items as Record<string, unknown>[]) : [];
    for (const one of items) {
      if (typeof one.email !== 'string') continue;
      out.push({
        email: one.email.toLowerCase(),
        firstName: typeof one.first_name === 'string' ? one.first_name : null,
        lastName: typeof one.last_name === 'string' ? one.last_name : null,
        warmupStatus: one.warmup_status === null || one.warmup_status === undefined ? null : Number(one.warmup_status),
      });
    }
    after = typeof answer.body.next_starting_after === 'string' ? answer.body.next_starting_after : '';
    if (!after || items.length === 0) break;
  }
  return out;
}

/** Starts Instantly's (free) warmup. Enabling warmup that is already on changes nothing. */
export async function instantlyEnableWarmup(ctx: Ctx, emails: string[]): Promise<{ ok: boolean; detail: string }> {
  if (emails.length === 0) return { ok: true, detail: 'nothing to enable' };
  const answer = await instantly(ctx, 'POST', '/accounts/warmup/enable', { emails: emails.slice(0, 100) });
  if (answer.kind === 'OK') return { ok: true, detail: `warmup enabled on ${Math.min(emails.length, 100)} account(s)` };
  return { ok: false, detail: answer.kind === 'UNKNOWN' ? answer.reason : answer.detail };
}

/* ------------------------------------------------------------------ */
/* InboxKit                                                            */
/* ------------------------------------------------------------------ */

export function inboxKitConfigured(env: NodeJS.ProcessEnv = process.env): { ok: boolean; missing: string[] } {
  const missing = [INBOXKIT_KEY_ENV, INBOXKIT_WORKSPACE_ENV, INBOXKIT_CONTACT_ENV].filter((name) => !secretValue(name, env));
  return { ok: missing.length === 0, missing };
}

async function inboxKit(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ProviderAnswer> {
  const key = secretValue(INBOXKIT_KEY_ENV, ctx.env);
  const workspace = secretValue(INBOXKIT_WORKSPACE_ENV, ctx.env);
  if (!key || !workspace) return { kind: 'REFUSED', status: 0, category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `${INBOXKIT_KEY_ENV} or ${INBOXKIT_WORKSPACE_ENV} is not configured` };
  return providerRequest({
    fetch: ctx.fetch,
    url: `${INBOXKIT_API}${path}`,
    method,
    headers: { Authorization: `Bearer ${key}`, 'X-Workspace-Id': workspace, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 60_000,
    // InboxKit's 402 is its wallet refusing the whole batch before anything is queued.
  });
}

export interface InboxKitDomain {
  name: string;
  priceCents: number;
}

/** Available .com/.org domains Google Workspace can be set up on, cheapest first. */
export async function inboxKitSearchDomains(ctx: Ctx, keyword: string, limit = 20): Promise<InboxKitDomain[]> {
  const answer = await inboxKit(ctx, 'POST', '/domains/search', { keyword, limit, show_unavailable: false });
  if (answer.kind !== 'OK') return [];
  const data = (answer.body.data ?? answer.body) as Record<string, unknown>;
  const domains = Array.isArray(data.domains) ? (data.domains as Record<string, unknown>[]) : [];
  return domains
    .filter((one) => typeof one.name === 'string' && one.available === true && one.google_workspace_available !== false && /\.(com|org)$/i.test(String(one.name)))
    .map((one) => ({ name: String(one.name).toLowerCase(), priceCents: cents(one.price) }))
    .sort((a, b) => a.priceCents - b.priceCents);
}

export async function inboxKitWallet(ctx: Ctx): Promise<{ ok: boolean; creditsRemaining: number | null; detail: string }> {
  const answer = await inboxKit(ctx, 'GET', '/billing/wallet');
  if (answer.kind !== 'OK') return { ok: false, creditsRemaining: null, detail: answer.kind === 'UNKNOWN' ? answer.reason : answer.detail };
  const data = (answer.body.data ?? answer.body) as Record<string, unknown>;
  const remaining = Number(data.credits_remaining);
  return { ok: true, creditsRemaining: Number.isFinite(remaining) ? remaining : null, detail: 'ok' };
}

/** The connected Instantly sequencer new mailboxes are exported into; connected once in InboxKit by the owner. */
export async function inboxKitInstantlySequencer(ctx: Ctx): Promise<string | null> {
  const answer = await inboxKit(ctx, 'POST', '/sequencers/list', { sequencer_platforms: ['instantly'], keyword: '', uids: [] });
  if (answer.kind !== 'OK') return null;
  const data = (answer.body.data ?? answer.body) as Record<string, unknown>;
  const list = Array.isArray(data.sequencers) ? data.sequencers : Array.isArray(data.items) ? data.items : Array.isArray(answer.body) ? answer.body : [];
  const first = (list as Record<string, unknown>[]).find((one) => String(one.platform ?? '').toLowerCase().includes('instantly'));
  return first && typeof first.uid === 'string' ? first.uid : null;
}

/**
 * InboxKit publishes no simulation, so its quote is computed from its own
 * numbers: the domain's registration price from its search, and its published
 * mailbox price. Monthly adds the domain's renewal spread over twelve months.
 */
export function inboxKitQuote(domain: InboxKitDomain, mailboxes: number): Quote {
  const mailboxCents = mailboxes * INBOXKIT_MAILBOX_MONTHLY_CENTS;
  return {
    valid: true,
    upfrontCents: domain.priceCents + mailboxCents,
    monthlyCents: mailboxCents + Math.ceil(domain.priceCents / 12),
    problem: null,
    raw: { domain: domain.name, domain_price_cents: domain.priceCents, mailbox_monthly_cents: INBOXKIT_MAILBOX_MONTHLY_CENTS, mailboxes },
  };
}

export async function inboxKitOrder(ctx: Ctx, input: { domain: string; redirectUrl: string; mailboxes: Mailbox[]; sequencerUid: string | null }): Promise<OrderResult> {
  let contact: unknown;
  try {
    contact = JSON.parse(secretValue(INBOXKIT_CONTACT_ENV, ctx.env) ?? '');
  } catch {
    return { kind: 'REFUSED', detail: `${INBOXKIT_CONTACT_ENV} is not a JSON object; nothing was sent`, receipt: {} };
  }
  const answer = await inboxKit(ctx, 'POST', '/orders', {
    contact_details: contact,
    warmup_addon_enabled: false,
    domains: [{
      name: input.domain,
      redirect_url: input.redirectUrl,
      registration_years: 1,
      mailboxes: input.mailboxes.map((one) => ({
        email: `${one.prefix}@${input.domain}`,
        first_name: one.firstName,
        last_name: one.lastName,
        platform: 'GOOGLE',
        ...(input.sequencerUid ? { sequencer_uid: input.sequencerUid } : {}),
      })),
    }],
  });
  if (answer.kind !== 'OK') {
    if (answer.kind === 'REFUSED' && answer.status === 402) {
      return { kind: 'REFUSED', detail: 'the InboxKit wallet does not cover this order; nothing was queued — top the wallet up', receipt: {} };
    }
    return refusedOf(answer);
  }
  const results = (Array.isArray(answer.body) ? answer.body : Array.isArray(answer.body.data) ? answer.body.data : []) as Record<string, unknown>[];
  const mine = results.filter((one) => String(one.domain ?? '').toLowerCase() === input.domain);
  const receipt = { results: mine.map((one) => pick(one, ['order_id', 'status', 'domain', 'mailbox'])) };
  if (mine.some((one) => String(one.status ?? '').toLowerCase() === 'error')) {
    return { kind: 'REFUSED', detail: `InboxKit rejected ${input.domain}`, receipt };
  }
  if (mine.some((one) => /queued/i.test(String(one.status ?? '')))) {
    return { kind: 'PLACED', detail: `InboxKit queued ${input.domain} with ${input.mailboxes.length} mailbox(es)`, receipt };
  }
  return { kind: 'UNKNOWN', detail: 'InboxKit answered without saying whether it queued the domain' };
}
