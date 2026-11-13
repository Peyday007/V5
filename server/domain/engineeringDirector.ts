/**
 * Hermes as Brain's engineering director (§109): the pure rules.
 *
 * The operator (§106) diagnoses a deficiency in Brain — its economic reasoning,
 * its planning assumptions, a strategy it keeps repeating, how it spends
 * capacity, a missing capability, a broken integration, a slow algorithm, an
 * operational failure that recurs — and these functions decide, from what the
 * diagnosis states, *what kind* of intervention it has earned, how much
 * engineering capacity it deserves, which class of worker can carry it, and,
 * once Factory has answered, whether the original problem is actually solved.
 *
 * Nothing here is a second Factory, scheduler or improvement loop. An
 * engineering intervention becomes one `improvement_candidates` row (§87) and
 * one Factory objective through `submitObjective` / `approveAndStartCampaign`;
 * these rules only decide the inputs those owners already take. Every function
 * is a function of its arguments, so "why did Hermes send this to Factory at
 * priority 9 and a STRONGEST worker" is answerable from the recorded inputs.
 */
import type { MetricKey } from './improvement.ts';

export const DEFICIENCY_CLASSES = [
  'ECONOMIC_REASONING',
  'PLANNING_ASSUMPTION',
  'REPEATED_STRATEGIC_MISTAKE',
  'RESOURCE_ALLOCATION',
  'MISSING_CAPABILITY',
  'BROKEN_INTEGRATION',
  'INEFFICIENT_ALGORITHM',
  'RECURRING_OPERATIONAL_FAILURE',
] as const;
export type DeficiencyClass = (typeof DEFICIENCY_CLASSES)[number];

/**
 * The interventions a deficiency can earn. Only ENGINEERING reaches Factory.
 *
 *   ENGINEERING  a code change to the owner of the behaviour (Factory)
 *   MODEL        the reasoning is limited by the model that does it — a better
 *                model or recipe on capacity Brain already has (§85, §108's GPU)
 *   STRATEGY     the code is right and the choice is wrong: change what Brain
 *                pursues, recorded as a lesson the next run reads
 *   EVIDENCE     the cause is not established: research or measurement first (§87's
 *                method research), never a guess sent to Factory
 *   CAPACITY     work waits beside idle capacity: continue it through its own
 *                scheduler (§98); engineering only once that has failed
 *   PERSON       only a person can act (a credential, a login, money): rule 11
 *   WATCH        seen once: recorded, engineered only if it recurs
 */
export const INTERVENTIONS = ['ENGINEERING', 'MODEL', 'STRATEGY', 'EVIDENCE', 'CAPACITY', 'PERSON', 'WATCH'] as const;
export type Intervention = (typeof INTERVENTIONS)[number];

export interface Diagnosis {
  goalId: string | null;
  deficiency: DeficiencyClass;
  title: string;
  /** What Brain observed, in production terms. */
  observed: string;
  /** Row ids and verbatim reasons that show it. */
  evidence: string;
  /** The cause, when the rows or the code state it; null when it is not established. */
  cause: string | null;
  /** Repository paths that own the behaviour. */
  ownerPaths: string[];
  /** How many times the deficiency was observed (runs, rows, cycles). */
  recurrence: number;
  /** What fixing it is expected to return, in the goal's terms. */
  expectedBenefit: string;
  /** What a test proves once it is fixed. */
  acceptance: string;
  /** The scoreboard metric (§87) its real effect is measured on. */
  metric: MetricKey;
  /** Does the deficiency stand between the goal and its target right now? */
  blocksGoal: boolean;
  /** Share of the goal's remaining value the deficiency holds back, 0..1. */
  share: number;
  /** The intervention the diagnosing agent proposes; Brain's rules decide. */
  proposed: Intervention | null;
  /** The failure is the quality of a model's output, not the code around it. */
  modelLimited?: boolean;
  /** Only a person holds what is missing (a credential, a login, money). */
  personOnly?: boolean;
  /** Executable work waits beside idle capacity. */
  capacityIdle?: boolean;
  /** Continuing idle capacity was already tried and the work still waits. */
  capacityTried?: boolean;
}

