/**
 * A plan's shape reaches its architect while the architect can still change it.
 *
 * Reproduces the recorded failure class OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595
 * (finding F1): `validatePlan` measured a serial chain and an oversized unit, and
 * the only consumer of that measurement was a warning logged on a plan that had
 * already been accepted and installed. Nothing that could reshape the plan ever
 * read it. Now the plan bin's contract sends a flagged plan back once, with the
 * measurement, and passes it after it is reshaped or after the architect states
 * why the shape stands. No other bar moves: an error still refuses, an uncovered
 * condition still refuses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { approveChangeRequest, ensureCampaign, ensureChangeRequest } from '../server/repos/factory.ts';
import { assignNextBin, listBins, putBinUnitResult } from '../server/repos/bins.ts';
import { evaluateContract } from '../server/services/bins/contracts.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import {
  MIN_SHAPE_REASON_LENGTH,
  SHAPE_REASON_FIELD,
  shapeRevisionRequest,
  validatePlan,
} from '../server/services/factory/planner.ts';
import type { FactoryChangeRequest } from '../server/domain/factory.ts';

const OAKWOOD = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

function unit(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    kind: 'IMPLEMENTATION',
    title: key,
    objective: `Implement the ${key} change inside the files this unit owns.`,
    acceptance: ['the change is implemented and tested'],
    ownedPaths: [`src/${key}.js`],
    requiredContext: [],
    verification: ['npm test'],
    expectedArtifact: 'a diff',
    risk: 'LOW',
    criticalPath: false,
    dependsOn: [],
    serves: ['A01'],
    ...overrides,
  };
}

/** The recorded shape: disjoint files chained anyway, the root owning three modules. */
const SERIAL_OVERSIZED = {
  units: [
    unit('alpha', { ownedPaths: ['src/alpha.js', 'lib/a/one.js', 'lib/b/two.js'] }),
    unit('beta', { dependsOn: ['alpha'] }),
    unit('gamma', { dependsOn: ['beta'] }),
  ],
};

/** The same work, reshaped: split by file ownership, nothing waiting for nothing. */
const RESHAPED = {
  units: [
    unit('alpha'),
    unit('alpha-lib-a', { ownedPaths: ['lib/a/one.js'] }),
    unit('alpha-lib-b', { ownedPaths: ['lib/b/two.js'] }),
    unit('beta'),
    unit('gamma'),
  ],
};

const REASON = 'beta imports the module alpha generates at build time, so the chain is real.';

describe('shape feedback is computed with the plan (pure)', () => {
  const changeRequest = {
    repository: 'example/subject',
    objective: 'Make the subject faster.',
    mutationScope: ['src/**', 'lib/**'],
    verificationCommands: ['npm test'],
    acceptanceConditions: [{ id: 'A01', text: 'faster', mandatory: true, checkedBy: 'npm test' }],
  } as unknown as FactoryChangeRequest;

  it('carries the unanswered shape warnings, and none once a reason is stated', () => {
    const flagged = validatePlan(SERIAL_OVERSIZED, changeRequest);
    expect(flagged.ok).toBe(true);
    expect(flagged.shapeFeedback.length).toBe(2);
    expect(flagged.shapeFeedback.every((w) => w.startsWith('Shape:'))).toBe(true);
    expect(flagged.shapeReason).toBeNull();

    const answered = validatePlan({ ...SERIAL_OVERSIZED, [SHAPE_REASON_FIELD]: REASON }, changeRequest);
    expect(answered.ok).toBe(true);
    expect(answered.shapeFeedback).toEqual([]);
    expect(answered.shapeReason).toBe(REASON);
    // The measurement is still reported; only the obligation to answer it is met.
    expect(answered.warnings.some((w) => w.startsWith('Shape:'))).toBe(true);
  });

  it('does not take a token as a reason', () => {
    const token = validatePlan({ ...SERIAL_OVERSIZED, [SHAPE_REASON_FIELD]: 'ok' }, changeRequest);
    expect('ok'.length).toBeLessThan(MIN_SHAPE_REASON_LENGTH);
    expect(token.shapeReason).toBeNull();
    expect(token.shapeFeedback.length).toBe(2);
  });

  it('says what to change and how to keep the shape', () => {
    const text = shapeRevisionRequest(validatePlan(SERIAL_OVERSIZED, changeRequest).shapeFeedback);
    expect(text).toMatch(/beta -> alpha/);
    expect(text).toMatch(/split/);
    expect(text).toContain(SHAPE_REASON_FIELD);
  });
});

