/**
 * Recovering a fragment the execution surface broke, and nothing else.
 *
 * Step 10's real research packet failed for a reason that had nothing to do
 * with the research: the worker's environment could not reach the sources. The
 * evidence gate did exactly what it should — refused two ungrounded claims,
 * spent the fragment's repair budget, blocked it with the reason recorded — and
 * the three fragments depending on it were stranded behind it. That is the
 * correct outcome and it must stay the correct outcome.
 *
 * Then the operator opened the network. Nothing in Brain could act on that.
 * `retryFragment` exists, but it is the general "give this another go" control
 * and it knows nothing about *why* the fragment failed, so using it here would
 * be indistinguishable from using it on research that simply was not good
 * enough. The difference matters more than any convenience: a mechanism that
 * cannot tell "the room was locked" from "we looked and did not find it" is a
 * mechanism for quietly re-running failed research until it passes.
 *
 * So this is deliberately the narrowest thing that does the job, and every
 * restriction is load-bearing:
 *
 *   1. **The fragment's own recorded failure must name an execution-surface
 *      condition.** Not the operator's say-so — the row Brain wrote at the time
 *      it gave up. Ordinary evidence insufficiency is refused, by name.
 *   2. **The surface change must be evidenced by a probe a worker actually
 *      ran**, recorded as a `SURFACE_PROBE_V1` bin with a `RETRIEVED` reading,
 *      completed *after* the fragment was blocked. An operator asserting that
 *      the network is open is not evidence; a fired session reaching a host is.
 *   3. **The ceiling is raised; the counter is never reset.** §5. The failed
 *      attempts stay in the history, the new attempt is numbered after them,
 *      and a reader can see the fragment failed twice before this.
 *   4. **A terminal packet is refused.** A completed packet's fragments are its
 *      provenance and are not restartable.
 *   5. **Only the named fragment is requeued.** Its dependents are restored
 *      only if they were stranded *by it* — `DEPENDENCY_DOOM_PREFIX` is how
 *      they say so — and never if they failed their own gate.
 *   6. **Everything is audited**, with the probe it relied on named in the row.
 *
 * It creates the new attempt by calling `retryFragment`, which already carries
 * every declaration forward verbatim and is already idempotent on
 * (fragment, attempt). Nothing about the evidence bar moves: the new attempt is
 * judged by the standard the last one failed.
 */
import type { ActorType, Bin, ResearchFragment, ResearchOrchestration } from '../../domain/types.ts';
import { getBin } from '../../repos/bins.ts';
import { readSurfaceProbe, type SurfaceProbeReading } from '../bins/contracts.ts';
import { currentFragments, getOrchestration, updateFragment } from '../../repos/research.ts';
import { DEPENDENCY_DOOM_PREFIX, advancePacket } from './packetRunner.ts';
import { dependencyKeys } from '../../domain/dependencies.ts';
import { retryFragment } from './reissue.ts';
import { recordEvent } from '../../repos/events.ts';
import type { AdvanceResult } from './packetRunner.ts';

export class SurfaceRecoveryRefused extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join(' '));
    this.name = 'SurfaceRecoveryRefused';
    this.reasons = reasons;
  }
}

/**
 * The vocabulary a recorded failure uses when the surface, not the search, was
 * the problem.
 *
 * Matched against what Brain itself wrote when it gave up — the fragment's
 * `blockedReason` and the `repairReason` of the attempt that failed. Kept
 * deliberately specific: `blocked` alone would match half the failures in the
 * system, and the whole point of this module is that it must not.
 */
const SURFACE_FAILURE_MARKERS: RegExp[] = [
  /egress[_\s-]?blocked/i,
  /host[_\s-]?not[_\s-]?allowed/i,
  /access[- ]refused condition/i,
  /execution (environment|surface)/i,
  /network (access|policy|egress) (is |was )?(blocked|restricted|refused)/i,
  /cannot reach (the )?(internet|network|any )/i,
];

/** Language that means the research was not good enough, which is not this. */
const INSUFFICIENCY_ONLY_MARKERS: RegExp[] = [
  /did not support the claims/i,
  /no accepted evidence/i,
  /insufficient/i,
];

export interface SurfaceRecoveryResult {
  orchestrationId: string;
  fragmentKey: string;
  previousFragmentId: string;
  newFragmentId: string | null;
  /** The attempt the failure history ends at. Unchanged by this call. */
  attemptBefore: number;
  /** The attempt the new try is numbered. Always one past the history. */
  attemptAfter: number;
  maxRepairsBefore: number;
  maxRepairsAfter: number;
  /** Dependents that were stranded behind this fragment and are live again. */
  unblockedDependents: string[];
  probeBinId: string;
  reachedHosts: string[];
  advanced: AdvanceResult | null;
}

/** Does this recorded failure name the surface rather than the search? */
export function namesSurfaceFailure(fragment: ResearchFragment): boolean {
  const recorded = `${fragment.blockedReason ?? ''}\n${fragment.repairReason ?? ''}`;
  return SURFACE_FAILURE_MARKERS.some((marker) => marker.test(recorded));
}

