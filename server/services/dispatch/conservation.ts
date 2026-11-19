/**
 * Work conservation for the dispatch pass: no free surface beside a bin the
 * dispatcher would fire, and no bin called idle that the dispatcher is
 * deliberately holding.
 *
 * Production, 2026-11-18: engineering:watchdog recorded "1 executable item(s),
 * 13 eligible surface(s), 0 active against a target of 12: capacity is
 * unexplainedly idle" (and the Factory line's "1 piece(s) of executable work and
 * 1 free surface(s) … That is a fault, not a wait") in 181 of 144 ten-minute
 * windows, and the dispatch pass it asked for each time fired nothing
 * (ORIGINATED:IDLE_CAPACITY:engineering-watchdog, attempt 2).
 *
 * The cause is two predicates that answer one question differently. The
 * watchdog counted a bin executable when it was dispatchable, fireable and had
 * claimable work. The dispatcher fires a bin only through its one intent per
 * (bin, lease generation) — `listDispatchableBinHeads({ onlyWithoutIntent })`
 * skips a bin holding an intent in *any* state — so a bin whose intent was
 * deferred into the future, sent and awaiting its session, or abandoned, was
 * "executable" to one and had nothing due to the other. The pass the watchdog
 * asked for then found nothing to send, every window.
 *
 * Attempt 1 re-armed abandoned intents on a clock (`rearm.ts`) and changed
 * nothing measurable. This changes the method in two ways, both extensions of
 * the existing tick rather than a second scheduler:
 *
 *   1. One predicate. `dispatchReadiness` partitions every dispatchable,
 *      fireable, work-ready bin into the ones the dispatcher would fire this
 *      tick and the ones it is holding, each hold named (deferred until T on
 *      refusal R, sent and awaiting arrival, abandoned, pinned to an unavailable
 *      surface, refused by routing moments ago). The watchdog reads this rather
 *      than restating it, so idleness is counted only where it is unexplained —
 *      work conservation exempts a deliberate hold, never an unexplained one.
 *
 *   2. Capacity, not the clock, ends a capacity wait. An intent deferred because
 *      every surface was at its target waits out a timestamp even after the
 *      fleet drains, so a free surface sits beside it until the backoff lapses.
 *      `pullForwardCapacityDeferred` asks `routeBin` again — the fire's own
 *      predicate — and makes the intent due now only when the answer is a route.
 *      It is asked when a dispatch pass is requested because capacity reads idle
 *      (`dispatchTick({ conserve: true })`), the analogue of re-queueing on a
 *      cluster event rather than waiting for the backoff to expire.
 *
 * Nothing here fires, charges or abandons anything. A pulled intent meets every
 * gate a new one meets — the refire guard, audit fit, Brain-only admission,
 * routing and the fire-slot compare-and-swap — and the change is one
 * conditional UPDATE, so two dispatchers pull it once.
 */
import { getDb } from '../../db/database.ts';
import {
  DISPATCHABLE_SQL,
  FIREABLE_SQL,
  binNow,
  getBin,
  recordBinEvent,
  workReadySql,
} from '../../repos/bins.ts';
import type { Bin } from '../../domain/types.ts';
import type { RoutingRefusal } from './router.ts';

/** A routing refusal this recent is a named wait, not idle capacity (the watchdog's window). */
export const RECENTLY_UNROUTED_MS = 15 * 60_000;

/**
 * Which deferrals free capacity ends.
 *
 * A `Record` over every refusal so one added later is a compile error here
 * until somebody decides. Only a target being reached is ended by a surface
 * becoming free. A provider's rate limit carries its own retry time; a paused
 * fleet and an account whose sessions are unproductive are deliberate holds;
 * every operator wait is put back by the fleet write that answers it
 * (`rearmSurfaceDeferredIntents`), never by capacity.
 */
export const ENDED_BY_FREE_CAPACITY: Record<RoutingRefusal, boolean> = {
  FLEET_TARGET_REACHED: true,
  ACCOUNT_TARGETS_REACHED: true,
  ACCOUNT_SESSIONS_UNPRODUCTIVE: false,
  ALL_SURFACES_RATE_LIMITED: false,
  FLEET_PAUSED: false,
  NO_SURFACE_SERVES_THIS_FAMILY: false,
  NO_SURFACE_SERVES_THIS_REPOSITORY: false,
  NO_SURFACE_SERVES_THIS_PROJECT: false,
  NO_CAPABLE_SURFACE: false,
  NO_ROUTINES_REGISTERED: false,
  ALL_SURFACES_INELIGIBLE: false,
  PINNED_SURFACE_UNAVAILABLE: false,
};

