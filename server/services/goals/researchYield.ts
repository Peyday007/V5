/**
 * What a cash goal's research produced for its plan, and why it fell short.
 *
 * Two halves, both readings over existing rows (§43, invariant 45): nothing
 * here stores state about work whose rows can be read.
 *
 *  - `diagnoseGoalResearch` (pure) reads the plan's own judgement of every
 *    opening it holds and the goal's recent rounds, and names the reasons the
 *    research is not producing openings the plan can use — each with the
 *    instruction the next round is given. `openGoalDiscovery` puts them in the
 *    question, so a search that keeps returning a provider's price page
 *    instead of a buyer is told so and asked differently. The bar does not
 *    move: the gate, harvest and plan judge exactly as before.
 *  - `goalResearchProgress` measures the chain from a research job to the
 *    plan: the goal's research jobs by model (the RunPod GPU among them),
 *    claims accepted on them, openings harvested from them and from which
 *    model's fragment, how many have a buyer and a price the plan accepts, how
 *    many the quant model takes, and the plan's own reach over time.
 */
import { getDb } from '../../db/database.ts';
import { RESEARCH_PURPOSES, type ResearchPurpose } from './researchAllocation.ts';
import type { ChainLink, ConsideredOpening } from './plan.ts';

const DATA_CAUSES = [
  'RESEARCH_NOT_FINISHING',
  'NO_OPENINGS_REPORTED',
  'NO_BUYER',
  'NO_SUPPORTED_PRICE',
  'TOO_SMALL',
  'OVER_LIMITS',
  'NO_FULFILLER',
  'SETTLEMENT_UNKNOWN',
] as const;
/**
 * The data causes above are read from the plan's judgement of each opening;
 * the reasoning causes from the goal-to-transaction loop's pathways (§93,
 * `pathways.ts`) — failures of the method rather than of one opening.
 */
export const RESEARCH_CAUSES = [...DATA_CAUSES, 'CONSTRUCTION_FAILURE', 'ACQUISITION_FAILURE', 'CASH_TIMING_FAILURE', 'VOLUME_UNRESEARCHED', 'REPEATED_GAP', 'STRATEGY_RECONSTRUCTION'] as const;
export type ResearchCause = (typeof RESEARCH_CAUSES)[number];

export interface ResearchDiagnosis {
  cause: ResearchCause;
  /** What the rows show, in one sentence. */
  evidence: string;
  /** What the next round is asked to do differently. */
  instruction: string;
}

export interface GoalRoundOutcome {
  state: string;
  found: number;
}

/** A share at or above this of the openings held lacking a link names that link as a cause. */
export const CAUSE_SHARE = 0.5;
/** Rounds settled empty (or abandoned) before research itself is named the cause. */
export const BARREN_ROUNDS_FOR_CAUSE = 2;
/** At most this many instructions go into one question, so it stays a question. */
export const MAX_INSTRUCTIONS = 3;

const INSTRUCTION: Record<(typeof DATA_CAUSES)[number], string> = {
  RESEARCH_NOT_FINISHING:
    'Recent searches for this goal ended without a report because no claim survived the evidence check, so cite only pages that open without a login or bot wall (official pages, public marketplace listings, public registers) and quote the exact sentence that names the buyer, the work and the price.',
  NO_OPENINGS_REPORTED:
    'Recent searches for this goal reported no opening, so report buyer-side evidence: a dated public request, job post, tender or marketplace listing where a business or household asks and pays for this work.',
  NO_BUYER:
    'Most openings Brain holds are a provider describing its own service, not a buyer asking for one, so for each opening name the kind of business or household that pays, where it publicly asks for the work, and one dated example of it doing so.',
  NO_SUPPORTED_PRICE:
    'Most openings Brain holds have no price buyers are shown paying, so give the price buyers pay for this exact deliverable — completed-job prices on a marketplace, or a competitor\'s published price for the same deliverable to the same buyers — with its page.',
  TOO_SMALL:
    'The openings Brain holds are each too small to matter for the goal, so prefer work many buyers pay for repeatedly, and state how many such buyers exist (a count from a directory, register or marketplace) and how often each buys.',
  OVER_LIMITS:
    'Most openings Brain holds need more money up front, or cost more, than the goal allows, so prefer ways with almost no up-front cost — work produced digitally, or services an independent contractor performs and the buyer pays for before or on completion — and state the direct cost per sale.',
  NO_FULFILLER:
    'Several openings were left out because they need physical work and nobody independent was named to perform it; the owner does no physical work himself but may sell, book, refer or subcontract it. For each such opening name the kind of independent contractor or supplier who performs it, how they are found and paid, and how this operation coordinates the job online.',
  SETTLEMENT_UNKNOWN:
    'Nobody has established when the money from the openings held would settle, so for each opening say how buyers pay (card at checkout, prepaid, invoice terms) and how many days until the cash arrives.',
};

/**
 * Why the goal's research is not producing openings its plan can use.
 * Pure: the plan's considered openings, the reasons it excluded others, and
 * the goal's recent rounds. Most severe first; empty when nothing stands out.
 */
export function diagnoseGoalResearch(input: {
  considered: Pick<ConsideredOpening, 'missing' | 'supportedReach' | 'potentialReach'>[];
  excludedReasons: string[];
  rounds: GoalRoundOutcome[];
  /** The amount still needed, in major units. */
  remaining: number;
}): ResearchDiagnosis[] {
  const out: ResearchDiagnosis[] = [];
  const settled = input.rounds.filter((one) => one.state !== 'OPEN');
  const fruitful = settled.filter((one) => one.state === 'HARVESTED' && one.found > 0).length;
  const abandoned = settled.filter((one) => one.state === 'ABANDONED').length;
  const empty = settled.filter((one) => one.state === 'HARVESTED' && one.found === 0).length;
  if (fruitful === 0 && abandoned >= BARREN_ROUNDS_FOR_CAUSE && abandoned >= empty) {
    out.push({ cause: 'RESEARCH_NOT_FINISHING', evidence: `${abandoned} of the goal's last ${settled.length} settled rounds ended without a report, and none filed an opening`, instruction: INSTRUCTION.RESEARCH_NOT_FINISHING });
  } else if (fruitful === 0 && empty >= BARREN_ROUNDS_FOR_CAUSE) {
    out.push({ cause: 'NO_OPENINGS_REPORTED', evidence: `${empty} of the goal's last ${settled.length} settled rounds filed a report with no opening in it`, instruction: INSTRUCTION.NO_OPENINGS_REPORTED });
  }
  const held = input.considered;
  if (held.length > 0) {
    const lacking = (links: ChainLink[]) => held.filter((one) => one.missing.some((link) => links.includes(link))).length;
    const share = (n: number) => `${n} of ${held.length} openings held`;
    const buyer = lacking(['REACHABLE_BUYER', 'CURRENT_DEMAND']);
    if (buyer / held.length >= CAUSE_SHARE) out.push({ cause: 'NO_BUYER', evidence: `${share(buyer)} lack a reachable buyer or a dated sign of demand`, instruction: INSTRUCTION.NO_BUYER });
    const price = lacking(['OFFER_AND_PRICE']);
    if (price / held.length >= CAUSE_SHARE) out.push({ cause: 'NO_SUPPORTED_PRICE', evidence: `${share(price)} lack a price buyers are shown to pay`, instruction: INSTRUCTION.NO_SUPPORTED_PRICE });
    const largest = Math.max(0, ...held.map((one) => Math.max(one.supportedReach, one.potentialReach ?? 0)));
    if (input.remaining > 0 && largest < input.remaining * 0.1) {
      out.push({ cause: 'TOO_SMALL', evidence: `the largest opening held could bring ${Math.round(largest)} of the ${Math.round(input.remaining)} still needed`, instruction: INSTRUCTION.TOO_SMALL });
    }
    const money = lacking(['ECONOMICS']);
    if (money / held.length >= CAUSE_SHARE) out.push({ cause: 'OVER_LIMITS', evidence: `${share(money)} have costs or money tied up that are unknown or over the limits`, instruction: INSTRUCTION.OVER_LIMITS });
    const settles = lacking(['SETTLES_IN_TIME']);
    if (settles / held.length >= CAUSE_SHARE) out.push({ cause: 'SETTLEMENT_UNKNOWN', evidence: `${share(settles)} have no established settlement date`, instruction: INSTRUCTION.SETTLEMENT_UNKNOWN });
  }
  // Physical work with nobody named to perform it is a fulfilment question, not a money limit.
  const physical = input.excludedReasons.filter((reason) => /physical/i.test(reason)).length;
  if (physical >= 3) {
    out.push({ cause: 'NO_FULFILLER', evidence: `${physical} openings were left out for physical work with no independent provider named`, instruction: INSTRUCTION.NO_FULFILLER });
  }
  const limits = input.excludedReasons.filter((reason) => /capital|tie[sd]? up|more than the/i.test(reason)).length;
  if (limits >= 3 && !out.some((one) => one.cause === 'OVER_LIMITS')) {
    out.push({ cause: 'OVER_LIMITS', evidence: `${limits} openings were left out of the plan for money tied up`, instruction: INSTRUCTION.OVER_LIMITS });
  }
  return out;
}

