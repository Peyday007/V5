/**
 * GOAL_PLAN.OPENINGS.ROUNDS_FILE: a goal lens round's gated, signalled claims are
 * filed and counted on that round, however the round settled and whenever the
 * claims were gated (2026-11-12, attempt 2).
 *
 * Each case drives the real path: `openGoalDiscovery` opens the round, a real
 * mission and packet answer it, and `harvest` (with `closeEndedRounds` and the
 * settled-round attribution) files and counts. The first block passes on
 * 7819a27: the settlement chain in discovery.ts does not lose a signalled
 * claim. The production 2/39 was upstream of it, in `signalledClaims`: a goal
 * round's gated demand_signal claim that the worker did not tag was never
 * read, so the round settled found 0 (the second block fails on 7819a27).
 */
import type { OpportunitySignal } from '../server/domain/types.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { SIGNAL_LANE, harvest, nextGoalRoundFor, openGoalDiscovery } from '../server/services/cash/discovery.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import type { CashDiscoveryRound } from '../server/domain/types.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `goal-rounds-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function goalRoundOpener() {
  const { createWorkstream, getWorkstream } = await import('../server/repos/register.ts');
  const { setTerms } = await import('../server/services/goals/decide.ts');
  const { setTarget } = await import('../server/services/goals/target.ts');
  const { forgetGoalReadings, readGoalPlan } = await import('../server/services/goals/plan.ts');
  const day = 24 * 60 * 60 * 1000;
  forgetGoalReadings();
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 25 * day).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, hoursCeiling: 200, now: new Date(Date.now() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  const w = (await getWorkstream(g.id))!;
  const target = (await readGoalPlan({ goalId: g.id, evaluations: 200 }))!.target;
  return async () => {
    const opened = await openGoalDiscovery({ goal: w, target, bestReach: null });
    expect(opened).not.toBeNull();
    expect(opened!.bucketId).not.toContain('-mx-');
    return opened!;
  };
}

/** A packet launched by a round's idea, with its one fragment still being researched. */
async function launchedPacket(candidateId: string | null, attempt = 1) {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a goal lens' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a goal lens', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id,
      geography: 'anywhere',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'],
      completionCriteria: ['one dated request'], minIndependentSources: 1, maxRepairs: 2,
      fragmentIndex: 0, fragmentKey: 'goal-lens', question: 'Who pays?', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const { mission } = await launchMission({
    projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a goal lens', whyNow: 'the goal is live',
    idempotencyKey: `mission:${orchestration.id}`, candidateId, attempt,
  } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  const gate = async (claims: { claim: string; signal: OpportunitySignal | null; sourceUrl: string; lane?: string }[]) => {
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
    const inserted = await insertClaims(claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A listing', sourcePublisher: 'A marketplace',
      sourceDate: '2026-10-10', evidenceExcerpt: one.claim, evidenceLocator: 'the body', evidenceLane: one.lane ?? SIGNAL_LANE,
      opportunitySignal: one.signal, closesOn: null, retrievedAt: '2026-10-12', confidence: 0.8,
      validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.sourceUrl}`,
    })));
    for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  };
  const end = async (to: 'DONE' | 'FAILED' | 'NEEDS_HUMAN', from: 'RUNNING' | 'NEEDS_HUMAN' = 'RUNNING') =>
    transitionMission({ missionId: mission.id, from, to, terminalReason: to === 'DONE' ? null : 'stopped', waitingOn: to === 'NEEDS_HUMAN' ? 'a person' : null });
  return { gate, end, missionId: mission.id };
}

const rounds = async (bucketId: string) => (await listRounds(projectId)).filter((one) => one.bucketId === bucketId).map((one) => [one.state, one.found]);
const opening = (tag: string) => ({ claim: `A county published a paid request for ${tag} services.`, signal: 'ACTIVE_BUYER_DEMAND' as const, sourceUrl: `https://example.test/rfp/${tag}` });

describe('a goal lens round files and counts what its research found', () => {
  it('counts an opening on a round closed ABANDONED at a park, gated after the park', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.end('NEEDS_HUMAN');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 0]]);
    await p.gate([opening('a')]);
    await p.end('DONE', 'NEEDS_HUMAN');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 1]]);
  });

  it('counts an opening gated after its round closed HARVESTED', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.end('DONE');
    await harvest({ projectId });
    await p.gate([opening('c')]);
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['HARVESTED', 1]]);
  });

  it("counts a redo attempt's opening on the round its first attempt abandoned", async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p1 = await launchedPacket(r.candidateId, 1);
    await p1.end('FAILED');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 0]]);
    const p2 = await launchedPacket(r.candidateId, 2);
    await p2.gate([opening('d')]);
    await p2.end('DONE');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 1]]);
  });

  it('counts an opening gated while the parked mission is still waiting', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.end('NEEDS_HUMAN');
    await harvest({ projectId });
    await p.gate([opening('e')]);
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 1]]);
  });

  it('counts an opening gated before its mission failed', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.gate([opening('f')]);
    await p.end('FAILED');
    await harvest({ projectId, limit: 10 });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 1]]);
  });

  it('counts every opening of a round whose claims take several bounded passes', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.gate(Array.from({ length: 25 }, (_, i) => opening(`g${i}`)));
    await p.end('DONE');
    for (let i = 0; i < 4; i += 1) await harvest({ projectId, limit: 10 });
    expect(await rounds(r.bucketId)).toEqual([['HARVESTED', 25]]);
  });
});

