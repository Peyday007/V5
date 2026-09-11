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
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  approveChangeRequest,
  claimUnits,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  factoryNow,
  patchCampaign,
  plusMs,
  getCampaign,
} from '../server/repos/factory.ts';
import { getSession, openSession } from '../server/repos/factoryFleet.ts';
import { getDb } from '../server/db/database.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import { tickCampaign } from '../server/services/factory/loop.ts';
import { gitOrThrow, run } from '../server/services/factory/git.ts';
import { factoryRouter } from '../server/routes/factory.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal } from '../server/domain/types.ts';

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

/**
 * The grep this file's first `describe` block runs pins the import; it cannot
 * tell a real call apart from an import with nothing wired behind it. This
 * block drives `tickCampaign` through a real dead-process scenario — a session
 * still `RUNNING` for a unit whose lease has expired — and checks the effect
 * only `recoverCampaign` produces: the session closed, and a `recovery:` note
 * on the report. Delete the call at `loop.ts:225` while leaving the import in
 * place and this session stays `RUNNING` forever; nothing else in the tick
 * touches it.
 */
describe('the tick actually runs recovery, not merely imports the module', () => {
  it('closes a dead session and reclaims its lease as part of one real tick', async () => {
    const headSha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);

    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'wiring-recovery',
      objective: 'Prove the tick actually calls recoverCampaign, not merely imports it.',
      expectedOutcome: 'A dead session is closed and its lease reclaimed inside one real tick.',
      nonGoals: [],
      acceptanceConditions: [
        {
          id: 'A01',
          statement: 'recovery runs inside the tick',
          verification: 'read the tick report and the session row',
          mandatory: true,
        },
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
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'alpha',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'alpha',
      objective: 'alpha',
      acceptance: ['it works'],
      ownedPaths: ['src.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });

    const session = await openSession({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'test-model',
    });
    const claimed = await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [unit.id],
      sessionId: session.id,
      leaseMs: 30_000,
    });
    expect(claimed.length).toBe(1);

    // The process that was driving this campaign died: the lease it holds has
    // expired and nothing renewed it. A dispatcher's next tick is the only
    // thing that will ever notice.
    await getDb().run(`UPDATE factory_work_units SET lease_expires_at = ? WHERE id = ?`, [
      plusMs(factoryNow(), -60_000),
      unit.id,
    ]);
    await patchCampaign(campaign.id, { state: 'EXECUTING', stageDetail: 'executing for the test' });

    const report = await tickCampaign(campaign.id, { repoRoot });

    expect(
      report.notes.some((note) =>
        note.startsWith('recovery: 1 session(s) closed, 1 lease(s) reclaimed'),
      ),
    ).toBe(true);
    expect((await getSession(session.id))?.state).toBe('ABANDONED');
  });
});

/**
 * The same grep problem, one file over: `routes/factory.ts:44-52` pins the
 * import of `projections.ts`, `throughput.ts` and `pullRequest.ts`, and
 * nothing else in the suite requests `/briefing`, `/throughput` or
 * `/pull-request`. This mounts `factoryRouter` the way `russellAuthoritySurface.test.ts`
 * mounts `russellRouter` — a real Express app, a real listening socket, a real
 * fetch — and asserts on text each route's handler could only produce by
 * actually calling its service, not by importing it.
 */
describe('the briefing, throughput and pull-request routes actually answer, not merely import their modules', () => {
  function adminPrincipal(): Principal {
    return {
      type: 'HUMAN',
      id: 'wiring-test-admin',
      handle: 'admin@example.test',
      displayName: 'Wiring test admin',
      isBrainAdmin: true,
      mustChangePassword: false,
      credentialId: 'ses_wiring_test',
      authMethod: 'SESSION_COOKIE',
      memberships: [],
      requestId: 'req',
    } as Principal;
  }

  async function withFactoryRoutes<T>(
    fn: (call: (path: string) => Promise<{ status: number; body: any }>) => Promise<T>,
  ): Promise<T> {
    const app = express();
    app.use((req, _res, next) => {
      attachContext(req, {
        principal: adminPrincipal(),
        requestId: newRequestId(),
        method: req.method,
        path: `/api${req.path}`,
        remoteAddr: null,
        userAgent: null,
      });
      next();
    });
    app.use('/api', factoryRouter);
    app.use((error: any, _req: any, res: any, _next: any) => {
      res.status(typeof error?.status === 'number' ? error.status : 500).json({
        error: String(error?.message ?? error),
      });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      return await fn(async (path) => {
        const response = await fetch(`http://127.0.0.1:${port}/api${path}`);
        const text = await response.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* left as text */
        }
        return { status: response.status, body: body as any };
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('answer with the shape only their own service produces', async () => {
    const headSha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'wiring-http',
      objective: 'Prove the briefing, throughput and pull-request routes are wired.',
      expectedOutcome: 'Each route answers with the shape only its own service can produce.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'the routes answer', verification: 'call them over HTTP', mandatory: true },
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
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    await withFactoryRoutes(async (call) => {
      const briefing = await call(`/factory/campaigns/${campaign.id}/briefing`);
      expect(briefing.status).toBe(200);
      // This exact sentence is composed nowhere but `campaignBriefing`; a route
      // that only imported the module would 500 or answer something else.
      expect(briefing.body.stage).toBe(
        'The campaign is planning: turning the objective into a graph of units.',
      );
      expect(briefing.body.objective).toBe(changeRequest.objective);

      const throughput = await call(`/factory/campaigns/${campaign.id}/throughput`);
      expect(throughput.status).toBe(200);
      // Only `throughputReport` reads `factory_campaigns.lane_target` into this
      // field, always labelled UNKNOWN because a declared number is never
      // evidence of what actually ran.
      expect(throughput.body.concurrency.declared).toEqual({
        value: 1,
        evidence: 'UNKNOWN',
        basis: expect.stringContaining('factory_campaigns.lane_target'),
      });

      const pullRequest = await call(`/factory/campaigns/${campaign.id}/pull-request`);
      expect(pullRequest.status).toBe(200);
      // Only `renderPullRequest` produces this title and these section headings.
      expect(pullRequest.body.title).toBe(changeRequest.objective);
      expect(pullRequest.body.body).toContain('### Acceptance conditions');
      expect(pullRequest.body.body).toContain('No unit has reached the integration branch yet.');
    });
  });
});