export const CAPACITY_ENDED_REFUSALS: readonly RoutingRefusal[] = (
  Object.keys(ENDED_BY_FREE_CAPACITY) as RoutingRefusal[]
).filter((refusal) => ENDED_BY_FREE_CAPACITY[refusal]);

export type DispatchHoldKind =
  | 'DEFERRED'
  | 'SENDING'
  | 'SENT_AWAITING_ARRIVAL'
  | 'ABANDONED'
  | 'SUPERSEDED'
  | 'PINNED_SURFACE_UNAVAILABLE'
  | 'RECENTLY_UNROUTED';

export interface DispatchHold {
  binId: string;
  projectId: string;
  kind: DispatchHoldKind;
  /** The refusal or failure the intent last recorded, when there is one. */
  cause: string | null;
  /** When the hold lapses by itself, when it does. */
  until: string | null;
}

export interface DispatchReadiness {
  /** Bins the dispatcher would create an intent for, or claim one of, this tick. */
  executable: Array<{ binId: string; projectId: string }>;
  /** Every other dispatchable, fireable, work-ready bin, with what holds it. */
  held: DispatchHold[];
}

interface ReadyBinRow {
  id: string;
  project_id: string;
  lease_generation: number | string;
  pinned_routine_id: string | null;
}

interface IntentRow {
  bin_id: string;
  lease_generation: number | string;
  state: string;
  next_attempt_at: string | null;
  last_error_kind: string | null;
}

/**
 * The dispatcher's own answer, for every bin it may fire: would it fire it now,
 * or what is it waiting on. Read only; nothing is changed.
 *
 * Bounded at the page the tick itself reads, so the two never disagree about
 * which bins are being asked.
 */
export async function dispatchReadiness(now = new Date(), limit = 500): Promise<DispatchReadiness> {
  const iso = now.toISOString();
  const bins = await getDb().all<ReadyBinRow>(
    `SELECT bins.id AS id, bins.project_id AS project_id, bins.lease_generation AS lease_generation,
            bins.pinned_routine_id AS pinned_routine_id
       FROM bins
      WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')}
      ORDER BY bins.priority DESC, bins.created_at, bins.id
      LIMIT ?`,
    [iso, iso, iso, iso, Math.min(500, Math.max(1, limit))],
  );
  const out: DispatchReadiness = { executable: [], held: [] };
  if (bins.length === 0) return out;

  const ids = bins.map((bin) => bin.id);
  const marks = ids.map(() => '?').join(', ');
  const intents = new Map<string, IntentRow>();
  for (const row of await getDb().all<IntentRow>(
    `SELECT bin_id, lease_generation, state, next_attempt_at, last_error_kind
       FROM bin_dispatch WHERE bin_id IN (${marks})`,
    ids,
  )) {
    const bin = bins.find((one) => one.id === row.bin_id);
    if (bin && Number(bin.lease_generation) === Number(row.lease_generation)) intents.set(row.bin_id, row);
  }
  const unroutedSince = new Date(now.getTime() - RECENTLY_UNROUTED_MS).toISOString();
  const unrouted = new Map<string, string | null>();
  for (const row of await getDb().all<{ bin_id: string; outcome: string | null; at: string }>(
    `SELECT bin_id, outcome, at FROM bin_events
      WHERE event_type = 'DISPATCH_UNROUTED' AND at > ? AND bin_id IN (${marks})
      ORDER BY at`,
    [unroutedSince, ...ids],
  )) {
    unrouted.set(row.bin_id, row.outcome);
  }
  const pinnedIds = [...new Set(bins.map((bin) => bin.pinned_routine_id).filter((id): id is string => !!id))];
  const pinnedUsable = new Set<string>();
  if (pinnedIds.length > 0) {
    for (const row of await getDb().all<{ id: string }>(
      `SELECT r.id AS id FROM fleet_routines r JOIN fleet_accounts a ON a.id = r.account_id
        WHERE r.state = 'ENABLED' AND a.state = 'ENABLED' AND r.id IN (${pinnedIds.map(() => '?').join(', ')})`,
      pinnedIds,
    )) {
      pinnedUsable.add(row.id);
    }
  }

  for (const bin of bins) {
    const base = { binId: bin.id, projectId: bin.project_id };
    if (bin.pinned_routine_id && !pinnedUsable.has(bin.pinned_routine_id)) {
      out.held.push({ ...base, kind: 'PINNED_SURFACE_UNAVAILABLE', cause: bin.pinned_routine_id, until: null });
      continue;
    }
    const intent = intents.get(bin.id);
    if (!intent) {
      // The tick creates an intent for it and claims it in the same pass —
      // unless routing refused it moments ago, which is a named wait.
      if (unrouted.has(bin.id)) {
        out.held.push({ ...base, kind: 'RECENTLY_UNROUTED', cause: unrouted.get(bin.id) ?? null, until: null });
      } else out.executable.push(base);
      continue;
    }
    const due = intent.next_attempt_at === null || intent.next_attempt_at <= iso;
    switch (intent.state) {
      case 'PENDING':
        if (due) out.executable.push(base);
        else
          out.held.push({ ...base, kind: 'DEFERRED', cause: intent.last_error_kind, until: intent.next_attempt_at });
        break;
      case 'SENDING':
        if (due) out.executable.push(base);
        else out.held.push({ ...base, kind: 'SENDING', cause: null, until: intent.next_attempt_at });
        break;
      case 'SENT':
        out.held.push({ ...base, kind: 'SENT_AWAITING_ARRIVAL', cause: null, until: null });
        break;
      case 'ABANDONED':
        out.held.push({ ...base, kind: 'ABANDONED', cause: intent.last_error_kind, until: null });
        break;
      default:
        out.held.push({ ...base, kind: 'SUPERSEDED', cause: intent.last_error_kind, until: null });
    }
  }
  return out;
}

