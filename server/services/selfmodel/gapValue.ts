/**
 * The VALUE step of a capability-gap loop, computed rather than asserted (AUTO-20-2 step 4, S-0248).
 *
 * The improvement loop used to take the next step the stage machine named and
 * write it down afterwards beside a fixed list of "alternatives". This module
 * makes the comparison the step claims to make. Each option the loop can
 * actually carry out is costed for one candidate from evidence:
 *
 *   - P(success): measured base rates from the loop's own decided candidates
 *     (how often a Factory change was KEPT, how often method research led to
 *     a change), with a Laplace prior while the rows are few. Then it is
 *     adjusted by what this case's record holds: a known cause, accepted archive
 *     claims, existing matches, and earlier attempts that a method failed.
 *   - latency: median hours measured from the loop's events (research opened ->
 *     engineering submitted; engineering submitted -> delivered). A prior is
 *     used where no rows exist, labelled as such.
 *   - cost: worker hours measured from the bins of the Factory campaigns the
 *     loop handed work to. Where nothing is measured, a labelled prior is used.
 *     No paid model API is used by any option.
 *   - opportunity cost: the weighted occurrences the weakness keeps producing
 *     while the option is still in flight.
 *   - dependencies and constraints: the owner's single engineering slot, the
 *     archive already answering (invariant 13), a credential only a person holds
 *     (rule 11 MISSING_AUTHORITY), and research that already settled with nothing.
 *
 * expected value = P(success) x impact x (1 - latency / horizon), where impact is
 * the weighted occurrences the weakness would produce over the horizon. net =
 * expected value - cost (one worker hour is weighed as one weighted occurrence).
 * The feasible option with the highest net is chosen. ABANDON is always
 * feasible at net 0, so a direction whose every option costs more than it is
 * expected to return is abandoned rather than run.
 *
 * Everything that decided is written onto the VALUE row, so the judgment can be
 * re-read and argued with. The weights are where the judgment starts. No option
 * is a whitelist: the set is the actions the loop's existing owners can perform.
 */
import { getDb } from '../../db/database.ts';
import { ARCHIVE_ENOUGH, type Severity, type WeaknessScope } from '../../domain/improvement.ts';
import type { GapCause } from './gapLoop.ts';

export const NEXT_STEP_OPTIONS = [
  'REUSE_EXISTING', // engineer from what the archive or the system already holds, without new research
  'COMMISSION_RESEARCH', // method research first, then engineering
  'FACTORY_CHANGE', // a Factory change to the owner now
  'ASK_CREDENTIAL', // a person supplies the one credential that lifts a permission refusal
  'ABANDON', // stop: nothing is expected to return more than it costs
] as const;
export type NextStepOption = (typeof NEXT_STEP_OPTIONS)[number];

/** The planning horizon a closed gap is valued over. */
export const VALUE_HORIZON_HOURS = 28 * 24;
/** Priors used only where the loop's rows hold nothing measured; every use is labelled. */
export const PRIOR_LATENCY_HOURS = { research: 48, factory: 24, person: 72 } as const;
export const PRIOR_WORKER_HOURS = { research: 2, factory: 3 } as const;

export interface MeasuredFigure {
  value: number;
  /** MEASURED from rows (with the count), or PRIOR when no row answers. */
  basis: string;
}

/** What the loop's own decided candidates and events say each route costs and yields. */
export interface RouteHistory {
  /** P(a Factory change is KEPT): (kept + 1) / (measured + 2). */
  factoryKept: MeasuredFigure;
  /** P(method research leads to an engineering change): (yielded + 1) / (concluded + 2). */
  researchYield: MeasuredFigure;
  researchLatencyHours: MeasuredFigure;
  factoryLatencyHours: MeasuredFigure;
  factoryWorkerHours: MeasuredFigure;
  researchWorkerHours: MeasuredFigure;
}

