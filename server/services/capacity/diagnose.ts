/**
 * Which stage is actually the constraint, from lifecycle evidence.
 *
 * Pure over a `CapacityObservation`. There is a bottleneck classifier already —
 * `services/dispatch/profiles.ts` names five values — and this is deliberately a
 * *different* question rather than a replacement for it: that one answers "what
 * held this workload up" for a report about one scope, and this one answers "what
 * is the constraint right now, and what is the cheapest thing that would tell us
 * whether we are right". The five values there are folded into the thirteen here
 * rather than duplicated, and `profiles.ts` is untouched.
 *
 * ---------------------------------------------------------------------------
 * Why the leading diagnosis carries its own counter-evidence
 * ---------------------------------------------------------------------------
 *
 * Every stage transition has at least two explanations, and the cheap wrong one is
 * always available. Eligible-but-not-leased looks like a scheduler fault and is
 * equally consistent with there being no eligible surface. More starts without
 * more results looks like ineffective concurrency and is equally consistent with
 * the work having become harder. So a diagnosis here is a triple — the claim, what
 * supports it, and what would have to be true for it to be wrong — and the
 * discriminator is the *cheapest* observation that separates them, which is what
 * `selectExperiment` reads.
 *
 * Nothing in this module writes, enqueues, fires or decides. It classifies.
 */
import type { CapacityObservation } from './observe.ts';
import { maxOverlap, maxProductiveOverlap } from './observe.ts';

/**
 * The stages a constraint can live in.
 *
 * Ordered by how far along the lifecycle they are, because the first one that
 * holds is the one to report: a fleet with nothing to do has no dispatch problem,
 * and a fleet whose provider is refusing has no scheduler problem worth fixing
 * first.
 */
export type Bottleneck =
  | 'NO_ELIGIBLE_WORK'
  | 'NO_EXECUTION_SURFACE'
  | 'SCHEDULER_OR_QUEUE'
  | 'LOCAL_TARGET'
  | 'PROVIDER_BOUNDARY'
  | 'SESSION_NEVER_ARRIVES'
  | 'EXECUTION_SPEED'
  | 'VALIDATION_OR_FINALIZATION'
  | 'INEFFECTIVE_CONCURRENCY'
  | 'RECOVERY_AMPLIFICATION'
  | 'QUALITY_CEILING'
  | 'AWAITING_PERSON'
  | 'NONE';

export interface Diagnosis {
  bottleneck: Bottleneck;
  /** One sentence naming the stage and the evidence for it. */
  evidenceFor: string;
  /** The competing explanation, always. Never omitted for being unlikely. */
  evidenceAgainst: string;
  /**
   * The cheapest observation that would separate the two.
   *
   * Read by `selectExperiment`, which is why it is a sentence rather than an
   * enum: the discriminator for a novel condition is often "measure the thing we
   * have not measured", and an enum would force it into the nearest existing box.
   */
  discriminator: string;
  /** Whether Brain can act on this itself, or whether it needs a person. */
  actionable: 'BRAIN' | 'PERSON';
}

/**
 * Classify the current constraint.
 *
 * A cascade rather than a score. Each condition is a fact about rows, tested in
 * the order in which acting on it would be correct, and the first one that holds
 * wins. A weighted combination would need weights nobody set, and §38 records the
 * argument: the number then reads like a measurement.
 */
