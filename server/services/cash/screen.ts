/**
 * The deterministic screen: obvious misfits, rejected in code, from the goal's
 * own stored limits.
 *
 * No model and no research is involved, and nothing here is hardcoded to any
 * one goal: every limit is read from the `TargetReading` the caller passes, so
 * the same opportunity can be a REJECT under one goal and clear under another.
 *
 * Three rules shape every answer.
 *   * A REJECT needs a *known* fact that breaks a *known* limit, and names both.
 *   * A missing fact never rejects and never counts as favourable: it makes the
 *     verdict HOLD, with the fact named, so somebody can go and establish it.
 *   * Being unfamiliar is never a reason to reject. A type Brain has no history
 *     with is HOLD/INVESTIGATE.
 *
 * Capital is the careful one. The blanket "no capital, no research" gate was
 * removed on 2026-10-28 because research is reading, not spending; so capital
 * above a limit rejects only when no no-capital route (pre-sale, brokerage, a
 * fee, a finder) is named, and where one is named the verdict is HOLD with that
 * route as the question.
 */
import type { TargetReading } from '../goals/target.ts';

/** The limits the screen reads, taken from a goal's `TargetReading`. */
export type ScreenLimits = Pick<TargetReading, 'metric' | 'daysLeft' | 'capitalCeilingCents' | 'capitalBeforeProofCents'>;

export interface ScreenFacts {
  /** Capital the opportunity needs before it pays, in the goal's currency; null when nobody has established it. */
  capitalRequiredCents: number | null;
  /** A named route that needs no capital of ours (pre-sale, brokerage, fee, finder); null when none is named. */
  noCapitalRoute: string | null;
  /** Whole days from now until money would arrive; null when unknown. */
  daysToPayment: number | null;
  /** The opening's own closing date (ISO date or timestamp); null when none is recorded. */
  expiresAt: string | null;
  /** The earlier opening this duplicates, from duplicates.ts; null when it is not a duplicate. */
  duplicateOf: string | null;
  /** What the opportunity says it requires of us (a registration, a licence). */
  requirements: readonly string[];
  /** What we hold, or null when that has not been recorded. */
  capabilities: readonly string[] | null;
  /** Requirements the operation has decided it will never meet. */
  exclusions: readonly string[];
  /** Facts the card has established. */
  hasPayer: boolean;
  hasPrice: boolean;
  /** Whether Brain has any recorded history with this kind of opportunity. */
  typeHasHistory: boolean;
  /** When the source was last read; null when unknown. */
  sourceObservedAt: string | null;
}

export type RejectReason =
  | 'EXPIRED'
  | 'DUPLICATE'
  | 'EXCLUDED_REQUIREMENT'
  | 'NOT_ELIGIBLE'
  | 'CAPITAL_TOO_HIGH'
  | 'PAID_TOO_LATE';

export type HoldReason = 'MISSING_FACTS' | 'NO_CAPITAL_ROUTE_TO_CONFIRM' | 'STALE_SOURCE' | 'UNFAMILIAR_TYPE' | 'ELIGIBILITY_UNKNOWN';

export type ScreenVerdict =
  | { verdict: 'REJECT'; reason: RejectReason; detail: string; limit: string | null }
  | { verdict: 'HOLD'; reason: HoldReason; detail: string; missing: string[]; question: string | null }
  | { verdict: 'CLEAR'; detail: string };

/** How old a source reading may be before it is re-verified rather than trusted. */
export const SOURCE_FRESH_MS = 30 * 86_400_000;

const key = (value: string): string => value.trim().toLowerCase();

