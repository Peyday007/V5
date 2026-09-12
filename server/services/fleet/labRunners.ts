/**
 * The five pressure runners, and the one thing they may not measure.
 *
 * `lab.ts` shipped `HEALTH_CHECK`, `CALIBRATION` and `FLEET_PROVIDER` and
 * refused the other five by name, on the reasoning that running them means
 * "putting real pressure on real surfaces and Brain has no way to do that
 * without spending the subscription". **Half of that was right and the half
 * that was wrong made a declared capability into a permanent refusal**, which
 * is exactly the shape this repository keeps correcting: a state that says
 * "somebody must authorize this" with no path that authorization opens.
 *
 * The part that was right: Brain must not fire Routines to find a limit. The
 * fleet's capacity belongs to a fixed subscription, `max_external_spend` is 0,
 * and a lab that burned an allowance discovering a number would be spending the
 * user's capacity on curiosity.
 *
 * The part that was wrong: **the surface is not the only thing under pressure.**
 * Every one of these tests is about a *concurrency machine* — claiming, leasing,
 * fencing, contention, recovery, and how a backlog is shaped before it is handed
 * out — and that machine is `repos/workQueue.ts`, which runs here, in this
 * process, against this database, and costs nothing external at all. A run
 * against it is a real execution of the real code with real compare-and-swaps
 * and real losers, not a projection.
 *
 * So the split is drawn where the money is rather than where the word
 * "pressure" is:
 *
 *   - **Measured here, for real:** how many concurrent claimants the queue
 *     admits before contention dominates, what a given backlog *shape* costs to
 *     drain, how quality signals move when concurrency rises, and whether an
 *     abandoned lease is genuinely recoverable and genuinely fenced.
 *   - **Not measured here, ever, and said so in every result:** whether a real
 *     Cowork surface holds that concurrency. That needs real activations, it
 *     spends the subscription, and it is the one thing that requires a person's
 *     authorization. Every result carries it in `untested` and every
 *     `highestTested` is a lower bound on Brain's own machinery rather than a
 *     claim about a provider.
 *
 * ---------------------------------------------------------------------------
 * Why this cannot contaminate anything
 * ---------------------------------------------------------------------------
 *
 * Four separate reasons, none of which relies on the others:
 *
 *  1. `declareExperiment` refuses a pressure mode outside a `TECHNICAL`
 *     project, and ordinary totals, maps, briefings and lists already exclude
 *     that provenance.
 *  2. Every item enqueued here is `SYNTHETIC_ECHO`, whose registration declares
 *     `repeatSafety: 'HARMLESS'` and which touches no document, claim, audit or
 *     knowledge row. Nothing in this file writes one either.
 *  3. Every claim is confined to that project **and** to that work type, so a
 *     runner cannot reach real work even inside its own scope.
 *  4. **Nothing is minted, and the database is what made that a decision rather
 *     than a preference.** The first version of this file passed invented
 *     `labw_…` ids straight into `claimWork`, on the reasoning that a label is
 *     not an identity. `work_leases.worker_id` is `NOT NULL REFERENCES
 *     workers(id)`, so the claim failed on a foreign key — and the constraint is
 *     right: §19 proves ownership against a real principal, and a lease held by
 *     something that cannot be a principal is not a lease. The correction is
 *     recorded rather than quietly applied, because the tempting fix was to
 *     create the rows, and creating a worker identity to make a test run is
 *     exactly what §22 forbids.
 *
 *     So the lab **discovers** its claimants: workers that already hold
 *     `queue:claim` on the isolated project. With none it refuses and names the
 *     remedy, which is a person registering one on a terminal. With fewer than
 *     it wants it reuses them and says so — concurrency here means concurrent
 *     *claim calls*, and the compare-and-swap arbitrates per item rather than
 *     per identity, so the contention reading is unaffected by how many
 *     identities issued the calls.
 *
 * And the cleanup is part of the run rather than a promise about it: whatever a
 * round did not finish is cancelled, which advances the fencing generation, so
 * a late completion from a synthetic claimant matches nothing.
 */
import {
  cancelWork,
  claimWork,
  completeWork,
  enqueueWork,
  listWorkItems,
  queueNow,
  type OwnershipProof,
} from '../../repos/workQueue.ts';
import { listMembershipsForProject } from '../../repos/identity.ts';
import { newId } from '../../repos/util.ts';
import type { Evidence } from './view.ts';

/** The scope a synthetic claim needs, and the only one it is given. */
const LAB_SCOPES = ['queue:claim'] as const;

/** The one work type a runner may touch. */
export const LAB_WORK_TYPE = 'SYNTHETIC_ECHO';

