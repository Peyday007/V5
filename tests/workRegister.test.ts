/**
 * The work register: what it stores, what it refuses to store, and what it
 * derives.
 *
 * Four properties carry the whole design and each has a test that fails if it
 * is undone:
 *
 *   1. **No state is stored.** The schema has no column for it, and the state
 *      moves when the rows it points at move — with nothing rewritten.
 *   2. **A source never contributes a state.** A conversation describing
 *      shipped work is not the work shipping, and the only thing stopping the
 *      register saying otherwise is that `SOURCE` links are excluded before the
 *      derivation.
 *   3. **An unattested pull request is not a merge.** Brain holds no forge
 *      credential, so a URL on its own moves nothing. Two tests, because the
 *      interesting half is the refusal.
 *   4. **Many-to-many both ways.** One conversation feeds several workstreams
 *      and several conversations feed one.
 *
 * Plus the one a register is for: the six answers come out of real rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  archiveWorkstream,
  createWorkstream,
  linkWorkstream,
  listLinks,
  listWorkstreams,
  supersedeLink,
  workstreamsForRef,
} from '../server/repos/register.ts';
import { assembleRegister, viewOf } from '../server/services/register/view.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { captureSoftwareRequest } from '../server/repos/russellSoftware.ts';
import { submitObjective, approveObjective } from '../server/services/factory/contract.ts';
import { ensureCampaign, ensureUnit, factoryNow, patchCampaign } from '../server/repos/factory.ts';
import { recordIntegration, recordReview } from '../server/repos/factoryFleet.ts';
import { observeCampaignPullRequestMerge } from '../server/services/register/pullRequestMergeObservation.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

let projectId = '';
let userId = '';
let repoRoot = '';

/**
 * A throwaway git repository for the contract to pin against.
 *
 * The contract derives its base commit and verification commands from a real
 * checkout, so a fixture that faked one would be testing the fixture. This is
 * the same shape `tests/factory.test.ts` already uses.
 */
