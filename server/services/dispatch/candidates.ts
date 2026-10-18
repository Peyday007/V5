/**
 * What the router needs to know, read from rows.
 *
 * Kept apart from `router.ts` on purpose. The router is a pure function so a
 * decision can be replayed and argued with; this is the impure half that goes
 * and gets the numbers. Separating them is what makes "why did this bin go to
 * that account" answerable from a recorded input rather than from a re-run
 * against a database that has since moved.
 */
import { deliveryReadings } from '../../repos/deliveryProofs.ts';
import { getDb, outsideTransaction } from '../../db/database.ts';
import { asWorkload } from '../../db/infra.ts';
import {
  currentPolicies,
  policyKey,
  effectiveTarget,
  listAccounts,
  listRoutines,
} from '../../repos/fleet.ts';
import { resolveToken } from './fire.ts';
import { surfaceIneligibility, type RoutingCandidate } from './router.ts';
import type { FleetAccount, FleetPolicy } from '../../domain/types.ts';
import { getWorker, getWorkerRouting, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { derivedFamiliesFrom } from '../bins/routing.ts';
import { latestAllowanceReports } from '../../repos/allowance.ts';
import { connectorHealthByRoutine } from '../fleet/connectorHealth.ts';
import { sameProviderSession } from '../../domain/sessionRef.ts';

/**
 * How long a sent activation counts as in flight.
 *
 * Not a timeout and not a lease — those belong to the bin. This is only the
 * window in which a fire we made is still plausibly a running session, for the
 * purpose of not starting more than the target allows. Too short and Brain
 * over-fires; too long and it under-fires after a quiet failure. Thirty minutes
 * is longer than every activation Step 10 measured (the longest drained seven
 * bins in 107 seconds) and short enough that a dead session frees its slot
 * within one operator's attention span.
 */
export const IN_FLIGHT_WINDOW_MS = 30 * 60_000;

/**
 * Unproductive session starts per account: the adaptive control that replaced
 * the fixed hourly activation budget.
 *
 * ---------------------------------------------------------------------------
 * Why a fixed budget was the wrong shape
 * ---------------------------------------------------------------------------
 *
 * An account's target bounds how many of its sessions run *at once*; nothing
 * bounded how many were *started*, so a session handed a bin it could not
 * advance ended in a minute and freed its slot for the next — Airyn 2-A was
 * fired 48 times in one hour on 2026-10-12, 558 times in a day for one accepted
 * completion. The first containment was a budget of six starts per slot per
 * hour (twelve with no target), and it stopped the bleeding by refusing
 * everything past a count: a productive account doing real work for six
 * friends' sessions an hour was refused exactly as a broken one was.
 *
 * What was wrong was never the number of starts; it was starts that did
 * nothing. So only those are counted. A start is **productive** when the
 * session it started did any work — claimed an item, submitted a unit result,
 * checkpointed, completed a bin, or finished a research pass in the bin's
 * packet — and **unproductive** when its session never arrived (while other
 * sessions were arriving, so it is not Brain's own outage), or arrived and its
 * lease ended without any of those. A start whose session still holds a live
 * lease, or that is too recent to judge, is **pending** and counts for neither.
 *
 * An account is refused only when its unproductive starts in the last hour
 * reach `UNPRODUCTIVE_STARTS_THRESHOLD`. Productive starts are bounded by the
 * person-set account, Routine and fleet targets and the grant, and by nothing
 * here. The refusal lifts by itself as those starts leave the hour.
 *
 * ---------------------------------------------------------------------------
 * The four things the dispatcher has to tell apart, and where each lives
 * ---------------------------------------------------------------------------
 *
 *   * a productive worker — counted nowhere; more capacity is welcome;
 *   * a worker temporarily unable to complete one assignment — that bin is
 *     deferred (`bin_session_refusals`, the per-bin refire guard) and the worker
 *     is still handed other work;
 *   * a repeated assignment that cannot advance — `workReadySql` refuses to fire
 *     a bin with nothing claimable (`NO_CLAIMABLE_WORK`) and `BIN_REFIRE_GUARD`
 *     cools off a bin fired too often;
 *   * a genuine shortage — `ACCOUNT_TARGETS_REACHED`,
 *     `NO_HEALTHY_EXECUTION_SURFACE`, or the grant full.
 *
 * And the fifth this adds: an account whose sessions keep doing nothing —
 * `ACCOUNT_SESSIONS_UNPRODUCTIVE`. Nothing here starts a session because an
 * earlier one handed work back; it can only refuse.
 */

/**
 * How many unproductive starts in an hour refuse an account.
 *
 * Three, for the same reason the no-show quarantine trips at three: one is an
 * accident, two a coincidence, three a pattern somebody's allowance is paying
 * for. It is not a quarantine — nothing is disabled and no person has to act —
 * so the cost of reading a pattern into three is one hour of not starting that
 * account's sessions, against the cost of not reading it, which was hundreds
 * of activations a day.
 */
export const UNPRODUCTIVE_STARTS_THRESHOLD = 3;

/** The window starts are judged over. */
export const PRODUCTIVITY_WINDOW_MS = 60 * 60_000;

/**
 * How long a fire may go without its session arriving before that silence is
 * judged. Longer than any cold start measured (§20: 35.7s, 28.8s), short enough
 * that a dead surface is read inside the hour.
 */
export const ARRIVAL_SETTLE_MS = 15 * 60_000;

export type StartVerdict =
  | 'PRODUCTIVE'
  /** Its session never arrived while others were arriving. */
  | 'UNPRODUCTIVE_NEVER_ARRIVED'
  /** Its session arrived and ended without doing any work. */
  | 'UNPRODUCTIVE_NO_WORK'
  /** Still working, or too recent to judge. */
  | 'PENDING'
  /** Nothing arrived anywhere in its window: Brain's own outage, charged to nobody. */
  | 'NOT_JUDGED';

/** What one start's verdict is decided from. Every field is read from rows. */
export interface StartFacts {
  sentAtMs: number;
  nowMs: number;
  /** Its own session reached Brain (an arrival or an assignment matched to it). */
  arrived: boolean;
  /** The leases its session took, and what became of each. */
  leases: { productive: boolean; live: boolean }[];
  /** Some session — any session — arrived at Brain within its settle window. */
  brainAnswering: boolean;
}

/** The verdict for one start. Pure and total. */
export function classifyStart(facts: StartFacts): StartVerdict {
  if (facts.leases.some((one) => one.productive)) return 'PRODUCTIVE';
  if (facts.leases.some((one) => one.live)) return 'PENDING';
  if (facts.leases.length > 0) return 'UNPRODUCTIVE_NO_WORK';
  const settled = facts.nowMs - facts.sentAtMs >= ARRIVAL_SETTLE_MS;
  if (facts.arrived) return settled ? 'UNPRODUCTIVE_NO_WORK' : 'PENDING';
  if (!settled) return 'PENDING';
  return facts.brainAnswering ? 'UNPRODUCTIVE_NEVER_ARRIVED' : 'NOT_JUDGED';
}

export interface AccountProductivity {
  productive: number;
  unproductive: number;
  pending: number;
}

const PRODUCTIVE_EVENTS = ['BIN_ITEM_CLAIMED', 'BIN_CHECKPOINT'];

/**
 * How long one reading may be reused. The window it judges is an hour, so a
 * reading a minute old changes no decision, and the dispatch tick runs every
 * ten seconds on a database §61 measured as the shared bottleneck. Off in the
 * test suite (`BRAIN_SHARED_SNAPSHOT_MS=0`), which writes and reads within a
 * second.
 */
function productivityReuseMs(): number {
  const own = process.env['BRAIN_PRODUCTIVITY_REUSE_MS'];
  if (own !== undefined && /^\d+$/.test(own)) return Number(own);
  if (process.env['BRAIN_SHARED_SNAPSHOT_MS'] === '0') return 0;
  return 60_000;
}
let productivityMemo: { at: number; value: Map<string, AccountProductivity> } | null = null;

/** Tests: forget the reading. */
export function resetProductivityCache(): void {
  productivityMemo = null;
}

/**
 * Productive, unproductive and pending starts per account in the last hour.
 *
 * Six bounded reads, each on an index (`bin_dispatch (state, sent_at)`,
 * `bin_events (event_type, at)`, the primary keys of `bins` and
 * `bin_unit_results`, `research_passes (orchestration_id, …)`), then a join in
 * memory. A session is matched to its fire by its provider session id in any
 * of its spellings (`sameProviderSession`); an assignment that reported no
 * session is credited to the fire for its own bin at the generation that fire
 * named, exactly as `creditDispatchArrival` credits arrivals.
 */
export async function productivityByAccount(
  nowMs: number,
  accountOfRoutine: Map<string, string>,
): Promise<Map<string, AccountProductivity>> {
  const reuse = productivityReuseMs();
  if (productivityMemo && reuse > 0 && nowMs >= productivityMemo.at && nowMs - productivityMemo.at < reuse) {
    return productivityMemo.value;
  }
  const value = await readProductivity(nowMs, accountOfRoutine);
  productivityMemo = { at: nowMs, value };
  return value;
}

async function readProductivity(
  nowMs: number,
  accountOfRoutine: Map<string, string>,
): Promise<Map<string, AccountProductivity>> {
  const since = new Date(nowMs - PRODUCTIVITY_WINDOW_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const db = getDb();
  const fires = await db.all<{
    bin_id: string;
    lease_generation: number;
    routine_id: string;
    session_ref: string | null;
    sent_at: string;
  }>(
    `SELECT d.bin_id, d.lease_generation, d.routine_id, d.session_ref, d.sent_at
       FROM bin_dispatch d
      WHERE d.state = 'SENT' AND d.sent_at >= ? AND d.routine_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM connector_recovery_probes p WHERE p.bin_id = d.bin_id)`,
    [since],
  );
  const out = new Map<string, AccountProductivity>();
  if (fires.length === 0) return out;

  const assignments = await db.all<{ bin_id: string; lease_generation: number; session_ref: string | null; at: string }>(
    `SELECT bin_id, lease_generation, session_ref, at FROM bin_events
      WHERE event_type IN ('BIN_ASSIGNED', 'BIN_TAKEOVER') AND at >= ? AND bin_id IS NOT NULL`,
    [since],
  );
  const arrivals = await db.all<{ session_ref: string | null; at: string }>(
    `SELECT session_ref, at FROM bin_events
      WHERE event_type IN ('DISPATCH_SESSION_ARRIVED', 'DISPATCH_WRONG_WORKER') AND at >= ?`,
    [since],
  );
  const worked = await db.all<{ bin_id: string; lease_generation: number | null }>(
    `SELECT bin_id, lease_generation FROM bin_events
      WHERE at >= ? AND bin_id IS NOT NULL
        AND (event_type IN (${PRODUCTIVE_EVENTS.map(() => '?').join(', ')})
             OR (event_type = 'BIN_TERMINAL' AND outcome = 'COMPLETE'))`,
    [since, ...PRODUCTIVE_EVENTS],
  );
  const productive = new Set(worked.map((row) => `${row.bin_id}#${row.lease_generation}`));

  const binIds = [...new Set(assignments.map((row) => row.bin_id))];
  const bins = new Map<string, { state: string; lease_generation: number; lease_expires_at: string | null; orchestration_id: string | null }>();
  for (const chunk of chunks(binIds, 200)) {
    const marks = chunk.map(() => '?').join(', ');
    for (const row of await db.all<{
      id: string;
      state: string;
      lease_generation: number;
      lease_expires_at: string | null;
      orchestration_id: string | null;
    }>(
      `SELECT id, state, lease_generation, lease_expires_at, orchestration_id FROM bins WHERE id IN (${marks})`,
      chunk,
    )) {
      bins.set(row.id, row);
    }
    for (const row of await db.all<{ bin_id: string; lease_generation: number | null }>(
      `SELECT bin_id, lease_generation FROM bin_unit_results WHERE bin_id IN (${marks}) AND created_at >= ?`,
      [...chunk, since],
    )) {
      productive.add(`${row.bin_id}#${row.lease_generation}`);
    }
  }
  // A research pass finished in the packet a leased bin carries, during that lease.
  const orchestrationIds = [...new Set([...bins.values()].map((row) => row.orchestration_id).filter((id): id is string => !!id))];
  const passesByOrchestration = new Map<string, string[]>();
  for (const chunk of chunks(orchestrationIds, 200)) {
    const marks = chunk.map(() => '?').join(', ');
    for (const row of await db.all<{ orchestration_id: string; completed_at: string }>(
      `SELECT orchestration_id, completed_at FROM research_passes
        WHERE orchestration_id IN (${marks}) AND completed_at IS NOT NULL AND completed_at >= ?`,
      [...chunk, since],
    )) {
      passesByOrchestration.set(row.orchestration_id, [
        ...(passesByOrchestration.get(row.orchestration_id) ?? []),
        row.completed_at,
      ]);
    }
  }

  const arrivalTimes = arrivals.map((row) => Date.parse(row.at));
  for (const fire of fires) {
    const account = accountOfRoutine.get(fire.routine_id);
    if (!account) continue;
    const sentAtMs = Date.parse(fire.sent_at);
    // Its own session's assignments: matched by session, or — when the
    // session reported none — the one at the generation after the fire on the
    // bin it was fired for.
    let mine = fire.session_ref
      ? assignments.filter((row) => row.at >= fire.sent_at && sameProviderSession(row.session_ref, fire.session_ref))
      : [];
    if (mine.length === 0) {
      mine = assignments.filter(
        (row) =>
          row.bin_id === fire.bin_id &&
          Number(row.lease_generation) === Number(fire.lease_generation) + 1 &&
          !row.session_ref,
      );
    }
    const leases = mine.map((row) => {
      const bin = bins.get(row.bin_id);
      const generation = Number(row.lease_generation);
      const passes = bin?.orchestration_id ? (passesByOrchestration.get(bin.orchestration_id) ?? []) : [];
      return {
        productive:
          productive.has(`${row.bin_id}#${generation}`) || passes.some((at) => at >= row.at),
        live:
          bin !== undefined &&
          bin.state === 'LEASED' &&
          Number(bin.lease_generation) === generation &&
          (bin.lease_expires_at ?? '') > nowIso,
      };
    });
    const arrived =
      mine.length > 0 ||
      (fire.session_ref !== null &&
        arrivals.some((row) => sameProviderSession(row.session_ref, fire.session_ref)));
    const verdict = classifyStart({
      sentAtMs,
      nowMs,
      arrived,
      leases,
      brainAnswering: arrivalTimes.some((at) => at > sentAtMs && at <= sentAtMs + ARRIVAL_SETTLE_MS),
    });
    const tally = out.get(account) ?? { productive: 0, unproductive: 0, pending: 0 };
    if (verdict === 'PRODUCTIVE') tally.productive += 1;
    else if (verdict === 'UNPRODUCTIVE_NEVER_ARRIVED' || verdict === 'UNPRODUCTIVE_NO_WORK') tally.unproductive += 1;
    else if (verdict === 'PENDING') tally.pending += 1;
    out.set(account, tally);
  }
  return out;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Routines whose sessions recently could not reach the web.
 *
 * A research fragment is blocked with the environment's own words when the
 * session's sandbox refuses the source (`ENOTFOUND`, `EAI_AGAIN`, an egress
 * policy). That is a fact about the surface, not the question: production,
 * 2026-10-17, Airyn 2-A held 45 DNS failures and kept being fired for research,
 * each session ending "No network egress to source hosts (ENOTFOUND)".
 *
 * A Routine with at least `NETWORK_BLOCK_THRESHOLD` such blocks attributed to
 * its sessions inside `NETWORK_BLOCK_WINDOW_MS`, and no accepted fragment in the
 * same window, is not fired for research. It is not quarantined and is still
 * fired for other work; the window is the recovery — once it passes with no new
 * block the Routine is eligible again and its next session tests it, so a
 * repaired environment comes back without anybody remembering to clear it.
 */
export const NETWORK_BLOCK_THRESHOLD = 3;
export const NETWORK_BLOCK_WINDOW_MS = 6 * 60 * 60_000;
const NETWORK_BLOCK_PATTERNS = ['%ENOTFOUND%', '%EAI_AGAIN%', '%getaddrinfo%', '%egress%', '%network polic%'];

/**
 * Read at most every five minutes. The window it judges is six hours, so a
 * fresher answer changes nothing, and the dispatch tick runs every ten seconds
 * on a database §61 measured as the shared bottleneck.
 */
const NETWORK_BLOCK_CACHE_MS = 5 * 60_000;
let networkBlockCache: { at: number; value: Set<string> } | null = null;

export function resetNetworkBlockCache(): void {
  networkBlockCache = null;
}

export async function networkBlockedRoutines(nowMs: number): Promise<Set<string>> {
  if (networkBlockCache && nowMs - networkBlockCache.at >= 0 && nowMs - networkBlockCache.at < NETWORK_BLOCK_CACHE_MS) {
    return networkBlockCache.value;
  }
  const value = await readNetworkBlockedRoutines(nowMs);
  networkBlockCache = { at: nowMs, value };
  return value;
}

async function readNetworkBlockedRoutines(nowMs: number): Promise<Set<string>> {
  const since = new Date(nowMs - NETWORK_BLOCK_WINDOW_MS).toISOString();
  const like = NETWORK_BLOCK_PATTERNS.map(() => 'f.blocked_reason LIKE ?').join(' OR ');
  const routineOf =
    `(SELECT p.executor_routine_id FROM research_passes p WHERE p.fragment_id = f.id` +
    ` AND p.executor_routine_id IS NOT NULL ORDER BY p.started_at DESC LIMIT 1)`;
  const blocked = await getDb().all<{ routine_id: string | null; n: number }>(
    `SELECT routine_id, COUNT(*) AS n FROM (
       SELECT ${routineOf} AS routine_id FROM research_fragments f
        WHERE f.status = 'BLOCKED' AND f.updated_at >= ? AND f.blocked_reason IS NOT NULL AND (${like})
     ) x WHERE routine_id IS NOT NULL GROUP BY routine_id`,
    [since, ...NETWORK_BLOCK_PATTERNS],
  );
  const accepted = await getDb().all<{ routine_id: string | null }>(
    `SELECT DISTINCT routine_id FROM (
       SELECT ${routineOf} AS routine_id FROM research_fragments f
        WHERE f.status = 'ACCEPTED' AND f.accepted_at >= ?
     ) x WHERE routine_id IS NOT NULL`,
    [since],
  );
  const working = new Set(accepted.map((row) => row.routine_id).filter((id): id is string => !!id));
  const out = new Set<string>();
  for (const row of blocked) {
    if (row.routine_id && Number(row.n) >= NETWORK_BLOCK_THRESHOLD && !working.has(row.routine_id)) {
      out.add(row.routine_id);
    }
  }
  return out;
}

export interface FleetSnapshot {
  candidates: RoutingCandidate[];
  fleetPolicy: FleetPolicy | null;
  fleetInFlight: number;
  /** Routines registered but skipped because their secret is not deployed. */
  missingSecrets: { routineId: string; secretName: string }[];
}

/**
 * Activations started and not yet visibly finished, per Routine.
 *
 * Counted from `bin_dispatch` rather than from bins, because the question is
 * "how many sessions did we start" and a session exists from the moment the
 * provider accepted the fire — before any bin is leased, and still while one is
 * being drained. Counting leased bins instead would read zero in the window
 * between firing and check-in, which is exactly when over-firing happens.
 *
 * ---------------------------------------------------------------------------
 * A reservation is not an occupied slot
 * ---------------------------------------------------------------------------
 *
 * This number decides `ACCOUNT_TARGETS_REACHED`, which is what refused the
 * frozen acceptance message five times on 2026-09-04 — so counting a session
 * that is not running is not a rounding error, it is a fleet that refuses work
 * it has room for. Four conditions separate a live activation from a stale
 * reservation, and each is exact rather than a heuristic:
 *
 *   1. **The bin has not gone terminal.** `COMPLETE`, `CANCELLED` and `FAILED`
 *      were already excluded. `NEEDS_HUMAN` is added: it is terminal for the
 *      worker, whose session ended when it escalated, and holding a slot for a
 *      bin that is waiting on a *person* is the clearest stale reservation
 *      there is.
 *
 *   2. **It is the newest fire for its bin.** A bin whose worker never arrived
 *      is re-dispatched at a later generation, and the earlier `SENT` row stays
 *      `SENT` forever — `supersedeStaleIntents` only touches `PENDING` ones,
 *      deliberately, because a fire that really happened must not be rewritten
 *      as though it had not. So the old row was counted beside the new one and
 *      one bin reserved two slots. Note that this is **not** a generation
 *      *match* against the bin: a bin's generation advances the moment a worker
 *      is assigned, so requiring equality would drop the count exactly when a
 *      session starts working, reintroducing the hole the paragraph above
 *      exists to close.
 *
 *   3. **If a worker took it, the lease has not lapsed.** An expired lease is
 *      claimable work everywhere else in this codebase (§19); a session whose
 *      lease Brain has already written off is not occupying a slot.
 *
 *   4. **The fire is recent**, which is `IN_FLIGHT_WINDOW_MS` and was already
 *      here. It is the backstop for everything the first three cannot see.
 *
 * Every one of these can only *lower* the count, so the failure mode this
 * changes is under-firing rather than over-firing — and the targets, the fire
 * slot's compare-and-swap and the provider's own refusals all still bound the
 * other direction.
 */
export async function inFlightByRoutine(nowMs: number): Promise<Map<string, number>> {
  const since = new Date(nowMs - IN_FLIGHT_WINDOW_MS).toISOString();
  const now = new Date(nowMs).toISOString();
  /*
   * Reused while nothing that can *raise* the count has happened (INF-6e).
   *
   * Every fleet read — the tick, Who, People, Build, the alerts — asked this
   * join afresh, and production ran it 85k times at ~58 ms. A count rises only
   * when a new fire is SENT, and the watermark below (the newest SENT fire and
   * how many are inside the window, from the `(state, sent_at)` index) changes
   * the instant one is — so a new activation is never missed. What the reuse
   * can lag is a *fall* — a bin finishing, a lease lapsing — and a stale high
   * count can only under-fire, never fire twice; that lag is bounded by
   * `IN_FLIGHT_REUSE_MS`. The one rise it cannot see — an old fire's bin taken
   * over again inside the window — is bounded by the same interval, and the
   * targets and the fire slot's compare-and-swap still bound the other side.
   */
  const reuseMs = inFlightReuseMs();
  if (reuseMs > 0) {
    const mark = await getDb().get<{ newest: string | null; n: number }>(
      "SELECT MAX(sent_at) AS newest, COUNT(*) AS n FROM bin_dispatch WHERE state = 'SENT' AND sent_at >= ?",
      [since],
    );
    const watermark = `${mark?.newest ?? ''}|${Number(mark?.n ?? 0)}`;
    if (inFlightMemo && inFlightMemo.watermark === watermark && nowMs >= inFlightMemo.at && nowMs - inFlightMemo.at < reuseMs) {
      return new Map(inFlightMemo.counts);
    }
    const counts = await readInFlight(since, now);
    inFlightMemo = { at: nowMs, watermark, counts };
    return new Map(counts);
  }
  return readInFlight(since, now);
}

let inFlightMemo: { at: number; watermark: string; counts: Map<string, number> } | null = null;

/**
 * How long an unchanged in-flight count may be reused. `BRAIN_INFLIGHT_REUSE_MS=0`
 * turns reuse off, and so does `BRAIN_SHARED_SNAPSHOT_MS=0` (the test suite sets
 * it, because a test finishes a bin and reads the fleet back inside a second).
 */
function inFlightReuseMs(): number {
  const own = process.env['BRAIN_INFLIGHT_REUSE_MS'];
  if (own !== undefined && /^\d+$/.test(own)) return Number(own);
  if (process.env['BRAIN_SHARED_SNAPSHOT_MS'] === '0') return 0;
  return 20_000;
}

/** Tests, and a write that knows the count just changed. */
export function forgetInFlight(): void {
  inFlightMemo = null;
}

async function readInFlight(since: string, now: string): Promise<Map<string, number>> {
  const rows = await getDb().all<{ routine_id: string | null; n: number }>(
    `SELECT d.routine_id AS routine_id, COUNT(*) AS n
       FROM bin_dispatch d
       JOIN bins b ON b.id = d.bin_id
      WHERE d.state = 'SENT' AND d.sent_at >= ?
        AND b.state NOT IN ('COMPLETE','CANCELLED','FAILED','NEEDS_HUMAN')
        AND d.lease_generation = (
              SELECT MAX(d2.lease_generation) FROM bin_dispatch d2
               WHERE d2.bin_id = d.bin_id AND d2.state = 'SENT')
        AND (b.state <> 'LEASED' OR b.lease_expires_at > ?)
      GROUP BY d.routine_id`,
    [since, now],
  );
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.routine_id) out.set(row.routine_id, Number(row.n));
  }
  return out;
}

