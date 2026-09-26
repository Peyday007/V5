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
import { DISPATCHABLE_SQL, FIREABLE_SQL } from '../../repos/bins.ts';
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
  const executable = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bins WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL}`,
    [iso, iso],
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

export const IDLE_READ_INTERVAL_MS = 5 * 60_000;
let lastIdleRead = 0;

/** The durable tick's call: record-only, and no more often than every few minutes. */
export async function watchIdleOnTick(nowMs = Date.now()): Promise<IdleReading | null> {
  if (nowMs - lastIdleRead < IDLE_READ_INTERVAL_MS) return null;
  lastIdleRead = nowMs;
  return await watchIdle({ continueWork: false, now: new Date(nowMs) });
}