/** The instructions a goal round is given, from a diagnosis. */
export function diagnosisInstructions(diagnosis: ResearchDiagnosis[]): string {
  return diagnosis.slice(0, MAX_INSTRUCTIONS).map((one) => one.instruction).join(' ');
}

/** The goal's own rounds (lens and constructed), newest first. */
export async function recentGoalRounds(projectId: string, goalId: string, limit = 12): Promise<GoalRoundOutcome[]> {
  return await getDb().all<GoalRoundOutcome>(
    `SELECT state, found FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE ?
      ORDER BY opened_at DESC, id DESC LIMIT ${Math.max(1, Math.trunc(limit))}`,
    [projectId, `goal-${goalId}%`],
  );
}

/** The model that answered a free-lane job, from its event's reason (`model <name>[: why]`). */
export function modelOfReason(reason: string | null): string {
  return String(reason ?? '').replace(/^model /, '').split(':')[0]!.trim() || '(unknown)';
}

/** A free-lane failure reason without its model, counts, hosts and quotes, so like failures group. */
export function failureClass(reason: string | null): string {
  const why = String(reason ?? '').replace(/^model [^:]+:\s*/, '');
  return why
    .replace(/\{[^}]*\}/g, '{…}')
    .replace(/\d+/g, 'N')
    .replace(/(getaddrinfo \w+|attempted address:|answered) .*/, '$1 …')
    .slice(0, 110)
    .trim() || '(no reason)';
}

export interface GoalResearchProgress {
  since: string;
  rounds: { opened: number; harvested: number; withOpenings: number; abandoned: number; open: number };
  /** Free-lane jobs on the goal's research, by model. */
  jobs: Record<string, { submitted: number; failed: number }>;
  /** Accepted (sourced) claims on fragments each model submitted for the goal. */
  claims: Record<string, { claims: number; sourced: number; signalled: number }>;
  /** Why the goal's research jobs were not accepted, most frequent first (reason with ids stripped). */
  failures: { reason: string; n: number }[];
  /** Openings harvested from the goal's research in the window. */
  openings: { id: string; title: string; model: string | null; payer: boolean; price: boolean }[];
}

/**
 * The chain from a goal's research jobs to its openings, over a window.
 * A goal's research is every mission whose idea one of its rounds asked.
 */
export async function goalResearchProgress(projectId: string, goalId: string, since: string): Promise<GoalResearchProgress> {
  const db = getDb();
  const bucket = `goal-${goalId}%`;
  const rounds = await db.all<{ state: string; found: number; opened_at: string; harvested_at: string | null }>(
    `SELECT state, found, opened_at, harvested_at FROM cash_discovery_rounds
      WHERE project_id = ? AND bucket_id LIKE ? AND (opened_at >= ? OR harvested_at >= ? OR state = 'OPEN')`,
    [projectId, bucket, since, since],
  );
  const goalOrchestrations = `SELECT m.orchestration_id FROM russell_missions m
      JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id
     WHERE r.project_id = ? AND r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL`;
  const jobRows = await db.all<{ reason: string | null; outcome: string; n: number | string }>(
    `SELECT e.reason, e.outcome, COUNT(*) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND w.orchestration_id IN (${goalOrchestrations})
      GROUP BY e.reason, e.outcome`,
    [since, projectId, bucket],
  );
  const jobs: GoalResearchProgress['jobs'] = {};
  for (const row of jobRows) {
    const model = modelOfReason(row.reason);
    const entry = (jobs[model] ??= { submitted: 0, failed: 0 });
    if (row.outcome === 'SUBMITTED') entry.submitted += Number(row.n);
    else entry.failed += Number(row.n);
  }
  const claimRows = await db.all<{ reason: string | null; claims: number | string; sourced: number | string | null; signalled: number | string | null }>(
    `SELECT e.reason, COUNT(c.id) AS claims,
            SUM(CASE WHEN c.sourced = 1 THEN 1 ELSE 0 END) AS sourced,
            SUM(CASE WHEN c.sourced = 1 AND c.opportunity_signal IS NOT NULL THEN 1 ELSE 0 END) AS signalled
       FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
       JOIN research_claims c ON c.fragment_id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.workload_class = 'RESEARCH_FRAGMENT'
        AND e.at >= ? AND w.fragment_id IS NOT NULL AND w.orchestration_id IN (${goalOrchestrations})
      GROUP BY e.reason`,
    [since, projectId, bucket],
  );
  const failRows = await db.all<{ reason: string | null }>(
    `SELECT e.reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome <> 'SUBMITTED' AND e.at >= ?
        AND w.orchestration_id IN (${goalOrchestrations})`,
    [since, projectId, bucket],
  );
  const failCounts = new Map<string, number>();
  for (const row of failRows) {
    const why = failureClass(row.reason);
    failCounts.set(why, (failCounts.get(why) ?? 0) + 1);
  }
  const failures = [...failCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, n]) => ({ reason, n }));
  const claims: GoalResearchProgress['claims'] = {};
  for (const row of claimRows) {
    const entry = (claims[modelOfReason(row.reason)] ??= { claims: 0, sourced: 0, signalled: 0 });
    entry.claims += Number(row.claims);
    entry.sourced += Number(row.sourced ?? 0);
    entry.signalled += Number(row.signalled ?? 0);
  }
  const openingRows = await db.all<{ id: string; title: string; payer: string | null; price_cents: number | null; fragment_id: string | null }>(
    `SELECT o.id, o.title, o.payer, o.price_cents, o.fragment_id FROM cash_opportunities o
       JOIN cash_discovery_rounds r ON r.id = o.discovery_round_id
      WHERE o.project_id = ? AND r.bucket_id LIKE ? AND o.created_at >= ? AND o.duplicate_of_id IS NULL
      ORDER BY o.created_at DESC`,
    [projectId, bucket, since],
  );
  const fragments = [...new Set(openingRows.map((one) => one.fragment_id).filter((one): one is string => !!one))];
  const byFragment = new Map<string, string>();
  if (fragments.length > 0) {
    const rows = await db.all<{ fragment_id: string; reason: string | null }>(
      `SELECT w.fragment_id, e.reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
        WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED'
          AND w.fragment_id IN (${fragments.map(() => '?').join(', ')})`,
      fragments,
    );
    for (const row of rows) byFragment.set(row.fragment_id, modelOfReason(row.reason));
  }
  return {
    since,
    rounds: {
      opened: rounds.filter((one) => one.opened_at >= since).length,
      harvested: rounds.filter((one) => one.state === 'HARVESTED' && (one.harvested_at ?? '') >= since).length,
      withOpenings: rounds.filter((one) => one.state === 'HARVESTED' && one.found > 0 && (one.harvested_at ?? '') >= since).length,
      abandoned: rounds.filter((one) => one.state === 'ABANDONED' && (one.harvested_at ?? one.opened_at) >= since).length,
      open: rounds.filter((one) => one.state === 'OPEN').length,
    },
    jobs,
    failures,
    claims,
    openings: openingRows.map((one) => ({
      id: one.id,
      title: one.title,
      // A fragment no free-lane model answered was answered by a Claude routine or a person.
      model: one.fragment_id ? (byFragment.get(one.fragment_id) ?? 'not the free lane') : null,
      payer: !!one.payer?.trim(),
      price: one.price_cents !== null,
    })),
  };
}