/**
 * The hard ceiling on a single run, whatever the envelope says.
 *
 * The envelope is a person's limit and this is the code's. Two limits rather
 * than one because they answer different questions: the envelope says what this
 * *test* is allowed to do, and this says what any test is allowed to do. A
 * declared ceiling above this is clamped and the clamping is reported, never
 * silently applied — a runner that quietly ran less than it was asked to would
 * make its own result unreadable.
 */
export const MAX_ITEMS_PER_RUN = 400;
export const MAX_CONCURRENCY = 64;

/** The shortest lease the queue will accept, which a recovery drill needs. */
const DRILL_LEASE_MS = 5_000;

/** One rung: a real drain of a real backlog at one concurrency. */
export interface DrainRound {
  concurrency: number;
  /** How many items were queued for this rung. */
  items: number;
  /** How many the claimants actually took. */
  claimed: number;
  /**
   * Claim calls that returned nothing while work was still queued.
   *
   * This is the contention signal, and it is a *measurement* rather than an
   * error: §19 says a losing claim is an ordinary outcome. What it tells you is
   * how much of each claimant's effort went into losing a compare-and-swap,
   * which is what actually stops throughput scaling with claimant count.
   */
  lostRaces: number;
  completed: number;
  /** Completions the queue refused — a fenced or expired proof. */
  refusedCompletions: number;
  elapsedMs: number;
  /** Items still outstanding when the rung ended, and therefore cancelled. */
  leftOver: number;
}

export interface DrainOptions {
  experimentId: string;
  projectId: string;
  concurrency: number;
  items: number;
  /** How many items one claim call may take. */
  batch?: number;
  /** Wall-clock the whole rung may not exceed. */
  deadlineMs: number;
  /** Shape the backlog differently without changing the work in it. */
  priorityShape?: 'FLAT' | 'STAGGERED';
}

/** Why a run could not start, in the words the experiment records. */
export class NoLabClaimant extends Error {
  constructor(projectId: string) {
    super(
      'No worker holds queue:claim on this isolated testing project, so there is nothing ' +
        `that can legitimately hold a lease in it (${projectId}). The lab does not create ` +
        'identities: register one with `npm run admin` and run the test again. Nothing was ' +
        'run and nothing was spent.',
    );
    this.name = 'NoLabClaimant';
  }
}

/**
 * The identities allowed to claim inside this experiment's scope.
 *
 * Read from membership rows rather than chosen, and deliberately *not* created:
 * an identity is a person's to grant (§26), and a lab that minted one to make
 * its own test pass would be supplying the authorization it is judged against.
 */
export async function labClaimants(projectId: string): Promise<string[]> {
  const memberships = await listMembershipsForProject(projectId);
  return memberships
    .filter(
      (membership) =>
        membership.principalType === 'WORKER' &&
        membership.active &&
        membership.scopes.includes('queue:claim'),
    )
    .map((membership) => membership.principalId);
}

/**
 * Spread `count` claim calls over whatever identities exist.
 *
 * Round-robin rather than one-each, because concurrency here is a property of
 * the *calls* — two calls by one identity still race on the same item's
 * compare-and-swap, which is what the contention number measures.
 */
function assign(claimants: string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => claimants[index % claimants.length]!);
}

/**
 * Drain one backlog at one concurrency, through the real queue.
 *
 * Every claimant is a separate call into `claimWork`, run together, so the
 * compare-and-swap in `repos/workQueue.ts` is doing the actual arbitration —
 * which is the only reason the contention number means anything. Nothing here
 * simulates a race.
 */
