/**
 * Whether an opening is worth spending research on now, read from its own rows.
 *
 * Production, 2026-10-21: 340 openings, 269 deep dives, one qualified — and
 * that one was a broker's own fee schedule ($5 membership against an $800
 * deposit) read as revenue. The dives had gone to three kinds of opening no
 * answer could make executable:
 *
 *   * **a freelance-marketplace listing.** Its payer is the client and its
 *     route is the platform's escrow, and this operation takes no freelance
 *     work, so a dive there buys an answer nobody could act on.
 *   * **an opening that closes before a dive could finish** and a person could
 *     act on what it found. A dive runs for hours to a day, and the first
 *     external step needs a grant and a send after that.
 *
 * A third used to be here — an asset to buy that the ledger cannot pay for —
 * and it was removed on 2026-10-28. It refused research on every resale
 * opening while deployable cash was zero, so a whole family of openings could
 * never be qualified, and research is reading, not spending: what an asset
 * costs, whether it can be sold before it is paid for, or bought by somebody
 * else for a fee, is exactly what a dive establishes. Capital is still asked
 * where it binds — `beginExecution` refuses to start what deployable cash
 * cannot cover — exactly as it always was for a service with an exposure.
 *
 * Neither deletes, archives or reclassifies anything, and neither is stored.
 * Each is derived on every read, so it lifts by itself when the row it reads
 * changes, and an opening is never refused for a host it does not name. §65's
 * rule holds: not being able to act today is a named gap, never a reason to
 * drop an opening.
 */
import { getDb } from '../../db/database.ts';
import { getClaim } from '../../repos/research.ts';
import type { CashOpportunity } from '../../domain/types.ts';
import { screenOpportunity, type ScreenFacts, type ScreenLimits, type ScreenVerdict } from './screen.ts';
import { listWorkstreams } from '../../repos/register.ts';
import { readTarget } from '../goals/target.ts';

/**
 * Hosts whose pages are individual freelance-marketplace listings.
 *
 * Matched on the host's registered name, any subdomain and any country domain
 * (`upwork.com`, `www.peopleperhour.co.uk`). A reviewed constant: adding a
 * marketplace here is a code change somebody reads.
 */
export const MARKETPLACE_HOSTS: readonly string[] = Object.freeze([
  'freelancer',
  'peopleperhour',
  'upwork',
  'fiverr',
  'guru',
  'truelancer',
  'workana',
]);

/** How long before its recorded close an opening stops being worth a dive. */
export const DIVE_RUNWAY_MS = 72 * 60 * 60 * 1000;

/** The marketplace a source URL is a listing on, or null. */
export function marketplaceOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  for (const name of MARKETPLACE_HOSTS) {
    // `upwork.com`, `www.fiverr.ie`, `guru.co.uk` — the name is
    // a whole label, followed only by a public suffix.
    const at = labels.indexOf(name);
    if (at >= 0 && at < labels.length - 1 && labels.slice(at + 1).length <= 2 && labels.slice(at + 1).every((one) => one.length <= 3)) {
      return name;
    }
  }
  return null;
}

/** Whether a recorded closing date falls within the runway. Unknown dates are never "soon". */
export function closesWithin(expiresAt: string | null, now: string, runwayMs = DIVE_RUNWAY_MS): boolean {
  if (!expiresAt) return false;
  const value = expiresAt.trim();
  let closes: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) closes = Date.parse(`${value}T23:59:59.999Z`);
  else if (/^\d{4}-\d{2}-\d{2}T/.test(value)) closes = Date.parse(value);
  else return false;
  if (!Number.isFinite(closes)) return false;
  return closes - Date.parse(now) < runwayMs;
}

export type NotWorthResearching =
  | { kind: 'MARKETPLACE_LISTING'; marketplace: string }
  | { kind: 'CLOSES_TOO_SOON'; at: string }
  | { kind: 'SCREENED_OUT'; reason: string; detail: string; limit: string | null };

export function describeNotWorthResearching(reason: NotWorthResearching): string {
  switch (reason.kind) {
    case 'MARKETPLACE_LISTING':
      return 'a freelance-marketplace listing — this operation takes no freelance work, so nothing a dive found could be acted on';
    case 'CLOSES_TOO_SOON':
      return `it closes ${reason.at}, sooner than a dive could finish and the first step be taken`;
    case 'SCREENED_OUT':
      return `${reason.detail}${reason.limit ? ` (${reason.limit})` : ''}`;
  }
}

