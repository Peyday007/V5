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
  listFragments,
  updateFragment,
} from '../server/repos/research.ts';
import { FragmentNotRetryable, retryFragment } from '../server/services/research/reissue.ts';
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
    // Attempt 3 is the last permitted one (maxRepairs 2), the one that belongs to a
    // person. It is told it is the last, bar unchanged, and it is given a search —
    // never the instruction "do not attempt this".
    expect(third.repairPlan!.remainingBudget).toBe(1);
    expect(third.repairPlan!.strategies).not.toContain('MARK_UNRESOLVED');
    expect(third.repairPlan!.strategies.length).toBeGreaterThan(0);
    for (const strategy of third.repairPlan!.strategies) {
      expect(second.repairPlan!.strategies).not.toContain(strategy);
    }
  });

  it('refuses to mint an attempt once the ladder is exhausted, as the runner does', async () => {
    const { fragment, orchestrationId } = await blockedFragment(20);
    // Walk the ladder: each retry gets searches no earlier attempt ran, until
    // there are none left. The budget (20) is far from spent when that happens.
    const tried = new Set<RepairStrategy>();
    let current = fragment;
    let refusal: unknown = null;
    for (let round = 0; round < 15 && !refusal; round += 1) {
      try {
        const retried = await retryFragment({ fragmentId: current.id, reason: 'again', actor: ADMIN, advance: false });
        current = (await getFragment(retried.newFragmentId!))!;
      } catch (error) {
        refusal = error;
        break;
      }
      const strategies = current.repairPlan!.strategies.filter((s) => s !== 'MARK_UNRESOLVED');
      expect(strategies.length).toBeGreaterThan(0);
      for (const strategy of strategies) {
        expect(tried.has(strategy)).toBe(false);
        tried.add(strategy);
      }
      await block(current, orchestrationId);
      current = (await getFragment(current.id))!;
    }
    // Every search this failure suggests has been tried: another attempt would
    // repeat one, so none is minted and the fragment stays BLOCKED.
    expect(refusal).toBeInstanceOf(FragmentNotRetryable);
    expect(String((refusal as Error).message)).toMatch(/already been tried/);
    expect(current.attempt).toBeLessThan(current.maxRepairs);
    const attempts = (await listFragments(orchestrationId)).filter((f) => f.fragmentKey === fragment.fragmentKey);
    expect(attempts).toHaveLength(current.attempt);
    expect((await getFragment(current.id))!.status).toBe('BLOCKED');
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
