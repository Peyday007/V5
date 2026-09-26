/**
 * Record that a Routine has passed a delivery probe for a repository.
 *
 * For fixtures whose subject is not delivery verification but which fire work
 * that pushes: since 2026-09-26 a bin requiring `repository-write` is fired only
 * at a Routine whose newest settled delivery probe for that repository is PROVEN
 * (`deliveryProvenFor`). A fixture that models a working Factory surface has to
 * model *that* too, or it is modelling the surface that could not push. The
 * probe itself is exercised end to end in `tests/deliveryProof.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../../server/db/database.ts';
import { normalizeRepository } from '../../server/repos/deliveryProofs.ts';

export async function recordDeliveryProven(routineId: string, repository: string): Promise<void> {
  const at = new Date().toISOString();
  const nonce = randomUUID().replace(/-/g, '').slice(0, 12);
  await getDb().run(
    `INSERT INTO routine_delivery_proofs
       (id, routine_id, repository, bin_id, state, branch, probe_path, head_sha, pull_request,
        requested_by, created_at, settled_at)
     VALUES (?, ?, ?, ?, 'PROVEN', ?, ?, ?, 1, 'test-fixture', ?, ?)`,
    [
      `rdp_${nonce}`,
      routineId,
      normalizeRepository(repository),
      `bin_fixture_${nonce}`,
      `factory-verify/fixture/${nonce}`,
      `.factory-verify/${nonce}.md`,
      'f'.repeat(40),
      at,
      at,
    ],
  );
}

/**
 * Record a passing probe for every repository the Routine's bound worker is
 * routed to — a fixture's "this surface works" for a worker that may serve
 * several. A Routine without `repository-write` gets nothing: it is not a
 * surface that could have delivered.
 */
export async function recordDeliveryProvenForWorker(
  routineId: string,
  workerId: string,
  capabilities: readonly string[],
): Promise<void> {
  if (!capabilities.includes('repository-write')) return;
  const { getWorkerRouting } = await import('../../server/repos/identity.ts');
  const routing = await getWorkerRouting(workerId);
  for (const repository of routing?.repositories ?? []) {
    await recordDeliveryProven(routineId, repository);
  }
}
