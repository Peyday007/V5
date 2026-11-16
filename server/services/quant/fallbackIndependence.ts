/**
 * Independence of a dependency's fallbacks, scored by common cause rather than
 * by count (FALL-37-3).
 *
 * Three acquisition channels on one suspended account are one failure. Two
 * suppliers behind one warehouse fail in the same outage. So the score here
 * is the number of **independent paths** — clusters of paths joined by any
 * common cause they share — never the number of named backups. Concentration
 * and the correlated tail are reported per common cause.
 *
 * It owns nothing and adds no second correlation model:
 *
 *  - The dependency, substitute, eligibility and readiness shapes are
 *    `fallbacks.ts`'; eligibility starts from its `ineligibility` (authority,
 *    obligations, an unverified evidence route) and adds the two things that
 *    module leaves to callers: a fallback that makes things worse, and safety.
 *  - At the level of a whole objective, shared exposure between activities is
 *    `challenge.ts` `detectSharedExposure` over the portfolio's own correlated
 *    worlds; `objectiveCommonCauses` reads it into the same per-cause shape.
 *
 * Four rules:
 *
 *  - **Count independence, not names.** Paths sharing a common cause, directly
 *    or through a chain of them, are one path.
 *  - **Diversity only when it pays.** An added fallback is recommended only
 *    when the expected loss it removes, plus any option value, exceeds its cost
 *    and the capital it exposes. A figure that is unknown is not judged
 *    (invariant 39): nothing is recommended on a blank.
 *  - **A fallback that makes things worse is not a fallback.** Any harm class
 *    makes it `HARMFUL` and ineligible; so does failing obligations, authority
 *    or safety.
 *  - **Unknown is reconciled, never retried** (invariant 26). An unknown
 *    external confirmation yields `RECONCILE_FIRST`. There is no retry action.
 */
import { ineligibility, type Dependency, type Substitute } from './fallbacks.ts';
import { detectSharedExposure, type ActivityFacts } from './challenge.ts';
import type { PortfolioProblem, PortfolioReading } from './portfolio.ts';
import type { Figure } from './graph.ts';

/* ------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* ------------------------------------------------------------------------- */

/** Ways a fallback can make things worse. Each one alone makes it ineligible. */
export const HARM_CLASSES = [
  'EXTRA_COMMITMENTS',
  'DUPLICATE_PURCHASES',
  'CONFLICTING_CONTRACTS',
  'LOW_QUALITY_REPLACEMENT',
  'COMPLIANCE_BREACH',
  'DATA_DIVERGENCE',
  'LIQUIDITY_STRAIN',
  'SLOWER_EXECUTION',
] as const;
export type HarmClass = (typeof HARM_CLASSES)[number];

/** What is known about a substitute beyond `fallbacks.ts`' own fields. */
export interface FallbackAssessment {
  /** Harms switching to it would cause. Empty when none is identified. */
  harms?: HarmClass[];
  /** True only when it meets the safety constraints; null when nobody checked. */
  safe?: boolean | null;
  /** Outcome of an external effect already attempted toward it (an order, a booking). */
  externalConfirmation?: 'CONFIRMED' | 'REFUSED' | 'UNKNOWN' | null;
}

export type FallbackStatus = 'ELIGIBLE' | 'HARMFUL' | 'INELIGIBLE';

export interface FallbackEligibility {
  key: string;
  status: FallbackStatus;
  harms: HarmClass[];
  because: string[];
}

export interface IndependentPath {
  /** Every path in the cluster: `primary` and substitute keys. */
  members: string[];
  /** The common causes that join them. */
  commonCauses: string[];
  /** Whether the primary is in it: a backup that shares a cause with the primary does not back it up. */
  includesPrimary: boolean;
  /** Probability, for the period, that every member fails, or null when a figure is unknown. */
  failureProbability: number | null;
}

export interface CauseConcentration {
  cause: string;
  /** Paths (primary and eligible substitutes) resting on it. */
  paths: string[];
  /** Share of all scored paths that rest on it. */
  share: number;
  /** Whether any scored path survives if it fails. */
  survivorsIfItFails: string[];
  /** Probability it fails, as the caller stated, or null. */
  failureProbability: number | null;
  /** The correlated tail: probability that this cause takes down every scored path, or null when unknown. */
  tailProbability: number | null;
}

