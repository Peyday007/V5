/**
 * An unplanned retry is planned exactly as the packet runner would plan it.
 *
 * Recorded failure class: CAPABILITY:RESEARCH.RECOVERY.RETRY — "repeated
 * failure", "retry repeating the same strategy". `retryFragment` without a
 * caller-supplied plan computed the budget from the new attempt number (one
 * short of the runner's), so a fragment with two repairs left was planned
 * MARK_UNRESOLVED and the recovery was spent being told to give up; and it
 * passed no failed condition, so the condition-keyed ladder was never used.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  getFragment,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { retryFragment } from '../server/services/research/reissue.ts';
import type { Layer, Project, RepairStrategy, ResearchFragment } from '../server/domain/types.ts';

let project: Project;
let layer: Layer;
const ADMIN = { type: 'HUMAN' as const, id: 'usr_admin' };
const SCOPE_LADDER: RepairStrategy[] = [
  'USE_CLASSIFICATION_CODES',
  'FIND_METHODOLOGY_DOCUMENTATION',
  'CHANGE_TERMINOLOGY',
  'NARROW_THE_CLAIM',
];

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layer = await fixture.layerByName('Monetization Logic');
});

async function blockedFragment(maxRepairs: number): Promise<{ fragment: ResearchFragment; orchestrationId: string }> {
  const run = await createRun({
    projectId: project.id, layerId: layer.id, runType: 'FOUNDATION',
    status: 'PLANNED', provider: 'WORKER', prompt: 'x',
  });
  const orchestration = await createOrchestration({
    projectId: project.id, layerId: layer.id, runId: run.id,
    title: 'Licensing', assignment: 'Which states.', provider: 'WORKER', autoApprove: false,
  });
  const [fragment] = await createFragments([{
    orchestrationId: orchestration.id, projectId: project.id, layerId: layer.id,
    fragmentIndex: 0, fragmentKey: 'tx-licence',
    question: 'Does Texas require a licence?', geography: 'Texas', timeframe: '2026',
    population: null, definitions: null,
    requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['statute'], excludedSourceTypes: [],
    completionCriteria: ['One section.'], dependsOn: [], minIndependentSources: 1,
    maxRepairs, status: 'BLOCKED',
  }]);
  await block(fragment!, orchestration.id);
  return { fragment: (await getFragment(fragment!.id))!, orchestrationId: orchestration.id };
}

/** The attempt failed its gate on a scope mismatch, as production records it. */
async function block(fragment: ResearchFragment, orchestrationId: string): Promise<void> {
  await insertClaims([{
    orchestrationId, fragmentId: fragment.id, passId: null, passKey: 'BROAD_SCAN',
    claim: `Licence rule, attempt ${fragment.attempt}`, sourceUrl: `https://example.test/${fragment.attempt}`,
    sourceTitle: 'A page', sourcePublisher: 'A publisher', sourceDate: '2026-01-01',
    evidenceExcerpt: 'text', evidenceLocator: 'para 1', evidenceLane: 'statute',
    retrievedAt: '2026-10-12', confidence: 0.6,
    validationState: 'SOURCED', validationDetail: null, sourced: true, claimType: 'SOURCED_FACT',
    accepted: false, rejectionReason: 'The source covers a different scope than the fragment asks.',
    contentHash: `scope-${fragment.id}`,
  }]);
  await updateFragment(fragment.id, { status: 'BLOCKED', blockedReason: 'Scope mismatch.' });
}

describe('a retry nobody planned', () => {
  it('gets the runner budget and the failed condition ladder, not MARK_UNRESOLVED', async () => {
    const { fragment, orchestrationId } = await blockedFragment(2);

    const one = await retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN, advance: false });
    const second = (await getFragment(one.newFragmentId!))!;
    const plan = second.repairPlan!;
    // The packet runner's figure for this same next attempt.
    expect(plan.remainingBudget).toBe(fragment.maxRepairs - fragment.attempt + 1);
    expect(plan.remainingBudget).toBe(2);
    expect(plan.strategies).not.toContain('MARK_UNRESOLVED');
    expect(plan.strategies.length).toBeGreaterThan(0);
    for (const strategy of plan.strategies) expect(SCOPE_LADDER).toContain(strategy);

    // The repaired attempt fails too; the next retry repeats none of its rungs.
    await block(second, orchestrationId);
    const two = await retryFragment({ fragmentId: second.id, reason: 'again', actor: ADMIN, advance: false });
    const third = (await getFragment(two.newFragmentId!))!;
    // Attempt 3 is the last permitted one (maxRepairs 2): it is told so, bar unchanged.
    expect(third.repairPlan!.remainingBudget).toBe(1);
    expect(third.repairPlan!.strategies).toEqual(['MARK_UNRESOLVED']);
  });

  it('never re-offers a rung an earlier attempt recorded', async () => {
    const { fragment, orchestrationId } = await blockedFragment(4);

    const one = await retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN, advance: false });
    const second = (await getFragment(one.newFragmentId!))!;
    const first = second.repairPlan!.strategies;
    expect(first).not.toContain('MARK_UNRESOLVED');

    await block(second, orchestrationId);
    const two = await retryFragment({ fragmentId: second.id, reason: 'again', actor: ADMIN, advance: false });
    const next = (await getFragment(two.newFragmentId!))!.repairPlan!.strategies;
    expect(next).not.toContain('MARK_UNRESOLVED');
    for (const strategy of next) expect(first).not.toContain(strategy);
  });
});
