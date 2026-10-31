/**
 * The quantitative inference vocabulary (§79).
 *
 * The scenario engine (§60) evaluates a model somebody wrote down. This is what
 * comes before it: turning "nobody has published this exact number" into a
 * defensible estimate from what the world does know about the mechanism, and
 * saying exactly how defensible it is.
 *
 * An estimate climbs a ladder and stops at the first rung that is enough:
 *
 *   DIRECT       evidence about this exact activity, in this population
 *   COMPARABLE   evidence about other activities whose *mechanism* matches on
 *                every dimension declared material, with the differences that
 *                remain discounted or adjusted, never transferred blindly
 *   COMPONENT    the quantity rebuilt from sub-quantities, each estimated on
 *                its own ladder, with uncertainty propagated through the
 *                formula that relates them
 *   MECHANISM    broad economic evidence only — enough for bounds, never for a
 *                probability
 *
 * Nothing here computes; `services/quant/` does. Three rules are written into
 * the shape of these types:
 *
 *   * **An observation names its lineage.** Two studies that rest on one
 *     upstream dataset share a lineage id and are counted once, so "four
 *     sources agree" cannot be three restatements of one survey (§14).
 *   * **A transfer names what differs.** An observation's context is compared
 *     dimension by dimension with the target's; a mismatch on a dimension the
 *     quantity declares *material* excludes it unless an adjustment with its
 *     own evidence bridges the gap.
 *   * **Only an estimate whose every leaf is evidence may carry a
 *     distribution.** Anything resting on broad mechanism evidence or an
 *     assumption is exported to the scenario engine as a range, so a run over
 *     it is a sweep and nobody reads coverage as a probability (§60, §77).
 */
import type { SourceRef } from './scenario.ts';

/** The ladder, strongest first. */
export const EVIDENCE_TIERS = ['DIRECT', 'COMPARABLE', 'COMPONENT', 'MECHANISM', 'ASSUMED', 'UNKNOWN'] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** Tiers whose result may justify a probability distribution downstream. */
export const DISTRIBUTION_TIERS: readonly EvidenceTier[] = ['DIRECT', 'COMPARABLE', 'COMPONENT'];

/**
 * What kind of number a quantity is. It decides the scale estimates are pooled
 * on: a share on the logit scale, a positive magnitude on the log scale, a
 * real number as it is.
 */
export type QuantityKind = 'RATE' | 'POSITIVE' | 'REAL';

/** One piece of quantitative evidence, about some population. */
export type ObservationValue =
  /** Successes out of trials — a measured rate with its sample. */
  | { kind: 'COUNT'; successes: number; trials: number }
  /** A published point figure. `sampleSize` when the source states one. */
  | { kind: 'POINT'; value: number; sampleSize?: number }
  /** A published range: read as the spread of the population it describes. */
  | { kind: 'RANGE'; low: number; high: number };

export interface Observation {
  id: string;
  value: ObservationValue;
  /** The population this was measured in: dimension → value. */
  context: Record<string, string>;
  /**
   * The upstream data this rests on. Two observations whose lineages intersect
   * are one observation counted twice, and are collapsed.
   */
  lineage: string[];
  source: SourceRef;
  /** When it was observed (ISO), for staleness. */
  observedAt?: string | null;
  /** True when this observation is about broad economics rather than any activity. */
  broad?: boolean;
  /** A note a reader can check: what exactly the figure measures. */
  measures?: string;
}

/**
 * A declared bridge across one material difference: "conversion for a $2,000
 * offer is between 0.4 and 0.8 of conversion for a $300 offer". It carries its
 * own source, because an adjustment is a claim exactly as a value is.
 */
export interface TransferAdjustment {
  dimension: string;
  /** Applies when the observation's value on the dimension is `from` and the target's is `to`. */
  from: string;
  to: string;
  /** A multiplicative factor range on the natural scale. */
  factorLow: number;
  factorHigh: number;
  source: SourceRef;
}

/** One quantity in a reconstruction graph. */
export interface QuantityNode {
  key: string;
  label: string;
  unit: string;
  kind: QuantityKind;
  /** Physical bounds: a rate is in [0, 1]; days are positive. */
  min?: number;
  max?: number;
  /**
   * The population the question is about. Observations are compared with it
   * dimension by dimension.
   */
  context?: Record<string, string>;
  /** Dimensions where a difference changes the answer, so a mismatch disqualifies. */
  material?: string[];
  observations?: Observation[];
  adjustments?: TransferAdjustment[];
  /** How to rebuild it from other nodes, in the scenario expression grammar. */
  formula?: string;
  /**
   * When the estimate is good enough to stop climbing: the ratio p90 / p10 for
   * a positive quantity, the absolute width p90 − p10 for a rate or a real.
   */
  sufficientWidth?: number;
  /** Observations older than this many days are stale and not used. */
  freshDays?: number;
  /** A person's stated value, used only when nothing else answers. Never a distribution. */
  assumed?: { low: number; high: number; source: SourceRef };
}

export interface QuantGraph {
  nodes: QuantityNode[];
  /** Declared rank correlations between nodes' estimates, used when propagating. */
  correlations?: Array<{ a: string; b: string; rho: number; note?: string }>;
}

export interface ExcludedObservation {
  id: string;
  reason: string;
}

/** What the engine concluded about one quantity. */
export interface Estimate {
  key: string;
  label: string;
  unit: string;
  kind: QuantityKind;
  tier: EvidenceTier;
  /** The pooled centre and spread on the pooling scale. */
  scale: 'LOGIT' | 'LOG' | 'IDENTITY';
  mean: number;
  sd: number;
  /** Natural-scale quantiles of the predictive distribution for the target. */
  p05: number;
  p10: number;
  p50: number;
  p90: number;
  p95: number;
  /** Observations' worth after discounting, collapsing and pooling. */
  effectiveSample: number;
  /** Between-population spread on the pooling scale (random effects). */
  heterogeneity: number;
  /** May a distribution be exported? False for MECHANISM, ASSUMED and UNKNOWN. */
  distributionJustified: boolean;
  sources: SourceRef[];
  used: string[];
  excluded: ExcludedObservation[];
  /** Groups of observations collapsed into one because they share data. */
  collapsed: string[][];
  /** For a COMPONENT estimate, the children it was rebuilt from. */
  children: string[];
  /** Routes considered and why each was or was not taken, in order. */
  trace: string[];
  /** Natural-scale samples of the predictive distribution, for propagation. Not serialized by readers. */
  samples: number[];
}

export interface Reconstruction {
  target: string;
  estimates: Record<string, Estimate>;
  /** Nodes never resolved because a stronger route answered first. */
  notNeeded: string[];
  /** Nodes visited, for the budget. */
  visited: number;
  elapsedMs: number;
}

/** Bounds on one reconstruction. */
export const QUANT_LIMITS = {
  maxDepth: 8,
  maxNodes: 200,
  samples: 4_000,
  /** Default sufficiency: a positive quantity whose p90 is within 2.5× its p10. */
  positiveWidth: 2.5,
  /** A rate known to within 15 points. */
  rateWidth: 0.15,
  /** A real quantity: no default; it climbs until it runs out of routes. */
} as const;
