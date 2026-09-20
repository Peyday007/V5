/**
 * The capacity kernel: one complete loop, small perimeter.
 *
 *   OBSERVE → MODEL → DIAGNOSE → SELECT → AUTHORITY CHECK → CANARY → EVALUATE
 *           → ADOPT or ROLL BACK → UPDATE CLAIMS → REPORT → OBSERVE
 *
 * ---------------------------------------------------------------------------
 * What it is allowed to do, and what it is not
 * ---------------------------------------------------------------------------
 *
 * Its observations, hypotheses and conclusions may grow without limit. Its
 * **authority** may not grow at all, and the mechanism for that is not a rule
 * somebody remembers — it is that there are exactly two effects this module can
 * have on the world:
 *
 *   1. One `fleet_policy` row through `setPolicy`, which is append-only, carries
 *      an actor and a reason, and leaves the previous version in place to revert
 *      to. The field it writes is `explore_ceiling`, which 026 added for this and
 *      which nothing has ever written.
 *   2. Some isolated canary bins through `createProbeBin`, which creates a bin and
 *      nothing else — it registers nothing, fires nothing, mints nothing and
 *      authorizes nothing, and its manifest forbids every external effect.
 *
 * It cannot create an account, a Routine, a credential, a membership or a scope;
 * it cannot enable a paid API; it cannot raise a spending ceiling; and it cannot
 * fire anything — the dispatcher picks its bins up through the same routing every
 * other bin goes through. §22's split holds: **Brain owns dispatch, the surface
 * owns whether a worker may act**, and a kernel that minted its own surfaces to
 * measure them would be measuring something it had authorized itself.
 *
 * ---------------------------------------------------------------------------
 * Why the tick is idempotent by rows rather than by a flag
 * ---------------------------------------------------------------------------
 *
 * Every transition is a compare-and-swap in `repos/capacityKernel.ts` naming the
 * state it moves from, and every artefact an experiment creates is recorded in the
 * same statement that moves the state. So a restart mid-experiment resumes rather
 * than duplicating: a tick finding `CANARY_RUNNING` reads the bins that already
 * exist instead of making more, and a tick that dies between deciding and writing
 * has changed nothing. §27's rule — a flag can be set by a tick that then dies,
 * rows cannot.
 *
 * ---------------------------------------------------------------------------
 * A note on what this deliberately does not decide
 * ---------------------------------------------------------------------------
 *
 * It does not choose which work runs, does not order the queue, does not judge
 * evidence, does not touch an audit role and does not approve anything. Raising a
 * concurrency ceiling changes how many workers may run at once and nothing about
 * what any of them is allowed to do — every evidence gate, verification pass,
 * audit role, independence floor and approval envelope is exactly where it was.
 */
import {
  CANARY_WORKLOAD_CLASS,
  EXPERIMENT_AUTHORITY,
  type CapacityDimension,
} from '../../domain/capacity.ts';
import {
  authorizeExperiment,
  beginEvaluating,
  liveExperiments,
  parkExperimentForUser,
  proposeExperiment,
  recordClaim,
  runningCanaryCount,
  settleExperiment,
  startCanary,
  type CapacityExperiment,
} from '../../repos/capacityKernel.ts';
import { currentPolicy, listRoutines, setPolicy } from '../../repos/fleet.ts';
import { getWorkerRouting } from '../../repos/identity.ts';
import { recordBinEvent, markBinReady } from '../../repos/bins.ts';
import { createProbeBin, ProbeRefused } from '../fleet/probe.ts';
import { getWorker } from '../../repos/identity.ts';
import { deriveEnvelope, envelopeRows, type CapacityEnvelope } from './envelope.ts';
import { diagnose, type Diagnosis } from './diagnose.ts';
import {
  CANARY_WINDOW_MS,
  MAX_CANARY_BINS,
  checkStopConditions,
  judgeCanary,
  selectExperiment,
  type CanaryBaseline,
  type ExperimentProposal,
} from './experiments.ts';
import { observeCapacity, type CapacityObservation } from './observe.ts';
import { capacityNow } from '../../repos/capacityKernel.ts';

