/**
 * Brain-only mode: paid Claude routines take only work that improves Brain
 * itself, until the owner says otherwise (§84).
 *
 * The rule is enforced in SQL, not here: `purposeAdmitsSql` sits inside
 * `claimableStateSql`, which every assigner, dispatcher and supersede pass
 * composes, and `workItemPurposeAdmits` sits in `workloadAdmission`, which
 * every work-item claim (MCP tool, HTTP route, bin drain) asks before its
 * compare-and-swap. This module holds the switch, the per-item check, and the
 * pass that tags existing bins and takes non-Brain work out of the Claude lane.
 *
 * There is one switch and one way to change it (`setBrainOnlyMode`, reached
 * from the terminal as `admin brain-only on|off --admin …`). No environment
 * variable, header, argument or prompt changes what a worker is handed.
 */
import { getDb } from '../../db/database.ts';
import { binLane, isBrainProject, type BinPurpose } from '../../domain/binPurpose.ts';
import type { WorkItemRow } from '../../domain/types.ts';
import {
  binNow,
  purposeAdmitsSql,
  purposeFor,
  recordBinEvent,
  releaseBin,
} from '../../repos/bins.ts';
import { releaseWork } from '../../repos/workQueue.ts';
import { laneConfig } from '../cheap/lane.ts';

export const BRAIN_ONLY_SWITCH = 'brain_only_mode';

/** Whether the mode is on. A missing row is ON: the default denies. */
export async function brainOnlyMode(): Promise<boolean> {
  const row = await getDb().get<{ enabled: number | string }>(
    'SELECT enabled FROM brain_switches WHERE name = ?',
    [BRAIN_ONLY_SWITCH],
  );
  if (!row) return true;
  return Number(row.enabled) === 1;
}

/** The only way to change it. `by` is the administrator it is recorded against. */
export async function setBrainOnlyMode(enabled: boolean, by: string, reason: string | null): Promise<void> {
  /*
   * §85: a restriction that displaces work must name a replacement that is
   * doing it. Turning the mode on is refused while displaced research has no
   * working free lane, and the previous route stays in force.
   */
  if (enabled && !(await brainOnlyMode())) {
    const { laneCoverage } = await import('../freeLane/coverage.ts');
    const coverage = await laneCoverage();
    if (!coverage.ready) {
      throw new Error(`Brain-only mode was not turned on, so nothing is stranded: ${coverage.reason}`);
    }
  }
  const at = binNow();
  await getDb().run(
    `INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by, reason = excluded.reason`,
    [BRAIN_ONLY_SWITCH, enabled ? 1 : 0, at, by, reason],
  );
  await recordBinEvent({
    eventType: 'BRAIN_ONLY_MODE_SET',
    outcome: enabled ? 'ON' : 'OFF',
    reason: reason ?? null,
    evidenceClass: 'MEASURED',
  });
  if (enabled) await enforceBrainOnly();
}

/**
 * Whether a work item may be claimed under the mode, from the bin that owns it.
 *
 * The owning bin is the one named by `bin_id`, or the packet's bin by
 * `orchestration_id` (every bin of one packet shares a project, so they share a
 * purpose). An item no bin owns has no purpose, and no purpose is denied.
 * One statement, switch included, so the answer is never a cached copy.
 */
