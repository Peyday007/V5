/**
 * The fallback watch on the one consequential dependency every cash knowledge
 * refresh already holds: the cash forecast the goals' plans are read from
 * (FALL-37-4, run in production by `knowledge.ts loadCashKnowledge`).
 *
 * The switch criteria, early warning, multi-level reliability and failure
 * record in `fallbackSwitch.ts` and `ledger.ts` are general. What makes them
 * act is a dependency whose failures are rows, and the forecast is one: each
 * version of a cash claim is a prediction, each outcome measured against it
 * says whether the path held, and `learning.ts` diagnoses every miss and names
 * the smallest reusable correction. On every refresh this module:
 *
 *   * records every miss as a failure (`recordFailureRecovery`): whether it was
 *     detected before the horizon closed, what Brain tried (the corrections that
 *     name the claim), and whether the path recovered — the next outcome on the
 *     same claim — settled as soon as that outcome is measured;
 *   * reads the calibration as an early-warning signal (`earlyWarning`,
 *     FORECAST_DRIFT, at the calibrator's own miscalibration threshold) and takes
 *     the preventive action it justifies: the plans resting on a drifting claim
 *     are handed back for a re-read (`goals/plan.ts requestGoalPlanPass`, the
 *     owner of plan recomputation) before a further miss, not after;
 *   * judges each correction as a switch from the uncorrected forecast to the
 *     corrected one (`switchDecision`, authority through `authorityForSwitch`):
 *     a research or software correction is Brain's own reversible work and fails
 *     over automatically; one that changes how commercial work is run touches
 *     counterparties and escalates, naming what is not known;
 *   * states the forecast pathway's reliability (`readReliability`) on the
 *     outcomes on record, never an assurance the sample cannot support;
 *   * reads the failure record back (`recurringFailureClasses`) and hands every
 *     recurring class that names a method to improve to Factory through the
 *     improvement register (§87), idempotent by weakness key.
 *
 * Nothing here is a second store, scheduler or authority path: failures are
 * `bin_events` through the ledger's writer, plans are re-read by their owner,
 * authority is `cash/authority.ts`, Factory's intake is the register (§10.3,
 * §20.4). No category or industry is special: the watch reads whatever claims
 * the ledger holds.
 */
import { makeFigure, unknownFigure, type Figure } from './graph.ts';
import type { Dependency, Substitute } from './fallbacks.ts';
import {
  authorityForSwitch,
  earlyWarning,
  readReliability,
  safeguardEffect,
  switchDecision,
  type GoalPortfolioReach,
  type PreventiveAction,
  type ReliabilityReading,
  type SafeguardEffect,
  type SwitchAuthority,
  type SwitchDecision,
  type SwitchFacts,
  type WarningSignal,
} from './fallbackSwitch.ts';
import { MISCALIBRATION_Z, type Correction, type LedgerEntry, type MissDiagnosis } from './forecast.ts';
import type { ModelLearningReading } from './learning.ts';
import {
  readFailureRecoveries,
  recordFailureRecovery,
  recurringFailureClasses,
  type FailureRecoveryInput,
  type FailureRecoveryRecord,
  type RecurringFailureClass,
} from './ledger.ts';
import { upsertCandidate } from '../../repos/improvement.ts';
import { getDb } from '../../db/database.ts';

const DAY_MS = 86_400_000;

export interface FallbackWatchDeps {
  record?: NonNullable<Parameters<typeof recordFailureRecovery>[1]>['record'];
  /** The failure record as it stands; defaults to this project's `bin_events`. */
  readRecoveries?: () => Promise<FailureRecoveryRecord[]>;
  authority?: (projectId: string, action: string | null) => Promise<SwitchAuthority>;
  /** Hand a goal's plan back for a re-read; defaults to `goals/plan.ts requestGoalPlanPass`. */
  replan?: (goalId: string, why: string) => Promise<void> | void;
  /** The goals whose plans rest on each claim (`knowledge.ts cashDependencyGraph`, inverted). */
  dependents?: ReadonlyMap<string, readonly string[]>;
  toFactory?: typeof upsertCandidate;
  /** The goals' portfolios as their latest plan readings state them; defaults to `goal_plan_readings`. */
  goalPortfolios?: (goalIds: readonly string[]) => Promise<GoalPortfolioReach[]>;
}

export interface CorrectionSwitch {
  cause: string;
  owner: string;
  claimIds: readonly string[];
  decision: SwitchDecision;
}