export interface InterventionDecision {
  intervention: Intervention;
  why: string;
  /** The proposal was overruled, and why. */
  overruled: string | null;
}

/**
 * Which intervention a diagnosis has earned.
 *
 * "Do not turn every problem into a coding assignment." Engineering is the
 * intervention left once a person is not the only remedy, the model is not
 * the limit, idle capacity is not the cause, the cause is established, an
 * owner is named, and the deficiency has recurred. A less invasive proposal
 * (STRATEGY over ENGINEERING) is honoured; a more invasive one the rows do
 * not support is overruled with the reason.
 */
export function decideIntervention(d: Diagnosis): InterventionDecision {
  const rule = ((): { intervention: Intervention; why: string } => {
    if (d.personOnly) return { intervention: 'PERSON', why: 'only a person holds what is missing (rule 11: MISSING_AUTHORITY)' };
    if (d.modelLimited) return { intervention: 'MODEL', why: "the failure is a model's output quality; a better model or recipe, not a code change" };
    if (d.capacityIdle && !d.capacityTried) {
      return { intervention: 'CAPACITY', why: 'work waits beside idle capacity; its own scheduler continues it first (§98)' };
    }
    if (!d.cause || d.cause.trim().length < 20) {
      return { intervention: 'EVIDENCE', why: 'the cause is not established; research or measurement first, never a guess sent to Factory' };
    }
    if (d.recurrence < 2 && d.deficiency !== 'BROKEN_INTEGRATION') {
      return { intervention: 'WATCH', why: 'observed once; recorded, and engineered only if it recurs' };
    }
    if (d.ownerPaths.length === 0) {
      return { intervention: d.deficiency === 'REPEATED_STRATEGIC_MISTAKE' ? 'STRATEGY' : 'EVIDENCE', why: 'no code owns it; the remedy is not a code change until an owner is found' };
    }
    return { intervention: 'ENGINEERING', why: `the cause is established, ${d.ownerPaths.length} owner path(s) are named and it recurred ${d.recurrence} time(s)` };
  })();
  const proposed = d.proposed;
  if (!proposed || proposed === rule.intervention) return { ...rule, overruled: null };
  // A less invasive proposal is the agent's call; engineering only where the rule reaches it.
  const invasive: Record<Intervention, number> = { WATCH: 0, STRATEGY: 1, CAPACITY: 1, EVIDENCE: 2, MODEL: 2, PERSON: 3, ENGINEERING: 4 };
  if (proposed !== 'PERSON' && proposed !== 'ENGINEERING' && invasive[proposed] <= invasive[rule.intervention]) {
    return { intervention: proposed, why: `proposed ${proposed}, less invasive than the rule's ${rule.intervention} (${rule.why})`, overruled: null };
  }
  return { ...rule, overruled: `proposed ${proposed}, but ${rule.why}` };
}

/* ------------------------------------------------------------------------- */
/* Priority: engineering capacity follows what the defect holds back          */
/* ------------------------------------------------------------------------- */

export type Urgency = 'IMMEDIATE' | 'HIGH' | 'NORMAL' | 'LOW';

export interface PriorityInput {
  blocksGoal: boolean;
  /** The goal's remaining value in cents, or null when the goal has no money target. */
  remainingCents: number | null;
  daysLeft: number | null;
  share: number;
  recurrence: number;
  deficiency: DeficiencyClass;
}

export interface EngineeringPriority {
  /** Factory priority 1..9 (bins and the line order by it, highest first). */
  priority: number;
  urgency: Urgency;
  /** Value at stake per day of delay, in cents: the quantity the priority is a scale of. */
  stakePerDayCents: number;
  why: string;
}

/**
 * How much engineering capacity a defect deserves, from what it holds back.
 *
 * No equal shares and no favourite goal: the priority is the value the defect
 * holds back per day of delay — the goal's remaining value times the share the
 * defect blocks, divided over the days left — on a log scale, raised for a
 * defect that blocks the goal outright and for one that keeps recurring. A
 * defect on a goal with no money target is valued at a floor, so it still
 * competes, and never outranks one that holds real money back.
 */
