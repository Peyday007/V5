/**
 * AUTO-20-1 / AUTO-20-2 step 4: a hand-off route judged inadequate is not re-run
 * (repair F-ROUTED-GAP-NEVER-CHANGES-METHOD).
 *
 * The reviewer's finding: advance() handed every candidate with an execution
 * route to its owner before the next step was valued, unconditionally. When a
 * hand-off ended KEPT_NO_EFFECT or REVERTED and the weakness re-registered as
 * attempt #2, the same owner received it again by the same route, and research
 * or a Factory change to the routing were never considered (S-0242: "improve
 * the underlying method, rather than endlessly re-running it").
 *
 * These pin that a first-time route is still handed to its owner, and that a
 * route that already failed this weakness is set aside, recorded as a method
 * judged inadequate, and the next step is valued among the other options.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  decideCandidate,
  getCandidateByKey,
  listImprovementEvents,
  patchCandidate,
  upsertCandidate,
  type CandidateInput,
} from '../server/repos/improvement.ts';
import { failedHandOffs, improvementTick, ownerHandoffRef, resetImprovementTick } from '../server/services/improvement/loop.ts';
import { readGapLoop } from '../server/services/selfmodel/gapLoop.ts';

const BASE = 'TEST:ROUTED_GAP:supplier-capacity';
const ROUTE = { kind: 'INTEGRATION', owner: 'integration manager', why: 'a connector is missing' } as const;

function input(key: string, attempt: number, parentId: string | null): CandidateInput {
  return {
    weaknessKey: key,
    kind: 'ORIGINATED_UNMET_NEED',
    title: 'Opportunities wait on supplier capacity',
    problem: 'Several opportunities are blocked on supplier capacity the system cannot reach.',
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'server/services/cash/needs.ts',
    frequency: 6,
    denominator: 10,
    scope: 'LANE',
    severity: 'HIGH',
    evidence: {
      samples: ['n1', 'n2'],
      knownCause: 'no connector reaches a supplier with spare capacity',
      // No rows to hand: if the route were taken, the hand-off would reject the candidate as settled.
      origination: { family: 'UNMET_NEED', observed: [], handTo: [], route: ROUTE },
    },
    attempt,
    parentId,
  };
}

describe('a routed gap whose route already failed', () => {
  beforeEach(async () => {
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    resetImprovementTick();
  });

  it('still hands a first attempt to the owner its route names', async () => {
    await upsertCandidate(input(BASE, 1, null));
    await improvementTick(new Date(Date.now() + 1000));
    const value = (await readGapLoop(BASE)).latest.VALUE?.detail;
    expect(value?.['decision']).toBe('HAND_TO_OWNER');
  });

  it('sets the route aside, records the method inadequate, and values the next step instead of re-handing it', async () => {
    const { candidate: first } = await upsertCandidate(input(BASE, 1, null));
    await patchCandidate(first.id, { deliveredAt: new Date().toISOString(), deliveredRef: ownerHandoffRef(ROUTE) });
    await decideCandidate(first.id, 'KEPT_NO_EFFECT', 'the metric did not move after the hand-off');
    const { candidate: second } = await upsertCandidate(input(`${BASE}#2`, 2, first.id));

    expect((await failedHandOffs(second, ROUTE)).map((m) => m.attempt)).toEqual([1]);
    // A different route is not the one that failed.
    expect(await failedHandOffs(second, { kind: 'RESEARCH', owner: 'research' })).toEqual([]);

    await improvementTick(new Date(Date.now() + 1000));

    const after = (await getCandidateByKey(`${BASE}#2`))!;
    // Not handed to the same owner again.
    expect(after.deliveredRef).not.toBe(ownerHandoffRef(ROUTE));
    const delivered = await listImprovementEvents({ candidateId: second.id, kinds: ['DELIVERED'] });
    expect(delivered.filter((e) => e.detail['handedTo'] === ROUTE.owner)).toEqual([]);
    // The judgment is recorded on the candidate and as an event, naming the failed attempt.
    expect(after.evidence['routeSetAside']).toMatchObject({ kind: 'INTEGRATION', owner: ROUTE.owner, failedAttempts: [1] });
    expect(after.evidence['methodInadequacy']).toMatchObject({ failedAttempts: [1] });
    const setAside = await listImprovementEvents({ candidateId: second.id, kinds: ['ROUTE_SET_ASIDE'] });
    expect(setAside).toHaveLength(1);
    // The next step was valued among the other options, not taken as the route.
    const value = (await readGapLoop(`${BASE}#2`)).latest.VALUE?.detail;
    expect(value?.['evaluated']).toBe(true);
    expect(value?.['decision']).not.toBe('HAND_TO_OWNER');
    expect(['REUSE_EXISTING', 'COMMISSION_RESEARCH', 'FACTORY_CHANGE', 'ASK_CREDENTIAL', 'ABANDON']).toContain(value?.['decision']);

    // A second pass does not record the set-aside again.
    await improvementTick(new Date(Date.now() + 2000));
    expect(await listImprovementEvents({ candidateId: second.id, kinds: ['ROUTE_SET_ASIDE'] })).toHaveLength(1);
  });
});
