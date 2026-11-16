/**
 * When to switch to a fallback, what warns before it is needed, how reliable a
 * plan really is, and what each safeguard buys (FALL-37-4).
 *
 * ---------------------------------------------------------------------------
 * Automatic only inside authority, and an unknown is never permission
 * ---------------------------------------------------------------------------
 *
 * A switch fails over by itself only for authorized, reversible internal work
 * or an alternative a person already approved. One that would expand a
 * contract, spend unapproved money, bypass an access restriction, move customer
 * data improperly or incur a new obligation escalates, naming why — and so does
 * one where any of those is *not known*, because an unanswered fact may never
 * make something ready (invariant 39). Authority is read through the one
 * commercial authority path (`cash/authority.ts`), never a second check. An
 * effect whose outcome is unknown calls for reconciliation first, never a
 * switch that might double it (invariant 26).
 *
 * ---------------------------------------------------------------------------
 * Reliability is computed, and an assurance is earned
 * ---------------------------------------------------------------------------
 *
 * Pathway reliability composes each dependency's chance of failing with no
 * independent eligible substitute left — a substitute sharing a common cause
 * with the primary fails with it and adds nothing (FALL-37-3). Portfolio
 * reliability and correlated downside are read from the portfolio's own
 * world-by-world evaluation (`portfolio.ts`), not multiplied. A 90% figure is
 * stated only when the reliability reaches it *and* the sample behind the
 * probabilities is large enough to tell 90% from chance (the rule of three:
 * zero failures in n trials bounds the failure rate near 3/n). No worst-case
 * floor is ever asserted: an illustrative example is not evidence of one.
 *
 * Pure except `authorityForSwitch`, which reads the grant without recording.
 * The failure-and-recovery record lives with the other ledgers (`ledger.ts`).
 */
import type { Figure } from './graph.ts';
import { evaluateCombination, type PortfolioProblem } from './portfolio.ts';
import { ineligibility, planFallbacks, type Dependency, type Substitute } from './fallbacks.ts';

/* ------------------------------------------------------------------------- */
/* Switch criteria                                                            */
/* ------------------------------------------------------------------------- */

/** What a switch would do, as the caller knows it. Null means nobody has said. */
export interface SwitchFacts {
  /** The work is internal to Brain (no counterparty is touched). */
  internal: boolean | null;
  /** The switch can be undone without loss. */
  reversible: boolean | null;
  /** A person already approved this alternative. */
  previouslyApproved: boolean;
  expandsContractTerms: boolean | null;
  spendsUnapprovedMoney: boolean | null;
  bypassesAccessRestriction: boolean | null;
  movesCustomerDataImproperly: boolean | null;
  incursNewObligation: boolean | null;
  /** Whether the failed effect's own outcome is known. False: it may have happened. */
  primaryOutcomeKnown: boolean;
}

/** The commercial authority reading for the switch's action, from the one authority path. */
export interface SwitchAuthority {
  /** Null when no commercial action applies (purely internal work). */
  ok: boolean | null;
  reason: string;
}

export type SwitchAction = 'AUTO_FAILOVER' | 'ESCALATE' | 'RECONCILE_FIRST' | 'REFUSE';

export interface SwitchDecision {
  action: SwitchAction;
  /** Why, one entry per cause. */
  reasons: string[];
  /** What must hold before the switch is taken, stated for the record. */
  preconditions: string[];
}

const ESCALATIONS: { fact: keyof SwitchFacts; says: string; unknown: string }[] = [
  { fact: 'expandsContractTerms', says: 'it would expand contractual terms', unknown: 'whether it expands contractual terms is not known' },
  { fact: 'spendsUnapprovedMoney', says: 'it would spend money nobody approved', unknown: 'whether it spends unapproved money is not known' },
  { fact: 'bypassesAccessRestriction', says: 'it would bypass an access restriction', unknown: 'whether it bypasses an access restriction is not known' },
  { fact: 'movesCustomerDataImproperly', says: 'it would move customer data improperly', unknown: 'whether it moves customer data properly is not known' },
  { fact: 'incursNewObligation', says: 'it would incur a new obligation', unknown: 'whether it incurs a new obligation is not known' },
];