export function engineeringPriority(input: PriorityInput): EngineeringPriority {
  const share = Math.min(1, Math.max(0, Number.isFinite(input.share) ? input.share : 0));
  const remaining = input.remainingCents !== null && input.remainingCents > 0 ? input.remainingCents : 0;
  const days = input.daysLeft !== null && input.daysLeft > 0 ? input.daysLeft : input.daysLeft === null ? 90 : 1;
  const floor = 100_00; // $100/day: a defect with no money target still competes.
  const stake = Math.max(floor / Math.max(days, 1), (remaining * Math.max(share, input.blocksGoal ? 0.25 : 0.02)) / days);
  // $1/day → 1, $10/day → 4, $100/day → 7, log-scaled; bounded at 9 below.
  let priority = Math.round(1 + 3 * Math.log10(Math.max(1, stake / 100)));
  if (input.blocksGoal) priority += 1;
  if (input.recurrence >= 5) priority += 1;
  if (input.deficiency === 'ECONOMIC_REASONING' || input.deficiency === 'PLANNING_ASSUMPTION') priority += remaining > 0 ? 1 : 0;
  priority = Math.min(9, Math.max(1, priority));
  const urgency: Urgency = priority >= 9 ? 'IMMEDIATE' : priority >= 7 ? 'HIGH' : priority >= 4 ? 'NORMAL' : 'LOW';
  return {
    priority,
    urgency,
    stakePerDayCents: Math.round(stake),
    why:
      `holds back about $${(stake / 100).toFixed(0)}/day` +
      (remaining > 0 ? ` (share ${share.toFixed(2)} of $${(remaining / 100).toFixed(0)} over ${days} day(s))` : ' (no money target: the floor)') +
      (input.blocksGoal ? '; blocks the goal outright' : '') +
      (input.recurrence >= 5 ? `; recurred ${input.recurrence} times` : ''),
  };
}

/* ------------------------------------------------------------------------- */
/* Routing: the class of worker the problem needs                             */
/* ------------------------------------------------------------------------- */

export type Complexity = 'ARCHITECTURAL' | 'BOUNDED';

export interface RoutingInput {
  deficiency: DeficiencyClass;
  ownerPaths: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Earlier attempts on the same deficiency that did not fix it. */
  failedAttempts: number;
  urgency: Urgency;
}

export interface EngineeringRoute {
  complexity: Complexity;
  /** The weakest model class Factory may give any unit of this objective. */
  minimumModelClass: 'STRONGEST' | 'FAST';
  why: string;
}

/** Deficiencies whose fix is reasoning about Brain's own reasoning: never a cheap model's job. */
const REASONING_DEFICIENCIES: ReadonlySet<DeficiencyClass> = new Set([
  'ECONOMIC_REASONING',
  'PLANNING_ASSUMPTION',
  'REPEATED_STRATEGIC_MISTAKE',
  'RESOURCE_ALLOCATION',
  'INEFFICIENT_ALGORITHM',
]);

/**
 * Which class of worker a fix needs.
 *
 * A bounded fix (one or two owner files, LOW risk, a first attempt, an
 * operational or integration defect) is FAST work Factory may give its
 * cheapest capable worker. Everything else — Brain's economic or planning
 * reasoning, an algorithm, a wide or risky scope, a second attempt after the
 * first did not work — is ARCHITECTURAL and is never handed to a weaker model
 * because it is free: Factory's scheduler refuses a FAST worker for a unit
 * this marks STRONGEST (`scheduler.chooseWorker`).
 */
