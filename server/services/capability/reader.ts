/**
 * The identity a reading is submitted under.
 *
 * ---------------------------------------------------------------------------
 * Why this exists and what it deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * A reading has to be submitted by *somebody*, and the whole design depends on
 * Brain never being the one holding the pen: the extraction and the audit must
 * arrive as authenticated workers, through `checkIn` and the lease, so the
 * routing scope, the declared-unit check and the independence guard all decide
 * them rather than being skipped.
 *
 * So this makes a worker identity and grants it the scopes the capability bins
 * need on one project. That is a *membership*, which §26 puts at `ADMIN` on a
 * browser surface and on a terminal otherwise — and this is the terminal one:
 * reaching the shell is the authentication.
 *
 * **It does not make the reader independent.** Who runs the command decides
 * that, and `capabilityAuditLineage` decides whether it counts. Two handles are
 * two workers and two sessions, which is what the guard compares; whether two
 * different *model contexts* were behind them is a fact about the operation and
 * is not something any row here can establish. That distinction is the one
 * §23 insists on — reported at the tier it earned, never rounded up — and it is
 * why this file will not mint a credential, fire a Routine, or claim a tier.
 */
import { createHash } from 'node:crypto';
import { createWorker, getWorkerByName, grantMembership } from '../../repos/identity.ts';
import type { Principal, Worker, WorkerScope } from '../../domain/types.ts';
import { workerIdentity } from '../identity/authenticate.ts';

/**
 * What a capability bin's worker needs, and no more.
 *
 * A constant rather than a picker, for the reason §25 gives about a connected
 * site's scope set: the membership is the one with a silent wrong answer in it,
 * because a worker given the wrong scopes is refused with the same 404 a
 * missing project gives, and that tells nobody anything.
 *
 * It is deliberately its own constant and names no other. `tests/
 * operatorConsoleRemoved.test.ts` asserts that exactly one module in this
 * repository both mentions the site set and grants a membership, and it cannot
 * tell prose from code — so an explanatory sentence here that named it would
 * have tripped a guard on a security-relevant property to make a comment read
 * better. The guard is right to be crude; the comment moved.
 *
 * `research:write` is deliberately absent. A capability reading writes no
 * claim, no verification and no audit row — it submits bin units, and the
 * services behind them are the only thing that writes anything.
 */
export const CAPABILITY_READER_SCOPES: readonly WorkerScope[] = [
  'project:read',
  'documents:read',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
];

export interface Reader {
  principal: Principal;
  workerId: string;
  /** The session this run presents. Stable per handle, so a rerun is one session. */
  sessionRef: string;
}

/**
 * Make or reuse the worker a reading is submitted under.
 *
 * Idempotent by handle, so running a command twice is one identity rather than
 * two — and so the independence guard sees the same session on a retry, which
 * is the truthful answer: a retry of the extraction is not a second reader.
 */
export async function ensureReaderWorker(input: {
  handle: string;
  projectId: string;
}): Promise<Reader> {
  let worker: Worker | null = await getWorkerByName(input.handle);
  if (!worker) {
    worker = await createWorker({
      name: input.handle,
      displayName: input.handle,
      createdByType: 'SYSTEM',
      createdById: 'capability reader (shell)',
    });
  }

  await grantMembership({
    projectId: input.projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: [...CAPABILITY_READER_SCOPES],
    grantedByType: 'SYSTEM',
    grantedById: 'capability reader (shell)',
  });

  /*
   * A session reference derived from the handle.
   *
   * Stable on purpose: the independence guard compares sessions, and a value
   * that changed per invocation would let the same reader come back as a
   * "different session" simply by running the command again. That is exactly
   * the hole §23 refuses to open for the real fleet — Brain could revoke a
   * token and have the connector refresh in seconds, and would not, because it
   * would let one model context take the role it was just refused.
   */
  const sessionRef = `cse_reader_${createHash('sha256').update(input.handle).digest('hex').slice(0, 20)}`;

  return {
    workerId: worker.id,
    sessionRef,
    principal: {
      type: 'WORKER',
      id: worker.id,
      // The neutral label; a reader identity is printed beside audit
      // lineage and must not read as a person's name. See migration 072.
      handle: workerIdentity(worker),
      displayName: workerIdentity(worker),
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: sessionRef,
      authMethod: 'WORKER_BEARER',
      memberships: [
        {
          projectId: input.projectId,
          principalType: 'WORKER',
          principalId: worker.id,
          role: 'MEMBER',
          scopes: [...CAPABILITY_READER_SCOPES],
          active: true,
        } as unknown as Principal['memberships'][number],
      ],
      requestId: `req_${sessionRef}`,
    },
  };
}
