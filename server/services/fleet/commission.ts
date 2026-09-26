/**
 * Is this account ready to complete Factory work on this repository, end to end?
 *
 * One journey with one answer. Commissioning a Factory account used to be
 * nine separate discoveries — the connector identity, the Routine trigger, the
 * worker binding, the deployment token, GitHub collaborator access, the
 * Routine's repository attachment, the session's GitHub scope, the push, the
 * pull request — and the last four could only be discovered by a real build
 * failing at its last step. That is what happened on 2026-09-26: a surface that
 * read VERIFIED planned, implemented, typechecked and passed review, and then
 * could not push, because its Routine was attached to a different repository.
 *
 * So the steps are asked in the order they have to be true, every one from a
 * row Brain wrote or the forge's own account, and the first that is not true is
 * the answer. The repository-side steps are not guessed at from configuration:
 * they are the delivery probe (`services/dispatch/deliveryProof.ts`), which the
 * session Brain fired actually performs. Nothing here merges or deploys.
 */
import { getRoutineByRef, sessionsForRoutine, type WorkerSession } from '../../repos/fleet.ts';
import { getBin, listDispatchesForBin } from '../../repos/bins.ts';
import { getWorker, getWorkerRouting, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { listTokensForWorker } from '../../repos/oauth.ts';
import { listDeliveryProofs, normalizeRepository } from '../../repos/deliveryProofs.ts';
import { resolveToken } from '../dispatch/fire.ts';
import { proveSurface } from '../dispatch/surfaceProof.ts';
import { DELIVERY_REMEDY } from '../dispatch/deliveryProof.ts';
import type { Bin, BinDispatch, RoutineDeliveryProof } from '../../domain/types.ts';

export const SURFACE_TIERS = ['NONE', 'CONNECTED', 'EXECUTION_VERIFIED', 'DELIVERY_VERIFIED'] as const;
export type SurfaceTier = (typeof SURFACE_TIERS)[number];

export type StepState = 'PASS' | 'FAIL' | 'PENDING' | 'NOT_REACHED';

export interface CommissionStep {
  key: string;
  label: string;
  state: StepState;
  detail: string;
  /** What to do, when the step is not PASS. */
  remedy: string | null;
}

export interface CommissionReading {
  routineRef: string;
  repository: string;
  tier: SurfaceTier;
  ready: boolean;
  steps: CommissionStep[];
  /** The first step that is not PASS, or null when ready. */
  blocking: CommissionStep | null;
  latestProof: RoutineDeliveryProof | null;
  /** Whether a delivery probe could usefully be created now. */
  mayProbe: boolean;
  routineId: string | null;
  /** The one line an operator reads. */
  verdict: string;
}

function step(key: string, label: string, state: StepState, detail: string, remedy: string | null = null): CommissionStep {
  return { key, label, state, detail, remedy: state === 'PASS' ? null : remedy };
}

export async function readCommission(input: { routineRef: string; repository: string }): Promise<CommissionReading> {
  const repository = normalizeRepository(input.repository);
  const steps: CommissionStep[] = [];
  const routine = await getRoutineByRef(input.routineRef);
  let tier: SurfaceTier = 'NONE';
  let latestProof: RoutineDeliveryProof | null = null;

  const finish = (mayProbe: boolean): CommissionReading => {
    const blocking = steps.find((s) => s.state !== 'PASS') ?? null;
    const ready = blocking === null;
    return {
      routineRef: input.routineRef,
      repository,
      tier,
      ready,
      steps,
      blocking,
      latestProof,
      mayProbe,
      routineId: routine?.id ?? null,
      verdict: ready
        ? `READY FOR ${repository} IMPLEMENTATION — this account can complete Factory work end to end`
        : `NOT READY — ${blocking!.label}: ${blocking!.remedy ?? blocking!.detail}`,
    };
  };

  if (!routine) {
    steps.push(step('routine', 'Routine registered', 'FAIL', `No Routine ${input.routineRef} is registered.`,
      'Register it: fleet register-routine --account <account> --name <name> --ref trig_… --secret <SECRET_NAME> --capabilities repository,repository-write'));
    return finish(false);
  }
  steps.push(step('routine', 'Routine registered', 'PASS', `${routine.name} (${routine.state})`));

  steps.push(
    routine.state === 'ENABLED'
      ? step('state', 'Routine enabled', 'PASS', 'ENABLED')
      : step('state', 'Routine enabled', 'FAIL', `${routine.state}${routine.stateReason ? ` — ${routine.stateReason}` : ''}`,
          'Fix the recorded cause, then fleet set-state --kind routine --ref <trig> --to ENABLED'),
  );

  steps.push(
    resolveToken(routine.tokenSecretName)
      ? step('secret', 'Trigger token deployed', 'PASS', `${routine.tokenSecretName} is present (value never read out)`)
      : step('secret', 'Trigger token deployed', 'FAIL', `${routine.tokenSecretName} is not present in this deployment.`,
          `A Brain administrator sets the Fly secret ${routine.tokenSecretName} to the Routine's bearer token.`),
  );

  const worker = routine.workerId ? await getWorker(routine.workerId) : null;
  if (!worker) {
    steps.push(step('worker', 'Bound to a Factory worker', 'FAIL', 'This Routine is bound to no worker.',
      'fleet bind-worker --ref <trig> --worker <factory worker>'));
    return finish(false);
  }
  steps.push(
    worker.disabled
      ? step('worker', 'Bound to a Factory worker', 'FAIL', `${worker.name} is ${worker.status}.`, 'Re-enable or re-bind the worker.')
      : step('worker', 'Bound to a Factory worker', 'PASS', worker.label ?? worker.name),
  );

  const routing = await getWorkerRouting(worker.id);
  const servesRepo = routing ? routing.repositories.map(normalizeRepository).includes(repository) : false;
  const factoryOnly = routing ? routing.families.every((f) => f === 'FACTORY') && routing.families.includes('FACTORY') : false;
  steps.push(
    servesRepo && factoryOnly
      ? step('routing', 'Worker authorized for this repository', 'PASS', `families [${routing!.families.join(',')}]`)
      : step('routing', 'Worker authorized for this repository', 'FAIL',
          routing ? `serves [${routing.families.join(',')}] on [${routing.repositories.join(',')}]` : 'no routing row',
          'Onboard the repository for this worker on Build (it writes the routing row and membership).'),
  );
  const memberships = (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active);
  steps.push(
    memberships.length > 0
      ? step('membership', 'Worker is a project member', 'PASS', `${memberships.length} membership(s)`)
      : step('membership', 'Worker is a project member', 'FAIL', 'no active membership', 'Onboard the repository on Build.'),
  );

  const caps = ['repository', 'repository-write'].filter((tag) => !routine.capabilities.includes(tag));
  steps.push(
    caps.length === 0
      ? step('capabilities', 'Declares repository and repository-write', 'PASS', `[${routine.capabilities.join(',')}]`)
      : step('capabilities', 'Declares repository and repository-write', 'FAIL', `missing ${caps.join(', ')}`,
          'fleet set-capabilities --ref <trig> --capabilities repository,repository-write'),
  );

  // Connector identity and execution: the four-row chain.
  const tokens = await listTokensForWorker(worker.id);
  const sessions: WorkerSession[] = await sessionsForRoutine(routine.id, 20);
  const bins = new Map<string, Bin | null>();
  const dispatches = new Map<string, readonly BinDispatch[]>();
  for (const session of sessions) {
    if (!bins.has(session.binId)) bins.set(session.binId, await getBin(session.binId));
    if (!dispatches.has(session.binId)) dispatches.set(session.binId, await listDispatchesForBin(session.binId));
  }
  const proof = proveSurface({ boundWorkerId: worker.id, routineRef: routine.routineRef, sessions, bins, dispatches });
  const ownArrivals = sessions.filter((s) => s.workerId === worker.id).length;
  if (proof.foreignWorkerIds.length > 0) {
    steps.push(step('connector', 'Connector authenticates as this worker', 'FAIL',
      `arrivals authenticated as ${proof.foreignWorkerIds.join(', ')}`,
      'In the Routine, select the Factory Brain connector that was authorized for this worker.'));
  } else if (ownArrivals > 0) {
    tier = 'CONNECTED';
    steps.push(step('connector', 'Connector authenticates as this worker', 'PASS', `${ownArrivals} arrival(s)`));
  } else {
    steps.push(step('connector', 'Connector authenticates as this worker', tokens.length > 0 ? 'PENDING' : 'FAIL',
      tokens.length > 0 ? 'a token exists but no fired session has arrived yet' : 'no token was ever minted for this worker',
      tokens.length > 0 ? 'Run the probe (--probe) so Brain fires this Routine.' : 'Complete the Factory Brain connector OAuth flow in the account that owns the Routine.'));
  }

  // Delivery: the probe. It also closes the execution chain, since it is a pinned bin this Routine completes.
  const proofs = (await listDeliveryProofs(routine.id)).filter((p) => p.repository === repository);
  latestProof = proofs[0] ?? null;
  const settled = proofs.find((p) => p.state !== 'PENDING') ?? null;
  const pending = proofs.find((p) => p.state === 'PENDING') ?? null;

  if (proof.chain) {
    if (tier === 'CONNECTED') tier = 'EXECUTION_VERIFIED';
    steps.push(step('execution', 'Executes a Factory bin', 'PASS', `completed ${proof.chain.binId}`));
  } else {
    steps.push(step('execution', 'Executes a Factory bin', pending ? 'PENDING' : 'FAIL',
      pending ? `waiting on probe ${pending.binId}` : 'no fired session has completed a bin',
      'Run the probe (--probe); it proves execution and delivery together.'));
  }

  if (settled?.state === 'PROVEN' && !pending) {
    if (tier === 'EXECUTION_VERIFIED') tier = 'DELIVERY_VERIFIED';
    steps.push(step('delivery', `Delivers to ${repository}`, 'PASS',
      `pushed ${settled.headSha?.slice(0, 12)}, opened and closed PR #${settled.pullRequest} (${settled.settledAt})`));
  } else if (pending) {
    steps.push(step('delivery', `Delivers to ${repository}`, 'PENDING', `probe ${pending.binId} is in flight`,
      'Wait for the fired session to finish; re-read this command.'));
  } else if (settled?.state === 'FAILED') {
    const failure = settled.failureStep ?? 'FORGE_DID_NOT_CONFIRM';
    steps.push(step('delivery', `Delivers to ${repository}`, 'FAIL',
      `${failure}${settled.detail ? `: ${settled.detail}` : ''}`,
      `${DELIVERY_REMEDY[failure]} Then re-run with --probe.`));
  } else {
    steps.push(step('delivery', `Delivers to ${repository}`, 'FAIL', 'no delivery probe has ever run for this repository',
      'Run with --probe: the fired session pushes a disposable branch, opens and closes a PR, and deletes the branch.'));
  }

  const preconditions = steps.filter((s) => ['routine', 'state', 'secret', 'worker', 'routing', 'membership', 'capabilities'].includes(s.key));
  const mayProbe = preconditions.every((s) => s.state === 'PASS') && !pending && proof.foreignWorkerIds.length === 0;
  return finish(mayProbe);
}
