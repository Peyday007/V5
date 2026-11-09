/**
 * Rule 9: executable work, eligible capacity and nothing running is a defect.
 *
 * The continuation path already exists — the dispatch tick turns a READY bin
 * into a fire — so the watchdog does not invent a second one. It reads the
 * three counts from the same places the dispatcher and the Fleet page read
 * them, records `IDLE_WITH_EXECUTABLE_WORK` when all three line up, and asks
 * the existing dispatch tick for one pass. A condition that persists is
 * recorded at most once per window, so a stuck fleet reads as one visible
 * intervention rather than a row every ten seconds.
 */
import { getDb } from '../../db/database.ts';
import { DISPATCHABLE_SQL, FIREABLE_SQL, workReadySql } from '../../repos/bins.ts';
import { recordIntervention } from '../../repos/engineering.ts';
import { idleCheck } from '../../domain/engineering.ts';
import { capacityReading } from '../fleet/capacity.ts';
import { dispatchTick } from '../dispatch/loop.ts';

export const IDLE_RECORD_WINDOW_MS = 10 * 60_000;

export interface IdleReading {
  executableWork: number;
  eligibleCapacity: number;
  activeWork: number;
  safeTarget: number;
  idle: boolean;
  reason: string;
  intervened: boolean;
  fired: number;
}

export async function idleCounts(now = new Date()): Promise<Omit<IdleReading, 'idle' | 'reason' | 'intervened' | 'fired'>> {
  const iso = now.toISOString();
  // The dispatcher's own predicate, all three parts: a research packet bin with
  // no claimable work is not executable, and counting it read as idle capacity
  // for hours while the dispatcher correctly had nothing to fire (§98).
  const executable = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bins WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')}`,
    [iso, iso, iso, iso],
  );
  const active = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM bins WHERE state = 'LEASED' AND lease_expires_at > ?",
    [iso],
  );
  const capacity = await capacityReading();
  const eligible = capacity.eligibleNow;
  return {
    executableWork: Number(executable?.n ?? 0),
    eligibleCapacity: eligible,
    activeWork: Number(active?.n ?? 0),
    safeTarget: capacity.target ?? eligible,
  };
}

export async function watchIdle(options: { continueWork?: boolean; now?: Date } = {}): Promise<IdleReading> {
  const now = options.now ?? new Date();
  const counts = await idleCounts(now);
  const check = idleCheck(counts);
  let intervened = false;
  let fired = 0;
  if (check.idle) {
    const since = new Date(now.getTime() - IDLE_RECORD_WINDOW_MS).toISOString();
    const recent = await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND created_at > ?",
      [since],
    );
    if (Number(recent?.n ?? 0) === 0) {
      await recordIntervention({
        kind: 'IDLE_WITH_EXECUTABLE_WORK',
        rule: 'RULE_9_KEEP_CAPACITY_FED',
        attemptedAction: check.reason,
        replacementAction: 'one dispatch tick through the existing continuation path',
        actorType: 'BRAIN',
        actorId: 'engineering:watchdog',
      });
      intervened = true;
    }
    if (options.continueWork !== false) {
      const tick = await dispatchTick();
      fired = tick.fired;
    }
  }
  return { ...counts, ...check, intervened, fired };
}

/* ------------------------------------------------------------------------- */
/* Every pool (Brain-wide resource rule, §98)                                 */
/* ------------------------------------------------------------------------- */

/**
 * One pool of capacity, read from the counts its own scheduler uses.
 *
 * `waiting` is work that pool could take now, `running` is what it holds, and
 * `capacity` is the most it may hold at once. A pool is idle when work waits
 * and it holds less than it may; `limitedBy` names the justified bound when
 * it is not idle for that reason (capacity, a person, provider errors).
 */
export interface PoolReading {
  pool: 'ROUTINES' | 'FREE_LANE' | 'RESEARCH_SLOTS' | 'FACTORY';
  waiting: number;
  running: number;
  capacity: number;
  idle: boolean;
  because: string;
}

/**
 * The free lane, as its own controller last read it (§86). A process that
 * does not run the lane (an operator's shell) reads the same three numbers
 * from rows: waiting work, leased free-lane items, and the persisted targets.
 */
async function freeLanePool(now: Date): Promise<PoolReading | null> {
  const { lastControlReading, adaptivePoolRunning, waitingNow, readCapacity } = await import('../freeLane/capacity.ts');
  const reading = adaptivePoolRunning() ? lastControlReading() : null;
  let waiting: number;
  let running: number;
  let capacity: number;
  let detail: string;
  if (reading) {
    waiting = reading.waiting;
    running = reading.models.reduce((sum, one) => sum + one.busy, 0);
    capacity = reading.models.reduce((sum, one) => sum + one.target, 0);
    detail = reading.models.map((one) => `${one.model}: ${one.busy}/${one.target} (${one.reason})`).join('; ');
  } else {
    const targets = await readCapacity();
    if (targets.length === 0) return null;
    waiting = await waitingNow();
    const leased = await getDb().get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM work_items WHERE state = 'LEASED' AND lease_expires_at > ?
          AND worker_id IN (SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))`,
      [now.toISOString()],
    );
    running = Number(leased?.n ?? 0);
    capacity = targets.reduce((sum, one) => sum + one.target, 0);
    detail = targets.map((one) => `${one.model}: target ${one.target} (${one.reason})`).join('; ');
  }
  const idle = waiting > 0 && running === 0 && capacity > 0;
  return {
    pool: 'FREE_LANE',
    waiting,
    running,
    capacity,
    idle,
    because: idle
      ? `${waiting} research item(s) waiting and none of ${capacity} free-lane slot(s) busy`
      : detail.slice(0, 400) || 'no models',
  };
}

/** Research grant mission slots: launchable ideas, live holds, and the grants' at-once ceilings. */
async function researchSlotPool(now: Date): Promise<PoolReading> {
  const iso = now.toISOString();
  const db = getDb();
  const waiting = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM russell_candidates c
      WHERE c.state = 'QUEUED' AND c.project_id IS NOT NULL AND c.judgment LIKE '%"missionSpec"%'
        AND NOT EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id AND m.state NOT IN ('FAILED','CANCELLED'))`,
  );
  const live = await db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM russell_budget_reservations WHERE kind = 'MISSION' AND state = 'HELD' AND expires_at > ?",
    [iso],
  );
  const cap = await db.get<{ n: number | string | null }>(
    "SELECT COALESCE(SUM(max_concurrent), 0) AS n FROM russell_goals WHERE state = 'ACTIVE'",
  );
  const w = Number(waiting?.n ?? 0);
  const r = Number(live?.n ?? 0);
  const c = Number(cap?.n ?? 0);
  const idle = w > 0 && r < c;
  return {
    pool: 'RESEARCH_SLOTS',
    waiting: w,
    running: r,
    capacity: c,
    idle,
    because: idle
      ? `${w} launchable idea(s) and ${c - r} free research slot(s): the launch pass takes the most important first`
      : w === 0
        ? 'nothing launchable is waiting'
        : `every research slot is held (${r}/${c})`,
  };
}