/**
 * The probe readings that make a surface change a fact rather than a claim.
 *
 * A probe bin counts only if it finished, only if something came back
 * `RETRIEVED`, and only if that happened after the fragment was written off —
 * a probe from before the change proves the surface was open then, which is
 * precisely what was not true.
 */
async function provenReach(input: {
  probe: Bin;
  blockedAt: string;
}): Promise<{ readings: SurfaceProbeReading[]; reached: SurfaceProbeReading[] }> {
  const readings = await readSurfaceProbe(input.probe);
  const reached = readings.filter(
    (reading) => reading.outcome === 'RETRIEVED' && reading.recordedAt > input.blockedAt,
  );
  return { readings, reached };
}

export async function recoverFragmentAfterSurfaceChange(input: {
  fragmentKey: string;
  orchestrationId: string;
  /** The `SURFACE_PROBE_V1` bin whose readings justify this. */
  probeBinId: string;
  reason: string;
  actor: { type: ActorType; id: string };
  /** How many further attempts to authorise. The ceiling rises by this much. */
  grantAttempts?: number;
}): Promise<SurfaceRecoveryResult> {
  const refusals: string[] = [];

  const orchestration = await getOrchestration(input.orchestrationId);
  if (!orchestration) throw new SurfaceRecoveryRefused(['No such orchestration.']);

  // (4) A finished packet's fragments are its provenance.
  if (orchestration.status === 'COMPLETE' || orchestration.status === 'CANCELLED') {
    throw new SurfaceRecoveryRefused([
      `That packet is ${orchestration.status}. A terminal packet's fragments are the record of ` +
        'how it reached its answer, and are not restartable.',
    ]);
  }

  const fragments = await currentFragments(orchestration.id);
  const fragment = fragments.find((entry) => entry.fragmentKey === input.fragmentKey);
  if (!fragment) {
    throw new SurfaceRecoveryRefused([
      `No current fragment "${input.fragmentKey}" in that packet.`,
    ]);
  }
  if (fragment.status !== 'BLOCKED') {
    refusals.push(
      `Fragment "${fragment.fragmentKey}" is ${fragment.status}, not BLOCKED. This recovers work ` +
        'the surface stopped, and nothing else.',
    );
  }

  // (1) The discriminator. Brain's own words at the time it gave up.
  if (fragment.status === 'BLOCKED' && !namesSurfaceFailure(fragment)) {
    const insufficiency = INSUFFICIENCY_ONLY_MARKERS.some((marker) =>
      marker.test(`${fragment.blockedReason ?? ''}\n${fragment.repairReason ?? ''}`),
    );
    refusals.push(
      `Fragment "${fragment.fragmentKey}" was not blocked by an execution-surface failure. ` +
        (insufficiency
          ? 'It was blocked because its evidence did not clear the gate, and that is not something ' +
            'a network change fixes — re-running it would be re-running research that was ' +
            'correctly refused.'
          : 'Its recorded reason names no surface condition, so there is nothing here for this ' +
            'to recover.') +
        ` Recorded reason: ${(fragment.blockedReason ?? '(none)').slice(0, 200)}`,
    );
  }

  // (2) The evidence, from a probe a worker ran.
  const probe = await getBin(input.probeBinId);
  let reached: SurfaceProbeReading[] = [];
  if (!probe || probe.completionContract !== 'SURFACE_PROBE_V1') {
    refusals.push(
      `"${input.probeBinId}" is not a SURFACE_PROBE_V1 bin. The surface change has to be evidenced ` +
        'by a probe a worker actually ran, not asserted.',
    );
  } else if (probe.state !== 'COMPLETE') {
    refusals.push(
      `Probe ${probe.id} is ${probe.state}, not COMPLETE. A probe that has not finished has not ` +
        'established anything.',
    );
  } else {
    const blockedAt = fragment.completedAt ?? fragment.updatedAt;
    const outcome = await provenReach({ probe, blockedAt });
    reached = outcome.reached;
    if (reached.length === 0) {
      refusals.push(
        `Probe ${probe.id} records no host RETRIEVED after this fragment was blocked at ` +
          `${blockedAt}. Readings: ` +
          `${outcome.readings.map((r) => `${r.host}=${r.outcome}`).join(', ') || '(none)'}. ` +
          'Without one, the surface is not shown to have changed.',
      );
    }
  }

  if (refusals.length > 0) throw new SurfaceRecoveryRefused(refusals);

  // (3) The ceiling rises. The counter is never touched.
  const grant = Math.max(1, Math.min(5, input.grantAttempts ?? 2));
  const maxRepairsBefore = fragment.maxRepairs;
  const maxRepairsAfter = Math.max(maxRepairsBefore, fragment.attempt + grant);
  if (maxRepairsAfter !== maxRepairsBefore) {
    await updateFragment(fragment.id, { maxRepairs: maxRepairsAfter });
  }

  const retried = await retryFragment({
    fragmentId: fragment.id,
    reason:
      `${input.reason.trim()} The previous ${fragment.attempt} attempt(s) failed because this ` +
      'worker surface could not reach the sources, not because the sources were searched and ' +
      'found wanting. Evidenced by probe ' +
      `${probe!.id}: ${reached.map((r) => `${r.host} RETRIEVED`).join(', ')}. Every declaration, ` +
      'source restriction and evidence lane is carried forward unchanged.',
    actor: input.actor,
    advance: false,
  });

  // (5) Only what this fragment stranded, and only if it says so.
  const unblocked = await restoreStrandedDependents({
    orchestration,
    recoveredKey: fragment.fragmentKey,
    fragments,
  });

  // (6) The audit row, naming the evidence it acted on.
  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_SURFACE_RECOVERY',
    payload: {
      orchestrationId: orchestration.id,
      fragmentKey: fragment.fragmentKey,
      previousFragmentId: fragment.id,
      newFragmentId: retried.newFragmentId,
      attemptBefore: fragment.attempt,
      attemptAfter: retried.attempt,
      maxRepairsBefore,
      maxRepairsAfter,
      probeBinId: probe!.id,
      reachedHosts: reached.map((reading) => reading.host),
      probeRecordedAt: reached.map((reading) => reading.recordedAt),
      unblockedDependents: unblocked,
      blockedReason: fragment.blockedReason,
      authorizedBy: `${input.actor.type}:${input.actor.id}`,
      reason: input.reason.trim(),
    },
  });

  const advanced = await advancePacket(orchestration.id);

  return {
    orchestrationId: orchestration.id,
    fragmentKey: fragment.fragmentKey,
    previousFragmentId: fragment.id,
    newFragmentId: retried.newFragmentId,
    attemptBefore: fragment.attempt,
    attemptAfter: retried.attempt,
    maxRepairsBefore,
    maxRepairsAfter,
    unblockedDependents: unblocked,
    probeBinId: probe!.id,
    reachedHosts: reached.map((reading) => reading.host),
    advanced,
  };
}