export interface FallbackWatch {
  /** One dependency per forecast claim with a measured outcome. */
  dependencies: Dependency[];
  /** Each miss recorded, the pathway of its own claim family, and whether this refresh wrote it. */
  failures: { occurrence: string; claimId: string; pathway: string; failureClass: string; recovered: boolean | null; written: boolean }[];
  warnings: { actions: PreventiveAction[]; unjudged: { dependency: string; kind: string; why: string }[] };
  /** Goals whose plans were handed back by a preventive action. */
  replanned: string[];
  switches: CorrectionSwitch[];
  /** Pathway, goal-portfolio and correlated-downside reliability, and time to recovery. */
  reliability: ReliabilityReading;
  /** What each correction, as a safeguard, changes in the pathway's chance of success and its expected net. */
  safeguards: SafeguardEffect[];
  recurring: RecurringFailureClass[];
  /** Recurring classes handed to Factory, by weakness key. */
  improvements: { weaknessKey: string; created: boolean }[];
}

function measuredProbability(meaning: string, value: number, source: string): Figure {
  const made = makeFigure({ meaning, unit: 'probability', value, status: 'OBSERVED', source });
  return made.ok ? made.figure : unknownFigure(meaning, 'probability');
}

/** A miss is a diagnosed failure of the path; NOT_A_MISS held, UNJUDGED says nothing either way. */
function isMiss(d: MissDiagnosis | undefined): boolean {
  return !!d && (d.kind === 'SYSTEMATIC' || d.kind === 'EXPECTED_MISS');
}

function failureClassOf(d: MissDiagnosis): string {
  return d.kind === 'SYSTEMATIC' ? `FORECAST_MISS:SYSTEMATIC:${d.causes[0] ?? 'UNATTRIBUTED'}` : 'FORECAST_MISS:EXPECTED';
}

/** Days the miss was measured after the claim's horizon closed; null when the claim stated no horizon. */
function detectionDelay(e: LedgerEntry): number | null {
  if (e.prediction.horizonDays === null || !e.outcome) return null;
  const end = Date.parse(e.prediction.madeAt) + e.prediction.horizonDays * DAY_MS;
  const seen = Date.parse(e.outcome.observedAt);
  if (!Number.isFinite(end) || !Number.isFinite(seen)) return null;
  return Math.max(0, Math.floor((seen - end) / DAY_MS));
}

/** Time to harm: the horizon the plan read the claim over; a miss detected after it is detected late. */
function timeToHarm(e: LedgerEntry): number | null {
  return e.prediction.horizonDays;
}

function correctionsOn(claimId: string, corrections: readonly Correction[]): Correction[] {
  return corrections.filter((c) => c.claimIds.includes(claimId));
}

/** What a correction would do, as a switch. Research and software corrections are Brain's own reversible work. */
export function correctionSwitchFacts(correction: Pick<Correction, 'owner'>): SwitchFacts {
  if (correction.owner === 'COMMERCIAL_OPERATIONS') {
    // How commercial work is run touches buyers and suppliers; nothing on record says what it commits to.
    return {
      internal: false,
      reversible: null,
      previouslyApproved: false,
      expandsContractTerms: null,
      spendsUnapprovedMoney: null,
      bypassesAccessRestriction: false,
      movesCustomerDataImproperly: false,
      incursNewObligation: null,
      primaryOutcomeKnown: true,
    };
  }
  // A new forecast version beside the old one (append-only), research questions or a register entry: no
  // counterparty, no money, nothing that cannot be superseded again.
  return {
    internal: true,
    reversible: true,
    previouslyApproved: false,
    expandsContractTerms: false,
    spendsUnapprovedMoney: false,
    bypassesAccessRestriction: false,
    movesCustomerDataImproperly: false,
    incursNewObligation: false,
    primaryOutcomeKnown: true,
  };
}

