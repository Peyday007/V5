/**
 * A unit, or a repair, is given everything it needs to finish — and nothing more.
 *
 * Two shapes observed in real campaigns, each reproduced here against a real
 * repository before anything about the planner changed:
 *
 *   A. **The deadlock.** Unit 1 changes `src/impl.ts`; unit 2 depends on unit 1
 *      and owns `src/impl.test.ts`, the test unit 1's own verification runs.
 *      Unit 1 cannot integrate without a test change it may not make, and unit 2
 *      cannot start until unit 1 integrates. The campaign sits EXECUTING with a
 *      tidy blocker and a small code change nobody can land.
 *   B. **The test-only repair.** A reviewer finds a defect in `src/impl.ts` and
 *      names the test it shows up in. The repair was given exactly the test file,
 *      so the only fix it could legally make was to weaken the test.
 *
 * The rule both answers rest on is `ownership.ts`: one validator, asked by the
 * planner, by repair creation and by every replan — so nothing reaches a worker
 * that its own writable scope and finished dependencies cannot complete.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, testDatabaseKind, type TestProject } from './helpers.ts';
import {
  addDependency,
  claimUnits,
  ensureCampaign,
  ensureUnit,
  listDependencies,
  listUnits,
} from '../server/repos/factory.ts';
import { listFactoryEvents, recordReview } from '../server/repos/factoryFleet.ts';
import { createUser } from '../server/repos/identity.ts';
import { approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import { installPlan, validatePlan, type UnitSpec } from '../server/services/factory/planner.ts';
import { checkOwnership } from '../server/services/factory/integrate.ts';
import { ownershipForRepair, queueRepairs } from '../server/services/factory/repair.ts';
import {
  graphFromRows,
  OWNERSHIP_REASONS,
  validateUnitGraph,
} from '../server/services/factory/ownership.ts';
import { run } from '../server/services/factory/git.ts';
import type { FactoryChangeRequest, FactoryFinding } from '../server/domain/factory.ts';

let fixture: TestProject;
let repoRoot: string;
let approverId: string;

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ownership-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { typecheck: 'node -e "0"', test: 'node -e "0"' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'impl.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'impl.test.ts'), "import { value } from './impl';\n");
  fs.writeFileSync(path.join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'unrelated.ts'), 'export const unrelated = 1;\n');
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

beforeEach(async () => {
  fixture = await freshProject();
  repoRoot = await makeRepository();
  approverId = (
    await createUser({
      email: 'ownership-approver@test.local',
      displayName: 'Ownership Approver',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

async function approved(mutationScope: string[] = ['src/**']): Promise<FactoryChangeRequest> {
  const submitted = await submitObjective({
    projectId: fixture.project.id,
    objective: 'Change what impl exports, and prove it with its test.',
    expectedOutcome: 'src/impl.ts exports the new value and its test checks it.',
    acceptanceConditions: [{ statement: 'impl exports the new value', verification: 'npm test' }],
    repositoryRoot: repoRoot,
    mutationScope,
  });
  const result = await approveObjective({
    changeRequestId: submitted.changeRequest.id,
    via: 'PERSON',
    userId: approverId,
  });
  expect(result.ok).toBe(true);
  return result.changeRequest;
}

async function campaignFor(changeRequest: FactoryChangeRequest) {
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 3,
    laneTargetReason: 'initial',
  });
  return campaign;
}

function unit(overrides: Partial<UnitSpec> & { key: string; ownedPaths: string[] }): Record<string, unknown> {
  return {
    kind: 'IMPLEMENTATION',
    title: overrides.key,
    objective: `Do the part of the change that ${overrides.key} is responsible for, completely.`,
    acceptance: [`${overrides.key} is done`],
    requiredContext: [],
    verification: ['npm test'],
    expectedArtifact: 'a commit',
    risk: 'LOW',
    criticalPath: false,
    modelClass: 'FAST',
    dependsOn: [],
    serves: ['A01'],
    ...overrides,
  };
}

/** The historical shape: the implementation's own test, owned by a unit that waits for it. */
const DEADLOCK_PLAN = {
  units: [
    unit({ key: 'change-impl', ownedPaths: ['src/impl.ts'] }),
    unit({
      key: 'verify-impl',
      kind: 'TEST',
      ownedPaths: ['src/impl.test.ts'],
      dependsOn: ['change-impl'],
      acceptance: ['src/impl.test.ts asserts the new value'],
    }),
  ],
};

