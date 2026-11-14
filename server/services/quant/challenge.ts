/**
 * Independent challenge, scaled by consequence (CHAL-33).
 *
 * Brain seeks the ways its own important conclusions could be wrong, and how
 * hard it looks depends on what being wrong would cost. A small reversible
 * action is checked against basic invariants and passes; a large obligation or
 * a portfolio-wide assumption gets the deep review: failure-mode checks,
 * counterfactual sensitivity, correlated-scenario stress, shared-exposure
 * detection and a demand for validation that is actually independent.
 *
 * This module adds no store, queue, scheduler or authority path. It reads the
 * portfolio the quant owner (`portfolio.ts`) already optimizes, recomputes
 * every counterfactual through that same evaluator on the same drawn worlds
 * (an activity's samples and a resource's outages are seeded by their own key,
 * so a sub-problem sees exactly the worlds the full one did), and measures a
 * proposed safeguard with `readWithSafeguard` instead of asserting it.
 *
 * Three rules hold everywhere:
 *
 *   * A finding names the assumption that matters, the observation or method
 *     that would test it, and a concrete safer structure. "Insufficient
 *     confidence" alone is never emitted.
 *   * A model agreeing with itself is not independent validation: a check by
 *     the producing model, or over the producing data source, is refused.
 *   * A calculated scenario, a calibrated probability, an accepted plan and an
 *     actual result are four different things and stay four different fields.
 *     The probability comes only from `assess()`'s evidence rule, and scenario
 *     coverage never stands in for a 90% claim (§77, §95).
 *
 * Tiers are thresholds over numbers. No category, industry or example list
 * decides anything here (R01-A1, §18.1).
 */
import {
  CLAIM_THRESHOLD,
  MIN_EVIDENCE_SAMPLE,
  assess,
  compareReadings,
  effectiveSample,
  evaluateCombination,
  readWithSafeguard,
  type Activity,
  type Assurance,
  type PortfolioProblem,
  type PortfolioReading,
  type PortfolioResult,
  type Safeguard,
} from './portfolio.ts';

// ─── Scrutiny ────────────────────────────────────────────────────────────────

export type ScrutinyTier = 'BASIC_INVARIANTS' | 'STANDARD' | 'DEEP';

/** What being wrong about an action would cost. Every field is a number or a flag, never a category. */
export interface ScrutinyInput {
  /** Money lost if the conclusion is wrong (major units). */
  potentialLoss: number;
  /** What the loss is measured against: capital available, the target, the account balance. */
  reference: number;
  /** True when the action cannot be undone once taken (an obligation signed, money sent). */
  irreversible: boolean;
  /** 0–1: how unsure the model behind the conclusion is (1 = no calibration at all). */
  modelUncertainty: number;
  /** 0–1: share of the plan's value exposed to one shared supplier, channel, marketplace or payment rail. */
  correlatedExposure: number;
  /** 0–1: how much the decision would change if the conclusion were wrong (e.g. EVPPI over the decision's value). */
  decisionImpact: number;
  /** True when the conclusion is an assumption every plan in the portfolio rests on. */
  portfolioWide?: boolean;
}

/** The thresholds a tier is chosen by. Defaults are deliberate, and a caller may tighten them. */
export interface ScrutinyThresholds {
  /** At or under this share of the reference, a reversible action is small. */
  basicLossShare: number;
  /** At or over this share, the review is deep whether or not the action is reversible. */
  deepLossShare: number;
  /** An irreversible action at or over this share is deep. */
  deepIrreversibleLossShare: number;
  /** Above this, model uncertainty alone rules out basic invariants. */
  basicUncertainty: number;
  /** At or above this, model uncertainty alone makes the review deep when the loss is not small. */
  deepUncertainty: number;
  basicExposure: number;
  deepExposure: number;
  basicImpact: number;
  deepImpact: number;
}

export const DEFAULT_SCRUTINY: ScrutinyThresholds = {
  basicLossShare: 0.02,
  deepLossShare: 0.25,
  deepIrreversibleLossShare: 0.05,
  basicUncertainty: 0.5,
  deepUncertainty: 0.8,
  basicExposure: 0.25,
  deepExposure: 0.5,
  basicImpact: 0.1,
  deepImpact: 0.5,
};

export interface Scrutiny {
  tier: ScrutinyTier;
  /** Why this tier, one line per factor that decided it. */
  because: string[];
  lossShare: number;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);

/**
 * Choose how hard to look. A small reversible action with a confident model,
 * little shared exposure and little bearing on the decision needs only basic
 * invariants; a large or irreversible obligation, a portfolio-wide assumption,
 * a heavily shared exposure or a decision that turns on the conclusion gets
 * the deep review. Anything unknown is read as the worse case: a non-finite
 * number is treated as maximal, never as zero.
 */
