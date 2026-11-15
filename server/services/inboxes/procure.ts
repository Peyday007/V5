/**
 * Inbox procurement (§110): the owner puts money in, Brain buys sending
 * inboxes with it and sets them up, and nothing else can spend it.
 *
 * The rules, each one an invariant rather than a preference:
 *
 * - **Only money the owner put in is spent** (18, 38). `fundedCents` is the sum
 *   of the owner's ADD_FUNDS rows; `monthlyCeilingCents` is the latest ceiling
 *   on the recurring total. With neither, nothing is bought.
 * - **The provider prices it, before anything is placed.** Instantly is asked
 *   in simulation; InboxKit's price comes from its own domain search and its
 *   published mailbox price. The order goes only if both the one-off pot and
 *   the monthly ceiling still cover it *with this order counted*.
 * - **One domain is one purchase, recorded before it is placed** (20, 27). The
 *   key is the provider, the kind and the domain, so a retry of the same order
 *   is the same row and is refused as already attempted.
 * - **An unknown answer is spent and never retried** (26). It stays counted
 *   against the money until `syncInboxes` finds the domain on the provider and
 *   appends PLACED.
 * - **Nothing is a balance row** (37). `inboxBudget` derives it every time.
 *
 * Racing buyers cannot overspend: each records its purchase first and then
 * re-reads the totals with every recorded purchase counted, so two at once each
 * see the other and the later one refuses.
 */
import { createHash } from 'node:crypto';
import {
  addInboxFunds, inboxFunds, inboxPurchases, recordInboxOutcome, recordInboxPurchase,
  type InboxKind, type InboxProvider, type InboxPurchase,
} from '../../repos/inboxes.ts';
import {
  ctxOf, inboxKitConfigured, inboxKitInstantlySequencer, inboxKitOrder, inboxKitQuote, inboxKitSearchDomains,
  instantlyAccounts, instantlyEnableWarmup, instantlyOrder, instantlyOrderedDomains, instantlyPrewarmedDomains,
  instantlyQuote, instantlySimilarDomains, MAILBOXES_PER_DOMAIN, type Ctx, type Mailbox, type Quote,
} from './providers.ts';
import type { FetchLike } from '../cash/providers/http.ts';

export interface InboxBudget {
  fundedCents: number;
  spentCents: number;
  remainingCents: number;
  monthlyCeilingCents: number;
  monthlyCommittedCents: number;
  monthlyRemainingCents: number;
  mailboxesOwned: number;
  purchases: InboxPurchase[];
}

/** A purchase counts against the money unless its provider refused it. */
function counts(one: InboxPurchase): boolean {
  return one.state !== 'REFUSED';
}

export async function inboxBudget(): Promise<InboxBudget> {
  const { fundedCents, monthlyCeilingCents } = await inboxFunds();
  const purchases = await inboxPurchases();
  const live = purchases.filter(counts);
  const spentCents = live.reduce((sum, one) => sum + one.upfrontCents, 0);
  const monthlyCommittedCents = live.reduce((sum, one) => sum + one.monthlyCents, 0);
  return {
    fundedCents,
    spentCents,
    remainingCents: fundedCents - spentCents,
    monthlyCeilingCents,
    monthlyCommittedCents,
    monthlyRemainingCents: monthlyCeilingCents - monthlyCommittedCents,
    mailboxesOwned: live.reduce((sum, one) => sum + one.mailboxes, 0),
    purchases,
  };
}

export async function fundInboxes(input: { addCents?: number; monthlyCeilingCents?: number; actor: string; note?: string }): Promise<InboxBudget> {
  if (input.addCents !== undefined) await addInboxFunds({ kind: 'ADD_FUNDS', amountCents: input.addCents, actor: input.actor, note: input.note });
  if (input.monthlyCeilingCents !== undefined) await addInboxFunds({ kind: 'SET_MONTHLY_CEILING', amountCents: input.monthlyCeilingCents, actor: input.actor, note: input.note });
  return inboxBudget();
}

/* ------------------------------------------------------------------ */
/* Who the inboxes are, and what domains they live on                  */
/* ------------------------------------------------------------------ */

export interface Persona {
  firstName: string;
  lastName: string;
  /** The owner's main domain: new domains are found near it and redirect to it. */
  seedDomain: string;
}

/**
 * The sender the owner already mails as, read from their Instantly accounts
 * (the most common name and domain there) unless the command names one.
 */