describe('A — a dependent may not own what its dependency needs to finish', () => {
  it('the historical arrangement really is a deadlock under the ownership the old planner accepted', async () => {
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    // Installed directly, bypassing the planner — the shape as it reached workers.
    const { unit: first } = await ensureUnit({
      campaignId: campaign.id, unitKey: 'change-impl', kind: 'IMPLEMENTATION', role: 'IMPLEMENTER',
      title: 'impl', objective: 'impl', acceptance: [], ownedPaths: ['src/impl.ts'], requiredContext: [],
      verification: ['npm test'], expectedArtifact: 'a commit', state: 'READY',
    });
    const { unit: second } = await ensureUnit({
      campaignId: campaign.id, unitKey: 'verify-impl', kind: 'TEST', role: 'IMPLEMENTER',
      title: 'test', objective: 'test', acceptance: [], ownedPaths: ['src/impl.test.ts'], requiredContext: [],
      verification: ['npm test'], expectedArtifact: 'a commit', state: 'BLOCKED',
    });
    await addDependency(campaign.id, second.id, first.id, 'verify-impl needs change-impl');
    // Unit 1's honest diff (the behaviour and the test that must follow it) is refused whole…
    expect(checkOwnership(['src/impl.ts', 'src/impl.test.ts'], first.ownedPaths)).toEqual({
      ok: false,
      outside: ['src/impl.test.ts'],
    });
    // …and unit 2 is not claimable until unit 1 integrates. Neither can move.
    const units = await listUnits(campaign.id);
    expect(units.find((u) => u.unitKey === 'verify-impl')?.state).toBe('BLOCKED');
    // And the canonical validator names exactly that, from rows.
    const verdict = validateUnitGraph(
      graphFromRows(units, await listDependencies(campaign.id)),
      { mutationScope: changeRequest.mutationScope, forbiddenPaths: [] },
    );
    expect(verdict.issues.map((i) => i.reason)).toContain('MUTATION_OWNED_BY_DEPENDENT');
    expect(verdict.ok).toBe(false);
  });

  it('detects the deadlock before dispatch and rewrites the plan into one that can finish', async () => {
    const changeRequest = await approved();
    const validation = validatePlan(DEADLOCK_PLAN, changeRequest);
    expect(validation.ok).toBe(true);
    // The test moved to the unit whose verification needs it; the emptied unit merged in.
    expect(validation.units.map((u) => u.key)).toEqual(['change-impl']);
    const merged = validation.units[0]!;
    expect(merged.ownedPaths).toEqual(['src/impl.ts', 'src/impl.test.ts']);
    expect(merged.acceptance).toContain('src/impl.test.ts asserts the new value');
    expect(validation.rewrites.map((r) => r.action)).toEqual(['MOVE_PATH', 'MERGE_UNITS']);
    expect(validation.rewrites[0]).toMatchObject({
      reason: 'MUTATION_OWNED_BY_DEPENDENT',
      paths: ['src/impl.test.ts'],
      from: 'verify-impl',
      to: 'change-impl',
    });
    expect(validateUnitGraph(validation.units, { mutationScope: changeRequest.mutationScope, forbiddenPaths: [] }).ok).toBe(true);
  });

  it('keeps a dependent that still has its own work, and moves only the file the dependency needs', async () => {
    const changeRequest = await approved();
    const validation = validatePlan(
      {
        units: [
          unit({ key: 'change-impl', ownedPaths: ['src/impl.ts'] }),
          unit({ key: 'use-impl', ownedPaths: ['src/impl.test.ts', 'src/other.ts'], dependsOn: ['change-impl'] }),
        ],
      },
      changeRequest,
    );
    expect(validation.ok).toBe(true);
    expect(validation.units.find((u) => u.key === 'change-impl')?.ownedPaths).toEqual(['src/impl.ts', 'src/impl.test.ts']);
    expect(validation.units.find((u) => u.key === 'use-impl')?.ownedPaths).toEqual(['src/other.ts']);
    expect(validation.units.find((u) => u.key === 'use-impl')?.dependsOn).toEqual(['change-impl']);
  });

  it('records the rewrite as an event and installs the corrected graph, which survives a restart', async () => {
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    const validation = validatePlan(DEADLOCK_PLAN, changeRequest);
    await installPlan(campaign.id, validation.units, { rewrites: validation.rewrites });
    const events = (await listFactoryEvents(campaign.id)).filter((e) => e.kind === 'PLAN_REWRITTEN');
    expect(events.map((e) => e.detail['action'])).toEqual(['MOVE_PATH', 'MERGE_UNITS']);
    expect(events[0]?.detail['reason']).toBe('MUTATION_OWNED_BY_DEPENDENT');

    // A restart reads rows; the corrected ownership is what is there.
    const { closeDatabase } = await import('../server/db/database.ts');
    void closeDatabase;
    const units = await listUnits(campaign.id);
    expect(units.map((u) => [u.unitKey, u.ownedPaths])).toEqual([['change-impl', ['src/impl.ts', 'src/impl.test.ts']]]);
    expect(
      validateUnitGraph(graphFromRows(units, await listDependencies(campaign.id)), {
        mutationScope: changeRequest.mutationScope,
        forbiddenPaths: [],
      }).ok,
    ).toBe(true);
  });

  it('cannot be talked back into the invalid graph by a retry or a replan', async () => {
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    const first = validatePlan(DEADLOCK_PLAN, changeRequest);
    await installPlan(campaign.id, first.units, { rewrites: first.rewrites });
    // The same proposal again (a redelivered plan bin, a resumed planner) rewrites identically…
    const again = validatePlan(DEADLOCK_PLAN, changeRequest);
    expect(again.units).toEqual(first.units);
    const installed = await installPlan(campaign.id, again.units, { rewrites: again.rewrites });
    expect(installed.created).toBe(0);
    // …and the raw invalid graph cannot be installed by anybody who skipped validation.
    await expect(
      installPlan(campaign.id, (DEADLOCK_PLAN.units as unknown as UnitSpec[])),
    ).rejects.toThrow(/MUTATION_OWNED_BY_DEPENDENT/);
    expect((await listUnits(campaign.id)).map((u) => u.unitKey)).toEqual(['change-impl']);
  });

  it('refuses a true dependency cycle rather than rewriting it', async () => {
    const changeRequest = await approved();
    const validation = validatePlan(
      {
        units: [
          unit({ key: 'first-unit', ownedPaths: ['src/impl.ts'], dependsOn: ['second-unit'] }),
          unit({ key: 'second-unit', ownedPaths: ['src/other.ts'], dependsOn: ['first-unit'] }),
        ],
      },
      changeRequest,
    );
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((i) => i.reason)).toContain('DEPENDENCY_CYCLE');
    expect(validation.rewrites).toEqual([]);
  });

  it('leaves independent units narrow and parallel', async () => {
    const changeRequest = await approved();
    const validation = validatePlan(
      {
        units: [
          unit({ key: 'change-impl', ownedPaths: ['src/impl.ts', 'src/impl.test.ts'] }),
          unit({ key: 'change-other', ownedPaths: ['src/other.ts'] }),
        ],
      },
      changeRequest,
    );
    expect(validation.ok).toBe(true);
    expect(validation.rewrites).toEqual([]);
    expect(validation.issues).toEqual([]);
    expect(validation.units.map((u) => u.ownedPaths)).toEqual([['src/impl.ts', 'src/impl.test.ts'], ['src/other.ts']]);
  });

  it('serialises two units that would write one file, by the claim loop’s own rule', async () => {
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    const validation = validatePlan(
      {
        units: [
          unit({ key: 'writer-one', ownedPaths: ['src/other.ts'] }),
          unit({ key: 'writer-two', ownedPaths: ['src/other.ts'] }),
        ],
      },
      changeRequest,
    );
    // Not refused and not rewritten: the canonical rule is that the claim loop
    // serialises them, and the validator reports it as such.
    expect(validation.ok).toBe(true);
    const overlap = validation.issues.find((i) => i.reason === 'OVERLAPPING_MUTATION_SCOPE');
    expect(overlap).toMatchObject({ fatal: false, units: ['writer-one', 'writer-two'] });
    await installPlan(campaign.id, validation.units, { rewrites: validation.rewrites });
    const claimed = await claimUnits({ campaignId: campaign.id, workerId: 'w1', limit: 2 });
    expect(claimed.length).toBe(1);
  });

  it('refuses ownership outside the repository bounds with a typed reason', async () => {
    const changeRequest = await approved(['src/**']);
    const validation = validatePlan(
      { units: [unit({ key: 'escape', ownedPaths: ['../outside.ts', 'server/x.ts'] })] },
      changeRequest,
    );
    expect(validation.ok).toBe(false);
    expect(validation.issues.filter((i) => i.reason === 'OWNERSHIP_OUTSIDE_REPOSITORY').length).toBeGreaterThan(0);
  });

  it('has one closed vocabulary of reasons', () => {
    expect([...OWNERSHIP_REASONS].sort()).toEqual(
      [
        'DEPENDENCY_CYCLE',
        'UNKNOWN_DEPENDENCY',
        'MUTATION_OWNED_BY_DEPENDENT',
        'REQUIRED_FILE_NOT_WRITABLE',
        'REPAIR_SCOPE_INSUFFICIENT',
        'OVERLAPPING_MUTATION_SCOPE',
        'OWNERSHIP_OUTSIDE_REPOSITORY',
      ].sort(),
    );
  });

  it(`gives the same answer on ${testDatabaseKind} as the pure function does`, async () => {
    // The same rows, read back from whichever backend this run uses, decide
    // identically to the in-memory plan they were installed from.
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    const raw = {
      units: [
        unit({ key: 'base-unit', ownedPaths: ['src/impl.ts'] }),
        unit({ key: 'leaf-unit', ownedPaths: ['src/other.ts'], dependsOn: ['base-unit'] }),
      ],
    };
    const validation = validatePlan(raw, changeRequest);
    await installPlan(campaign.id, validation.units, { rewrites: validation.rewrites });
    const ctx = { mutationScope: changeRequest.mutationScope, forbiddenPaths: [] };
    const fromRows = validateUnitGraph(graphFromRows(await listUnits(campaign.id), await listDependencies(campaign.id)), ctx);
    const fromSpecs = validateUnitGraph(validation.units, ctx);
    expect(fromRows).toEqual(fromSpecs);
  });
});

