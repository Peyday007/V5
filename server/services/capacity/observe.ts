/**
 * What actually happened, read from the rows Brain already wrote.
 *
 * ---------------------------------------------------------------------------
 * Why this is the impure half and `envelope.ts` is the pure one
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/router.ts` draws this line and says why: a decision has to
 * be answerable afterwards from a recorded input rather than from a re-run
 * against a database that has since moved. A capacity conclusion has the same
 * requirement and more of it — "why did Brain believe six was safe" is asked
 * weeks later, by which time the ledger holds a different answer. So this module
 * goes and gets the numbers, once, and everything that reasons about them is a
 * pure function over the result.
 *
 * ---------------------------------------------------------------------------
 * Overlap is computed, never counted
 * ---------------------------------------------------------------------------
 *
 * The tempting reading of "how many ran at once" is a count of activations in a
 * window, and it is wrong in a way that always overstates. Step 10's rung 20
 * finished twenty bins from thirteen activations because a worker that finishes
 * one asks for another, so activations in an hour is a count of *starts* and not
 * of simultaneity. §27 already states the rule for the factory —
 * `maxObservedConcurrency` is the true maximum overlap of real session intervals,
 * and the sum of declared concurrency is a projection that is never reported as
 * throughput.
 *
 * So a session becomes an interval with a real start and a real end, and the
 * maximum overlap is found by a sweep. An interval with no observed end is
 * **dropped rather than extended to now**: assuming a session is still running
 * because nothing recorded it stopping is the unknown-as-favourable-assumption
 * invariant 39 forbids, and here the favourable direction is the one that
 * inflates the headline number.
 *
 * ---------------------------------------------------------------------------
 * Nothing here decides anything
 * ---------------------------------------------------------------------------
 *
 * No fire, no enqueue, no claim, no policy write, no registration. Reading this
 * is safe from any surface, and `tests/capacityKernel.test.ts` asserts it against
 * the queue, the bins and the fire counters rather than trusting this paragraph.
 */
import { getDb } from '../../db/database.ts';
import { listAccounts, listRoutines, currentPolicy, effectiveTarget } from '../../repos/fleet.ts';
import { nowIso } from '../../repos/util.ts';
import type { FleetAccount, FleetRoutine } from '../../domain/types.ts';

/**
 * One session's run, as Brain observed it.
 *
 * `endedAt` is null when nothing recorded the session stopping. Such an interval
 * contributes to no overlap figure at all — see the header.
 */
export interface SessionInterval {
  sessionRef: string;
  accountId: string | null;
  routineId: string | null;
  binId: string | null;
  workloadClass: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Did the bin this session worked reach an accepted completion? */
  productive: boolean;
}

/** A fire Brain made, and what the provider did with it. */
export interface FireObservation {
  binId: string;
  accountId: string | null;
  routineId: string | null;
  at: string;
  /** SENT means the provider accepted it. Anything else it did not. */
  accepted: boolean;
}

/** Where in its life a bin currently is. The input to the bottleneck classifier. */
export interface StageCounts {
  /** Dispatchable and no intent has been sent at the current generation. */
  readyNotFired: number;
  /** An intent was sent and no session has arrived for it. */
  firedNotArrived: number;
  /** A session arrived and holds a live lease. */
  leasedLive: number;
  /** A lease lapsed with work still outstanding. */
  leasedExpired: number;
  /** Terminal and accepted. */
  completed: number;
  /** Parked on a person. */
  needsHuman: number;
  /** Terminal and not accepted. */
  failed: number;
  /** Intents held back by a routing refusal, by refusal name. */
  deferredByRefusal: Record<string, number>;
}

export interface LatencySample {
  /** Milliseconds. */
  ms: number;
  binId: string;
  eventId: string;
}

/** The measured stages of one bin's life, aggregated. */
export interface LatencyBand {
  samples: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

export interface CapacityObservation {
  takenAt: string;
  /** The window these measurements are over, in hours. */
  windowHours: number;
  scope: { accountId: string | null; workloadClass: string | null };

