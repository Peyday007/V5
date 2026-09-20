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
import { submitObjective, approveObjective } from '../server/services/factory/contract.ts';
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
});