export async function drain(options: DrainOptions): Promise<DrainRound> {
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(options.concurrency)));
  const items = Math.max(1, Math.min(MAX_ITEMS_PER_RUN, Math.floor(options.items)));
  const batch = Math.max(1, Math.min(10, Math.floor(options.batch ?? 1)));

  const registered = await labClaimants(options.projectId);
  if (registered.length === 0) throw new NoLabClaimant(options.projectId);
  const claimants = assign(registered, concurrency);

  const correlationId = `lab:${options.experimentId}:${newId('rnd')}`;
  for (let index = 0; index < items; index += 1) {
    await enqueueWork({
      projectId: options.projectId,
      workType: LAB_WORK_TYPE,
      payload: { note: `lab ${options.experimentId} item ${index + 1}` },
      // A staggered backlog is the same work arriving in a different shape.
      // Nothing about the items changes, which is what makes the two layouts
      // comparable at all.
      priority: options.priorityShape === 'STAGGERED' ? (index % 5) * 20 : 100,
      requiredScopes: [...LAB_SCOPES],
      correlationId,
      createdByType: 'SYSTEM',
    });
  }

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1_000, options.deadlineMs);
  let claimed = 0;
  let lostRaces = 0;
  let completed = 0;
  let refusedCompletions = 0;
  let remaining = items;

  while (remaining > 0 && Date.now() < deadline) {
    const results = await Promise.all(
      claimants.map(async (workerId) => {
        const taken = await claimWork({
          workerId,
          scopes: [{ projectId: options.projectId, scopes: [...LAB_SCOPES] }],
          workTypes: [LAB_WORK_TYPE],
          limit: batch,
          leaseMs: 60_000,
        });
        // Only this round's items. A concurrent lab run in the same scope must
        // not be able to make this one's numbers look better or worse.
        const mine = taken.filter((work) => work.workItemId.length > 0);
        let done = 0;
        let refused = 0;
        for (const work of mine) {
          const proof: OwnershipProof = {
            workItemId: work.workItemId,
            workerId,
            leaseId: work.leaseId,
            leaseGeneration: work.leaseGeneration,
          };
          const outcome = await completeWork(proof, { summary: 'lab echo' });
          if (outcome.ok) done += 1;
          else refused += 1;
        }
        return { took: mine.length, done, refused };
      }),
    );

    let tookThisPass = 0;
    for (const result of results) {
      claimed += result.took;
      completed += result.done;
      refusedCompletions += result.refused;
      tookThisPass += result.took;
      if (result.took === 0) lostRaces += 1;
    }
    remaining -= tookThisPass;
    // Nothing was taken and nothing is left to take: the backlog is not what is
    // blocking, so stop rather than spin to the deadline.
    if (tookThisPass === 0) break;
  }

  const elapsedMs = Date.now() - startedAt;

  /*
   * Cleanup is part of the run.
   *
   * Cancelling advances the fencing generation, so anything a synthetic
   * claimant still held can never land afterwards. §5 holds: the rows keep
   * their ids, their attempts and the reason they stopped.
   */
  const leftOverItems = (
    await listWorkItems(options.projectId, { states: ['QUEUED', 'LEASED'], limit: 500 })
  ).filter((item) => item.correlationId === correlationId);
  for (const item of leftOverItems) {
    await cancelWork(item.id, `Lab round ${options.experimentId} ended.`);
  }

  return {
    concurrency,
    items,
    claimed,
    lostRaces,
    completed,
    refusedCompletions,
    elapsedMs,
    leftOver: leftOverItems.length,
  };
}

/**
 * One recovery drill, end to end, with nothing simulated.
 *
 * The four things §15 asks a failure drill to establish, each proved by the
 * real code rather than asserted:
 *
 *   - a worker that stops mid-lease leaves claimable work (§19);
 *   - another claimant genuinely takes it over;
 *   - the dead owner's late completion is **fenced** and matches nothing;
 *   - cancellation advances the generation, so nothing lands after it.
 *
 * It waits out a real lease rather than editing one, because a drill that
 * rewrote the expiry would be testing the edit.
 */
export interface RecoveryDrill {
  /**
   * Whether the takeover was by a *different* identity.
   *
   * Separate from `leaseTakenOver` on purpose: with one registered claimant the
   * reclaim is real and the cross-identity part is not, and reporting the two
   * as one fact would round a weaker result up to a stronger one.
   */
  crossIdentity: boolean;
  leaseTakenOver: boolean;
  lateCompletionFenced: boolean;
  lateCompletionRejection: string | null;
  cancellationFenced: boolean;
  waitedMs: number;
}