  accounts: FleetAccount[];
  routines: FleetRoutine[];
  /** Routines the router would consider this instant, by id. */
  eligibleRoutineIds: string[];
  /** Routines registered but with no deployed secret. */
  missingSecretRoutineIds: string[];
  /** The fleet concurrency target in force, or null when nobody set one. */
  fleetTarget: number | null;
  fleetPolicyVersion: number | null;

  sessions: SessionInterval[];
  fires: FireObservation[];
  stages: StageCounts;

  /** Provider refusals in the window, with their ledger ids. */
  providerRefusals: { eventId: string; at: string; accountId: string | null; routineId: string | null; retryAfterMs: number | null; reason: string | null }[];

  /** Distinct bins that reached an accepted completion in the window. */
  validatedCompletions: { binId: string; at: string; eventId: string }[];
  /** Completion attempts Brain refused, which is retry amplification's numerator. */
  completionRefusals: number;
  /** Bins taken over from an expired lease, which is recovery amplification. */
  takeovers: number;
  /** Bin attempts credited, which is the denominator of attempts-per-completion. */
  attemptsCredited: number;

  latencies: {
    /** Bin became READY → Brain sent a fire. */
    readyToFired: LatencyBand;
    /** Fire sent → a session arrived and was assigned. */
    firedToArrived: LatencyBand;
    /** Assigned → first recorded progress on it. */
    arrivedToFirstProgress: LatencyBand;
    /** Assigned → accepted completion. */
    arrivedToCompleted: LatencyBand;
    /** Became READY → accepted completion. */
    endToEnd: LatencyBand;
  };

