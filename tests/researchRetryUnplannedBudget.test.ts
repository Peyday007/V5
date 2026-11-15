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
  currentFragments,
  getFragment,
  insertClaims,
  listFragments,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { FragmentNotRetryable, retryFragment } from '../server/services/research/reissue.ts';
import { recoverReachableFragments } from '../server/services/research/surfaceRecovery.ts';
import { UNREADABLE_LADDER } from '../server/services/research/repair.ts';
import { assignNextBin, createBin, putBinUnitResult } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { hashUnitValue } from '../server/services/bins/contracts.ts';
import { createWorker } from '../server/repos/identity.ts';
import { listEvents } from '../server/repos/events.ts';
import { getDb } from '../server/db/database.ts';
import type { BinManifest, Layer, Project, RepairStrategy, ResearchFragment } from '../server/domain/types.ts';

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

/**
 * Surface recovery is an unplanned retry too, and the exhausted-ladder refusal
 * has to reach it as a refusal it handles.
 *
 * Review finding F1 against 5a854b7: `retryFragment` refused an exhausted
 * ladder with `FragmentNotRetryable`, after surface recovery had already
 * raised the ceiling, and the automatic pass caught only
 * `SurfaceRecoveryRefused` — so one exhausted fragment aborted the pass for
 * every other candidate, wrote no refusal, and threw again on every pass.
 */
describe('surface recovery of a fragment whose ladder is exhausted', () => {
  const HOST_URL = 'https://www.legislature.mi.gov/';
  const SURFACE_BLOCK =
    'This is not a search-strategy failure; it is an access-refused condition in this ' +
    "worker's execution environment. EGRESS_BLOCKED on legislature.mi.gov.";

  async function surfaceBlocked(key: string, triedRungs: RepairStrategy[]): Promise<ResearchFragment> {
    const run = await createRun({
      projectId: project.id, layerId: layer.id, runType: 'FOUNDATION',
      status: 'PLANNED', provider: 'WORKER', prompt: 'x',
    });
    const orchestration = await createOrchestration({
      projectId: project.id, layerId: layer.id, runId: run.id,
      title: key, assignment: 'Which states.', provider: 'WORKER', autoApprove: false,
    });
    await updateOrchestration(orchestration.id, { status: 'NEEDS_HUMAN' });
    await createFragments([{
      orchestrationId: orchestration.id, projectId: project.id, layerId: layer.id,
      fragmentIndex: 0, fragmentKey: key,
      question: 'What conduct triggers the licence?', geography: 'Michigan', timeframe: '2026',
      population: null, definitions: null,
      requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['statute'], excludedSourceTypes: [],
      completionCriteria: ['One section.'], dependsOn: [], minIndependentSources: 1,
      maxRepairs: 3, attempt: 3, status: 'BLOCKED',
    }] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(orchestration.id);
    await updateFragment(fragment!.id, {
      status: 'BLOCKED',
      blockedReason: SURFACE_BLOCK,
      completedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    if (triedRungs.length > 0) {
      // The rungs earlier attempts already ran, as the stored plan records them.
      await getDb().run('UPDATE research_fragments SET repair_plan = ? WHERE id = ?', [
        JSON.stringify({ strategies: triedRungs, remainingBudget: 1 }),
        fragment!.id,
      ]);
    }
    const stored = (await getFragment(fragment!.id))!;
    expect(stored.blockCause).toBe('SOURCE_ACCESS');
    return stored;
  }

  async function probeReaches(url: string): Promise<void> {
    const workerId = (await createWorker({ name: 'w', createdByType: 'SYSTEM', createdById: 't' })).id;
    const manifest: BinManifest = {
      objective: 'Establish what this surface reaches.', why: 'test',
      lineage: { projectId: project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'h1', establishes: `Whether ${url} is reachable.`, input: url, transform: 'probe', dependsOn: [] }],
      acceptableSources: ['the declared URL'], excludedSources: ['a cached copy'],
      evidence: ['one reading per host'], outputs: ['readings'],
      authorizedActions: ['read the declared hosts'], prohibitedActions: ['any spend'],
      budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 30 }, stoppingConditions: ['every host has a reading'],
    };
    const bin = await createBin({
      projectId: project.id, kind: 'SURFACE_PROBE', title: 'probe', objective: manifest.objective,
      manifest, completionContract: 'SURFACE_PROBE_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    const assigned = (await assignNextBin({ workerId, projectIds: [project.id] }))!;
    const value = 'RETRIEVED 200 51200 bytes';
    await putBinUnitResult({
      binId: bin.id, unitKey: 'h1', value, contentHash: hashUnitValue(value),
      leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, submittedBy: workerId,
    });
    const outcome = await requestCompletion({
      workerId,
      proof: { binId: bin.id, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
    });
    expect(outcome.state).toBe('COMPLETE');
  }

  it('refuses the exhausted fragment with nothing changed, and still recovers the others', async () => {
    const allRungs = UNREADABLE_LADDER.filter((rung) => rung !== 'MARK_UNRESOLVED');
    const exhausted = await surfaceBlocked('exhausted', [...allRungs]);
    const fresh = await surfaceBlocked('fresh', []);
    await probeReaches(HOST_URL);

    // The pass completes: it does not throw out of the exhausted candidate.
    const pass = await recoverReachableFragments(10, { force: true });
    const byFragment = new Map(pass.map((entry) => [entry.fragmentId, entry]));
    expect(byFragment.get(exhausted.id)?.outcome).toBe('REFUSED');
    expect(byFragment.get(exhausted.id)!.reasons.join(' ')).toMatch(/already been tried/);
    expect(byFragment.get(fresh.id)?.outcome).toBe('RECOVERED');

    // Refused before anything was written: the ceiling is where it was, no
    // attempt was minted, and the fragment is still BLOCKED.
    const after = (await getFragment(exhausted.id))!;
    expect(after.maxRepairs).toBe(exhausted.maxRepairs);
    expect(after.status).toBe('BLOCKED');
    expect(await listFragments(exhausted.orchestrationId)).toHaveLength(1);

    // The recovered attempt carries the plan that was checked: a search, not a stop.
    const recovered = (await currentFragments(fresh.orchestrationId))[0]!;
    expect(recovered.attempt).toBe(fresh.attempt + 1);
    expect(recovered.repairPlan!.strategies.length).toBeGreaterThan(0);
    expect(recovered.repairPlan!.strategies).not.toContain('MARK_UNRESOLVED');

    // The refusal is recorded once, and the next pass does not retry it.
    const refusals = (await listEvents(project.id)).filter(
      (event) => event.eventType === 'RESEARCH_SURFACE_RECOVERY_REFUSED',
    );
    expect(refusals).toHaveLength(1);
    expect(await recoverReachableFragments(10, { force: true })).toEqual([]);
  });
});
