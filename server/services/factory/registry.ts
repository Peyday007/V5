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
  FactoryWorkerKind,
} from '../../domain/factory.ts';
import {
  listWorkers,
  registerWorker,
  recordFactoryEvent,
  workerLoad,
  type RegisterWorkerInput,
} from '../../repos/factoryFleet.ts';
import { factoryNow } from '../../repos/factory.ts';
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