/** Decide how one switch may be taken. Pure. */
export function switchDecision(substitute: Substitute, facts: SwitchFacts, authority: SwitchAuthority): SwitchDecision {
  const preconditions = [
    `${substitute.label} is eligible: authorized and meeting the obligations the primary carried`,
    `${substitute.label} is ${substitute.readiness === 'LOCATED' ? 'validated before it is relied on' : substitute.readiness.toLowerCase()}`,
    'the failed effect is reconciled with its provider before anything is repeated',
  ];
  if (!facts.primaryOutcomeKnown) {
    return {
      action: 'RECONCILE_FIRST',
      reasons: ['the failed effect may have happened; its outcome is reconciled with the provider before any switch (invariant 26)'],
      preconditions,
    };
  }
  const ineligible = ineligibility(substitute);
  if (ineligible.length > 0 || substitute.readiness === 'LOCATED') {
    return {
      action: 'REFUSE',
      reasons: [...ineligible, ...(substitute.readiness === 'LOCATED' ? ['it is located only; a possible substitute is not available capacity'] : [])],
      preconditions,
    };
  }
  const reasons: string[] = [];
  for (const e of ESCALATIONS) {
    const value = facts[e.fact];
    if (value === true) reasons.push(e.says);
    else if (value === null) reasons.push(e.unknown);
  }
  if (authority.ok === false) reasons.push(`the commercial authority refuses it: ${authority.reason}`);
  if (reasons.length > 0) return { action: 'ESCALATE', reasons, preconditions };

  const internalReversible = facts.internal === true && facts.reversible === true && authority.ok !== false;
  if (internalReversible || facts.previouslyApproved) {
    return {
      action: 'AUTO_FAILOVER',
      reasons: [facts.previouslyApproved ? 'a person already approved this alternative' : 'authorized, reversible internal work'],
      preconditions,
    };
  }
  const why: string[] = [];
  if (facts.internal !== true) why.push(facts.internal === null ? 'whether the work is internal is not known' : 'the work touches a counterparty');
  if (facts.reversible !== true) why.push(facts.reversible === null ? 'whether it can be undone is not known' : 'it cannot be undone');
  return { action: 'ESCALATE', reasons: why, preconditions };
}

/**
 * The authority reading for a switch's commercial action, through the one path
 * every other caller uses, without writing a decision row (it is a reading,
 * not an act). Null action: purely internal work, no commercial authority applies.
 */
export async function authorityForSwitch(projectId: string, action: string | null): Promise<SwitchAuthority> {
  if (action === null) return { ok: null, reason: 'no commercial action applies' };
  const { actionContext, checkCommercialAuthority, BRAIN_PRINCIPAL, isCommercialAction } = await import('../cash/authority.ts');
  if (!isCommercialAction(action)) return { ok: false, reason: `${action} is not a commercial action this Brain knows` };
  const decision = await checkCommercialAuthority({ projectId, action, ...actionContext({ principal: BRAIN_PRINCIPAL }) }, { record: false });
  return { ok: decision.ok, reason: decision.reason };
}

/* ------------------------------------------------------------------------- */
/* Early warning                                                              */
/* ------------------------------------------------------------------------- */

export const WARNING_KINDS = [
  'FAILURE_RATE',
  'DEADLINE_MISS_PROJECTED',
  'CAPACITY_EXHAUSTED',
  'PRICE_INCREASE',
  'PROVIDER_INCIDENT',
  'CUSTOMER_CANCELLATION',
  'FORECAST_DRIFT',
] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

export interface WarningSignal {
  kind: WarningKind;
  dependency: string;
  /** The observed level (a rate, days late, share used, price change, count). Null when not read. */
  observed: number | null;
  /** The level at which it warrants action; null when nobody has set one. */
  threshold: number | null;
  /** Where the reading came from. */
  source: string;
}

export interface PreventiveAction {
  dependency: string;
  kind: WarningKind;
  action: string;
  justification: string;
}

const PREVENTIVE: Record<WarningKind, string> = {
  FAILURE_RATE: 'validate and reserve the next substitute before the primary fails outright',
  DEADLINE_MISS_PROJECTED: 'resequence or stage the delivery and tell the client before the date, not after',
  CAPACITY_EXHAUSTED: 'shift new work to validated substitute capacity and stop admitting work the primary cannot take',
  PRICE_INCREASE: 're-derive the unit economics at the new price and re-rank substitutes on it',
  PROVIDER_INCIDENT: 'hold new effects on that provider and reconcile in-flight ones before resuming',
  CUSTOMER_CANCELLATION: 'release the commitments the cancelled work held and re-plan the capacity it frees',
  FORECAST_DRIFT: 'recalibrate the forecast and recompute the plans it feeds',
};

