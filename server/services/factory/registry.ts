/**
 * The worker registry, and what the fleet can currently do.
 *
 * §23's distinction, at the factory's altitude: **an account is not a worker and
 * a worker is not a slot.** An account holds an allowance; a worker is an
 * identity that can execute; a slot is one concurrent execution that worker is
 * allowed to hold. Multiplying a plan label by a guess is how a fleet gets
 * sized on a fiction, so nothing in this file does arithmetic on
 * `declared_plan_power` or anything like it. Capacity is counted from rows:
 * registered workers, their declared concurrency, and the sessions currently
 * running.
 *
 * **Adding a worker is registration, never a code change.** `kind` selects an
 * executor that already exists, and a kind nothing implements is refused here
 * rather than discovered at dispatch — a registry that accepted a worker nobody
 * could run would report capacity the factory does not have.
 *
 * What this module will not do is create a worker by itself. Brain never mints
 * its own workers: a surface that can authorize non-interactively is granted
 * where the worker runs, by a person, and the factory's side of it is a row
 * somebody asked for.
 */
import type {
  FactoryCapability,
  FactoryModelClass,
  FactoryRole,
  FactoryWorker,
  FactoryWorkerAvailability,
  FactoryWorkerKind,
} from '../../domain/factory.ts';
import { FACTORY_WORKER_AVAILABILITY } from '../../domain/factory.ts';
import {
  listWorkers,
  registerWorker,
  recordFactoryEvent,
  setWorkerAvailability,
  workerLoad,
  type RegisterWorkerInput,
} from '../../repos/factoryFleet.ts';
import { factoryNow } from '../../repos/factory.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { executorKinds, probeExecutor } from './executors/index.ts';

/** Which capability each role needs. One table, so a role cannot mean two things. */
export const CAPABILITY_FOR_ROLE: Record<FactoryRole, FactoryCapability> = {
  ARCHITECT: 'ARCHITECT',
  IMPLEMENTER: 'IMPLEMENT',
  REVIEWER: 'REVIEW',
  INTEGRATOR: 'INTEGRATE',
  VERIFIER: 'VERIFY',
};

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Register a worker.
 *
 * Refuses a kind no executor implements, and refuses a capability set that
 * claims nothing: a worker that can do nothing is a row that makes the fleet
 * look larger than it is.
 */
export async function register(input: RegisterWorkerInput): Promise<FactoryWorker> {
  const kinds = executorKinds();
  if (!kinds.includes(input.kind)) {
    throw new RegistryError(
      `No executor implements worker kind ${input.kind}. Registered kinds: ${kinds.join(', ')}.`,
    );
  }
  if (input.capabilities.length === 0) {
    throw new RegistryError('A worker with no capabilities is capacity the factory does not have.');
  }
  const { worker, created } = await registerWorker(input);
  await recordFactoryEvent({
    workerId: worker.id,
    accountRef: worker.accountRef,
    kind: created ? 'WORKER_REGISTERED' : 'WORKER_ALREADY_REGISTERED',
    evidenceClass: 'MEASURED',
    detail: {
      name: worker.name,
      kind: worker.kind,
      capabilities: worker.capabilities,
      maxConcurrency: worker.maxConcurrency,
      // The *name* of a secret, never its value, and only ever whether a digest
      // exists. A registry projection that could leak a credential would leak it
      // into every capacity report.
      credentialRef: worker.credentialRef,
      credentialRecorded: worker.credentialDigest !== null,
    },
  });
  return worker;
}

/* ------------------------------------------------------------------------- */
/* The answering transition                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Why a person moved a worker's availability.
 *
 * A closed set rather than free text, for the reason `step10.ts` already wrote
 * down about regranting attempts: a caller that can write its own audit trail
 * is a caller whose audit trail says whatever it wanted. An operator action
 * with no truthful cause recorded is invariant 3 again.
 *
 * There is deliberately no reason meaning *it should be fine now*. Every entry
 * names something that was actually done or observed, because restoring a
 * worker resets the failure streak that quarantined it, and doing that on a
 * hunch is how the same three failures happen again with the record saying
 * somebody fixed it.
 */
export const WORKER_STATE_REASONS = {
  /** The credential, the executor or the machine it runs on was repaired. */
  surfaceRepaired: 'SURFACE_REPAIRED',
  /** The failures were a defect in the factory, and the fix is deployed. */
  defectFixed: 'DEFECT_FIXED',
  /** Taken out of rotation deliberately — maintenance, a migration, a spend cap. */
  withdrawnByOperator: 'WITHDRAWN_BY_OPERATOR',
  /** Put back after being withdrawn, with nothing else having changed. */
  returnedToRotation: 'RETURNED_TO_ROTATION',
  /** Held back on an operator's own reading rather than on the failure counter. */
  heldByOperator: 'HELD_BY_OPERATOR',
} as const;