/**
 * How fast a goal's work moves, measured from rows (owner's order, 2026-11-05:
 * "prove the speed improvement"). Nothing is estimated: each figure is a count
 * or a difference of timestamps Brain wrote while doing the work.
 *
 *   - submission → plan: the goal's creation and target, its first plan
 *     reading, and its first RECOMMENDABLE one (a complete plan), if any;
 *   - concurrency: free-lane research jobs in flight at once (each event is a
 *     finished job carrying its duration), peak and time-averaged, fleet-wide
 *     and for this goal's own jobs;
 *   - research accepted per hour, openings filed and plan reads per hour;
 *   - waiting: for every opening filed in the window, the time until the goal's
 *     plan next read it (a scenario run began, or a reading was written) — the time evidence sat beside an
 *     idle plan — and the minutes the free lane sat idle with work queued;
 *   - quantitative evaluation: each plan run's own elapsed time;
 *   - GPU: busy job-time over the pod's measured running time.
 */
export interface GoalPipelineSpeed {
  hours: number;
  goalCreatedAt: string | null;
  targetSetAt: string | null;
  firstReadingAt: string | null;
  firstRecommendableAt: string | null;
  jobs: { total: number; goal: number; peak: number; average: number; goalPeak: number; goalAverage: number };
  acceptedClaimsPerHour: number;
  goalAcceptedClaimsPerHour: number;
  openingsPerHour: number;
  planRunsPerHour: number;
  evidenceToPlan: { openings: number; unread: number; medianMs: number | null; p90Ms: number | null; maxMs: number | null };
  idleWithWorkMinutes: number;
  planRunMs: { runs: number; medianMs: number | null; maxMs: number | null };
  gpu: { jobMs: number; runningMs: number; busySlots: number | null };
}

/** Peak and time-averaged overlap of [start, end] intervals inside [from, to]. Pure. */
export function overlap(intervals: readonly { start: number; end: number }[], from: number, to: number): { peak: number; average: number } {
  const edges: { at: number; d: number }[] = [];
  let area = 0;
  for (const one of intervals) {
    const start = Math.max(from, one.start);
    const end = Math.min(to, one.end);
    if (end <= start) continue;
    edges.push({ at: start, d: 1 }, { at: end, d: -1 });
    area += end - start;
  }
  // An end before a start at the same instant: touching jobs do not overlap.
  edges.sort((a, b) => a.at - b.at || a.d - b.d);
  let now = 0;
  let peak = 0;
  for (const edge of edges) {
    now += edge.d;
    peak = Math.max(peak, now);
  }
  return { peak, average: to > from ? Math.round((100 * area) / (to - from)) / 100 : 0 };
}