export interface ValueInput {
  stage: 'DIAGNOSE' | 'ENGINEER';
  severity: Severity;
  scope: WeaknessScope;
  frequency: number;
  denominator: number;
  cause: GapCause;
  /** The cause the rows state (the detector's diagnosis), not one inferred from free text. */
  knownCause: string | null;
  archiveClaims: number;
  /** Existing matches other than the owner path itself. */
  existingOther: number;
  research: { opened: boolean; settled: boolean; acceptedClaims: number } | null;
  /** Earlier attempts of this weakness that ended KEPT_NO_EFFECT or REVERTED, and whether they went through research. */
  failedAttempts: { attempt: number; researched: boolean }[];
  history: RouteHistory;
}

export interface OptionValue {
  option: NextStepOption;
  feasible: boolean;
  why: string;
  pSuccess: number;
  pBasis: string;
  latencyHours: number;
  latencyBasis: string;
  costWorkerHours: number;
  costBasis: string;
  expectedValue: number;
  opportunityCost: number;
  dependencies: string[];
  constraints: string[];
  net: number;
}

export interface ValueJudgment {
  stage: ValueInput['stage'];
  chosen: NextStepOption;
  /** The weighted occurrences the weakness produces over the horizon if nothing changes. */
  impact: number;
  impactBasis: string;
  horizonHours: number;
  options: OptionValue[];
  /** One sentence: why the chosen option beat the others. */
  basis: string;
}

const SEVERITY: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const SCOPE: Record<WeaknessScope, number> = { GENERAL: 3, LANE: 2, LOCAL: 1 };
const round = (n: number, d = 3) => Number(n.toFixed(d));