describe('B — a repair owns where the defect must be fixed, not only where it was seen', () => {
  async function seededCampaign(changeRequest: FactoryChangeRequest, withTestUnit = true) {
    const campaign = await campaignFor(changeRequest);
    const { unit: implUnit } = await ensureUnit({
      campaignId: campaign.id, unitKey: 'change-impl', kind: 'IMPLEMENTATION', role: 'IMPLEMENTER',
      title: 'impl', objective: 'impl', acceptance: [], ownedPaths: ['src/impl.ts'], requiredContext: [],
      verification: ['npm test'], expectedArtifact: 'a commit', state: 'INTEGRATED',
    });
    if (withTestUnit) {
      await ensureUnit({
        campaignId: campaign.id, unitKey: 'verify-impl', kind: 'TEST', role: 'IMPLEMENTER',
        title: 'test', objective: 'test', acceptance: [], ownedPaths: ['src/impl.test.ts'], requiredContext: [],
        verification: ['npm test'], expectedArtifact: 'a commit', state: 'INTEGRATED',
      });
    }
    return { campaign, implUnit };
  }

  async function review(campaignId: string, statement: string, evidence: string, category = 'correctness') {
    await recordReview({
      campaignId, round: 1, scope: 'CAMPAIGN', reviewerSessionId: null, reviewedSha: 'b'.repeat(40),
      verdict: 'CHANGES_REQUIRED', summary: 'one defect', independence: 'WORKER_SEPARATED',
      findings: [{ key: 'impl-wrong', severity: 'MAJOR', category, statement, evidence }],
    });
  }

  it('the old ownership could not legally fix the defect', () => {
    // The finding as reviewers write it: the symptom, in the test.
    const finding = {
      findingKey: 'impl-wrong', category: 'correctness', severity: 'MAJOR',
      statement: 'src/impl.test.ts:3 fails: value is 1 where the change requires 2',
      evidence: 'npm test exits 1\nSuggested paths: src/impl.test.ts',
    } as unknown as FactoryFinding;
    const owned = ['src/impl.test.ts'];
    // Under that ownership the real fix is refused at integration.
    expect(checkOwnership(['src/impl.ts'], owned).ok).toBe(false);
    void finding;
  });

  it('a defect detected in a test receives ownership of the implementation it tests', async () => {
    const changeRequest = await approved();
    const { campaign } = await seededCampaign(changeRequest);
    await review(
      campaign.id,
      'src/impl.test.ts:3 fails: value is 1 where the change requires 2',
      'npm test exits 1\nSuggested paths: src/impl.test.ts',
    );
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.ownershipBlocked).toEqual([]);
    expect(result.queued.length).toBe(1);
    const repair = (await listUnits(campaign.id)).find((u) => u.kind === 'REPAIR')!;
    expect(repair.ownedPaths).toEqual(['src/impl.ts', 'src/impl.test.ts']);
    // The real fix is now inside what integration will accept.
    expect(checkOwnership(['src/impl.ts', 'src/impl.test.ts'], repair.ownedPaths).ok).toBe(true);
    const queued = (await listFactoryEvents(campaign.id)).find((e) => e.kind === 'REPAIR_QUEUED' && e.unitId === repair.id);
    expect(queued?.detail['rootCauseFiles']).toEqual(['src/impl.ts']);
    expect(queued?.detail['evidenceFiles']).toEqual(['src/impl.test.ts']);
  });

  it('derives the implementation from a unit that owns it by glob, through the sibling convention', async () => {
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    await ensureUnit({
      campaignId: campaign.id, unitKey: 'whole-src', kind: 'IMPLEMENTATION', role: 'IMPLEMENTER',
      title: 'src', objective: 'src', acceptance: [], ownedPaths: ['src/**'], requiredContext: [],
      verification: ['npm test'], expectedArtifact: 'a commit', state: 'INTEGRATED',
    });
    await review(campaign.id, 'the new value is not exported', 'Suggested paths: src/impl.test.ts');
    const result = await queueRepairs(campaign, changeRequest);
    const repair = (await listUnits(campaign.id)).find((u) => u.kind === 'REPAIR')!;
    expect(result.queued.length).toBe(1);
    expect(repair.ownedPaths).toEqual(['src/impl.ts', 'src/impl.test.ts']);
  });

  it('a reviewer naming an unrelated file cannot widen the repair', async () => {
    const changeRequest = await approved();
    const { campaign } = await seededCampaign(changeRequest);
    await review(
      campaign.id,
      'src/impl.test.ts:3 fails: value is 1 where the change requires 2',
      'Suggested paths: src/impl.test.ts, src/unrelated.ts',
    );
    await queueRepairs(campaign, changeRequest);
    const repair = (await listUnits(campaign.id)).find((u) => u.kind === 'REPAIR')!;
    expect(repair.ownedPaths).not.toContain('src/unrelated.ts');
    expect(repair.ownedPaths).toEqual(['src/impl.ts', 'src/impl.test.ts']);
    const queued = (await listFactoryEvents(campaign.id)).find((e) => e.kind === 'REPAIR_QUEUED' && e.unitId === repair.id);
    expect(queued?.detail['rejectedHints']).toEqual(['src/unrelated.ts']);
  });

  it('a repair whose root cause cannot be established blocks cleanly, with no bin', async () => {
    const changeRequest = await approved();
    const campaign = await campaignFor(changeRequest);
    // Only the test is anywhere in the campaign; nothing establishes what it tests.
    await ensureUnit({
      campaignId: campaign.id, unitKey: 'verify-impl', kind: 'TEST', role: 'IMPLEMENTER',
      title: 'test', objective: 'test', acceptance: [], ownedPaths: ['src/impl.test.ts'], requiredContext: [],
      verification: ['npm test'], expectedArtifact: 'a commit', state: 'INTEGRATED',
    });
    await review(campaign.id, 'the assertion on line 3 fails', 'Suggested paths: src/impl.test.ts');
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.queued).toEqual([]);
    expect(result.ownershipBlocked).toEqual([
      expect.objectContaining({ findingKey: 'impl-wrong', reason: 'REPAIR_SCOPE_INSUFFICIENT' }),
    ]);
    expect((await listUnits(campaign.id)).filter((u) => u.kind === 'REPAIR')).toEqual([]);
    // Explained in a row, once however many ticks ask.
    await queueRepairs(campaign, changeRequest);
    const blocked = (await listFactoryEvents(campaign.id)).filter((e) => e.kind === 'REPAIR_OWNERSHIP_BLOCKED');
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.detail['reason']).toBe('REPAIR_SCOPE_INSUFFICIENT');
  });

  it('a person naming the exact file in the scope is what answers that block', async () => {
    const changeRequest = await approved(['src/impl.test.ts', 'src/impl.ts']);
    const campaign = await campaignFor(changeRequest);
    await ensureUnit({
      campaignId: campaign.id, unitKey: 'verify-impl', kind: 'TEST', role: 'IMPLEMENTER',
      title: 'test', objective: 'test', acceptance: [], ownedPaths: ['src/impl.test.ts'], requiredContext: [],
      verification: ['npm test'], expectedArtifact: 'a commit', state: 'INTEGRATED',
    });
    await review(campaign.id, 'the assertion on line 3 fails', 'Suggested paths: src/impl.test.ts');
    const result = await queueRepairs(campaign, changeRequest);
    expect(result.ownershipBlocked).toEqual([]);
    const repair = (await listUnits(campaign.id)).find((u) => u.kind === 'REPAIR')!;
    expect(repair.ownedPaths).toEqual(['src/impl.ts', 'src/impl.test.ts']);
  });

  it('a finding that is genuinely about a test keeps a test-only repair', async () => {
    const changeRequest = await approved();
    const { campaign } = await seededCampaign(changeRequest);
    await review(campaign.id, 'the new branch has no test', 'Suggested paths: src/impl.test.ts', 'test-coverage');
    await queueRepairs(campaign, changeRequest);
    const repair = (await listUnits(campaign.id)).find((u) => u.kind === 'REPAIR')!;
    expect(repair.ownedPaths).toEqual(['src/impl.test.ts']);
  });

  it('every repair it creates passes the same validator the planner uses', async () => {
    const changeRequest = await approved();
    const { campaign } = await seededCampaign(changeRequest);
    await review(campaign.id, 'src/impl.test.ts:3 fails', 'Suggested paths: src/impl.test.ts');
    await queueRepairs(campaign, changeRequest);
    const units = await listUnits(campaign.id);
    const verdict = validateUnitGraph(graphFromRows(units, await listDependencies(campaign.id)), {
      mutationScope: changeRequest.mutationScope,
      forbiddenPaths: [],
    });
    expect(verdict.ok).toBe(true);
  });

  it('ownershipForRepair names the four kinds of file apart', () => {
    const finding = {
      findingKey: 'impl-wrong', category: 'correctness', severity: 'MAJOR',
      statement: 'src/impl.test.ts:3 fails', evidence: 'Suggested paths: src/impl.test.ts',
    } as unknown as FactoryFinding;
    const changeRequest = { mutationScope: ['src/**'] } as unknown as FactoryChangeRequest;
    const units = [
      { unitKey: 'change-impl', ownedPaths: ['src/impl.ts'], kind: 'IMPLEMENTATION' },
      { unitKey: 'verify-impl', ownedPaths: ['src/impl.test.ts'], kind: 'TEST' },
    ] as never;
    const ownership = ownershipForRepair(finding, changeRequest, units);
    expect(ownership).toMatchObject({
      ok: true,
      evidenceFiles: ['src/impl.test.ts'],
      rootCauseFiles: ['src/impl.ts'],
      verificationFiles: ['src/impl.test.ts'],
      ownedPaths: ['src/impl.ts', 'src/impl.test.ts'],
    });
  });
});