/** For each event time, how long until the first start at or after it; null when none came. Pure. */
export function waitsUntilNext(events: readonly number[], starts: readonly number[]): (number | null)[] {
  const sorted = [...starts].sort((a, b) => a - b);
  return events.map((at) => {
    const next = sorted.find((one) => one >= at);
    return next === undefined ? null : next - at;
  });
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export async function goalPipelineSpeed(input: { goalId: string; projectId: string; since: string; until?: string }): Promise<GoalPipelineSpeed> {
  const db = getDb();
  const from = Date.parse(input.since);
  const until = input.until ?? new Date().toISOString();
  const to = Date.parse(until);
  const hours = Math.max(1 / 60, (to - from) / 3_600_000);
  const perHour = (n: number) => Math.round((10 * n) / hours) / 10;
  const bucket = `goal-${input.goalId}%`;
  const goal = await db.get<{ created_at: string; target_set_at: string | null }>('SELECT created_at, target_set_at FROM workstreams WHERE id = ?', [input.goalId]);
  const first = await db.get<{ at: string | null }>('SELECT MIN(created_at) AS at FROM goal_plan_readings WHERE workstream_id = ?', [input.goalId]);
  const firstGood = await db.get<{ at: string | null }>(
    `SELECT MIN(created_at) AS at FROM goal_plan_readings WHERE workstream_id = ? AND verdict = 'RECOMMENDABLE'`,
    [input.goalId],
  );
  const goalOrchestrations = `SELECT m.orchestration_id FROM russell_missions m
      JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id
     WHERE r.project_id = ? AND r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL`;
  const jobs = await db.all<{ at: string; ms: number | string | null; reason: string | null; mine: number | string }>(
    `SELECT e.at, e.duration_ms AS ms, e.reason,
            CASE WHEN w.orchestration_id IN (${goalOrchestrations}) THEN 1 ELSE 0 END AS mine
       FROM bin_events e LEFT JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND e.at <= ?`,
    [input.projectId, bucket, input.since, until],
  );
  const intervals = jobs.map((one) => ({ end: Date.parse(one.at), start: Date.parse(one.at) - Number(one.ms ?? 0), mine: Number(one.mine) === 1, gpu: modelOfReason(one.reason).startsWith('runpod/') }));
  const all = overlap(intervals, from, to);
  const mine = overlap(intervals.filter((one) => one.mine), from, to);
  const claims = await db.get<{ n: number | string; g: number | string | null }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN c.orchestration_id IN (${goalOrchestrations}) THEN 1 ELSE 0 END) AS g
       FROM research_claims c WHERE c.accepted = 1 AND c.created_at >= ? AND c.created_at <= ?`,
    [input.projectId, bucket, input.since, until],
  );
  const openings = await db.all<{ created_at: string }>(
    `SELECT created_at FROM cash_opportunities WHERE project_id = ? AND duplicate_of_id IS NULL AND created_at >= ? AND created_at <= ?`,
    [input.projectId, input.since, until],
  );
  const runs = await db.all<{ started_at: string; elapsed_ms: number | string | null }>(
    `SELECT started_at, elapsed_ms FROM scenario_runs WHERE project_id = ? AND label = ? AND started_at >= ?`,
    [input.projectId, `goal ${input.goalId}`, input.since],
  );
  // A plan read is a scenario run, or a reading written without one (nothing modellable yet).
  const readings = await db.all<{ created_at: string }>(
    'SELECT created_at FROM goal_plan_readings WHERE workstream_id = ? AND created_at >= ?',
    [input.goalId, input.since],
  );
  const reads = [...runs.map((one) => Date.parse(one.started_at)), ...readings.map((one) => Date.parse(one.created_at))];
  const waits = waitsUntilNext(openings.map((one) => Date.parse(one.created_at)), reads);
  const known = waits.filter((one): one is number => one !== null);
  const idle = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_IDLE' AND at >= ? AND at <= ?`,
    [input.since, until],
  );
  const elapsed = runs.map((one) => Number(one.elapsed_ms ?? NaN)).filter((one) => Number.isFinite(one));
  const pod = await db.get<{ ms: number | string | null }>(
    `SELECT SUM(duration_ms) AS ms FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome = 'SAMPLE_RUNNING' AND at >= ? AND at <= ?`,
    [input.since, until],
  );
  const gpuJobMs = intervals.filter((one) => one.gpu).reduce((sum, one) => sum + Math.max(0, one.end - one.start), 0);
  const runningMs = Number(pod?.ms ?? 0);
  return {
    hours: Math.round(hours * 10) / 10,
    goalCreatedAt: goal?.created_at ?? null,
    targetSetAt: goal?.target_set_at ?? null,
    firstReadingAt: first?.at ?? null,
    firstRecommendableAt: firstGood?.at ?? null,
    jobs: { total: intervals.length, goal: intervals.filter((one) => one.mine).length, peak: all.peak, average: all.average, goalPeak: mine.peak, goalAverage: mine.average },
    acceptedClaimsPerHour: perHour(Number(claims?.n ?? 0)),
    goalAcceptedClaimsPerHour: perHour(Number(claims?.g ?? 0)),
    openingsPerHour: perHour(openings.length),
    planRunsPerHour: perHour(runs.length),
    evidenceToPlan: { openings: openings.length, unread: waits.length - known.length, medianMs: percentile(known, 50), p90Ms: percentile(known, 90), maxMs: known.length ? Math.max(...known) : null },
    // The lane records an idle reading at most every ten minutes while it lasts.
    idleWithWorkMinutes: Number(idle?.n ?? 0) * 10,
    planRunMs: { runs: elapsed.length, medianMs: percentile(elapsed, 50), maxMs: elapsed.length ? Math.max(...elapsed) : null },
    gpu: { jobMs: gpuJobMs, runningMs, busySlots: runningMs > 0 ? Math.round((100 * gpuJobMs) / runningMs) / 100 : null },
  };
}

/* ------------------------------------------------------------------------- */
/* Research yield by lane and by purpose, over one window (RES-07, RES-15-5)  */
/* ------------------------------------------------------------------------- */

/**
 * What the research Brain ran in one window produced, per lane and per
 * purpose, read from the rows the work already wrote (invariant 45: nothing
 * is stored here).
 *
 * A **job** is one unit of spent capacity: a free-lane item (one
 * `FREE_LANE_ITEM` event, carrying its model and duration) or one bin handed
 * to a worker (`BIN_ASSIGNED`, running until the lease closes). Its **lane** is
 * where the capacity came from — `free-lane:<model>` (the RunPod GPU's models
 * start `runpod/`) or `bin:<provider>`.
 *
 * Every job is **attributed** to one or more of five purposes from what its
 * rows already say — the bin's recorded purpose, the project, the goal the
 * research belongs to, the discovery round that asked it, the opening it is
 * about and whether that opening has been paid — and the basis is recorded.
 * Nothing is attributed by category or industry, and a job nothing attributes
 * is reported as `UNATTRIBUTED`, never dropped.
 *
 * A job serving several purposes appears in each purpose's *output*, but its
 * *cost* (job time, and money where a row records it) is split evenly between
 * them, so the purposes' costs sum exactly to the total and the total sums each
 * distinct job once — `costCountedOnce` says whether that held.
 */
// The purposes are defined once, in the pure allocation module; re-exported for this module's readers.
export { RESEARCH_PURPOSES, type ResearchPurpose };
export type PurposeKey = ResearchPurpose | 'UNATTRIBUTED';

/** What the rows say about the work a job did, for attribution. */
export interface PurposeFacts {
  /** The bin's recorded purpose (`domain/binPurpose.ts`), when the job was a bin. */
  binPurpose?: string | null;
  projectSlug?: string | null;
  projectPurpose?: string | null;
  /** The goal the research belongs to, and whether that goal has a target set. */
  goalId?: string | null;
  goalHasTarget?: boolean;
  /** Discovery-round buckets whose idea this research asked. */
  buckets?: readonly string[];
  /** The research asks about an opening already filed (its deep dive or a narrow need). */
  aboutOpening?: boolean;
  /** That opening has a verified customer payment: a business already operating. */
  openingPaid?: boolean;
}

export interface PurposeAttribution {
  purposes: PurposeKey[];
  /** One line per purpose, naming the row that decided it. */
  basis: string[];
}

/** Brain's own project slug (`domain/binPurpose.ts` BRAIN_PROJECT_SLUG). */
const BRAIN_PROJECT = 'brain-architecture';

/** Which of the five purposes a job served, from its rows. Pure. */
export function attributePurposes(facts: PurposeFacts): PurposeAttribution {
  const purposes: PurposeKey[] = [];
  const basis: string[] = [];
  // Every row that bears on a purpose is recorded, even when an earlier one already decided it.
  const add = (purpose: ResearchPurpose, why: string) => {
    if (!purposes.includes(purpose)) purposes.push(purpose);
    basis.push(`${purpose}: ${why}`);
  };
  if (facts.binPurpose === 'BRAIN_IMPROVEMENT') add('SELF_IMPROVEMENT', 'bin purpose BRAIN_IMPROVEMENT');
  if (facts.projectSlug === BRAIN_PROJECT) add('SELF_IMPROVEMENT', `project ${BRAIN_PROJECT}`);
  if (facts.projectPurpose === 'TECHNICAL') add('SELF_IMPROVEMENT', 'project purpose TECHNICAL');
  const buckets = facts.buckets ?? [];
  if (facts.openingPaid) add('OPERATING_SUPPORT', 'asks about an opening with a verified customer payment');
  if (facts.aboutOpening) add('TRANSACTION_ROUTES', 'asks about an opening already filed');
  const constructed = buckets.filter((b) => /-mx-/.test(b));
  if (constructed.length > 0) add('TRANSACTION_ROUTES', `constructed arrangement round ${constructed[0]}`);
  const broad = buckets.filter((b) => !/-mx-/.test(b));
  if (broad.length > 0) add('BROAD_DISCOVERY', `discovery round ${broad[0]}`);
  if (facts.goalId && facts.goalHasTarget === false) add('FORWARD_EXPLORATION', `goal ${facts.goalId} has no target yet`);
  if (purposes.length === 0) return { purposes: ['UNATTRIBUTED'], basis: ['UNATTRIBUTED: no row names what this work was for'] };
  return { purposes, basis };
}

