/**
 * A cash goal's research measured to its plan, and told why it falls short
 * (owner, 2026-11-05): the diagnosis reads the plan's own judgement, the next
 * goal round is asked differently for it, and an opening is traced to the
 * model — the RunPod GPU among them — whose research job produced it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, listReadings, planProgress, readGoalPlan } from '../server/services/goals/plan.ts';
import { harvest, openConstructedRound, openGoalDiscovery, REMOTE_AI_FOCUS } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { getDb } from '../server/db/database.ts';
import {
  diagnoseGoalResearch,
  diagnosisInstructions,
  goalResearchProgress,
  modelOfReason,
} from '../server/services/goals/researchYield.ts';
import type { Layer } from '../server/domain/types.ts';

const held = (missing: string[], supportedReach = 100, potentialReach: number | null = 200) =>
  ({ missing, supportedReach, potentialReach }) as Parameters<typeof diagnoseGoalResearch>[0]['considered'][number];

describe('why a goal’s research is not producing openings its plan can use', () => {
  it('names a provider’s price page with no buyer, an unsupported price and openings too small, with an instruction for each', () => {
    const diagnosis = diagnoseGoalResearch({
      considered: [held(['REACHABLE_BUYER', 'OFFER_AND_PRICE']), held(['CURRENT_DEMAND', 'OFFER_AND_PRICE']), held(['CONVERSION'])],
      excludedReasons: [],
      rounds: [{ state: 'HARVESTED', found: 1 }],
      remaining: 10_000,
    });
    expect(diagnosis.map((one) => one.cause)).toEqual(['NO_BUYER', 'NO_SUPPORTED_PRICE', 'TOO_SMALL']);
    expect(diagnosis[0]!.evidence).toBe('2 of 3 openings held lack a reachable buyer or a dated sign of demand');
    expect(diagnosisInstructions(diagnosis)).toContain('name the kind of business that pays');
  });

  it('names research that does not finish, or finishes empty, from the goal’s own rounds', () => {
    const base = { considered: [], excludedReasons: [], remaining: 10_000 };
    expect(diagnoseGoalResearch({ ...base, rounds: [{ state: 'ABANDONED', found: 0 }, { state: 'ABANDONED', found: 0 }, { state: 'OPEN', found: 0 }] }).map((d) => d.cause)).toEqual(['RESEARCH_NOT_FINISHING']);
    expect(diagnoseGoalResearch({ ...base, rounds: [{ state: 'HARVESTED', found: 0 }, { state: 'HARVESTED', found: 0 }] }).map((d) => d.cause)).toEqual(['NO_OPENINGS_REPORTED']);
    // One round that filed an opening means the search works; nothing is named.
    expect(diagnoseGoalResearch({ ...base, rounds: [{ state: 'HARVESTED', found: 0 }, { state: 'HARVESTED', found: 0 }, { state: 'HARVESTED', found: 2 }] })).toEqual([]);
  });

  it('names money limits from the openings the plan left out, and keeps a question to three instructions', () => {
    const diagnosis = diagnoseGoalResearch({
      considered: [held(['REACHABLE_BUYER', 'OFFER_AND_PRICE', 'SETTLES_IN_TIME'], 10, null)],
      excludedReasons: ['ties up 500 at its start', 'needs the owner’s physical work', 'more than the 375 one arrangement may'],
      rounds: [{ state: 'ABANDONED', found: 0 }, { state: 'ABANDONED', found: 0 }],
      remaining: 10_000,
    });
    expect(diagnosis.map((one) => one.cause)).toEqual(['RESEARCH_NOT_FINISHING', 'NO_BUYER', 'NO_SUPPORTED_PRICE', 'TOO_SMALL', 'SETTLEMENT_UNKNOWN', 'OVER_LIMITS']);
    expect(diagnosisInstructions(diagnosis).split('. ').length).toBeLessThan(diagnosis.map((d) => d.instruction).join(' ').split('. ').length);
  });

  it('reads the model from a free-lane event’s reason', () => {
    expect(modelOfReason('model runpod/Qwen/Qwen3-4B')).toBe('runpod/Qwen/Qwen3-4B');
    expect(modelOfReason('model brain-a: the model returned no usable JSON')).toBe('brain-a');
    expect(modelOfReason(null)).toBe('(unknown)');
  });
});

describe('a goal’s research reaches its plan, and the plan records its progress', () => {
  let projectId = '';
  let userId = '';
  let layer: Layer;
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    const fixture = await freshProject();
    projectId = fixture.project.id;
    layer = await fixture.layerByName('Discovery Logic');
    userId = (await createUser({ email: `gy-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
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

  /** A finished packet behind a round's idea, one accepted claim, and the free-lane job that submitted its fragment. */
  async function answeredBy(candidateId: string, text: string, model: string): Promise<void> {
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    await createFragments([
      {
        orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
        requiredEvidence: [{ id: 'demand_pattern', description: 'buyers repeatedly paying', necessity: 'CONDITIONAL' }],
        acceptableSourceTypes: ['a price page'], excludedSourceTypes: ['a forecast'], completionCriteria: ['two dated examples'],
        minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'market-signal', question: 'q', dependsOn: [], attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(orchestration.id);
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
    const [claim] = await insertClaims([{
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: text, sourceUrl: `https://example.test/${encodeURIComponent(text.slice(0, 20))}`, sourceTitle: 'A price page', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: 'demand_pattern', opportunitySignal: null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${candidateId}|${text}`,
    }]);
    await decideClaim(claim!.id, { accepted: true });
    const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${candidateId}`, candidateId });
    await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [orchestration.id, mission.id]);
    const item = await enqueueWork({
      projectId, workType: 'RESEARCH_FRAGMENT', payload: workType('RESEARCH_FRAGMENT').validate({}),
      orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM',
    });
    await recordBinEvent({
      eventType: 'FREE_LANE_ITEM', projectId, workItemId: item.id, workloadClass: 'RESEARCH_FRAGMENT',
      outcome: 'SUBMITTED', reason: `model ${model}`, durationMs: 1000, evidenceClass: 'MEASURED',
    } as Parameters<typeof recordBinEvent>[0]);
  }

  it('traces an opening to the GPU job whose fragment produced it, and the plan judges it', async () => {
    const goalId = await goal();
    const w = (await getWorkstream(goalId))!;
    const since = new Date(Date.now() - 60_000).toISOString();
    const round = await openConstructedRound({ goal: w, projectId, key: 'k1', title: 'Constructed: AI receptionist setup for HVAC firms', question: 'Which HVAC firms pay for AI receptionist setup?' });
    expect(round).not.toBeNull();
    await answeredBy(round!.candidateId, 'HVAC firms repeatedly pay agencies 1,500 to 5,500 USD to set up an AI receptionist.', 'runpod/Qwen/Qwen3-4B');
    expect((await harvest({ projectId })).length).toBeGreaterThanOrEqual(1);

    const progress = await goalResearchProgress(projectId, goalId, since);
    expect(progress.jobs['runpod/Qwen/Qwen3-4B']).toEqual({ submitted: 1, failed: 0 });
    expect(progress.claims['runpod/Qwen/Qwen3-4B']?.sourced).toBe(1);
    expect(progress.openings).toHaveLength(1);
    expect(progress.openings[0]!.model).toBe('runpod/Qwen/Qwen3-4B');

    const reading = (await readGoalPlan({ goalId, evaluations: 200, persist: true }))!;
    // Judged either way: considered, or left out with the plan's reason — a
    // fresh signal waits for its validation dive to name who pays.
    const id = progress.openings[0]!.id;
    const excluded = reading.excluded.find((one) => one.opportunityId === id);
    expect(reading.considered.some((one) => one.opportunityId === id) || !!excluded?.reason).toBe(true);
    // The plan's history records its progress, so improvement is measurable.
    const [row] = await listReadings(goalId);
    const forecast = JSON.parse(row!.forecast!) as ReturnType<typeof planProgress>;
    expect(forecast.considered).toBe(reading.considered.length);
    expect(forecast.causes).toEqual(reading.researchDiagnosis.map((one) => one.cause));
  });

  it('asks the next goal round for remote, AI-fulfilled work and tells it what was wrong last time', async () => {
    const goalId = await goal();
    const w = (await getWorkstream(goalId))!;
    const target = (await readGoalPlan({ goalId, evaluations: 200 }))!.target;
    const diagnosis = diagnosisInstructions(diagnoseGoalResearch({ considered: [held(['REACHABLE_BUYER'])], excludedReasons: [], rounds: [], remaining: 10_000 }));
    const opened = await openGoalDiscovery({ goal: w, target, bestReach: null, diagnosis });
    expect(opened).not.toBeNull();
    const row = await getDb().get<{ statement: string }>('SELECT statement FROM russell_candidates WHERE id = ?', [opened!.candidateId]);
    expect(row?.statement).toContain(REMOTE_AI_FOCUS.slice(0, 60));
    expect(row?.statement).toContain('name the kind of business that pays');
  });
});