export interface IndependenceReading {
  dependency: string;
  /** Named backups, whatever they share. Reported only to show the difference. */
  namedBackups: number;
  /** Independent paths besides the primary's own cluster: the real score. */
  independentBackups: number;
  paths: IndependentPath[];
  concentration: CauseConcentration[];
  /** Probability that every scored path fails together, or null when a figure is unknown. */
  jointFailureProbability: number | null;
  eligibility: FallbackEligibility[];
  /** What would make the reading complete. */
  missing: string[];
}

export type DiversityVerdict = 'RECOMMENDED' | 'NOT_WORTH_IT' | 'NOT_JUDGED';

export interface DiversityReading {
  candidate: string;
  verdict: DiversityVerdict;
  /** Expected loss before and after adding it, in the cash unit, or null. */
  expectedLossBefore: number | null;
  expectedLossAfter: number | null;
  optionValue: number | null;
  cost: number | null;
  capitalExposure: number | null;
  because: string;
}

export type FallbackAction = 'SWITCH' | 'RECONCILE_FIRST' | 'INELIGIBLE';

/* ------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* ------------------------------------------------------------------------- */

/** Whether a substitute may be switched to: `fallbacks.ts` eligibility, plus harm and safety. */
export function assessEligibility(substitute: Substitute, assessment: FallbackAssessment = {}): FallbackEligibility {
  const harms = [...new Set(assessment.harms ?? [])];
  const because = ineligibility(substitute);
  if (assessment.safe === false) because.push('it breaks a safety constraint');
  else if (assessment.safe === undefined || assessment.safe === null) because.push('whether it meets the safety constraints has not been checked');
  if (harms.length > 0) {
    return { key: substitute.key, status: 'HARMFUL', harms, because: [`switching to it makes things worse: ${harms.map((h) => h.toLowerCase().replace(/_/g, ' ')).join(', ')}`, ...because] };
  }
  return { key: substitute.key, status: because.length === 0 ? 'ELIGIBLE' : 'INELIGIBLE', harms, because };
}

/**
 * What to do about switching to one substitute now. An unknown external
 * confirmation, or authority nobody has recorded, is reconciled first; there
 * is no retry (invariant 26).
 */
export function nextFallbackAction(substitute: Substitute, assessment: FallbackAssessment = {}): { action: FallbackAction; because: string[] } {
  if (assessment.externalConfirmation === 'UNKNOWN') {
    return { action: 'RECONCILE_FIRST', because: ['an earlier effect toward it has no confirmed outcome; establish what happened before acting again, and never repeat it blind'] };
  }
  const reading = assessEligibility(substitute, assessment);
  if (reading.status === 'HARMFUL') return { action: 'INELIGIBLE', because: reading.because };
  if (substitute.eligibility.authorized === null || substitute.eligibility.meetsObligations === null || assessment.safe === null || assessment.safe === undefined) {
    if (substitute.eligibility.authorized !== false && substitute.eligibility.meetsObligations !== false && assessment.safe !== false && !(substitute.evidenceRoute && !substitute.evidenceRoute.verified)) {
      return { action: 'RECONCILE_FIRST', because: reading.because };
    }
  }
  return reading.status === 'ELIGIBLE' ? { action: 'SWITCH', because: [] } : { action: 'INELIGIBLE', because: reading.because };
}

/* ------------------------------------------------------------------------- */
/* Independence                                                               */
/* ------------------------------------------------------------------------- */

const known = (figure: Figure | null | undefined): number | null =>
  figure && figure.status !== 'UNKNOWN' && figure.value !== null && Number.isFinite(figure.value) ? figure.value : null;

interface PathNode {
  key: string;
  causes: string[];
  probability: number | null;
}

/**
 * Paths joined by any common cause they share, directly or through a chain of
 * them: each group fails together when that cause fails. Exported so every
 * reliability reading counts independence the same way (fallbackSwitch.ts
 * `pathwayReliability`).
 */