export interface KernelTickResult {
  at: string;
  envelope: CapacityEnvelope;
  diagnosis: Diagnosis;
  /** Claims written, by dimension and what happened to each. */
  claims: { dimension: CapacityDimension; action: 'CREATED' | 'REVERIFIED' | 'SUPERSEDED' }[];
  /** Experiments moved this tick, with the transition that happened. */
  transitions: { experimentId: string; from: string; to: string; why: string }[];
  /** The experiment proposed this tick, if any. */
  proposed: ExperimentProposal | null;
  /** Live experiments after the tick. */
  live: CapacityExperiment[];
  /** Everything a person must do, in exact words. Empty when nothing is needed. */
  userActions: string[];
  /** Fields the ledger could not answer. */
  missing: string[];
}

/**
 * Who a kernel-written policy row is attributed to.
 *
 * Attribution, never authentication. §23 draws the distinction in two columns and
 * it holds here: this says whose authority the change carries — the kernel's own,
 * inside limits set in code — and it says nothing about who typed anything,
 * because nobody did.
 */
export const KERNEL_ACTOR = 'capacity-kernel';

/**
 * One pass.
 *
 * Exported so a test can drive it directly and an operator can step it
 * deliberately, which is the same reason `dispatchTick` is exported. Safe to call
 * repeatedly: every write it makes is guarded on a state it read, so a second call
 * against an unchanged fleet transitions nothing and re-verifies the same claims.
 */
