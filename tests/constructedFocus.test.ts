/**
 * §83: constructed research under focus counts research still running under a
 * closed round, never researches one design twice at once, and does not return
 * to the same buyer population once its rounds settle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { askConstructedArrangements, byLeastAsked, forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { openConstructedRound, openGoalDiscovery, SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { getDb } from '../server/db/database.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const saved = process.env['BRAIN_CASH_RESEARCH_MAX'];

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `cf-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

afterEach(() => {
  if (saved === undefined) delete process.env['BRAIN_CASH_RESEARCH_MAX'];
  else process.env['BRAIN_CASH_RESEARCH_MAX'] = saved;
});

async function sector(name: string, buyer: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: ['a forecast'], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [claim] = await insertClaims([{
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
    claim: `${buyer} buy in ${name}.`, sourceUrl: `https://example.test/${encodeURIComponent(buyer)}`, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
    evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: null, closesOn: null,
    retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
    claimType: 'SOURCED_FACT' as const, contentHash: `${buyer}|${name}`,
  }]);
  await decideClaim(claim!.id, { accepted: true });
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: buyer, origin: 'DISCOVERED', sourceClaimId: claim!.id });
}

async function goal(): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return g.id;
}

describe('constructed research under focus counts what is still running, and is never asked twice at once', () => {
  it('counts a closed round whose mission still runs against the focus cap, and refuses re-asking that design until it ends', async () => {
    process.env['BRAIN_CASH_RESEARCH_MAX'] = '1';
    const id = await goal();
    const w = (await getWorkstream(id))!;
    const first = await openConstructedRound({ goal: w, projectId, key: 'k1', title: 't', question: 'Which buyers pay for this design?' });
    expect(first).not.toBeNull();
    // The round closes (a park reads ABANDONED) long ago, while its research goes on.
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await getDb().run(`UPDATE cash_discovery_rounds SET state = 'ABANDONED', opened_at = ?, harvested_at = ? WHERE candidate_id = ?`, [longAgo, longAgo, first!.candidateId]);
    const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${first!.candidateId}`, candidateId: first!.candidateId });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    // Under focus that live research still holds the one slot: a different design waits.
    expect(await openConstructedRound({ goal: w, projectId, key: 'k2', title: 't', question: 'Which buyers pay for that design?' })).toBeNull();
    // Off focus the slot question is gone, and the same design is still not asked twice at once.
    delete process.env['BRAIN_CASH_RESEARCH_MAX'];
    expect(await openConstructedRound({ goal: w, projectId, key: 'k1', title: 't', question: 'Which buyers pay for this design?' })).toBeNull();
    await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
    expect(await openConstructedRound({ goal: w, projectId, key: 'k1', title: 't', question: 'Which buyers pay for this design?' })).not.toBeNull();
  });

  it('opens no lens round under focus, and a constructed one only within the ceiling', async () => {
    process.env['BRAIN_CASH_RESEARCH_MAX'] = '1';
    await sector('Animation', 'Production committees');
    const id = await goal();
    const w = (await getWorkstream(id))!;
    const reading = (await readGoalPlan({ goalId: id, evaluations: 500 }))!;
    expect(await askConstructedArrangements(w, reading, now, 5, 10)).toHaveLength(1);
    expect(await askConstructedArrangements(w, reading, now, 5, 10)).toHaveLength(0);
    expect(await openGoalDiscovery({ goal: w, target: reading.target, bestReach: reading.bestReach })).toBeNull();
  });
});

describe('one buyer population does not monopolize constructed research', () => {
  it('asks a never-asked population, reverse designs included, ahead of more variants of one already asked', () => {
    const a = (key: string, ref: string, structure = 'BROKER', exposure = 'SAFE') => ({ key, structure, demand: { ref }, stress: { exposure } });
    const anime = [a('a1', 'ind_anime'), a('a2', 'ind_anime', 'POOL'), a('a3', 'ind_anime', 'PRODUCE')];
    const others = [a('r1', 'reverse:x', 'POOL'), a('b1', 'ind_other', 'PRODUCE'), a('u1', 'ind_risky', 'BROKER', 'UNKNOWN')];
    const ranked = [...anime, ...others];
    const rounds = [{ bucketId: 'goal-wst_1-mx-a1' }, { bucketId: 'goal-wst_1-mx-a2' }];
    const order = byLeastAsked(ranked, rounds).map((one) => one.key);
    expect(order.indexOf('r1')).toBeLessThan(order.indexOf('a3'));
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a3'));
    // Safety stays ahead of diversity; evidence ranking still breaks ties.
    expect(order.indexOf('a3')).toBeLessThan(order.indexOf('u1'));
    expect(byLeastAsked(ranked, []).map((one) => one.key)).toEqual(['a1', 'a2', 'a3', 'r1', 'b1', 'u1']);
  });
});

describe('a goal’s own round launches ahead of broad discovery', () => {
  it('orders the goal-mechanism profile after the deep dives and before broad discovery buckets', async () => {
    const { goalMechanismProfile, profileFor } = await import('../server/services/russell/compilerProfiles.ts');
    const goalProfile = goalMechanismProfile('RUSSELL_CASH_DISCOVERY_V1')!;
    const broad = profileFor('RUSSELL_CASH_DISCOVERY_V1')!;
    const dive = profileFor('RUSSELL_CASH_VALIDATION_V1')!;
    expect(goalProfile.launchOrdinal).toBeLessThan(broad.launchOrdinal);
    expect(goalProfile.launchOrdinal).toBeGreaterThan(dive.launchOrdinal);
  });

  it('tells a worker a repeating buyer pattern is an opening of a declared kind', async () => {
    const { goalMechanismProfile, profileFor } = await import('../server/services/russell/compilerProfiles.ts');
    const goalCriteria = goalMechanismProfile('RUSSELL_CASH_DISCOVERY_V1')!.completionCriteria('any market');
    const broadCriteria = profileFor('RUSSELL_CASH_DISCOVERY_V1')!.completionCriteria('any market');
    expect(goalCriteria.some((one) => one.includes('demand_pattern') && one.includes('RECURRING_OUTSOURCED_WORK'))).toBe(true);
    expect(broadCriteria.some((one) => one.includes('RECURRING_OUTSOURCED_WORK'))).toBe(false);
  });
});