export function routeEngineering(input: RoutingInput): EngineeringRoute {
  const reasons: string[] = [];
  if (REASONING_DEFICIENCIES.has(input.deficiency)) reasons.push(`${input.deficiency} is reasoning about Brain's reasoning`);
  if (input.ownerPaths.length > 2) reasons.push(`${input.ownerPaths.length} owner paths`);
  if (input.risk !== 'LOW') reasons.push(`${input.risk} risk`);
  if (input.failedAttempts > 0) reasons.push(`${input.failedAttempts} earlier attempt(s) did not fix it`);
  if (input.urgency === 'IMMEDIATE') reasons.push('immediate: a failed cheap attempt would cost more than the stronger model');
  if (reasons.length > 0) return { complexity: 'ARCHITECTURAL', minimumModelClass: 'STRONGEST', why: reasons.join('; ') };
  return {
    complexity: 'BOUNDED',
    minimumModelClass: 'FAST',
    why: `${input.deficiency} in ${input.ownerPaths.length} owner file(s), LOW risk, first attempt: the cheapest capable worker can do it`,
  };
}

/**
 * The marker an objective carries so Factory's planner holds every unit at
 * the routed class. Read back by `minimumModelClassOf`, which the planner
 * calls with the change request's objective.
 */
export const ROUTING_MARKER = 'FACTORY ROUTING: every unit STRONGEST.';

export function minimumModelClassOf(objective: string): 'STRONGEST' | null {
  return objective.includes(ROUTING_MARKER) ? 'STRONGEST' : null;
}

/* ------------------------------------------------------------------------- */
/* The result: was the original problem solved, and did the goal move?        */
/* ------------------------------------------------------------------------- */

/** One reading of a goal, recorded when the work is commissioned and again after. */
export interface GoalMark {
  at: string;
  state: string | null;
  waitingOn: string | null;
  settledCents: number | null;
  blockers: number | null;
  /** The plan's verdict and the reach of its best combination (§95, §99). */
  verdict: string | null;
  bestReachCents: number | null;
  /** Openings at C or higher on the evidence ladder (market-test ready and beyond). */
  ladderAdvanced: number | null;
  /** Open person-requests that are moot (§106). */
  mootRequests: number | null;
}

export type GoalEffect = 'IMPROVED' | 'UNCHANGED' | 'WORSE' | 'UNKNOWN';

export function compareGoal(before: GoalMark | null, after: GoalMark | null): { effect: GoalEffect; reasons: string[] } {
  if (!before || !after) return { effect: 'UNKNOWN', reasons: ['no reading of the goal before or after'] };
  const better: string[] = [];
  const worse: string[] = [];
  const num = (label: string, a: number | null, b: number | null, higherIsBetter: boolean): void => {
    if (a === null || b === null || a === b) return;
    ((b > a) === higherIsBetter ? better : worse).push(`${label} ${a} → ${b}`);
  };
  num('settled cents', before.settledCents, after.settledCents, true);
  num('best reach cents', before.bestReachCents, after.bestReachCents, true);
  num('openings at C+', before.ladderAdvanced, after.ladderAdvanced, true);
  num('blockers', before.blockers, after.blockers, false);
  num('moot requests', before.mootRequests, after.mootRequests, false);
  // What a goal waits on is compared only when both readings derived it.
  if (before.waitingOn !== null && after.waitingOn !== null) {
    const personBefore = before.waitingOn.startsWith('PERSON');
    const personAfter = after.waitingOn.startsWith('PERSON');
    if (personBefore && !personAfter) better.push(`no longer waiting on a person (${after.waitingOn})`);
    if (!personBefore && personAfter) worse.push(`now waiting on a person (${after.waitingOn})`);
  }
  const derived = (state: string | null): state is string => Boolean(state) && state !== 'NOT_DERIVED';
  if (before.state !== after.state && derived(before.state) && derived(after.state)) {
    const rank = (s: string): number => (s === 'BLOCKED' ? 0 : s === 'STALLED' ? 1 : s === 'DONE' || s === 'MET' ? 3 : 2);
    (rank(after.state) > rank(before.state) ? better : rank(after.state) < rank(before.state) ? worse : []).push(`state ${before.state} → ${after.state}`);
  }
  if (better.length > 0 && worse.length === 0) return { effect: 'IMPROVED', reasons: better };
  if (worse.length > 0 && better.length === 0) return { effect: 'WORSE', reasons: worse };
  if (better.length === 0 && worse.length === 0) return { effect: 'UNCHANGED', reasons: ['every reading is as it was'] };
  return { effect: better.length >= worse.length ? 'IMPROVED' : 'WORSE', reasons: [...better.map((r) => `+ ${r}`), ...worse.map((r) => `- ${r}`)] };
}