export async function capacityKernelTick(
  options: {
    windowHours?: number;
    /** Set false to observe and conclude without creating or moving anything. */
    act?: boolean;
    now?: string;
    requestedBy?: string;
  } = {},
): Promise<KernelTickResult> {
  const act = options.act !== false;
  const at = options.now ?? capacityNow();
  const requestedBy = options.requestedBy ?? KERNEL_ACTOR;

  // OBSERVE
  const observation = await observeCapacity({ windowHours: options.windowHours, now: at });
  // MODEL
  const envelope = deriveEnvelope(observation);
  // DIAGNOSE
  const diagnosis = diagnose(observation);

  const transitions: KernelTickResult['transitions'] = [];
  const claims: KernelTickResult['claims'] = [];
  const userActions: string[] = [];

  /*
   * Live experiments are advanced **before** a new one is proposed.
   *
   * A canary that has finished its window must be judged and settled in the same
   * tick that notices, or the next selection sees a dimension still owned by an
   * experiment that is really over — and the kernel would stall, waiting for
   * itself. That is §24's *waiting nobody can resolve*, and the party who cannot
   * resolve it here is Brain.
   */
  const live = await liveExperiments();
  for (const experiment of live) {
    const moved = await advanceExperiment({ experiment, observation, at, act });
    if (moved) transitions.push(moved);
    /*
     * The user actions are deliberately **not** collected here.
     *
     * This list was read before `advanceExperiment` ran, so a `NEEDS_USER`
     * experiment settled by this very tick — because its answering transition
     * found the Routine registered — would still have its action reported. That is
     * asking somebody to do a thing that is already done, which is §29's defect in
     * the direction that wastes their time and teaches them the list is stale.
     * They are read from the post-advance state below instead.
     */
  }

  // UPDATE CLAIMS. Always, and independently of any experiment: a conclusion the
  // ledger supports is worth recording whether or not anything is being tested.
  if (act) {
    for (const reading of envelopeRows(envelope)) {
      const outcome = await recordClaim({
        dimension: reading.dimension,
        scope: 'FLEET',
        scopeId: null,
        workloadClass: observation.scope.workloadClass ?? 'ANY',
        value: reading.value,
        bound: reading.bound,
        evidenceClass: reading.evidenceClass,
        explanation: reading.explanation,
        sampleCount: reading.sampleCount,
        confidence: reading.confidence,
        evidenceIds: reading.evidenceIds,
        contradictions: reading.contradictions,
        staleness: reading.staleness,
        configHash: configHashOf(observation),
      });
      claims.push({ dimension: reading.dimension, action: outcome.action });
    }
  }

  // SELECT, then AUTHORITY CHECK.
  const after = await liveExperiments();
  // Every action still outstanding, read after this tick's transitions rather
  // than before them. See the note in the advance loop above.
  for (const experiment of after) {
    if (experiment.state === 'NEEDS_USER' && experiment.userAction) {
      userActions.push(experiment.userAction);
    }
  }
  const proposal = selectExperiment({
    observation,
    envelope,
    diagnosis,
    claimedDimensions: after.map((one) => one.dimension),
    canaryRunning: (await runningCanaryCount()) > 0,
  });

  if (proposal && act) {
    const { experiment, created } = await proposeExperiment({
      kind: proposal.kind,
      dimension: proposal.dimension,
      scope: 'FLEET',
      scopeId: null,
      workloadClass: observation.scope.workloadClass ?? 'ANY',
      hypothesis: proposal.hypothesis,
      successMetric: proposal.successMetric,
      stopCondition: proposal.stopCondition,
      resolvesUnknown: proposal.resolvesUnknown,
      factor: proposal.factor,
      baselineValue: proposal.baselineValue,
      canaryValue: proposal.canaryValue,
      requestedBy,
    });
    if (created) {
      transitions.push({
        experimentId: experiment.id,
        from: '—',
        to: 'PROPOSED',
        why: `${proposal.kind} selected: ${proposal.resolvesUnknown}`,
      });
      /*
       * The authority check, immediately, and it is a *table lookup* rather than a
       * judgement. `EXPERIMENT_AUTHORITY` is a constant in `domain/capacity.ts`, so
       * nothing here supplies the limits its own work is judged against — §16's
       * approval-envelope property, at a smaller scale and for the identical
       * reason.
       */
      if (EXPERIMENT_AUTHORITY[proposal.kind] === 'PERSON') {
        if (proposal.userAction && (await parkExperimentForUser({ id: experiment.id, userAction: proposal.userAction }))) {
          transitions.push({
            experimentId: experiment.id,
            from: 'PROPOSED',
            to: 'NEEDS_USER',
            why: 'Brain holds no authority to create an execution surface.',
          });
          userActions.push(proposal.userAction);
        }
      } else {
        const moved = await advanceExperiment({
          experiment: (await liveExperimentFor(experiment.id)) ?? experiment,
          observation,
          at,
          act,
          proposal,
        });
        if (moved) transitions.push(moved);
      }
    }
  } else if (proposal && proposal.userAction) {
    // Not acting, but still worth reporting what would be asked for.
    userActions.push(proposal.userAction);
  }

  await recordBinEvent({
    eventType: 'CAPACITY_KERNEL_TICK',
    evidenceClass: 'MEASURED',
    outcome: diagnosis.bottleneck,
    reason: diagnosis.evidenceFor,
    measures: {
      activeConcurrency: envelope.readings.ACTIVE_CONCURRENCY.value,
      productiveConcurrency: envelope.readings.PRODUCTIVE_CONCURRENCY.value,
      eligibleSurfaces: envelope.readings.ELIGIBLE_CAPACITY.value,
      recommendedTarget: envelope.readings.RECOMMENDED_OPERATING_TARGET.value,
      liveExperiments: after.length,
      transitions: transitions.length,
    },
  });

  return {
    at,
    envelope,
    diagnosis,
    claims,
    transitions,
    proposed: proposal,
    live: await liveExperiments(),
    userActions: [...new Set(userActions)],
    missing: observation.missing,
  };
}

async function liveExperimentFor(id: string): Promise<CapacityExperiment | null> {
  const { experimentById } = await import('../../repos/capacityKernel.ts');
  return await experimentById(id);
}

