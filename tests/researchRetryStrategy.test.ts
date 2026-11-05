/**
 * A retry nobody planned still records a strategy, so the next one differs.
 * Recorded failure class: "retry repeating the same strategy".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  getFragment,
  updateFragment,
} from '../server/repos/research.ts';
import { retryFragment } from '../server/services/research/reissue.ts';
import type { Layer, Project } from '../server/domain/types.ts';

let project: Project;
let layer: Layer;
const ADMIN = { type: 'HUMAN' as const, id: 'usr_admin' };

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layer = await fixture.layerByName('Monetization Logic');
});

describe('retry without a caller-supplied plan', () => {
  it('stores a plan, and the next retry does not repeat its strategies', async () => {
    const run = await createRun({
      projectId: project.id, layerId: layer.id, runType: 'FOUNDATION',
      status: 'PLANNED', provider: 'WORKER', prompt: 'x',
    });
    const orchestration = await createOrchestration({
      projectId: project.id, layerId: layer.id, runId: run.id,
      title: 'Licensing', assignment: 'Which states.', provider: 'WORKER', autoApprove: false,
    });
    const [first] = await createFragments([{
      orchestrationId: orchestration.id, projectId: project.id, layerId: layer.id,
      fragmentIndex: 0, fragmentKey: 'tx-licence',
      question: 'Does Texas require a licence?', geography: 'Texas', timeframe: '2026',
      population: null, definitions: null,
      requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['statute'], excludedSourceTypes: [],
      completionCriteria: ['One section.'], dependsOn: [], minIndependentSources: 1,
      maxRepairs: 5, status: 'BLOCKED',
    }]);
    await updateFragment(first!.id, { status: 'BLOCKED', blockedReason: 'Thin.' });

    const one = await retryFragment({
      fragmentId: first!.id, reason: 'again', actor: ADMIN, advance: false,
    });
    const second = (await getFragment(one.newFragmentId!))!;
    const firstStrategies = second.repairPlan?.strategies ?? [];
    expect(firstStrategies.length).toBeGreaterThan(0);

    await updateFragment(second.id, { status: 'BLOCKED', blockedReason: 'Thin.' });
    const two = await retryFragment({
      fragmentId: second.id, reason: 'again', actor: ADMIN, advance: false,
    });
    const third = (await getFragment(two.newFragmentId!))!;
    const secondStrategies = third.repairPlan?.strategies ?? [];
    expect(secondStrategies.length).toBeGreaterThan(0);
    for (const strategy of secondStrategies) {
      if (strategy !== 'MARK_UNRESOLVED') expect(firstStrategies).not.toContain(strategy);
    }
  });
});