/** Compare every option for one candidate and choose. Pure. */
export function evaluateNextStep(input: ValueInput): ValueJudgment {
  const h = input.history;
  const weeks = VALUE_HORIZON_HOURS / (7 * 24);
  const share = input.denominator > 0 ? Math.min(1, input.frequency / input.denominator) : 0;
  const impact = input.frequency * SEVERITY[input.severity] * SCOPE[input.scope] * weeks * (0.5 + share);
  const impactBasis =
    `${input.frequency} occurrence(s) in the detection window` +
    (input.denominator > 0 ? ` (${Math.round(share * 100)}% of ${input.denominator})` : '') +
    ` x severity ${input.severity} x scope ${input.scope}, over ${weeks} week(s)`;
  const failedDirect = input.failedAttempts.filter((f) => !f.researched).length;
  const failedResearched = input.failedAttempts.filter((f) => f.researched).length;
  const researchDone = Boolean(input.research?.opened && input.research.settled);
  const researchFoundNothing = researchDone && (input.research?.acceptedClaims ?? 0) === 0;
  const archiveAnswers = input.archiveClaims >= ARCHIVE_ENOUGH;
  const evidenceToBuild = Boolean(input.knownCause) || input.archiveClaims > 0 || (input.research?.acceptedClaims ?? 0) > 0;

  const options: OptionValue[] = [];
  const add = (o: Omit<OptionValue, 'expectedValue' | 'opportunityCost' | 'net'>) => {
    const timeFactor = Math.max(0, 1 - o.latencyHours / VALUE_HORIZON_HOURS);
    const expectedValue = o.feasible ? o.pSuccess * impact * timeFactor : 0;
    const opportunityCost = impact * Math.min(1, o.latencyHours / VALUE_HORIZON_HOURS);
    const net = o.feasible ? expectedValue - o.costWorkerHours : Number.NEGATIVE_INFINITY;
    options.push({ ...o, pSuccess: round(o.pSuccess), expectedValue: round(expectedValue, 2), opportunityCost: round(opportunityCost, 2), net: Number.isFinite(net) ? round(net, 2) : net });
  };
  // One live engineering objective per owner component: an option that needs it waits while another holds it (loop.ts).
  const slot = ['the owner component\'s single engineering slot'];
  const penaltyDirect = 0.5 ** failedDirect;
  const penaltyResearch = 0.7 ** failedResearched;
  const methodNote = (n: number, what: string) => (n > 0 ? `; x${what} for ${n} earlier attempt(s) of this route that did not move the metric` : '');

  // REUSE_EXISTING: engineer from what already exists, skipping new research.
  {
    const leads = input.archiveClaims > 0 || input.existingOther > 0;
    const factor = input.archiveClaims > 0 ? 0.8 : 0.4;
    const feasible = leads && !researchFoundNothing;
    add({
      option: 'REUSE_EXISTING',
      feasible,
      why: !leads
        ? 'the search found no accepted method and no existing component beyond the owner itself'
        : researchFoundNothing
          ? 'research already settled with nothing to reuse'
          : `${input.archiveClaims} accepted archive claim(s), ${input.existingOther} existing component match(es)`,
      pSuccess: h.factoryKept.value * factor * penaltyDirect,
      pBasis: `P(kept) ${round(h.factoryKept.value)} (${h.factoryKept.basis}) x ${factor} (${input.archiveClaims > 0 ? 'an accepted method exists' : 'only name matches, not a method'})${methodNote(failedDirect, String(0.5 ** failedDirect))}`,
      latencyHours: h.factoryLatencyHours.value,
      latencyBasis: h.factoryLatencyHours.basis,
      costWorkerHours: h.factoryWorkerHours.value,
      costBasis: h.factoryWorkerHours.basis,
      dependencies: slot,
      constraints: [],
    });
  }
  // COMMISSION_RESEARCH: learn the method first.
  {
    const feasible = input.stage === 'DIAGNOSE' && !archiveAnswers && !researchDone;
    add({
      option: 'COMMISSION_RESEARCH',
      feasible,
      why: archiveAnswers
        ? `the archive already answers it (${input.archiveClaims} >= ${ARCHIVE_ENOUGH} accepted claims): researching it again is invariant 13`
        : researchDone
          ? 'method research already ran and settled; re-running it is re-running the method'
          : input.stage !== 'DIAGNOSE'
            ? 'research is already open or done for this candidate'
            : 'no cause is stated and nothing in the archive answers it',
      pSuccess: h.researchYield.value * h.factoryKept.value * penaltyResearch,
      pBasis: `P(research yields a change) ${round(h.researchYield.value)} (${h.researchYield.basis}) x P(kept) ${round(h.factoryKept.value)}${methodNote(failedResearched, String(0.7 ** failedResearched))}`,
      latencyHours: h.researchLatencyHours.value + h.factoryLatencyHours.value,
      latencyBasis: `research ${h.researchLatencyHours.basis}; then Factory ${h.factoryLatencyHours.basis}`,
      costWorkerHours: h.researchWorkerHours.value + h.factoryWorkerHours.value,
      costBasis: `research ${h.researchWorkerHours.basis}; Factory ${h.factoryWorkerHours.basis}`,
      dependencies: [],
      constraints: ['worked by Claude routines and the free lane on subscription capacity; no paid model API'],
    });
  }
  // FACTORY_CHANGE: change the owner now.
  {
    const factor = input.knownCause || (input.research?.acceptedClaims ?? 0) > 0 ? 1 : archiveAnswers ? 0.9 : input.archiveClaims > 0 ? 0.7 : 0.35;
    // Research that settled with nothing, an empty archive and no stated cause leave nothing to build.
    const feasible = !(researchFoundNothing && !evidenceToBuild);
    add({
      option: 'FACTORY_CHANGE',
      feasible,
      why: !feasible
        ? 'research settled with nothing supported and the rows state no cause: there is nothing to build'
        : input.knownCause
            ? `the rows state the cause: ${input.knownCause.slice(0, 120)}`
            : (input.research?.acceptedClaims ?? 0) > 0
              ? `research accepted ${input.research!.acceptedClaims} claim(s)`
              : 'building without a stated cause is a guess at the method',
      pSuccess: h.factoryKept.value * factor * penaltyDirect,
      pBasis: `P(kept) ${round(h.factoryKept.value)} (${h.factoryKept.basis}) x ${factor} for the evidence the change is built on${methodNote(failedDirect, String(0.5 ** failedDirect))}`,
      latencyHours: h.factoryLatencyHours.value,
      latencyBasis: h.factoryLatencyHours.basis,
      costWorkerHours: h.factoryWorkerHours.value,
      costBasis: h.factoryWorkerHours.basis,
      dependencies: slot,
      constraints: ['Brain repository only, on the standing improvement grant; no gate, evidence bar or permission lowered'],
    });
  }
  // ASK_CREDENTIAL: one credential only a person holds.
  {
    const permission = input.cause === 'PERMISSION_GAP' && Boolean(input.knownCause);
    add({
      option: 'ASK_CREDENTIAL',
      feasible: permission,
      why: permission
        ? 'the rows state an authorization refusal: one credential from a person lifts it'
        : 'the rows state no authorization refusal; a person would be asked for nothing they alone hold',
      pSuccess: permission ? 0.8 : 0,
      pBasis: 'a credential lifts a refusal it caused; 0.8 allows for the refusal having another cause',
      latencyHours: PRIOR_LATENCY_HOURS.person,
      latencyBasis: `PRIOR ${PRIOR_LATENCY_HOURS.person}h: no row measures how long a person takes`,
      costWorkerHours: 0,
      costBasis: 'no worker time; a person\'s time',
      dependencies: permission ? ['a person who holds the credential'] : [],
      constraints: ['rule 11 MISSING_AUTHORITY: the only reason a person is asked'],
    });
  }
  add({
    option: 'ABANDON',
    feasible: true,
    why: 'stop the direction; the weakness keeps occurring and a recurrence opens a new attempt',
    pSuccess: 0,
    pBasis: 'abandoning removes nothing',
    latencyHours: 0,
    latencyBasis: 'immediate',
    costWorkerHours: 0,
    costBasis: 'none',
    dependencies: [],
    constraints: [],
  });

  const feasible = options.filter((o) => o.feasible);
  const best = [...feasible].sort((a, b) => b.net - a.net || a.costWorkerHours - b.costWorkerHours || NEXT_STEP_OPTIONS.indexOf(a.option) - NEXT_STEP_OPTIONS.indexOf(b.option))[0]!;
  const runnerUp = [...feasible].filter((o) => o.option !== best.option).sort((a, b) => b.net - a.net)[0];
  const basis =
    best.option === 'ABANDON'
      ? `No option is expected to return more than it costs: ${feasible
          .filter((o) => o.option !== 'ABANDON')
          .map((o) => `${o.option} net ${o.net}`)
          .join(', ') || 'no other option is feasible'}.`
      : `${best.option} has the highest net value ${best.net} (P ${best.pSuccess}, ${best.latencyHours}h, ${best.costWorkerHours} worker-h)` +
        (runnerUp ? `, ahead of ${runnerUp.option} at ${runnerUp.net}.` : '.');
  return { stage: input.stage, chosen: best.option, impact: round(impact, 2), impactBasis, horizonHours: VALUE_HORIZON_HOURS, options, basis };
}