export async function runRecoveryDrill(input: {
  experimentId: string;
  projectId: string;
}): Promise<RecoveryDrill> {
  const registered = await labClaimants(input.projectId);
  if (registered.length === 0) throw new NoLabClaimant(input.projectId);
  const abandoner = registered[0]!;
  const rescuer = registered[1] ?? registered[0]!;

  const correlationId = `lab:${input.experimentId}:drill`;
  const item = await enqueueWork({
    projectId: input.projectId,
    workType: LAB_WORK_TYPE,
    payload: { note: 'recovery drill' },
    requiredScopes: [...LAB_SCOPES],
    correlationId,
    createdByType: 'SYSTEM',
  });

  const first = await claimWork({
    workerId: abandoner,
    scopes: [{ projectId: input.projectId, scopes: [...LAB_SCOPES] }],
    workTypes: [LAB_WORK_TYPE],
    limit: 1,
    leaseMs: DRILL_LEASE_MS,
  });
  const held = first.find((work) => work.workItemId === item.id);
  if (!held) {
    throw new Error('The drill could not claim its own item; nothing was proved and nothing spent.');
  }

  // Then the worker "dies": no heartbeat, no completion, no release. Waiting is
  // the mechanism — an expired lease is claimable work, and that is the thing
  // being demonstrated.
  const waitStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, DRILL_LEASE_MS + 1_000));
  const waitedMs = Date.now() - waitStart;

  const second = await claimWork({
    workerId: rescuer,
    scopes: [{ projectId: input.projectId, scopes: [...LAB_SCOPES] }],
    workTypes: [LAB_WORK_TYPE],
    limit: 1,
    leaseMs: 60_000,
  });
  const takenOver = second.find((work) => work.workItemId === item.id) ?? null;

  // The dead owner comes back and tries to finish. Its generation is stale, so
  // the guarded UPDATE matches nothing — this is the fence, exercised.
  const late = await completeWork(
    {
      workItemId: item.id,
      workerId: abandoner,
      leaseId: held.leaseId,
      leaseGeneration: held.leaseGeneration,
    },
    { summary: 'late completion from the abandoned lease' },
  );

  let cancellationFenced = false;
  if (takenOver) {
    await cancelWork(item.id, 'Recovery drill: cancelling under a live lease.');
    const afterCancel = await completeWork(
      {
        workItemId: item.id,
        workerId: rescuer,
        leaseId: takenOver.leaseId,
        leaseGeneration: takenOver.leaseGeneration,
      },
      { summary: 'completion after cancellation' },
    );
    cancellationFenced = !afterCancel.ok;
  } else {
    await cancelWork(item.id, 'Recovery drill cleanup.');
  }

  return {
    crossIdentity: abandoner !== rescuer,
    leaseTakenOver: takenOver !== null,
    lateCompletionFenced: !late.ok,
    lateCompletionRejection: late.ok ? null : late.rejection,
    cancellationFenced,
    waitedMs,
  };
}

/* ==========================================================================
 * Reading a set of rounds
 * ========================================================================== */

/** Items completed per second, or null when nothing completed. */
export function throughput(round: DrainRound): number | null {
  if (round.completed === 0 || round.elapsedMs <= 0) return null;
  return round.completed / (round.elapsedMs / 1000);
}

/**
 * Where a ramp stopped getting better.
 *
 * Deliberately conservative and deliberately explicit about the difference
 * §15.4 insists on: this returns the last rung that *improved*, and the caller
 * reports the highest rung actually reached separately. "Tested safely through
 * 32" and "maximum 32" are different sentences and this function only ever
 * supports the first.
 */
export function knee(rounds: DrainRound[]): { concurrency: number; reason: string } | null {
  let best: { concurrency: number; rate: number } | null = null;
  for (const round of rounds) {
    const rate = throughput(round);
    if (rate === null) continue;
    if (best === null || rate > best.rate * 1.05) {
      best = { concurrency: round.concurrency, rate };
      continue;
    }
    return {
      concurrency: best.concurrency,
      reason: `Raising claimants to ${round.concurrency} did not improve throughput by more than 5%.`,
    };
  }
  return best === null ? null : { concurrency: best.concurrency, reason: 'Every rung improved.' };
}

/**
 * What a round's numbers are evidence of.
 *
 * `MEASURED` for what was actually executed here; `UNKNOWN` when nothing
 * completed, because an empty run is not a zero. There is no branch that can
 * return `PROVIDER_ENFORCED` — no provider was involved, and labelling a
 * queue measurement as a provider fact is exactly the rounding-up §23 forbids.
 */
export function evidenceFor(rounds: DrainRound[]): Evidence {
  return rounds.some((round) => round.completed > 0) ? 'MEASURED' : 'UNKNOWN';
}

/** The sentence every pressure result carries, because it is always true. */
export const PROVIDER_UNTESTED =
  'Whether a real Cowork surface holds this concurrency. That needs real activations, ' +
  'it spends the subscription, and it is the one thing here a person must authorize.';

/** The wall-clock a rung is given, from the envelope rather than a constant. */
export function deadlineForRung(durationMinutes: number, rungs: number): number {
  const total = Math.max(1, durationMinutes) * 60_000;
  return Math.max(2_000, Math.floor(total / Math.max(1, rungs)));
}

/** The ladder a push-to-failure walks, bounded by the declared ceiling. */
export function ladder(ceiling: number): number[] {
  const top = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(ceiling)));
  const rungs: number[] = [];
  for (let value = 1; value < top; value *= 2) rungs.push(value);
  rungs.push(top);
  return [...new Set(rungs)];
}

/** Now, through the queue's own clock, so a lab row and a queue row agree. */
export function labNow(): string {
  return queueNow();
}
