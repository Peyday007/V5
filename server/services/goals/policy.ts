/**
 * What a goal is held to before a plan for it may be recommended.
 *
 * A goal carries a policy. SQUEEZE — a fixed target, a deadline and a capital
 * limit — is one configurable policy, not the definition of a goal: a
 * long-term venture, a creative goal, a research goal or a recurring-income
 * goal does not inherit its rules, and is never judged as though it did.
 *
 * Pure: it reads nothing and writes nothing. The plan calls `gateRecommendation`
 * with what it already holds, and gets back whether the plan may be
 * recommended and every reason it may not.
 *
 *   * A probability is *supported* only when it comes from comparable finished
 *     outcomes (a measured rate with a sample and a lower bound) or from an
 *     evidence-backed model whose every stage of the complete goal —
 *     acquisition, fulfilment, payment, capacity, timing and contingencies — is
 *     established. Coverage from a sweep of tested conditions is never a
 *     probability, and is never reported as one.
 *   * Where evidence cannot support a number, the gate says so and the plan is
 *     not recommendable. It never fills the gap with a figure.
 *   * A plan must also survive combined ordinary setbacks, not only single ones.
 */
import type { GoalTarget } from '../../domain/register.ts';

export const POLICY_KINDS = ['SQUEEZE', 'LONG_TERM_VENTURE', 'CREATIVE', 'RESEARCH', 'RECURRING_INCOME'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** The stages of a complete goal; reliability is judged across all of them. */
export const GOAL_STAGES = ['ACQUISITION', 'FULFILMENT', 'PAYMENT', 'CAPACITY', 'TIMING', 'CONTINGENCIES'] as const;
export type GoalStage = (typeof GOAL_STAGES)[number];

export const DEFAULT_RELIABILITY = { normal: 0.9, adverse: 0.8 } as const;

export interface ReliabilityStandard {
  /** Chance required under ordinary conditions. */
  normal: number;
  /** Chance required when realistic adverse conditions are combined. */
  adverse: number;
}

export interface GoalPolicy {
  kind: PolicyKind;
  /** Whether a fixed target and deadline are what the goal is judged on. */
  judgedOnTarget: boolean;
  target: { amountCents: number; currency: string } | null;
  deadlineDays: number | null;
  capital: { ceilingCents: number | null; beforeProofCents: number | null; perWeekCents: number | null };
  /** Null for policies that carry no reliability standard of their own. */
  reliability: ReliabilityStandard | null;
}

export interface PolicyOverrides {
  reliability?: Partial<ReliabilityStandard>;
}

function validStandard(s: ReliabilityStandard): boolean {
  return [s.normal, s.adverse].every((n) => Number.isFinite(n) && n > 0 && n <= 1) && s.adverse <= s.normal;
}

/**
 * The policy for a goal. Only SQUEEZE reads the goal's own target, deadline and
 * capital limits; every other kind carries none of them. A reliability override
 * that is out of range or puts the adverse bar above the normal one is
 * ignored in favour of the default: a configured standard may differ, it may
 * not be nonsense.
 */
export function policyFor(input: {
  kind?: PolicyKind | null;
  target?: GoalTarget | null;
  daysLeft?: number | null;
  overrides?: PolicyOverrides;
}): GoalPolicy {
  const kind: PolicyKind = input.kind && POLICY_KINDS.includes(input.kind) ? input.kind : 'SQUEEZE';
  if (kind !== 'SQUEEZE') {
    return {
      kind,
      judgedOnTarget: false,
      target: null,
      deadlineDays: null,
      capital: { ceilingCents: null, beforeProofCents: null, perWeekCents: null },
      reliability: null,
    };
  }
  const t = input.target ?? null;
  const merged: ReliabilityStandard = {
    normal: input.overrides?.reliability?.normal ?? DEFAULT_RELIABILITY.normal,
    adverse: input.overrides?.reliability?.adverse ?? DEFAULT_RELIABILITY.adverse,
  };
  return {
    kind,
    judgedOnTarget: true,
    target: t ? { amountCents: t.amountCents, currency: t.currency } : null,
    deadlineDays: input.daysLeft ?? null,
    capital: {
      ceilingCents: t?.capitalCeilingCents ?? null,
      beforeProofCents: t?.capitalBeforeProofCents ?? null,
      perWeekCents: t?.capitalPerWeekCents ?? null,
    },
    reliability: validStandard(merged) ? merged : { ...DEFAULT_RELIABILITY },
  };
}

/** A probability and what it rests on. `basis` decides whether it is supported. */
export interface ProbabilityEvidence {
  /** Comparable finished outcomes, as Brain measured them. */
  measured: { lowerBound: number; sampleSize: number } | null;
  /** An evidence-backed model's estimate, with the stages whose inputs are established. */
  modelled: { estimate: number; lowerBound: number; establishedStages: GoalStage[] } | null;
  /** Share of tested conditions in a sweep that met the goal. Never a probability. */
  sweepCoverage?: number | null;
}

export interface SetbackTest {
  /** Names of the setbacks applied together in this test. */
  setbacks: string[];
  /** Whether the goal was still met under them. */
  goalMet: boolean;
}

export interface GateInput {
  policy: GoalPolicy;
  probability: ProbabilityEvidence;
  /** Tests of combined ordinary setbacks (two or more at once). */
  combinedSetbacks: SetbackTest[];
  /** Share of combined-setback worlds that still met the goal, when run as a distribution. */
  adverseShare?: { lowerBound: number } | null;
}

export type SupportedProbability =
  | { supported: true; lowerBound: number; source: 'MEASURED' | 'MODELLED' }
  | { supported: false; reason: string };

/** The only place a number becomes a probability, and the reasons it refuses. */
export function supportedProbability(p: ProbabilityEvidence, minSample = 10): SupportedProbability {
  if (p.measured && p.measured.sampleSize >= minSample) {
    return { supported: true, lowerBound: p.measured.lowerBound, source: 'MEASURED' };
  }
  if (p.modelled) {
    const missing = GOAL_STAGES.filter((s) => !p.modelled!.establishedStages.includes(s));
    if (missing.length === 0) return { supported: true, lowerBound: p.modelled.lowerBound, source: 'MODELLED' };
    return {
      supported: false,
      reason: `The model leaves ${missing.map((s) => s.toLowerCase()).join(', ')} unestablished, so it cannot state a chance for the complete goal.`,
    };
  }
  const sweep = p.sweepCoverage != null ? ` Sweep coverage (${Math.round(p.sweepCoverage * 100)}% of tested conditions) is not a probability.` : '';
  const sample = p.measured ? ` Only ${p.measured.sampleSize} comparable outcome(s) exist; ${minSample} are needed.` : '';
  return { supported: false, reason: `No comparable outcomes or evidence-backed model supports a chance for the complete goal.${sample}${sweep}` };
}

export interface GateResult {
  recommendable: boolean;
  policy: PolicyKind;
  /** True when this policy has no reliability gate and the plan was not held to squeeze rules. */
  notSqueeze: boolean;
  probability: SupportedProbability | null;
  reasons: string[];
}

/**
 * May this plan be recommended under its goal's policy? Non-SQUEEZE policies
 * are not judged here at all: they return `notSqueeze` and no squeeze reasons.
 */
export function gateRecommendation(input: GateInput): GateResult {
  const { policy } = input;
  if (policy.kind !== 'SQUEEZE' || !policy.reliability) {
    return { recommendable: true, policy: policy.kind, notSqueeze: true, probability: null, reasons: [] };
  }
  const reasons: string[] = [];
  if (!policy.target) reasons.push('The goal has no target, so there is nothing for a squeeze plan to be held to.');
  if (policy.deadlineDays == null) reasons.push('The goal has no deadline, so a squeeze plan cannot be judged on timing.');
  const prob = supportedProbability(input.probability);
  if (!prob.supported) {
    reasons.push(prob.reason);
  } else if (prob.lowerBound < policy.reliability.normal) {
    reasons.push(
      `The supported chance is at least ${pct(prob.lowerBound)}, below the ${pct(policy.reliability.normal)} this goal requires under ordinary conditions.`,
    );
  }
  const combined = input.combinedSetbacks.filter((t) => t.setbacks.length >= 2);
  if (combined.length === 0) {
    reasons.push('No combination of ordinary setbacks has been tested; single setbacks alone do not show the plan holds.');
  } else {
    const failed = combined.filter((t) => !t.goalMet);
    if (failed.length > 0) {
      reasons.push(`The plan fails under combined setbacks: ${failed.map((t) => t.setbacks.join(' + ')).join('; ')}.`);
    }
    if (input.adverseShare && input.adverseShare.lowerBound < policy.reliability.adverse) {
      reasons.push(
        `Under combined realistic setbacks the supported chance is at least ${pct(input.adverseShare.lowerBound)}, below the ${pct(policy.reliability.adverse)} required.`,
      );
    } else if (!input.adverseShare) {
      reasons.push(`The chance under combined setbacks is not supported by evidence, so the ${pct(policy.reliability.adverse)} adverse standard cannot be shown met.`);
    }
  }
  return { recommendable: reasons.length === 0, policy: policy.kind, notSqueeze: false, probability: prob, reasons };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