async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'register-repo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { test: 'node -e "0"' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'one.txt'), 'one\n');
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'register@test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Register Test'], { cwd: root });
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `register-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  repoRoot = await makeRepository();
});

afterEach(() => {
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
});

async function stream(purpose: 'REVENUE_DIRECT' | 'CAPABILITY' = 'CAPABILITY') {
  return await createWorkstream({
    projectId,
    title: 'A piece of work',
    intent: 'The outcome somebody actually asked for.',
    purpose,
    createdByUserId: userId,
  });
}

describe('the register stores an intent and derives everything else', () => {
  it('has no state column at all, in either direction', async () => {
    /*
     * Asserted against the database rather than against the TypeScript, because
     * the thing that must not exist is a *place to put* a stored verdict. A
     * type can be changed back in one line; a column somebody has to add is a
     * migration somebody reads.
     */
    const row = await getDb().get<Record<string, unknown>>(
      `SELECT * FROM workstreams WHERE id = ?`,
      [(await stream()).id],
    );
    expect(row).toBeDefined();
    for (const column of Object.keys(row ?? {})) {
      expect(column, `workstreams.${column}`).not.toMatch(/^state/);
    }
  });

  it('reads UNKNOWN when nothing linked to it says where it has got to', async () => {
    const one = await stream();
    const view = await viewOf(one, []);
    expect(view.state).toBe('UNKNOWN');
    // And it says so rather than inventing an instruction.
    expect(view.nextAction).toBeNull();
    expect(view.stateEvidence).toContain('nothing linked');
  });

  it('moves when the row it points at moves, with nothing rewritten', async () => {
    const one = await stream();
    const request = await submitObjective({
      projectId,
      objective: 'Make the thing work.',
      expectedOutcome: 'The thing works.',
      acceptanceConditions: [{ statement: 'It works.', verification: 'npm test' }],
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      submissionKey: `reg-${Math.random().toString(36).slice(2, 10)}`,
    });
    const changeRequestId = request.changeRequest.id;

    await linkWorkstream({
      workstreamId: one.id,
      kind: 'CHANGE_REQUEST',
      ref: changeRequestId,
      relation: 'PURSUES',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });

    const before = await viewOf(one, await listLinks(one.id));
    expect(before.state).toBe('PROPOSED');
    expect(before.ownerAction).toContain('Approve the change request');

    const approved = await approveObjective({
      changeRequestId,
      via: 'PERSON',
      userId,
    });
    expect(approved.ok).toBe(true);

    // Same link row, same workstream row, different answer.
    const after = await viewOf(one, await listLinks(one.id));
    expect(after.state).toBe('IN_PROGRESS');
    expect(after.stateEvidence).toContain('APPROVED');
    expect(after.ownerAction).toBeNull();
  });
});

describe('what a link may and may not say about progress', () => {
  it('never lets a source conversation contribute a state', async () => {
    const one = await stream();
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'We shipped the thing last week',
    });
    await linkWorkstream({
      workstreamId: one.id,
      kind: 'CONVERSATION',
      ref: conversation.id,
      relation: 'SOURCE',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });

    const view = await viewOf(one, await listLinks(one.id));
    // The conversation is read, named and shown as a source — and says nothing
    // about whether any of it happened.
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]?.status).toContain('shipped the thing');
    expect(view.state).toBe('UNKNOWN');
  });

  it('refuses to read a pull request URL as a merge', async () => {
    const one = await stream();
    await linkWorkstream({
      workstreamId: one.id,
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/V5/pull/999',
      relation: 'EVIDENCE',
      detail: { merged: true, state: 'merged' },
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });

    const view = await viewOf(one, await listLinks(one.id));
    /*
     * `merged: true` is right there in the detail and it moves nothing,
     * because nobody attested to it. Brain holds no forge credential, so the
     * alternative would be believing a claim it cannot check — which is the
     * invented citation this codebase exists to refuse.
     */
    expect(view.state).toBe('UNKNOWN');
    expect(view.readings[0]?.status).toContain('nobody attesting');
  });

  it('reads a declared branch as work in progress, and never as more than that', async () => {
    /*
     * A branch is a person saying where their own work is happening, which is a
     * different kind of statement from "it merged": one is somebody telling
     * Brain what they are doing, the other is a claim about a system Brain
     * cannot see. So it contributes IN_PROGRESS and the ladder stops there —
     * otherwise somebody wanting the register to say MERGED could get there by
     * renaming a branch rather than by producing an attestation.
     */
    const one = await stream();
    await linkWorkstream({
      workstreamId: one.id,
      kind: 'BRANCH',
      ref: 'claude/some-work',
      relation: 'PURSUES',
      // Whatever a caller puts in the detail, this is not a merge.
      detail: { merged: true, state: 'merged', attestedBy: 'nobody', attestedAt: 'never' },
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });
    const view = await viewOf(one, await listLinks(one.id));
    expect(view.state).toBe('IN_PROGRESS');
    expect(view.readings[0]?.evidence).toContain('never read from the repository');
  });

  it('reads it once somebody has attested to it, and says who and when', async () => {
    const one = await stream();
    await linkWorkstream({
      workstreamId: one.id,
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/V5/pull/999',
      relation: 'EVIDENCE',
      detail: {
        merged: true,
        attestedBy: 'person:the-owner',
        attestedAt: '2026-09-20T12:00:00.000Z',
      },
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });
    const view = await viewOf(one, await listLinks(one.id));
    expect(view.state).toBe('MERGED');
    expect(view.readings[0]?.attested).toEqual({
      by: 'person:the-owner',
      at: '2026-09-20T12:00:00.000Z',
    });
    expect(view.nextAction).toContain('Deploy the canonical branch');
  });
});

describe('one conversation, several workstreams, and back', () => {
  it('links both ways and resolves both ways', async () => {
    const a = await stream();
    const b = await stream('REVENUE_DIRECT');
    const conversation = await createConversation({ ownerUserId: userId, title: 'One thread' });

    for (const one of [a, b]) {
      await linkWorkstream({
        workstreamId: one.id,
        kind: 'CONVERSATION',
        ref: conversation.id,
        relation: 'SOURCE',
        recordedBy: 'PERSON',
        recordedByUserId: userId,
      });
    }

    expect((await workstreamsForRef('CONVERSATION', conversation.id)).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    const second = await createConversation({ ownerUserId: userId, title: 'Another thread' });
    await linkWorkstream({
      workstreamId: a.id,
      kind: 'CONVERSATION',
      ref: second.id,
      relation: 'SOURCE',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });
    expect((await viewOf(a, await listLinks(a.id))).sources).toHaveLength(2);
  });

  it('is idempotent: linking the same thing twice makes one live link', async () => {
    const one = await stream();
    const conversation = await createConversation({ ownerUserId: userId, title: 'Thread' });
    const first = await linkWorkstream({
      workstreamId: one.id,
      kind: 'CONVERSATION',
      ref: conversation.id,
      relation: 'SOURCE',
      recordedBy: 'BRAIN',
    });
    const again = await linkWorkstream({
      workstreamId: one.id,
      kind: 'CONVERSATION',
      ref: conversation.id,
      relation: 'SOURCE',
      recordedBy: 'BRAIN',
    });
    expect(again.id).toBe(first.id);
    expect(await listLinks(one.id)).toHaveLength(1);
  });

  it('keeps a superseded link, and lets the same ref be linked again afterwards', async () => {
    const one = await stream();
    const link = await linkWorkstream({
      workstreamId: one.id,
      kind: 'BRANCH',
      ref: 'claude/wrong-branch',
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });
    expect(await supersedeLink(link.id, 'It was the wrong branch.')).toBe(true);
    // A second correction of one link is an ordinary refusal, not a second
    // correction — the guard is in the statement that makes the change.
    expect(await supersedeLink(link.id, 'again')).toBe(false);

    expect(await listLinks(one.id)).toHaveLength(0);
    const history = await listLinks(one.id, { includeSuperseded: true });
    expect(history).toHaveLength(1);
    expect(history[0]?.supersededReason).toBe('It was the wrong branch.');

    // The partial index is what makes re-linking possible after a correction.
    const again = await linkWorkstream({
      workstreamId: one.id,
      kind: 'BRANCH',
      ref: 'claude/wrong-branch',
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });
    expect(again.id).not.toBe(link.id);
  });
});

describe('the six answers', () => {
  it('answers them from rows, and reports what it could not tell', async () => {
    const money = await createWorkstream({
      projectId,
      title: 'Sell the thing',
      intent: 'Money arrives.',
      purpose: 'REVENUE_DIRECT',
      createdByUserId: userId,
    });
    const capability = await stream();

    const request = await submitObjective({
      projectId,
      objective: 'Build the thing.',
      expectedOutcome: 'It exists.',
      acceptanceConditions: [{ statement: 'It exists.', verification: 'npm test' }],
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      submissionKey: `reg-${Math.random().toString(36).slice(2, 10)}`,
    });
    await linkWorkstream({
      workstreamId: money.id,
      kind: 'CHANGE_REQUEST',
      ref: request.changeRequest.id,
      relation: 'PURSUES',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });

    const view = await assembleRegister({ projectIds: [projectId] });
    expect(view.answers.pursuingMoney).toContain(money.id);
    expect(view.answers.pursuingMoney).not.toContain(capability.id);
    expect(view.answers.needsYou).toContain(money.id);
    expect(view.answers.beingBuilt).toContain(money.id);
    // The one with nothing linked is counted as unknown rather than presented
    // as "nothing is happening".
    expect(view.unknown).toBe(1);
  });

  it('shows nothing to a caller who may read nothing', async () => {
    await stream();
    expect((await assembleRegister({ projectIds: [] })).workstreams).toHaveLength(0);
  });

  it('keeps a Brain-wide workstream readable by anybody who may read at all', async () => {
    const platform = await createWorkstream({
      projectId: null,
      title: 'The factory itself',
      intent: 'Brain can change its own code through a reviewed pull request.',
      purpose: 'CAPABILITY',
      createdByUserId: userId,
    });
    const view = await assembleRegister({ projectIds: [projectId] });
    expect(view.workstreams.map((one) => one.id)).toContain(platform.id);
  });

  it('archiving destroys nothing and takes it off the list', async () => {
    const one = await stream();
    await linkWorkstream({
      workstreamId: one.id,
      kind: 'BRANCH',
      ref: 'claude/some-branch',
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });
    await archiveWorkstream(one.id, 'Superseded by a different approach.');

    expect((await listWorkstreams()).map((x) => x.id)).not.toContain(one.id);
    const withArchived = await listWorkstreams({ includeArchived: true });
    expect(withArchived.map((x) => x.id)).toContain(one.id);
    // The links are still there, so the sources still resolve.
    expect(await listLinks(one.id)).toHaveLength(1);
  });
});

describe('what the register says it is holding that nobody filed', () => {
  it('names an unfiled change request, and stops once it is filed', async () => {
    const request = await submitObjective({
      projectId,
      objective: 'Something nobody filed.',
      expectedOutcome: 'It is done.',
      acceptanceConditions: [{ statement: 'The change is present.', verification: 'npm test' }],
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      submissionKey: `reg-${Math.random().toString(36).slice(2, 10)}`,
    });
    const id = request.changeRequest.id;

    const before = await assembleRegister({ projectIds: [projectId] });
    expect(before.unfiled.map((one) => one.ref)).toContain(id);
    // It offers the row and composes no intent for it: the title is the
    // objective somebody actually wrote.
    expect(before.unfiled.find((one) => one.ref === id)?.title).toBe('Something nobody filed.');

    const one = await stream();
    await linkWorkstream({
      workstreamId: one.id,
      kind: 'CHANGE_REQUEST',
      ref: id,
      relation: 'PURSUES',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });

    const after = await assembleRegister({ projectIds: [projectId] });
    expect(after.unfiled.map((x) => x.ref)).not.toContain(id);
  });

  it('does not offer a software request that has no change request yet', async () => {
    /*
     * Offering it under its own `rsr_` id as a CHANGE_REQUEST link was the
     * first version, and it would have produced a link `readChangeRequest`
     * reports as missing for ever — a register telling somebody their work had
     * vanished, on a row that is perfectly healthy. §27's cries-wolf rule at a
     * new reader: a warning that is wrong teaches a person to stop believing
     * the one place that says something is genuinely gone.
     */
    const conversation = await createConversation({ ownerUserId: userId, title: 'Asking for a change' });
    const captured = await captureSoftwareRequest({
      projectId,
      conversationId: conversation.id,
      messageId: null,
      title: 'Fix the export',
      objective: 'The export stops dropping the last row.',
      expectedOutcome: 'A run of the export contains every row.',
      submissionKey: `sw-${Math.random().toString(36).slice(2, 10)}`,
    });

    const view = await assembleRegister({ projectIds: [projectId] });
    expect(view.unfiled.map((one) => one.ref)).not.toContain(captured.request.id);
    // And nothing in the register claims a missing change request either.
    expect(view.unfiled.every((one) => one.ref.startsWith('fcr_') || one.kind !== 'CHANGE_REQUEST')).toBe(
      true,
    );
  });
});

/**
 * `observeCampaignPullRequestMerge` — the forge's own answer correcting a
 * campaign's `PULL_REQUEST` attestation once the request actually merges.
 *
 * The forge is stubbed rather than reached, following the pattern
 * `tests/factoryExecutionPlane.test.ts` already uses: each test decides
 * exactly what `/pulls/:number` answers and then checks that the module's
 * decision follows from that and from nothing else.
 */
describe('observeCampaignPullRequestMerge', () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env['BRAIN_FORGE_API_BASE'];
  });

  /** Answers `/pulls/:number` with a fixed `merged` value; everything else 404s. */
  function stubForgePull(number: number, merged: boolean): void {
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const pull = /\/pulls\/(\d+)$/.exec(url);
      if (pull && Number(pull[1]) === number) {
        return json({
          number,
          state: merged ? 'closed' : 'open',
          merged,
          html_url: `https://github.com/x/y/pull/${number}`,
          title: 'a pull request',
          updated_at: '2026-09-21T00:00:00Z',
          head: { sha: 'b'.repeat(40), ref: `factory/${number}` },
          base: { ref: 'main' },
        });
      }
      return json({ message: 'Not Found' }, 404);
    }) as typeof globalThis.fetch;
  }

  /** A change request whose repository parses, without touching the forge. */
  async function approvedChangeRequestWithRemote() {
    await exec(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/Peyday007/register-test-fixture'],
      { cwd: repoRoot },
    );
    const submitted = await submitObjective({
      projectId,
      objective: 'Change the fixture so the outcome is visible.',
      expectedOutcome: 'server/one.txt contains the new text.',
      acceptanceConditions: [
        { statement: 'server/one.txt contains the new text', verification: 'read the file' },
      ],
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      submissionKey: `reg-merge-${Math.random().toString(36).slice(2, 10)}`,
    });
    const approved = await approveObjective({
      changeRequestId: submitted.changeRequest.id,
      via: 'PERSON',
      userId,
    });
    expect(approved.ok).toBe(true);
    return approved.changeRequest;
  }

  /** A COMPLETE campaign carrying an attested-but-unverified pull request. */
  async function completeCampaignWithPullRequest(prNumber: number): Promise<string> {
    const changeRequest = await approvedChangeRequestWithRemote();
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'only',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'only',
      objective: 'change the file',
      acceptance: ['it changed'],
      ownedPaths: ['server/one.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'INTEGRATED',
    });
    await recordIntegration({
      campaignId: campaign.id,
      unitId: unit.id,
      attempt: 1,
      outcome: 'MERGED',
      reason: 'stayed inside its surface',
      beforeSha: changeRequest.baseSha,
      afterSha: 'deadbeefcafe',
    });
    await recordReview({
      campaignId: campaign.id,
      round: 1,
      scope: 'CAMPAIGN',
      unitId: null,
      reviewerSessionId: 's-review',
      reviewedSha: 'deadbeefcafe',
      verdict: 'PASS',
      summary: 'clean',
      independence: 'SESSION_SEPARATED',
      findings: [],
    });
    await patchCampaign(campaign.id, {
      state: 'COMPLETE',
      integrationSha: 'deadbeefcafe',
      finishedAt: factoryNow(),
      prUrl: `https://github.com/Peyday007/register-test-fixture/pull/${prNumber}`,
      prRef: `#${prNumber}`,
    });
    return campaign.id;
  }

  /** The workstream carries the same open attestation `campaignPullRequestLink.ts` writes. */
  async function workstreamWithOpenAttestation(campaignId: string, prUrl: string): Promise<string> {
    const workstream = await stream();
    await linkWorkstream({
      workstreamId: workstream.id,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });
    await linkWorkstream({
      workstreamId: workstream.id,
      kind: 'PULL_REQUEST',
      ref: prUrl,
      relation: 'EVIDENCE',
      recordedBy: 'BRAIN',
      detail: { attestedBy: 'factory-campaign', attestedAt: '2026-09-20T00:00:00.000Z', merged: false, state: 'open' },
    });
    return workstream.id;
  }

  it('refuses when the campaign has no attested pull request', async () => {
    const changeRequest = await approvedChangeRequestWithRemote();
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    const result = await observeCampaignPullRequestMerge(campaign.id);
    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/no attested pull request/);
    expect(result.correctedWorkstreamIds).toEqual([]);
  });

  it('refuses when the campaign does not exist', async () => {
    const result = await observeCampaignPullRequestMerge('no-such-campaign');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no such campaign/);
    expect(result.correctedWorkstreamIds).toEqual([]);
  });

  it('refuses with the forge\'s own reason when the call itself fails', async () => {
    const campaignId = await completeCampaignWithPullRequest(4300);
    // Stub a pull request that never answers 4300, so the forge 404s.
    stubForgePull(9999, true);

    const result = await observeCampaignPullRequestMerge(campaignId);
    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.correctedWorkstreamIds).toEqual([]);
  });

  it('makes its one call, changes no rows, and reports nothing merged when the forge says open', async () => {
    const campaignId = await completeCampaignWithPullRequest(4301);
    const prUrl = `https://github.com/Peyday007/register-test-fixture/pull/4301`;
    const workstreamId = await workstreamWithOpenAttestation(campaignId, prUrl);
    stubForgePull(4301, false);

    const before = await listLinks(workstreamId, { includeSuperseded: true });

    const result = await observeCampaignPullRequestMerge(campaignId);
    expect(result.ok).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.correctedWorkstreamIds).toEqual([]);

    const after = await listLinks(workstreamId, { includeSuperseded: true });
    expect(after).toEqual(before);
  });

  it('A04: corrects the stale attestation, superseding it rather than mutating it, when the forge reports merged', async () => {
    const campaignId = await completeCampaignWithPullRequest(4302);
    const prUrl = `https://github.com/Peyday007/register-test-fixture/pull/4302`;
    const workstreamId = await workstreamWithOpenAttestation(campaignId, prUrl);
    stubForgePull(4302, true);

    const result = await observeCampaignPullRequestMerge(campaignId);
    expect(result.ok).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.correctedWorkstreamIds).toEqual([workstreamId]);

    const live = await listLinks(workstreamId);
    const pullRequestLinks = live.filter((link) => link.kind === 'PULL_REQUEST');
    expect(pullRequestLinks).toHaveLength(1);
    expect(pullRequestLinks[0]?.detail.merged).toBe(true);
    expect(pullRequestLinks[0]?.detail.state).toBe('merged');
    expect(pullRequestLinks[0]?.detail.attestedBy).toBe('pull-request-merge-observation');
    expect(pullRequestLinks[0]?.detail.attestedBy).not.toBe('factory-campaign');
    expect(typeof pullRequestLinks[0]?.detail.attestedAt).toBe('string');
    expect(pullRequestLinks[0]?.ref).toBe(prUrl);

    // The stale link is superseded, never destroyed.
    const everything = await listLinks(workstreamId, { includeSuperseded: true });
    const supersededLinks = everything.filter((link) => link.kind === 'PULL_REQUEST' && link.supersededAt !== null);
    expect(supersededLinks).toHaveLength(1);
    expect(supersededLinks[0]?.detail.merged).toBe(false);
    expect(supersededLinks[0]?.supersededReason).toMatch(/merged/);
  });

  it('does not create a second correction on a second call', async () => {
    const campaignId = await completeCampaignWithPullRequest(4303);
    const prUrl = `https://github.com/Peyday007/register-test-fixture/pull/4303`;
    const workstreamId = await workstreamWithOpenAttestation(campaignId, prUrl);
    stubForgePull(4303, true);

    const first = await observeCampaignPullRequestMerge(campaignId);
    expect(first.correctedWorkstreamIds).toEqual([workstreamId]);

    const afterFirst = await listLinks(workstreamId, { includeSuperseded: true });
    const supersededAfterFirst = afterFirst.filter(
      (link) => link.kind === 'PULL_REQUEST' && link.supersededAt !== null,
    );
    expect(supersededAfterFirst).toHaveLength(1);

    // The second call finds `detail.merged === true` already and does nothing.
    const second = await observeCampaignPullRequestMerge(campaignId);
    expect(second.ok).toBe(true);
    expect(second.merged).toBe(true);
    expect(second.correctedWorkstreamIds).toEqual([]);

    const afterSecond = await listLinks(workstreamId, { includeSuperseded: true });
    const supersededAfterSecond = afterSecond.filter(
      (link) => link.kind === 'PULL_REQUEST' && link.supersededAt !== null,
    );
    // Exactly one supersession per correction — not one per call.
    expect(supersededAfterSecond).toHaveLength(1);
    expect(afterSecond.filter((link) => link.kind === 'PULL_REQUEST' && link.supersededAt === null)).toHaveLength(1);
  });
});