/**
 * How long a snapshot taken for a reader may be handed to the next reader.
 * `BRAIN_SHARED_SNAPSHOT_MS=0` turns sharing off (the test suite does, because
 * a test writes the fleet and reads it back inside a second).
 */
function sharedSnapshotMs(): number {
  const raw = process.env['BRAIN_SHARED_SNAPSHOT_MS'];
  return raw && /^\d+$/.test(raw) ? Number(raw) : 5_000;
}
let shared: { at: number; snapshot: Promise<FleetSnapshot> } | null = null;

/**
 * The fleet as read for a *surface*, shared for a few seconds.
 *
 * One `fleetSnapshot` is of the order of a hundred statements — connector
 * health for every connector reads its token history and its refusals — and the
 * Build page polls it every twenty seconds per open tab, beside Who, People, the
 * goal model and the self-model, each taking its own. Under a slow database that
 * was a browser multiplying the load on the pool the dispatcher and every check-in
 * share. Readers that only *show* the fleet take this one; the dispatch tick,
 * which decides who is fired, still reads its own, fresh. Built outside any
 * caller's transaction and on the workload pool, because it is shared.
 */
export function sharedFleetSnapshot(): Promise<FleetSnapshot> {
  const nowMs = Date.now();
  if (shared && nowMs - shared.at < sharedSnapshotMs()) return shared.snapshot;
  const snapshot = outsideTransaction(() => asWorkload(() => fleetSnapshot(new Date(nowMs))));
  shared = { at: nowMs, snapshot };
  // A failed read is not kept: the next reader asks again.
  snapshot.catch(() => {
    if (shared?.snapshot === snapshot) shared = null;
  });
  return snapshot;
}