export type EngineeringStatus = 'BUILDING' | 'BLOCKED' | 'FAILED' | 'DELIVERED_UNMEASURED' | 'RESOLVED' | 'NOT_RESOLVED' | 'NOT_STARTED';

export interface OutcomeInput {
  started: boolean;
  /** Factory's objective status (`objectiveOutcome`), or null before a campaign exists. */
  factoryStatus: string | null;
  merged: boolean;
  deployed: boolean;
  verified: boolean;
  /** The improvement loop's measurement (§87) and decision, once taken. */
  measurement: string | null;
  decision: string | null;
  goal: { effect: GoalEffect; reasons: string[] };
}

export interface EngineeringJudgment {
  status: EngineeringStatus;
  /** What the operator does with it next. */
  next: 'WAIT' | 'UNBLOCK' | 'NEW_ATTEMPT' | 'CHANGE_STRATEGY' | 'DONE';
  sentence: string;
}

/**
 * Whether the defect is solved — never read off a merged pull request.
 *
 * Solved means the improvement loop measured the metric after delivery and
 * kept the change because it moved (KEPT, IMPROVED). A merge or a deploy
 * without that measurement is DELIVERED_UNMEASURED. A change kept without
 * effect, or reverted, did not solve it: the next step is a different method
 * (invariant 16), and when the goal itself did not move either, a different
 * strategy.
 */
export function judgeEngineering(input: OutcomeInput): EngineeringJudgment {
  if (!input.started) return { status: 'NOT_STARTED', next: 'UNBLOCK', sentence: 'Factory has not started it.' };
  if (input.decision === 'KEPT' && input.measurement === 'IMPROVED') {
    return {
      status: 'RESOLVED',
      next: input.goal.effect === 'IMPROVED' ? 'DONE' : 'CHANGE_STRATEGY',
      sentence:
        'Delivered, and the measured metric improved after deployment.' +
        (input.goal.effect === 'IMPROVED'
          ? ` The goal moved: ${input.goal.reasons.join('; ')}.`
          : ` The goal itself did not move (${input.goal.effect}): the defect was real and is fixed, and the goal needs a different lever.`),
    };
  }
  if (input.decision === 'KEPT_NO_EFFECT' || input.decision === 'REVERTED' || input.decision === 'REJECTED') {
    return { status: 'NOT_RESOLVED', next: 'NEW_ATTEMPT', sentence: `Decided ${input.decision}: the change did not fix what it was for. A different method is next (invariant 16).` };
  }
  if (input.decision === 'HELD') {
    return { status: 'BLOCKED', next: 'UNBLOCK', sentence: 'Held on a named dependency; it moves when that does.' };
  }
  if (input.decision === 'COMBINED') {
    return { status: 'BUILDING', next: 'WAIT', sentence: 'Combined into another objective on the same owner; that one carries it.' };
  }
  if (input.merged || input.deployed || input.factoryStatus === 'LIVE') {
    return {
      status: 'DELIVERED_UNMEASURED',
      next: 'WAIT',
      sentence:
        `Merged${input.deployed ? ' and deployed' : ''}${input.verified ? ' and verified live' : ''}. ` +
        'A merge is not proof: the improvement loop measures the metric after deployment and decides.' +
        (input.goal.effect !== 'UNKNOWN' ? ` Goal so far: ${input.goal.effect} (${input.goal.reasons.join('; ')}).` : ''),
    };
  }
  if (input.factoryStatus === 'BLOCKED') return { status: 'BLOCKED', next: 'UNBLOCK', sentence: 'Factory is blocked.' };
  if (input.factoryStatus === 'CANCELLED' || input.factoryStatus === 'FAILED') {
    return { status: 'FAILED', next: 'NEW_ATTEMPT', sentence: `Factory ended ${input.factoryStatus} without delivering.` };
  }
  return { status: 'BUILDING', next: 'WAIT', sentence: `Factory is building it (${input.factoryStatus ?? 'starting'}).` };
}