export function scrutinyFor(action: ScrutinyInput, thresholds: ScrutinyThresholds = DEFAULT_SCRUTINY): Scrutiny {
  const t = thresholds;
  const loss = Number.isFinite(action.potentialLoss) ? Math.max(0, action.potentialLoss) : Infinity;
  const lossShare = action.reference > 0 && Number.isFinite(action.reference) ? loss / action.reference : loss > 0 ? Infinity : 0;
  const uncertainty = clamp01(action.modelUncertainty);
  const exposure = clamp01(action.correlatedExposure);
  const impact = clamp01(action.decisionImpact);
  const deep: string[] = [];
  if (action.portfolioWide) deep.push('a portfolio-wide assumption: every plan rests on it');
  if (lossShare >= t.deepLossShare) deep.push(`potential loss is ${pct(lossShare)} of the reference (deep at ${pct(t.deepLossShare)})`);
  if (action.irreversible && lossShare >= t.deepIrreversibleLossShare) deep.push(`irreversible, and the loss is ${pct(lossShare)} of the reference`);
  if (exposure >= t.deepExposure) deep.push(`${pct(exposure)} of the value shares one dependency`);
  if (impact >= t.deepImpact) deep.push(`the decision turns on it (impact ${pct(impact)})`);
  if (uncertainty >= t.deepUncertainty && lossShare > t.basicLossShare) deep.push(`model uncertainty ${pct(uncertainty)} on a loss that is not small`);
  if (deep.length > 0) return { tier: 'DEEP', because: deep, lossShare };
  const notBasic: string[] = [];
  if (action.irreversible) notBasic.push('irreversible');
  if (lossShare > t.basicLossShare) notBasic.push(`potential loss is ${pct(lossShare)} of the reference (basic at or under ${pct(t.basicLossShare)})`);
  if (uncertainty > t.basicUncertainty) notBasic.push(`model uncertainty ${pct(uncertainty)}`);
  if (exposure > t.basicExposure) notBasic.push(`${pct(exposure)} shared exposure`);
  if (impact > t.basicImpact) notBasic.push(`decision impact ${pct(impact)}`);
  if (notBasic.length > 0) return { tier: 'STANDARD', because: notBasic, lossShare };
  return { tier: 'BASIC_INVARIANTS', because: ['small, reversible, confident, unshared and with little bearing on the decision: basic invariants only'], lossShare };
}

// ─── Findings ────────────────────────────────────────────────────────────────

/** The ways a commercial conclusion is commonly wrong (S-0476). A mode is a kind of check, not a whitelist of businesses. */
export type FailureMode =
  | 'INVARIANT'
  | 'UNREPRESENTATIVE_DATA'
  | 'SURVIVORSHIP_BIAS'
  | 'STALE_PRICES'
  | 'REGIME_CHANGE'
  | 'POSTED_VS_PAID_PRICE'
  | 'UNREACHABLE_BUYERS'
  | 'SUPPLIER_CONSTRAINT'
  | 'UNACCOUNTED_OBLIGATIONS'
  | 'FAVOURABLE_CONVERSION'
  | 'SHARED_DEPENDENCY'
  | 'CASH_TIMING'
  | 'REFUNDS'
  | 'LEGAL_COUNTERPARTY'
  | 'SENSITIVITY'
  | 'SELF_AGREEMENT'
  | 'UNCALIBRATED_TARGET';

export type ChallengeMethod =
  | 'INVARIANT_CHECK'
  | 'INDEPENDENT_MODEL'
  | 'MATHEMATICAL_CHECK'
  | 'COUNTERFACTUAL'
  | 'HELD_OUT_EVIDENCE'
  | 'ADVERSARIAL_SEARCH'
  | 'STATISTICAL_TEST'
  | 'PRODUCTION_HISTORY'
  | 'CORRELATED_STRESS';

export interface ChallengeFinding {
  mode: FailureMode;
  /** The activity, resource or plan the finding is about. */
  subject: string;
  /** The assumption that matters. */
  assumption: string;
  /** The observation or method that would test it. */
  test: string;
  /** A concrete alternative structure or safeguard that makes the plan more robust. */
  saferStructure: string;
  severity: 'BLOCKING' | 'MATERIAL' | 'MINOR';
  /** How the finding was established: by the data's own shape, or by recomputing outcomes. */
  method: ChallengeMethod;
  /** The measured effect, when one was recomputed (share of worlds reaching the target). */
  measured?: { reachBefore: number; reachAfter: number };
}

/**
 * Facts about an activity the portfolio's samples do not carry. Every field is
 * optional, and an absent fact is never read as the favourable answer: it is
 * a finding naming the observation that would supply it (invariant 39).
 */
export interface ActivityFacts {
  /** When the prices behind the cash samples were observed (ISO-8601). */
  priceObservedAt?: string;
  /** Whether the prices are what buyers actually paid, or only what was posted. */
  priceKind?: 'PAID' | 'POSTED';
  /** Whether the buyers the plan counts on have been reached at least once (a reply, a call, a sale). */
  buyersReached?: boolean;
  /** Units a supplier can deliver in the period, against the units the plan needs. */
  supplierCapacity?: { available: number; needed: number };
  /** Whether every obligation (fees, taxes, fulfilment, guarantees) is inside the samples. */
  obligationsAccounted?: boolean;
  /** The conversion rate the samples assume, and how many real attempts it rests on. */
  conversion?: { rate: number; attempts: number };
  /** Days between "settled" and cash the owner can actually spend (payout holds, reserves). */
  payoutHoldDays?: number;
  /** Share of settled cash refunded or charged back. */
  refundRate?: number;
  /** Whether the counterparty's legal exposure (contract, licence, liability) has been reviewed. */
  counterpartyReviewed?: boolean;
  /** Dependencies the samples do not name as `needs`, `riskGroup` or `market`. */
  supplier?: string;
  channel?: string;
  marketplace?: string;
  paymentProvider?: string;
}

