/**
 * GOV-11's "re-map it when the owner answers", made a mechanism rather than a
 * habit.
 *
 * `checkRegister` holds the open-questions register to its promises, and
 * `checkRegisterOnProduction` runs it against the program's stored source and
 * the register at the running revision. Neither ran unless somebody ran a test,
 * so a release appended through the §97 amendment path could leave the register
 * silently behind it. This watcher closes that: on the goals tick it reads the
 * program's release fingerprint (how many releases, the latest number) and the
 * running revision, and whenever either has moved since the last recorded
 * check, it re-runs the production check and appends one
 * `PROGRAM_REGISTER_CHECKED` factory event — but only when the verdict or the
 * fingerprint changed, so the ledger records moves, not ticks.
 *
 * A register behind a new release fails naming that release (`behind`), and
 * keeps failing — recorded once — until the register is re-mapped against it
 * and that revision is running. No new store, status set or scheduler: the
 * program owns its releases (§96/§97), the factory event ledger is the existing
 * append-only record, and the goals tick is the existing durable pass.
 */
import type { RegisterCheck } from './openQuestions.ts';

export const REGISTER_CHECK_KIND = 'PROGRAM_REGISTER_CHECKED';

/** How often the tick may look at all. The look itself is one query; the check runs only when something moved. */
export const REGISTER_WATCH_INTERVAL_MS = 10 * 60_000;

export interface RegisterFingerprint {
  programId: string;
  /** Changes when a release is appended or a different revision is running. */
  key: string;
  releases: number;
  latestRelease: number;
  revision: string | null;
}

export interface RecordedRegisterCheck {
  key: string;
  ok: boolean;
  detail: string;
}

export interface RegisterWatchDeps {
  fingerprint: () => Promise<RegisterFingerprint | null>;
  lastRecorded: (programId: string) => Promise<RecordedRegisterCheck | null>;
  check: () => Promise<{ ok: boolean; detail: string; check: RegisterCheck | null }>;
  record: (entry: { fingerprint: RegisterFingerprint; ok: boolean; detail: string; behind: number[] }) => Promise<void>;
}

export type RegisterWatchResult =
  | { outcome: 'NO_PROGRAM' }
  | { outcome: 'UNCHANGED'; programId: string; key: string }
  | { outcome: 'CHECKED'; programId: string; key: string; ok: boolean; detail: string; behind: number[]; recorded: boolean };

async function programFingerprint(): Promise<RegisterFingerprint | null> {
  const { getDb } = await import('../../db/database.ts');
  const { BRAIN_REVISION } = await import('../../env.ts');
  const { ARCHITECTURE_PROGRAM_KEY } = await import('../factory/program/probes.ts');
  const row = await getDb().get<{ id: string; releases: number | string | null; latest: number | string | null }>(
    `SELECT p.id AS id, COUNT(a.number) AS releases, MAX(a.number) AS latest
       FROM factory_programs p
       LEFT JOIN factory_program_amendments a ON a.program_id = p.id
      WHERE p.submission_key = ?
      GROUP BY p.id, p.created_at
      ORDER BY p.created_at
      LIMIT 1`,
    [ARCHITECTURE_PROGRAM_KEY],
  );
  if (!row) return null;
  const releases = Number(row.releases ?? 0);
  const latestRelease = Number(row.latest ?? 0);
  const revision = BRAIN_REVISION;
  return { programId: row.id, key: `${releases}:${latestRelease}:${revision ?? 'no-revision'}`, releases, latestRelease, revision };
}

async function lastRecordedCheck(programId: string): Promise<RecordedRegisterCheck | null> {
  const { listFactoryEvents } = await import('../../repos/factoryFleet.ts');
  // Recorded only when something moved, so the kind stays a short list.
  const events = await listFactoryEvents(null, { kinds: [REGISTER_CHECK_KIND], limit: 5000 });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const detail = events[index]!.detail as Record<string, unknown>;
    if (detail['programId'] !== programId) continue;
    return { key: String(detail['key'] ?? ''), ok: detail['ok'] === true, detail: String(detail['detail'] ?? '') };
  }
  return null;
}

async function recordCheck(entry: { fingerprint: RegisterFingerprint; ok: boolean; detail: string; behind: number[] }): Promise<void> {
  const { recordFactoryEvent } = await import('../../repos/factoryFleet.ts');
  await recordFactoryEvent({
    kind: REGISTER_CHECK_KIND,
    evidenceClass: 'MEASURED',
    detail: {
      programId: entry.fingerprint.programId,
      key: entry.fingerprint.key,
      releases: entry.fingerprint.releases,
      latestRelease: entry.fingerprint.latestRelease,
      revision: entry.fingerprint.revision,
      ok: entry.ok,
      behind: entry.behind,
      detail: entry.detail.slice(0, 2000),
    },
  });
}

async function productionCheck(): Promise<{ ok: boolean; detail: string; check: RegisterCheck | null }> {
  const { checkRegisterOnProduction } = await import('./openQuestions.ts');
  return checkRegisterOnProduction();
}

const DEFAULT_DEPS: RegisterWatchDeps = {
  fingerprint: programFingerprint,
  lastRecorded: lastRecordedCheck,
  check: productionCheck,
  record: recordCheck,
};

/**
 * One look: when the program's releases or the running revision moved since
 * the last recorded check, re-run the register check against production and
 * record the verdict if it differs from the last one recorded.
 */
export async function watchRegister(deps: Partial<RegisterWatchDeps> = {}): Promise<RegisterWatchResult> {
  const use = { ...DEFAULT_DEPS, ...deps };
  const fingerprint = await use.fingerprint();
  if (!fingerprint) return { outcome: 'NO_PROGRAM' };
  const last = await use.lastRecorded(fingerprint.programId);
  if (last && last.key === fingerprint.key) return { outcome: 'UNCHANGED', programId: fingerprint.programId, key: fingerprint.key };
  const result = await use.check();
  const behind = result.check?.behind ?? [];
  const changed = !last || last.ok !== result.ok || last.detail !== result.detail || last.key !== fingerprint.key;
  if (changed) await use.record({ fingerprint, ok: result.ok, detail: result.detail, behind });
  return { outcome: 'CHECKED', programId: fingerprint.programId, key: fingerprint.key, ok: result.ok, detail: result.detail, behind, recorded: changed };
}

let lastLookAt = Number.NEGATIVE_INFINITY;

/** The goals tick's entry: at most one look per interval, and a look that fails never stops the tick. */
export async function watchRegisterIfDue(
  nowMs: number = Date.now(),
  deps: Partial<RegisterWatchDeps> = {},
): Promise<RegisterWatchResult | null> {
  if (nowMs - lastLookAt < REGISTER_WATCH_INTERVAL_MS) return null;
  lastLookAt = nowMs;
  try {
    return await watchRegister(deps);
  } catch (error) {
    console.warn('[goals] open-questions register watch failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Tests only: forget when the tick last looked. */
export function resetRegisterWatchForTests(): void {
  lastLookAt = Number.NEGATIVE_INFINITY;
}