export type WorkerStateReason =
  (typeof WORKER_STATE_REASONS)[keyof typeof WORKER_STATE_REASONS];

export interface SetAvailabilityOutcome {
  moved: boolean;
  worker: FactoryWorker;
  note: string;
}

/**
 * Move one worker between availability states, on an operator's authority.
 *
 * The guard, the streak reset and the refusal to touch `rate_limited_until` all
 * live in `setWorkerAvailability`, where they are one statement. What is here
 * is the vocabulary, the refusal to act on a reading that has moved, and the
 * ledger row — because a transition nothing recorded is one nobody can ask
 * about afterwards, which is the defect three doors along in this same loop.
 */
export async function setAvailability(input: {
  name: string;
  to: FactoryWorkerAvailability;
  reason: WorkerStateReason;
  actorRef: string;
}): Promise<SetAvailabilityOutcome> {
  if (!FACTORY_WORKER_AVAILABILITY.includes(input.to)) {
    throw new RegistryError(
      `"${input.to}" is not an availability a worker can hold. The set is fixed in code: ` +
        `${FACTORY_WORKER_AVAILABILITY.join(', ')}.`,
    );
  }
  const worker = (await listWorkers()).find((candidate) => candidate.name === input.name);
  if (!worker) throw new RegistryError(`No worker is registered as ${input.name}.`);

  const from = worker.availability;
  if (from === input.to) {
    // Not a failure and not a move. Said plainly, because an operator who reads
    // "moved" here would believe a quarantine had been lifted that never was.
    return {
      moved: false,
      worker,
      note: `${worker.name} is already ${from}, so nothing was written.`,
    };
  }

  const moved = await setWorkerAvailability(worker.id, from, input.to);
  if (!moved) {
    // The guard is on the state the operator named, so a loss here means the row
    // changed between the read and the write — another operator, or a third
    // failure landing in between. Refused rather than retried against whatever
    // it is now, because the decision was about the state that was read.
    throw new RegistryError(
      `${worker.name} was ${from} when this was read and is not any more, so nothing was ` +
        'changed. Read it again and decide against what it says now.',
    );
  }

  await recordFactoryEvent({
    workerId: worker.id,
    accountRef: worker.accountRef,
    kind: FACTORY_EVENT_KINDS.workerStateChanged,
    evidenceClass: 'MEASURED',
    detail: {
      name: worker.name,
      from,
      to: input.to,
      reason: input.reason,
      // Attribution rather than authentication — §23's column pair. Reaching the
      // shell is what authenticated this; the actor is whose authority it
      // carries, and Brain cannot check that it was them.
      actorRef: input.actorRef,
      streakReset: from === 'QUARANTINED',
    },
  });

  const refreshed =
    (await listWorkers()).find((candidate) => candidate.id === worker.id) ?? worker;
  return {
    moved: true,
    worker: refreshed,
    note:
      `${worker.name} ${from} -> ${input.to} (${input.reason}).` +
      (from === 'QUARANTINED'
        ? ' Its failure streak is back to zero, so three more failures would quarantine it' +
          ' again rather than the next one.'
        : '') +
      (refreshed.rateLimitedUntil !== null
        ? ` It is still deferred by provider backpressure until ${refreshed.rateLimitedUntil},` +
          ' which is the provider\'s ceiling rather than this decision.'
        : ''),
  };
}

/* ------------------------------------------------------------------------- */
/* Capacity                                                                   */
/* ------------------------------------------------------------------------- */

export interface WorkerSlot {
  workerId: string;
  name: string;
  kind: FactoryWorkerKind;
  accountRef: string;
  model: string;
  modelClass: FactoryModelClass | 'EITHER';
  capabilities: FactoryCapability[];
  /** Declared concurrency minus sessions actually running, counted from rows. */
  freeSlots: number;
  running: number;
  availability: FactoryWorker['availability'];
  rateLimitedUntil: string | null;
}

export interface CapacitySnapshot {
  at: string;
  slots: WorkerSlot[];
  /** Slots a unit could be handed right now. */
  available: number;
  /** Everything registered, whatever its state. */
  registered: number;
  /** Deferred by provider backpressure rather than broken. */
  rateLimited: number;
  quarantined: number;
  paused: number;
  /**
   * What the factory knows about its own ceiling.
   *
   * DERIVED while it is the sum of declared concurrency; MEASURED only once a
   * campaign has actually run that many lanes at the same time. A ceiling nobody
   * has observed is not a measurement, and this field is where that distinction
   * is kept rather than implied.
   */
  ceilingEvidence: 'DERIVED' | 'MEASURED' | 'UNKNOWN';
}