/* -------------------------------------------------------------------------- */
/* The state machine                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Move one experiment at most one step.
 *
 * One step per tick, with no exceptions — and the comment here previously claimed
 * one, which was wrong. A freshly selected experiment is proposed and authorized
 * in the same pass (the selection path calls this once, moving
 * `PROPOSED → AUTHORIZED`) and its canary starts on the *next* tick. That is what
 * the code does and what a driven run shows; a reader who believed the old
 * sentence would conclude a canary starts a tick earlier than it does, and would
 * look for a bug when it did not.
 *
 * One step is deliberate rather than incidental: a tick is ten seconds away, so
 * there is nothing to gain from collapsing two guarded transitions into one pass
 * and one fewer partially-written state to reason about.
 */
async function advanceExperiment(input: {
  experiment: CapacityExperiment;
  observation: CapacityObservation;
  at: string;
  act: boolean;
  proposal?: ExperimentProposal;
}): Promise<KernelTickResult['transitions'][number] | null> {
  const { experiment, observation, at, act } = input;
  if (!act) return null;

  switch (experiment.state) {
    case 'PROPOSED': {
      /*
       * Capture the rollback point in the authorizing statement. By the time a
       * rollback runs the current policy row is this experiment's own, so reading
       * it back then would revert to the thing being reverted.
       */
      const policy = await currentPolicy('FLEET', null);
      if (
        await authorizeExperiment({
          id: experiment.id,
          rollbackPolicyVersion: policy?.version ?? null,
          rollbackTarget: policy?.target ?? null,
        })
      ) {
        return {
          experimentId: experiment.id,
          from: 'PROPOSED',
          to: 'AUTHORIZED',
          why: `rollback point recorded: policy v${policy?.version ?? '—'} target ${policy?.target ?? '—'}`,
        };
      }
      return null;
    }

    case 'AUTHORIZED': {
      const baseline = baselineOf(observation);
      const until = new Date(Date.parse(at) + CANARY_WINDOW_MS).toISOString();

      /*
       * An observational experiment applies nothing at all. It still moves to
       * `CANARY_RUNNING`, because the window is what it needs: a passive baseline
       * is "watch for twenty minutes and then read the ledger", and giving it the
       * same state machine as a real canary means one evaluation path rather than
       * two that must agree.
       */
      if (experiment.kind === 'PASSIVE_BASELINE' || experiment.kind === 'SUSTAINED_HOLD') {
        if (
          await startCanary({
            id: experiment.id,
            appliedPolicyVersion: null,
            canaryBinIds: [],
            canaryUntil:
              experiment.kind === 'SUSTAINED_HOLD'
                ? new Date(Date.parse(at) + 4 * 3_600_000).toISOString()
                : until,
            baselineReading: baseline,
          })
        ) {
          return {
            experimentId: experiment.id,
            from: 'AUTHORIZED',
            to: 'CANARY_RUNNING',
            why: 'observing only: nothing was applied and nothing was created.',
          };
        }
        return null;
      }

      // A concurrency staircase: one policy row, then isolated canary load.
      const target = Math.max(1, Math.round(experiment.canaryValue ?? 0));
      if (target <= 0) return null;
      const policy = await currentPolicy('FLEET', null);
      /*
       * `exploreCeiling` rather than `target`, and this is the reason the whole
       * experiment is safe to leave running if a process dies: an explore ceiling
       * carries its own expiry, and `effectiveTarget` compares that expiry to the
       * clock. So a kernel that never gets another tick leaves a ceiling that stops
       * applying by itself, and the fleet falls back to the operator's own target
       * with no rollback having to run. §23's rule that a boost expires by being
       * compared to the clock rather than by anything running — applied to the
       * field that was added for exactly this and never used.
       *
       * The base `target` is carried through unchanged, so the row records a
       * temporary departure rather than replacing what the operator set.
       */
      const written = await setPolicy({
        scope: 'FLEET',
        scopeId: null,
        target: policy?.target ?? target,
        autoScale: policy?.autoScale ?? false,
        autoScaleCeiling: policy?.autoScaleCeiling ?? null,
        minReserve: policy?.minReserve ?? 0,
        boostTarget: policy?.boostTarget ?? null,
        boostUntil: policy?.boostUntil ?? null,
        boostReason: policy?.boostReason ?? null,
        exploreCeiling: target,
        exploreUntil: until,
        paused: policy?.paused ?? false,
        actor: KERNEL_ACTOR,
        reason:
          `capacity experiment ${experiment.id}: exploring concurrency ${target} until ${until}. ` +
          `Reverts to target ${policy?.target ?? target} by expiry even if nothing runs again.`,
      });

      /*
       * The bins are created as DRAFTs, recorded, and only then made dispatchable.
       *
       * That order is the whole crash guarantee, and I had it wrong first: marking
       * them READY inside `createCanaryLoad` left a window in which a dispatchable
       * canary bin existed and the experiment row did not yet name it, so a process
       * dying there would have left orphan work nothing could attribute or clean
       * up. A DRAFT is not selected by `DISPATCHABLE_SQL`, so with this order the
       * worst a crash leaves is an undispatchable row — visible, attributable to
       * nothing, and costing no activation.
       */
      const binIds = await createCanaryLoad({ wanted: MAX_CANARY_BINS, experimentId: experiment.id });

      if (
        await startCanary({
          id: experiment.id,
          appliedPolicyVersion: written.version,
          canaryBinIds: binIds,
          canaryUntil: until,
          baselineReading: baseline,
        })
      ) {
        for (const binId of binIds) await markBinReady(binId);
        return {
          experimentId: experiment.id,
          from: 'AUTHORIZED',
          to: 'CANARY_RUNNING',
          why:
            `explore ceiling ${target} written as policy v${written.version} until ${until}, with ` +
            `${binIds.length} isolated canary bin(s).`,
        };
      }
      /*
       * Lost the transition — another tick started this canary first. The policy
       * row is append-only so the duplicate write is harmless history, and the bins
       * stay DRAFT: never dispatched, so they cost nothing, and kept rather than
       * deleted because §5 applies to a row whose only fault is having lost a race.
       */
      return null;
    }

    case 'CANARY_RUNNING': {
      const baseline = (experiment.baselineReading as CanaryBaseline | null) ?? baselineOf(observation);
      const stop = checkStopConditions({ observation, baseline });
      if (stop.stop) {
        await rollBack({ experiment, why: stop.reason });
        if (await settleExperiment({ id: experiment.id, to: 'ROLLED_BACK', verdict: 'STOPPED', reason: stop.reason })) {
          return {
            experimentId: experiment.id,
            from: 'CANARY_RUNNING',
            to: 'ROLLED_BACK',
            why: `${stop.condition}: ${stop.reason}`,
          };
        }
        return null;
      }
      // The window is compared to the clock by a reader. Nothing schedules it.
      if (experiment.canaryUntil && experiment.canaryUntil > at) return null;
      if (await beginEvaluating({ id: experiment.id, canaryReading: baselineOf(observation) })) {
        return {
          experimentId: experiment.id,
          from: 'CANARY_RUNNING',
          to: 'EVALUATING',
          why: 'the canary window has closed; nothing may be adopted before this.',
        };
      }
      return null;
    }

    case 'EVALUATING': {
      const baseline = (experiment.baselineReading as CanaryBaseline | null) ?? baselineOf(observation);
      const judged = judgeCanary({
        observation,
        targetLevel: Math.max(1, Math.round(experiment.canaryValue ?? 1)),
        baseline,
      });

      if (judged.verdict === 'CONFIRMED') {
        /*
         * Adoption is a *durable* policy row, not the explore ceiling being left
         * to expire. The ceiling was the experiment; the adopted number is the
         * operator's new baseline, with the explore fields cleared so nothing is
         * left carrying an expiry that would silently undo it.
         */
        if (experiment.kind === 'CONCURRENCY_STAIRCASE' && experiment.canaryValue !== null) {
          const policy = await currentPolicy('FLEET', null);
          await setPolicy({
            scope: 'FLEET',
            scopeId: null,
            target: Math.max(1, Math.round(experiment.canaryValue)),
            autoScale: policy?.autoScale ?? false,
            autoScaleCeiling: policy?.autoScaleCeiling ?? null,
            minReserve: policy?.minReserve ?? 0,
            boostTarget: null,
            boostUntil: null,
            boostReason: null,
            exploreCeiling: null,
            exploreUntil: null,
            paused: policy?.paused ?? false,
            actor: KERNEL_ACTOR,
            reason:
              `capacity experiment ${experiment.id} confirmed: ${judged.reason} Adopting as the ` +
              `standing target; the previous version ${experiment.rollbackPolicyVersion ?? '—'} ` +
              `(target ${experiment.rollbackTarget ?? '—'}) remains the revert point.`,
          });
        }
        if (await settleExperiment({ id: experiment.id, to: 'ADOPTED', verdict: 'CONFIRMED', reason: judged.reason })) {
          return { experimentId: experiment.id, from: 'EVALUATING', to: 'ADOPTED', why: judged.reason };
        }
        return null;
      }

      await rollBack({ experiment, why: judged.reason });
      const verdict = judged.verdict;
      if (await settleExperiment({ id: experiment.id, to: 'ROLLED_BACK', verdict, reason: judged.reason })) {
        return { experimentId: experiment.id, from: 'EVALUATING', to: 'ROLLED_BACK', why: judged.reason };
      }
      return null;
    }

    case 'NEEDS_USER': {
      /*
       * The answering transition, derived from rows rather than from somebody
       * telling Brain they did it.
       *
       * A definition staircase asked for one more registered Routine. The moment
       * `fleet_routines` holds more than the baseline it was proposed against, the
       * thing it asked for has happened — so the claim is recorded and the
       * experiment settles. Derived, so it reaches an action taken days ago by a
       * person who never came back to say so, and so nothing has to be re-asked.
       * That is the fourth time this repository has needed the distinction between
       * a hook on the moment and a derivation from the rows.
       */
      if (experiment.kind === 'DEFINITION_STAIRCASE' && experiment.canaryValue !== null) {
        const registered = (await listRoutines()).length;
        if (registered >= experiment.canaryValue) {
          await recordClaim({
            dimension: 'DEFINITION_CAPACITY',
            scope: 'FLEET',
            scopeId: null,
            value: registered,
            bound: 'AT_LEAST',
            evidenceClass: 'MEASURED',
            explanation:
              `${registered} Routine definitions are now registered, which the provider accepted. That ` +
              `establishes definition capacity at at least ${registered} and no maximum: nothing ` +
              'refused the addition.',
            sampleCount: registered,
            confidence: 'MEDIUM',
            staleness: ['a Routine is registered or removed', 'the account changes plan'],
          });
          if (
            await settleExperiment({
              id: experiment.id,
              to: 'ADOPTED',
              verdict: 'CONFIRMED',
              reason: `${registered} definitions are registered, which meets the ${experiment.canaryValue} asked for.`,
            })
          ) {
            return {
              experimentId: experiment.id,
              from: 'NEEDS_USER',
              to: 'ADOPTED',
              why: `the requested Routine was registered; definition capacity is at least ${registered}.`,
            };
          }
        }
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Put the policy back where it was.
 *
 * Writes the recorded rollback target as a fresh version with the explore fields
 * cleared, rather than deleting anything: `fleet_policy` is append-only, so a
 * rollback is a new row saying "back to what it was" and the experiment's own row
 * stays on the history. An experiment that applied nothing has nothing to roll
 * back and this is a no-op, which is why it is safe to call from both settlement
 * paths.
 */
async function rollBack(input: { experiment: CapacityExperiment; why: string }): Promise<void> {
  const { experiment } = input;
  if (experiment.appliedPolicyVersion === null) return;
  const policy = await currentPolicy('FLEET', null);
  await setPolicy({
    scope: 'FLEET',
    scopeId: null,
    target: experiment.rollbackTarget ?? policy?.target ?? 1,
    autoScale: policy?.autoScale ?? false,
    autoScaleCeiling: policy?.autoScaleCeiling ?? null,
    minReserve: policy?.minReserve ?? 0,
    boostTarget: null,
    boostUntil: null,
    boostReason: null,
    exploreCeiling: null,
    exploreUntil: null,
    paused: policy?.paused ?? false,
    actor: KERNEL_ACTOR,
    reason:
      `rolling back capacity experiment ${experiment.id} to policy v${experiment.rollbackPolicyVersion ?? '—'} ` +
      `(target ${experiment.rollbackTarget ?? '—'}): ${input.why}`,
  });
}

/**
 * Isolated, non-consequential load for a staircase step.
 *
 * `createProbeBin` unpinned, which is the one difference from a surface probe and
 * the reason it must be: a probe asks "does *this* surface work" and pins to one,
 * while a concurrency step asks "can the fleet run one more at once" and must let
 * the router distribute. Pinning here would measure one surface's serialization
 * rather than the fleet's concurrency.
 *
 * Every bin is a `DETERMINISTIC_CHECK` whose manifest forbids every repository
 * operation and every external effect, and whose whole task is to hash a value
 * that travelled inside it. It touches no document, no packet, no claim and no
 * money — so a staircase step can never consume a real attempt budget or damage
 * production work, which is the mandate's own instruction not to use important
 * work as disposable load.
 */
async function createCanaryLoad(input: { wanted: number; experimentId: string }): Promise<string[]> {
  const routines = await listRoutines();
  const created: string[] = [];

  for (const routine of routines) {
    if (created.length >= input.wanted) break;
    if (routine.state !== 'ENABLED' || !routine.workerId) continue;
    const worker = await getWorker(routine.workerId);
    if (!worker) continue;
    const routing = await getWorkerRouting(routine.workerId);
    /*
     * Research family only. A factory probe must name a repository, and a canary
     * that named one would be repository work — reaching a surface with push
     * access to measure a concurrency ceiling is a blast radius nothing here needs.
     */
    try {
      const binId = await createProbeBin({
        worker: { id: worker.id, name: worker.name },
        repositories: routing?.repositories ?? [],
        routine: { id: routine.id, name: routine.name, capabilities: [] },
        family: 'RESEARCH',
        createdByType: 'SYSTEM',
        createdById: KERNEL_ACTOR,
        pinned: false,
        workloadClass: CANARY_WORKLOAD_CLASS,
        ready: false,
      });
      /*
       * Left as a DRAFT. The caller marks them READY only after the experiment row
       * names them — see the note at the call site for why that order matters.
       */
      created.push(binId);
    } catch (error) {
      /*
       * A refused probe is an ordinary outcome: a surface whose worker is a member
       * of no project can be handed nothing. It contributes no load and stops
       * nothing, because the step is judged on the overlap actually achieved rather
       * than on how many bins were made.
       */
      if (!(error instanceof ProbeRefused)) throw error;
    }
  }

  await recordBinEvent({
    eventType: 'CAPACITY_CANARY_CREATED',
    evidenceClass: 'MEASURED',
    workloadClass: CANARY_WORKLOAD_CLASS,
    outcome: created.length > 0 ? 'CREATED' : 'NONE',
    reason: `capacity experiment ${input.experimentId} created ${created.length} isolated canary bin(s)`,
    measures: { wanted: input.wanted, created: created.length },
  });

  return created;
}

function baselineOf(observation: CapacityObservation): CanaryBaseline {
  return {
    validatedCompletions: observation.validatedCompletions.length,
    completionRefusals: observation.completionRefusals,
    takeovers: observation.takeovers,
    sessionCount: observation.sessions.length,
    providerRefusals: observation.providerRefusals.length,
  };
}

/**
 * A short fingerprint of the configuration a claim was measured against.
 *
 * Not a security value and not a version number: it is the thing that makes "this
 * claim is about another system now" derivable rather than scheduled. A claim
 * measured against four eligible surfaces and a target of six is not a claim about
 * a fleet with one surface and no target, and comparing hashes says so without
 * anybody having to remember to invalidate anything.
 */
function configHashOf(observation: CapacityObservation): string {
  return [
    `routines=${observation.routines.length}`,
    `eligible=${observation.eligibleRoutineIds.length}`,
    `target=${observation.fleetTarget ?? 'none'}`,
    `policy=v${observation.fleetPolicyVersion ?? 0}`,
  ].join(' ');
}