/** A check run by something other than the model that produced the conclusion. */
export interface IndependentCheck {
  method: ChallengeMethod;
  /** Who ran it: a model, a person, a solver. */
  by: string;
  /** The data it was run over. */
  dataSource: string;
  /** Whether it agreed with the conclusion. */
  agrees: boolean;
  /** What it read, when it read the same quantity (share of worlds reaching the target). */
  reach?: number;
}

/** An outcome that actually happened (`quant/ledger.ts`), kept apart from every forecast. */
export interface ActualResult {
  settled: number;
  at: string;
  source: string;
}

export interface ChallengeInput {
  problem: PortfolioProblem;
  /** The optimizer's own answer for that problem. */
  result: PortfolioResult;
  action: ScrutinyInput;
  thresholds?: ScrutinyThresholds;
  /** Who produced the conclusion, so a check by the same model or over the same data is not counted. */
  producedBy: { model: string; dataSource: string };
  facts?: Record<string, ActivityFacts>;
  checks?: IndependentCheck[];
  /** True once a person or rule has accepted the plan. */
  accepted?: { by: string; at: string };
  actual?: ActualResult;
  /** "Now", for staleness. Defaults to the current time. */
  now?: string;
  /** Prices older than this many days are stale. */
  staleAfterDays?: number;
}

// ─── Shared exposure ─────────────────────────────────────────────────────────

export type ExposureKind = 'RESOURCE' | 'RISK_GROUP' | 'MARKET' | 'SUPPLIER' | 'CHANNEL' | 'MARKETPLACE' | 'PAYMENT_PROVIDER';

export interface SharedExposure {
  kind: ExposureKind;
  id: string;
  /** Members of the recommended combination that share it. */
  members: string[];
  /** Probability, for the period, that it fails — only when the problem states one. */
  failureProbability: number | null;
  /** Share of worlds reaching the target if it fails (every member that shares it settles nothing). */
  reachIfItFails: number;
  /** Share of worlds reaching the target as planned. */
  reachAsPlanned: number;
}

export interface ExposureProposal {
  kind: 'INDEPENDENT_SUBSTITUTE' | 'REDUCED_COMMITMENT' | 'DECORRELATING_SAFEGUARD';
  exposure: string;
  description: string;
  keys: string[];
  /** Recomputed on the same worlds. */
  reading: PortfolioReading;
  /** Share of worlds reaching the target if the exposure fails, after the change. */
  reachIfItFails: number;
  /** Capital and spend tied up, before and after, so a reduction's economics are visible. */
  capitalBefore: number;
  capitalAfter: number;
  /** The probability the evidence supports for the changed plan: `assess()`, never coverage. */
  assurance: Assurance;
  /** True when it is economically defensible: it does not lower contribution below zero and it makes the plan survive the exposure better, or ties up less for no loss of reach. */
  defensible: boolean;
  /** What must still be true for it to work (a second supplier must exist, its failure rate must be stated). */
  requires: string[];
}

export interface ExposureReport {
  exposures: SharedExposure[];
  proposals: ExposureProposal[];
  /** The best defensible proposal, if any. */
  recommended: ExposureProposal | null;
  /** Dependencies shared through facts alone, with no stated failure probability: research, not an assumption. */
  researchNeeds: string[];
}

function exposuresOf(one: Activity, facts: ActivityFacts | undefined): Array<{ kind: ExposureKind; id: string }> {
  const out: Array<{ kind: ExposureKind; id: string }> = [];
  for (const r of one.needs ?? []) out.push({ kind: 'RESOURCE', id: r });
  if (one.riskGroup) out.push({ kind: 'RISK_GROUP', id: one.riskGroup });
  if (one.market) out.push({ kind: 'MARKET', id: one.market });
  if (facts?.supplier) out.push({ kind: 'SUPPLIER', id: facts.supplier });
  if (facts?.channel) out.push({ kind: 'CHANNEL', id: facts.channel });
  if (facts?.marketplace) out.push({ kind: 'MARKETPLACE', id: facts.marketplace });
  if (facts?.paymentProvider) out.push({ kind: 'PAYMENT_PROVIDER', id: facts.paymentProvider });
  return out;
}

const exposureKey = (e: { kind: ExposureKind; id: string }) => `${e.kind}:${e.id}`;

function subProblem(problem: PortfolioProblem, keys: string[]): PortfolioProblem {
  const keep = new Set(keys);
  return { ...problem, activities: problem.activities.filter((a) => keep.has(a.key)), safeguards: undefined };
}

/** Reads `keys` running together, on the same worlds the optimizer drew (samples and outages are seeded by key). */
function readKeys(problem: PortfolioProblem, keys: string[]): PortfolioReading | null {
  if (keys.length === 0) return null;
  const read = evaluateCombination(subProblem(problem, keys));
  return 'missing' in read ? null : read;
}

