/**
 * Research that names nothing is held, re-asked with its opening, and never
 * handed straight back to the worker that just gave it up.
 *
 * Production, 2026-10-11, Cash Mode 1: card-blank needs were turned into ideas
 * whose question was "This card cannot be tested without it … State the maximum
 * cash out before the money is usable." — no opening, no source. Every worker
 * reported the fragment BLOCKED, released the bin, checked in again and was
 * handed the same bin; `bin_8131dbc5044f4ece9e97` and
 * `bin_853479a8c376474ea529` each went 0/5 to 5/5 in about two minutes, and the
 * launcher then gave each packet a fresh bin to spend the same way.
 *
 * Each repair is asserted against rows, and each was run against the code it
 * replaces to watch it fail first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { getNeed, setNeedCandidate, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createCandidate, getCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, insertClaims } from '../server/repos/research.ts';
import {
  assignNextBin,
  createBin,
  getBin,
  MAX_PACKET_BINS,
  releaseBin,
  UNTARGETED_HOLD_REASON,
  type BinProof,
} from '../server/repos/bins.ts';
import { allHeldBins } from '../server/repos/goals.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { packetMayHaveAnotherBin } from '../server/services/russell/launch.ts';
import {
  advanceDependentWork,
  isTargeted,
  TARGET_MARKER,
} from '../server/services/cash/dependentTarget.ts';
import type { BinManifest, Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (
    await createUser({
      email: `target-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
});

async function orchestration(title = 'A packet'): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', provider: 'WORKER' });
  return (
    await createOrchestration({
      projectId,
      layerId: layer.id,
      runId: run.id,
      title,
      assignment: 'Answer one question.',
      provider: 'WORKER',
    })
  ).id;
}

/** An opening, optionally harvested from a claim that says where it was published. */
async function opening(withSource: boolean): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'The RFP states a firm closing date of September 25, 2026',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  if (withSource) {
    const [claim] = await insertClaims([
      {
        orchestrationId: await orchestration('Where the opening was found'),
        fragmentId: null,
        passId: null,
        passKey: 'TARGETED',
        claim: 'Westfield County RFP 2026-441 asks for parcel ownership research, closing September 25, 2026.',
        sourceUrl: 'https://example.test/westfield/rfp-2026-441',
        sourceTitle: 'RFP 2026-441',
        sourcePublisher: 'Westfield County Purchasing',
        sourceDate: '2026-09-01',
        evidenceExcerpt: null,
        evidenceLocator: null,
        evidenceLane: 'demand_signal',
        retrievedAt: '2026-09-02',
        confidence: 0.9,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        derived: false,
        derivedFrom: [],
        accepted: true,
        contentHash: 'fixture-opening',
      },
    ]);
    await updateOpportunity(captured.value.id, { source_claim_id: claim!.id } as never);
  }
  return captured.value.id;
}

async function payerNeed(opportunityId: string): Promise<string> {
  const raised = await raiseNeed({
    projectId,
    opportunityId,
    actorRef: 'BRAIN',
    blockedAction: 'Payer for "The RFP states a firm closing date"',
    whyItMatters:
      'This card cannot be tested without it, and it is a fact about the world rather than a decision of ' +
      'yours — so Brain looks it up rather than asking you.',
    recommendedPath: 'Name the person or role who can approve payment.',
    setupEffort: 'One bounded look.',
    nextStep: 'Name the person or role who can approve payment.',
    completionCondition: 'The payer is recorded on this card.',
    blocksState: 'EXECUTING',
    requestKey: `question:${opportunityId}:payer`,
  });
  if (!raised.ok) throw new Error(raised.reason);
  return raised.value.id;
}

function manifest(): BinManifest {
  return {
    objective: 'Carry this research packet to a filed report.',
    why: 'Fixture.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a filed report'],
    outputs: ['one report'],
    authorizedActions: ['research tools'],
    prohibitedActions: ['anything external'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is terminal'],
  };
}

async function packetBin(orchestrationId: string, state: 'READY' | 'NEEDS_HUMAN' = 'READY'): Promise<string> {
  const bin = await createBin({
    projectId,
    layerId: layer.id,
    kind: 'RESEARCH_PACKET',
    title: 'A packet bin',
    objective: 'Carry this research packet to a filed report.',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 5,
  });
  if (state === 'NEEDS_HUMAN') {
    await getDb().run("UPDATE bins SET state = 'NEEDS_HUMAN', attempt_count = 5 WHERE id = ?", [bin.id]);
  }
  return bin.id;
}