/*
 * The recorded failure class: the research found a specific open request and
 * the gate accepted it, but the worker reported it without restating its kind.
 */
const untagged = (tag: string, lane = SIGNAL_LANE) => ({
  claim: `U.S. Navy published solicitation ${tag} for dust plugs, responses due 2026-12-01.`,
  signal: null,
  sourceUrl: `https://sam.example.test/opp/${tag}`,
  lane,
});

describe("a goal round's untagged open request is filed (GOAL_PLAN.OPENINGS.ROUNDS_FILE)", () => {
  it('files a gated, untagged demand_signal claim as an opening and counts it on the round', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.gate([untagged('N0010426QAC01')]);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['HARVESTED', 1]]);
    const filed = (await listOpportunities({ projectId })).filter((one) => one.discoveryRoundId !== null);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.opportunitySignal).toBe('ACTIVE_BUYER_DEMAND');
    expect(filed[0]!.mechanism).toBe('EXPLICIT_PAID_REQUEST');
  });

  it('files it even when it is gated after the round closed ABANDONED at a park', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    await p.end('NEEDS_HUMAN');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 0]]);
    await p.gate([untagged('140LL027Q0005')]);
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['ABANDONED', 1]]);
  });

  it('fabricates nothing: a round that found only context, or nothing, still settles found 0', async () => {
    const open = await goalRoundOpener();
    const r = await open();
    const p = await launchedPacket(r.candidateId);
    // An untagged claim in a lane that is not an opening stays evidence.
    await p.gate([untagged('ctx-1', 'market_context')]);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await rounds(r.bucketId)).toEqual([['HARVESTED', 0]]);
    expect(await listOpportunities({ projectId })).toHaveLength(0);
  });

  it('leaves a packet no goal round asked for exactly as before: untagged is not an opening', async () => {
    await goalRoundOpener();
    const p = await launchedPacket(null);
    await p.gate([untagged('broad-1')]);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await listOpportunities({ projectId })).toHaveLength(0);
  });
});

describe('nextGoalRoundFor: one documented rule for an ABANDONED round that filed nothing', () => {
  const HOUR = 60 * 60 * 1000;
  const at = (ms: number) => new Date(Date.parse('2026-11-12T00:00:00.000Z') + ms).toISOString();
  const round = (n: number, state: CashDiscoveryRound['state'], found: number, settledMs: number) =>
    ({ round: n, state, found, openedAt: at(settledMs - HOUR), harvestedAt: at(settledMs) }) as unknown as CashDiscoveryRound;

  it('reads ABANDONED with found 0 as no evidence either way (§53, §65): it neither lengthens nor resets the backoff', () => {
    const barren = [round(1, 'HARVESTED', 0, 0)];
    const withAbandoned = [round(1, 'HARVESTED', 0, 0), round(2, 'ABANDONED', 0, 0)];
    // One barren harvest: the same wait with or without the abandoned round after it.
    for (const elapsed of [24 * HOUR, 47 * HOUR, 49 * HOUR]) {
      expect(nextGoalRoundFor(barren, at(elapsed)) === null).toBe(nextGoalRoundFor(withAbandoned, at(elapsed)) === null);
    }
    // A round that filed something ends the barren streak; an abandoned one does not.
    const productive = [round(1, 'HARVESTED', 0, 0), round(2, 'ABANDONED', 1, 0)];
    expect(nextGoalRoundFor(productive, at(25 * HOUR))).toBe(3);
  });
});