/** The same combination in the worlds where `exposure` has failed: every member sharing it settles nothing. */
function readIfFails(problem: PortfolioProblem, keys: string[], exposure: { kind: ExposureKind; id: string }, facts: Record<string, ActivityFacts>): number {
  if (exposure.kind === 'RESOURCE') {
    const read = readKeys({ ...problem, resourceFailure: { ...(problem.resourceFailure ?? {}), [exposure.id]: 1 } }, keys);
    return read?.reach ?? 0;
  }
  const byKey = new Map(problem.activities.map((a) => [a.key, a]));
  const survivors = keys.filter((k) => !exposuresOf(byKey.get(k)!, facts[k]).some((e) => exposureKey(e) === exposureKey(exposure)));
  return readKeys(problem, survivors)?.reach ?? 0;
}

const capitalOf = (problem: PortfolioProblem, keys: string[]) =>
  problem.activities.filter((a) => keys.includes(a.key)).reduce((sum, a) => sum + (a.capital ?? 0), 0);

/**
 * Find what members of the recommended combination share — a resource they
 * need, a risk group, a market, or a supplier, channel, marketplace or payment
 * provider named in their facts — quantify the joint failure on the same
 * worlds, and propose independent substitutes, reduced commitment or a
 * decorrelating safeguard, each recomputed through the portfolio evaluator.
 * The probability attached to every proposal is `assess()`'s; a proposal
 * never raises a figure above what the evidence supports.
 */
export function detectSharedExposure(problem: PortfolioProblem, best: PortfolioReading, facts: Record<string, ActivityFacts> = {}): ExposureReport {
  const byKey = new Map(problem.activities.map((a) => [a.key, a]));
  const members = best.keys.filter((k) => byKey.has(k));
  const groups = new Map<string, { kind: ExposureKind; id: string; members: string[] }>();
  for (const k of members) {
    for (const e of exposuresOf(byKey.get(k)!, facts[k])) {
      const g = groups.get(exposureKey(e)) ?? { ...e, members: [] };
      if (!g.members.includes(k)) g.members.push(k);
      groups.set(exposureKey(e), g);
    }
  }
  const shared = [...groups.values()].filter((g) => g.members.length >= 2).sort((a, b) => exposureKey(a).localeCompare(exposureKey(b)));
  const exposures: SharedExposure[] = shared.map((g) => ({
    kind: g.kind,
    id: g.id,
    members: g.members,
    failureProbability: g.kind === 'RESOURCE' ? (problem.resourceFailure?.[g.id] ?? null) : null,
    reachIfItFails: readIfFails(problem, members, g, facts),
    reachAsPlanned: best.reach,
  }));
  const researchNeeds = exposures
    .filter((e) => e.kind !== 'RESOURCE' && e.kind !== 'RISK_GROUP')
    .map((e) => `state how often ${e.kind.toLowerCase().replace('_', ' ')} "${e.id}" fails or cuts off ${e.members.join(', ')} (no failure probability is recorded)`);

  const proposals: ExposureProposal[] = [];
  const capitalBefore = capitalOf(problem, members);
  const consider = (kind: ExposureProposal['kind'], exposure: SharedExposure, description: string, keys: string[], reading: PortfolioReading | null, reachIfItFails: number, requires: string[], judgedOn: PortfolioProblem = problem) => {
    if (!reading || !reading.feasible) return;
    const capitalAfter = capitalOf(problem, keys);
    const survives = reachIfItFails > exposure.reachIfItFails + 1e-9;
    const cheaperNoWorse = capitalAfter < capitalBefore && reading.reach >= best.reach - 1e-9;
    proposals.push({
      kind,
      exposure: `${exposure.kind}:${exposure.id}`,
      description,
      keys,
      reading,
      reachIfItFails,
      capitalBefore,
      capitalAfter,
      assurance: assess(judgedOn, reading),
      defensible: reading.contribution >= 0 && (survives || cheaperNoWorse),
      requires,
    });
  };

  for (const exposure of exposures) {
    const e = { kind: exposure.kind, id: exposure.id };
    // Independent substitutes: activities outside the combination that do not share this exposure, swapped for each sharing member.
    const outside = problem.activities.filter((a) => !members.includes(a.key) && !exposuresOf(a, facts[a.key]).some((x) => exposureKey(x) === exposureKey(e)));
    for (const sharing of exposure.members) {
      for (const sub of outside) {
        const keys = [...members.filter((k) => k !== sharing), sub.key];
        consider('INDEPENDENT_SUBSTITUTE', exposure, `replace "${sharing}" with "${sub.key}", which does not depend on ${exposure.kind.toLowerCase()} "${exposure.id}"`, keys, readKeys(problem, keys), readIfFails(problem, keys, e, facts), []);
      }
    }
    // Reduced commitment: keep the strongest sharing member, drop one other at a time.
    for (const sharing of exposure.members) {
      const keys = members.filter((k) => k !== sharing);
      if (keys.length === 0) continue;
      consider('REDUCED_COMMITMENT', exposure, `drop "${sharing}" so less of the plan rides on ${exposure.kind.toLowerCase()} "${exposure.id}"`, keys, readKeys(problem, keys), readIfFails(problem, keys, e, facts), []);
    }
    // A shared risk group can be broken by an independent channel or counterparty: measured, and it requires that one to exist.
    if (exposure.kind === 'RISK_GROUP') {
      const guard: Safeguard = { key: `decorrelate:${exposure.id}`, kind: 'INDEPENDENT_CHANNEL', decorrelate: exposure.members.slice(1) };
      const { after } = readWithSafeguard(subProblem(problem, members), members, guard);
      // After the move only the first member still rides on the group; if the group's shock hits, the rest keep running.
      const moved: PortfolioProblem = { ...problem, activities: problem.activities.map((a) => (guard.decorrelate!.includes(a.key) ? { ...a, riskGroup: undefined } : a)) };
      const ifFails = readKeys(moved, members.filter((k) => k !== exposure.members[0]))?.reach ?? 0;
      consider('DECORRELATING_SAFEGUARD', exposure, `move ${exposure.members.slice(1).join(', ')} onto a channel or counterparty independent of risk group "${exposure.id}"`, members, after, ifFails, [`an independent channel or counterparty for ${exposure.members.slice(1).join(', ')} must exist and be recorded`]);
    }
  }
  const defensible = proposals.filter((p) => p.defensible);
  // Robustness first: the proposal that survives the exposure best, then the optimizer's own ordering.
  defensible.sort((a, b) => b.reachIfItFails - a.reachIfItFails || compareReadings(a.reading, b.reading) || a.capitalAfter - b.capitalAfter);
  return { exposures, proposals, recommended: defensible[0] ?? null, researchNeeds };
}