export async function workItemPurposeAdmits(
  item: Pick<WorkItemRow, 'bin_id' | 'orchestration_id'> & { project_id?: string | null },
): Promise<boolean> {
  /*
   * The newest owning bin: a packet's live bin is its newest, and its spent
   * predecessors were never tagged (the retag pass reads live bins only).
   */
  const owner = item.bin_id ? 'b.id = ?' : 'b.orchestration_id = ?';
  const key = item.bin_id ?? item.orchestration_id ?? null;
  const row = key
    ? await getDb().get<{ purpose: string | null; found: number | string; mode: number | string }>(
        `SELECT
           (SELECT b.purpose FROM bins b WHERE ${owner} ORDER BY b.created_at DESC LIMIT 1) AS purpose,
           (SELECT COUNT(*) FROM bins b WHERE ${owner}) AS found,
           (SELECT COUNT(*) FROM brain_switches bs WHERE bs.name = 'brain_only_mode' AND bs.enabled = 1) AS mode`,
        [key, key],
      )
    : await getDb().get<{ purpose: string | null; found: number | string; mode: number | string }>(
        `SELECT NULL AS purpose, 0 AS found,
           (SELECT COUNT(*) FROM brain_switches bs WHERE bs.name = 'brain_only_mode' AND bs.enabled = 1) AS mode`,
        [],
      );
  const purpose = row?.purpose ?? null;
  if (purpose === 'BLOCKED_LEGAL') return false;
  const modeOn = Number(row?.mode ?? 1) > 0;
  if (!modeOn) return true;
  if (Number(row?.found ?? 0) > 0) return purpose === 'BRAIN_IMPROVEMENT';
  /*
   * No bin owns it: a queue item from before Step 10, or one the hosted
   * verifier enqueues in its own scope. The project is then the deterministic
   * rule, exactly as it is for a bin (`isBrainProject`): Brain's own and
   * technical projects are Brain work, everything else is denied. The first
   * deploy denied every bin-less item, and the verifier's queue-claim checks in
   * `verification-scope` failed with it.
   */
  if (!item.project_id) return false;
  const project = await getDb().get<{ slug: string; purpose: string }>(
    'SELECT slug, purpose FROM projects WHERE id = ?',
    [item.project_id],
  );
  return isBrainProject(project ?? null);
}

/** Bins still able to be handed out again: everything not finished for good. */
const LIVE_STATES = ['DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN'] as const;

export interface EnforceReport {
  tagged: number;
  binLeasesReleased: number;
  itemLeasesReleased: number;
  parked: Record<string, number>;
}

/**
 * Tag every live bin that has no purpose, then — under the mode — take every
 * non-Brain bin out of the Claude lane: release the lease a routine holds on it
 * and on its work items, and record where it was parked.
 *
 * Idempotent by rows: a tagged bin is never re-tagged, a parked bin is recorded
 * once, and a released lease is gone. Run at boot and on every dispatch tick, so
 * nothing slips back in. Records events only; it notifies nobody (§84).
 */
export async function enforceBrainOnly(): Promise<EnforceReport> {
  const db = getDb();
  const report: EnforceReport = { tagged: 0, binLeasesReleased: 0, itemLeasesReleased: 0, parked: {} };
  const marks = LIVE_STATES.map(() => '?').join(', ');

  const untagged = await db.all<{
    id: string;
    project_id: string;
    kind: string;
    workload_class: string | null;
    completion_contract: string;
    title: string;
    objective: string;
    rationale: string | null;
    manifest: string;
  }>(
    `SELECT id, project_id, kind, workload_class, completion_contract, title, objective, rationale, manifest
       FROM bins WHERE purpose IS NULL AND state IN (${marks}) LIMIT 500`,
    [...LIVE_STATES],
  );
  const mode = await brainOnlyMode();
  for (const row of untagged) {
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(row.manifest) as Record<string, unknown>;
    } catch {
      manifest = {};
    }
    const decision = await purposeFor({
      projectId: row.project_id,
      kind: row.kind,
      workloadClass: row.workload_class,
      completionContract: row.completion_contract,
      title: row.title,
      objective: row.objective,
      rationale: row.rationale,
      manifest,
    });
    const updated = await db.run(
      'UPDATE bins SET purpose = ?, purpose_basis = ?, updated_at = ? WHERE id = ? AND purpose IS NULL',
      [decision.purpose, decision.basis, binNow(), row.id],
    );
    if (updated.changes !== 1) continue;
    report.tagged += 1;
    const lane = binLane(decision.purpose, mode, laneConfig() !== null);
    await recordBinEvent({
      eventType: lane === 'CLAUDE' ? 'BIN_PURPOSE_TAGGED' : 'BIN_PARKED',
      binId: row.id,
      projectId: row.project_id,
      outcome: lane === 'CLAUDE' ? decision.purpose : lane,
      reason: `${decision.purpose} by ${decision.basis}`,
      evidenceClass: 'MEASURED',
    });
    if (lane !== 'CLAUDE') report.parked[lane] = (report.parked[lane] ?? 0) + 1;
  }

  // Leases on bins the Claude lane may no longer hold. Legal bins always; the rest under the mode.
  const held = await db.all<{
    id: string;
    project_id: string;
    lease_id: string;
    lease_generation: number;
    worker_id: string;
    orchestration_id: string | null;
    purpose: string | null;
  }>(
    `SELECT id, project_id, lease_id, lease_generation, worker_id, orchestration_id, purpose
       FROM bins
      WHERE state = 'LEASED' AND lease_id IS NOT NULL AND worker_id IS NOT NULL
        AND NOT ${purposeAdmitsSql('')}`,
    [],
  );
  const now = binNow();
  for (const bin of held) {
    const lane = binLane((bin.purpose ?? null) as BinPurpose | null, mode, laneConfig() !== null);
    const outcome = await releaseBin(
      { binId: bin.id, leaseId: bin.lease_id, leaseGeneration: bin.lease_generation, workerId: bin.worker_id },
      `Taken out of the Claude lane by brain-only mode: ${bin.purpose ?? 'UNCLASSIFIED'} is ${lane}.`,
    );
    if (outcome === 'OK') report.binLeasesReleased += 1;
  }

  // Work-item leases under bins that are not admissible, wherever they were claimed from.
  const items = await db.all<{
    id: string;
    worker_id: string;
    lease_id: string;
    lease_generation: number;
  }>(
    `SELECT w.id, w.worker_id, w.lease_id, w.lease_generation
       FROM work_items w
      WHERE w.state = 'LEASED' AND w.lease_id IS NOT NULL AND w.worker_id IS NOT NULL
        AND w.lease_expires_at > ?
        -- The free research lane's own workers hold these by design (§85).
        AND w.worker_id NOT IN (SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))
        AND EXISTS (SELECT 1 FROM bins b
                     WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
                       AND NOT ${purposeAdmitsSql('b.')})`,
    [now],
  );
  for (const item of items) {
    const result = await releaseWork(
      { workItemId: item.id, workerId: item.worker_id, leaseId: item.lease_id, leaseGeneration: item.lease_generation },
      'Taken out of the Claude lane by brain-only mode (§84).',
    );
    if (result.ok) report.itemLeasesReleased += 1;
  }
  return report;
}