/** Free research slots across active grants: at-once ceilings minus live holds. */
export async function researchSlotsFree(now = new Date()): Promise<number> {
  const slots = await researchSlotPool(now);
  return Math.max(0, slots.capacity - slots.running);
}

/** The Factory line, as its own reading says (`readLine`). */
async function factoryPool(now: Date): Promise<PoolReading | null> {
  try {
    const { readLine } = await import('../factory/line.ts');
    const line = await readLine(now);
    return {
      pool: 'FACTORY',
      waiting: line.executable.total,
      running: line.active.leasedBins + line.active.arriving,
      capacity: line.active.leasedBins + line.active.arriving + line.capacity.freeSurfaces,
      idle: line.unexplainedIdle,
      because: line.because,
    };
  } catch {
    return null;
  }
}

/** Every pool Brain schedules work onto, read now. Nothing is changed. */
export async function brainUtilization(now = new Date()): Promise<PoolReading[]> {
  const counts = await idleCounts(now);
  const routines = idleCheck(counts);
  const pools: PoolReading[] = [
    {
      pool: 'ROUTINES',
      waiting: counts.executableWork,
      running: counts.activeWork,
      capacity: counts.safeTarget,
      idle: routines.idle,
      because: routines.reason,
    },
  ];
  const free = await freeLanePool(now).catch(() => null);
  if (free) pools.push(free);
  pools.push(await researchSlotPool(now));
  const factory = await factoryPool(now);
  if (factory) pools.push(factory);
  return pools;
}

/**
 * Read every pool and continue what is idle beside waiting work.
 *
 * Each correction is the pool's own continuation, never a second scheduler:
 * routines get one guarded dispatch pass (`dispatchTickIfIdle`, which skips
 * when the loop is already running); the free lane gets its controller's step,
 * which tops up idle slots; research slots and the Factory line are continued
 * by their own passes on the next tick, so idleness there is recorded with
 * its reason. A pool idle for the same reason is recorded once per window.
 */
export async function watchUtilization(options: { continueWork?: boolean; now?: Date } = {}): Promise<{ pools: PoolReading[]; recorded: string[]; continued: string[] }> {
  const now = options.now ?? new Date();
  const pools = await brainUtilization(now);
  const recorded: string[] = [];
  const continued: string[] = [];
  const since = new Date(now.getTime() - IDLE_RECORD_WINDOW_MS).toISOString();
  for (const one of pools.filter((p) => p.idle)) {
    const recent = await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND attempted_action LIKE ? AND created_at > ?",
      [`${one.pool}:%`, since],
    );
    if (Number(recent?.n ?? 0) === 0) {
      await recordIntervention({
        kind: 'IDLE_WITH_EXECUTABLE_WORK',
        rule: 'RULE_9_KEEP_CAPACITY_FED',
        attemptedAction: `${one.pool}: ${one.because}`,
        replacementAction:
          one.pool === 'ROUTINES'
            ? 'one guarded dispatch pass'
            : one.pool === 'FREE_LANE'
              ? "the free lane controller's step, which tops up idle slots"
              : 'its own pass on the next tick',
        actorType: 'BRAIN',
        actorId: 'engineering:watchdog',
      });
      recorded.push(one.pool);
    }
    if (options.continueWork === false) continue;
    if (one.pool === 'ROUTINES') {
      const { dispatchTickIfIdle } = await import('../dispatch/loop.ts');
      if (await dispatchTickIfIdle({})) continued.push(one.pool);
    } else if (one.pool === 'FREE_LANE') {
      const { controlStep } = await import('../freeLane/capacity.ts');
      await controlStep();
      continued.push(one.pool);
    }
  }
  return { pools, recorded, continued };
}

export const IDLE_READ_INTERVAL_MS = 5 * 60_000;
let lastIdleRead = 0;

/** The durable tick's call: every pool, continued through its own path, no more often than every few minutes. */
export async function watchIdleOnTick(nowMs = Date.now()): Promise<IdleReading | null> {
  if (nowMs - lastIdleRead < IDLE_READ_INTERVAL_MS) return null;
  lastIdleRead = nowMs;
  const reading = await watchIdle({ continueWork: false, now: new Date(nowMs) });
  await watchUtilization({ now: new Date(nowMs) }).catch((error) => {
    console.warn('[watchdog] utilization read failed:', (error as Error).message);
  });
  return reading;
}