/** A failure reason that is a provider's rate limit or quota, not a fault in the work. */
export function isRateLimited(reason: string | null): boolean {
  return /rate.?limit|\b429\b|quota|too many requests/i.test(String(reason ?? ''));
}

export interface YieldJob {
  id: string;
  lane: string;
  purposes: PurposeKey[];
  basis: string[];
  /** When the job began running (ms). */
  startMs: number;
  durationMs: number;
  /** Time it waited in the queue before it began; null when unknown. */
  queueWaitMs: number | null;
  outcome: 'COMPLETED' | 'FAILED' | 'IN_FLIGHT';
  /** Grouped failure reason; null unless FAILED. */
  failureCause: string | null;
  rateLimited: boolean;
  /** Money a row records this job cost, in minor units; null when no row records it. */
  costMinor: number | null;
}

export const YIELD_OUTPUT_KINDS = ['ACCEPTED_CLAIM', 'PACKET_FILED', 'NEW_MECHANISM', 'QUALIFIED_POSITION', 'EXECUTABLE_OFFER', 'PAID_TRANSACTION'] as const;
export type YieldOutputKind = (typeof YIELD_OUTPUT_KINDS)[number];
/** Outputs that are a commercially usable result rather than an intermediate (a claim). */
export const USEFUL_KINDS: readonly YieldOutputKind[] = ['PACKET_FILED', 'QUALIFIED_POSITION', 'EXECUTABLE_OFFER', 'PAID_TRANSACTION'];

export interface YieldOutput {
  kind: YieldOutputKind;
  id: string;
  lane: string;
  purposes: PurposeKey[];
  /** For an accepted claim: how its source was classified. */
  source?: 'PRIMARY' | 'SECONDARY' | 'UNRETRIEVED';
}

export interface YieldBucket {
  submissions: number;
  completions: number;
  inFlight: number;
  failures: { total: number; rateLimited: number; other: number; causes: { cause: string; n: number }[] };
  queueWait: { measured: number; medianMs: number | null; p90Ms: number | null };
  acceptedClaims: number;
  sourceQuality: { primary: number; secondary: number; unretrieved: number; primaryShare: number | null };
  packetsFiled: number;
  newMechanisms: number;
  qualifiedPositions: number;
  executableOffers: number;
  paidTransactions: number;
  /** Packets, qualified positions, executable offers and paid transactions. */
  usefulResults: number;
  /** Job time charged here; for a purpose, a multi-purpose job's share. */
  jobMs: number;
  /** Money charged here, or null when no job here has a recorded cost. */
  costMinor: number | null;
  /** Jobs whose money cost no row records. */
  uncostedJobs: number;
  msPerUsefulResult: number | null;
  costMinorPerUsefulResult: number | null;
  /** Average jobs running at once over the window (time-weighted); 1 = one slot busy throughout. */
  utilization: number;
}

export interface ResearchYieldReading {
  window: { since: string; until: string; ms: number };
  total: YieldBucket;
  lanes: Record<string, YieldBucket>;
  purposes: Record<PurposeKey, YieldBucket>;
  /** Distinct jobs, the job time and money they spent, and whether every purpose's share sums back to it. */
  costCountedOnce: { jobs: number; totalJobMs: number; purposeJobMs: number; totalCostMinor: number | null; purposeCostMinor: number | null; holds: boolean };
  /** Each job's attribution basis, so "why is this job SELF_IMPROVEMENT" is answerable. */
  attributions: { jobId: string; lane: string; purposes: PurposeKey[]; basis: string[] }[];
  notes: string[];
}

function emptyBucket(): YieldBucket {
  return {
    submissions: 0, completions: 0, inFlight: 0,
    failures: { total: 0, rateLimited: 0, other: 0, causes: [] },
    queueWait: { measured: 0, medianMs: null, p90Ms: null },
    acceptedClaims: 0, sourceQuality: { primary: 0, secondary: 0, unretrieved: 0, primaryShare: null },
    packetsFiled: 0, newMechanisms: 0, qualifiedPositions: 0, executableOffers: 0, paidTransactions: 0, usefulResults: 0,
    jobMs: 0, costMinor: null, uncostedJobs: 0, msPerUsefulResult: null, costMinorPerUsefulResult: null, utilization: 0,
  };
}

/**
 * Fold jobs and outputs into total, per-lane and per-purpose buckets over one
 * window. Pure. A job's cost goes to the total once and is split evenly between
 * its purposes; its counts and its outputs go to every purpose it served.
 */