export async function capacity(repository?: string): Promise<CapacitySnapshot> {
  const at = factoryNow();
  const workers = await listWorkers();
  const load = await workerLoad();

  const slots: WorkerSlot[] = [];
  let rateLimited = 0;
  let quarantined = 0;
  let paused = 0;

  for (const worker of workers) {
    if (worker.availability === 'QUARANTINED') quarantined += 1;
    if (worker.availability === 'PAUSED') paused += 1;
    const limited = worker.rateLimitedUntil !== null && worker.rateLimitedUntil > at;
    if (limited) rateLimited += 1;

    // A worker that may not touch this repository is not capacity for this
    // campaign. Read from the row, never from anything the worker said.
    if (
      repository &&
      worker.repositories.length > 0 &&
      !worker.repositories.includes(repository) &&
      !worker.repositories.includes('*')
    ) {
      continue;
    }

    const running = load.get(worker.id) ?? 0;
    const healthy = worker.availability === 'AVAILABLE' && !limited;
    slots.push({
      workerId: worker.id,
      name: worker.name,
      kind: worker.kind,
      accountRef: worker.accountRef,
      model: worker.model,
      modelClass: worker.modelClass,
      capabilities: worker.capabilities,
      freeSlots: healthy ? Math.max(0, worker.maxConcurrency - running) : 0,
      running,
      availability: worker.availability,
      rateLimitedUntil: worker.rateLimitedUntil,
    });
  }

  return {
    at,
    slots,
    available: slots.reduce((sum, slot) => sum + slot.freeSlots, 0),
    registered: workers.length,
    rateLimited,
    quarantined,
    paused,
    ceilingEvidence: workers.length === 0 ? 'UNKNOWN' : 'DERIVED',
  };
}

/**
 * Can anything actually run?
 *
 * Answered as an operational fact with an operational remedy, which is the
 * blocker §23 insists on: a fleet with nowhere to run says
 * `NO_HEALTHY_EXECUTION_SURFACE` and names what to register, never a person and
 * never a missing account.
 */
export async function readiness(
  repository?: string,
): Promise<{ ready: boolean; reason: string; snapshot: CapacitySnapshot }> {
  const snapshot = await capacity(repository);
  if (snapshot.registered === 0) {
    return {
      ready: false,
      reason:
        'NO_HEALTHY_EXECUTION_SURFACE: no worker is registered. Register one with the factory ' +
        'registry; adding a worker is a row, not a code change.',
      snapshot,
    };
  }
  if (snapshot.available === 0) {
    const parts: string[] = [];
    if (snapshot.rateLimited > 0) parts.push(`${snapshot.rateLimited} rate-limited`);
    if (snapshot.quarantined > 0) parts.push(`${snapshot.quarantined} quarantined`);
    if (snapshot.paused > 0) parts.push(`${snapshot.paused} paused`);
    const busy = snapshot.slots.reduce((sum, slot) => sum + slot.running, 0);
    if (busy > 0) parts.push(`${busy} running`);
    return {
      ready: false,
      reason: `NO_HEALTHY_EXECUTION_SURFACE: every slot is unavailable (${parts.join(', ') || 'no free slot'}).`,
      snapshot,
    };
  }
  return { ready: true, reason: 'At least one slot is free.', snapshot };
}

/**
 * Does the surface a registered worker needs actually exist on this machine?
 *
 * Separate from whether the factory's own code works, for the reason §16 gives
 * about the research engine and the worker: passing your own tests against a
 * scripted provider says nothing about whether the tool runs here. The probe is
 * reported, never inferred, and a worker whose surface is missing is reported
 * unusable rather than discovered mid-campaign.
 */
export async function probeFleet(): Promise<
  { workerId: string; name: string; kind: FactoryWorkerKind; ok: boolean; detail: string }[]
> {
  const workers = await listWorkers();
  const results: {
    workerId: string;
    name: string;
    kind: FactoryWorkerKind;
    ok: boolean;
    detail: string;
  }[] = [];
  const byKind = new Map<FactoryWorkerKind, { ok: boolean; detail: string }>();
  for (const worker of workers) {
    let probe = byKind.get(worker.kind);
    if (!probe) {
      probe = await probeExecutor(worker.kind);
      byKind.set(worker.kind, probe);
    }
    results.push({
      workerId: worker.id,
      name: worker.name,
      kind: worker.kind,
      ok: probe.ok,
      detail: probe.detail,
    });
  }
  return results;
}