describe('the plan bin sends a flagged shape back before install', () => {
  let fixture: TestProject;
  let campaignId = '';
  let workerId = '';

  beforeEach(async () => {
    fixture = await freshProject();
    const approverId = (
      await createUser({
        email: `approver-${Math.random().toString(36).slice(2)}@example.test`,
        displayName: 'An approver',
        password: 'a-long-enough-password',
        isBrainAdmin: true,
        createdByType: 'SYSTEM',
        createdById: 't',
      })
    ).id;
    workerId = (await createWorker({ name: 'shape-fleet', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { setWorkerRouting } = await import('../server/repos/identity.ts');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/oakwood-junk-removal'],
      capabilities: [],
      reason: 'a factory surface for the repository under test',
      setBy: 'test',
    });
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'shape',
      objective: 'Speed up the quote path without changing what it does.',
      expectedOutcome: 'The suite still passes and the path is faster.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'the suite asserts it', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: approverId, authorityId: null });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    campaignId = campaign.id;
  });

  afterEach(async () => {
    await teardown();
  });

  async function submit(plan: unknown, hash: string) {
    await tickRemoteCampaign(campaignId);
    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_PLAN');
    const stored = await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'plan',
      value: JSON.stringify(plan),
      contentHash: hash,
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
      submittedBy: workerId,
    });
    expect(stored.stored).toBe(true);
    return { assigned: assigned!, async verdict() {
      const bin = (await listBins({ projectId: fixture.project.id })).find((b) => b.id === assigned!.bin.id)!;
      return evaluateContract(bin);
    } };
  }

  it('refuses the serial, oversized plan with its shape, and accepts the reshaped one', async () => {
    const { assigned, verdict } = await submit(SERIAL_OVERSIZED, 'h-serial');
    const first = await verdict();
    expect(first.satisfied).toBe(false);
    expect(first.disposition).toBe('RETRY');
    const said = first.reasons.join('\n');
    expect(said).toMatch(/beta -> alpha/);
    expect(said).toMatch(/`alpha` owns 3 source files across 3 directories/);
    expect(first.observed['shapeFeedback']).toHaveLength(2);

    // The architect revises within the same lease; the reshaped plan passes.
    await putBinUnitResult({
      binId: assigned.bin.id,
      unitKey: 'plan',
      value: JSON.stringify(RESHAPED),
      contentHash: 'h-reshaped',
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.leaseGeneration,
      submittedBy: workerId,
    });
    const second = await verdict();
    expect(second.satisfied).toBe(true);
    expect(second.observed['shape']).toMatchObject({ maxDepth: 1, largestUnitModules: 1 });
  });

  it('accepts the same shape once the architect says why it stands', async () => {
    const { assigned, verdict } = await submit(SERIAL_OVERSIZED, 'h-serial-2');
    expect((await verdict()).satisfied).toBe(false);
    await putBinUnitResult({
      binId: assigned.bin.id,
      unitKey: 'plan',
      value: JSON.stringify({ ...SERIAL_OVERSIZED, [SHAPE_REASON_FIELD]: REASON }),
      contentHash: 'h-reasoned',
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.leaseGeneration,
      submittedBy: workerId,
    });
    const answered = await verdict();
    expect(answered.satisfied).toBe(true);
    expect(answered.observed['shapeReason']).toBe(REASON);
  });

  it('still refuses an uncovered condition first, whatever the shape', async () => {
    const { verdict } = await submit(
      { units: [unit('alpha', { serves: [] })], [SHAPE_REASON_FIELD]: REASON },
      'h-uncovered',
    );
    const refused = await verdict();
    expect(refused.satisfied).toBe(false);
    expect(refused.reasons.join(' ')).toContain('No unit serves mandatory acceptance condition A01');
  });
});