/** The VALUE row's detail for a judgment: names the chosen option, every alternative with its figures, and the decision. */
export function valueDetail(judgment: ValueJudgment): Record<string, unknown> {
  const alternatives = judgment.options
    .filter((o) => o.option !== judgment.chosen)
    .map((o) => `${o.option}: ${o.feasible ? `net ${o.net} (P ${o.pSuccess}, EV ${o.expectedValue}, ${o.latencyHours}h, ${o.costWorkerHours} worker-h)` : 'infeasible'} — ${o.why}`)
    .join('; ');
  return {
    evaluated: true,
    stage: judgment.stage,
    chosen: judgment.chosen,
    ref: judgment.chosen,
    decision: judgment.chosen,
    ...(judgment.chosen === 'ABANDON' ? { abandon: true } : {}),
    alternatives,
    basis: judgment.basis,
    impact: judgment.impact,
    impactBasis: judgment.impactBasis,
    horizonHours: judgment.horizonHours,
    options: judgment.options.map((o) => ({ ...o, net: Number.isFinite(o.net) ? o.net : null })),
  };
}

/* ------------------------------------------------------------------------- */
/* The measured route history                                                 */
/* ------------------------------------------------------------------------- */

function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A Laplace-smoothed rate with its basis. Pure. */
export function smoothedRate(successes: number, trials: number, what: string): MeasuredFigure {
  return {
    value: (successes + 1) / (trials + 2),
    basis: trials > 0 ? `MEASURED ${successes}/${trials} ${what}, smoothed` : `PRIOR 1/2: no ${what} on record`,
  };
}

