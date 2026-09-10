/**
 * Pinning the wiring this unit is responsible for: `loop.ts` reaches into
 * `recovery.ts` and `writeback.ts`, and `routes/factory.ts` reaches into
 * `projections.ts`, `throughput.ts` and `pullRequest.ts` — rather than either
 * file quietly staying self-contained while the modules they were supposed to
 * call sit unreferenced.
 *
 * Two kinds of proof, because either alone would miss the actual defect this
 * unit exists to prevent: a source-text check that the imports exist at all
 * (a module nothing calls is not a mechanism), and a real run through the
 * loop proving `recordCampaignOutcome` actually fires exactly once when a
 * campaign reaches COMPLETE (an import with nothing wired behind it is not a
 * mechanism either).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  patchCampaign,
  getCampaign,
} from '../server/repos/factory.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import { tickCampaign } from '../server/services/factory/loop.ts';
import { gitOrThrow, run } from '../server/services/factory/git.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the two files this unit wires', () => {
  it('loop.ts imports recovery.ts and writeback.ts', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'services', 'factory', 'loop.ts'),
      'utf8',
    );
    expect(source).toMatch(/from ['"]\.\/recovery\.ts['"]/);
    expect(source).toMatch(/from ['"]\.\/writeback\.ts['"]/);
  });

  it('routes/factory.ts imports projections.ts, throughput.ts and pullRequest.ts', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'routes', 'factory.ts'),
      'utf8',
    );
    expect(source).toMatch(/from ['"]\.\.\/services\/factory\/projections\.ts['"]/);
    expect(source).toMatch(/from ['"]\.\.\/services\/factory\/throughput\.ts['"]/);
    expect(source).toMatch(/from ['"]\.\.\/services\/factory\/pullRequest\.ts['"]/);
  });
});

let fixture: TestProject;
let repoRoot: string;

/** A small real repository, exactly as `tests/factory.test.ts` builds one. */
async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wiring-repo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { typecheck: 'node -e "0"', test: 'node -e "0"' } }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'src.txt'), 'one\n');
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Factory Wiring Test'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

beforeEach(async () => {
  fixture = await freshProject();
  repoRoot = await makeRepository();
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('driving a campaign to COMPLETE through the loop', () => {
  it('writes back exactly one FACTORY_CAMPAIGN project event', async () => {
    const headSha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);

    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'wiring-complete',
      objective: 'Prove the loop writes a campaign outcome back into Brain once.',
      expectedOutcome: 'Exactly one FACTORY_CAMPAIGN project event exists.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'one event exists', verification: 'count the rows', mandatory: true },
      ],
      repository: repoRoot,
      baseBranch: 'main',
      baseSha: headSha,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['src.txt'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'discard the branch',
      verificationCommands: [],
    });
    expect(
      await approveChangeRequest({
        changeRequestId: changeRequest.id,
        via: 'PERSON',
        userId: null,
        authorityId: null,
      }),
    ).toBe(true);

    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: headSha,
      integrationBranch: 'factory/campaign/wiring-complete',
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    // No units, no sessions: this unit is only responsible for wiring the loop
    // to the writeback and recovery modules, not for re-proving the pipeline
    // that produces a campaign's units — that is exercised elsewhere. Starting
    // the campaign at ASSEMBLING still drives it through the loop's own
    // COMPLETE transition, which is the mechanism this test pins.
    await patchCampaign(campaign.id, { state: 'ASSEMBLING', stageDetail: 'assembling for the test' });

    const report = await tickCampaign(campaign.id, { repoRoot });

    expect(report.tickHeld).toBe(false);
    expect(report.state).toBe('COMPLETE');

    const finished = await getCampaign(campaign.id);
    expect(finished?.state).toBe('COMPLETE');
    expect(finished?.finishedAt).not.toBeNull();

    const events = await listEventsByEntity('FACTORY_CAMPAIGN', campaign.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('FACTORY_CAMPAIGN_COMPLETED');
    expect(events[0]?.projectId).toBe(fixture.project.id);
  });
});