export function diagnose(observation: CapacityObservation): Diagnosis {
  const { stages } = observation;
  const active = maxOverlap(observation.sessions);
  const productive = maxProductiveOverlap(observation.sessions);
  const outstanding = stages.readyNotFired + stages.firedNotArrived + stages.leasedExpired;

  /*
   * A provider that said no outranks everything, including a deep queue —
   * especially a deep queue, which is exactly when the temptation to push through
   * one is strongest. `proposeScale` already puts refusals first for this reason.
   */
  if (observation.providerRefusals.length > 0) {
    return {
      bottleneck: 'PROVIDER_BOUNDARY',
      evidenceFor:
        `${observation.providerRefusals.length} refusal(s) the provider itself issued are in the window, ` +
        'classified PROVIDER_ENFORCED at the moment they were observed.',
      evidenceAgainst:
        'a refusal is a fact about one moment rather than a ceiling. It may be a per-window allowance ' +
        'that has since reset rather than a simultaneity limit, and those have different remedies.',
      discriminator:
        'whether a fire at the same concurrency is refused again after the recorded retry point passes.',
      actionable: 'BRAIN',
    };
  }

  /*
   * Nothing to do is not a capacity problem, and reporting one here would send
   * somebody to scale a fleet that is idle because the work ran out.
   */
  if (outstanding === 0 && stages.leasedLive === 0) {
    return {
      bottleneck: 'NO_ELIGIBLE_WORK',
      evidenceFor: 'no bin is ready, fired-and-unanswered, or on a lapsed lease, and none is being worked.',
      evidenceAgainst:
        'work may exist and be invisible to this reading — parked on a person, or held behind an ' +
        'authorization rather than behind capacity.',
      discriminator:
        `whether the ${stages.needsHuman} bin(s) at NEEDS_HUMAN are waiting on a decision somebody can actually make.`,
      actionable: stages.needsHuman > 0 ? 'PERSON' : 'BRAIN',
    };
  }

  if (observation.eligibleRoutineIds.length === 0) {
    return {
      bottleneck: 'NO_EXECUTION_SURFACE',
      evidenceFor:
        `${outstanding} piece(s) of work are outstanding and no registered Routine is a routing candidate` +
        (observation.missingSecretRoutineIds.length > 0
          ? `; ${observation.missingSecretRoutineIds.length} are registered but their deployment secret is not present here.`
          : '.'),
      evidenceAgainst:
        'a surface may exist and be excluded for a reason other than health — a scope, a project ' +
        'membership or a capability — which is an authorization rather than a capacity fact.',
      discriminator: 'the recorded state reason on each non-ENABLED Routine.',
      actionable: 'PERSON',
    };
  }

  /*
   * Deferred on a target rather than on a refusal. Brain's own guardrail is the
   * constraint, which is the one condition in this list the kernel can move.
   */
  const targetRefusals =
    (stages.deferredByRefusal['ACCOUNT_TARGETS_REACHED'] ?? 0) +
    (stages.deferredByRefusal['FLEET_TARGET_REACHED'] ?? 0);
  if (targetRefusals > 0) {
    return {
      bottleneck: 'LOCAL_TARGET',
      evidenceFor:
        `${targetRefusals} intent(s) are held back by a target Brain itself configured, with no provider ` +
        'refusal in the window.',
      evidenceAgainst:
        'the target may be the right number and the work behind it may not benefit from more ' +
        'concurrency — more starts without more distinct results is the failure mode raising it produces.',
      discriminator:
        'whether one more concurrent session produces one more distinct validated completion.',
      actionable: 'BRAIN',
    };
  }

  if (stages.readyNotFired > 0 && stages.firedNotArrived === 0 && stages.leasedLive === 0) {
    return {
      bottleneck: 'SCHEDULER_OR_QUEUE',
      evidenceFor:
        `${stages.readyNotFired} bin(s) are READY with no fire sent at their current generation, while ` +
        `${observation.eligibleRoutineIds.length} surface(s) are eligible and nothing has refused.`,
      evidenceAgainst:
        'an intent may exist and be inside a backoff, in which case this is a wait rather than a ' +
        'scheduler fault and the remedy is elsewhere.',
      discriminator: 'the recorded refusal kind and next-attempt time on those bins’ dispatch rows.',
      actionable: 'BRAIN',
    };
  }

  if (stages.firedNotArrived > 0 && stages.leasedLive === 0) {
    return {
      bottleneck: 'SESSION_NEVER_ARRIVES',
      evidenceFor:
        `${stages.firedNotArrived} bin(s) have a fire the provider accepted and no session has arrived ` +
        'for any of them.',
      evidenceAgainst:
        'a session may be starting and simply not have checked in yet; the in-flight window is thirty ' +
        'minutes and a reading inside it cannot tell a slow start from a no-show.',
      discriminator: 'whether those intents are still unanswered once the in-flight window has passed.',
      actionable: 'PERSON',
    };
  }

  if (stages.leasedExpired > 0 && observation.takeovers > observation.validatedCompletions.length) {
    return {
      bottleneck: 'RECOVERY_AMPLIFICATION',
      evidenceFor:
        `${observation.takeovers} takeover(s) of lapsed leases against ${observation.validatedCompletions.length} ` +
        'distinct validated completion(s) — work is being picked up again more often than it is finishing.',
      evidenceAgainst:
        'a long legitimate task whose lease is shorter than it needs produces the same pattern, and the ' +
        'remedy for that is the lease rather than the concurrency.',
      discriminator: 'whether the reclaimed items resume from a checkpoint or restart from nothing.',
      actionable: 'BRAIN',
    };
  }

  if (observation.completionRefusals > observation.validatedCompletions.length) {
    return {
      bottleneck: 'QUALITY_CEILING',
      evidenceFor:
        `${observation.completionRefusals} completion(s) were refused against ${observation.validatedCompletions.length} ` +
        'accepted — raw completions are outrunning what Brain will accept.',
      evidenceAgainst:
        'a newly tightened contract produces exactly this shape for one cycle while workers adjust, ' +
        'and that is a transient rather than a ceiling.',
      discriminator: 'whether the refusal reasons are the same reason repeated or a spread of different ones.',
      actionable: 'BRAIN',
    };
  }

  if (active.max > 1 && productive.max < active.max) {
    return {
      bottleneck: 'INEFFECTIVE_CONCURRENCY',
      evidenceFor:
        `${active.max} session(s) overlapped and only ${productive.max} of them produced distinct ` +
        'validated work, so added simultaneity is not turning into added output.',
      evidenceAgainst:
        'the losing sessions may have been correct duplicate activations that found nothing to do, ' +
        'which costs an activation and is not a defect.',
      discriminator: 'whether the unproductive sessions were refused work or were handed some and failed.',
      actionable: 'BRAIN',
    };
  }

  if (stages.leasedLive > 0 && observation.validatedCompletions.length === 0) {
    return {
      bottleneck: 'EXECUTION_SPEED',
      evidenceFor:
        `${stages.leasedLive} session(s) hold live leases and nothing has been accepted in the window.`,
      evidenceAgainst:
        'the window may simply be shorter than the work; a four-hour task inside a one-hour window ' +
        'looks identical to one that is stuck.',
      discriminator: 'the end-to-end latency distribution against the width of the window.',
      actionable: 'BRAIN',
    };
  }

  if (stages.needsHuman > 0 && outstanding === 0) {
    return {
      bottleneck: 'AWAITING_PERSON',
      evidenceFor: `${stages.needsHuman} bin(s) are parked on a decision and nothing else is outstanding.`,
      evidenceAgainst: 'a park may have an answering transition Brain can take, in which case it is not waiting on anybody.',
      discriminator: 'whether each park names a choice something actually implements.',
      actionable: 'PERSON',
    };
  }

  if (observation.validatedCompletions.length > 0 && stages.leasedLive > 0) {
    return {
      bottleneck: 'NONE',
      evidenceFor:
        `${observation.validatedCompletions.length} distinct validated completion(s) in the window with ` +
        `${stages.leasedLive} session(s) still working and nothing refused.`,
      evidenceAgainst:
        'a fleet moving steadily below its own ceiling looks the same as one at its ceiling when the ' +
        'ceiling has never been probed.',
      discriminator: 'raising the concurrency ceiling by one and seeing whether throughput follows.',
      actionable: 'BRAIN',
    };
  }

  return {
    bottleneck: 'VALIDATION_OR_FINALIZATION',
    evidenceFor:
      'work is outstanding, surfaces are eligible, nothing has been refused by the provider and nothing ' +
      'has been accepted — the remaining stage is between a worker finishing and Brain accepting.',
    evidenceAgainst:
      'this is the residual branch rather than a positive finding: it is what is left when no earlier ' +
      'condition held, so it is the weakest diagnosis in this list and should be read as such.',
    discriminator: 'the arrived-to-completed latency band against the arrived-to-first-progress one.',
    actionable: 'BRAIN',
  };
}
