/**
 * The one bounded self-test that turns a configured surface into a proven one.
 *
 * §32's rule, and §23's before it: a Routine registered this morning with a
 * secret in place is **CONFIGURED**, and calling it HEALTHY is a claim rather
 * than a reading. What makes it a reading is the four-row chain `proveSurface`
 * asks for — Brain fired it, a session arrived and was attributed to the bound
 * worker *from that same dispatch row*, it was handed a bin, and the bin
 * reached `COMPLETE` — and none of those rows exists until something has
 * actually been sent for.
 *
 * So there has to be something to send for, and it has to be the smallest thing
 * that can produce the whole chain. A `DETERMINISTIC_CHECK` is that: §22 already
 * describes the shape as exercising claiming, the lease, heartbeats, fencing
 * and completion without touching a document or spending anything, and a worker
 * answers it by hashing a value that travelled inside the bin.
 *
 * ---------------------------------------------------------------------------
 * Why it moved out of `scripts/fleet.ts`
 * ---------------------------------------------------------------------------
 *
 * It was `verify-surface --probe`'s private helper, reachable only from a
 * terminal. The People & Capacity page needs the identical fire for the
 * identical reason, and a second copy of it would be the fourth time in this
 * repository that one rule applied by one of two readers turned out to be worse
 * than none — here the two readers would disagree about what "proven" costs and
 * what a probe is allowed to touch.
 *
 * It creates a bin and nothing else. It registers nothing, fires nothing, mints
 * nothing and authorizes nothing: the dispatcher picks the bin up on its own
 * tick, through the routing every other bin goes through.
 */
import { createBin } from '../../repos/bins.ts';
import { listMembershipsForPrincipal } from '../../repos/identity.ts';
import type { ActorType } from '../../domain/types.ts';

export interface ProbeTarget {
  worker: { id: string; name: string };
  /** Explicit repository scope, when the surface has one. */
  repositories: string[];
  routine: { id: string; name: string; capabilities: string[] };
  /** FACTORY names a repository and must; anything else must not. */
  family: 'FACTORY' | 'RESEARCH';
}

export class ProbeRefused extends Error {}

/**
 * Create the probe bin, or say exactly why one cannot exist yet.
 *
 * Both refusals are conditions an authorized action resolves, and both name it:
 * a worker that is a member of no project can be handed nothing, and a factory
 * probe with no repository would be refused at admission for naming none.
 */
export async function createProbeBin(
  input: ProbeTarget & {
    createdByType?: ActorType;
    createdById?: string;
    /**
     * Whether the bin is dispatchable the moment it exists.
     *
     * `false` makes it a **DRAFT**, which `DISPATCHABLE_SQL` does not select —
     * so a caller that has to win a race before its bin may be fired can make
     * one speculatively, offer it, and cancel it if it loses, with no window in
     * which a losing bin could be dispatched. The caller then marks the winner
     * READY. Defaults to true, which is what the terminal command wants.
     */
    ready?: boolean;
  },
): Promise<string> {
  const memberships = (await listMembershipsForPrincipal('WORKER', input.worker.id)).filter(
    (membership) => membership.active,
  );
  const projectId = memberships[0]?.projectId;
  if (!projectId) {
    throw new ProbeRefused(
      'this surface’s worker is a member of no project, so nothing could be handed to it. ' +
        'A Brain administrator grants it one and the probe can be sent straight afterwards.',
    );
  }
  const repository = input.repositories[0];
  if (input.family === 'FACTORY' && !repository) {
    throw new ProbeRefused('this surface’s worker is authorized for no repository.');
  }

  const nonce = new Date().toISOString();
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: `Surface self-test for ${input.routine.name}`,
    objective:
      'Prove this surface can be fired, can authenticate, can be handed a bin and can finish one. ' +
      'Submit the sha-256 of the value below as the unit result. Change nothing anywhere.',
    rationale: 'capacity surface probe',
    manifest: {
      objective: 'Return the sha-256 of one value carried in this manifest.',
      why: 'a bounded proof that this Routine runs as the worker it is bound to',
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [
        { key: 'echo', establishes: 'the surface answered', input: nonce, transform: 'sha256', dependsOn: [] },
      ],
      /*
       * Only for a factory surface, and its absence is load-bearing rather than
       * cosmetic. `familyOf` reads a manifest that names a repository as
       * repository work *whatever its class says*, so a research probe carrying
       * an empty repository block would be routed as FACTORY and refused by the
       * very worker it is trying to prove.
       */
      ...(input.family === 'FACTORY' && repository
        ? {
            repository: {
              remote: `https://github.com/${repository}`,
              ref: 'main',
              baseSha: '',
              integrationBranch: '',
              pullRequest: null,
            },
          }
        : {}),
      acceptableSources: [],
      excludedSources: [],
      evidence: ['one unit result'],
      outputs: ['the sha-256 of the value in this manifest'],
      authorizedActions: ['submit the unit result', 'complete this bin'],
      prohibitedActions: [
        'cloning, reading, writing, branching or pushing to any repository',
        'creating or claiming any other work',
        'anything with an external effect',
      ],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 30 },
      stoppingConditions: ['the declared unit has a result'],
    },
    completionContract: 'DETERMINISTIC_UNITS_V1',
    /*
     * `familyOf` keys on the prefix: `FACTORY…` is repository work and
     * `SURFACE_PROBE…` is research. The probe must classify as the family it is
     * proving, or it routes to a surface other than the one under test and
     * proves nothing about it.
     */
    workloadClass: input.family === 'FACTORY' ? 'FACTORY_SURFACE_PROBE' : 'SURFACE_PROBE_RESEARCH_V1',
    requiredCapabilities: [...input.routine.capabilities],
    /*
     * Pinned to the surface it is proving, which is the difference between a
     * probe and a sample.
     *
     * Without this the bin is routed like any other, so with several Routines
     * bound to one worker — the whole point of a pool — a probe made for B is
     * very likely fired at A, and `proveSurface` then reports B unproven for
     * ever while every fire it prompted went somewhere else. Pinning narrows the
     * candidate list to one and changes nothing else: the surface still has to
     * pass state, project, family, repository, capability, rate limit and
     * target, and admission is still decided on the authenticated worker. A
     * pinned surface that cannot take it defers, which is the honest answer.
     */
    pinnedRoutineId: input.routine.id,
    createdByType: input.createdByType ?? 'SYSTEM',
    createdById: input.createdById ?? 'capacity-probe',
    ready: input.ready ?? true,
    maxAttempts: 2,
  });
  return bin.id;
}