/**
 * Put back exactly what the recovered fragment stranded.
 *
 * A dependent qualifies only if it is BLOCKED *and* its recorded reason is the
 * one `blockOnFailedDependency` writes — a fragment that failed its own gate
 * carries a different reason and is left exactly where it is. Iterated to a
 * fixpoint so a fragment two levels down comes back too, and bounded by the
 * fragment count because a dependency graph with a cycle would not have been
 * planned in the first place.
 */
async function restoreStrandedDependents(input: {
  orchestration: ResearchOrchestration;
  recoveredKey: string;
  fragments: ResearchFragment[];
}): Promise<string[]> {
  const { orchestration, recoveredKey, fragments } = input;
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));
  const live = new Set<string>([recoveredKey]);
  const restored: string[] = [];

  for (let pass = 0; pass < fragments.length + 1; pass += 1) {
    let changed = false;
    for (const fragment of fragments) {
      if (live.has(fragment.fragmentKey)) continue;
      if (fragment.status !== 'BLOCKED') continue;
      if (!(fragment.blockedReason ?? '').startsWith(DEPENDENCY_DOOM_PREFIX)) continue;

      /*
       * Every dependency has to be back, not just one of them.
       *
       * The first version asked whether *any* dependency was live again, and a
       * test caught it immediately: `exemption-inclusion` depends on both the
       * recovered fragment and on one that failed its own gate, and it was put
       * back into QUEUED with a HARD dependency still BLOCKED underneath it.
       * The runner would only have re-doomed it, so nothing would have broken —
       * which is exactly why it is worth fixing rather than leaving: a fragment
       * reported as unblocked while its foundation is still missing is a false
       * statement in the audit row, and the row is the point.
       */
      const deps = dependencyKeys(fragment.dependsOn);
      if (!deps.some((key) => live.has(key))) continue;
      const stillMissing = deps.some(
        (key) => !live.has(key) && byKey.get(key)?.status === 'BLOCKED',
      );
      if (stillMissing) continue;

      await updateFragment(fragment.id, {
        status: 'QUEUED',
        blockedReason: null,
        completedAt: null,
      });
      await recordEvent({
        projectId: orchestration.projectId,
        layerId: orchestration.layerId,
        entityType: 'RUN',
        entityId: orchestration.runId,
        eventType: 'RESEARCH_FRAGMENT_UNBLOCKED',
        payload: {
          orchestrationId: orchestration.id,
          fragmentId: fragment.id,
          fragmentKey: fragment.fragmentKey,
          because: `${recoveredKey} is being attempted again, so what it stranded is live again.`,
        },
      });
      live.add(fragment.fragmentKey);
      restored.push(fragment.fragmentKey);
      changed = true;
    }
    if (!changed) break;
  }
  return restored;
}
