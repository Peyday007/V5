/**
 * The bridge and the register, driven over a socket.
 *
 * The service suites beside this one cannot see the properties that live at the
 * door, and those are the ones that would be quietly wrong:
 *
 *   * **A worker is refused by type**, at every route including the reads. A
 *     machine that could write into somebody's conversation could put words in
 *     their mouth.
 *   * **A bridge credential cannot mint another one.** A key that could mint
 *     keys survives its own revocation: revoke the one you know about and the
 *     one it made is still there.
 *   * **A bridge credential is not an administrator**, however its holder's
 *     account is configured.
 *   * **Absent and forbidden are one answer with one body** — somebody else's
 *     conversation and an invented id are byte-identical.
 *
 * It mounts the real routers over the real database, with the principal
 * attached the way `guard.ts` attaches it. What is *not* substituted is the
 * decision: `requirePerson` and `decideProjectAccess` run exactly as they do in
 * production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { bridgeRouter } from '../server/routes/bridge.ts';
import { registerRouter } from '../server/routes/register.ts';
import { authenticateRequest } from '../server/services/identity/authenticate.ts';
import type { Principal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let server: Server | null = null;
let base = '';

/** Swapped per test, the way a different credential would produce a different one. */
let current: Principal | null = null;

function human(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_browser',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'ADMIN',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      },
    ],
    requestId: 'req',
    ...overrides,
  } as Principal;
}

