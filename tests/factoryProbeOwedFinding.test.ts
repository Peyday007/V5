/**
 * A finding that only the program's protected verification module can answer
 * (production 2026-11-11: money-d0-p0, transaction-lifecycle-d0-p1 parked on
 * "probes.ts is outside the approved scope") belongs to the program, not to a
 * campaign that may never write it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  getCampaign,
} from '../server/repos/factory.ts';
import { listFindings, recordReview } from '../server/repos/factoryFleet.ts';
import { getDb } from '../server/db/database.ts';
import { isProtectedVerificationPath, queueRepairs } from '../server/services/factory/repair.ts';

const REPO = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

let fixture: TestProject;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  fixture = await freshProject();
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  await teardown();
});

async function campaignWithProbeFinding(statement: string, options: { key?: string; category?: string } = {}) {
  const approver = await createUser({
    email: `approver-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'An approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `probe-owed-${Math.random()}`,
    objective: 'Build the ledger.',
    expectedOutcome: 'The ledger records every decision.',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'r01.x-1 passes', verification: 'probe r01.x-1', mandatory: true }],
    repository: REPO,
    repositoryRoot: '',
    baseBranch: 'main',
    baseSha: BASE,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['server/services/cash/**', 'tests/program-x*.test.ts'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'decline',
    verificationCommands: ['npm test'],
  });
  await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: approver.id, authorityId: null });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'REMOTE',
  });
  await ensureUnit({
    campaignId: campaign.id,
    unitKey: 'the-work',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'work',
    objective: 'work',
    acceptance: [],
    ownedPaths: ['server/services/cash/ledger.ts'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'INTEGRATED',
  });
  await recordReview({
    campaignId: campaign.id,
    round: 1,
    scope: 'CAMPAIGN',
    reviewerSessionId: 'cse_reviewer',
    reviewedSha: BASE,
    verdict: 'CHANGES_REQUIRED',
    independence: 'SESSION_SEPARATED',
    summary: 'one finding',
    findings: [{ key: options.key ?? 'F1', severity: 'BLOCKER', category: options.category ?? 'correctness', statement, evidence: '', acceptanceConditionId: 'A01' }],
  });
  return { campaign, changeRequest };
}

describe('a finding only the protected probes module can answer', () => {
  it('is recorded as the program\'s, and does not ask for a scope no grant could give', async () => {
    const { campaign, changeRequest } = await campaignWithProbeFinding(
      'The probe r01.x-1 is not registered; it must be added to server/services/factory/program/probes.ts.',
    );
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.needsAmendment).toEqual([]);
    expect(result.queued).toEqual([]);
    const [finding] = await listFindings(campaign.id);
    expect(finding?.state).toBe('ACCEPTED_LIMITATION');
    expect(finding?.resolution).toMatch(/owed by the program/);
  });

  it('still asks for a scope amendment when the finding needs an ordinary file outside the scope', async () => {
    const { campaign, changeRequest } = await campaignWithProbeFinding(
      'The ledger must be read in server/services/goals/portfolio.ts, which ignores it.',
    );
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.needsAmendment.map((need) => need.outsideScope)).toEqual([['server/services/goals/portfolio.ts']]);
    const [finding] = await listFindings(campaign.id);
    expect(finding?.state).toBe('OPEN');
  });

  it('settles a finding keyed as a missing probe, whichever file it names', async () => {
    const { campaign, changeRequest } = await campaignWithProbeFinding(
      'The probe r01.x-1 is missing; its name appears only in scripts/program-map-release-01.py.',
      { key: 'F3-probe-missing' },
    );
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.needsAmendment).toEqual([]);
    expect(result.queued).toEqual([]);
    expect((await listFindings(campaign.id))[0]?.state).toBe('ACCEPTED_LIMITATION');
  });

  it('settles a finding about the factory\'s own process as the platform\'s', async () => {
    const { campaign, changeRequest } = await campaignWithProbeFinding(
      'Review dispatch loop: one session receives repeated round-3 review bins for the same SHA.',
      { key: 'DISPATCH', category: 'process' },
    );
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.queued).toEqual([]);
    const [finding] = await listFindings(campaign.id);
    expect(finding?.state).toBe('ACCEPTED_LIMITATION');
    expect(finding?.resolution).toMatch(/owed by the platform/);
  });
});

describe('a protected path named short of the repository root', () => {
  it('is still the protected verification path (capacity-d0-p0 named "factory/program/probes.ts")', () => {
    expect(isProtectedVerificationPath('server/services/factory/program/probes.ts')).toBe(true);
    expect(isProtectedVerificationPath('factory/program/probes.ts')).toBe(true);
    expect(isProtectedVerificationPath('program/probes.ts')).toBe(true);
    expect(isProtectedVerificationPath('domain/factoryProgram.ts')).toBe(true);
    expect(isProtectedVerificationPath('./factory/program/release01/capacityProbe.ts')).toBe(true);
    expect(isProtectedVerificationPath('freeLane/worker.ts')).toBe(false);
    expect(isProtectedVerificationPath('factory/repair.ts')).toBe(false);
    expect(isProtectedVerificationPath('probes.ts')).toBe(false);
  });
});