export function clusterByCommonCause<T extends { key: string; causes: readonly string[] }>(nodes: readonly T[]): T[][] {
  const parent = new Map(nodes.map((n) => [n.key, n.key]));
  const find = (k: string): string => {
    let at = k;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const byCause = new Map<string, string>();
  for (const node of nodes) {
    for (const cause of node.causes) {
      const first = byCause.get(cause);
      if (first === undefined) byCause.set(cause, node.key);
      else parent.set(find(node.key), find(first));
    }
  }
  const groups = new Map<string, T[]>();
  for (const node of nodes) {
    const root = find(node.key);
    groups.set(root, [...(groups.get(root) ?? []), node]);
  }
  return [...groups.values()];
}

/**
 * The independence of a dependency's fallbacks. Only eligible substitutes that
 * are validated or reserved are scored as paths — a located one is not
 * capacity and a harmful one is not a fallback — but every one is listed in
 * `eligibility` with its reason.
 */
export function scoreIndependence(
  dependency: Dependency,
  options: { assessments?: Record<string, FallbackAssessment>; causeFailure?: Record<string, number> } = {},
): IndependenceReading {
  const assessments = options.assessments ?? {};
  const causeFailure = options.causeFailure ?? {};
  const eligibility = dependency.substitutes.map((one) => assessEligibility(one, assessments[one.key]));
  const scored = dependency.substitutes.filter((one, i) => eligibility[i]!.status === 'ELIGIBLE' && one.readiness !== 'LOCATED');
  const nodes: PathNode[] = [
    { key: 'primary', causes: [...new Set(dependency.commonCauses ?? [])], probability: known(dependency.primaryFailureProbability) },
    ...scored.map((one) => ({ key: one.key, causes: [...new Set(one.commonCauses ?? [])], probability: known(one.failureProbability) })),
  ];
  const missing: string[] = [];
  for (const node of nodes) if (node.probability === null) missing.push(`failure probability of ${node.key}`);
  const allCauses = [...new Set(nodes.flatMap((n) => n.causes))].sort();
  for (const cause of allCauses) if (causeFailure[cause] === undefined) missing.push(`failure probability of common cause ${cause}`);

  const causeP = (causes: string[]): number | null => {
    let none = 1;
    for (const cause of causes) {
      const p = causeFailure[cause];
      if (p === undefined) return null;
      none *= 1 - p;
    }
    return 1 - none;
  };

  const paths: IndependentPath[] = clusterByCommonCause(nodes).map((members) => {
    const causes = [...new Set(members.flatMap((m) => m.causes))].sort();
    // A path whose causes are shared fails if a shared cause fails, or else if every member fails on its own.
    const shared = causes.filter((c) => members.filter((m) => m.causes.includes(c)).length > 1 || members.length === 1);
    const pCause = causeP(shared);
    const own = members.every((m) => m.probability !== null) ? members.reduce((acc, m) => acc * m.probability!, 1) : null;
    const failureProbability = pCause === null || own === null ? null : pCause + (1 - pCause) * own;
    return {
      members: members.map((m) => m.key).sort((a, b) => (a === 'primary' ? -1 : b === 'primary' ? 1 : a.localeCompare(b))),
      commonCauses: causes,
      includesPrimary: members.some((m) => m.key === 'primary'),
      failureProbability,
    };
  });
  paths.sort((a, b) => Number(b.includesPrimary) - Number(a.includesPrimary) || a.members[0]!.localeCompare(b.members[0]!));

  const jointFailureProbability = paths.every((p) => p.failureProbability !== null) ? paths.reduce((acc, p) => acc * p.failureProbability!, 1) : null;

  const concentration: CauseConcentration[] = allCauses.map((cause) => {
    const on = nodes.filter((n) => n.causes.includes(cause)).map((n) => n.key);
    const survivors = nodes.filter((n) => !n.causes.includes(cause)).map((n) => n.key);
    const p = causeFailure[cause] ?? null;
    return {
      cause,
      paths: on,
      share: on.length / nodes.length,
      survivorsIfItFails: survivors,
      failureProbability: p,
      tailProbability: survivors.length === 0 ? p : p === null ? null : (() => {
        const rest = survivors.map((k) => nodes.find((n) => n.key === k)!.probability);
        return rest.every((x) => x !== null) ? p * rest.reduce((acc, x) => acc * x!, 1) : null;
      })(),
    };
  });
  concentration.sort((a, b) => b.share - a.share || a.cause.localeCompare(b.cause));

  return {
    dependency: dependency.key,
    namedBackups: dependency.substitutes.length,
    independentBackups: paths.filter((p) => !p.includesPrimary).length,
    paths,
    concentration,
    jointFailureProbability,
    eligibility,
    missing,
  };
}

/**
 * Whether adding one more fallback is worth it: recommended only when the
 * expected loss it removes plus its option value exceeds its cost plus the
 * capital it exposes. Any unknown figure leaves it `NOT_JUDGED`.
 */
export function judgeDiversity(
  dependency: Dependency,
  candidate: Substitute,
  economics: { cost: Figure; capitalExposure: Figure; optionValue?: Figure | null },
  options: { assessments?: Record<string, FallbackAssessment>; causeFailure?: Record<string, number> } = {},
): DiversityReading {
  const base = { candidate: candidate.key, optionValue: null as number | null, cost: known(economics.cost), capitalExposure: known(economics.capitalExposure) };
  const eligible = assessEligibility(candidate, options.assessments?.[candidate.key]);
  if (eligible.status !== 'ELIGIBLE') {
    return { ...base, verdict: 'NOT_WORTH_IT', expectedLossBefore: null, expectedLossAfter: null, because: `It is not an eligible fallback: ${eligible.because.join('; ')}.` };
  }
  const before = scoreIndependence(dependency, options);
  const after = scoreIndependence({ ...dependency, substitutes: [...dependency.substitutes, { ...candidate, readiness: candidate.readiness === 'LOCATED' ? 'VALIDATED' : candidate.readiness }] }, options);
  const cashAtRisk = known(dependency.consequence.cashAtRisk);
  const optionValue = economics.optionValue === undefined || economics.optionValue === null ? 0 : known(economics.optionValue);
  const gaps: string[] = [];
  if (cashAtRisk === null) gaps.push('cash at risk');
  if (before.jointFailureProbability === null || after.jointFailureProbability === null) gaps.push(...new Set([...before.missing, ...after.missing]));
  if (base.cost === null) gaps.push('the cost of adding it');
  if (base.capitalExposure === null) gaps.push('the capital it exposes');
  if (optionValue === null) gaps.push('its option value');
  if (gaps.length > 0) {
    return { ...base, verdict: 'NOT_JUDGED', expectedLossBefore: null, expectedLossAfter: null, because: `Not judged until these are known: ${gaps.join('; ')}.` };
  }
  const lossBefore = before.jointFailureProbability! * cashAtRisk!;
  const lossAfter = after.jointFailureProbability! * cashAtRisk!;
  const gain = lossBefore - lossAfter + optionValue!;
  const price = base.cost! + base.capitalExposure!;
  const independentGain = after.independentBackups > before.independentBackups;
  return {
    ...base,
    optionValue,
    expectedLossBefore: lossBefore,
    expectedLossAfter: lossAfter,
    verdict: gain > price ? 'RECOMMENDED' : 'NOT_WORTH_IT',
    because:
      `${independentGain ? 'It adds an independent path' : 'It shares a common cause with an existing path and adds no independent one'}; ` +
      `it removes ${(lossBefore - lossAfter).toFixed(2)} of expected loss plus ${optionValue!.toFixed(2)} of option value, against ${price.toFixed(2)} of cost and capital exposure.`,
  };
}

/* ------------------------------------------------------------------------- */
/* The whole objective                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Common causes across an objective's activities, read from `challenge.ts`
 * `detectSharedExposure` over the portfolio's own correlated worlds — not a
 * second correlation model. Each shared exposure becomes a cause with the
 * activities resting on it and the reach if it fails.
 */
export function objectiveCommonCauses(problem: PortfolioProblem, best: PortfolioReading, facts: Record<string, ActivityFacts> = {}): Array<{
  cause: string;
  activities: string[];
  share: number;
  failureProbability: number | null;
  reachAsPlanned: number;
  reachIfItFails: number;
}> {
  const report = detectSharedExposure(problem, best, facts);
  const members = best.keys.length || 1;
  return report.exposures
    .map((e) => ({
      cause: `${e.kind}:${e.id}`,
      activities: e.members,
      share: e.members.length / members,
      failureProbability: e.failureProbability,
      reachAsPlanned: e.reachAsPlanned,
      reachIfItFails: e.reachIfItFails,
    }))
    .sort((a, b) => b.share - a.share || a.cause.localeCompare(b.cause));
}