async function queuedItem(orchestrationId: string): Promise<void> {
  const definition = workType('RESEARCH_SYNTHESIZE');
  await enqueueWork({
    projectId,
    workType: 'RESEARCH_SYNTHESIZE',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
  } as never);
}

describe('a question about an opening names the opening', () => {
  it('is composed from the claim the opening came from', async () => {
    const id = await opening(true);
    const needId = await payerNeed(id);

    const pass = await advanceDependentWork(projectId);
    expect(pass.started).toHaveLength(1);
    const candidate = (await getCandidate(pass.started[0]!.candidateId))!;
    expect(isTargeted(candidate.statement)).toBe(true);
    expect(candidate.statement).toContain(TARGET_MARKER);
    expect(candidate.statement).toContain('https://example.test/westfield/rfp-2026-441');
    expect(candidate.statement).toContain('RFP 2026-441 asks for parcel ownership research');
    expect(candidate.statement.startsWith('Name the person or role who can approve payment.')).toBe(true);
    expect(candidate.title).toContain('Westfield County Purchasing');
    expect((await getNeed(needId))!.candidateId).toBe(candidate.id);

    // And once, however many ticks read it.
    const again = await advanceDependentWork(projectId);
    expect(again.started).toEqual([]);
    expect(again.retargeted).toEqual([]);
  });

  it('starts nothing for an opening with no source to open, and leaves the need visibly open', async () => {
    const id = await opening(false);
    const needId = await payerNeed(id);
    const pass = await advanceDependentWork(projectId);
    expect(pass.started).toEqual([]);
    expect(pass.untargeted).toEqual([needId]);
    const need = (await getNeed(needId))!;
    expect(need.candidateId).toBeNull();
    expect(need.state).toBe('OPEN');
  });
});

describe('research already asked without a target', () => {
  async function untargetedPacket(withSource: boolean): Promise<{
    needId: string;
    oldCandidate: string;
    orchestrationId: string;
    readyBin: string;
    spentBin: string;
  }> {
    const id = await opening(withSource);
    const needId = await payerNeed(id);
    const need = (await getNeed(needId))!;
    // The old composition, exactly as `startDependentWork` used to write it.
    const old = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: need.blockedAction,
      statement: `${need.whyItMatters} ${need.nextStep}`.trim(),
    });
    expect(await setNeedCandidate(needId, old.id)).toBe(true);
    const orchestrationId = await orchestration('Payer for an opening nobody named');
    const { mission } = await launchMission({
      projectId,
      layerId: layer.id,
      visibility: 'SHARED',
      objective: 'Answer the need.',
      whyNow: 'Fixture.',
      idempotencyKey: `fixture:${old.id}`,
      candidateId: old.id,
    });
    await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [orchestrationId, mission.id]);
    const spentBin = await packetBin(orchestrationId, 'NEEDS_HUMAN');
    const readyBin = await packetBin(orchestrationId);
    await linkMission({ missionId: mission.id, binId: readyBin });
    await queuedItem(orchestrationId);
    return { needId, oldCandidate: old.id, orchestrationId, readyBin, spentBin };
  }

  it('is held out of dispatch, every row intact, and re-asked naming its opening', async () => {
    const fixture = await untargetedPacket(true);
    const worker = (await createWorker({ name: 'w-held', createdByType: 'SYSTEM', createdById: 't' })).id;

    const pass = await advanceDependentWork(projectId);
    expect(pass.held.map((one) => one.binId).sort()).toEqual([fixture.readyBin, fixture.spentBin].sort());

    // Held, not cancelled: state, attempts and generation are exactly as they were.
    const ready = (await getBin(fixture.readyBin))!;
    expect(ready.state).toBe('READY');
    expect(ready.heldReason).toBe(UNTARGETED_HOLD_REASON);
    expect(ready.heldByWorkstreamId).toBe(fixture.needId);
    const spent = (await getBin(fixture.spentBin))!;
    expect(spent.state).toBe('NEEDS_HUMAN');
    expect(spent.attemptCount).toBe(5);
    expect(spent.heldReason).toBe(UNTARGETED_HOLD_REASON);

    // No worker is handed it, and the launcher gives the packet no new bin.
    expect(await assignNextBin({ workerId: worker, projectIds: [projectId] })).toBeNull();
    expect(await packetMayHaveAnotherBin(fixture.orchestrationId)).toBe(false);

    // The goals tick manages its own holds only, so it cannot undo this one.
    expect((await allHeldBins()).map((bin) => bin.id)).not.toContain(fixture.readyBin);

    // And the need asks again, this time naming the opening.
    expect(pass.retargeted).toEqual([
      { needId: fixture.needId, from: fixture.oldCandidate, to: expect.any(String) },
    ]);
    const replacement = (await getCandidate((await getNeed(fixture.needId))!.candidateId!))!;
    expect(isTargeted(replacement.statement)).toBe(true);
    // The old idea keeps its row and its words.
    expect((await getCandidate(fixture.oldCandidate))!.statement).not.toContain(TARGET_MARKER);

    // Idempotent: nothing held twice, nothing re-asked twice.
    const again = await advanceDependentWork(projectId);
    expect(again.held).toEqual([]);
    expect(again.retargeted).toEqual([]);
  });

  it('is held even where no opening can be named, and nothing new is asked', async () => {
    const fixture = await untargetedPacket(false);
    const pass = await advanceDependentWork(projectId);
    expect(pass.held).toHaveLength(2);
    expect(pass.retargeted).toEqual([]);
    expect((await getNeed(fixture.needId))!.candidateId).toBe(fixture.oldCandidate);
    expect((await getBin(fixture.readyBin))!.heldReason).toBe(UNTARGETED_HOLD_REASON);
  });
});

