/**
 * AUTO-20-2 step 5 (S-0249), repair F-HANDOFF-NO-WORKER.
 *
 * "Use the existing execution owner ... Allocate actual workers and time; do not
 * stop at a recommendation or spec." A hand-off used to write a CASH_NEED_ROUTED
 * event nothing read and mark the gap DELIVERED. These pin, on real rows, that a
 * hand-off now gives the owner work:
 *
 * - a need routed to a connector, a counterparty or information gets one idea the
 *   research pipeline launches, pinned to the need (reused when one is alive);
 * - an opening a missed-opportunity gap hands back gets a need with a worker on it;
 * - a route that could give no worker anything is never recorded as delivered: it
 *   is set aside and the gap is valued like any other.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode, listCashEvents } from '../server/repos/cashMode.ts';
import { createOpportunity, getNeed, listNeeds } from '../server/repos/cashPortfolio.ts';
import { getCandidate as getIdea, transitionCandidate } from '../server/repos/russellCandidates.ts';
import { getCandidate, listImprovementEvents, upsertCandidate, type ImprovementCandidate } from '../server/repos/improvement.ts';
import { handNeedsToOwners, raiseNeed } from '../server/services/cash/needs.ts';
import { acquisitionAsk, startNeedWork } from '../server/services/cash/operate.ts';
import { improvementTick, OWNER_HANDOFF_PREFIX, resetImprovementTick } from '../server/services/improvement/loop.ts';
import { opportunityWeaknesses, unmetNeedWeaknesses, type NeedRow, type OriginatedWeakness } from '../server/services/selfmodel/originate.ts';

const DAY = 86_400_000;

let projectId = '';
let userId = '';
let cashModeId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const existing = await getProjectBySlug('brain-architecture');
  const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
  await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
  userId = (
    await createUser({
      email: `alloc-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple 1',
      isBrainAdmin: true,
    })
  ).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
  resetImprovementTick();
});

async function need(blockerKey: string | null, tag: string, opportunityId: string | null = null): Promise<string> {
  const raised = await raiseNeed({
    projectId,
    opportunityId,
    actorRef: 'BRAIN',
    blockedAction: `Reach the supplier (${tag})`,
    whyItMatters: 'Two openings wait on it.',
    recommendedPath: 'Connect the channel.',
    setupEffort: 'Minutes.',
    nextStep: 'Record the channel.',
    completionCondition: 'A channel is recorded.',
    requestKey: `alloc:${tag}`,
    blockerKey,
  });
  if (!raised.ok) throw new Error(raised.reason);
  return raised.value.id;
}

async function register(weakness: OriginatedWeakness | undefined): Promise<ImprovementCandidate> {
  if (!weakness) throw new Error('the originator made nothing');
  const { candidate } = await upsertCandidate({
    weaknessKey: weakness.key,
    kind: weakness.kind,
    title: weakness.title,
    problem: weakness.problem,
    metric: weakness.metric,
    downstreamMetric: weakness.downstreamMetric,
    ownerComponent: weakness.ownerComponent,
    frequency: weakness.frequency,
    denominator: weakness.denominator,
    scope: weakness.scope,
    severity: weakness.severity,
    evidence: { samples: weakness.samples, mutationScope: weakness.mutationScope, knownCause: null, origination: weakness.origination },
  });
  return candidate;
}

const row = (id: string, opportunityId: string, blockerKey: string | null): NeedRow => ({
  id,
  opportunityId,
  blockerKey,
  blockedAction: 'Reach the supplier',
  recommendedPath: 'Connect the channel.',
  expectedCostCents: null,
});

describe('a handed-off need is given a worker by its owner', () => {
  it('connector, counterparty and information needs each get one launched idea pinned to the need; watch and person needs do not', async () => {
    const connector = await need('CAPABILITY:SEND_A_MESSAGE', 'a');
    const supplier = await need('SUPPLIER:widgets', 'b');
    const evidence = await need('EVIDENCE:market-size', 'c');
    const watched = await need('DEPENDENCY:opp_1', 'd');
    const person = await need('PERSON', 'e');
    const result = await handNeedsToOwners({ needIds: [connector, supplier, evidence, watched, person], gapKey: 'gap:alloc', actorRef: 'improvement loop' });

    const byNeed = new Map(result.handed.map((h) => [h.needId, h]));
    for (const id of [connector, supplier, evidence]) {
      const work = byNeed.get(id)!.work;
      expect(work.kind).toBe('ALLOCATED');
      if (work.kind !== 'ALLOCATED') continue;
      expect(work.reused).toBe(false);
      // The idea is a real row the research pipeline picks up, and the need names it.
      const idea = (await getIdea(work.candidateId))!;
      expect(idea.state).toBe('CAPTURED');
      expect(idea.projectId).toBe(projectId);
      expect((await getNeed(id))!.candidateId).toBe(work.candidateId);
    }
    expect(byNeed.get(watched)!.work).toEqual({ kind: 'WATCH' });
    expect(byNeed.get(person)!.work).toEqual({ kind: 'PERSON' });
    expect((await getNeed(watched))!.candidateId).toBeNull();
    expect((await getNeed(person))!.candidateId).toBeNull();

    // The routed event says what work the owner was given, not only who the owner is.
    const routed = (await listCashEvents(projectId, 100)).filter((e) => e.kind === 'CASH_NEED_ROUTED');
    expect(routed).toHaveLength(5);
    const kinds = routed.map((e) => ((e.detail as Record<string, unknown>)['work'] as { kind: string }).kind).sort();
    expect(kinds).toEqual(['ALLOCATED', 'ALLOCATED', 'ALLOCATED', 'PERSON', 'WATCH']);
  });

  it('the ask follows the route and names no vendor', () => {
    const n = { blockedAction: 'send a message', recommendedPath: 'Connect it.', nextStep: 'Find the payer.', completionCondition: 'It is recorded.' };
    expect(acquisitionAsk(n, 'INTEGRATION')).toContain('acquire the missing capability');
    expect(acquisitionAsk(n, 'COMMERCIAL')).toContain('counterparty');
    expect(acquisitionAsk(n, 'RESEARCH')).toMatch(/^Find the payer\./);
    for (const route of ['INTEGRATION', 'COMMERCIAL', 'RESEARCH'] as const) expect(acquisitionAsk(n, route)).toContain('It is recorded.');
  });

  it('handing the same need again reuses its live idea; a dead idea is replaced', async () => {
    const id = await need('SUPPLIER:widgets', 'r');
    const first = await handNeedsToOwners({ needIds: [id], gapKey: 'gap:alloc', actorRef: 'improvement loop' });
    const again = await handNeedsToOwners({ needIds: [id], gapKey: 'gap:alloc', actorRef: 'improvement loop' });
    const a = first.handed[0]!.work;
    const b = again.handed[0]!.work;
    if (a.kind !== 'ALLOCATED' || b.kind !== 'ALLOCATED') throw new Error('expected work to be allocated');
    expect(b).toEqual({ kind: 'ALLOCATED', candidateId: a.candidateId, reused: true });

    expect(await transitionCandidate({ candidateId: a.candidateId, from: 'CAPTURED', to: 'REJECTED' })).toBe(true);
    const replaced = await startNeedWork((await getNeed(id))!, 'COMMERCIAL');
    expect(replaced.kind).toBe('ALLOCATED');
    if (replaced.kind !== 'ALLOCATED') return;
    expect(replaced.candidateId).not.toBe(a.candidateId);
    expect((await getNeed(id))!.candidateId).toBe(replaced.candidateId);
  });
});

describe('the loop records a hand-off only where work was allocated', () => {
  it('a routable gap is DELIVERED with the ideas its owner was given', async () => {
    const a = await need('SUPPLIER:widgets', 'a');
    const b = await need('SUPPLIER:widgets', 'b');
    const candidate = await register(unmetNeedWeaknesses([row(a, 'o1', 'SUPPLIER:widgets'), row(b, 'o2', 'SUPPLIER:widgets')])[0]);
    await improvementTick(new Date(Date.now() + 1000));
    const after = (await getCandidate(candidate.id))!;
    expect(after.deliveredRef).toBe(`${OWNER_HANDOFF_PREFIX}COMMERCIAL:server/services/cash/operate.ts`);
    const delivered = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['DELIVERED'] }))[0]!.detail;
    const work = delivered['work'] as { kind: string; candidateId?: string }[];
    expect(work).toHaveLength(2);
    expect(work.every((w) => w.kind === 'ALLOCATED' && typeof w.candidateId === 'string')).toBe(true);
    for (const id of [a, b]) expect((await getNeed(id))!.candidateId).not.toBeNull();
  });

  it('a route that could give no worker any row is set aside, never DELIVERED', async () => {
    // Every opening is already past its window, so research on it is refused.
    const past = new Date(Date.now() - DAY).toISOString();
    const o1 = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: 'Closed one', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', source: 'A publisher', expiresAt: past });
    const o2 = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: 'Closed two', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', source: 'A publisher', expiresAt: past });
    const a = await need('SUPPLIER:widgets', 'a', o1.id);
    const b = await need('SUPPLIER:widgets', 'b', o2.id);
    const candidate = await register(unmetNeedWeaknesses([row(a, o1.id, 'SUPPLIER:widgets'), row(b, o2.id, 'SUPPLIER:widgets')])[0]);
    await improvementTick(new Date(Date.now() + 1000));
    const after = (await getCandidate(candidate.id))!;
    expect(after.deliveredRef).toBeNull();
    expect(after.deliveredAt).toBeNull();
    expect(after.evidence['routeRefused']).toMatchObject({ kind: 'COMMERCIAL', owner: 'server/services/cash/operate.ts' });
    expect(await listImprovementEvents({ candidateId: candidate.id, kinds: ['DELIVERED'] })).toEqual([]);
    expect((await listImprovementEvents({ candidateId: candidate.id, kinds: ['ROUTE_SET_ASIDE'] })).length).toBe(1);
    for (const id of [a, b]) expect((await getNeed(id))!.candidateId).toBeNull();
  });

  it('a missed-opportunity gap gives each opening still inside its window a need with a worker on it', async () => {
    const now = Date.now();
    // Inside the closing window, and still far enough out for a dive (DIVE_RUNWAY_MS) to be worth it.
    const soon = new Date(now + 4.5 * DAY).toISOString();
    const openings = [];
    for (let i = 0; i < 4; i += 1) {
      openings.push(
        await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: `Opening ${i}`, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', source: 'A publisher', expiresAt: soon }),
      );
    }
    const weakness = opportunityWeaknesses(
      openings.map((o) => ({ id: o.id, title: o.title, state: o.state, expiresAt: soon })),
      new Date(now),
    ).find((w) => w.key === 'ORIGINATED:MISSED_OPPORTUNITY:CLOSING');
    const candidate = await register(weakness);
    await improvementTick(new Date(now + 1000));
    const after = (await getCandidate(candidate.id))!;
    expect(after.deliveredRef).toBe(`${OWNER_HANDOFF_PREFIX}COMMERCIAL:${candidate.ownerComponent}`);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => n.requestKey?.startsWith('gap:ORIGINATED:MISSED_OPPORTUNITY:CLOSING:'));
    expect(needs.map((n) => n.opportunityId).sort()).toEqual(openings.map((o) => o.id).sort());
    for (const n of needs) {
      expect(n.candidateId).not.toBeNull();
      expect((await getIdea(n.candidateId!))!.statement).toContain('For this specific opening');
    }
  });
});