/** Preventive actions the signals justify. A signal with no threshold or no reading justifies nothing and says so. Pure. */
export function earlyWarning(signals: readonly WarningSignal[]): { actions: PreventiveAction[]; unjudged: { dependency: string; kind: WarningKind; why: string }[] } {
  const actions: PreventiveAction[] = [];
  const unjudged: { dependency: string; kind: WarningKind; why: string }[] = [];
  for (const s of signals) {
    if (s.observed === null || s.threshold === null) {
      unjudged.push({ dependency: s.dependency, kind: s.kind, why: s.observed === null ? 'no reading' : 'no threshold anyone set' });
      continue;
    }
    if (s.observed < s.threshold) continue;
    actions.push({
      dependency: s.dependency,
      kind: s.kind,
      action: PREVENTIVE[s.kind],
      justification: `${s.kind} on ${s.dependency} read ${s.observed} against a threshold of ${s.threshold} (${s.source})`,
    });
  }
  return { actions, unjudged };
}

/* ------------------------------------------------------------------------- */
/* Multi-level reliability                                                    */
/* ------------------------------------------------------------------------- */

const known = (f: Figure | null | undefined): f is Figure & { value: number } =>
  !!f && f.status !== 'UNKNOWN' && f.value !== null && Number.isFinite(f.value);

export interface PathwayReliability {
  pathway: string;
  /** Chance every dependency is served (by its primary or an independent eligible substitute); null when a probability is unknown. */
  reliability: number | null;
  /** Per dependency: chance it ends unserved, or null with what is missing. */
  dependencies: { key: string; unserved: number | null; missing: string[] }[];
  /** Days until the slowest dependency is recovered by its fastest eligible switch; null when unknown or unrecoverable. */
  timeToRecoveryDays: number | null;
}

/** Reliability of one pathway: every dependency must be served. Pure. */
export function pathwayReliability(pathway: string, dependencies: readonly Dependency[]): PathwayReliability {
  const rows: PathwayReliability['dependencies'] = [];
  let reliability: number | null = 1;
  let recovery: number | null = 0;
  for (const d of dependencies) {
    const plan = planFallbacks(d);
    const missing: string[] = [];
    if (!known(d.primaryFailureProbability)) missing.push(`${d.key}: primary failure probability`);
    // Only independent, eligible, validated-or-reserved substitutes count; one sharing a common cause fails with the primary.
    const counted = plan.substitutes
      .filter((s) => s.eligible && s.readiness !== 'LOCATED' && s.sharedWithPrimary.length === 0)
      .map((s) => d.substitutes.find((x) => x.key === s.key)!);
    for (const s of counted) if (!known(s.failureProbability)) missing.push(`${s.key}: failure probability`);
    let unserved: number | null = null;
    if (missing.length === 0) {
      unserved = (d.primaryFailureProbability as Figure & { value: number }).value;
      for (const s of counted) unserved *= (s.failureProbability as Figure & { value: number }).value;
    }
    rows.push({ key: d.key, unserved, missing });
    reliability = reliability === null || unserved === null ? null : reliability * (1 - unserved);
    const switches = counted.map((s) => s.timeToSwitchDays).filter(known).map((f) => f.value);
    const fastest = switches.length > 0 ? Math.min(...switches) : null;
    recovery = recovery === null || fastest === null ? null : Math.max(recovery, fastest);
  }
  return { pathway, reliability, dependencies: rows, timeToRecoveryDays: dependencies.length === 0 ? null : recovery };
}

/** The share of trials needed before a failure rate near `1 - target` can be told from chance (rule of three). */
export function minimumSampleFor(target: number): number {
  // Rounded before the ceiling, so 3 / 0.1 is 30 rather than 30.000000000000004 → 31.
  return Math.ceil(Math.round((3 / Math.max(1e-9, 1 - target)) * 1e6) / 1e6);
}

export interface ReliabilityReading {
  pathways: PathwayReliability[];
  /** Share of portfolio worlds reaching the target; null when the portfolio could not be evaluated. */
  portfolioReliability: number | null;
  /** Share of worlds settling at or below the downside threshold, across correlated worlds. */
  correlatedDownside: number | null;
  /** The slowest pathway recovery, days. */
  timeToRecoveryDays: number | null;
  /** The target the caller seeks (e.g. 0.9) and whether it is supported. */
  assurance: { target: number; supported: boolean; statement: string };
  /** Never asserted: an illustrative example is not evidence of a worst-case floor. */
  assuredFloor: null;
  floorStatement: string;
}

