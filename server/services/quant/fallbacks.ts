/**
 * Fallback structure for a consequential dependency (FALL-37-1, FALL-37-2).
 *
 * For each activity, commitment or goal pathway a caller hands in, this reads
 * its failure modes, the signals that detect each, the time to harm, the
 * recovery window, the substitutes and the consequences. It judges how many
 * independent alternatives the dependency needs from evidence. It exports the
 * machine-readable chain: primary path → failure condition → evidence that
 * failure occurred → replacement options → eligibility/authority → switching
 * cost → time to switch → estimated cash/capability impact → verification
 * that recovery worked.
 *
 * Like `forecast.ts` and `learning.ts`, it is pure and owns nothing: no table,
 * schedule or queue. Figures are `graph.ts` figures. Switching re-derives the
 * dependent figures through `derive`, and re-evaluates the portfolio through
 * `portfolio.ts` `evaluateCombination`, so lead time, cost, delivery
 * obligation, acquisition economics, cash timing and target reach are
 * recalculated, never copied (§37, invariant 39: an unknown stays unknown).
 *
 * Four rules, each one an invariant somewhere else in Brain:
 *
 *  - **The number of alternatives is a judgment, never a fixed count.** It is
 *    the smallest number of independent substitutes whose joint failure
 *    probability, together with the primary, brings the expected loss under
 *    what the caller says it can bear. Without the failure probabilities it
 *    needs, the judgment is recorded as not possible, along with what is
 *    missing. It is never read as "none needed" (invariant 39).
 *  - **A substitute may change the mechanism.** `changes` names what switching
 *    alters: the provider alone, or the segment, payer, financing, payment
 *    terms, business role, the whole venture, or anything else the caller can
 *    name. No list here is a whitelist (R01-A1).
 *  - **Located is not capacity.** A substitute is `LOCATED` (found),
 *    `VALIDATED` (shown able to do the work) or `RESERVED` (negotiated or
 *    held). A located substitute contributes no available capacity. When one
 *    is switched to, its capacity enters the model as unknown, so every figure
 *    that depends on it is unknown too.
 *  - **An unverified route is never promoted because the primary failed.** A
 *    substitute that supplies evidence and is not verified, or whose
 *    authority or obligations are not confirmed, is ineligible, and the reason
 *    is given. An unknown confirmation calls for reconciliation, not a switch
 *    (invariant 26).
 */
import { derive, unknownFigure, type Figure } from './graph.ts';
import { evaluateCombination, type Activity, type PortfolioProblem } from './portfolio.ts';

/* ------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* ------------------------------------------------------------------------- */

/** How far a substitute has got: found, shown able, or negotiated/held. */
export type SubstituteReadiness = 'LOCATED' | 'VALIDATED' | 'RESERVED';

/** What switching to a substitute alters. `PROVIDER` alone is an equivalent swap; anything else changes the mechanism. */
export type MechanismDimension =
  | 'PROVIDER'
  | 'SEGMENT'
  | 'PAYER'
  | 'SUPPLIER'
  | 'DISTRIBUTION'
  | 'PRICE'
  | 'FINANCING'
  | 'PAYMENT_TERMS'
  | 'BUSINESS_ROLE'
  | 'VENTURE'
  | (string & {});

export interface FailureMode {
  key: string;
  /** The condition that is the failure ("supplier misses the ship date"). */
  condition: string;
  /** Signals that detect it, earliest first. */
  detectionSignals: string[];
  /** Evidence that it has actually happened (a record, a reading), or null when nobody has said what would show it. */
  failureEvidence: string[] | null;
  /** Days from the failure until harm lands. */
  timeToHarmDays: Figure;
  /** Days inside which recovery still prevents the harm. */
  recoveryWindowDays: Figure;
  /** Probability, for the period, that this mode occurs. Unknown when unsized. */
  probability: Figure;
}

export interface SubstituteEligibility {
  /** True only when the authority to switch is on record; null when nobody has said. */
  authorized: boolean | null;
  /** True only when the substitute meets the obligations the primary carried; null when not checked. */
  meetsObligations: boolean | null;
  /** Free text: what the eligibility rests on. */
  basis: string;
}