/** The operator is woken by an outcome it has not seen. These are the statuses worth waking it for. */
export function wakesOperator(status: EngineeringStatus): boolean {
  return status !== 'BUILDING';
}

/** A stable key for one deficiency: the same defect named twice is one candidate (§87's register). */
export function deficiencyKey(d: Pick<Diagnosis, 'deficiency' | 'ownerPaths' | 'title' | 'goalId'>, hash: (text: string) => string): string {
  const owner = [...d.ownerPaths].map((p) => p.trim()).sort().join(',');
  // A defect in code is one defect whichever goal it holds back: keyed by its owner files alone,
  // so four goals blocked by the same bug are one candidate and one campaign, never four.
  if (owner) return `OPERATOR:${d.deficiency}:${hash(owner).slice(0, 16)}`;
  const subject = d.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `OPERATOR:${d.deficiency}:${hash(`${d.goalId ?? '-'}|${subject}`).slice(0, 16)}`;
}

/* ------------------------------------------------------------------------- */
/* Telling the owner: a verified self-improvement cycle                        */
/* ------------------------------------------------------------------------- */

/**
 * The facts of one commissioned engineering, read from the rows §109 already keeps:
 * the candidate's directive, the operator run that commissioned it, Factory's outcome,
 * §87's measurement and decision, and the operator's own evaluation afterwards.
 */
export interface CycleFacts {
  candidateId: string;
  title: string;
  deficiency: string;
  problem: string;
  goalId: string | null;
  goalTitle: string | null;
  /** Who commissioned it: the operator (Hermes) itself, or Brain's standing director in its place. */
  origin: 'OPERATOR' | 'STANDING_DIRECTOR' | 'UNKNOWN';
  /** The operator run named in the directive called brain_operator_commission / submit_fix itself. */
  commissionedByRun: string | null;
  intervention: string;
  campaignId: string | null;
  factory: {
    status: string | null;
    prUrl: string | null;
    mergeSha: string | null;
    deployed: boolean;
    verified: boolean;
    changedPaths: string[];
    tests: string;
  } | null;
  measurement: { metric: string; before: number | null; after: number | null; verdict: string | null } | null;
  decision: string | null;
  decisionReason: string | null;
  /** When §87 decided KEPT. */
  decidedAt: string | null;
  status: EngineeringStatus;
  goal: { effect: GoalEffect; reasons: string[] };
  /** The operator's evaluation of this result, recorded by one of its runs after the decision. */
  evaluation: { runId: string; recordedAt: string; lesson: string } | null;
}

/** The five steps the owner named (2026-11-12), in order, each read from a row. */
export const CYCLE_STEPS = [
  'IDENTIFIED_BY_HERMES',
  'COMMISSIONED_FACTORY',
  'RELEASED_AND_VERIFIED',
  'RESULT_RECEIVED',
  'GOAL_EVALUATED',
] as const;
export type CycleStep = (typeof CYCLE_STEPS)[number];

/**
 * Whether one engineering is a verified autonomous self-improvement cycle — never read
 * off a merge. Each step names the row that proves it; a missing one says why.
 *
 * 1. Hermes identified it: the directive's origin is the operator, and the run it names
 *    made the commission call itself (Brain's standing director acting in its place is
 *    not Hermes identifying anything).
 * 2. Factory was commissioned: an ENGINEERING intervention with a campaign.
 * 3. Factory implemented, merged, deployed and verified: LIVE, with a merge and a deploy.
 * 4. Hermes received the result, and 5. evaluated it against the goal: a lesson recorded
 *    by an operator run, naming this candidate, after §87 measured the metric and kept
 *    the change (RESOLVED: KEPT on an IMPROVED measurement). A delivery without that
 *    measurement is a release, not an improvement.
 */