export function summarizeResearchYield(input: { since: string; until: string; jobs: readonly YieldJob[]; outputs: readonly YieldOutput[] }): ResearchYieldReading {
  const from = Date.parse(input.since);
  const to = Date.parse(input.until);
  const windowMs = Math.max(0, to - from);
  const total = emptyBucket();
  const lanes: Record<string, YieldBucket> = {};
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, emptyBucket()])) as Record<PurposeKey, YieldBucket>;
  const waits = new Map<YieldBucket, number[]>();
  const causes = new Map<YieldBucket, Map<string, number>>();
  const intervals = new Map<YieldBucket, { start: number; end: number }[]>();
  const lane = (key: string) => (lanes[key] ??= emptyBucket());
  const seen = new Set<string>();
  const countJob = (bucket: YieldBucket, job: YieldJob, share: number) => {
    bucket.submissions += 1;
    if (job.outcome === 'COMPLETED') bucket.completions += 1;
    else if (job.outcome === 'IN_FLIGHT') bucket.inFlight += 1;
    else {
      bucket.failures.total += 1;
      if (job.rateLimited) bucket.failures.rateLimited += 1;
      else bucket.failures.other += 1;
      const cause = job.rateLimited ? 'rate limit or quota' : (job.failureCause ?? '(no reason)');
      const m = causes.get(bucket) ?? new Map<string, number>();
      m.set(cause, (m.get(cause) ?? 0) + 1);
      causes.set(bucket, m);
    }
    if (job.queueWaitMs !== null) (waits.get(bucket) ?? waits.set(bucket, []).get(bucket)!).push(job.queueWaitMs);
    (intervals.get(bucket) ?? intervals.set(bucket, []).get(bucket)!).push({ start: job.startMs, end: job.startMs + job.durationMs });
    bucket.jobMs += job.durationMs * share;
    if (job.costMinor === null) bucket.uncostedJobs += 1;
    else bucket.costMinor = (bucket.costMinor ?? 0) + job.costMinor * share;
  };
  for (const job of input.jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    countJob(total, job, 1);
    countJob(lane(job.lane), job, 1);
    const served = job.purposes.length > 0 ? job.purposes : (['UNATTRIBUTED'] as PurposeKey[]);
    for (const p of served) countJob(purposes[p], job, 1 / served.length);
  }
  const outputSeen = new Set<string>();
  const countOutput = (bucket: YieldBucket, out: YieldOutput) => {
    switch (out.kind) {
      case 'ACCEPTED_CLAIM':
        bucket.acceptedClaims += 1;
        if (out.source === 'PRIMARY') bucket.sourceQuality.primary += 1;
        else if (out.source === 'UNRETRIEVED') bucket.sourceQuality.unretrieved += 1;
        else bucket.sourceQuality.secondary += 1;
        break;
      case 'PACKET_FILED': bucket.packetsFiled += 1; break;
      case 'NEW_MECHANISM': bucket.newMechanisms += 1; break;
      case 'QUALIFIED_POSITION': bucket.qualifiedPositions += 1; break;
      case 'EXECUTABLE_OFFER': bucket.executableOffers += 1; break;
      case 'PAID_TRANSACTION': bucket.paidTransactions += 1; break;
    }
    if (USEFUL_KINDS.includes(out.kind)) bucket.usefulResults += 1;
  };
  for (const out of input.outputs) {
    const key = `${out.kind}:${out.id}`;
    if (outputSeen.has(key)) continue;
    outputSeen.add(key);
    countOutput(total, out);
    countOutput(lane(out.lane), out);
    const served = out.purposes.length > 0 ? out.purposes : (['UNATTRIBUTED'] as PurposeKey[]);
    for (const p of served) countOutput(purposes[p], out);
  }
  const finish = (bucket: YieldBucket) => {
    const w = waits.get(bucket) ?? [];
    bucket.queueWait = { measured: w.length, medianMs: percentile(w, 50), p90Ms: percentile(w, 90) };
    bucket.failures.causes = [...(causes.get(bucket) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([cause, n]) => ({ cause, n }));
    const rated = bucket.sourceQuality.primary + bucket.sourceQuality.secondary + bucket.sourceQuality.unretrieved;
    bucket.sourceQuality.primaryShare = rated > 0 ? Math.round((1000 * bucket.sourceQuality.primary) / rated) / 1000 : null;
    bucket.jobMs = Math.round(bucket.jobMs * 1000) / 1000;
    if (bucket.costMinor !== null) bucket.costMinor = Math.round(bucket.costMinor * 1000) / 1000;
    bucket.msPerUsefulResult = bucket.usefulResults > 0 ? Math.round(bucket.jobMs / bucket.usefulResults) : null;
    bucket.costMinorPerUsefulResult = bucket.usefulResults > 0 && bucket.costMinor !== null && bucket.uncostedJobs === 0 ? Math.round(bucket.costMinor / bucket.usefulResults) : null;
    bucket.utilization = overlap(intervals.get(bucket) ?? [], from, to).average;
  };
  finish(total);
  for (const bucket of Object.values(lanes)) finish(bucket);
  for (const bucket of Object.values(purposes)) finish(bucket);
  const purposeJobMs = Math.round(Object.values(purposes).reduce((sum, b) => sum + b.jobMs, 0) * 1000) / 1000;
  const costed = Object.values(purposes).filter((b) => b.costMinor !== null);
  const purposeCostMinor = costed.length > 0 ? Math.round(costed.reduce((sum, b) => sum + (b.costMinor ?? 0), 0) * 1000) / 1000 : null;
  const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.01);
  return {
    window: { since: input.since, until: input.until, ms: windowMs },
    total,
    lanes,
    purposes,
    costCountedOnce: {
      jobs: seen.size,
      totalJobMs: total.jobMs,
      purposeJobMs,
      totalCostMinor: total.costMinor,
      purposeCostMinor,
      holds: close(total.jobMs, purposeJobMs) && close(total.costMinor, purposeCostMinor),
    },
    attributions: input.jobs.filter((job, i, all) => all.findIndex((o) => o.id === job.id) === i).map((job) => ({ jobId: job.id, lane: job.lane, purposes: job.purposes.length ? job.purposes : ['UNATTRIBUTED'], basis: job.basis })),
    notes: [
      'a job is a free-lane item or a bin handed to a worker; its cost is job time, and money only where a row records it',
      'a job serving several purposes counts in each purpose, with its cost split evenly so purposes sum to the total once',
      'source quality: PRIMARY when the claim says its source produced the data, UNRETRIEVED when the source was not read, otherwise SECONDARY',
      'useful results: packets filed, evidence-qualified positions, executable offers and verified customer payments',
    ],
  };
}

/** The windows TEL-07-1 reads (`cash/screenMetrics.ts`), so yield and telemetry compare like with like. */
export const RESEARCH_YIELD_WINDOWS = [
  { key: '1h', ms: 3_600_000 },
  { key: '6h', ms: 6 * 3_600_000 },
  { key: '24h', ms: 24 * 3_600_000 },
] as const;

const CHUNK = 400;
async function inChunks<T>(ids: readonly string[], read: (chunk: string[], marks: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    out.push(...(await read(chunk, chunk.map(() => '?').join(', '))));
  }
  return out;
}

/** Who ran a dispatched bin: its event's provider, else the latest fire for it (`screenMetrics.ts` BIN_PROVIDER). Alias `e`. */
const DISPATCH_PROVIDER = `COALESCE(e.provider,
  (SELECT d.provider FROM bin_events d
    WHERE d.event_type = 'DISPATCH_SENT' AND d.bin_id = e.bin_id AND d.at <= e.at
    ORDER BY d.at DESC LIMIT 1),
  '(none)')`;

/** The attribution facts of every orchestration and project named, read in batches. */
async function attributionFacts(orchestrationIds: readonly string[], projectIds: readonly string[]): Promise<{ byOrchestration: Map<string, PurposeFacts>; byProject: Map<string, PurposeFacts> }> {
  const db = getDb();
  const projects = await inChunks(projectIds, (c, m) => db.all<{ id: string; slug: string; purpose: string | null }>(`SELECT id, slug, purpose FROM projects WHERE id IN (${m})`, c));
  const byProject = new Map(projects.map((p) => [p.id, { projectSlug: p.slug, projectPurpose: p.purpose } as PurposeFacts]));
  const orchestrations = await inChunks(orchestrationIds, (c, m) =>
    db.all<{ id: string; goal_id: string | null; project_id: string; slug: string | null; purpose: string | null }>(
      `SELECT o.id, o.goal_id, o.project_id, p.slug, p.purpose FROM research_orchestrations o LEFT JOIN projects p ON p.id = o.project_id WHERE o.id IN (${m})`, c));
  const missions = await inChunks(orchestrationIds, (c, m) =>
    db.all<{ orchestration_id: string; candidate_id: string | null; goal_id: string | null }>(`SELECT orchestration_id, candidate_id, goal_id FROM russell_missions WHERE orchestration_id IN (${m})`, c));
  const candidates = missions.map((one) => one.candidate_id).filter((one): one is string => !!one);
  const rounds = await inChunks(candidates, (c, m) => db.all<{ candidate_id: string; bucket_id: string }>(`SELECT candidate_id, bucket_id FROM cash_discovery_rounds WHERE candidate_id IN (${m})`, c));
  const aboutDirect = await inChunks(candidates, (c, m) => db.all<{ candidate_id: string; id: string }>(`SELECT candidate_id, id FROM cash_opportunities WHERE candidate_id IN (${m})`, c));
  const aboutNeed = await inChunks(candidates, (c, m) => db.all<{ candidate_id: string; id: string | null }>(`SELECT candidate_id, opportunity_id AS id FROM cash_needs WHERE opportunity_id IS NOT NULL AND candidate_id IN (${m})`, c));
  const openingIds = [...aboutDirect, ...aboutNeed].map((one) => one.id).filter((one): one is string => !!one);
  const paid = new Set((await inChunks(openingIds, (c, m) => db.all<{ id: string }>(`SELECT DISTINCT opportunity_id AS id FROM cash_money_entries WHERE kind = 'CUSTOMER_PAYMENT' AND opportunity_id IN (${m})`, c))).map((one) => one.id));
  const goalIds = [...orchestrations.map((o) => o.goal_id), ...missions.map((one) => one.goal_id)].filter((one): one is string => !!one);
  const goals = new Map((await inChunks(goalIds, (c, m) => db.all<{ id: string; target_set_at: string | null; target_amount_cents: number | null }>(`SELECT id, target_set_at, target_amount_cents FROM workstreams WHERE id IN (${m})`, c))).map((g) => [g.id, g.target_amount_cents !== null && g.target_amount_cents !== undefined]));
  const byOrchestration = new Map<string, PurposeFacts>();
  for (const o of orchestrations) {
    const mine = missions.filter((one) => one.orchestration_id === o.id);
    const cands = new Set(mine.map((one) => one.candidate_id).filter(Boolean));
    const openings = [...aboutDirect, ...aboutNeed].filter((one) => cands.has(one.candidate_id) && one.id).map((one) => one.id!);
    const goalId = o.goal_id ?? mine.find((one) => one.goal_id)?.goal_id ?? null;
    byOrchestration.set(o.id, {
      projectSlug: o.slug,
      projectPurpose: o.purpose,
      goalId,
      ...(goalId ? { goalHasTarget: goals.get(goalId) ?? false } : {}),
      buckets: rounds.filter((r) => cands.has(r.candidate_id)).map((r) => r.bucket_id),
      aboutOpening: openings.length > 0,
      openingPaid: openings.some((id) => paid.has(id)),
    });
  }
  return { byOrchestration, byProject };
}

