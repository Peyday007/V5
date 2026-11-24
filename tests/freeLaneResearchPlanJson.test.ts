/**
 * RESEARCH_PLAN replies in the shapes a model actually sends (production,
 * 2026-11-24, OPERATOR:RECURRING_OPERATIONAL_FAILURE:666553bc2f177cc1):
 * auto/best-coding had 5 of 5 RESEARCH_PLAN answers refused as "the model
 * returned no usable JSON" — the default reason, recorded whenever the reply
 * had no top-level `fragments` list, even when it parsed. A wrapped or bare
 * list of fragments is that proposal and is submitted; a reply that proposes
 * none is told what it held, once, and fails naming it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { firstJson, freeLaneTick, planFragmentsOf, planMissReason, resetFreeLaneFitness } from '../server/services/freeLane/worker.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };

const FRAGMENT = {
  key: 'receptionist-wage-us-2024',
  question: 'What is the US median hourly wage of a receptionist?',
  geography: 'United States',
  timeframe: '2024',
  population: 'Receptionists',
  definitions: 'Median hourly wage',
  required_evidence: [{ id: 'wage', description: 'an official wage statistic', necessity: 'REQUIRED' }],
  acceptable_source_types: ['official statistics'],
  completion_criteria: ['One official wage figure'],
  min_independent_sources: 1,
};

describe('reading a RESEARCH_PLAN reply', () => {
  it('reads fragments wherever the reply put them', () => {
    expect(planFragmentsOf({ fragments: [FRAGMENT], rationale: 'one question' })).toEqual({ fragments: [FRAGMENT], rationale: 'one question' });
    expect(planFragmentsOf({ plan: { fragments: [FRAGMENT], rationale: 'r' } })).toEqual({ fragments: [FRAGMENT], rationale: 'r' });
    expect(planFragmentsOf({ proposal: [FRAGMENT] })).toEqual({ fragments: [FRAGMENT] });
    // A bare list: `firstJson` reads it as claims.
    expect(planFragmentsOf(firstJson(JSON.stringify([FRAGMENT]))!)).toEqual({ fragments: [FRAGMENT] });
  });

  it('invents nothing, and says what a reply without fragments held', () => {
    expect(planFragmentsOf({ title: 'x', summary: 'y' })).toBeNull();
    expect(planFragmentsOf({ fragments: [] })).toBeNull();
    expect(planFragmentsOf({ claims: [{ claim: 'not a fragment' }] })).toBeNull();
    expect(planMissReason({ title: 'x', summary: 'y' })).toMatch(/proposed no fragments: it held keys \["title","summary"\].*top-level "fragments"/);
    expect(planMissReason({ fragments: ['a'] })).toMatch(/"fragments" list of 1 entry that are not all objects/);
  });
});

let play: TestProject;

const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: false,
  requestedUrl: url,
  finalUrl: null,
  status: 404,
  retrievedAt: new Date().toISOString(),
  reason: 'HTTP_ERROR' as never,
  detail: '404',
});

async function planItem(): Promise<string> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const title = 'AI receptionist pricing';
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title,
    assignment: 'What does a human receptionist cost per hour in the US?',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title,
    objective: title,
    orchestrationId: orchestration.id,
    manifest: {
      objective: title,
      why: 'test',
      lineage: { projectId, layerId, goal: title, orchestrationId: orchestration.id },
      units: [],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 60 },
      stoppingConditions: [],
    },
    completionContract: 'RESEARCH_PACKET_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const definition = workType('RESEARCH_PLAN');
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_PLAN',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: null,
    createdByType: 'SYSTEM',
  });
  return item.id;
}

/** A model that answers the plan prompt with the given replies in turn. */
function model(replies: string[]): { completer: Completer; prompts: string[] } {
  const prompts: string[] = [];
  const completer: Completer = async (_config, _name, _system, prompt) => {
    prompts.push(prompt);
    return replies[Math.min(prompts.length - 1, replies.length - 1)]!;
  };
  return { completer, prompts };
}

beforeEach(async () => {
  play = await freshProject();
  resetFreeLaneFitness();
  await setBrainOnlyMode(true, 'test', 'research plan json suite');
});

describe('the free lane on a RESEARCH_PLAN item', () => {
  it('submits fragments a model wrapped under another key, where it used to fail as "no usable JSON"', async () => {
    const itemId = await planItem();
    const { completer, prompts } = model([JSON.stringify({ plan: { fragments: [FRAGMENT], rationale: 'one question answers it' } })]);
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_PLAN']).toBe(1);
    expect(prompts).toHaveLength(1);
    expect((await getWorkItem(itemId))?.state).toBe('SUCCEEDED');
    const proposed = await getDb().all<{ fragment_key: string }>('SELECT fragment_key FROM research_fragments WHERE orchestration_id = (SELECT orchestration_id FROM work_items WHERE id = ?)', [itemId]);
    expect(proposed.map((one) => one.fragment_key)).toEqual([FRAGMENT.key]);
  });

  it('submits a bare list of fragments', async () => {
    const itemId = await planItem();
    const { completer } = model([`Here is the plan:\n${JSON.stringify([FRAGMENT])}`]);
    await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect((await getWorkItem(itemId))?.state).toBe('SUCCEEDED');
  });

  it('tells a reply with no fragments what it held, and is answered on the second ask', async () => {
    const itemId = await planItem();
    const { completer, prompts } = model([JSON.stringify({ title: 'Receptionist cost', summary: 'Use BLS.' }), JSON.stringify({ fragments: [FRAGMENT] })]);
    await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/held keys \["title","summary"\].*ONLY one JSON object whose top-level "fragments" key/s);
    expect((await getWorkItem(itemId))?.state).toBe('SUCCEEDED');
  });

  it('fails a reply that never proposes fragments with a reason naming what it held, not "no usable JSON"', async () => {
    const itemId = await planItem();
    const { completer, prompts } = model([JSON.stringify({ title: 'Receptionist cost', summary: 'Use BLS.' })]);
    await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(prompts).toHaveLength(2);
    const item = await getWorkItem(itemId);
    expect(item?.state).not.toBe('SUCCEEDED');
    const reasons = await getDb().all<{ reason: string | null }>(
      "SELECT reason FROM bin_events WHERE event_type LIKE 'FREE_LANE%'",
    );
    const said = reasons.map((one) => one.reason ?? '').join(' | ');
    expect(said).toMatch(/proposed no fragments: it held keys \["title","summary"\]/);
    expect(said).not.toMatch(/no usable JSON/);
  });
});
