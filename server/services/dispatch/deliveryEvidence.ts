/**
 * Real Factory work is the evidence that a surface can deliver.
 *
 * A Routine declaring `repository-write` is intent. Whether the Claude session
 * it starts can actually push to a repository is a setting Brain cannot read —
 * the Routine's repository attachment — and production found the gap the
 * expensive way: a surface planned, implemented, typechecked and passed review,
 * and then the git proxy refused the push because its Routine was attached to a
 * different repository.
 *
 * The answer is not a ceremony in front of every surface. Brain already writes
 * the fact down every time real work lands: `UNIT_IMPLEMENTED`,
 * `INTEGRATION_MERGED` and `PR_DELIVERED` are recorded only after the forge
 * confirmed the push, and each carries the lease session of the bin that did
 * it. `routineRefsForSession` resolves that provider session to the Routine
 * Brain fired it at, from Brain's own `bin_dispatch` rows. So:
 *
 * - **PROVEN** is recorded from those events, live as each one is written and
 *   once per process over the history already in the table.
 * - **FAILED** is recorded the moment a real unit, integration or delivery
 *   report says the git proxy refused this repository — and a FAILED reading is
 *   the only thing that takes a surface out of push routing, so an unknown costs
 *   one attempt rather than a campaign's worth.
 * - **No reading** is provisional: the router lets such a surface take one
 *   write bin at a time, and that real bin proves it or refuses it.
 *
 * Attribution is exact or absent. A session that resolves to no Routine, or to
 * more than one, is credited to nobody — never to whichever Routine fired near
 * the same time. The synthetic probe (`deliveryProof.ts`) stays as the fallback
 * for a surface with no real work to prove itself on.
 */
import { getDb } from '../../db/database.ts';
import { routineRefsForSession } from '../../repos/bins.ts';
import { getRoutineByRef } from '../../repos/fleet.ts';
import { normalizeRepository, recordRealDelivery } from '../../repos/deliveryProofs.ts';
import { repositoryIdOfRemote } from '../factory/onboard.ts';
import { nowIso } from '../../repos/util.ts';

/** What a worker's blocked report says when the git proxy refused this repository. */
const ACCESS_REFUSAL =
  /authorized repository set|permission to \S+ denied|remote: permission denied|requested url returned error: 403|repository not found|git proxy.{0,80}(refus|denied|403)/i;

export function isRepositoryAccessRefusal(text: string | null | undefined): boolean {
  return typeof text === 'string' && ACCESS_REFUSAL.test(text);
}

function repositoryKey(repository: string): string {
  return repositoryIdOfRemote(repository) ?? normalizeRepository(repository);
}

/** The one Routine Brain fired this provider session at, or null when that is not exactly one. */
export async function routineForSession(sessionRef: string | null | undefined): Promise<string | null> {
  if (!sessionRef) return null;
  const refs = [...new Set(await routineRefsForSession(sessionRef))];
  if (refs.length !== 1) return null;
  const routine = await getRoutineByRef(refs[0]!);
  return routine?.id ?? null;
}

/**
 * Record what one real bin established. Returns the Routine credited, or null
 * when the session could not be attributed exactly — in which case nothing is
 * written. A FAILED reading touches the Routine so every reader of the fleet
 * sees it on the next tick.
 */
export async function recordDeliveryEvidence(input: {
  sessionRef: string | null | undefined;
  repository: string;
  /** The bin, or `evt:<event id>` for history that did not name one. */
  evidenceKey: string;
  state: 'PROVEN' | 'FAILED';
  branch?: string | null;
  headSha?: string | null;
  pullRequest?: number | null;
  detail?: string | null;
}): Promise<string | null> {
  const routineId = await routineForSession(input.sessionRef);
  if (!routineId) return null;
  const wrote = await recordRealDelivery({
    routineId,
    repository: repositoryKey(input.repository),
    binId: input.evidenceKey,
    state: input.state,
    branch: input.branch ?? null,
    headSha: input.headSha ?? null,
    pullRequest: input.pullRequest ?? null,
    failureStep: input.state === 'FAILED' ? 'REPOSITORY_NOT_IN_SESSION' : null,
    detail: input.detail ? input.detail.slice(0, 500) : null,
    requestedBy: 'brain:real-work',
  });
  // Touching the Routine is what lets the re-arm reconsider work deferred for want of a surface.
  if (wrote) await getDb().run('UPDATE fleet_routines SET updated_at = ? WHERE id = ?', [nowIso(), routineId]);
  return routineId;
}

const CONFIRMED_KINDS = ['UNIT_IMPLEMENTED', 'INTEGRATION_MERGED', 'PR_DELIVERED'] as const;

/**
 * Every confirmed push already in the ledger, credited to the Routine whose
 * session made it. Idempotent by its evidence key, so it is safe on every boot.
 */
export async function backfillDeliveryEvidence(): Promise<{ examined: number; credited: number }> {
  const rows = await getDb().all<{
    id: string;
    session_id: string | null;
    detail: string;
    repository: string;
  }>(
    `SELECT e.id, e.session_id, e.detail, r.repository
       FROM factory_events e
       JOIN factory_campaigns c ON c.id = e.campaign_id
       JOIN factory_change_requests r ON r.id = c.change_request_id
      WHERE e.kind IN (?, ?, ?)
        AND e.evidence_class = 'MEASURED'
        AND e.session_id IS NOT NULL
        AND c.execution_mode = 'REMOTE'
      ORDER BY e.at`,
    [...CONFIRMED_KINDS],
  );
  let credited = 0;
  for (const row of rows) {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      /* an unreadable detail still names the event */
    }
    const binId = typeof detail.binId === 'string' ? detail.binId : null;
    const credited1 = await recordDeliveryEvidence({
      sessionRef: row.session_id,
      repository: row.repository,
      evidenceKey: binId ?? `evt:${row.id}`,
      state: 'PROVEN',
      branch: typeof detail.branch === 'string' ? detail.branch : null,
      headSha: typeof detail.headSha === 'string' ? detail.headSha : null,
      pullRequest: typeof detail.pullRequest === 'number' ? detail.pullRequest : null,
      detail: `backfilled from ${row.id}`,
    });
    if (credited1) credited++;
  }
  return { examined: rows.length, credited };
}

let backfilled = false;

/** The backfill, once per process, from the dispatch tick. */
export async function backfillDeliveryEvidenceOnce(): Promise<void> {
  if (backfilled) return;
  backfilled = true;
  await backfillDeliveryEvidence();
}