// ─── The challenge ───────────────────────────────────────────────────────────

/** The four things a figure can be. They are never merged. */
export interface FourKinds {
  /** Share of simulated worlds reaching the target. A calculation over scenarios, not a probability. */
  CALCULATED_SCENARIO: { coverage: number | null; worlds: number | null };
  /** Only what `assess()` supports from evidence. Null when calibration is unavailable. */
  CALIBRATED_PROBABILITY: { status: Assurance['status']; range: { low: number; high: number } | null; claimsAtLeast90: boolean } | null;
  /** A plan a person or rule accepted. Null until one did. */
  ACCEPTED_PLAN: { keys: string[]; by: string; at: string } | null;
  /** What actually happened. Null until it happened. */
  ACTUAL_RESULT: ActualResult | null;
}

export type ChallengeVerdict =
  /** Nothing material: proceed. */
  | 'PASS'
  /** Proceed, carrying the findings. */
  | 'PASS_WITH_FINDINGS'
  /** The evidence cannot justify the claim: improve the plan and the evidence, do not declare the target proven. */
  | 'IMPROVE_PLAN_AND_EVIDENCE'
  /** An invariant fails: the conclusion cannot stand as computed. */
  | 'REFUSE';

export interface ChallengeReport {
  scrutiny: Scrutiny;
  /** The checks that ran, in order. A basic review runs only invariants. */
  ran: ChallengeMethod[];
  findings: ChallengeFinding[];
  exposure: ExposureReport | null;
  independentValidation: { counted: IndependentCheck[]; refusedAsSelfAgreement: IndependentCheck[]; disagreeing: IndependentCheck[] };
  kinds: FourKinds;
  /** When the evidence cannot justify 90%: the concrete improvements to the plan and its evidence. */
  improvements: string[];
  verdict: ChallengeVerdict;
}

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : 'unbounded');

function invariants(problem: PortfolioProblem, result: PortfolioResult): ChallengeFinding[] {
  const out: ChallengeFinding[] = [];
  const add = (subject: string, assumption: string, test: string, saferStructure: string) =>
    out.push({ mode: 'INVARIANT', subject, assumption, test, saferStructure, severity: 'BLOCKING', method: 'INVARIANT_CHECK' });
  if (!(problem.target > 0)) add('plan', `the target ${problem.target} is a positive amount`, 'read the goal row the target came from', 'restate the target from the goal record before acting');
  if (!(problem.deadlineDays > 0)) add('plan', `the deadline ${problem.deadlineDays} is a positive number of days`, 'read the goal row the deadline came from', 'restate the deadline from the goal record before acting');
  for (const a of problem.activities) {
    if (a.cash.length === 0 || a.cash.length !== a.days.length) add(a.key, 'cash and days samples are paired', `count the samples behind "${a.key}"`, `rebuild "${a.key}" from its observations with one day figure per cash figure`);
    if (a.days.some((d) => !(d >= 0)) || a.cash.some((c) => !Number.isFinite(c))) add(a.key, 'every sample is a finite amount at a non-negative day', `inspect "${a.key}"'s samples for negative days or non-finite cash`, `drop or correct the malformed samples of "${a.key}" and recompute`);
  }
  const needed = [...new Set(problem.activities.flatMap((a) => a.needs ?? []))];
  for (const r of needed) {
    const p = problem.resourceFailure?.[r];
    if (p === undefined || !(p >= 0 && p <= 1)) add(r, `resource "${r}" is reliable`, `measure how often "${r}" fails over the period`, `state a failure probability for "${r}" or plan without it`);
  }
  if (result.best && !result.best.feasible) add(result.best.keys.join('+'), 'the recommended combination can run', 'check capacity, exclusions and capital for the combination', 'choose a feasible combination');
  return out;
}

