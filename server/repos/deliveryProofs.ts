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
  DeliveryProofSource,
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
    source: row.source ?? 'PROBE',
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
  state: 'PROVEN' | 'FAILED';
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
 * Record what a real Factory bin established about a Routine's delivery.
 *
 * Settled at birth: PROVEN only from an event Brain wrote after the forge
 * confirmed the push (`UNIT_IMPLEMENTED`, `INTEGRATION_MERGED`,
 * `PR_DELIVERED`), FAILED only from a worker's report that the git proxy
 * refused this repository. One row per bin, so a bin read on every tick, and
 * the history backfill run on every tick, record once.
 */
export async function recordRealDelivery(input: {
  routineId: string;
  repository: string;
  binId: string;
  state: 'PROVEN' | 'FAILED';
  branch?: string | null;
  headSha?: string | null;
  pullRequest?: number | null;
  failureStep?: DeliveryFailureStep | null;
  detail?: string | null;
  requestedBy: string;
}): Promise<boolean> {
  const now = nowIso();
  const result = await getDb().run(
    `INSERT INTO routine_delivery_proofs
       (id, routine_id, repository, bin_id, source, state, branch, probe_path, head_sha,
        pull_request, failure_step, detail, requested_by, created_at, settled_at)
     VALUES (?, ?, ?, ?, 'REAL_WORK', ?, ?, '', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (bin_id) DO NOTHING`,
    [
      newId('rdp'),
      input.routineId,
      normalizeRepository(input.repository),
      input.binId,
      input.state,
      input.branch ?? '',
      input.headSha ?? null,
      input.pullRequest ?? null,
      input.failureStep ?? null,
      input.detail ?? null,
      input.requestedBy,
      now,
      now,
    ],
  );
  return result.changes > 0;
}

export type DeliveryReading = 'PROVEN' | 'FAILED';

/**
 * A person saying the cause of a refusal was fixed — the repository attached to
 * the Claude Routine. It proves nothing: it only returns the pair to
 * provisional, so the next real implementation proves or refuses it. Refused
 * unless the newest reading is FAILED, so it can never erase a proof.
 */
export async function clearDeliveryRefusal(input: {
  routineId: string;
  repository: string;
  reason: string;
  requestedBy: string;
}): Promise<boolean> {
  const repository = normalizeRepository(input.repository);
  const current = (await deliveryReadings()).get(input.routineId)?.get(repository);
  if (current !== 'FAILED') return false;
  const now = nowIso();
  const id = newId('rdp');
  await getDb().run(
    `INSERT INTO routine_delivery_proofs
       (id, routine_id, repository, bin_id, source, state, branch, probe_path, detail,
        requested_by, created_at, settled_at)
     VALUES (?, ?, ?, ?, 'REAL_WORK', 'CLEARED', '', '', ?, ?, ?, ?)`,
    [id, input.routineId, repository, `clear:${id}`, input.reason.slice(0, 500), input.requestedBy, now, now],
  );
  await getDb().run('UPDATE fleet_routines SET updated_at = ? WHERE id = ?', [now, input.routineId]);
  return true;
}

/**
 * The newest settled reading per (routine, repository). A pair with no entry
 * has no reading at all, which is *provisional*, not refused: the first real
 * implementation is what proves it. A later FAILED outranks an earlier PROVEN.
 */
export async function deliveryReadings(): Promise<Map<string, Map<string, DeliveryReading>>> {
  const rows = await getDb().all<RoutineDeliveryProofRow>(
    `SELECT * FROM routine_delivery_proofs
      WHERE state IN ('PROVEN', 'FAILED', 'CLEARED')
      ORDER BY routine_id, repository, settled_at DESC, created_at DESC`,
  );
  const out = new Map<string, Map<string, DeliveryReading>>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.routine_id}\u0000${row.repository}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // CLEARED is the newest word and it says nothing is known: provisional.
    if (row.state === 'CLEARED') continue;
    const readings = out.get(row.routine_id) ?? new Map<string, DeliveryReading>();
    readings.set(row.repository, row.state as DeliveryReading);
    out.set(row.routine_id, readings);
  }
  return out;
}

/** Kept for readers that only ask what is proven. */
export async function deliveryProvenRepositories(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const [routineId, readings] of await deliveryReadings()) {
    const proven = [...readings].filter(([, state]) => state === 'PROVEN').map(([repo]) => repo);
    if (proven.length > 0) out.set(routineId, new Set(proven));
  }
  return out;
}
