/**
 * Reuse before research: is what the project (or the shared pool) already holds
 * current enough to stand in for a new job?
 *
 * This extends the coverage decision `services/reconcile/` already makes and
 * adds the one thing it does not state as a rule of its own: a freshness
 * window per question. It is a pure function over rows, so no model is asked
 * and nothing is spent, and it can only ever *withhold* a reuse — it never
 * lowers an evidence bar. A claim is reusable only if the reconcile classifier
 * already called the requirement SATISFIED from it, the claim has passed the
 * verification and contradiction rules the gate applies, and its source date
 * falls inside the window.
 *
 * An undated claim is not current (an unknown is never a favourable
 * assumption), and a stale one is reported as stale rather than reused, so the
 * part that needs investigating is exactly the part that is missing or old.
 */
import type { CoverageStatus, ExistingClaim } from '../../../domain/types.ts';

/** Default window when a question states none. A year, never "forever". */
export const DEFAULT_FRESHNESS_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReuseVerdict =
  /** Every cited claim is current: no new job is needed. */
  | 'REUSE'
  /** Some cited claims are current and some are not: investigate the rest. */
  | 'PARTIAL'
  /** Cited claims exist and none is current: they are history, not an answer. */
  | 'STALE'
  /** Nothing usable: investigate. */
  | 'INVESTIGATE';

export interface ReuseInput {
  status: CoverageStatus;
  needsResearch: boolean;
  claimIds: string[];
  /** The claims available to cite, own project and shared alike. */
  claims: ExistingClaim[];
  /** Per-question window in days; null/absent means the default. */
  freshnessDays?: number | null | undefined;
  now: string;
}

export interface ReuseDecision {
  verdict: ReuseVerdict;
  /** Claims that are current and may be reused. */
  currentClaimIds: string[];
  /** Claims that were cited but are not current, each with why. */
  notCurrent: { claimId: string; reason: string }[];
  windowDays: number;
  reason: string;
}

function windowFor(days: number | null | undefined): number {
  return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : DEFAULT_FRESHNESS_DAYS;
}

/** Why a claim may not stand in as current evidence, or null when it may. */
export function whyNotCurrent(claim: ExistingClaim, windowDays: number, now: string): string | null {
  if (claim.superseded) return 'superseded';
  if (claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED') {
    return `contradiction state ${claim.contradictionState}`;
  }
  if (
    claim.verificationState === 'REJECTED' ||
    claim.verificationState === 'SUPERSEDED' ||
    claim.verificationState === 'UNVERIFIABLE'
  ) {
    return `verification ${claim.verificationState}`;
  }
  const dated = claim.sourceDate ?? claim.retrievedAt;
  if (!dated) return 'no source date';
  const at = Date.parse(dated);
  if (!Number.isFinite(at)) return 'unreadable source date';
  const age = Date.parse(now) - at;
  if (age > windowDays * DAY_MS) return `older than ${windowDays} days`;
  return null;
}

export function decideReuse(input: ReuseInput): ReuseDecision {
  const windowDays = windowFor(input.freshnessDays);
  if (input.status !== 'SATISFIED' || input.needsResearch || input.claimIds.length === 0) {
    return {
      verdict: 'INVESTIGATE',
      currentClaimIds: [],
      notCurrent: [],
      windowDays,
      reason: `coverage is ${input.status}${input.needsResearch ? ' and needs research' : ''}; nothing is reused`,
    };
  }
  const byId = new Map(input.claims.map((claim) => [claim.id, claim]));
  const current: string[] = [];
  const notCurrent: { claimId: string; reason: string }[] = [];
  for (const id of input.claimIds) {
    const claim = byId.get(id);
    if (!claim) {
      notCurrent.push({ claimId: id, reason: 'claim not readable' });
      continue;
    }
    const why = whyNotCurrent(claim, windowDays, input.now);
    if (why) notCurrent.push({ claimId: id, reason: why });
    else current.push(id);
  }
  if (notCurrent.length === 0) {
    return { verdict: 'REUSE', currentClaimIds: current, notCurrent, windowDays, reason: 'every cited claim is current' };
  }
  if (current.length === 0) {
    return { verdict: 'STALE', currentClaimIds: [], notCurrent, windowDays, reason: 'no cited claim is current' };
  }
  return {
    verdict: 'PARTIAL',
    currentClaimIds: current,
    notCurrent,
    windowDays,
    reason: `${current.length} current, ${notCurrent.length} not current; only the remainder is investigated`,
  };
}
