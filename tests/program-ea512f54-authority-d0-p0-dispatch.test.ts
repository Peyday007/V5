/**
 * repair-DISPATCH: one session was handed repeated "Review round 3" bins for
 * the same SHA (bin_401b…, bin_df2f…, bin_4120…, bin_34a7…, one session_ref),
 * so no independent review could be gathered from it. The review stage names
 * every bin of one round `factory:review:<campaign>:<round>`, and a second bin
 * of that name exists only because the first ended without an accepted
 * verdict. The replacement goes to a different session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  assignNextBin,
  createBin,
  finishBin,
  getBin,
  listBinEvents,
  type BinProof,
} from '../server/repos/bins.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let workerId = '';
const campaignId = 'fcp_dispatch_loop_test';
const SESSION_A = 'cse_01DispatchLoopSessionAaaaa';
const SESSION_B = 'cse_01DispatchLoopSessionBbbbb';

function reviewManifest(): BinManifest {
  return {
    objective: 'Judge the reviewed commit against the objective.',
    why: 'An independent review.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'review', establishes: 'a verdict', input: '{}', transform: 'FACTORY_REVIEW', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a verdict'],
    outputs: ['one submitted unit result with key `review`'],
    authorizedActions: ['read the repository'],
    prohibitedActions: ['change anything'],
    budgetUnits: null,
    retry: { maxAttempts: 2, backoffSeconds: 60 },
    stoppingConditions: ['the unit has a result'],
  };
}

async function reviewBin(round: number): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'FACTORY_REVIEW',
    title: `Review round ${round}: test`,
    objective: 'Judge the reviewed commit against the objective.',
    rationale: `Round ${round} against 99d2e019bbd1.`,
    manifest: reviewManifest(),
    completionContract: 'FACTORY_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: `factory:review:${campaignId}:${round}`,
    workloadClass: 'FACTORY_REVIEW',
    factoryCampaignId: campaignId,
    ready: true,
    maxAttempts: 2,
  });
  return bin.id;
}

const arrive = (sessionRef: string) =>
  assignNextBin({ workerId, projectIds: [projectId], sessionRef, leaseMs: 30_000 });

function proofOf(assigned: NonNullable<Awaited<ReturnType<typeof arrive>>>): BinProof {
  return {
    binId: assigned.bin.id,
    leaseId: assigned.bin.leaseId!,
    leaseGeneration: assigned.bin.leaseGeneration,
    workerId,
  };
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  workerId = (
    await createWorker({ name: `w-review-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' })
  ).id;
});

describe('repair-DISPATCH: a replacement review goes to a different session', () => {
  it('does not hand a session the same round again after its earlier bin ended without a verdict', async () => {
    const first = await reviewBin(3);
    const held = await arrive(SESSION_A);
    expect(held?.bin.id).toBe(first);
    expect((await getBin(first))?.leaseSessionRef).toBe(SESSION_A);

    // The round-3 bin ends with nothing accepted, and the stage makes another for the same round.
    expect(await finishBin(proofOf(held!), { state: 'FAILED', reason: 'no verdict was recorded' })).toBe('OK');
    const replacement = await reviewBin(3);

    // The session that already had a go is not handed it again, and nothing is charged for asking.
    expect(await arrive(SESSION_A)).toBeNull();
    const untouched = await getBin(replacement);
    expect(untouched?.state).toBe('READY');
    expect(untouched?.attemptCount).toBe(0);
    const refusals = (await listBinEvents(replacement)).filter((e) => e.eventType === 'BIN_ASSIGNMENT_REFUSED');
    expect(refusals.at(-1)?.outcome).toBe('REVIEW_ALREADY_ATTEMPTED_BY_SESSION');
    expect(refusals.at(-1)?.reason).toContain(first);

    // A different session takes it.
    const other = await arrive(SESSION_B);
    expect(other?.bin.id).toBe(replacement);
  });

  it('matches the session however its prefix is spelled', async () => {
    const first = await reviewBin(3);
    const held = await arrive(SESSION_A);
    expect(held?.bin.id).toBe(first);
    await finishBin(proofOf(held!), { state: 'FAILED', reason: 'no verdict was recorded' });
    await reviewBin(3);
    expect(await arrive(SESSION_A.replace(/^cse_/, 'session_'))).toBeNull();
  });

  it('still offers the same session the next round, which is a different review', async () => {
    const first = await reviewBin(3);
    const held = await arrive(SESSION_A);
    await finishBin(proofOf(held!), { state: 'COMPLETE', reason: 'verdict accepted' });
    const next = await reviewBin(4);
    expect(first).not.toBe(next);
    expect((await arrive(SESSION_A))?.bin.id).toBe(next);
  });
});
