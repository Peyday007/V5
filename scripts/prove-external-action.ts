/**
 * Prove one external action end to end against a real provider (§50).
 *
 * Starts a real Brain on a throwaway SQLite data directory, signs in as its
 * administrator over HTTP, and walks the path a person walks: open a Russell
 * conversation on a project, connect the owner-notification provider, deploy
 * its credential the way production does (as an environment secret, which
 * means a restart), check it, send one message from the conversation, and read
 * the result back — from Brain, and then independently from the provider by a
 * request that shares no code with Brain's.
 *
 * The provider is ntfy.sh, and the destination is a private topic this script
 * generates and throws away: self-directed, reaching no third party, costing
 * nothing. The topic is the credential, so it is never printed.
 *
 *   npx tsx scripts/prove-external-action.ts
 *
 * Prints `EXTERNAL-PROVE: OK` only when every step held.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PORT = 7400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'owner@example.invalid';
const BOOT_PASSWORD = 'bootstrap-password-01';
const PASSWORD = 'administrator-password-01';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let log = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-external-prove-'));
const topic = 'brain-prove-' + crypto.randomBytes(16).toString('hex');

function step(label: string, detail: unknown): void {
  console.log(`STEP ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function fail(message: string): never {
  console.log(`EXTERNAL-PROVE: FAIL ${message}`);
  if (process.env.PROVE_VERBOSE) console.log(log.slice(-4000));
  server?.kill('SIGINT');
  process.exit(1);
}

async function start(extraEnv: Record<string, string> = {}): Promise<void> {
  server = spawn(process.execPath, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      BRAIN_DATA_DIR: dataDir,
      PORT: String(PORT),
      NODE_ENV: 'production',
      BRAIN_BOOTSTRAP_ADMIN_EMAIL: ADMIN,
      BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOT_PASSWORD,
      BRAIN_DATABASE_PROVIDER: 'sqlite',
      BRAIN_STORAGE_PROVIDER: 'local',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      BRAIN_PROVIDER: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) fail('the server never became healthy');
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function stop(): Promise<void> {
  const dying = server;
  server = null;
  if (!dying) return;
  await new Promise<void>((resolve) => {
    dying.once('exit', () => resolve());
    dying.kill('SIGINT');
    setTimeout(() => resolve(), 10_000);
  });
}

async function call<T>(method: string, route: string, cookie: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: response.status, body: parsed as T };
}

async function signIn(password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN, password }),
  });
  if (!response.ok) fail(`sign-in answered ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function main(): Promise<void> {
  await start();
  const boot = await signIn(BOOT_PASSWORD);
  await call('POST', '/api/auth/password', boot, { currentPassword: BOOT_PASSWORD, newPassword: PASSWORD });
  let cookie = await signIn(PASSWORD);

  const projects = await call<{ projects: Array<{ id: string; name: string }> }>('GET', '/api/projects', cookie);
  const project = projects.body.projects[0];
  if (!project) fail('no project');
  step('project', project.name);

  const conversation = await call<{ id: string }>('POST', '/api/russell/conversations', cookie, {
    projectId: project.id,
    title: 'Tell me on my phone when something needs me',
  });
  const conversationId = conversation.body.id;
  if (!conversationId) fail(`could not open a conversation: ${JSON.stringify(conversation.body)}`);
  step('conversation', conversationId);

  const before = await call<{ capabilities: Array<{ id: string; state: string; detail: string | null }> }>('GET', `/api/projects/${project.id}/external`, cookie);
  const notifyBefore = before.body.capabilities.find((one) => one.id === 'NOTIFY_OWNER');
  step('capability before connecting', notifyBefore);
  if (notifyBefore?.state !== 'MISSING') fail('NOTIFY_OWNER should read MISSING before anything is connected');

  const connected = await call<{ connection: { id: string; secretName: string } }>('POST', `/api/projects/${project.id}/external/connections`, cookie, { provider: 'NTFY' });
  if (connected.status !== 200) fail(`connect answered ${connected.status}`);
  const { id: connectionId, secretName } = connected.body.connection;
  step('connected', { connectionId, secretName });

  const waiting = await call<{ capabilities: Array<{ id: string; state: string; detail: string | null }> }>('GET', `/api/projects/${project.id}/external`, cookie);
  step('capability with a row and no secret', waiting.body.capabilities.find((one) => one.id === 'NOTIFY_OWNER'));

  // The administrator step: a deployment secret, which restarts the machine.
  await stop();
  await start({ [secretName]: topic });
  cookie = await signIn(PASSWORD);
  step('restarted with the secret deployed', secretName);

  const checked = await call<{ state: string; says: string }>('POST', `/api/projects/${project.id}/external/connections/${connectionId}/check`, cookie, {});
  step('check', checked.body);
  if (checked.body.state !== 'HEALTHY') fail('the connection did not read HEALTHY after a real check');

  const after = await call<{ capabilities: Array<{ id: string; state: string; detail: string | null }> }>('GET', `/api/projects/${project.id}/external`, cookie);
  const notifyAfter = after.body.capabilities.find((one) => one.id === 'NOTIFY_OWNER');
  step('capability after a real check', notifyAfter);
  if (notifyAfter?.state !== 'PRESENT') fail('NOTIFY_OWNER did not read PRESENT');

  const sent = await call<{ action: { id: string; state: string; providerRef: string | null; readbackState: string | null; readbackDetail: string | null; operationId: string | null } }>(
    'POST',
    `/api/projects/${project.id}/external/actions`,
    cookie,
    {
      kind: 'NOTIFY_OWNER',
      subject: 'Brain: external action proof',
      body: 'This message was sent by Brain through its external-action path and read back.',
      conversationId,
    },
  );
  step('action', sent.body.action);
  let action = sent.body.action;
  if (action?.state !== 'CONFIRMED' || !action.providerRef) fail(`the action did not confirm: ${JSON.stringify(sent.body)}`);
  // The provider writes its cache a moment after answering, so the first
  // read-back may honestly say NOT_VISIBLE_YET. Ask again, as the tick would.
  for (let tries = 0; action.readbackState !== 'PUBLISHED' && tries < 10; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const refreshed = await call<{ action: typeof action }>('POST', `/api/projects/${project.id}/external/actions/${action.id}/refresh`, cookie, {});
    action = refreshed.body.action;
    step('read back again', { readbackState: action.readbackState, readbackDetail: action.readbackDetail });
  }
  if (action.readbackState !== 'PUBLISHED') fail(`the read-back did not find it: ${action.readbackState}`);

  // Independent of Brain: ask the provider directly, with code that shares
  // nothing with Brain's driver.
  const direct = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=1h`);
  const lines = (await direct.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id?: string; title?: string; time?: number });
  const seen = lines.find((one) => one.id === action.providerRef);
  step('independent provider read', seen ? { id: seen.id, title: seen.title, time: seen.time && new Date(seen.time * 1000).toISOString() } : 'not found');
  if (!seen) fail('the provider does not hold the message Brain says it sent');

  const thread = await call<{ turns?: Array<{ role: string; content: string }>; messages?: Array<{ role: string; content: string }> }>('GET', `/api/russell/conversations/${conversationId}`, cookie);
  const text = JSON.stringify(thread.body);
  if (!action.providerRef || !text.includes(action.providerRef)) fail('the result did not return to the conversation');
  step('returned to the conversation', 'the SYSTEM message carries the provider identifier');

  // Idempotency: the identical request again is the same action, not a second send.
  const again = await call<{ created: boolean; action: { id: string } }>('POST', `/api/projects/${project.id}/external/actions`, cookie, {
    kind: 'NOTIFY_OWNER',
    subject: 'Brain: external action proof',
    body: 'This message was sent by Brain through its external-action path and read back.',
    conversationId,
  });
  step('same request again', { created: again.body.created, sameAction: again.body.action?.id === action.id });
  if (again.body.created || again.body.action?.id !== action.id) fail('a repeated request produced a second action');

  const revoked = await call('POST', `/api/projects/${project.id}/external/connections/${connectionId}/revoke`, cookie, { reason: 'end of proof' });
  step('revoke', revoked.status);
  const gone = await call<{ capabilities: Array<{ id: string; state: string }> }>('GET', `/api/projects/${project.id}/external`, cookie);
  const notifyGone = gone.body.capabilities.find((one) => one.id === 'NOTIFY_OWNER');
  step('capability after revoking', notifyGone);
  if (notifyGone?.state !== 'MISSING') fail('the capability did not read MISSING after revoking');
  const refused = await call<{ error?: string; message?: string }>('POST', `/api/projects/${project.id}/external/actions`, cookie, {
    kind: 'NOTIFY_OWNER',
    subject: 'after revoke',
    body: 'must not be sent',
  });
  step('prepare after revoking', { status: refused.status, body: refused.body });
  if (refused.status !== 422) fail('a revoked connection still accepted an action');

  // No credential in the log or in any row Brain wrote.
  if (log.includes(topic)) fail('the credential appeared in the server log');
  const dbFile = fs.readdirSync(dataDir).find((one) => one.endsWith('.db'));
  if (dbFile && fs.readFileSync(path.join(dataDir, dbFile)).includes(Buffer.from(topic))) {
    fail('the credential appeared in the database');
  }
  step('credential', 'absent from the server log and from the database file');

  await stop();
  console.log(`EXTERNAL-PROVE: OK provider=ntfy.sh receipt=${action.providerRef} readback=${action.readbackState} operation=${action.operationId}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