function correctionSubstitute(correction: Correction): Substitute {
  const internal = correction.owner !== 'COMMERCIAL_OPERATIONS';
  return {
    key: `correction:${correction.cause}`,
    label: `the forecast corrected for ${correction.cause.toLowerCase().replace(/_/g, ' ')}`,
    changes: correction.owner === 'COMMERCIAL_OPERATIONS' ? ['BUSINESS_ROLE'] : ['MODEL_ROUTE'],
    // Diagnosed from the ledger's own systematic misses: the correction is measured, not merely located.
    readiness: 'VALIDATED',
    capacity: unknownFigure('claims the corrected forecast can carry', 'claims'),
    failureProbability: unknownFigure('chance the corrected forecast misses too', 'probability'),
    // Raising the correction is Brain's own act either way; what a commercial change would commit to is in
    // the switch facts, where an unknown escalates to a person rather than refusing the correction outright.
    eligibility: {
      authorized: true,
      meetsObligations: true,
      basis: internal
        ? `Brain's own forecast work, diagnosed from ${correction.misses} systematic miss(es)`
        : `${correction.misses} systematic miss(es) trace to how commercial work was run; raised on the operation's own review`,
    },
    switchingCost: null,
    timeToSwitchDays: null,
    overrides: {},
    recoveryVerification: 'outcomes observed after the correction are compared with the misses that exposed it',
  };
}

/** The forecast claim as a dependency: its measured miss rate, and its corrections as substitutes. Pure. */
export function forecastDependencies(reading: Pick<ModelLearningReading, 'ledger' | 'diagnoses' | 'corrections'>): Dependency[] {
  const byClaim = new Map<string, LedgerEntry[]>();
  for (const e of reading.ledger) if (e.outcome) byClaim.set(e.prediction.claimId, [...(byClaim.get(e.prediction.claimId) ?? []), e]);
  const out: Dependency[] = [];
  for (const [claimId, entries] of [...byClaim].sort((a, b) => a[0].localeCompare(b[0]))) {
    const judged = entries.map((e) => reading.diagnoses.find((d) => d.predictionId === e.prediction.id && d.observedAt === e.outcome!.observedAt)).filter((d) => d && d.kind !== 'UNJUDGED');
    const misses = judged.filter(isMiss).length;
    const horizon = entries.find((e) => e.prediction.horizonDays !== null)?.prediction.horizonDays ?? null;
    out.push({
      key: claimId,
      label: `the forecast of ${claimId}`,
      servesActivity: 'the goal plans that read this cash claim',
      primaryPath: `the current version of ${claimId} as the cash forecast states it`,
      primaryFailureProbability:
        judged.length > 0 ? measuredProbability(`share of ${claimId}'s outcomes the forecast missed`, misses / judged.length, `forecast ledger: ${misses} miss(es) in ${judged.length} judged outcome(s)`) : unknownFigure(`share of ${claimId}'s outcomes missed`, 'probability'),
      failureModes: [
        {
          key: 'FORECAST_MISS',
          condition: 'the realized figure lands outside the range the claim stated',
          detectionSignals: ['an outcome measured against the claim', 'the comparable bucket miscalibrated'],
          failureEvidence: ['the outcome row the ledger measured the claim against'],
          timeToHarmDays: horizon === null ? unknownFigure('days until a plan acts on the missed figure', 'days') : measuredProbabilityDays(horizon, claimId),
          recoveryWindowDays: unknownFigure('days inside which a corrected forecast still changes the plan', 'days'),
          probability: judged.length > 0 ? measuredProbability(`chance ${claimId} misses`, misses / judged.length, 'forecast ledger') : unknownFigure(`chance ${claimId} misses`, 'probability'),
        },
      ],
      substitutes: correctionsOn(claimId, reading.corrections).map(correctionSubstitute),
      consequence: {
        cashAtRisk: unknownFigure('cash a plan built on the missed figure puts at risk', 'cents'),
        obligations: [],
        capability: 'goal plans read a forecast that does not match what money did',
        tolerableLoss: unknownFigure('loss the plans can bear from a missed forecast', 'cents'),
      },
    });
  }
  return out;
}

function measuredProbabilityDays(horizon: number, claimId: string): Figure {
  const made = makeFigure({ meaning: `the horizon ${claimId} is read over`, unit: 'days', value: horizon, status: 'OBSERVED', source: 'the prediction row' });
  return made.ok ? made.figure : unknownFigure(`the horizon ${claimId} is read over`, 'days');
}