function worker(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'a-worker',
    displayName: 'A worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cre_worker',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem-w',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: null,
        scopes: ['project:read', 'research:write'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      },
    ],
    requestId: 'req',
  } as Principal;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;

  const user = await createUser({
    email: `door-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const machine = await createWorker({
    name: `worker-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'A worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = machine.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: workerId,
    role: null,
    scopes: ['project:read', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  current = human();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: current,
      requestId: newRequestId(),
      method: req.method,
      /*
       * The path the policy module matches on, which is the one the request
       * already carries. `req.path` in a middleware registered with no mount
       * path is the whole path, so prefixing `/api` again yields `/api/api/…`,
       * which matches no pattern in `services/identity/policy.ts` and falls
       * silently to the default `READ` — every write in this harness would then
       * be authorized at the wrong level, and a refusal asserted against one
       * would be vacuous.
       */
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', bridgeRouter);
  app.use('/api', registerRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });

  // Port 0 so this suite owns no range and cannot find another suite's server.
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('a worker is refused by type', () => {
  it('cannot read or write anything here', async () => {
    current = worker();
    for (const [method, path, body] of [
      ['GET', '/api/bridge/credentials', undefined],
      ['POST', '/api/bridge/credentials', { label: 'mine' }],
      ['GET', '/api/bridge/conversations', undefined],
      ['POST', '/api/bridge/conversations/sync', { source: 'CHATGPT', externalId: 'x', title: 't', messages: [] }],
      ['GET', '/api/register', undefined],
      ['POST', '/api/register/workstreams', { title: 't', intent: 'i', purpose: 'CAPABILITY' }],
    ] as const) {
      const result = await call(method as 'GET', path, body);
      expect([401, 403, 404], `${method} ${path}`).toContain(result.status);
    }
  });
});

describe('a bridge credential is bounded', () => {
  it('cannot mint another credential', async () => {
    current = human({ authMethod: 'BRIDGE_BEARER', credentialId: 'bcr_one' });
    const refused = await call('POST', '/api/bridge/credentials', { label: 'a second key' });
    expect(refused.status).toBe(404);

    // The same person over the cookie can.
    current = human();
    const minted = await call('POST', '/api/bridge/credentials', { label: 'my chat client' });
    expect(minted.status).toBe(200);
    expect(minted.body.secret.startsWith('brnc_')).toBe(true);
  });

  it('resolves to the person and never to an administrator', async () => {
    current = human();
    const minted = await call('POST', '/api/bridge/credentials', { label: 'my chat client' });
    const secret: string = minted.body.secret;

    /*
     * Authenticated for real rather than asserted about: the credential goes
     * through `authenticateRequest`, which is the function every request uses.
     * A test that built the principal itself would be testing the test.
     */
    const outcome = await authenticateRequest({
      header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${secret}` : undefined),
      query: {},
      secure: true,
    } as any);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.principal.type).toBe('HUMAN');
    expect(outcome.principal.id).toBe(userId);
    expect(outcome.principal.authMethod).toBe('BRIDGE_BEARER');
    // The half that matters: a key pasted into a chat client is not Brain
    // administration, whatever the account behind it is.
    expect(outcome.principal.isBrainAdmin).toBe(false);
  });

  it('is refused once it is given back', async () => {
    current = human();
    const minted = await call('POST', '/api/bridge/credentials', { label: 'key' });
    const secret: string = minted.body.secret;
    const revoked = await call(
      'POST',
      `/api/bridge/credentials/${minted.body.credential.id}/revoke`,
      { reason: 'rotating it' },
    );
    expect(revoked.body.revoked).toBe(true);

    const outcome = await authenticateRequest({
      header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${secret}` : undefined),
      query: {},
      secure: true,
    } as any);
    expect(outcome.ok).toBe(false);
  });
});

describe('somebody else’s conversation', () => {
  it('answers exactly as an invented id does, body included', async () => {
    current = human();
    const mine = await call('POST', '/api/bridge/conversations/sync', {
      source: 'CHATGPT',
      externalId: 'conv-mine',
      title: 'Mine',
      messages: [{ ordinal: 0, role: 'USER', content: 'hello' }],
      interpret: false,
    });
    expect(mine.status).toBe(200);

    const other = await createUser({
      email: `other-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Somebody else',
      password: 'correct horse battery staple',
    });
    current = human({ id: other.id, memberships: [] });

    const theirs = await call('GET', `/api/bridge/conversations/${mine.body.conversationId}/status`);
    const invented = await call('GET', '/api/bridge/conversations/bcv_0000000000000000000/status');
    expect(theirs.status).toBe(invented.status);
    // The same *body*, not only the same status: a status code that matches
    // while the body differs is still an oracle.
    expect(theirs.body).toEqual(invented.body);
  });
});

describe('the round trip a client actually makes', () => {
  it('syncs, gets a receipt, reads the transcript back, and asks what happened', async () => {
    current = human();
    const synced = await call('POST', '/api/bridge/conversations/sync', {
      source: 'CHATGPT',
      externalId: 'conv-round-trip',
      title: 'Planning the export fix',
      messages: [
        { ordinal: 0, role: 'USER', content: 'The Deal Dispatch export drops the last row.' },
        { ordinal: 1, role: 'ASSISTANT', content: 'That sounds like an off-by-one.' },
      ],
      interpret: false,
    });
    expect(synced.status).toBe(200);
    expect(synced.body.performed).toBe(true);
    expect(synced.body.receipt.accepted).toBe(2);
    expect(synced.body.receipt.missing).toEqual([]);

    const transcript = await call(
      'GET',
      `/api/bridge/conversations/${synced.body.conversationId}/transcript`,
    );
    expect(transcript.body.messages.map((one: any) => one.content)).toEqual([
      'The Deal Dispatch export drops the last row.',
      'That sounds like an off-by-one.',
    ]);

    const status = await call(
      'GET',
      `/api/bridge/conversations/${synced.body.conversationId}/status`,
    );
    expect(status.body.conversation.messageCount).toBe(2);

    /*
     * And the register can point at it, which is the join the whole delivery is
     * for: a conversation held somewhere else is now a source a workstream
     * resolves.
     */
    const filed = await call('POST', '/api/register/workstreams', {
      projectId,
      title: 'Fix the export',
      intent: 'The export stops dropping the last row.',
      purpose: 'REVENUE_ENABLING',
      links: [
        {
          kind: 'BRIDGE_CONVERSATION',
          ref: synced.body.conversationId,
          relation: 'SOURCE',
          label: 'Planning the export fix',
        },
      ],
    });
    expect(filed.status).toBe(200);
    expect(filed.body.links).toHaveLength(1);

    const register = await call('GET', '/api/register');
    expect(register.body.answers.pursuingMoney).toContain(filed.body.workstream.id);

    const again = await call(
      'GET',
      `/api/bridge/conversations/${synced.body.conversationId}/status`,
    );
    expect(again.body.workstreams.map((one: any) => one.id)).toContain(filed.body.workstream.id);
  });

  it('imports a pasted transcript and says which reading it used', async () => {
    current = human();
    const imported = await call('POST', '/api/bridge/conversations/import', {
      body: 'You: what did we decide?\nChatGPT: to ship it on Friday.',
      title: 'Pasted',
    });
    expect(imported.status).toBe(200);
    expect(imported.body.format).toBe('MARKED_TEXT');
    expect(imported.body.receipt.accepted).toBe(2);
  });
});