  /** Fields the ledger could not answer, named rather than defaulted to zero. */
  missing: string[];
}

/** Default measurement window. A day, so a diurnal fleet is not read at its trough. */
export const DEFAULT_WINDOW_HOURS = 24;

/**
 * Take one reading.
 *
 * `windowHours` bounds every *rate* and *latency*, and deliberately does not
 * bound the overlap search: a concurrency level demonstrated last week is still
 * demonstrated, and narrowing the window would make an established floor
 * disappear because nothing happened today. Staleness is decided by the claim's
 * own recorded conditions rather than by cropping the evidence.
 */
export async function observeCapacity(
  options: {
    windowHours?: number;
    accountId?: string | null;
    workloadClass?: string | null;
    now?: string;
  } = {},
): Promise<CapacityObservation> {
  const now = options.now ?? nowIso();
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const since = new Date(new Date(now).getTime() - windowHours * 3_600_000).toISOString();
  const accountId = options.accountId ?? null;
  const workloadClass = options.workloadClass ?? null;
  const missing: string[] = [];

  const [accounts, routines, fleetPolicy] = await Promise.all([
    listAccounts(),
    listRoutines(),
    currentPolicy('FLEET', null),
  ]);

  /*
   * The router's own answer to "which surfaces could take work", imported lazily.
   *
   * Lazily because `candidates.ts` reaches into `fire.ts` for the deployment
   * secret, and a module-level import would make every reader of this file
   * depend on the fire configuration being loadable. The kernel is a *reader*
   * first; it must be possible to take a capacity reading on a Brain whose
   * trigger is not configured at all, and report that as the fact it is.
   */
  let eligibleRoutineIds: string[] = [];
  let missingSecretRoutineIds: string[] = [];
  try {
    const { fleetSnapshot } = await import('../dispatch/candidates.ts');
    const snapshot = await fleetSnapshot(new Date(now));
    eligibleRoutineIds = snapshot.candidates.map((one) => one.routine.id);
    missingSecretRoutineIds = snapshot.missingSecrets.map((one) => one.routineId);
  } catch {
    missing.push('the router snapshot could not be read, so eligibility is unknown rather than zero');
  }

  const sessions = await readSessionIntervals({ since, accountId, workloadClass });
  const fires = await readFires({ since, accountId });
  const stages = await readStages({ now });
  const providerRefusals = await readProviderRefusals({ since, accountId });
  const validatedCompletions = await readValidatedCompletions({ since, workloadClass });
  const counters = await readCounters({ since });
  const latencies = await readLatencies({ since });

  if (sessions.length === 0) {
    missing.push('no authenticated session arrival is recorded in the window, so no overlap can be measured from it');
  }
  if (validatedCompletions.length === 0) {
    missing.push('no accepted completion is recorded in the window, so useful throughput is unknown rather than zero');
  }

  return {
    takenAt: now,
    windowHours,
    scope: { accountId, workloadClass },
    accounts,
    routines,
    eligibleRoutineIds,
    missingSecretRoutineIds,
    fleetTarget: fleetPolicy ? effectiveTarget(fleetPolicy, now).target : null,
    fleetPolicyVersion: fleetPolicy?.version ?? null,
    sessions,
    fires,
    stages,
    providerRefusals,
    validatedCompletions,
    completionRefusals: counters.completionRefusals,
    takeovers: counters.takeovers,
    attemptsCredited: counters.attemptsCredited,
    latencies,
    missing,
  };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every session that ran, with its real start and its real end.
 *
 * The start is `worker_sessions.observed_at`, which is written at arrival **from
 * the dispatch row Brain sent** — never from anything the worker said about
 * itself. That is what makes the account and Routine on it Brain's own
 * attribution rather than a claim, which §23 and §27 both require and which is
 * the whole reason a capacity number keyed on an account means anything.
 *
 * The end is the last event Brain recorded for that session on that bin. A
 * session with no such event has no end, and an interval with no end is dropped
 * by the overlap sweep rather than extended to now.
 *
 * `productive` is whether the bin reached `COMPLETE` — the bin's own state rather
 * than a count of completion events, because a duplicate callback appends
 * another event and cannot move a state that is already terminal. That is how
 * "duplicate callbacks cannot inflate throughput" is a property of the query
 * rather than a rule somebody remembers.
 */
async function readSessionIntervals(input: {
  since: string;
  accountId: string | null;
  workloadClass: string | null;
}): Promise<SessionInterval[]> {
  const params: (string | number)[] = [input.since];
  let accountFilter = '';
  if (input.accountId) {
    accountFilter = ' AND s.account_id = ?';
    params.push(input.accountId);
  }
  let classFilter = '';
  if (input.workloadClass) {
    classFilter = ' AND b.workload_class = ?';
    params.push(input.workloadClass);
  }

  const rows = await getDb().all<{
    session_ref: string;
    account_id: string | null;
    routine_id: string | null;
    bin_id: string;
    workload_class: string | null;
    started_at: string;
    ended_at: string | null;
    bin_state: string;
  }>(
    `SELECT s.session_ref   AS session_ref,
            s.account_id    AS account_id,
            s.routine_id    AS routine_id,
            s.bin_id        AS bin_id,
            b.workload_class AS workload_class,
            s.observed_at   AS started_at,
            (SELECT MAX(e.at) FROM bin_events e
              WHERE e.bin_id = s.bin_id AND e.session_ref = s.session_ref) AS ended_at,
            b.state         AS bin_state
       FROM worker_sessions s
       JOIN bins b ON b.id = s.bin_id
      WHERE s.observed_at >= ?${accountFilter}${classFilter}
      ORDER BY s.observed_at`,
    params,
  );

  return rows.map((row) => ({
    sessionRef: row.session_ref,
    accountId: row.account_id,
    routineId: row.routine_id,
    binId: row.bin_id,
    workloadClass: row.workload_class,
    startedAt: row.started_at,
    /*
     * An end that is not after the start is not an end.
     *
     * `MAX(at)` over a session's events can equal `observed_at` when the only
     * event is the arrival itself, and a zero-length interval overlaps nothing —
     * so treating it as an end would silently drop a session that is genuinely
     * still running from the *denominator* while keeping it in the numerator of
     * nothing. Null is the honest answer: Brain has not observed this session
     * stopping.
     */
    endedAt: row.ended_at && row.ended_at > row.started_at ? row.ended_at : null,
    productive: row.bin_state === 'COMPLETE',
  }));
}

/* -------------------------------------------------------------------------- */
/* Fires                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every activation Brain attempted, and whether the provider took it.
 *
 * From `bin_dispatch` rather than from `bin_events`, because the dispatch row is
 * the one thing that exists for *both* halves: an intent Brain claimed and then
 * failed to send has a row with `state <> 'SENT'`, and counting only the ledger's
 * `DISPATCH_SENT` events would make offered concurrency equal admitted
 * concurrency by construction — which is the distinction the mandate is most
 * insistent about not collapsing.
 */
async function readFires(input: { since: string; accountId: string | null }): Promise<FireObservation[]> {
  const params: (string | number)[] = [input.since, input.since];
  let accountFilter = '';
  if (input.accountId) {
    accountFilter = ' AND r.account_id = ?';
    params.push(input.accountId);
  }
  /*
   * The account comes from `fleet_routines`, because `bin_dispatch` has no such
   * column — 026 added `routine_id` and deliberately stopped there, on the
   * reasoning that a report can join to the account rather than duplicate it.
   * That reasoning is right and it is worth naming why: the account a Routine
   * belongs to is one fact with one owner, and a copy on every dispatch row is
   * the second master §30 refuses for a balance and §31 for a finding. A LEFT
   * JOIN, so a dispatch whose Routine row has since been deleted still counts as
   * an offered fire with an unknown account rather than vanishing from the
   * numerator.
   */
  const rows = await getDb().all<{
    bin_id: string;
    account_id: string | null;
    routine_id: string | null;
    at: string;
    state: string;
  }>(
    `SELECT d.bin_id AS bin_id, r.account_id AS account_id, d.routine_id AS routine_id,
            COALESCE(d.sent_at, d.updated_at) AS at, d.state AS state
       FROM bin_dispatch d
       LEFT JOIN fleet_routines r ON r.id = d.routine_id
      WHERE (d.sent_at >= ? OR d.updated_at >= ?)${accountFilter}
      ORDER BY COALESCE(d.sent_at, d.updated_at)`,
    params,
  );
  return rows.map((row) => ({
    binId: row.bin_id,
    accountId: row.account_id,
    routineId: row.routine_id,
    at: row.at,
    accepted: row.state === 'SENT',
  }));
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where the work currently is, by stage.
 *
 * A snapshot rather than a window, because the bottleneck question is about now:
 * "eligible but not leased" is a scheduler problem *while it is true*, and an
 * hour-old instance of it is history. The refusal breakdown comes from the
 * dispatch rows' own `last_error_kind`, which the loop writes when it defers.
 */
async function readStages(input: { now: string }): Promise<StageCounts> {
  const db = getDb();
  const row = await db.get<{
    ready_not_fired: number;
    fired_not_arrived: number;
    leased_live: number;
    leased_expired: number;
    completed: number;
    needs_human: number;
    failed: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM bins b
         WHERE b.state = 'READY'
           AND NOT EXISTS (SELECT 1 FROM bin_dispatch d
                            WHERE d.bin_id = b.id AND d.state = 'SENT'
                              AND d.lease_generation = b.lease_generation)) AS ready_not_fired,
       (SELECT COUNT(*) FROM bins b
         WHERE b.state = 'READY'
           AND EXISTS (SELECT 1 FROM bin_dispatch d
                        WHERE d.bin_id = b.id AND d.state = 'SENT'
                          AND d.lease_generation = b.lease_generation)) AS fired_not_arrived,
       (SELECT COUNT(*) FROM bins WHERE state = 'LEASED' AND lease_expires_at > ?) AS leased_live,
       (SELECT COUNT(*) FROM bins WHERE state = 'LEASED' AND lease_expires_at <= ?) AS leased_expired,
       (SELECT COUNT(*) FROM bins WHERE state = 'COMPLETE') AS completed,
       (SELECT COUNT(*) FROM bins WHERE state = 'NEEDS_HUMAN') AS needs_human,
       (SELECT COUNT(*) FROM bins WHERE state = 'FAILED') AS failed`,
    [input.now, input.now],
  );

  const refusals = await db.all<{ kind: string | null; n: number }>(
    `SELECT last_error_kind AS kind, COUNT(*) AS n
       FROM bin_dispatch
      WHERE state = 'PENDING' AND last_error_kind IS NOT NULL
      GROUP BY last_error_kind`,
    [],
  );
  const deferredByRefusal: Record<string, number> = {};
  for (const one of refusals) {
    if (one.kind) deferredByRefusal[one.kind] = Number(one.n);
  }

  return {
    readyNotFired: Number(row?.ready_not_fired ?? 0),
    firedNotArrived: Number(row?.fired_not_arrived ?? 0),
    leasedLive: Number(row?.leased_live ?? 0),
    leasedExpired: Number(row?.leased_expired ?? 0),
    completed: Number(row?.completed ?? 0),
    needsHuman: Number(row?.needs_human ?? 0),
    failed: Number(row?.failed ?? 0),
    deferredByRefusal,
  };
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Provider refusals, which are the only source of a `PROVIDER_ENFORCED` claim.
 *
 * `recordAllowanceObservation` writes these and classifies them at the moment
 * they are observed, because the provider refusing is the one capacity fact
 * nothing Brain infers may overwrite. Read by `evidence_class` rather than by
 * event type, so a refusal recorded by some other path with the same
 * classification is found and one merely *named* like an allowance event is not.
 */
async function readProviderRefusals(input: { since: string; accountId: string | null }) {
  const params: (string | number)[] = [input.since];
  let accountFilter = '';
  if (input.accountId) {
    accountFilter = ' AND account_id = ?';
    params.push(input.accountId);
  }
  const rows = await getDb().all<{
    id: string;
    at: string;
    account_id: string | null;
    routine_id: string | null;
    measures: string;
    reason: string | null;
  }>(
    `SELECT id, at, account_id, routine_id, measures, reason
       FROM bin_events
      WHERE evidence_class = 'PROVIDER_ENFORCED' AND at >= ?${accountFilter}
      ORDER BY at`,
    params,
  );
  return rows.map((row) => {
    let retryAfterMs: number | null = null;
    try {
      const parsed = JSON.parse(row.measures) as { retryAfterMs?: unknown };
      if (typeof parsed.retryAfterMs === 'number') retryAfterMs = parsed.retryAfterMs;
    } catch {
      /* A measures bag that will not parse contributes no number rather than a zero. */
    }
    return {
      eventId: row.id,
      at: row.at,
      accountId: row.account_id,
      routineId: row.routine_id,
      retryAfterMs,
      reason: row.reason,
    };
  });
}

/**
 * Distinct bins whose completion Brain accepted.
 *
 * `DISTINCT bin_id` is the whole defence against a duplicate callback inflating
 * throughput: `BIN_COMPLETION_ACCEPTED` is an append-only event and a redelivery
 * appends another one, so counting rows would count the redelivery as a second
 * unit of useful work. A bin is one piece of work however many times its
 * acceptance was recorded.
 */
async function readValidatedCompletions(input: { since: string; workloadClass: string | null }) {
  const params: (string | number)[] = [input.since];
  let classFilter = '';
  if (input.workloadClass) {
    classFilter = ' AND b.workload_class = ?';
    params.push(input.workloadClass);
  }
  const rows = await getDb().all<{ bin_id: string; at: string; event_id: string }>(
    `SELECT e.bin_id AS bin_id, MIN(e.at) AS at, MIN(e.id) AS event_id
       FROM bin_events e
       JOIN bins b ON b.id = e.bin_id
      WHERE e.event_type = 'BIN_COMPLETION_ACCEPTED' AND e.at >= ?${classFilter}
        AND e.bin_id IS NOT NULL
      GROUP BY e.bin_id
      ORDER BY MIN(e.at)`,
    params,
  );
  return rows.map((row) => ({ binId: row.bin_id, at: row.at, eventId: row.event_id }));
}

/** The three counters that make retry amplification readable. */
async function readCounters(input: { since: string }) {
  const row = await getDb().get<{
    completion_refusals: number;
    takeovers: number;
    attempts: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM bin_events WHERE event_type = 'BIN_COMPLETION_REFUSED' AND at >= ?) AS completion_refusals,
       (SELECT COUNT(*) FROM bin_events WHERE event_type = 'BIN_TAKEOVER' AND at >= ?) AS takeovers,
       (SELECT COUNT(*) FROM bin_events WHERE event_type = 'BIN_ATTEMPT_CREDITED' AND at >= ?) AS attempts`,
    [input.since, input.since, input.since],
  );
  return {
    completionRefusals: Number(row?.completion_refusals ?? 0),
    takeovers: Number(row?.takeovers ?? 0),
    attemptsCredited: Number(row?.attempts ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Latency                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY_BAND: LatencyBand = { samples: 0, p50: null, p90: null, p95: null };

/**
 * The five stage latencies, each from a pair of events on the same bin.
 *
 * Every one is a difference between two timestamps Brain wrote. Nothing here
 * consults a clock to decide what happened, which is `explainSlowness`'s own rule
 * and the reason it is worth having at all: a latency derived partly from `now`
 * grows while nobody is looking and is unfalsifiable afterwards.
 */
async function readLatencies(input: { since: string }): Promise<CapacityObservation['latencies']> {
  const [readyToFired, firedToArrived, arrivedToFirstProgress, arrivedToCompleted, endToEnd] =
    await Promise.all([
      band(input.since, 'BIN_READY', 'DISPATCH_SENT'),
      band(input.since, 'DISPATCH_SENT', 'BIN_ASSIGNED'),
      band(input.since, 'BIN_ASSIGNED', 'BIN_ITEM_CLAIMED'),
      band(input.since, 'BIN_ASSIGNED', 'BIN_COMPLETION_ACCEPTED'),
      band(input.since, 'BIN_READY', 'BIN_COMPLETION_ACCEPTED'),
    ]);
  return { readyToFired, firedToArrived, arrivedToFirstProgress, arrivedToCompleted, endToEnd };
}

/**
 * The gap between the first `from` and the first `to` after it, per bin.
 *
 * `MIN` on both ends deliberately. A bin that is re-fired has several
 * `DISPATCH_SENT` rows, and pairing the last of them with the first arrival would
 * produce a negative number; pairing the first with the last would measure the
 * whole retry history as though it were one wait. The first-to-first pair is the
 * one that answers "how long did this stage take the first time it happened",
 * which is what a percentile over many bins is a statement about.
 */
async function band(since: string, from: string, to: string): Promise<LatencyBand> {
  /*
   * The subtraction happens in JavaScript, not in SQL, and that is the one thing
   * about this query worth reviewing.
   *
   * The natural SQLite expression is `(julianday(b) - julianday(a)) * 86400000`.
   * It is also a statement only one of the two backends can say: Postgres has no
   * `julianday`, so it would pass the entire local suite and throw on the
   * database production runs. That has happened three times in this repository
   * already — a missing `seq`, three connect tables, `worker_sessions` — and the
   * convention this file follows instead is the one the repository layer was
   * built for: select the columns, do the arithmetic in one place, and let both
   * dialects say the same statement. Timestamps are ISO-8601 UTC strings by
   * convention, so `Date.parse` is exact on them.
   */
  const rows = await getDb()
    .all<{ from_at: string; to_at: string }>(
      `SELECT f.at AS from_at, t.at AS to_at
       FROM (SELECT bin_id, MIN(at) AS at FROM bin_events
              WHERE event_type = ? AND at >= ? AND bin_id IS NOT NULL GROUP BY bin_id) f
       JOIN (SELECT bin_id, MIN(at) AS at FROM bin_events
              WHERE event_type = ? AND at >= ? AND bin_id IS NOT NULL GROUP BY bin_id) t
         ON t.bin_id = f.bin_id
      WHERE t.at > f.at`,
      [from, since, to, since],
    )
    .catch(() => [] as { from_at: string; to_at: string }[]);
  const values = rows
    .map((row) => Date.parse(row.to_at) - Date.parse(row.from_at))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (values.length === 0) return EMPTY_BAND;
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
  };
}

/**
 * Nearest-rank percentile. Exported so the tests assert the same arithmetic the
 * report prints, rather than a re-implementation that happens to agree.
 */
export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/* -------------------------------------------------------------------------- */
/* Overlap                                                                    */
/* -------------------------------------------------------------------------- */

export interface OverlapReading {
  /** The greatest number of intervals open at one instant. */
  max: number;
  /** When that happened, so the claim resolves to a moment. */
  at: string | null;
  /** The session refs that were open then, so it resolves to rows. */
  sessionRefs: string[];
  /** Intervals that had no observed end and were therefore not counted. */
  droppedUnfinished: number;
}

/**
 * The true maximum overlap of a set of session intervals.
 *
 * A sweep over start and end points. `end` is processed before `start` at the
 * same instant, so two sessions that merely abut — one ending exactly as the next
 * begins — are not reported as two running at once. At second resolution that is
 * a real and common case, and counting it would manufacture concurrency out of a
 * handover.
 *
 * Pure, and exported, because it is the single arithmetic behind the headline
 * number: a claim that six sessions overlapped has to be checkable by handing the
 * same intervals to the same function.
 */
export function maxOverlap(intervals: readonly SessionInterval[]): OverlapReading {
  const usable = intervals.filter((one) => one.endedAt !== null);
  const dropped = intervals.length - usable.length;
  if (usable.length === 0) {
    return { max: 0, at: null, sessionRefs: [], droppedUnfinished: dropped };
  }

  type Point = { at: string; delta: number; sessionRef: string };
  const points: Point[] = [];
  for (const one of usable) {
    points.push({ at: one.startedAt, delta: 1, sessionRef: one.sessionRef });
    points.push({ at: one.endedAt!, delta: -1, sessionRef: one.sessionRef });
  }
  // Ends before starts at the same instant. See the note above.
  points.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at < b.at ? -1 : 1));

  const open = new Set<string>();
  let best = 0;
  let bestAt: string | null = null;
  let bestRefs: string[] = [];
  for (const point of points) {
    if (point.delta === 1) open.add(point.sessionRef);
    else open.delete(point.sessionRef);
    if (open.size > best) {
      best = open.size;
      bestAt = point.at;
      bestRefs = [...open];
    }
  }
  return { max: best, at: bestAt, sessionRefs: bestRefs, droppedUnfinished: dropped };
}

/**
 * Overlap counting only the sessions that produced distinct validated work.
 *
 * Not the same question as `maxOverlap`, and the difference is the point of the
 * whole kernel: five sessions overlapping while one bin completes is one unit of
 * useful work wearing five activations. Reporting the first number as capacity is
 * how a fleet gets scaled on a fiction.
 */
export function maxProductiveOverlap(intervals: readonly SessionInterval[]): OverlapReading {
  return maxOverlap(intervals.filter((one) => one.productive));
}

/**
 * Accepted starts per hour, per account, over the window.
 *
 * A rate rather than a maximum, and reported with its sample count, because a
 * rate from two starts is not a rate. Only accepted fires count: an offered fire
 * the provider refused did not start anything.
 */
export function startRatePerHour(
  fires: readonly FireObservation[],
  windowHours: number,
): { perHour: number | null; accepted: number } {
  const accepted = fires.filter((one) => one.accepted).length;
  if (windowHours <= 0) return { perHour: null, accepted };
  return { perHour: accepted / windowHours, accepted };
}
