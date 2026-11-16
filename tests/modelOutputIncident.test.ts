/**
 * A free-lane model whose answers stop being usable (production 2026-11-16
 * 18:05–19:04Z): gpt-oss-120b's RESEARCH_FRAGMENT answers listed no claims, it
 * was held back, the only other model's route was held on HTTP 429s, and 33
 * fragments waited with nothing running and nothing escalated. Simulated here
 * from the rows the worker writes: the drop is detected, recorded once with its
 * evidence (credentials removed), offered to Hermes as a deficiency the standing
 * director would commission, the queued work stays claimable, and the incident
 * closes itself when useful output returns.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import {
  ROUTE_FAILURE_LIMIT,
  answerRows,
  heldBackFor,
  recordRouteOutcome,
  resetFreeLaneFitness,
  routeHold,
  unfitPairs,
} from '../server/services/freeLane/worker.ts';
import {
  MODEL_OUTPUT_DROP,
  describeModelOutput,
  openModelOutputIncidents,
  watchModelOutput,
} from '../server/services/freeLane/coverage.ts';
import { modelOutputReading, readingId } from '../server/services/operator/director.ts';

const GPU = 'runpod/openai/gpt-oss-120b';
const FREE = 'brain-a';
const MODELS = [GPU, FREE];
const SECRET = 'api_key=abcdefghijklmnop1234';
const EMPTY_REPLY =
  `model ${GPU}: the answer did not survive Brain's own checks: 0 claim(s) offered, dropped {} from 2 source(s); ` +
  `the reply was "{\\"claims\\":[]} ${SECRET}"`;

let play: TestProject;

async function queuedFragments(n: number): Promise<string[]> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title: 'pricing', assignment: 'What does it cost?', provider: 'WORKER', autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'wage',
      question: 'What is the wage?', geography: 'United States', timeframe: '2024', population: 'Receptionists',
      definitions: 'Median', requiredEvidence: [{ id: 'wage', description: 'an official statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official statistics'], excludedSourceTypes: [], completionCriteria: ['One figure'],
      dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    },
  ]);
  const bin = await createBin({
    projectId, kind: 'RESEARCH_PACKET', title: 'pricing', objective: 'pricing', orchestrationId: orchestration.id,
    manifest: {
      objective: 'pricing', why: 'test', lineage: { projectId, layerId, goal: 'pricing', orchestrationId: orchestration.id },
      units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [],
      budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [],
    },
    completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
  });
  await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);
  const ids: string[] = [];
  const definition = workType('RESEARCH_FRAGMENT');
  for (let i = 0; i < n; i += 1) {
    const item = await enqueueWork({
      projectId, workType: 'RESEARCH_FRAGMENT', payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM',
    });
    ids.push(item.id);
  }
  return ids;
}

async function answers(workItemId: string, model: string, outcome: 'SUBMITTED' | 'FAILED_RETRYABLE', n: number, reason?: string): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workItemId, outcome, reason: reason ?? `model ${model}: submitted`, workloadClass: 'RESEARCH_FRAGMENT' });
  }
}

beforeEach(async () => {
  play = await freshProject();
  resetFreeLaneFitness();
});

describe('a model whose answers stop being usable', () => {
  it('is detected, recorded once with its evidence, escalated, keeps the work claimable, and closes when output returns', async () => {
    const queued = await queuedFragments(3);
    // The model answers, and every answer lists no claims.
    await answers(queued[0]!, GPU, 'FAILED_RETRYABLE', 6, EMPTY_REPLY);
    // The only other model's route is held on HTTP 429s.
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) {
      recordRouteOutcome(FREE, { ok: false, why: 'model call failed: cheap lane HTTP 429: rate limited' });
    }
    expect(routeHold(FREE)).not.toBeNull();

    // Detect: the failing pair, the failing stage, no functioning model, the evidence.
    const first = await watchModelOutput({ models: MODELS });
    expect(first.opened).toEqual([`${GPU}|RESEARCH_FRAGMENT`]);
    const incident = first.incidents[0]!;
    expect(incident).toMatchObject({ model: GPU, workType: 'RESEARCH_FRAGMENT', accepted: 0, rejected: 6, waiting: 3, noFunctioningModel: true });
    expect(incident.reasons[0]!.reason).toMatch(/N claim\(s\) offered/);
    expect(incident.sample).toContain('the reply was');
    expect(incident.sample).not.toContain('abcdefghijklmnop1234');
    expect(incident.others).toEqual([{ model: FREE, state: expect.stringMatching(/route failing/) }]);

    // Recorded as an incident row, and only once while it lasts.
    const rows = await getDb().all<{ outcome: string; reason: string; measures: string }>(
      'SELECT outcome, reason, measures FROM bin_events WHERE event_type = ?',
      [MODEL_OUTPUT_DROP],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('NO_FUNCTIONING_MODEL');
    expect(rows[0]!.reason).toBe(describeModelOutput(incident));
    expect(rows[0]!.measures).not.toContain('abcdefghijklmnop1234');
    expect((await watchModelOutput({ models: MODELS })).opened).toEqual([]);

    // Escalated: an ENGINEERING deficiency that blocks work, so the standing director commissions it.
    const reading = modelOutputReading(incident, describeModelOutput(incident));
    expect(reading.intervention).toBe('ENGINEERING');
    expect(reading.diagnosis.blocksGoal).toBe(true);
    expect(reading.diagnosis.ownerPaths).toEqual(['server/services/freeLane/worker.ts']);
    expect(reading.diagnosis.evidence).toContain('what the model sent');
    // Its id does not move with the counts, so Hermes and the register see one deficiency.
    const later = modelOutputReading({ ...incident, rejected: 9 }, 'x');
    expect(readingId(later)).toBe(readingId(reading));

    // Not abandoned: the work is still queued, and the failing model may still take it (#992).
    for (const id of queued) expect((await getWorkItem(id))?.state).toBe('QUEUED');
    const rowsNow = await answerRows();
    const unfit = unfitPairs(rowsNow, MODELS);
    expect(unfit.has(`${GPU}|RESEARCH_FRAGMENT`)).toBe(true);
    expect(heldBackFor(GPU, 'RESEARCH_FRAGMENT', MODELS, unfit, (m) => routeHold(m))).toBe(false);

    // The other route answers: still an incident, but routed, and no second row.
    recordRouteOutcome(FREE, { ok: true });
    const routed = await watchModelOutput({ models: MODELS });
    expect(routed.opened).toEqual([]);
    expect(routed.incidents[0]!.noFunctioningModel).toBe(false);
    expect(modelOutputReading(routed.incidents[0]!, '').diagnosis.blocksGoal).toBe(false);

    // Useful output returns: the incident closes itself.
    await answers(queued[1]!, GPU, 'SUBMITTED', 30);
    const back = await watchModelOutput({ models: MODELS });
    expect(back.incidents).toEqual([]);
    expect(back.recovered).toEqual([`${GPU}|RESEARCH_FRAGMENT`]);
    expect((await openModelOutputIncidents()).size).toBe(0);
    expect((await watchModelOutput({ models: MODELS })).recovered).toEqual([]);
  });

  it('records every route held for a kind with waiting work as no functioning model, a capacity condition', async () => {
    await queuedFragments(2);
    for (const model of MODELS) {
      for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome(model, { ok: false, why: 'model call failed: cheap lane HTTP 429' });
    }
    const watched = await watchModelOutput({ models: MODELS });
    expect(watched.opened).toEqual(['*|RESEARCH_FRAGMENT']);
    const reading = modelOutputReading(watched.incidents[0]!, describeModelOutput(watched.incidents[0]!));
    expect(reading.intervention).toBe('CAPACITY');
    expect(reading.diagnosis.blocksGoal).toBe(true);
    for (const model of MODELS) recordRouteOutcome(model, { ok: true });
    expect((await watchModelOutput({ models: MODELS })).recovered).toEqual(['*|RESEARCH_FRAGMENT']);
  });
});