/** Every miss on the ledger as a failure-and-recovery record. Pure. */
export function forecastFailures(reading: Pick<ModelLearningReading, 'ledger' | 'diagnoses' | 'corrections'>): FailureRecoveryInput[] {
  const resolved = reading.ledger
    .filter((e) => e.outcome)
    .map((e) => ({ e, d: reading.diagnoses.find((d) => d.predictionId === e.prediction.id && d.observedAt === e.outcome!.observedAt) }))
    .sort((a, b) => a.e.outcome!.observedAt.localeCompare(b.e.outcome!.observedAt) || a.e.prediction.id.localeCompare(b.e.prediction.id));
  const out: FailureRecoveryInput[] = [];
  for (const [i, { e, d }] of resolved.entries()) {
    if (!d || !isMiss(d)) continue;
    const claimId = e.prediction.claimId;
    // Recovery is the next judged outcome on the same claim: the path held again, or it missed again.
    const next = resolved.slice(i + 1).find((r) => r.e.prediction.claimId === claimId && r.d && r.d.kind !== 'UNJUDGED');
    const corrections = correctionsOn(claimId, reading.corrections);
    out.push({
      occurrence: `forecast-miss:${e.prediction.id}:${e.outcome!.evidence ?? e.outcome!.observedAt}`,
      dependency: claimId,
      failureMode: 'FORECAST_MISS',
      failureClass: failureClassOf(d),
      detectionDelayDays: detectionDelay(e),
      timeToHarmDays: timeToHarm(e),
      tried: corrections.map((c) => `correction of ${c.cause} by ${c.owner}`),
      recovered: next ? !isMiss(next.d) : null,
      cashLostCents: null,
      cashPreservedCents: null,
      timeLostDays: null,
      reputation: null,
      // An expected miss is the forecast's stated uncertainty, not a method that failed.
      methodsToImprove: d.kind === 'SYSTEMATIC' ? d.causes.map((c) => `${c} (${d.owner ?? 'UNOWNED'})`) : [],
    });
  }
  return out;
}

/** The calibration as early-warning signals, at the calibrator's own threshold. Pure. */
export function driftSignals(reading: Pick<ModelLearningReading, 'ledger' | 'calibration'>): WarningSignal[] {
  const claimsOf = new Map<string, Set<string>>();
  for (const e of reading.ledger) claimsOf.set(e.prediction.comparableKey, (claimsOf.get(e.prediction.comparableKey) ?? new Set()).add(e.prediction.claimId));
  const pooled = reading.calibration.filter((b) => b.scope === 'POOLED');
  const out: WarningSignal[] = [];
  for (const b of pooled.length > 0 ? pooled : reading.calibration) {
    for (const claimId of [...(claimsOf.get(b.comparableKey) ?? [])].sort()) {
      out.push({
        kind: 'FORECAST_DRIFT',
        dependency: claimId,
        observed: b.zScore === null ? null : Math.abs(b.zScore),
        // `forecast.ts` judges a bucket miscalibrated above this many standard errors; the warning uses the same bar.
        threshold: MISCALIBRATION_Z,
        source: `calibration of ${b.comparableKey}: ${b.n} resolved, verdict ${b.verdict}`,
      });
    }
  }
  return out;
}

/**
 * Each goal's portfolio as its latest plan reading states it (`goals/plan.ts persistReading`):
 * the accepted-or-candidate combination's reach and its basis, else the portfolio's best reach as
 * coverage. A goal with no reading, or one whose reading states no reach, is read as unknown.
 */
export async function readGoalPortfolioReach(goalIds: readonly string[]): Promise<GoalPortfolioReach[]> {
  const ids = [...new Set(goalIds)].sort();
  if (ids.length === 0) return [];
  const rows = await getDb().all<{ workstream_id: string; forecast: string | null }>(
    `SELECT r.workstream_id, r.forecast FROM goal_plan_readings r
      WHERE r.workstream_id IN (${ids.map(() => '?').join(',')})
        AND r.created_at = (SELECT MAX(x.created_at) FROM goal_plan_readings x WHERE x.workstream_id = r.workstream_id)`,
    [...ids],
  );
  const latest = new Map(rows.map((row) => [row.workstream_id, row.forecast]));
  return ids.map((goalId) => ({ goalId, ...portfolioReachOf(latest.get(goalId) ?? null) }));
}