/** Reliability at every level, with an assurance stated only where the evidence supports it. */
export function readReliability(input: {
  pathways: readonly { key: string; dependencies: readonly Dependency[] }[];
  portfolio?: PortfolioProblem;
  downsideAtOrBelow?: number;
  /** Trials behind the probabilities used (outcomes on record); null when not counted. */
  sampleSize: number | null;
  target?: number;
}): ReliabilityReading {
  const target = input.target ?? 0.9;
  const pathways = input.pathways.map((p) => pathwayReliability(p.key, p.dependencies));
  let portfolioReliability: number | null = null;
  let correlatedDownside: number | null = null;
  if (input.portfolio) {
    const combo = evaluateCombination(input.portfolio, input.downsideAtOrBelow);
    if (!('missing' in combo)) {
      portfolioReliability = combo.reach;
      correlatedDownside = combo.shareAtOrBelow;
    }
  }
  const recoveries = pathways.map((p) => p.timeToRecoveryDays);
  const timeToRecoveryDays = recoveries.length > 0 && recoveries.every((r) => r !== null) ? Math.max(...(recoveries as number[])) : null;
  const level = portfolioReliability ?? (pathways.length > 0 && pathways.every((p) => p.reliability !== null) ? Math.min(...pathways.map((p) => p.reliability as number)) : null);
  const needed = minimumSampleFor(target);
  let statement: string;
  let supported = false;
  if (level === null) statement = `a ${Math.round(target * 100)}% outcome is unsupported: a probability it rests on is unknown`;
  else if (input.sampleSize === null || input.sampleSize < needed) {
    statement = `a ${Math.round(target * 100)}% outcome is unsupported: ${input.sampleSize ?? 'no'} trial(s) on record, and ${needed} are needed to tell it from chance (computed ${round(level)})`;
  } else if (level < target) statement = `the computed reliability ${round(level)} is below ${target}`;
  else {
    supported = true;
    statement = `reliability ${round(level)} meets ${target} on ${input.sampleSize} trial(s), at least the ${needed} needed`;
  }
  return {
    pathways,
    portfolioReliability,
    correlatedDownside,
    timeToRecoveryDays,
    assurance: { target, supported, statement },
    assuredFloor: null,
    floorStatement: 'no worst-case floor is asserted: an illustrative example is not evidence of an assured floor',
  };
}

/* ------------------------------------------------------------------------- */
/* What a safeguard buys                                                      */
/* ------------------------------------------------------------------------- */

export interface SafeguardEffect {
  safeguard: string;
  successBefore: number | null;
  successAfter: number | null;
  /** Change in the chance of success; null when either side is unknown. */
  successDelta: number | null;
  /** successDelta × value at stake − cost; null when any input is unknown. */
  expectedNetDelta: number | null;
  because: string;
}

/** The effect of adding one substitute to one dependency, on success and on expected net economics. Pure. */
export function safeguardEffect(input: {
  pathway: string;
  dependencies: readonly Dependency[];
  dependencyKey: string;
  safeguard: Substitute;
  /** What the pathway is worth when it succeeds, in the cost unit. */
  valueAtStake: Figure;
  /** What the safeguard costs to prepare and hold. */
  cost: Figure;
}): SafeguardEffect {
  const before = pathwayReliability(input.pathway, input.dependencies).reliability;
  const withIt = input.dependencies.map((d) => (d.key === input.dependencyKey ? { ...d, substitutes: [...d.substitutes, input.safeguard] } : d));
  const after = pathwayReliability(input.pathway, withIt).reliability;
  const successDelta = before === null || after === null ? null : after - before;
  const expectedNetDelta =
    successDelta === null || !known(input.valueAtStake) || !known(input.cost) ? null : successDelta * input.valueAtStake.value - input.cost.value;
  return {
    safeguard: input.safeguard.key,
    successBefore: before,
    successAfter: after,
    successDelta,
    expectedNetDelta,
    because:
      successDelta === null
        ? 'a probability the pathway rests on is unknown, so the effect cannot be computed'
        : expectedNetDelta === null
          ? `success changes by ${round(successDelta)}; the economics are unknown`
          : `success changes by ${round(successDelta)} for a cost of ${input.cost.value}, net ${round(expectedNetDelta)}`,
  };
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
