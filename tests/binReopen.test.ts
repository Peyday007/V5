/**
 * Answering a bin's escalation — and every way that must not happen.
 *
 * The state machine had no edge from `NEEDS_HUMAN` back to work. A bin
 * escalates naming a condition, a person resolves that condition, and the only
 * answers available were `CANCELLED` and `FAILED` — both of which destroy the
 * work rather than finish it. That is the same defect `advancePacket` had one
 * level up: **a state that says "waiting for a person" which that person cannot
 * resolve is not waiting; it is stuck.**
 *
 * A reopen is one step from an override, and the only thing between them is the
 * set of guards below, so most of this file is attempts to get a reopen that
 * should be refused. The state and generation guards are proven by inversion:
 * every other source state is tried, and a stale generation is tried against a
 * bin that is otherwise perfectly reopenable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  assignNextBin,
  createBin,
  getBin,
  listBinEvents,
  markBinReady,
  putBinUnitResult,
  recordBinRefusal,
  regrantBinAttempts,
  reopenNeedsHumanBin,
  terminateUnleasedBin,
  type BinProof,
} from '../server/repos/bins.ts';
import { hashUnitValue, UNIT_TRANSFORMS } from '../server/services/bins/contracts.ts';
import { reopenParkedBin, requestCompletion } from '../server/services/bins/service.ts';
import {
  createOrchestration,
  updateOrchestration,
} from '../server/repos/research.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let workerId = '';

const OPERATOR = 'operator:step-10-acceptance';
const REASON =
  'The linked packet received named-human RECORD_GAPS authorization and advanced to ' +
  'terminal COMPLETE_WITH_GAPS after this bin was previously parked.';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  workerId = (
    await createWorker({
      name: `w-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
});

function manifest(units = 2): BinManifest {
  return {
    objective: 'Establish a small set of values Brain can check for itself.',
    why: 'A bin has to be about something.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: Array.from({ length: units }, (_, index) => ({
      key: `u${index + 1}`,
      establishes: `The transform of input ${index + 1}.`,
      input: `the quick brown fox number ${index + 1}`,
      transform: index % 2 === 0 ? 'sha256' : 'reverse',
      dependsOn: [],
    })),
    acceptableSources: ['arithmetic'],
    excludedSources: ['a guess'],
    evidence: ['each value'],
    outputs: ['the values'],
    authorizedActions: ['compute'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['every unit has a value'],
  };
}

/** A deterministic bin, left READY. */
async function makeBin(
  over: { maxAttempts?: number } = {},
): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'A tiny checkable mission',
    objective: 'Establish a small set of values Brain can check for itself.',
    manifest: manifest(),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: over.maxAttempts,
  });
  return bin.id;
}

/** A packet in a chosen status. */
async function packet(status: string): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded licensing question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a bounded licensing question',
    assignment: 'the four things that answer it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(orchestration.id, {
    status: status as Parameters<typeof updateOrchestration>[1]['status'],
  });
  return orchestration.id;
}

/**
 * A bin parked at NEEDS_HUMAN the way production parks one: a worker takes it,
 * `RESEARCH_PACKET_V1` refuses to HUMAN because the packet is not terminal, and
 * the bin goes terminal carrying its attempt count and its refusal.
 *
 * Built rather than stubbed, because the whole question this file asks is what
 * may be done to a bin in that state, and a bin *put* into it by a direct write
 * would not have the history the guards are supposed to preserve.
 */
async function parkBin(
  over: { maxAttempts?: number } = {},
): Promise<{ binId: string; orchestrationId: string }> {
  const orchestrationId = await packet('NEEDS_HUMAN');
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'one real research packet',
    objective: 'drain it',
    manifest: { ...manifest(), units: [] },
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: over.maxAttempts,
  });
  const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
  expect(assigned.bin.id).toBe(bin.id);
  const outcome = await requestCompletion({
    workerId,
    proof: {
      binId: bin.id,
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.leaseGeneration,
      workerId,
    },
  });
  expect(outcome.state).toBe('NEEDS_HUMAN');
  return { binId: bin.id, orchestrationId };
}