describe('a released bin is not handed straight back to the worker that released it', () => {
  async function plainBin(): Promise<string> {
    const bin = await createBin({
      projectId,
      kind: 'RESEARCH_PACKET',
      title: 'A bin',
      objective: 'Fixture.',
      manifest: manifest(),
      completionContract: 'RESEARCH_PACKET_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      maxAttempts: 5,
    });
    return bin.id;
  }

  function proofOf(assigned: { bin: { id: string }; leaseId: string; leaseGeneration: number }, workerId: string): BinProof {
    return { binId: assigned.bin.id, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId };
  }

  it('backs the same worker off, charges nothing for it, and leaves another worker free to take it', async () => {
    const binId = await plainBin();
    const one = (await createWorker({ name: 'w-one', createdByType: 'SYSTEM', createdById: 't' })).id;
    const two = (await createWorker({ name: 'w-two', createdByType: 'SYSTEM', createdById: 't' })).id;

    const first = (await assignNextBin({ workerId: one, projectIds: [projectId] }))!;
    expect(first.bin.id).toBe(binId);
    expect(await releaseBin(proofOf(first, one), 'the question names no market')).toBe('OK');
    const afterRelease = (await getBin(binId))!;
    expect(afterRelease.attemptCount).toBe(1);

    // The same worker checks in again at once: nothing, and no attempt spent.
    expect(await assignNextBin({ workerId: one, projectIds: [projectId] })).toBeNull();
    expect((await getBin(binId))!.attemptCount).toBe(1);
    // Its fire is deferred to the same instant, so no sibling session is woken for it.
    expect((await getBin(binId))!.dispatchNotBefore).not.toBeNull();

    // Another worker is handed it straight away.
    const second = (await assignNextBin({ workerId: two, projectIds: [projectId] }))!;
    expect(second.bin.id).toBe(binId);
    expect(await releaseBin(proofOf(second, two), 'same blocker')).toBe('OK');

    // Once the backoff has elapsed, the first worker may have it again.
    await getDb().run(
      "UPDATE bin_events SET at = '2000-01-01T00:00:00.000Z' WHERE bin_id = ? AND event_type = 'BIN_RELEASED'",
      [binId],
    );
    const again = (await assignNextBin({ workerId: one, projectIds: [projectId] }))!;
    expect(again.bin.id).toBe(binId);
    expect((await getBin(binId))!.attemptCount).toBe(3);
  });
});

describe('a packet is not given bins for ever', () => {
  it('stops replacing bins at the bound, however much is still queued', async () => {
    const orchestrationId = await orchestration('A packet whose item is never claimable');
    await getDb().run("UPDATE research_orchestrations SET status = 'RESEARCHING' WHERE id = ?", [orchestrationId]);
    await queuedItem(orchestrationId);
    for (let index = 0; index < MAX_PACKET_BINS - 1; index += 1) {
      await packetBin(orchestrationId, 'NEEDS_HUMAN');
    }
    expect(await packetMayHaveAnotherBin(orchestrationId)).toBe(true);
    await packetBin(orchestrationId, 'NEEDS_HUMAN');
    expect(await packetMayHaveAnotherBin(orchestrationId)).toBe(false);
  });
});
