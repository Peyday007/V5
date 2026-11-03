/**
 * Construction end to end (owner, 2026-11-03): a constructed round's accepted
 * repeating-buyer pattern is filed as an opening, and under brain-only mode the
 * focus caps that protect Routine time do not throttle the free lane's goal search.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { harvest, openConstructedRound, openGoalDiscovery } from '../server/services/cash/discovery.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
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
  userId = (await createUser({ email: `ch-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

afterEach(async () => {
  if (saved === undefined) delete process.env['BRAIN_CASH_RESEARCH_MAX'];
  else process.env['BRAIN_CASH_RESEARCH_MAX'] = saved;
  await setBrainOnlyMode(false, 'test', null);
});

async function goal(): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return g.id;
}

/** A finished packet behind a round's idea, holding one accepted claim in `lane`. */
async function answered(candidateId: string, lane: string, text: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: lane, description: 'buyers repeatedly paying', necessity: 'CONDITIONAL' }],
      acceptableSourceTypes: ['a price page'], excludedSourceTypes: ['a forecast'], completionCriteria: ['two dated examples'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'market-signal', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [claim] = await insertClaims([{
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
    claim: text, sourceUrl: `https://example.test/${encodeURIComponent(text.slice(0, 20))}`, sourceTitle: 'A price page', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
    evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: lane, opportunitySignal: null, closesOn: null,
    retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
    claimType: 'SOURCED_FACT' as const, contentHash: `${candidateId}|${text}`,
  }]);
  await decideClaim(claim!.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${candidateId}`, candidateId });
  await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [orchestration.id, mission.id]);
}

describe('a constructed round turns its repeating-buyer pattern into an opening', () => {
  it('files an accepted demand_pattern claim from a constructed round, and nothing untagged from anywhere else', async () => {
    const w = (await getWorkstream(await goal()))!;
    const round = await openConstructedRound({ goal: w, projectId, key: 'k1', title: 'Constructed: AI receptionist setup for HVAC firms', question: 'Which HVAC firms pay for AI receptionist setup?' });
    expect(round).not.toBeNull();
    await answered(round!.candidateId, 'demand_pattern', 'HVAC firms repeatedly pay agencies 1,500 to 5,500 USD to set up an AI receptionist.');
    // The same untagged pattern from a broad question is context, not work.
    const broad = await openGoalDiscovery({ goal: w, target: (await readGoalPlan({ goalId: w.id, evaluations: 200 }))!.target, bestReach: null });
    if (broad) await answered(broad.candidateId, 'demand_pattern', 'Dentists repeatedly pay for appointment reminders.');
    const filed = await harvest({ projectId });
    expect(filed.length).toBeGreaterThanOrEqual(1);
    const openings = await listOpportunities({ projectId });
    const hvac = openings.find((one) => one.title.startsWith('HVAC firms repeatedly pay'));
    expect(hvac?.opportunitySignal).toBe('RECURRING_OUTSOURCED_WORK');
    expect(openings.some((one) => one.title.startsWith('Dentists'))).toBe(false);
  });
});

describe('focus does not throttle the free lane’s goal search under brain-only mode', () => {
  it('keeps the routine cap without brain-only, and lifts it to the free lane when brain-only is on', async () => {
    process.env['BRAIN_CASH_RESEARCH_MAX'] = '1';
    const w = (await getWorkstream(await goal()))!;
    expect(await openConstructedRound({ goal: w, projectId, key: 'a1', title: 't', question: 'Which buyers pay for design one?' })).not.toBeNull();
    expect(await openConstructedRound({ goal: w, projectId, key: 'a2', title: 't', question: 'Which buyers pay for design two?' })).toBeNull();
    const target = (await readGoalPlan({ goalId: w.id, evaluations: 200 }))!.target;
    expect(await openGoalDiscovery({ goal: w, target, bestReach: null })).toBeNull();
    await setBrainOnlyMode(true, 'test', 'research is the free lane’s');
    expect(await openConstructedRound({ goal: w, projectId, key: 'a2', title: 't', question: 'Which buyers pay for design two?' })).not.toBeNull();
    expect(await openGoalDiscovery({ goal: w, target, bestReach: null })).not.toBeNull();
  });
});

describe('an approved goal’s own research goes first in the shared queue', () => {
  it('recognises a constructed round’s packet and a packet about an opening it found, and nothing else', async () => {
    const { servesGoalSearch } = await import('../server/services/research/packetRunner.ts');
    const w = (await getWorkstream(await goal()))!;
    const round = await openConstructedRound({ goal: w, projectId, key: 'p1', title: 'Constructed: gift brokerage', question: 'Which firms pay for year-end gift brokerage?' });
    await answered(round!.candidateId, 'demand_pattern', 'Firms repeatedly pay brokers to send year-end client gifts.');
    const mission = await getDb().get<{ orchestration_id: string }>('SELECT orchestration_id FROM russell_missions WHERE candidate_id = ?', [round!.candidateId]);
    expect(await servesGoalSearch(mission!.orchestration_id)).toBe(true);
    // A packet nothing ties to a goal is not lifted.
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const other = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    expect(await servesGoalSearch(other.id)).toBe(false);
    // A dive on the opening that round filed is the goal's too.
    await harvest({ projectId });
    const opening = (await listOpportunities({ projectId })).find((one) => one.title.startsWith('Firms repeatedly pay brokers'))!;
    const dive = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'dive', assignment: 'dive', provider: 'WORKER', autoApprove: false });
    await getDb().run('UPDATE cash_opportunities SET validation_orchestration_id = ? WHERE id = ?', [dive.id, opening.id]);
    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const idea = await createCandidate({ title: 'Dive', statement: 'Qualify the gift brokerage opening.', projectId });
    const { mission: diveMission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'dive', whyNow: 'goal', idempotencyKey: 'm:dive', candidateId: idea.id });
    await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [dive.id, diveMission.id]);
    expect(await servesGoalSearch(dive.id)).toBe(true);
  });
});