/** One line per kind of hold, for a reading that must say why capacity waits. */
export function describeHolds(held: readonly DispatchHold[]): string {
  if (held.length === 0) return '';
  const byKind = new Map<string, number>();
  for (const hold of held) {
    const key = hold.cause ? `${hold.kind} (${hold.cause})` : hold.kind;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  return [...byKind.entries()].map(([key, n]) => `${n} ${key}`).join('; ');
}

/**
 * Make due now every intent deferred only because capacity was full, whose bin
 * the router would now route.
 *
 * `routesNow` is the fire's own predicate (`routeBin` against this tick's
 * snapshot), passed in so this module does not read the fleet a second way.
 * Returns the bins pulled forward.
 */
export async function pullForwardCapacityDeferred(input: {
  routesNow: (bin: Bin) => boolean | Promise<boolean>;
  limit?: number;
  projectIds?: string[];
}): Promise<string[]> {
  if (CAPACITY_ENDED_REFUSALS.length === 0) return [];
  const now = binNow();
  const kinds = CAPACITY_ENDED_REFUSALS.map(() => '?').join(', ');
  // The bin side is the dispatcher's own predicate, asked of `bins` alone so its
  // unqualified columns cannot be read against `bin_dispatch` (as in `rearm.ts`).
  const rows = await getDb().all<{ id: string }>(
    `SELECT bins.id AS id FROM bins
      WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')}
        AND EXISTS (
          SELECT 1 FROM bin_dispatch d
           WHERE d.bin_id = bins.id AND d.lease_generation = bins.lease_generation
             AND d.state = 'PENDING' AND d.next_attempt_at > ? AND d.last_error_kind IN (${kinds}))
      ORDER BY bins.priority DESC, bins.created_at, bins.id
      LIMIT ?`,
    [now, now, now, now, now, ...CAPACITY_ENDED_REFUSALS, Math.max(1, input.limit ?? 20)],
  );
  const pulled: string[] = [];
  for (const row of rows) {
    const bin = await getBin(row.id);
    if (!bin) continue;
    if (input.projectIds && !input.projectIds.includes(bin.projectId)) continue;
    if (!(await input.routesNow(bin))) continue;
    const at = binNow();
    const result = await getDb().run(
      `UPDATE bin_dispatch SET next_attempt_at = ?, updated_at = ?
        WHERE bin_id = ? AND lease_generation = ? AND state = 'PENDING'
          AND next_attempt_at > ? AND last_error_kind IN (${kinds})`,
      [at, at, bin.id, bin.leaseGeneration, at, ...CAPACITY_ENDED_REFUSALS],
    );
    if (result.changes !== 1) continue;
    await recordBinEvent({
      eventType: 'DISPATCH_CONSERVED',
      binId: bin.id,
      projectId: bin.projectId,
      leaseGeneration: bin.leaseGeneration,
      outcome: 'PENDING',
      reason:
        'Deferred because every surface was at its target; a surface is free now and the router routes ' +
        'this bin, so the intent is due now rather than at the end of its backoff.',
      evidenceClass: 'MEASURED',
    });
    pulled.push(bin.id);
  }
  return pulled;
}