export interface Substitute {
  key: string;
  label: string;
  /** What switching alters. */
  changes: MechanismDimension[];
  readiness: SubstituteReadiness;
  /** Units of the dependency's work it can take on. Counted as available only once VALIDATED or RESERVED. */
  capacity: Figure;
  /** Probability, for the period, that it fails too. Unknown when unsized. */
  failureProbability: Figure;
  /** Common causes it shares with the primary or other substitutes (a warehouse, an account, a payments provider). */
  commonCauses?: string[];
  eligibility: SubstituteEligibility;
  /** Present when the substitute supplies evidence: whether that route is itself verified. */
  evidenceRoute?: { verified: boolean; basis: string };
  switchingCost: Figure | null;
  timeToSwitchDays: Figure | null;
  /** The economic-model inputs that change when it takes over (cost, lead time, price, payment terms). */
  overrides: Record<string, Figure>;
  /** How recovery onto it is shown to have worked, or null when nobody has said. */
  recoveryVerification: string | null;
}

export interface DependencyConsequence {
  /** Cash lost if it fails and nothing recovers it. */
  cashAtRisk: Figure;
  /** Obligations a failure breaks (a delivery to a client, a filing). */
  obligations: string[];
  /** Capability lost (free text), when any. */
  capability: string | null;
  /** The expected loss the caller can bear from this dependency, in the cash unit. */
  tolerableLoss: Figure;
}

export interface Dependency {
  key: string;
  label: string;
  /** Free text: the activity, commitment or pathway it belongs to. */
  servesActivity: string;
  /** The primary path, in words. */
  primaryPath: string;
  /** Probability the primary fails, for the period. Unknown when unsized. */
  primaryFailureProbability: Figure;
  /** Common causes the primary rests on. */
  commonCauses?: string[];
  failureModes: FailureMode[];
  substitutes: Substitute[];
  consequence: DependencyConsequence;
}

/** How many independent alternatives the dependency needs, judged from evidence. */
export interface AlternativesJudgment {
  /** Null when the evidence cannot settle it: never read as zero. */
  required: number | null;
  /** Eligible substitutes, validated or reserved, sharing no common cause with the primary, that count toward it. A located one never does. */
  counted: string[];
  /** Whether the counted substitutes meet the requirement; null when it cannot be judged. */
  met: boolean | null;
  /** The figures it rests on, or what is missing. */
  basis: string;
  /** Inputs that would settle it, when it could not be judged. */
  missing: string[];
}

export interface SubstituteReading {
  key: string;
  label: string;
  readiness: SubstituteReadiness;
  changesMechanism: boolean;
  changes: MechanismDimension[];
  eligible: boolean;
  /** Why it is not eligible, when it is not. */
  ineligibleBecause: string[];
  /** Capacity it actually contributes: unknown for a located substitute. */
  availableCapacity: Figure;
  /** Common causes it shares with the primary: a substitute that shares one is not independent of it. */
  sharedWithPrimary: string[];
}

export interface FallbackPlan {
  dependency: string;
  servesActivity: string;
  failureModes: FailureMode[];
  substitutes: SubstituteReading[];
  consequence: DependencyConsequence;
  alternatives: AlternativesJudgment;
  /** Capacity of RESERVED substitutes alone. */
  reservedCapacity: Figure;
  /** Capacity of VALIDATED and RESERVED substitutes. A LOCATED one adds nothing. */
  validatedCapacity: Figure;
  /** Failure modes whose recovery window is shorter than the fastest eligible switch: the plan cannot recover in time. */
  unrecoverableInTime: string[];
}

/** One link of the exported chain, per replacement. Unknown links are null. */
export interface ChainReplacement {
  substitute: string;
  readiness: SubstituteReadiness;
  changesMechanism: boolean;
  eligibility: { eligible: boolean; authorized: boolean | null; meetsObligations: boolean | null; ineligibleBecause: string[] };
  switchingCost: Figure | null;
  timeToSwitchDays: Figure | null;
  /** Estimated impact on cash/capability, when an economic model was given. */
  impact: SwitchImpact | null;
  recoveryVerification: string | null;
}

export interface FallbackChain {
  dependency: string;
  primaryPath: string;
  failureCondition: string;
  failureEvidence: string[] | null;
  detectionSignals: string[];
  timeToHarmDays: Figure;
  recoveryWindowDays: Figure;
  replacements: ChainReplacement[];
}

/**
 * The economics a dependency feeds. `inputs` are the figures a primary
 * provides; `figures` are derived from them in order, so a switch re-derives
 * every one. `capacityInput` names the input a substitute's capacity takes.
 */
export interface EconomicModel {
  inputs: Record<string, Figure>;
  figures: Array<{ key: string; meaning: string; unit: string; from: string[]; compute: (values: number[]) => number }>;
  capacityInput?: string;
  /**
   * The portfolio the dependency's activity sits in. `toActivity` rebuilds the
   * activity from the model's figures, or returns null when a figure it needs
   * is unknown. Then the reach is unknown, never assumed.
   */
  portfolio?: { problem: PortfolioProblem; activityKey: string; toActivity: (figures: Record<string, Figure>) => Partial<Activity> | null };
}