function figure(value: number | null, n: number, prior: number, what: string): MeasuredFigure {
  return value === null ? { value: prior, basis: `PRIOR ${prior}h: no ${what} on record` } : { value: round(value, 2), basis: `MEASURED median of ${n} ${what}` };
}

/** Read what the loop's routes have cost and yielded from its own rows. */
export async function readRouteHistory(): Promise<RouteHistory> {
  const db = getDb();
  const candidates = await db.all<{ id: string; research_goal_id: string | null; change_request_id: string | null; campaign_id: string | null; decision: string | null }>(
    'SELECT id, research_goal_id, change_request_id, campaign_id, decision FROM improvement_candidates',
    [],
  );
  const measured = candidates.filter((c) => c.change_request_id && (c.decision === 'KEPT' || c.decision === 'KEPT_NO_EFFECT' || c.decision === 'REVERTED'));
  const kept = measured.filter((c) => c.decision === 'KEPT').length;
  const researched = candidates.filter((c) => c.research_goal_id && (c.change_request_id || c.decision === 'REJECTED'));
  const yielded = researched.filter((c) => c.change_request_id).length;

  const events = await db.all<{ candidate_id: string; kind: string; at: string }>(
    "SELECT candidate_id, kind, at FROM improvement_events WHERE candidate_id IS NOT NULL AND kind IN ('RESEARCH_OPENED', 'ENGINEERING_SUBMITTED', 'DELIVERED') ORDER BY at ASC",
    [],
  );
  const first = new Map<string, Partial<Record<string, string>>>();
  for (const e of events) {
    const at = first.get(e.candidate_id) ?? {};
    if (!at[e.kind]) at[e.kind] = e.at;
    first.set(e.candidate_id, at);
  }
  const hours = (a?: string, b?: string) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : NaN);
  const researchSpans = [...first.values()].map((at) => hours(at['RESEARCH_OPENED'], at['ENGINEERING_SUBMITTED'])).filter(Number.isFinite);
  const factorySpans = [...first.values()].map((at) => hours(at['ENGINEERING_SUBMITTED'], at['DELIVERED'])).filter(Number.isFinite);

  const campaigns = [...new Set(candidates.map((c) => c.campaign_id).filter((c): c is string => Boolean(c)))];
  let factoryWorker: number | null = null;
  let timedCampaigns = 0;
  if (campaigns.length > 0) {
    const rows = await db.all<{ campaign: string; ms: number | string | null }>(
      `SELECT b.factory_campaign_id AS campaign, SUM(e.duration_ms) AS ms FROM bins b
         JOIN bin_events e ON e.bin_id = b.id
        WHERE b.factory_campaign_id IN (${campaigns.map(() => '?').join(', ')})
          AND e.event_type IN ('BIN_TERMINAL', 'BIN_RELEASED', 'BIN_LEASE_EXPIRED') AND e.duration_ms IS NOT NULL
        GROUP BY b.factory_campaign_id`,
      campaigns,
    );
    const perCampaign = rows.map((r) => Number(r.ms ?? 0) / 3_600_000).filter((v) => v > 0);
    timedCampaigns = perCampaign.length;
    factoryWorker = median(perCampaign);
  }
  return {
    factoryKept: smoothedRate(kept, measured.length, 'measured Factory changes kept'),
    researchYield: smoothedRate(yielded, researched.length, 'concluded method research that led to a change'),
    researchLatencyHours: figure(median(researchSpans), researchSpans.length, PRIOR_LATENCY_HOURS.research, 'research-opened-to-engineering spans'),
    factoryLatencyHours: figure(median(factorySpans), factorySpans.length, PRIOR_LATENCY_HOURS.factory, 'engineering-submitted-to-delivered spans'),
    factoryWorkerHours:
      factoryWorker === null
        ? { value: PRIOR_WORKER_HOURS.factory, basis: `PRIOR ${PRIOR_WORKER_HOURS.factory}h: no timed Factory lease on record` }
        : { value: round(factoryWorker, 2), basis: `MEASURED median worker-hours of ${timedCampaigns} campaign(s)` },
    researchWorkerHours: { value: PRIOR_WORKER_HOURS.research, basis: `PRIOR ${PRIOR_WORKER_HOURS.research}h: no row attributes research worker time to a candidate` },
  };
}