/** Tests: forget the shared reading. */
export function forgetSharedFleetSnapshot(): void {
  shared = null;
}

/**
 * Everything the router needs, assembled once per tick.
 *
 * A Routine whose secret is not present in this deployment is left out of the
 * candidate list and reported separately. That is a real state — a row can be
 * registered before its secret is set, or a secret can be rotated away — and
 * treating it as "eligible but will fail" would spend the fleet's scarce fire
 * budget discovering it.
 */
export async function fleetSnapshot(now = new Date()): Promise<FleetSnapshot> {
  const nowIso = now.toISOString();
  const [accounts, routines, policies, perRoutine, allowanceReports] = await Promise.all([
    listAccounts(),
    listRoutines(),
    currentPolicies(),
    inFlightByRoutine(now.getTime()),
    latestAllowanceReports(),
  ]);
  const fleetPolicy = policies.get(policyKey('FLEET', null)) ?? null;
  const readingsByRoutine = await deliveryReadings();
  // Read defensively: a failure here is an unknown, which routes as it always did.
  const healthByRoutine = await connectorHealthByRoutine(now.getTime()).catch(
    () => new Map<string, { state: string; reason: string }>(),
  );

  const accountById = new Map<string, FleetAccount>(accounts.map((a) => [a.id, a]));
  // Both read defensively: an unreadable count routes as it always did.
  const productivity = await productivityByAccount(
    now.getTime(),
    new Map(routines.map((routine) => [routine.id, routine.accountId])),
  ).catch(() => new Map<string, AccountProductivity>());
  const networkBlocked = await networkBlockedRoutines(now.getTime()).catch(() => new Set<string>());
  const perAccount = new Map<string, number>();
  for (const routine of routines) {
    const n = perRoutine.get(routine.id) ?? 0;
    perAccount.set(routine.accountId, (perAccount.get(routine.accountId) ?? 0) + n);
  }

  const candidates: RoutingCandidate[] = [];
  const missingSecrets: { routineId: string; secretName: string }[] = [];

  /*
   * The families each Routine's bound worker may be handed, read once.
   *
   * A Routine bound to no worker resolves to `null` — the question cannot be
   * answered, and the router treats that as eligible because the fire is not the
   * boundary. A worker with no routing row resolves to its *derived* default,
   * which is the same rule the assigner applies, so the two cannot disagree about
   * a worker nobody has narrowed.
   */
  const scopeByWorker = new Map<string, WorkerRoutingScope>();
  for (const routine of routines) {
    if (!routine.workerId || scopeByWorker.has(routine.workerId)) continue;
    scopeByWorker.set(routine.workerId, await routingScopeForWorker(routine.workerId));
  }

  for (const routine of routines) {
    const account = accountById.get(routine.accountId);
    if (!account) continue;
    if (!resolveToken(routine.tokenSecretName)) {
      missingSecrets.push({ routineId: routine.id, secretName: routine.tokenSecretName });
      continue;
    }
    const routinePolicy = policies.get(policyKey('ROUTINE', routine.id)) ?? null;
    const accountPolicy = policies.get(policyKey('ACCOUNT', account.id)) ?? null;
    candidates.push({
      routine,
      account,
      connectorHealth: healthByRoutine.get(routine.id) ?? null,
      servesFamilies: withoutResearchIf(
        networkBlocked.has(routine.id),
        routine.workerId ? scopeByWorker.get(routine.workerId)?.families ?? null : null,
      ),
      servesRepositories: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.repositories ?? null
        : null,
      /*
       * A Routine bound to no worker serves **no project**, and that is the one
       * place this snapshot deliberately fails closed.
       *
       * The two lines above resolve an unbound Routine to `null`, which the
       * router reads as eligible, because the cost of firing an out-of-scope
       * surface is one wasted activation and the cost of refusing an unknown is
       * work nothing is ever started for. That reasoning does not survive being
       * applied to the project: with one worker per private project, firing a
       * surface that cannot be handed the bin is not an occasional waste, it is
       * the *common* case — three fires in four at four operations, each
       * costing a 30-minute in-flight window before the intent can be re-armed.
       *
       * And the bootstrap this would otherwise deadlock has an operator's
       * answer already: `fleet bind-worker --ref trig_… --worker <name>` states
       * the binding rather than waiting to observe one, so a freshly registered
       * Routine is one command away from eligible.
       */
      deliveryReadings: Object.fromEntries(readingsByRoutine.get(routine.id) ?? []),
      servesProjects: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.projects ?? []
        : [],
      workerActive: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.active ?? false
        : false,
      routineInFlight: perRoutine.get(routine.id) ?? 0,
      accountInFlight: perAccount.get(account.id) ?? 0,
      routineTarget: routinePolicy ? effectiveTarget(routinePolicy, nowIso).target : null,
      accountTarget: accountPolicy ? effectiveTarget(accountPolicy, nowIso).target : null,
      accountUnproductiveStarts: productivity.get(account.id)?.unproductive ?? 0,
      accountUnproductiveLimit: UNPRODUCTIVE_STARTS_THRESHOLD,
      allowanceReport: allowanceReports.get(account.id) ?? null,
    });
  }

  let fleetInFlight = 0;
  for (const n of perRoutine.values()) fleetInFlight += n;

  return { candidates, fleetPolicy, fleetInFlight, missingSecrets };
}

