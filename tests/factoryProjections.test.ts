/**
 * campaignBriefing invents no progress number: it reports literal unit counts
 * or a non-numeric label, and its stage sentence comes from an exhaustive
 * mapping over the domain enum rather than a string a model wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { claimUnits, ensureCampaign, ensureUnit } from '../server/repos/factory.ts';
import { createUser } from '../server/repos/identity.ts';
import { approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import { run } from '../server/services/factory/git.ts';
import { campaignBriefing } from '../server/services/factory/projections.ts';

let fixture: TestProject;
let repoRoot: string;
let approverId: string;

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-proj-repo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { typecheck: 'node -e "0"', test: 'node -e "0"' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'one.txt'), 'one\n');
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
      email: 'factory-projections@test.local',
      displayName: 'Factory Projections',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

/** Every key name in the object, walked recursively — what the forbidden-word check applies to. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
    return out;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out.push(key);
    collectKeys(entry, out);
  }
  return out;
}

describe('campaign briefing', () => {
  it('returns null for a campaign that does not resolve', async () => {
    expect(await campaignBriefing('no-such-campaign')).toBeNull();
  });

  it('reports the objective, the stage, only the leased unit as active work, and literal milestone counts', async () => {
    const submitted = await submitObjective({
      projectId: fixture.project.id,
      objective: 'Change the first file so the outcome is visible to a reader.',
      expectedOutcome: 'src/one.txt contains the new text.',
      acceptanceConditions: [
        { statement: 'src/one.txt contains the new text', verification: 'read the file' },
      ],
      repositoryRoot: repoRoot,
    });
    const approved = await approveObjective({
      changeRequestId: submitted.changeRequest.id,
      via: 'PERSON',
      userId: approverId,
    });
    expect(approved.ok).toBe(true);
    const changeRequest = approved.changeRequest;

    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      integrationBranch: 'factory/campaign/projections',
      laneTarget: 3,
      laneTargetReason: 'initial',
    });

    const { unit: leasedUnit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'leased-one',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'the unit actually running',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/one.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    // A LEASED row carries lease columns a CHECK constraint requires, so the
    // fixture claims the unit for real rather than writing the state by hand.
    const claimed = await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [leasedUnit.id],
    });
    expect(claimed).toHaveLength(1);
    await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'integrated-one',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'the unit already merged',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/two.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'INTEGRATED',
    });
    await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'ready-one',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'the unit waiting to start',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/three.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });

    const briefing = await campaignBriefing(campaign.id);
    expect(briefing).not.toBeNull();
    if (!briefing) return;

    expect(briefing.objective).toBe(changeRequest.objective);
    expect(briefing.stage).toBe(
      'The campaign is planning: turning the objective into a graph of units.',
    );
    expect(briefing.activeWork.units).toHaveLength(1);
    expect(briefing.activeWork.units[0]?.unitKey).toBe('leased-one');
    expect(briefing.activeWork.readyCount).toBe(1);
    expect(briefing.activeWork.blockedCount).toBe(0);
    expect(briefing.progress).toEqual({ kind: 'MILESTONE', integratedUnits: 1, totalUnits: 3 });

    const forbidden = /percent|ratio|fraction|estimate|confidence/i;
    for (const key of collectKeys(briefing)) {
      expect(forbidden.test(key)).toBe(false);
    }
  });
});