export interface SwitchImpact {
  substitute: string;
  readiness: SubstituteReadiness;
  before: Record<string, Figure>;
  after: Record<string, Figure>;
  /** Figures whose value or status the switch changed. */
  changed: string[];
  /** Reach of the target before and after, or null where it cannot be read. */
  reachBefore: number | null;
  reachAfter: number | null;
  /** Why the portfolio could not be read after the switch, when it could not. */
  portfolioUnreadBecause: string | null;
}

/* ------------------------------------------------------------------------- */
/* Reading a dependency                                                       */
/* ------------------------------------------------------------------------- */

const known = (figure: Figure | null | undefined): figure is Figure & { value: number } =>
  !!figure && figure.status !== 'UNKNOWN' && figure.value !== null && Number.isFinite(figure.value);

/** Whether switching to it changes the mechanism rather than swapping an equivalent provider. */
export function changesMechanism(substitute: Pick<Substitute, 'changes'>): boolean {
  return substitute.changes.some((one) => one !== 'PROVIDER');
}

/** Why a substitute may not be switched to: authority, obligations, an unverified evidence route. Empty when eligible. */
export function ineligibility(substitute: Substitute): string[] {
  const why: string[] = [];
  if (substitute.eligibility.authorized !== true) {
    why.push(
      substitute.eligibility.authorized === false
        ? 'switching to it is not authorized'
        : 'no authority to switch to it is on record; reconcile before acting',
    );
  }
  if (substitute.eligibility.meetsObligations !== true) {
    why.push(
      substitute.eligibility.meetsObligations === false
        ? 'it does not meet the obligations the primary carried'
        : 'whether it meets the primary\'s obligations has not been checked',
    );
  }
  if (substitute.evidenceRoute && !substitute.evidenceRoute.verified) {
    why.push(`its evidence route is unverified (${substitute.evidenceRoute.basis}); the primary failing does not promote it`);
  }
  return why;
}

/** The capacity a substitute actually contributes: nothing until it is validated or reserved. */
export function availableCapacity(substitute: Substitute): Figure {
  if (substitute.readiness === 'LOCATED') {
    return unknownFigure(`${substitute.label}: capacity available (located only, not validated)`, substitute.capacity.unit, [
      `validation of ${substitute.key}`,
    ]);
  }
  return substitute.capacity;
}

function sumCapacity(meaning: string, unit: string, parts: Figure[]): Figure {
  if (parts.length === 0) return unknownFigure(meaning, unit);
  return derive(meaning, unit, parts, (values) => values.reduce((sum, x) => sum + x, 0));
}

/**
 * How many independent alternatives the dependency needs. It is the smallest n
 * for which the primary's failure probability times that of the n most
 * reliable eligible substitutes (validated or reserved, sharing no common
 * cause with the primary), brings the
 * expected loss (that joint probability times the cash at risk) to or under
 * the tolerable loss. A low-impact dependency can need none and a high-impact
 * one several. The judgment states its figures, or what it is missing.
 */