/**
 * A network-blocked Routine's families without RESEARCH. An unknown scope
 * (`null`) becomes the non-research families explicitly, because "fire it for
 * anything" is exactly what a known block must not mean.
 */
function withoutResearchIf(blocked: boolean, families: string[] | null): string[] | null {
  if (!blocked) return families;
  return (families ?? ['RESEARCH', 'GENERAL']).filter((family) => family !== 'RESEARCH');
}

/** What one worker may be handed, in the dimensions the fire decides on. */
interface WorkerRoutingScope {
  families: string[];
  /** Explicit and exhaustive, or `null` when the worker has no routing row. */
  repositories: string[] | null;
  /**
   * The projects this worker holds a **live** membership on.
   *
   * Always an array, never null, and that is the difference between this
   * dimension and the two above. Families and repositories are *scopes an
   * operator narrows*, so not having narrowed one is an unknown and the router
   * fails open on it. A project membership is not a narrowing — it is the
   * authorization itself, written by Brain, and a worker that holds none may be
   * handed nothing. There is no unknown here to fail open on, so the empty
   * array is a complete answer rather than a missing one.
   */
  projects: string[];
  /** Can this worker authenticate at all: present, not disabled, not archived. */
  active: boolean;
}

/**
 * The routing scope of one worker, for the routing snapshot.
 *
 * Its own function because the *derived* default needs the worker's membership
 * scopes, and `fleetSnapshot` holds a Routine rather than a principal. Reading
 * the memberships here keeps one rule — a worker with no explicit row serves what
 * its scopes imply and no repository work — rather than letting the fire side
 * invent a second, more generous default.
 *
 * An unreadable row resolves to `RESEARCH`/`GENERAL` and never to the repository
 * family, so a failure here can waste a fire and can never start a surface on
 * software work it is not authorized for.
 */