/** The reach a stored plan forecast states, and its basis. Pure. */
export function portfolioReachOf(forecast: string | null): Pick<GoalPortfolioReach, 'reach' | 'basis'> {
  if (!forecast) return { reach: null, basis: null };
  type Stored = { reach?: unknown; acceptance?: { candidate?: { reach?: unknown; reachBasis?: unknown } | null } } | null;
  const parsed = ((): Stored => {
    try {
      return JSON.parse(forecast) as Stored;
    } catch {
      return null;
    }
  })();
  const candidate = parsed?.acceptance?.candidate ?? null;
  if (candidate && typeof candidate.reach === 'number' && Number.isFinite(candidate.reach)) {
    return { reach: candidate.reach, basis: candidate.reachBasis === 'PROBABILITY' ? 'PROBABILITY' : 'COVERAGE' };
  }
  // The portfolio's best reach without a candidate's basis is not called a probability.
  if (typeof parsed?.reach === 'number' && Number.isFinite(parsed.reach)) return { reach: parsed.reach, basis: 'COVERAGE' };
  return { reach: null, basis: null };
}

/** Each correction's effect as a safeguard: the pathway without it, then with it. Pure. */
export function correctionSafeguards(pathway: string, dependencies: readonly Dependency[]): SafeguardEffect[] {
  const out: SafeguardEffect[] = [];
  for (const d of dependencies) {
    for (const safeguard of d.substitutes) {
      const without = dependencies.map((x) => (x.key === d.key ? { ...x, substitutes: x.substitutes.filter((s) => s.key !== safeguard.key) } : x));
      out.push(
        safeguardEffect({
          pathway,
          dependencies: without,
          dependencyKey: d.key,
          safeguard,
          // Neither is on record for a forecast correction; the expected net stays unknown rather than assumed.
          valueAtStake: unknownFigure(`what ${pathway} is worth when it holds`, 'cents'),
          cost: unknownFigure(`what correcting ${d.key} costs`, 'cents'),
        }),
      );
    }
  }
  return out;
}

async function defaultReplan(goalId: string, why: string): Promise<void> {
  const { requestGoalPlanPass } = await import('../goals/plan.ts');
  requestGoalPlanPass(goalId, why);
}

/**
 * The family a claim belongs to: the prefix before the first ':' of its id (`cash`, `operator`, ...).
 * A claim id with no prefix is the cash forecast's own, as every claim this watch read before families existed.
 */
export function claimFamily(claimId: string): string {
  const at = claimId.indexOf(':');
  return at > 0 ? claimId.slice(0, at) : 'cash';
}

/**
 * The pathway a claim's failures sit on: a cash claim on `cash-forecast:<project>`, as the plans read it; any
 * other family (an operator decision, `operator:<id>`) on its own family's path, never on the cash forecast's.
 */
export function claimPathway(projectId: string, claimId: string): string {
  const family = claimFamily(claimId);
  return family === 'cash' ? `cash-forecast:${projectId}` : `${family}:${projectId}`;
}

/** A method `forecastFailures` names is owned by Factory when its owner suffix says so (`forecast.ts CAUSE_OWNER`). */
function factoryOwned(method: string): boolean {
  return method.endsWith('(FACTORY)');
}