export async function personaFor(ctx: Ctx, given: Partial<Persona>): Promise<Persona | null> {
  if (given.firstName && given.lastName && given.seedDomain) return given as Persona;
  const accounts = await instantlyAccounts(ctx);
  const most = (values: (string | null)[]): string | null => {
    const tally = new Map<string, number>();
    for (const value of values) if (value) tally.set(value, (tally.get(value) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const firstName = given.firstName ?? most(accounts.map((one) => one.firstName));
  const lastName = given.lastName ?? most(accounts.map((one) => one.lastName));
  const seedDomain = given.seedDomain ?? most(accounts.map((one) => one.email.split('@')[1] ?? null));
  return firstName && lastName && seedDomain ? { firstName, lastName, seedDomain: seedDomain.toLowerCase() } : null;
}

/** Five distinct, ordinary addresses for one person on one domain. */
export function mailboxesFor(persona: Persona, count: number): Mailbox[] {
  const f = persona.firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = persona.lastName.toLowerCase().replace(/[^a-z]/g, '');
  const prefixes = [f, `${f}.${l}`, `${f}${l[0] ?? ''}`, `${f[0] ?? ''}.${l}`, `${f}${l}`];
  return [...new Set(prefixes)].slice(0, Math.max(1, Math.min(count, MAILBOXES_PER_DOMAIN)))
    .map((prefix) => ({ prefix, firstName: persona.firstName, lastName: persona.lastName }));
}

export function purchaseKeyOf(provider: InboxProvider, kind: InboxKind, domain: string): string {
  return createHash('sha256').update(`${provider}|${kind}|${domain.toLowerCase()}`).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Buying                                                              */
/* ------------------------------------------------------------------ */

export interface BuyRequest {
  kind: InboxKind;
  /** Mailboxes wanted; rounded up to whole domains of five. */
  mailboxes: number;
  /** Price and validate every order, and place none. */
  dryRun: boolean;
  actor: string;
  persona?: Partial<Persona>;
  /** Force a seller for new inboxes; by default InboxKit when connected, else Instantly. */
  provider?: InboxProvider;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface BuyLine {
  domain: string;
  provider: InboxProvider;
  mailboxes: number;
  upfrontCents: number;
  monthlyCents: number;
  outcome: 'QUOTED' | 'PLACED' | 'REFUSED' | 'UNKNOWN' | 'OVER_BUDGET' | 'ALREADY_ATTEMPTED' | 'NOT_QUOTABLE';
  detail: string;
}

export interface BuyResult {
  ok: boolean;
  provider: InboxProvider | null;
  lines: BuyLine[];
  stopped: string | null;
  budget: InboxBudget;
}

function providerFor(request: BuyRequest, env: NodeJS.ProcessEnv): InboxProvider {
  if (request.kind === 'PREWARMED') return 'INSTANTLY';
  if (request.provider) return request.provider;
  return inboxKitConfigured(env).ok ? 'INBOXKIT' : 'INSTANTLY';
}

async function candidateDomains(ctx: Ctx, provider: InboxProvider, kind: InboxKind, persona: Persona, taken: Set<string>): Promise<{ domain: string; priceCents?: number }[]> {
  if (kind === 'PREWARMED') {
    const list = await instantlyPrewarmedDomains(ctx);
    return list.domains.filter((one) => !taken.has(one.toLowerCase())).map((domain) => ({ domain: domain.toLowerCase() }));
  }
  if (provider === 'INBOXKIT') {
    const keyword = persona.seedDomain.replace(/\.[a-z]+$/i, '');
    return (await inboxKitSearchDomains(ctx, keyword, 40)).filter((one) => !taken.has(one.name)).map((one) => ({ domain: one.name, priceCents: one.priceCents }));
  }
  return (await instantlySimilarDomains(ctx, persona.seedDomain)).filter((one) => !taken.has(one.toLowerCase())).map((domain) => ({ domain: domain.toLowerCase() }));
}

async function quoteOne(ctx: Ctx, provider: InboxProvider, kind: InboxKind, domain: { domain: string; priceCents?: number }, mailboxes: Mailbox[]): Promise<Quote | { error: string }> {
  if (provider === 'INBOXKIT') {
    if (domain.priceCents === undefined || domain.priceCents <= 0) return { error: 'InboxKit gave no price for this domain' };
    return inboxKitQuote({ name: domain.domain, priceCents: domain.priceCents }, mailboxes.length);
  }
  return instantlyQuote(ctx, kind, domain.domain, mailboxes);
}

/** Domains a pre-warmed purchase owns arrive with their own five mailboxes. */
function mailboxCount(kind: InboxKind, quote: Quote, mailboxes: Mailbox[]): number {
  if (kind === 'NEW') return mailboxes.length;
  const ordered = Number(quote.raw.number_of_accounts_ordered);
  return Number.isFinite(ordered) && ordered > 0 ? ordered : MAILBOXES_PER_DOMAIN;
}

export async function buyInboxes(request: BuyRequest): Promise<BuyResult> {
  const ctx = ctxOf({ fetch: request.fetch, env: request.env });
  const provider = providerFor(request, ctx.env);
  const lines: BuyLine[] = [];
  const done = async (stopped: string | null): Promise<BuyResult> => ({
    ok: stopped === null && lines.every((one) => one.outcome === 'PLACED' || one.outcome === 'QUOTED'),
    provider, lines, stopped, budget: await inboxBudget(),
  });

  if (!Number.isInteger(request.mailboxes) || request.mailboxes < 1) return done('Name how many mailboxes to buy (a whole number, at least 1).');
  const start = await inboxBudget();
  if (!request.dryRun && (start.fundedCents <= 0 || start.monthlyCeilingCents <= 0)) {
    return done('No money has been put in yet: set both the one-off funds and the monthly ceiling first (`inboxes fund`).');
  }
  const persona = await personaFor(ctx, request.persona ?? {});
  if (!persona) return done('No sender name or main domain could be read from Instantly; name them (--first, --last, --seed).');

  const taken = new Set(start.purchases.map((one) => one.domain));
  if (provider === 'INSTANTLY') for (const domain of await instantlyOrderedDomains(ctx)) taken.add(domain);
  const candidates = await candidateDomains(ctx, provider, request.kind, persona, taken);
  if (candidates.length === 0) {
    return done(request.kind === 'PREWARMED'
      ? 'Instantly has no pre-warmed domains available right now; buy new ones instead (--kind new).'
      : 'No available domain was found near the main domain; name another with --seed.');
  }

  const sequencerUid = provider === 'INBOXKIT' && !request.dryRun ? await inboxKitInstantlySequencer(ctx) : null;
  if (provider === 'INBOXKIT' && !request.dryRun && !sequencerUid) {
    return done('InboxKit has no Instantly sequencer connected, so its mailboxes would not reach Instantly: connect Instantly once in InboxKit → Sequencers.');
  }

  let remaining = request.mailboxes;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const mailboxes = mailboxesFor(persona, remaining);
    const quote = await quoteOne(ctx, provider, request.kind, candidate, mailboxes);
    if ('error' in quote || !quote.valid) {
      lines.push({ domain: candidate.domain, provider, mailboxes: 0, upfrontCents: 0, monthlyCents: 0, outcome: 'NOT_QUOTABLE', detail: 'error' in quote ? quote.error : quote.problem ?? 'invalid' });
      if ('error' in quote && /not configured|refused the credential/.test(quote.error)) return done(quote.error);
      continue;
    }
    const count = mailboxCount(request.kind, quote, mailboxes);
    const line: BuyLine = { domain: candidate.domain, provider, mailboxes: count, upfrontCents: quote.upfrontCents, monthlyCents: quote.monthlyCents, outcome: 'QUOTED', detail: 'quoted by the provider; nothing placed' };
    lines.push(line);

    const budget = await inboxBudget();
    if (quote.upfrontCents > budget.remainingCents || quote.monthlyCents > budget.monthlyRemainingCents) {
      line.outcome = request.dryRun ? 'QUOTED' : 'OVER_BUDGET';
      line.detail = `needs $${(quote.upfrontCents / 100).toFixed(2)} now and $${(quote.monthlyCents / 100).toFixed(2)}/month; left: $${(budget.remainingCents / 100).toFixed(2)} and $${(budget.monthlyRemainingCents / 100).toFixed(2)}/month`;
      if (!request.dryRun) return done('The money put in does not cover the next domain.');
    }
    remaining -= count;
    if (request.dryRun) continue;

    const purchase = await recordInboxPurchase({
      purchaseKey: purchaseKeyOf(provider, request.kind, candidate.domain), provider, kind: request.kind, domain: candidate.domain,
      mailboxes: count, upfrontCents: quote.upfrontCents, monthlyCents: quote.monthlyCents, quote: quote.raw, actor: request.actor,
    });
    if (!purchase) {
      line.outcome = 'ALREADY_ATTEMPTED';
      line.detail = 'this exact order was attempted before and is never attempted twice';
      remaining += count;
      continue;
    }
    // Re-read with this purchase counted: a buyer racing this one is counted too.
    const after = await inboxBudget();
    if (after.remainingCents < 0 || after.monthlyRemainingCents < 0) {
      await recordInboxOutcome(purchase.id, 'REFUSED', 'not placed: with every recorded purchase counted, the money put in does not cover it');
      line.outcome = 'OVER_BUDGET';
      line.detail = 'another purchase took the money first; not placed';
      return done('The money put in does not cover the next domain.');
    }
    const result = provider === 'INBOXKIT'
      ? await inboxKitOrder(ctx, { domain: candidate.domain, redirectUrl: `https://${persona.seedDomain}`, mailboxes, sequencerUid })
      : await instantlyOrder(ctx, request.kind, candidate.domain, mailboxes);
    await recordInboxOutcome(purchase.id, result.kind, result.detail, result.kind === 'UNKNOWN' ? {} : result.receipt);
    line.outcome = result.kind;
    line.detail = result.detail;
    if (result.kind === 'UNKNOWN') return done(`The answer for ${candidate.domain} was lost; it is counted as spent and will not be retried until \`inboxes sync\` finds it.`);
    if (result.kind === 'REFUSED') remaining += count;
    if (result.kind === 'REFUSED' && /payment method|wallet|credential|not configured/.test(result.detail)) return done(result.detail);
  }
  return done(remaining > 0 ? `${remaining} mailbox(es) short: no further domain could be bought.` : null);
}

/* ------------------------------------------------------------------ */
/* After the order: reconcile, and start warmup                        */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  reconciled: string[];
  warmupEnabled: { domain: string; accounts: number }[];
  waiting: string[];
  notes: string[];
}

/**
 * Settles what an order left open. An UNKNOWN Instantly order whose domain is
 * now on the workspace's order list becomes PLACED. Every placed domain whose
 * mailboxes have reached Instantly gets Instantly's free warmup turned on
 * (pre-warmed ones keep warming, as Instantly recommends); one whose mailboxes
 * have not arrived yet is reported as waiting and tried next pass.
 */
export async function syncInboxes(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<SyncResult> {
  const ctx = ctxOf(options);
  const out: SyncResult = { reconciled: [], warmupEnabled: [], waiting: [], notes: [] };
  const purchases = await inboxPurchases();
  const unknown = purchases.filter((one) => one.state === 'UNKNOWN' || one.state === null);
  if (unknown.some((one) => one.provider === 'INSTANTLY')) {
    const ordered = await instantlyOrderedDomains(ctx);
    for (const one of unknown.filter((p) => p.provider === 'INSTANTLY' && ordered.has(p.domain))) {
      await recordInboxOutcome(one.id, 'PLACED', `reconciled: ${one.domain} is on Instantly's order list`);
      one.state = 'PLACED';
      out.reconciled.push(one.domain);
    }
  }
  for (const one of unknown.filter((p) => p.state !== 'PLACED')) {
    out.notes.push(`${one.domain} (${one.provider}): outcome still unknown; counted as spent, never retried automatically.`);
  }
  for (const one of purchases.filter((p) => p.state === 'PLACED' && !p.warmupEnabled)) {
    const accounts = (await instantlyAccounts(ctx, one.domain)).filter((a) => a.email.endsWith(`@${one.domain}`));
    if (accounts.length === 0) {
      out.waiting.push(one.domain);
      continue;
    }
    const enabled = await instantlyEnableWarmup(ctx, accounts.map((a) => a.email));
    if (enabled.ok) {
      await recordInboxOutcome(one.id, 'WARMUP_ENABLED', enabled.detail, { accounts: accounts.length });
      out.warmupEnabled.push({ domain: one.domain, accounts: accounts.length });
    } else {
      out.notes.push(`${one.domain}: warmup not enabled yet (${enabled.detail}); tried again next pass.`);
    }
  }
  return out;
}

/** Whether any bought inbox still needs the sync: an open outcome, or mailboxes not yet warming. */
export async function inboxesUnsettled(): Promise<boolean> {
  return (await inboxPurchases()).some((one) => one.state === 'UNKNOWN' || one.state === null || (one.state === 'PLACED' && !one.warmupEnabled));
}