function failureModes(problem: PortfolioProblem, best: PortfolioReading, facts: Record<string, ActivityFacts>, now: Date, staleAfterDays: number): ChallengeFinding[] {
  const out: ChallengeFinding[] = [];
  const members = problem.activities.filter((a) => best.keys.includes(a.key));
  for (const a of members) {
    const f = facts[a.key] ?? {};
    const sample = effectiveSample(a);
    const add = (mode: FailureMode, assumption: string, test: string, saferStructure: string, severity: ChallengeFinding['severity'] = 'MATERIAL') =>
      out.push({ mode, subject: a.key, assumption, test, saferStructure, severity, method: 'STATISTICAL_TEST' });
    if (!a.justified || sample.size === undefined || sample.size < MIN_EVIDENCE_SAMPLE) {
      add('UNREPRESENTATIVE_DATA', `the samples behind "${a.key}" represent the market it will meet (${sample.size === undefined ? 'no sample size stated' : `${sample.size} observation(s)`})`, `collect at least ${MIN_EVIDENCE_SAMPLE} independent observations of "${a.key}"'s outcome, or hold out part of the record and compare`, `run "${a.key}" as a small reversible probe first and commit capital only once its outcomes are observed`);
    }
    if (a.cash.every((c) => c > 0) && !a.evidence?.history?.winRate) {
      add('SURVIVORSHIP_BIAS', `every attempt at "${a.key}" pays something (no sample settles zero, and no bid/win record shows the losers)`, `acquire the bid/win record — attempts that failed as well as those that sold`, `add zero-outcome worlds at the observed loss rate, or size "${a.key}" so a run of losses is survivable`);
    }
    if (f.priceObservedAt === undefined) {
      add('STALE_PRICES', `the prices behind "${a.key}" are current (no observation date recorded)`, `record when each price was observed and re-observe any older than ${staleAfterDays} days`, `quote from a fresh observation, or carry a price haircut until one is taken`);
    } else {
      const ageDays = (now.getTime() - Date.parse(f.priceObservedAt)) / 86_400_000;
      if (!(ageDays <= staleAfterDays)) add('STALE_PRICES', `prices observed ${Number.isFinite(ageDays) ? `${Math.round(ageDays)} days ago` : 'at an unreadable date'} still hold for "${a.key}"`, `re-observe the price at its source now`, `refresh the price before committing, and cap commitment until it is refreshed`);
    }
    if (a.evidence?.conditionsChanged) {
      add('REGIME_CHANGE', `the regime "${a.key}"'s observations came from still holds`, `compare recent outcomes against the older record (a split-sample test)`, `weight recent observations, shorten the commitment and re-check at the first settlement`);
    }
    if (f.priceKind !== 'PAID') {
      add('POSTED_VS_PAID_PRICE', `${f.priceKind === 'POSTED' ? 'posted prices are' : 'the prices are'} what buyers of "${a.key}" actually pay`, `obtain completed-transaction prices (sold listings, invoices, settlement records)`, `model from paid prices, or apply the observed posted-to-paid discount`);
    }
    if (f.buyersReached !== true) {
      add('UNREACHABLE_BUYERS', `the buyers "${a.key}" counts on can be reached through the planned route`, `send the first contacts and measure replies before relying on volume`, `secure one reply or order before buying capacity; keep a second route to the same buyers`);
    }
    if ((a.needs?.length ?? 0) > 0 && f.supplierCapacity === undefined) {
      add('SUPPLIER_CONSTRAINT', `the supplier behind "${a.key}" can deliver the volume the plan needs`, `ask the supplier for committed capacity and lead time`, `name a second supplier or cap the plan at the confirmed volume`);
    } else if (f.supplierCapacity && f.supplierCapacity.available < f.supplierCapacity.needed) {
      add('SUPPLIER_CONSTRAINT', `the supplier delivers ${f.supplierCapacity.needed} although ${f.supplierCapacity.available} is confirmed`, `confirm the shortfall with the supplier`, `cut "${a.key}" to the confirmed ${f.supplierCapacity.available} or add a second supplier`, 'BLOCKING');
    }
    if (problem.reachOn !== 'KEPT' && f.obligationsAccounted !== true) {
      add('UNACCOUNTED_OBLIGATIONS', `"${a.key}"'s settled cash is free of fees, taxes, fulfilment and guarantees`, `list every obligation the activity creates and subtract it in each world`, `judge the plan on cash kept (reachOn KEPT) with every obligation as spend`);
    }
    if (!a.evidence?.history?.winRate && (f.conversion === undefined || f.conversion.attempts < MIN_EVIDENCE_SAMPLE)) {
      add('FAVOURABLE_CONVERSION', `the conversion rate behind "${a.key}"${f.conversion ? ` (${pct(f.conversion.rate)} over ${f.conversion.attempts} attempt(s))` : ''} will hold`, `measure conversion over at least ${MIN_EVIDENCE_SAMPLE} real attempts`, `size the plan at the lower bound of the observed conversion, not its point estimate`);
    }
    if (f.payoutHoldDays === undefined) {
      add('CASH_TIMING', `cash from "${a.key}" is usable the day it settles`, `read the payment provider's payout schedule and reserve terms`, `count cash only from the day it can be spent, and hold a reserve against payout holds`);
    }
    if (f.refundRate === undefined) {
      add('REFUNDS', `none of "${a.key}"'s settled cash comes back as refunds or chargebacks`, `read the refund and chargeback record for this kind of sale`, `hold back the observed refund share until the refund window closes`);
    }
    if (f.counterpartyReviewed !== true) {
      add('LEGAL_COUNTERPARTY', `the counterparty behind "${a.key}" carries no legal exposure the plan has not priced`, `review the contract, licence and liability terms with the counterparty`, `use written terms with a liability cap, or keep the deal small until reviewed`);
    }
  }
  return out;
}