/* ========================================================================= */

describe('a person answers the escalation and the bin goes back to work', () => {
  it('moves NEEDS_HUMAN to READY, fencing everyone who held it before', async () => {
    const { binId } = await parkBin();
    const before = (await getBin(binId))!;
    expect(before.state).toBe('NEEDS_HUMAN');

    const outcome = await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: { orchestrationStatus: 'COMPLETE_WITH_GAPS' },
    });

    if (!outcome.ok) throw new Error(`expected a reopen, got ${outcome.refusal}: ${outcome.reason}`);
    const after = (await getBin(binId))!;
    expect(after.state).toBe('READY');
    expect(after.leaseGeneration).toBe(before.leaseGeneration + 1);
    expect(outcome.previousState).toBe('NEEDS_HUMAN');
    expect(outcome.previousGeneration).toBe(before.leaseGeneration);
    expect(outcome.generation).toBe(before.leaseGeneration + 1);
    // The lease is gone with the escalation it belonged to.
    expect(after.leaseId).toBeNull();
    expect(after.workerId).toBeNull();
    expect(after.terminalReason).toBeNull();
    expect(after.completedAt).toBeNull();
  });

  it('advances the generation exactly once', async () => {
    const { binId } = await parkBin();
    const before = (await getBin(binId))!;
    await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    expect((await getBin(binId))!.leaseGeneration).toBe(before.leaseGeneration + 1);

    // A second reopen at the old generation must not move it again, and one at
    // the new generation has nothing to act on because the bin is READY.
    const stale = await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    expect(stale.ok).toBe(false);
    expect((await getBin(binId))!.leaseGeneration).toBe(before.leaseGeneration + 1);
  });

  it('keeps the attempts, the refusals and every event', async () => {
    const { binId } = await parkBin();
    const before = (await getBin(binId))!;
    const eventsBefore = await listBinEvents(binId);
    expect(before.attemptCount).toBeGreaterThan(0);
    const refusalsBefore = eventsBefore.filter((e) => e.eventType === 'BIN_COMPLETION_REFUSED');
    expect(refusalsBefore.length).toBeGreaterThan(0);

    await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });

    const after = (await getBin(binId))!;
    expect(after.attemptCount).toBe(before.attemptCount);
    expect(after.maxAttempts).toBe(before.maxAttempts);
    const eventsAfter = await listBinEvents(binId);
    // Append-only: every earlier row is still there, in order, plus one.
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    for (const [index, event] of eventsBefore.entries()) {
      expect(eventsAfter[index]!.id).toBe(event.id);
    }
    expect(
      eventsAfter.filter((e) => e.eventType === 'BIN_COMPLETION_REFUSED').length,
    ).toBe(refusalsBefore.length);
  });

  it('records an audit row naming who, why, whence and both generations', async () => {
    const { binId } = await parkBin();
    const before = (await getBin(binId))!;
    await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: { orchestrationId: 'orc_x', orchestrationStatus: 'COMPLETE_WITH_GAPS' },
    });

    const reopened = (await listBinEvents(binId)).filter((e) => e.eventType === 'BIN_REOPENED');
    expect(reopened).toHaveLength(1);
    const event = reopened[0]!;
    expect(event.reason).toBe(REASON);
    expect(event.leaseGeneration).toBe(before.leaseGeneration + 1);
    expect(event.attempt).toBe(before.attemptCount);
    const measures = event.measures as Record<string, unknown>;
    expect(measures['operator']).toBe(OPERATOR);
    expect(measures['previousState']).toBe('NEEDS_HUMAN');
    expect(measures['previousGeneration']).toBe(before.leaseGeneration);
    expect(measures['generation']).toBe(before.leaseGeneration + 1);
    expect(measures['resolutionEvidence']).toMatchObject({
      orchestrationStatus: 'COMPLETE_WITH_GAPS',
    });
  });

  it('hands the reopened bin to a worker again', async () => {
    // The point of the whole change: it earns an assignment once more.
    const { binId } = await parkBin();
    const before = (await getBin(binId))!;
    await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    const assigned = await assignNextBin({ workerId, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(binId);
  });
});

