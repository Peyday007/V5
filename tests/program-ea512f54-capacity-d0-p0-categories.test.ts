/**
 * CAP-16-3, S-0170: productive work is attributed across immediate commercial
 * discovery, deal completion, continuous broader-world research,
 * self-improvement and future-goal preparation, each job exactly once.
 *
 * `bins.purpose` alone cannot do it — commercial discovery, deal completion,
 * broader research and future-goal preparation are all PLAY_RESEARCH there —
 * so stage capacity reads the rows that consume each job's research. This
 * suite fails if the report falls back to grouping by bin purpose.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createProject } from '../server/repos/projects.ts';
import {
  ATTRIBUTION_CATEGORIES,
  attributeJob,
  stageCapacity,
  type AttributionFacts,
} from '../server/services/freeLane/stageCapacity.ts';

const NONE: AttributionFacts = {
  binPurpose: 'PLAY_RESEARCH',
  brainProject: false,
  validatesOpening: false,
  dealRound: false,
  futureGoal: false,
  commercialDiscovery: false,
};

describe('attributeJob (S-0170 categories)', () => {
  it('tells apart the four kinds of work bins.purpose lumps together as PLAY_RESEARCH', () => {
    expect(attributeJob({ ...NONE, commercialDiscovery: true }).category).toBe('IMMEDIATE_COMMERCIAL_DISCOVERY');
    expect(attributeJob({ ...NONE, validatesOpening: true }).category).toBe('DEAL_COMPLETION');
    expect(attributeJob({ ...NONE, dealRound: true }).category).toBe('DEAL_COMPLETION');
    expect(attributeJob({ ...NONE, futureGoal: true }).category).toBe('FUTURE_GOAL_PREPARATION');
    expect(attributeJob(NONE).category).toBe('BROADER_WORLD_RESEARCH');
  });

  it('attributes Brain’s own work to self-improvement, from the bin purpose or the project', () => {
    expect(attributeJob({ ...NONE, binPurpose: 'BRAIN_IMPROVEMENT' }).category).toBe('SELF_IMPROVEMENT');
    expect(attributeJob({ ...NONE, brainProject: true }).category).toBe('SELF_IMPROVEMENT');
  });

  it('gives a job matching several consumers exactly one category, the most specific', () => {
    const all: AttributionFacts = {
      binPurpose: 'PLAY_RESEARCH', brainProject: false, validatesOpening: true, dealRound: true, futureGoal: true, commercialDiscovery: true,
    };
    expect(attributeJob(all)).toEqual({ category: 'DEAL_COMPLETION', basis: 'OPENING_VALIDATION' });
    expect(attributeJob({ ...all, validatesOpening: false, dealRound: false })).toEqual({ category: 'FUTURE_GOAL_PREPARATION', basis: 'GOAL_NOT_STARTED' });
    expect(attributeJob({ ...all, binPurpose: 'BRAIN_IMPROVEMENT' }).category).toBe('SELF_IMPROVEMENT');
  });

  it('names exactly the five categories S-0170 lists', () => {
    expect([...ATTRIBUTION_CATEGORIES].sort()).toEqual([
      'BROADER_WORLD_RESEARCH', 'DEAL_COMPLETION', 'FUTURE_GOAL_PREPARATION', 'IMMEDIATE_COMMERCIAL_DISCOVERY', 'SELF_IMPROVEMENT',
    ]);
  });
});

let play: TestProject;

beforeEach(async () => {
  play = await freshProject();
});

async function orchestration(title: string): Promise<string> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const created = await createOrchestration({ projectId, layerId, runId: run.id, title, assignment: title, provider: 'WORKER', autoApprove: false });
  return created.id;
}

async function submitted(orchestrationId: string): Promise<void> {
  await recordBinEvent({ eventType: 'FREE_LANE_ITEM', outcome: 'SUBMITTED', projectId: play.project.id, orchestrationId, reason: 'model brain-a' });
}

describe('stage capacity attribution on rows (S-0170)', () => {
  it('splits PLAY_RESEARCH jobs into discovery, deal completion and broader research, each counted once', async () => {
    const projectId = play.project.id;
    const at = nowIso();
    const discovery = await orchestration('find openings');
    const validation = await orchestration('validate an opening');
    const broader = await orchestration('how a market works');

    // A cash sprint on a second project, so the play project itself is not a cash-mode project.
    const cash = await freshProjectCash(projectId, at);
    await getDb().run(
      `INSERT INTO cash_opportunities (id, project_id, cash_mode_id, owner_user_id, title, mechanism, currency,
         required_capabilities, state, created_at, updated_at, orchestration_id, validation_orchestration_id)
       VALUES (?, ?, ?, 'u', 'An opening', 'SERVICE', 'USD', '[]', 'DISCOVERED', ?, ?, ?, ?)`,
      [newId('opp'), projectId, cash, at, at, discovery, validation],
    );
    await submitted(discovery);
    await submitted(validation);
    await submitted(validation);
    await submitted(broader);

    const report = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    const by = Object.fromEntries(report.attribution.map((c) => [c.category, c.productiveJobs]));
    expect(by).toEqual({
      IMMEDIATE_COMMERCIAL_DISCOVERY: 1,
      DEAL_COMPLETION: 2,
      BROADER_WORLD_RESEARCH: 1,
      SELF_IMPROVEMENT: 0,
      FUTURE_GOAL_PREPARATION: 0,
    });
    expect(report.attributionSumsToTotal).toBe(true);
    expect(report.attribution.reduce((sum, c) => sum + c.productiveJobs, 0)).toBe(4);
  });
});

/**
 * cash_opportunities.cash_mode_id must name a cash mode; the mode is put on a
 * second project so the play project's jobs are not all commercial by project
 * membership.
 */
async function freshProjectCash(_playProjectId: string, at: string): Promise<string> {
  const other = await createProject({ name: 'Cash sprint', slug: `cash-${newId('x')}` });
  const id = newId('cm');
  await getDb().run(
    `INSERT INTO cash_modes (id, project_id, owner_user_id, objective, horizon_days, envelope_id, state, activated_at,
       created_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'u', 'cash', 30, 'env', 'ACTIVE', ?, 'u', ?, ?)`,
    [id, other.id, at, at, at],
  );
  return id;
}