export function judgeAlternatives(dependency: Dependency, readings: readonly SubstituteReading[]): AlternativesJudgment {
  const { cashAtRisk, tolerableLoss } = dependency.consequence;
  const missing: string[] = [];
  if (!known(cashAtRisk)) missing.push(`${dependency.key}: cash at risk`);
  if (!known(tolerableLoss)) missing.push(`${dependency.key}: tolerable loss`);
  if (!known(dependency.primaryFailureProbability)) missing.push(`${dependency.key}: primary failure probability`);
  const eligible = readings
    .filter((one) => one.eligible && one.readiness !== 'LOCATED' && one.sharedWithPrimary.length === 0)
    .map((one) => dependency.substitutes.find((s) => s.key === one.key)!)
    .filter(Boolean);
  const unsized = eligible.filter((one) => !known(one.failureProbability)).map((one) => `${one.key}: failure probability`);
  if (missing.length > 0) {
    return { required: null, counted: eligible.map((one) => one.key), met: null, basis: `cannot judge: ${missing.join(', ')} unknown`, missing };
  }
  const cash = (cashAtRisk as Figure & { value: number }).value;
  const bear = (tolerableLoss as Figure & { value: number }).value;
  const pPrimary = (dependency.primaryFailureProbability as Figure & { value: number }).value;
  // A relative tolerance, so 0.2 × 0.05 × 50 000 meets a tolerable 500 as it does on paper.
  const within = (loss: number): boolean => loss <= bear + 1e-9 * Math.max(1, Math.abs(bear));
  if (within(pPrimary * cash)) {
    return {
      required: 0,
      counted: eligible.map((one) => one.key),
      met: true,
      basis: `expected loss with no fallback ${round(pPrimary * cash)} is within the tolerable ${round(bear)} (p=${pPrimary}, at risk ${cash})`,
      missing: [],
    };
  }
  const sized = eligible
    .filter((one) => known(one.failureProbability))
    .sort((a, b) => (a.failureProbability.value as number) - (b.failureProbability.value as number));
  let joint = pPrimary;
  let required: number | null = null;
  for (let n = 1; n <= sized.length; n += 1) {
    joint *= sized[n - 1]!.failureProbability.value as number;
    if (within(joint * cash)) {
      required = n;
      break;
    }
  }
  if (required === null) {
    const why = unsized.length > 0 ? `; unsized substitutes could settle it: ${unsized.join(', ')}` : '';
    return {
      required: null,
      counted: sized.map((one) => one.key),
      met: false,
      basis: `the ${sized.length} eligible independent substitute(s) leave an expected loss of ${round(joint * cash)} over the tolerable ${round(bear)}; more independent alternatives are needed${why}`,
      missing: unsized,
    };
  }
  return {
    required,
    counted: sized.slice(0, required).map((one) => one.key),
    met: true,
    basis: `${required} independent substitute(s) bring the joint failure probability to ${round(joint)} and the expected loss to ${round(joint * cash)}, within the tolerable ${round(bear)} (primary p=${pPrimary}, at risk ${cash})`,
    missing: [],
  };
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Read one substitute against its dependency. */
export function readSubstitute(dependency: Dependency, substitute: Substitute): SubstituteReading {
  const primaryCauses = new Set(dependency.commonCauses ?? []);
  const ineligibleBecause = ineligibility(substitute);
  return {
    key: substitute.key,
    label: substitute.label,
    readiness: substitute.readiness,
    changesMechanism: changesMechanism(substitute),
    changes: [...substitute.changes],
    eligible: ineligibleBecause.length === 0,
    ineligibleBecause,
    availableCapacity: availableCapacity(substitute),
    sharedWithPrimary: (substitute.commonCauses ?? []).filter((one) => primaryCauses.has(one)),
  };
}

/** The fallback plan for one dependency. Pure. */
export function planFallbacks(dependency: Dependency): FallbackPlan {
  const readings = dependency.substitutes.map((one) => readSubstitute(dependency, one));
  const unit = dependency.substitutes[0]?.capacity.unit ?? 'units';
  const reserved = dependency.substitutes.filter((one) => one.readiness === 'RESERVED').map((one) => one.capacity);
  const validated = dependency.substitutes.filter((one) => one.readiness !== 'LOCATED').map((one) => one.capacity);
  const fastest = dependency.substitutes
    .filter((one) => ineligibility(one).length === 0 && known(one.timeToSwitchDays))
    .map((one) => one.timeToSwitchDays!.value as number)
    .sort((a, b) => a - b)[0];
  const unrecoverableInTime = dependency.failureModes
    .filter((mode) => known(mode.recoveryWindowDays) && (fastest === undefined || fastest > (mode.recoveryWindowDays.value as number)))
    .map((mode) => mode.key);
  return {
    dependency: dependency.key,
    servesActivity: dependency.servesActivity,
    failureModes: dependency.failureModes,
    substitutes: readings,
    consequence: dependency.consequence,
    alternatives: judgeAlternatives(dependency, readings),
    reservedCapacity: sumCapacity(`${dependency.label}: reserved substitute capacity`, unit, reserved),
    validatedCapacity: sumCapacity(`${dependency.label}: validated or reserved substitute capacity`, unit, validated),
    unrecoverableInTime,
  };
}

/* ------------------------------------------------------------------------- */
/* Switching: the economics are re-derived, never copied                      */
/* ------------------------------------------------------------------------- */

/** Every figure of the model, derived in order from its inputs. */
export function deriveModel(inputs: Record<string, Figure>, model: EconomicModel): Record<string, Figure> {
  const out: Record<string, Figure> = { ...inputs };
  for (const one of model.figures) {
    const from = one.from.map((key) => out[key] ?? unknownFigure(`${key} (not in the model)`, 'unknown'));
    out[one.key] = derive(one.meaning, one.unit, from, one.compute);
  }
  return out;
}

function reachOf(model: EconomicModel, figures: Record<string, Figure>): { reach: number | null; because: string | null } {
  if (!model.portfolio) return { reach: null, because: 'no portfolio was given' };
  const { problem, activityKey, toActivity } = model.portfolio;
  const replacement = toActivity(figures);
  if (!replacement) return { reach: null, because: 'a figure the activity needs is unknown after the switch' };
  const activities = problem.activities.map((one) => (one.key === activityKey ? { ...one, ...replacement, key: one.key } : one));
  const reading = evaluateCombination({ ...problem, activities });
  if ('missing' in reading) return { reach: null, because: `the portfolio refuses unsized resources: ${reading.missing.join(', ')}` };
  return { reach: reading.reach, because: null };
}

/**
 * What switching the dependency to one substitute does to the economics: the
 * substitute's overrides replace the primary's inputs, its capacity enters as
 * available only if validated or reserved, every dependent figure is
 * re-derived, and the portfolio is re-evaluated over the same worlds.
 */
export function switchTo(dependency: Dependency, substituteKey: string, model: EconomicModel): SwitchImpact {
  const substitute = dependency.substitutes.find((one) => one.key === substituteKey);
  if (!substitute) throw new Error(`No substitute ${substituteKey} on ${dependency.key}.`);
  const before = deriveModel(model.inputs, model);
  const inputs: Record<string, Figure> = { ...model.inputs, ...substitute.overrides };
  if (model.capacityInput) inputs[model.capacityInput] = availableCapacity(substitute);
  const after = deriveModel(inputs, model);
  const changed = Object.keys(after).filter((key) => {
    const a = before[key];
    const b = after[key];
    return !a || !b || a.value !== b.value || a.status !== b.status;
  });
  const reachBefore = reachOf(model, before);
  const reachAfter = reachOf(model, after);
  return {
    substitute: substitute.key,
    readiness: substitute.readiness,
    before,
    after,
    changed,
    reachBefore: reachBefore.reach,
    reachAfter: reachAfter.reach,
    portfolioUnreadBecause: reachAfter.because,
  };
}

/**
 * The machine-readable chain for one failure mode of a dependency, from the
 * primary path to the verification that recovery worked. A link nobody
 * stated is null. With an economic model, each replacement carries its
 * re-derived impact.
 */
export function fallbackChain(dependency: Dependency, failureModeKey: string, model?: EconomicModel): FallbackChain {
  const mode = dependency.failureModes.find((one) => one.key === failureModeKey);
  if (!mode) throw new Error(`No failure mode ${failureModeKey} on ${dependency.key}.`);
  return {
    dependency: dependency.key,
    primaryPath: dependency.primaryPath,
    failureCondition: mode.condition,
    failureEvidence: mode.failureEvidence && mode.failureEvidence.length > 0 ? [...mode.failureEvidence] : null,
    detectionSignals: [...mode.detectionSignals],
    timeToHarmDays: mode.timeToHarmDays,
    recoveryWindowDays: mode.recoveryWindowDays,
    replacements: dependency.substitutes.map((substitute) => {
      const ineligibleBecause = ineligibility(substitute);
      return {
        substitute: substitute.key,
        readiness: substitute.readiness,
        changesMechanism: changesMechanism(substitute),
        eligibility: {
          eligible: ineligibleBecause.length === 0,
          authorized: substitute.eligibility.authorized,
          meetsObligations: substitute.eligibility.meetsObligations,
          ineligibleBecause,
        },
        switchingCost: substitute.switchingCost ?? null,
        timeToSwitchDays: substitute.timeToSwitchDays ?? null,
        impact: model ? switchTo(dependency, substitute.key, model) : null,
        recoveryVerification: substitute.recoveryVerification ?? null,
      };
    }),
  };
}

/**
 * The substitute to switch to when the primary has failed: the eligible one
 * that is validated or reserved, reserved first, then the fastest switch.
 * Null when none qualifies. A located or unverified substitute is never
 * promoted because the primary failed.
 */
export function chooseReplacement(dependency: Dependency): Substitute | null {
  const rank: Record<SubstituteReadiness, number> = { RESERVED: 0, VALIDATED: 1, LOCATED: 2 };
  const candidates = dependency.substitutes
    .filter((one) => one.readiness !== 'LOCATED' && ineligibility(one).length === 0)
    .sort((a, b) => {
      const byReadiness = rank[a.readiness] - rank[b.readiness];
      if (byReadiness !== 0) return byReadiness;
      const ta = known(a.timeToSwitchDays) ? (a.timeToSwitchDays.value as number) : Infinity;
      const tb = known(b.timeToSwitchDays) ? (b.timeToSwitchDays.value as number) : Infinity;
      return ta - tb;
    });
  return candidates[0] ?? null;
}
