/**
 * What each Routine has been shown to be able to deliver, per repository.
 *
 * Append-only rows written by `services/dispatch/deliveryProof.ts`. The reading
 * for a (routine, repository) pair is its newest *settled* row, so a later
 * FAILED always outranks an earlier PROVEN — a surface whose Claude Routine was
 * re-pointed at another repository stops being deliverable the moment a probe
 * says so, and nothing about the older proof lingers as capacity.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  DeliveryFailureStep,
  DeliveryProofState,
  RoutineDeliveryProof,
  RoutineDeliveryProofRow,
} from '../domain/types.ts';

function map(row: RoutineDeliveryProofRow): RoutineDeliveryProof {
  return {
    id: row.id,
    routineId: row.routine_id,
    repository: row.repository,
    binId: row.bin_id,
    state: row.state,
    branch: row.branch,
    probePath: row.probe_path,
    headSha: row.head_sha,
    pullRequest: row.pull_request === null ? null : Number(row.pull_request),
    failureStep: (row.failure_step as DeliveryFailureStep | null) ?? null,
    detail: row.detail,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/** Canonical `owner/name`, lower-cased, so two spellings are one repository. */
export function normalizeRepository(repository: string): string {
  return repository
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export async function createDeliveryProof(input: {
  routineId: string;
  repository: string;
  binId: string;
  branch: string;
  probePath: string;
  requestedBy: string;
}): Promise<RoutineDeliveryProof> {
  const id = newId('rdp');
  await getDb().run(
    `INSERT INTO routine_delivery_proofs
       (id, routine_id, repository, bin_id, state, branch, probe_path, requested_by, created_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
    [
      id,
      input.routineId,
      normalizeRepository(input.repository),
      input.binId,
      input.branch,
      input.probePath,
      input.requestedBy,
      nowIso(),
    ],
  );
  return (await getDeliveryProof(id))!;
}

export async function getDeliveryProof(id: string): Promise<RoutineDeliveryProof | null> {
  const row = await getDb().get<RoutineDeliveryProofRow>(
    'SELECT * FROM routine_delivery_proofs WHERE id = ?',
    [id],
  );
  return row ? map(row) : null;
}

export async function getDeliveryProofByBin(binId: string): Promise<RoutineDeliveryProof | null> {
  const row = await getDb().get<RoutineDeliveryProofRow>(
    'SELECT * FROM routine_delivery_proofs WHERE bin_id = ?',
    [binId],
  );
  return row ? map(row) : null;
}

export async function listPendingDeliveryProofs(): Promise<RoutineDeliveryProof[]> {
  const rows = await getDb().all<RoutineDeliveryProofRow>(
    "SELECT * FROM routine_delivery_proofs WHERE state = 'PENDING' ORDER BY created_at",
  );
  return rows.map(map);
}

export async function listDeliveryProofs(routineId?: string): Promise<RoutineDeliveryProof[]> {
  const rows = routineId
    ? await getDb().all<RoutineDeliveryProofRow>(
        'SELECT * FROM routine_delivery_proofs WHERE routine_id = ? ORDER BY created_at DESC',
        [routineId],
      )
    : await getDb().all<RoutineDeliveryProofRow>(
        'SELECT * FROM routine_delivery_proofs ORDER BY created_at DESC',
      );
  return rows.map(map);
}

/**
 * Settle a pending proof. Guarded on PENDING in the statement that makes the
 * change, so two ticks reading one completed probe produce one verdict and an
 * ordinary loser.
 */
export async function settleDeliveryProof(input: {
  id: string;
  state: Exclude<DeliveryProofState, 'PENDING'>;
  headSha?: string | null;
  pullRequest?: number | null;
  failureStep?: DeliveryFailureStep | null;
  detail?: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE routine_delivery_proofs
        SET state = ?, head_sha = ?, pull_request = ?, failure_step = ?, detail = ?, settled_at = ?
      WHERE id = ? AND state = 'PENDING'`,
    [
      input.state,
      input.headSha ?? null,
      input.pullRequest ?? null,
      input.failureStep ?? null,
      input.detail ?? null,
      nowIso(),
      input.id,
    ],
  );
  return result.changes > 0;
}

/**
 * The newest settled reading per (routine, repository), as a set of
 * repositories each Routine is *currently* proven to deliver to. A Routine
 * whose newest settled probe failed is absent, whatever it proved before.
 */
export async function deliveryProvenRepositories(): Promise<Map<string, Set<string>>> {
  const rows = await getDb().all<RoutineDeliveryProofRow>(
    `SELECT * FROM routine_delivery_proofs
      WHERE state IN ('PROVEN', 'FAILED')
      ORDER BY routine_id, repository, settled_at DESC, created_at DESC`,
  );
  const seen = new Set<string>();
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.routine_id}\u0000${row.repository}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.state !== 'PROVEN') continue;
    const set = out.get(row.routine_id) ?? new Set<string>();
    set.add(row.repository);
    out.set(row.routine_id, set);
  }
  return out;
}