/** Counterfactuals measured on the same worlds: a price haircut, slower cash, refunds and payout holds where stated. */
function sensitivity(problem: PortfolioProblem, best: PortfolioReading, facts: Record<string, ActivityFacts>): ChallengeFinding[] {
  const out: ChallengeFinding[] = [];
  const members = best.keys;
  const variant = (label: string, change: (a: Activity) => Activity) => {
    const changed: PortfolioProblem = { ...problem, activities: problem.activities.map((a) => (members.includes(a.key) ? change(a) : a)) };
    const read = readKeys(changed, members);
    return { label, reach: read?.reach ?? 0 };
  };
  const haircut = variant('a 20% lower price', (a) => ({ ...a, cash: a.cash.map((c) => c * 0.8) }));
  const slower = variant('cash 50% slower to arrive', (a) => ({ ...a, days: a.days.map((d) => d * 1.5) }));
  const stated = variant('the stated refunds and payout holds', (a) => {
    const f = facts[a.key] ?? {};
    const keep = 1 - clamp01(f.refundRate ?? 0);
    const hold = Math.max(0, f.payoutHoldDays ?? 0);
    return { ...a, cash: a.cash.map((c) => c * keep), days: a.days.map((d) => d + hold) };
  });
  for (const v of [haircut, slower, stated]) {
    const drop = best.reach - v.reach;
    if (drop <= 0.05) continue;
    out.push({
      mode: v === stated ? 'CASH_TIMING' : 'SENSITIVITY',
      subject: members.join('+'),
      assumption: `the plan's reach survives ${v.label}`,
      test: `recompute on the same worlds with ${v.label} (done: reach falls from ${pct(best.reach)} to ${pct(v.reach)})`,
      saferStructure: v === haircut ? 'add a member whose cash does not move with this price, or lower the target commitment to what survives the haircut' : 'shorten the cash cycle (deposits, faster payout) or start earlier so slow cash still lands by the deadline',
      severity: drop > 0.25 ? 'BLOCKING' : 'MATERIAL',
      method: 'COUNTERFACTUAL',
      measured: { reachBefore: best.reach, reachAfter: v.reach },
    });
  }
  return out;
}

/**
 * Challenge a conclusion at the depth its consequence earns. A basic review
 * runs invariants only, so a minor reversible action is not held up by the
 * heavy review; a standard one adds the failure-mode checks and counterfactual
 * sensitivity; a deep one adds shared-exposure detection, correlated stress,
 * and requires validation that did not come from the producing model or data.
 */