/**
 * The first reason this opening is not worth researching now, or null.
 * Capital alone is not one of them: it decides whether work may begin. It
 * counts here only when the caller passes the goal's limits and the screen
 * finds a known need above a stated limit with no route needing none named -
 * and a HOLD, which is a question rather than a refusal, never stops research.
 */
/** Mechanisms whose own shape names a way to be paid that needs no capital of ours. */
const NO_CAPITAL_ROUTE: Partial<Record<CashOpportunity['mechanism'], string>> = {
  SUPPLY_DEMAND_MISMATCH: 'brokering the match for a fee',
  SUBCONTRACTED_FULFILMENT: 'subcontracting the fulfilment',
};

/**
 * Requirements the operation has decided it will never meet. A reviewed
 * constant: adding one is a code change somebody reads. These are the standing
 * exclusions the screen's EXCLUDED_REQUIREMENT reads.
 */
export const STANDING_EXCLUSIONS: readonly string[] = Object.freeze([
  'SAM.gov registration',
  'freelance marketplace work',
]);

/**
 * Phrases in an opening's own text that state something it requires of us, and
 * the requirement each names. Matching is on the opening's recorded words only;
 * it never infers a requirement the text does not state.
 */
const REQUIREMENT_PATTERNS: readonly { requirement: string; pattern: RegExp }[] = Object.freeze([
  { requirement: 'SAM.gov registration', pattern: /\bsam\.gov\b|system for award management/i },
  { requirement: 'contractor licence', pattern: /\b(contractor'?s?|trade|professional) licen[cs]e\b/i },
  { requirement: 'bonding', pattern: /\b(bid|performance|payment) bond\b|\bbonded\b/i },
  { requirement: 'vendor registration', pattern: /\b(vendor|supplier) (registration|pre-?qualification)\b/i },
]);

/** Requirements the opening's own words state. Empty when it states none. */
export function requirementsOf(opportunity: CashOpportunity): string[] {
  const text = [opportunity.title, opportunity.offerScope, opportunity.requiredInputs, opportunity.economicsNote]
    .filter((one): one is string => !!one)
    .join('\n');
  const out = REQUIREMENT_PATTERNS.filter((one) => one.pattern.test(text)).map((one) => one.requirement);
  if (marketplaceOf(opportunity.source)) out.push('freelance marketplace work');
  return out;
}

/**
 * Whole days from now until the opening's own recorded payment terms say money
 * arrives ("net 30", "paid within 14 days", "on delivery"), or null when the
 * terms are absent or say nothing a day count can be read from.
 */
export function daysToPaymentOf(paymentTerms: string | null | undefined): number | null {
  if (!paymentTerms) return null;
  const text = paymentTerms.toLowerCase();
  const net = /\bnet[\s-]*(\d{1,3})\b/.exec(text) ?? /\bwithin\s+(\d{1,3})\s*(?:calendar\s+|business\s+)?days?\b/.exec(text)
    ?? /\b(\d{1,3})\s*days?\b/.exec(text);
  if (net) return Number(net[1]);
  if (/\b(upfront|up-front|on delivery|on completion|on receipt|prepaid|deposit)\b/.test(text)) return 0;
  return null;
}

/**
 * What a caller can supply that the row alone cannot say. Absent fields are
 * unknown, and unknown is what the screen is built to hold on.
 */
export interface ScreenContext {
  /** What this operation holds against stated requirements; null when none are recorded. */
  capabilities?: readonly string[] | null;
  /** Whether Brain has any recorded history with this kind of opening. */
  typeHasHistory?: boolean;
}

/**
 * Whether Brain has history with this opening's mechanism: another opening of
 * the same mechanism in the same project that went through validation, or a
 * recorded outcome for it. Read from rows, never assumed.
 */
export async function mechanismHasHistory(opportunity: CashOpportunity): Promise<boolean> {
  const db = getDb();
  const dived = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_opportunities
      WHERE project_id = ? AND mechanism = ? AND id <> ? AND validation_state IS NOT NULL`,
    [opportunity.projectId, opportunity.mechanism, opportunity.id],
  );
  if (Number(dived?.n ?? 0) > 0) return true;
  const outcomes = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cash_outcomes WHERE project_id = ? AND mechanism = ?',
    [opportunity.projectId, opportunity.mechanism],
  );
  return Number(outcomes?.n ?? 0) > 0;
}

/**
 * What the opening's own row establishes, for the screen. Nothing unknown is
 * invented. Requirements, exclusions and days to payment come from the row and
 * the reviewed constants above; capabilities and type history come from the
 * caller's context, and a caller that supplies none leaves them unknown
 * (capabilities null, history false): an unestablished history is never read
 * as familiarity, so the screen holds to investigate. Callers with a database
 * should use `screenFactsWithHistory`, which reads history from rows.
 */
export function screenFactsFor(opportunity: CashOpportunity, context: ScreenContext = {}): ScreenFacts {
  return {
    capitalRequiredCents: opportunity.peakFundingCents ?? null,
    noCapitalRoute: NO_CAPITAL_ROUTE[opportunity.mechanism] ?? null,
    daysToPayment: daysToPaymentOf(opportunity.paymentTerms),
    expiresAt: opportunity.expiresAt ?? null,
    duplicateOf: opportunity.duplicateOfId ?? null,
    requirements: requirementsOf(opportunity),
    capabilities: context.capabilities ?? null,
    exclusions: [...STANDING_EXCLUSIONS],
    hasPayer: !!opportunity.payer,
    hasPrice: opportunity.priceCents !== null && opportunity.priceCents !== undefined,
    typeHasHistory: context.typeHasHistory ?? false,
    sourceObservedAt: opportunity.signalObservedAt ?? null,
  };
}

/** `screenFactsFor` with the opening's type history read from rows, for every real caller. */
export async function screenFactsWithHistory(
  opportunity: CashOpportunity,
  context: Omit<ScreenContext, 'typeHasHistory'> = {},
): Promise<ScreenFacts> {
  return screenFactsFor(opportunity, { ...context, typeHasHistory: await mechanismHasHistory(opportunity) });
}

/** The limits of every live goal in the project that has a target, read from the goal itself. */
export async function goalLimitsFor(projectId: string, now: string): Promise<ScreenLimits[]> {
  const out: ScreenLimits[] = [];
  for (const goal of await listWorkstreams({ projectIds: [projectId] })) {
    if (goal.projectId !== projectId || !goal.target) continue;
    const reading = await readTarget(goal, new Date(now));
    if (!reading || reading.achieved) continue;
    out.push({
      metric: reading.metric,
      daysLeft: reading.daysLeft,
      capitalCeilingCents: reading.capitalCeilingCents,
      capitalBeforeProofCents: reading.capitalBeforeProofCents,
    });
  }
  return out;
}

/**
 * The screen's verdict for an opening: a REJECT only when it fails every live
 * goal's limits, because an opening that serves one goal is worth researching.
 * No goal with a target means no limits to screen against, so no verdict.
 */
async function screenVerdictFor(opportunity: CashOpportunity, now: string): Promise<ScreenVerdict | null> {
  if (!opportunity.projectId) return null;
  const all = await goalLimitsFor(opportunity.projectId, now);
  if (all.length === 0) return null;
  const facts = await screenFactsWithHistory(opportunity);
  let reject: ScreenVerdict | null = null;
  for (const limits of all) {
    const verdict = screenOpportunity(facts, limits, now);
    if (verdict.verdict !== 'REJECT') return null;
    reject ??= verdict;
  }
  return reject;
}

export async function notWorthResearching(
  opportunity: CashOpportunity,
  context: { now: string; screen?: { facts: ScreenFacts; limits: ScreenLimits } | null },
): Promise<NotWorthResearching | null> {
  if (opportunity.sourceClaimId) {
    const claim = await getClaim(opportunity.sourceClaimId);
    const marketplace = marketplaceOf(claim?.sourceUrl);
    if (marketplace) return { kind: 'MARKETPLACE_LISTING', marketplace };
  }
  if (closesWithin(opportunity.expiresAt, context.now)) {
    return { kind: 'CLOSES_TOO_SOON', at: opportunity.expiresAt! };
  }
  // The goal's own limits, when the caller has them. Only a REJECT stops research:
  // a HOLD is a question to answer, and answering it is what research is for.
  // With none passed (every production caller), the project's own goals decide.
  const verdict = context.screen
    ? screenOpportunity(context.screen.facts, context.screen.limits, context.now)
    : context.screen === undefined
      ? await screenVerdictFor(opportunity, context.now)
      : null;
  if (verdict && verdict.verdict === 'REJECT') {
    return { kind: 'SCREENED_OUT', reason: verdict.reason, detail: verdict.detail, limit: verdict.limit };
  }
  return null;
}