function closed(expiresAt: string | null, now: string): boolean {
  if (!expiresAt) return false;
  const value = expiresAt.trim();
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T23:59:59.999Z`) : /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at < Date.parse(now);
}

const money = (cents: number): string => `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Pure. The first applicable REJECT wins; otherwise any gap is a HOLD; otherwise CLEAR. */
export function screenOpportunity(facts: ScreenFacts, limits: ScreenLimits, now: string): ScreenVerdict {
  if (closed(facts.expiresAt, now)) {
    return { verdict: 'REJECT', reason: 'EXPIRED', detail: `it closed ${facts.expiresAt}`, limit: null };
  }
  if (facts.duplicateOf) {
    return { verdict: 'REJECT', reason: 'DUPLICATE', detail: `it repeats ${facts.duplicateOf}`, limit: null };
  }
  const excluded = new Set(facts.exclusions.map(key));
  const barred = facts.requirements.find((r) => excluded.has(key(r)));
  if (barred) {
    return { verdict: 'REJECT', reason: 'EXCLUDED_REQUIREMENT', detail: `it requires "${barred}", which this operation has excluded`, limit: barred };
  }
  if (facts.capabilities) {
    const held = new Set(facts.capabilities.map(key));
    const missingReq = facts.requirements.find((r) => !held.has(key(r)));
    if (missingReq) {
      return { verdict: 'REJECT', reason: 'NOT_ELIGIBLE', detail: `it requires "${missingReq}", which is not a recorded capability`, limit: missingReq };
    }
  }
  if (facts.capitalRequiredCents !== null) {
    const binding: { name: string; cents: number }[] = [];
    if (limits.capitalCeilingCents !== null) binding.push({ name: 'capital ceiling', cents: limits.capitalCeilingCents });
    if (limits.capitalBeforeProofCents !== null) binding.push({ name: 'capital before proof', cents: limits.capitalBeforeProofCents });
    const over = binding.find((b) => facts.capitalRequiredCents! > b.cents);
    if (over) {
      const detail = `it needs ${money(facts.capitalRequiredCents)} of capital and the goal's ${over.name} is ${money(over.cents)}`;
      if (facts.noCapitalRoute) {
        return {
          verdict: 'HOLD', reason: 'NO_CAPITAL_ROUTE_TO_CONFIRM', detail: `${detail}, but a route needing none is named`, missing: [],
          question: `Can it be done without capital through ${facts.noCapitalRoute}?`,
        };
      }
      return { verdict: 'REJECT', reason: 'CAPITAL_TOO_HIGH', detail, limit: over.name };
    }
  }
  if ((limits.metric === 'COLLECTED_CASH' || limits.metric === 'SETTLED_CASH') && limits.daysLeft !== null && facts.daysToPayment !== null && facts.daysToPayment > limits.daysLeft) {
    return {
      verdict: 'REJECT', reason: 'PAID_TOO_LATE', limit: 'deadline',
      detail: `money would arrive in ${facts.daysToPayment} days and the goal has ${limits.daysLeft} left, so it cannot count`,
    };
  }

  const missing: string[] = [];
  if (!facts.hasPayer) missing.push('who pays');
  if (!facts.hasPrice) missing.push('the price');
  if (facts.daysToPayment === null) missing.push('when payment arrives');
  if (facts.capitalRequiredCents === null) missing.push('capital required');
  if (missing.length > 0) {
    return { verdict: 'HOLD', reason: 'MISSING_FACTS', detail: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not established`, missing, question: null };
  }
  if (facts.requirements.length > 0 && !facts.capabilities) {
    return { verdict: 'HOLD', reason: 'ELIGIBILITY_UNKNOWN', detail: 'what it requires of us cannot be checked, because no capabilities are recorded', missing: ['recorded capabilities'], question: null };
  }
  if (facts.sourceObservedAt === null || Date.parse(now) - Date.parse(facts.sourceObservedAt) > SOURCE_FRESH_MS) {
    return { verdict: 'HOLD', reason: 'STALE_SOURCE', detail: 'its source has not been read recently enough to rely on', missing: ['a current reading of the source'], question: null };
  }
  if (!facts.typeHasHistory) {
    return { verdict: 'HOLD', reason: 'UNFAMILIAR_TYPE', detail: 'Brain has no history with this kind of opportunity, so it is investigated rather than judged', missing: [], question: 'What has this kind of opportunity actually paid, and to whom?' };
  }
  return { verdict: 'CLEAR', detail: 'nothing known rules it out under this goal' };
}