/**
 * The purposes each bin serves, from the same rows and the same rules a job's
 * attribution uses (`attributePurposes`): the bin's recorded purpose, its
 * project, and what its research orchestration was asked for. A bin nothing
 * attributes is UNATTRIBUTED. Reads only.
 */
export async function purposesOfBins(bins: readonly { id: string; orchestrationId: string | null; projectId: string; purpose?: string | null }[]): Promise<Map<string, PurposeKey[]>> {
  const facts = await attributionFacts(
    bins.map((b) => b.orchestrationId).filter((one): one is string => !!one),
    bins.map((b) => b.projectId),
  );
  const out = new Map<string, PurposeKey[]>();
  for (const b of bins) {
    const attribution = attributePurposes({
      ...facts.byProject.get(b.projectId),
      ...(b.orchestrationId ? facts.byOrchestration.get(b.orchestrationId) : undefined),
      binPurpose: b.purpose ?? null,
    });
    out.set(b.id, attribution.purposes);
  }
  return out;
}

/**
 * Research yield over one window, total, per lane and per purpose, from the
 * rows the work wrote. See `summarizeResearchYield` for the folding rules.
 */
export async function researchYieldByPurpose(input: { since: string; until?: string }): Promise<ResearchYieldReading> {
  const db = getDb();
  const since = input.since;
  const until = input.until ?? new Date().toISOString();
  const untilMs = Date.parse(until);
  const laneRows = await db.all<{ id: string; at: string; ms: number | string | null; reason: string | null; outcome: string | null; eo: string | null; wo: string | null; fragment_id: string | null; queued_at: string | null; project_id: string | null; wp: string | null; bp: string | null }>(
    `SELECT e.id, e.at, e.duration_ms AS ms, e.reason, e.outcome, e.orchestration_id AS eo, w.orchestration_id AS wo, w.fragment_id,
            w.created_at AS queued_at, e.project_id, w.project_id AS wp, b.purpose AS bp
       FROM bin_events e LEFT JOIN work_items w ON w.id = e.work_item_id LEFT JOIN bins b ON b.id = w.bin_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND e.at < ?`,
    [since, until],
  );
  const binRows = await db.all<{ id: string; at: string; bin_id: string | null; provider: string | null; orchestration_id: string | null; project_id: string | null; purpose: string | null; ready_at: string | null; created_at: string | null; state: string | null }>(
    `SELECT e.id, e.at, e.bin_id, ${DISPATCH_PROVIDER} AS provider, b.orchestration_id, b.project_id, b.purpose, b.ready_at, b.created_at, b.state
       FROM bin_events e LEFT JOIN bins b ON b.id = e.bin_id
      WHERE e.event_type = 'BIN_ASSIGNED' AND e.at >= ? AND e.at < ?`,
    [since, until],
  );
  const closes = await inChunks(binRows.map((one) => one.bin_id ?? ''), (c, m) =>
    db.all<{ bin_id: string; event_type: string; at: string; reason: string | null }>(
      `SELECT bin_id, event_type, at, reason FROM bin_events
        WHERE bin_id IN (${m}) AND at >= ? AND event_type IN ('BIN_TERMINAL', 'BIN_RELEASED', 'BIN_LEASE_EXPIRED', 'BIN_TAKEOVER')`,
      [...c, since]));
  const claimRows = await db.all<{ id: string; orchestration_id: string | null; fragment_id: string | null; primary_source: number | string | null; sourced: number | string | null; retrieval_state: string | null }>(
    `SELECT id, orchestration_id, fragment_id, primary_source, sourced, retrieval_state FROM research_claims WHERE accepted = 1 AND created_at >= ? AND created_at < ?`,
    [since, until],
  );
  const packetRows = await db.all<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM research_orchestrations WHERE document_id IS NOT NULL AND completed_at >= ? AND completed_at < ?`,
    [since, until],
  );
  const openingRows = await db.all<{ id: string; project_id: string; mechanism: string | null; orchestration_id: string | null; fragment_id: string | null; payer: string | null; price_cents: number | null; fulfillment_owner: string | null; buying_signal: string | null; offer_scope: string | null; acceptance_condition: string | null; created_at: string }>(
    `SELECT id, project_id, mechanism, orchestration_id, fragment_id, payer, price_cents, fulfillment_owner, buying_signal, offer_scope, acceptance_condition, created_at
       FROM cash_opportunities WHERE duplicate_of_id IS NULL AND created_at >= ? AND created_at < ?`,
    [since, until],
  );
  const priorMechanisms = new Set(
    (await db.all<{ mechanism: string }>(`SELECT DISTINCT mechanism FROM cash_opportunities WHERE duplicate_of_id IS NULL AND mechanism IS NOT NULL AND created_at < ?`, [since])).map((one) => one.mechanism),
  );
  const paymentRows = await db.all<{ id: string; project_id: string; opportunity_id: string | null; orchestration_id: string | null; fragment_id: string | null }>(
    `SELECT m.id, m.project_id, m.opportunity_id, o.orchestration_id, o.fragment_id FROM cash_money_entries m LEFT JOIN cash_opportunities o ON o.id = m.opportunity_id
      WHERE m.kind = 'CUSTOMER_PAYMENT' AND m.created_at >= ? AND m.created_at < ?`,
    [since, until],
  );
  // Which free-lane model answered each fragment an output came from, inside the window or before it.
  const fragmentModel = new Map<string, string>();
  for (const row of laneRows) if (row.fragment_id && row.outcome === 'SUBMITTED') fragmentModel.set(row.fragment_id, modelOfReason(row.reason));
  const outputFragments = [...claimRows, ...openingRows, ...paymentRows].map((one) => one.fragment_id).filter((one): one is string => !!one && !fragmentModel.has(one));
  for (const row of await inChunks(outputFragments, (c, m) =>
    db.all<{ fragment_id: string; reason: string | null }>(
      `SELECT w.fragment_id, e.reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
        WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND w.fragment_id IN (${m})`, c))) {
    fragmentModel.set(row.fragment_id, modelOfReason(row.reason));
  }
  const orchestrationLane = new Map<string, string>();
  for (const row of binRows) if (row.orchestration_id) orchestrationLane.set(row.orchestration_id, `bin:${row.provider ?? '(none)'}`);
  const orchestrationIds = [
    ...laneRows.map((one) => one.wo ?? one.eo), ...binRows.map((one) => one.orchestration_id),
    ...claimRows.map((one) => one.orchestration_id), ...packetRows.map((one) => one.id),
    ...openingRows.map((one) => one.orchestration_id), ...paymentRows.map((one) => one.orchestration_id),
  ].filter((one): one is string => !!one);
  const projectIds = [...laneRows.map((one) => one.wp ?? one.project_id), ...binRows.map((one) => one.project_id)].filter((one): one is string => !!one);
  const facts = await attributionFacts(orchestrationIds, projectIds);
  const factsOf = (orchestrationId: string | null, projectId: string | null, binPurpose: string | null): PurposeFacts => ({
    ...(projectId ? facts.byProject.get(projectId) : undefined),
    ...(orchestrationId ? facts.byOrchestration.get(orchestrationId) : undefined),
    binPurpose,
  });
  const jobs: YieldJob[] = [];
  for (const row of laneRows) {
    const duration = Math.max(0, Number(row.ms ?? 0));
    const start = Date.parse(row.at) - duration;
    const attribution = attributePurposes(factsOf(row.wo ?? row.eo, row.wp ?? row.project_id, row.bp));
    const failed = row.outcome !== 'SUBMITTED';
    jobs.push({
      id: `lane:${row.id}`,
      lane: `free-lane:${modelOfReason(row.reason)}`,
      purposes: attribution.purposes,
      basis: attribution.basis,
      startMs: start,
      durationMs: duration,
      queueWaitMs: row.queued_at ? Math.max(0, start - Date.parse(row.queued_at)) : null,
      outcome: failed ? 'FAILED' : 'COMPLETED',
      failureCause: failed ? failureClass(row.reason) : null,
      rateLimited: failed && isRateLimited(row.reason),
      // The free lane runs on capacity Brain already holds; no row records a per-item charge.
      costMinor: null,
    });
  }
  for (const row of binRows) {
    const at = Date.parse(row.at);
    const close = closes.filter((one) => one.bin_id === row.bin_id && Date.parse(one.at) > at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    const end = close ? Date.parse(close.at) : row.state === 'LEASED' ? untilMs : at;
    const completed = close?.event_type === 'BIN_TERMINAL' && row.state === 'COMPLETE';
    const reason = close ? (close.event_type === 'BIN_TERMINAL' ? `terminal ${row.state ?? ''}`.trim() : close.event_type.replace('BIN_', '').toLowerCase().replace('_', ' ')) : null;
    const attribution = attributePurposes(factsOf(row.orchestration_id, row.project_id, row.purpose));
    const queuedFrom = row.ready_at ?? row.created_at;
    jobs.push({
      id: `bin:${row.id}`,
      lane: `bin:${row.provider ?? '(none)'}`,
      purposes: attribution.purposes,
      basis: attribution.basis,
      startMs: at,
      durationMs: Math.max(0, end - at),
      queueWaitMs: queuedFrom ? Math.max(0, at - Date.parse(queuedFrom)) : null,
      outcome: !close ? 'IN_FLIGHT' : completed ? 'COMPLETED' : 'FAILED',
      failureCause: close && !completed ? reason : null,
      rateLimited: !!close && !completed && isRateLimited(close.reason),
      costMinor: null,
    });
  }
  const laneOf = (fragmentId: string | null, orchestrationId: string | null): string => {
    if (fragmentId && fragmentModel.has(fragmentId)) return `free-lane:${fragmentModel.get(fragmentId)}`;
    if (orchestrationId && orchestrationLane.has(orchestrationId)) return orchestrationLane.get(orchestrationId)!;
    return '(no job on record)';
  };
  const purposesOf = (orchestrationId: string | null, projectId: string | null, extra?: ResearchPurpose): PurposeKey[] => {
    const found = attributePurposes(factsOf(orchestrationId, projectId, null)).purposes.filter((p) => p !== 'UNATTRIBUTED');
    if (extra && !found.includes(extra)) found.push(extra);
    return found.length > 0 ? found : ['UNATTRIBUTED'];
  };
  const outputs: YieldOutput[] = [];
  for (const row of claimRows) {
    const source: YieldOutput['source'] = Number(row.sourced ?? 0) !== 1 || (row.retrieval_state ?? 'RETRIEVED') !== 'RETRIEVED' ? 'UNRETRIEVED' : Number(row.primary_source ?? 0) === 1 ? 'PRIMARY' : 'SECONDARY';
    outputs.push({ kind: 'ACCEPTED_CLAIM', id: row.id, lane: laneOf(row.fragment_id, row.orchestration_id), purposes: purposesOf(row.orchestration_id, null), source });
  }
  for (const row of packetRows) outputs.push({ kind: 'PACKET_FILED', id: row.id, lane: laneOf(null, row.id), purposes: purposesOf(row.id, row.project_id) });
  const newMechanism = new Set<string>();
  for (const row of [...openingRows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const lane = laneOf(row.fragment_id, row.orchestration_id);
    const served = purposesOf(row.orchestration_id, row.project_id);
    if (row.mechanism && !priorMechanisms.has(row.mechanism) && !newMechanism.has(row.mechanism)) {
      newMechanism.add(row.mechanism);
      outputs.push({ kind: 'NEW_MECHANISM', id: row.mechanism, lane, purposes: served });
    }
    if (row.payer && row.price_cents !== null && row.fulfillment_owner && row.buying_signal) outputs.push({ kind: 'QUALIFIED_POSITION', id: row.id, lane, purposes: served });
    if (row.offer_scope && row.acceptance_condition && row.price_cents !== null) outputs.push({ kind: 'EXECUTABLE_OFFER', id: row.id, lane, purposes: served });
  }
  // A verified customer payment is a business operating: it always serves OPERATING_SUPPORT, beside whatever found it.
  for (const row of paymentRows) outputs.push({ kind: 'PAID_TRANSACTION', id: row.id, lane: laneOf(row.fragment_id, row.orchestration_id), purposes: purposesOf(row.orchestration_id, row.project_id, 'OPERATING_SUPPORT') });
  return summarizeResearchYield({ since, until, jobs, outputs });
}

/** The same reading over each of the TEL-07-1 windows ending at `until`. */
export async function researchYieldWindows(until = new Date().toISOString()): Promise<Record<(typeof RESEARCH_YIELD_WINDOWS)[number]['key'], ResearchYieldReading>> {
  const end = Date.parse(until);
  const out = {} as Record<(typeof RESEARCH_YIELD_WINDOWS)[number]['key'], ResearchYieldReading>;
  for (const w of RESEARCH_YIELD_WINDOWS) out[w.key] = await researchYieldByPurpose({ since: new Date(end - w.ms).toISOString(), until });
  return out;
}