async function routingScopeForWorker(workerId: string): Promise<WorkerRoutingScope> {
  try {
    /*
     * Live memberships, read once and used for both answers.
     *
     * `listMembershipsForPrincipal` returns live rows only — "a revoked one is
     * not a weaker membership; it is none" — so a revocation removes this
     * Routine from routing on the very next snapshot, with nothing to
     * invalidate and no cache to miss.
     */
    const worker = await getWorker(workerId);
    const active = worker !== null && !worker.disabled && !worker.archived;
    const memberships = await listMembershipsForPrincipal('WORKER', workerId);
    const projects = memberships
      .filter((membership) => membership.active)
      .map((membership) => membership.projectId);

    const explicit = await getWorkerRouting(workerId);
    // An explicit row is exhaustive in both of *its* dimensions, which is the
    // same rule the admission hook reads it by. It says nothing about projects:
    // `worker_routing` has no project column, because the project a worker may
    // serve is its membership and never a routing preference.
    if (explicit) {
      return { families: explicit.families, repositories: explicit.repositories, projects, active };
    }
    // The derived default, from the one function that defines it. Its
    // repositories are *unknown* rather than empty — and unreachable, because
    // the derived families never include a repository family.
    return {
      families: derivedFamiliesFrom(memberships),
      repositories: null,
      projects,
      active,
    };
  } catch {
    /*
     * An unreadable row wastes a fire in the two dimensions that fail open, and
     * serves **no project** in the one that does not. A read that failed is not
     * evidence of a membership, and manufacturing one here would be exactly the
     * unknown-as-favourable-assumption invariant 39 forbids.
     */
    return { families: ['RESEARCH', 'GENERAL'], repositories: null, projects: [], active: false };
  }
}

/**
 * Why the router would refuse each registered Routine, independent of any bin.
 *
 * `surfaceIneligibility` answers for a routing candidate; a Routine whose secret
 * is not deployed never becomes one, and a Routine whose account row is gone is
 * skipped outright. Readers that describe a surface to a person (Who, goals,
 * the Fleet page) need an answer for all three, and deriving it here keeps
 * them asking the router's question rather than reading a state column — the
 * disagreement §23 records at four readers already.
 *
 * `null` means the router would consider it; it says nothing about headroom.
 */
export function routingRefusalByRoutine(snapshot: FleetSnapshot, routineIds: readonly string[]): Map<string, string | null> {
  const candidates = new Map(snapshot.candidates.map((one) => [one.routine.id, one]));
  const missing = new Set(snapshot.missingSecrets.map((one) => one.routineId));
  const out = new Map<string, string | null>();
  for (const id of routineIds) {
    const candidate = candidates.get(id);
    if (candidate) out.set(id, surfaceIneligibility(candidate));
    else if (missing.has(id)) out.set(id, 'its deployment secret is not present');
    else out.set(id, 'its account is not registered');
  }
  return out;
}
