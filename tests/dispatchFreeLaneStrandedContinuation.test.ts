/**
 * ORIGINATED:IDLE_CAPACITY:free-lane-coverage — displaced research waited on
 * the free lane, the coverage watch recorded "Displaced research is not
 * progressing" every window, and nothing continued it (rule 9). The dispatch
 * tick's pass now performs the recorded replacement: the free lane's step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { continueDisplacedWork } from '../server/services/dispatch/loop.ts';

let play: TestProject;

/** One displaced research item under a PLAY_RESEARCH bin, queued `ageMs` ago. */
async function displaced(ageMs: number): Promise<void> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const title = 'Stranded displaced research';
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title, assignment: 'A question', provider: 'WORKER', autoApprove: false,
  });
  const bin = await createBin({
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
  await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);
  const definition = workType('RESEARCH_PLAN');
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_PLAN',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    createdByType: 'SYSTEM',
  });
  await getDb().run('UPDATE work_items SET available_at = ? WHERE id = ?', [new Date(Date.now() - ageMs).toISOString(), item.id]);
}

async function coverageInterventions(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE actor_id = 'free-lane:coverage' AND kind = 'IDLE_WITH_EXECUTABLE_WORK'",
    [],
  );
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  play = await freshProject();
  delete process.env['BRAIN_CHEAP_LLM_URL'];
});

describe('the dispatch tick continues displaced research the free lane left stranded', () => {
  it('records the free-lane:coverage idle intervention and steps the free lane in the same pass', async () => {
    await displaced(45 * 60_000);
    const step = vi.fn(async () => null);
    const outcome = await continueDisplacedWork({ step });
    expect(await coverageInterventions()).toBe(1);
    expect(outcome).toEqual({ stranded: true, continued: true });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('does not step the lane when nothing is stranded', async () => {
    await displaced(60_000); // queued a minute ago: inside the window
    const step = vi.fn(async () => null);
    const outcome = await continueDisplacedWork({ step });
    expect(outcome).toEqual({ stranded: false, continued: false });
    expect(step).not.toHaveBeenCalled();
    expect(await coverageInterventions()).toBe(0);
  });

  it('never throws when the watch or the step fails', async () => {
    const failingWatch = async (): Promise<{ stranded: boolean; reason: string }> => {
      throw new Error('watch down');
    };
    await expect(continueDisplacedWork({ watch: failingWatch })).resolves.toEqual({ stranded: false, continued: false });
    const failingStep = async (): Promise<never> => {
      throw new Error('step down');
    };
    await expect(
      continueDisplacedWork({ watch: async () => ({ stranded: true, reason: 'x' }), step: failingStep }),
    ).resolves.toEqual({ stranded: true, continued: false });
  });
});
