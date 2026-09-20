/**
 * When the self-model is stale, decided from rows rather than from a hook.
 *
 * ---------------------------------------------------------------------------
 * Derived, for the reason this repository has needed five times
 * ---------------------------------------------------------------------------
 *
 * The obvious design is to call `scanSystem` from everything that could make a
 * reading stale: the migration runner, the deploy path, `promoteCandidate`,
 * `registerRoutine`, the factory's integration. Every one of those is a hook,
 * and a hook fixes one entrance. §24's `concludeAbandonedParks`, §27's
 * `rearmSurfaceDeferredIntents` and §30's need continuation all record the same
 * correction: **derive the condition instead of scheduling it**, because that
 * is what reaches the ones already stale and survives a tick that died halfway.
 *
 * So there is one question — *is the last reading still about this system?* —
 * and three ways for the answer to be no. Each is a comparison against a row.
 *
 * ---------------------------------------------------------------------------
 * Why it does not scan on every tick
 * ---------------------------------------------------------------------------
 *
 * A scan reads every file under `server/`, every suite and every document. That
 * is cheap enough to do when something changed and wasteful enough every ten
 * seconds that somebody would eventually turn it off — and a scan nobody runs
 * is a self-model that is always stale, which is the failure this whole module
 * is trying to avoid. The interval is the floor under a system where nothing is
 * changing, not the mechanism.
 */
import { getDb } from '../../db/database.ts';
import { BRAIN_REVISION } from '../../env.ts';
import { latestScan, scanSystem, type ScanReason, type ScanReport } from './scan.ts';

/**
 * The longest a reading may stand when nothing observable has changed.
 *
 * Six hours rather than a number tuned against anything: the three real
 * triggers below are what make a scan timely, and this is only the floor for a
 * system nobody is touching. A shorter one would spend a full tree walk to
 * re-learn what it already knows.
 */
export const MAX_READING_AGE_MS = 6 * 60 * 60 * 1000;

export interface Staleness {
  stale: boolean;
  /** The reason to record on the scan, when one is due. */
  reason: ScanReason;
  /** Why, in words. Null when the reading still stands. */
  detail: string | null;
}

/**
 * Is the last reading still about this system?
 *
 * Three ways for the answer to be no, in the order that makes the recorded
 * reason most useful: a different commit is a deployment, a different schema
 * version is a migration, and age is the floor.
 */
export async function readingStaleness(now = Date.now()): Promise<Staleness> {
  const last = await latestScan();
  if (!last) {
    return {
      stale: true,
      reason: 'BOOT',
      detail: 'No reading has ever been taken on this database.',
    };
  }

  /*
   * The revision, first.
   *
   * Compared only when *both* are stamped. An unstamped process reading a
   * stamped scan is a local checkout looking at a production row, and treating
   * that as a deployment would make every developer's first tick rewrite six
   * hundred rows with weaker evidence. Unknown lineage does nothing rather than
   * asserting a change.
   */
  if (BRAIN_REVISION !== null && last.revision !== null && BRAIN_REVISION !== last.revision) {
    return {
      stale: true,
      reason: 'DEPLOYMENT',
      detail: `The last reading was taken on ${last.revision} and this process is ${BRAIN_REVISION}.`,
    };
  }

  const applied = await getDb().get<{ version: number; n: number }>(
    `SELECT MAX(version) AS version, COUNT(*) AS n FROM schema_migrations`,
  );
  const version = Number(applied?.version ?? 0);
  const count = Number(applied?.n ?? 0);
  const observed = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM system_components WHERE kind = 'MIGRATION' AND deployed = 'YES'`,
  );
  if (Number(observed?.n ?? 0) !== count) {
    return {
      stale: true,
      reason: 'MIGRATION_APPLIED',
      detail:
        `${count} migration(s) have applied (through version ${version}) and the reading holds ` +
        `${Number(observed?.n ?? 0)} as deployed.`,
    };
  }

  const age = now - Date.parse(last.startedAt);
  if (!Number.isFinite(age) || age >= MAX_READING_AGE_MS) {
    return {
      stale: true,
      reason: 'SCHEDULED',
      detail: `The last reading was taken at ${last.startedAt}.`,
    };
  }

  return { stale: false, reason: 'SCHEDULED', detail: null };
}

/**
 * Take a reading if one is due, and otherwise do nothing at all.
 *
 * Returns null when the reading still stands, which is the common answer and is
 * what makes this safe to call from a tick. A caller that wants a reading
 * regardless calls `scanSystem('REQUESTED')` directly — the two are deliberately
 * different functions, because "refresh if stale" and "refresh now" answer
 * different questions and one function with a flag would eventually be called
 * with the wrong one.
 */
export async function scanIfStale(): Promise<ScanReport | null> {
  const staleness = await readingStaleness();
  if (!staleness.stale) return null;
  return await scanSystem(staleness.reason);
}