/* ========================================================================= */

describe('what a reopen refuses', () => {
  it('refuses a stale generation against an otherwise reopenable bin', async () => {
    // The inversion for the CAS. Everything else about this bin is correct.
    const { binId } = await parkBin();
    const before = (await getBin(binId))!;
    const outcome = await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration + 7,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('STALE_GENERATION');
    const after = (await getBin(binId))!;
    expect(after.state).toBe('NEEDS_HUMAN');
    expect(after.leaseGeneration).toBe(before.leaseGeneration);
    expect((await listBinEvents(binId)).some((e) => e.eventType === 'BIN_REOPENED')).toBe(false);
  });

  it('refuses every source state that is not NEEDS_HUMAN', async () => {
    // The inversion for the state guard, tried against all six.
    //
    // Built one at a time, and the two that need an assignment are built first:
    // `assignNextBin` takes whichever bin the queue orders first, so leaving a
    // spare READY bin lying around makes this test assign the wrong one.
    const cases: { state: string; binId: string }[] = [];

    const leasedId = await makeBin();
    const leasedAssignment = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
    expect(leasedAssignment.bin.id).toBe(leasedId);
    cases.push({ state: 'LEASED', binId: leasedId });

    const completeId = await makeBin();
    const takenComplete = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
    expect(takenComplete.bin.id).toBe(completeId);
    const proof: BinProof = {
      binId: completeId,
      leaseId: takenComplete.leaseId,
      leaseGeneration: takenComplete.leaseGeneration,
      workerId,
    };
    for (const unit of manifest().units) {
      const value = UNIT_TRANSFORMS[unit.transform]!(unit.input);
      await putBinUnitResult({
        binId: completeId,
        unitKey: unit.key,
        value,
        contentHash: hashUnitValue(value),
        leaseId: proof.leaseId,
        leaseGeneration: proof.leaseGeneration,
        submittedBy: workerId,
      });
    }
    expect((await requestCompletion({ workerId, proof })).state).toBe('COMPLETE');
    cases.push({ state: 'COMPLETE', binId: completeId });

    const draft = await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'drafted',
      objective: 'not ready yet',
      manifest: manifest(),
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: false,
    });
    cases.push({ state: 'DRAFT', binId: draft.id });

    const cancelledId = await makeBin();
    const cancelled = (await getBin(cancelledId))!;
    expect(
      await terminateUnleasedBin(cancelledId, cancelled.leaseGeneration, 'CANCELLED', 'no'),
    ).toBe(true);
    cases.push({ state: 'CANCELLED', binId: cancelledId });

    const failedId = await makeBin();
    const failed = (await getBin(failedId))!;
    expect(await terminateUnleasedBin(failedId, failed.leaseGeneration, 'FAILED', 'no')).toBe(true);
    cases.push({ state: 'FAILED', binId: failedId });

    // Last, so nothing above could have been assigned in its place.
    const ready = await makeBin();
    cases.push({ state: 'READY', binId: ready });

    for (const entry of cases) {
      const bin = (await getBin(entry.binId))!;
      expect(bin.state).toBe(entry.state);
      const outcome = await reopenNeedsHumanBin({
        binId: entry.binId,
        leaseGeneration: bin.leaseGeneration,
        operator: OPERATOR,
        reason: REASON,
        resolutionEvidence: {},
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.refusal).toBe('WRONG_STATE');
      // Untouched, in every one of the six.
      const after = (await getBin(entry.binId))!;
      expect(after.state).toBe(entry.state);
      expect(after.leaseGeneration).toBe(bin.leaseGeneration);
      expect((await listBinEvents(entry.binId)).some((e) => e.eventType === 'BIN_REOPENED')).toBe(
        false,
      );
    }
  });

  it('refuses a bin with no attempt left, and names the exhausted budget', async () => {
    // Reopening a bin nothing can assign is the stuck state wearing READY.
    const { binId } = await parkBin({ maxAttempts: 1 });
    const before = (await getBin(binId))!;
    expect(before.attemptCount).toBeGreaterThanOrEqual(before.maxAttempts);

    const outcome = await reopenNeedsHumanBin({
      binId,
      leaseGeneration: before.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('NO_ATTEMPTS_LEFT');
    expect(outcome.reason).toMatch(/1 of 1 assignment attempts/);
    expect(outcome.reason).toMatch(/regrant/i);
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');

    // And the named remedy actually works, which is what makes the refusal a
    // direction rather than a wall.
    await regrantBinAttempts({ binId, maxAttempts: 4, reason: 'the operator restored it' });
    const regranted = (await getBin(binId))!;
    const second = await reopenNeedsHumanBin({
      binId,
      leaseGeneration: regranted.leaseGeneration,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    expect(second.ok).toBe(true);
  });

  it('refuses a bin that does not exist', async () => {
    const outcome = await reopenNeedsHumanBin({
      binId: 'bin_nothing',
      leaseGeneration: 1,
      operator: OPERATOR,
      reason: REASON,
      resolutionEvidence: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('NOT_FOUND');
  });

  it('leaves markBinReady narrow, which is what research-ready now detects', async () => {
    /*
     * Two things at once, and they are the same fact.
     *
     * `markBinReady` must still match `DRAFT` only — the widening that was
     * explicitly not done, because its narrowness is what stops two callers
     * both believing they created dispatch intent.
     *
     * And this is exactly the predicate `step10 research-ready` now tests.
     * It used to call `markBinReady` and print `was=… now=…` with a
     * `STEP10: OK` line, which the workflow greps for — so pointed at a
     * NEEDS_HUMAN bin it changed nothing and reported success, and a full
     * activation window was spent waiting on a bin that had never moved. The
     * command now fails when the returned state is not READY.
     */
    const { binId } = await parkBin();
    const returned = await markBinReady(binId);
    expect(returned!.state).toBe('NEEDS_HUMAN');
    // The script's exact condition for `STEP10 REFUSED`.
    expect(returned?.state !== 'READY').toBe(true);
    expect((await listBinEvents(binId)).some((e) => e.eventType === 'BIN_READY')).toBe(true);
    const readyEvents = (await listBinEvents(binId)).filter((e) => e.eventType === 'BIN_READY');
    // The one from creation, and none from that call.
    expect(readyEvents).toHaveLength(1);
  });
});

/* ========================================================================= */

describe("a research bin is only reopened once its packet has actually moved", () => {
  it('reopens when the packet is terminal, and records what it read', async () => {
    // Parked while the packet was NEEDS_HUMAN, then the packet advanced —
    // which is exactly the production sequence.
    const { binId, orchestrationId } = await parkBin();
    await updateOrchestration(orchestrationId, { status: 'COMPLETE_WITH_GAPS' });

    const outcome = await reopenParkedBin({ binId, operator: OPERATOR, reason: REASON });
    if (!outcome.ok) throw new Error(`expected a reopen, got ${outcome.refusal}: ${outcome.reason}`);
    expect((await getBin(binId))!.state).toBe('READY');

    const event = (await listBinEvents(binId)).find((e) => e.eventType === 'BIN_REOPENED')!;
    expect((event.measures as Record<string, unknown>)['resolutionEvidence']).toMatchObject({
      orchestrationId,
      orchestrationStatus: 'COMPLETE_WITH_GAPS',
    });
  });

  it('refuses while the packet is still not terminal', async () => {
    // Otherwise the remedy for "the contract refused because the packet was not
    // terminal" is to spend an activation being told so again.
    const { binId } = await parkBin();

    const outcome = await reopenParkedBin({ binId, operator: OPERATOR, reason: REASON });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('WRONG_STATE');
    expect(outcome.reason).toMatch(/not terminal/i);
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');
    expect((await listBinEvents(binId)).some((e) => e.eventType === 'BIN_REOPENED')).toBe(false);
  });
});