export function challenge(input: ChallengeInput): ChallengeReport {
  const { problem, result } = input;
  const facts = input.facts ?? {};
  const scrutiny = scrutinyFor(input.action, input.thresholds);
  const ran: ChallengeMethod[] = ['INVARIANT_CHECK'];
  const findings = invariants(problem, result);
  const best = result.best;

  const checks = input.checks ?? [];
  const self = (c: IndependentCheck) => c.by === input.producedBy.model || c.dataSource === input.producedBy.dataSource;
  const refusedAsSelfAgreement = checks.filter(self);
  const counted = checks.filter((c) => !self(c));
  const disagreeing = counted.filter((c) => !c.agrees);

  let exposure: ExposureReport | null = null;
  if (best && scrutiny.tier !== 'BASIC_INVARIANTS') {
    ran.push('STATISTICAL_TEST', 'COUNTERFACTUAL');
    findings.push(...failureModes(problem, best, facts, input.now ? new Date(input.now) : new Date(), input.staleAfterDays ?? 30));
    findings.push(...sensitivity(problem, best, facts));
  }
  if (best && scrutiny.tier === 'DEEP') {
    ran.push('CORRELATED_STRESS', 'ADVERSARIAL_SEARCH');
    exposure = detectSharedExposure(problem, best, facts);
    for (const e of exposure.exposures) {
      const fix = exposure.recommended?.exposure === `${e.kind}:${e.id}` ? exposure.recommended : exposure.proposals.find((p) => p.exposure === `${e.kind}:${e.id}` && p.defensible);
      findings.push({
        mode: 'SHARED_DEPENDENCY',
        subject: `${e.kind}:${e.id}`,
        assumption: `${e.members.join(', ')} fail independently, although they all depend on ${e.kind.toLowerCase().replace('_', ' ')} "${e.id}"`,
        test: e.failureProbability === null ? `measure how often "${e.id}" fails; meanwhile stress it: if it fails, reach falls from ${pct(e.reachAsPlanned)} to ${pct(e.reachIfItFails)}` : `stress it on the same worlds (done: if "${e.id}" fails, reach falls from ${pct(e.reachAsPlanned)} to ${pct(e.reachIfItFails)})`,
        saferStructure: fix ? `${fix.description}: reach ${pct(fix.reading.reach)}, ${pct(fix.reachIfItFails)} even if "${e.id}" fails${fix.requires.length ? `; requires ${fix.requires.join('; ')}` : ''}` : `find an activity that does not depend on "${e.id}", or reduce the commitment riding on it`,
        severity: e.reachAsPlanned - e.reachIfItFails > 0.25 ? 'BLOCKING' : 'MATERIAL',
        method: 'CORRELATED_STRESS',
        measured: { reachBefore: e.reachAsPlanned, reachAfter: e.reachIfItFails },
      });
    }
    if (counted.length === 0) {
      findings.push({
        mode: 'SELF_AGREEMENT',
        subject: best.keys.join('+'),
        assumption: 'the conclusion is right because the model that produced it says so',
        test: refusedAsSelfAgreement.length ? `the ${refusedAsSelfAgreement.length} offered check(s) came from "${input.producedBy.model}" or "${input.producedBy.dataSource}" and are not independent; check with a different model, held-out evidence or production history` : 'check with a different model, held-out evidence or production history',
        saferStructure: 'commit only the reversible first step until an independent check agrees',
        severity: 'MATERIAL',
        method: 'INDEPENDENT_MODEL',
      });
    }
  }
  for (const c of disagreeing) {
    findings.push({
      mode: 'SELF_AGREEMENT',
      subject: best?.keys.join('+') ?? 'plan',
      assumption: `the conclusion holds although an independent ${c.method.toLowerCase().replace('_', ' ')} by "${c.by}" disagrees${c.reach !== undefined ? ` (it reads ${pct(c.reach)})` : ''}`,
      test: `reconcile the two readings on the same inputs and find the input they differ on`,
      saferStructure: 'plan on the lower of the two readings until the difference is explained',
      severity: 'MATERIAL',
      method: c.method,
    });
  }
  if (refusedAsSelfAgreement.length) ran.push('INDEPENDENT_MODEL');

  const assurance = result.assurance ?? assess(problem, best);
  const improvements: string[] = [];
  if (scrutiny.tier !== 'BASIC_INVARIANTS' && best && !assurance.claimsAtLeast90) {
    findings.push({
      mode: 'UNCALIBRATED_TARGET',
      subject: best.keys.join('+'),
      assumption: `the target is met at ${pct(CLAIM_THRESHOLD)}, read from ${pct(best.reach)} of simulated worlds`,
      test: assurance.status === 'RANGE' ? `the evidence supports ${pct(assurance.range!.low)}–${pct(assurance.range!.high)}; enlarge the smallest sample behind any member` : `calibrate the inputs: ${assurance.validationProblems.join('; ')}`,
      saferStructure: exposure?.recommended ? exposure.recommended.description : 'improve the plan and its evidence (below) rather than reading scenario coverage as the target met',
      severity: 'MATERIAL',
      method: 'MATHEMATICAL_CHECK',
    });
    improvements.push(...assurance.validationProblems.map((p) => `evidence: ${p}`));
    improvements.push(...(assurance.researchNeeds ?? []).map((n) => `research: ${n}`));
    if (exposure?.recommended) improvements.push(`plan: ${exposure.recommended.description}`);
    improvements.push(...(exposure?.researchNeeds ?? []).map((n) => `research: ${n}`));
    for (const f of findings) if (f.severity === 'BLOCKING' && f.mode !== 'INVARIANT') improvements.push(`plan: ${f.saferStructure}`);
    if (improvements.length === 0) improvements.push(`evidence: enlarge the sample behind the weakest member until the lower bound clears ${pct(CLAIM_THRESHOLD)}`);
  }

  const kinds: FourKinds = {
    CALCULATED_SCENARIO: { coverage: best?.reach ?? null, worlds: problem.worlds ?? null },
    CALIBRATED_PROBABILITY: assurance.status === 'CALIBRATION_UNAVAILABLE' ? null : { status: assurance.status, range: assurance.range, claimsAtLeast90: assurance.claimsAtLeast90 },
    ACCEPTED_PLAN: input.accepted && best ? { keys: best.keys, by: input.accepted.by, at: input.accepted.at } : null,
    ACTUAL_RESULT: input.actual ?? null,
  };

  const blocking = findings.some((f) => f.severity === 'BLOCKING' && f.mode === 'INVARIANT');
  const verdict: ChallengeVerdict = blocking
    ? 'REFUSE'
    : improvements.length > 0
      ? 'IMPROVE_PLAN_AND_EVIDENCE'
      : findings.some((f) => f.severity !== 'MINOR')
        ? 'PASS_WITH_FINDINGS'
        : 'PASS';
  return { scrutiny, ran, findings, exposure, independentValidation: { counted, refusedAsSelfAgreement, disagreeing }, kinds, improvements, verdict };
}