/** What `admin brain-only show` prints: the switch and every live bin by lane. */
export async function brainOnlyReading(): Promise<{
  mode: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  lanes: Array<{ purpose: string; state: string; lane: string; n: number }>;
}> {
  const db = getDb();
  const mode = await brainOnlyMode();
  const sw = await db.get<{ updated_at: string; updated_by: string }>(
    'SELECT updated_at, updated_by FROM brain_switches WHERE name = ?',
    [BRAIN_ONLY_SWITCH],
  );
  const marks = LIVE_STATES.map(() => '?').join(', ');
  const rows = await db.all<{ purpose: string | null; state: string; n: number | string }>(
    `SELECT purpose, state, COUNT(*) AS n FROM bins WHERE state IN (${marks}) GROUP BY purpose, state`,
    [...LIVE_STATES],
  );
  return {
    mode,
    updatedAt: sw?.updated_at ?? null,
    updatedBy: sw?.updated_by ?? null,
    lanes: rows
      .map((row) => ({
        purpose: row.purpose ?? 'UNCLASSIFIED',
        state: row.state,
        lane: binLane((row.purpose ?? null) as BinPurpose | null, mode, laneConfig() !== null),
        n: Number(row.n),
      }))
      .sort((a, b) => a.purpose.localeCompare(b.purpose) || a.state.localeCompare(b.state)),
  };
}

/** One bin's purpose and lane, for `admin brain-only show <bin>`. */
export async function binPurposeReading(
  binId: string,
): Promise<{ id: string; state: string; purpose: string | null; basis: string | null; lane: string; leased: boolean } | null> {
  const row = await getDb().get<{ id: string; state: string; purpose: string | null; purpose_basis: string | null; lease_id: string | null }>(
    'SELECT id, state, purpose, purpose_basis, lease_id FROM bins WHERE id = ?',
    [binId],
  );
  if (!row) return null;
  const mode = await brainOnlyMode();
  return {
    id: row.id,
    state: row.state,
    purpose: row.purpose,
    basis: row.purpose_basis,
    lane: binLane((row.purpose ?? null) as BinPurpose | null, mode, laneConfig() !== null),
    leased: row.state === 'LEASED' && row.lease_id !== null,
  };
}
