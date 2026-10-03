/**
 * The unfiled list offers one change request once, and never a withdrawn one.
 * A software request and the change request it became name the same row.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { captureSoftwareRequest, recordSoftwareAuthorization } from '../server/repos/russellSoftware.ts';
import { submitObjective } from '../server/services/factory/contract.ts';
import { unfiledWork } from '../server/services/register/unfiled.ts';

const exec = promisify(execFile);
let projectId = '';
let userId = '';
let repoRoot = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `dedup-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-repo-'));
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { test: 'node -e "0"' } }),
  );
  fs.mkdirSync(path.join(repoRoot, 'server'));
  fs.writeFileSync(path.join(repoRoot, 'server', 'one.txt'), 'one\n');
  await exec('git', ['init', '-b', 'main'], { cwd: repoRoot });
  await exec('git', ['config', 'user.email', 'd@test'], { cwd: repoRoot });
  await exec('git', ['config', 'user.name', 'Dedup'], { cwd: repoRoot });
  await exec('git', ['add', '-A'], { cwd: repoRoot });
  await exec('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: repoRoot });
});

afterEach(() => {
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
});

async function linkedPair(): Promise<{ changeRequestId: string }> {
  const submitted = await submitObjective({
    projectId,
    objective: 'The objective as the contract holds it.',
    expectedOutcome: 'It is done.',
    acceptanceConditions: [{ statement: 'The change is present.', verification: 'npm test' }],
    repositoryRoot: repoRoot,
    mutationScope: ['server/**'],
    submissionKey: `dd-${Math.random().toString(36).slice(2, 10)}`,
  });
  const conversation = await createConversation({ ownerUserId: userId, title: 'Asking' });
  const captured = await captureSoftwareRequest({
    projectId,
    conversationId: conversation.id,
    messageId: null,
    title: 'The richer conversation title',
    objective: 'The export stops dropping the last row.',
    expectedOutcome: 'Every row is present.',
    submissionKey: `sw-${Math.random().toString(36).slice(2, 10)}`,
  });
  await recordSoftwareAuthorization({
    id: captured.request.id,
    grantId: 'grant',
    repositoryId: 'repo',
    baseBranch: null,
    requestedScope: ['server/**'],
    changeRequestId: submitted.changeRequest.id,
    campaignId: 'campaign',
    authorizedByUserId: userId,
  });
  return { changeRequestId: submitted.changeRequest.id };
}

describe('unfiled change requests', () => {
  it('offers a change request once, under the software request title', async () => {
    const { changeRequestId } = await linkedPair();
    const offered = (await unfiledWork([projectId])).filter(
      (one) => one.kind === 'CHANGE_REQUEST' && one.ref === changeRequestId,
    );
    expect(offered).toHaveLength(1);
    expect(offered[0]?.title).toBe('The richer conversation title');
  });

  it('offers nothing for a withdrawn change request, from either path', async () => {
    const { changeRequestId } = await linkedPair();
    await getDb().run(`UPDATE factory_change_requests SET state = 'WITHDRAWN' WHERE id = ?`, [
      changeRequestId,
    ]);
    const offered = await unfiledWork([projectId]);
    expect(offered.filter((one) => one.ref === changeRequestId)).toHaveLength(0);
  });
});