/** Run the watch on one project's forecast reading. */
export async function watchForecastPath(projectId: string, reading: ModelLearningReading, deps: FallbackWatchDeps = {}): Promise<FallbackWatch> {
  const dependencies = forecastDependencies(reading);

  // 1. Every failure is recorded, and a recovery the record left open is settled when it is measured.
  const read = deps.readRecoveries ?? (() => readFailureRecoveries(projectId));
  let held = await read();
  const failures: FallbackWatch['failures'] = [];
  for (const input of forecastFailures(reading)) {
    const { record, written } = await recordFailureRecovery(input, { projectId, caller: 'fallback-watch', read: async () => held, ...(deps.record ? { record: deps.record } : {}) });
    if (written) held = [...held.filter((r) => r.occurrence !== record.occurrence), record];
    failures.push({ occurrence: record.occurrence, claimId: input.dependency, pathway: claimPathway(projectId, input.dependency), failureClass: record.failureClass, recovered: record.recovered, written });
  }

  // 2. Early warning: drift beyond the calibrator's bar re-reads the plans resting on the claim before the next miss.
  const warnings = earlyWarning(driftSignals(reading));
  const replanned = new Set<string>();
  const replan = deps.replan ?? defaultReplan;
  for (const action of warnings.actions) {
    for (const goalId of deps.dependents?.get(action.dependency) ?? []) {
      if (replanned.has(goalId)) continue;
      replanned.add(goalId);
      await replan(goalId, `preventive: ${action.justification}`.slice(0, 400));
    }
  }

  // 3. Each correction judged as a switch, through the one authority path.
  const authority = deps.authority ?? authorityForSwitch;
  const switches: CorrectionSwitch[] = [];
  for (const correction of reading.corrections) {
    // No commercial action is named by a forecast correction; the facts carry what is and is not known.
    const decision = switchDecision(correctionSubstitute(correction), correctionSwitchFacts(correction), await authority(projectId, null));
    switches.push({ cause: correction.cause, owner: correction.owner, claimIds: correction.claimIds, decision });
  }

  // 4. Reliability on the outcomes on record.
  // Every level the pathway holds up: the pathway itself, and the portfolios of the goals resting on it,
  // read from their own plan readings — the goal-portfolio reliability and the correlated downside.
  const sampleSize = reading.ledger.filter((e) => e.outcome).length;
  const pathway = `cash-forecast:${projectId}`;
  const goalIds = [...new Set([...(deps.dependents?.values() ?? [])].flat())];
  const goalPortfolios = await (deps.goalPortfolios ?? readGoalPortfolioReach)(goalIds).catch(() => [] as GoalPortfolioReach[]);
  const reliability = readReliability({ pathways: [{ key: pathway, dependencies }], goalPortfolios, sampleSize });
  const safeguards = correctionSafeguards(pathway, dependencies);

  // 5. A recurring failure class with a method to improve becomes a Factory improvement objective — when a
  // repository change can remove it. That is the cash forecast path this module owns (Brain's own forecast
  // code), or any path whose named methods include a software cause (`CAUSE_OWNER` FACTORY). A class that
  // recurs only on another claim family (an operator decision) with only research or commercial causes is
  // not a defect in the forecast path: it stays in `recurring`, and its own owners already receive those
  // corrections (`knowledge.ts learnFromCashLedger`).
  const recurring = recurringFailureClasses(held);
  const improvements: FallbackWatch['improvements'] = [];
  const toFactory = deps.toFactory ?? upsertCandidate;
  for (const all of recurring) {
    if (all.methodsToImprove.length === 0) continue;
    const ofClass = held.filter((r) => r.failureClass === all.failureClass);
    const families = [...new Set(ofClass.map((r) => claimFamily(r.dependency)))].sort();
    const onForecastPath = families.includes('cash');
    if (!onForecastPath && !all.methodsToImprove.some(factoryOwned)) continue;
    // The candidate states the counts of the path it names. A class that recurs on the cash forecast's own
    // claims is that path's, counted from them alone; otherwise it names every family it was recorded on and
    // counts them all — never a title for one path over another path's occurrences.
    const cashOnly = ofClass.filter((r) => claimFamily(r.dependency) === 'cash');
    const onCash = recurringFailureClasses(cashOnly).find((c) => c.failureClass === all.failureClass && c.methodsToImprove.length > 0);
    const cls = onCash ?? all;
    const scope = onCash ? cashOnly : ofClass;
    const pathFamilies = onCash ? ['cash'] : families;
    const path = onCash ? 'the cash forecast path' : `the ${families.join(', ')} claim path${families.length > 1 ? 's' : ''}`;
    const weaknessKey = `FALLBACK:${cls.failureClass}`.slice(0, 200);
    const { created } = await toFactory({
      weaknessKey,
      kind: 'RECURRING_FAILURE_CLASS',
      title: `A failure recurs on ${path}: ${cls.failureClass.toLowerCase().replace(/_/g, ' ')}`,
      problem: `${cls.occurrences} recorded failure(s) of class ${cls.failureClass} on ${path}: ${cls.recovered} recovered, ${cls.notRecovered} did not, ${cls.untimelyDetections} detected late. Methods named for improvement: ${cls.methodsToImprove.join('; ')}.`.slice(0, 1000),
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'server/services/quant/fallbackWatch.ts',
      frequency: cls.occurrences,
      denominator: held.filter((r) => pathFamilies.includes(claimFamily(r.dependency))).length,
      scope: 'LOCAL',
      severity: cls.notRecovered > 0 || cls.untimelyDetections > 0 ? 'HIGH' : 'MEDIUM',
      evidence: {
        samples: scope.map((r) => r.occurrence).slice(0, 20),
        mutationScope: ['server/services/quant/**', 'server/services/cash/forecast.ts', 'tests/**'],
        knownCause: cls.methodsToImprove.join('; '),
        observedAt: new Date().toISOString(),
      },
    });
    improvements.push({ weaknessKey, created });
  }

  return { dependencies, failures, warnings, replanned: [...replanned], switches, reliability, safeguards, recurring, improvements };
}