export function verifiedCycle(f: CycleFacts): { verified: boolean; steps: Record<CycleStep, string | null> } {
  const steps: Record<CycleStep, string | null> = {
    IDENTIFIED_BY_HERMES:
      f.origin === 'STANDING_DIRECTOR'
        ? "commissioned by Brain's standing director, not by Hermes"
        : f.origin !== 'OPERATOR'
          ? 'no operator directive'
          : f.commissionedByRun
            ? null
            : 'the operator run named in the directive did not make the commission call itself',
    COMMISSIONED_FACTORY:
      f.intervention !== 'ENGINEERING' ? `the intervention was ${f.intervention}, not engineering` : f.campaignId ? null : 'no Factory campaign',
    RELEASED_AND_VERIFIED: !f.factory
      ? 'no Factory outcome'
      : !f.factory.mergeSha
        ? 'not merged'
        : !f.factory.deployed
          ? 'not deployed'
          : !f.factory.verified || f.factory.status !== 'LIVE'
            ? `not verified live (${f.factory.status ?? 'unknown'})`
            : null,
    RESULT_RECEIVED:
      f.status !== 'RESOLVED'
        ? `no demonstrated improvement yet (${f.status}${f.decision ? `, decided ${f.decision}` : ''})`
        : !f.evaluation
          ? 'Hermes has not yet received the measured result'
          : null,
    GOAL_EVALUATED: !f.evaluation
      ? 'Hermes has not evaluated the effect on the goal'
      : f.decidedAt && f.evaluation.recordedAt < f.decidedAt
        ? 'the evaluation predates the measurement'
        : null,
  };
  return { verified: Object.values(steps).every((s) => s === null), steps };
}

const ordinalWord = (n: number): string =>
  n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;

/**
 * The owner's message: what was wrong, what Brain fixed, and what actually improved —
 * the software release and the demonstrated improvement in separate, labelled parts,
 * because a release is not an improvement. Plain text; every figure is a row's.
 */
export function improvementNotice(f: CycleFacts, ordinal: number): { subject: string; text: string } {
  const goalMoved = f.goal.effect === 'IMPROVED';
  const subject = `Brain: ${ordinal === 1 ? 'first verified' : `verified #${ordinal}`} autonomous self-improvement — ${f.title}`.slice(0, 200);
  const m = f.measurement;
  const text = [
    `Brain completed its ${ordinalWord(ordinal)} verified autonomous self-improvement cycle.`,
    '',
    'THE PROBLEM HERMES FOUND',
    `${f.title} (${f.deficiency}).`,
    f.problem.slice(0, 900),
    '',
    'WHAT BRAIN FIXED — the software release (a release is not, by itself, an improvement)',
    `Factory campaign ${f.campaignId ?? '—'}${f.factory?.prUrl ? `, pull request ${f.factory.prUrl}` : ''}.`,
    `Merged at ${f.factory?.mergeSha?.slice(0, 12) ?? '—'}, deployed, and verified live.`,
    f.factory?.changedPaths.length ? `Code changed: ${f.factory.changedPaths.slice(0, 8).join(', ')}.` : 'Code changed: not itemised by Factory.',
    `Tests and review: ${f.factory?.tests ?? 'not recorded'}.`,
    '',
    "WHAT ACTUALLY IMPROVED — measured on production after the release",
    m
      ? `${m.metric}: ${m.before ?? '—'} → ${m.after ?? '—'} (${m.verdict ?? '—'}). Brain kept the change: ${f.decisionReason ?? 'KEPT'}`.slice(0, 700)
      : 'No measurement recorded.',
    `Effect on the goal${f.goalTitle ? ` "${f.goalTitle}"` : f.goalId ? ` ${f.goalId}` : ''}: ${f.goal.effect}${f.goal.reasons.length ? ` — ${f.goal.reasons.join('; ')}` : ''}.`,
    goalMoved
      ? 'The goal itself moved.'
      : 'The defect is fixed and its metric improved; the goal itself did not move, so Hermes is directed to a different lever.',
    '',
    "HERMES' EVALUATION",
    (f.evaluation?.lesson ?? '').slice(0, 900),
    '',
    `Record: improvement candidate ${f.candidateId}${f.evaluation ? `, operator run ${f.evaluation.runId}` : ''}. Sent once for this improvement; later verified improvements are each sent once too.`,
  ].join('\n');
  return { subject, text: text.slice(0, 7_900) };
}
