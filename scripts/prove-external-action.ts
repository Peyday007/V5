/**
 * Prove one external action end to end against a real provider (§51).
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
 * Three things beyond a plain send, because they are what release acceptance
 * asks about:
 *
 *   - The request comes from Russell. A person asks in a conversation; a real
 *     worker, authenticated with a Brain-issued credential over the real MCP
 *     endpoint, checks in, answers the turn with a proposal and completes the
 *     bin; the tick applies it. Nothing is called in-process.
 *   - An ambiguous send is reconciled against the real provider. Brain talks
 *     to ntfy.sh through a local HTTPS relay (trusted by adding its CA, never
 *     by relaxing verification). For one publish the relay forwards the
 *     message and then loses the response, so Brain must ask ntfy.sh what
 *     happened — and the topic, read independently, must hold that message
 *     exactly once.
 *   - Every HTTP response Brain gave, its log and its database file are
 *     searched for the credential.
 *
 *   npx tsx scripts/prove-external-action.ts
 *
 * Prints `EXTERNAL-PROVE: OK` only when every step held.
 */
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import https from 'node:https';
import { ModernMcpClient } from './mcpModernClient.ts';
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
/** Every body Brain answered with, searched for the credential at the end. */
const responses: string[] = [];

function tagFor(actionId: string): string {
  return 'brn-' + crypto.createHash('sha256').update(actionId, 'utf8').digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------------- */
/* The relay: ntfy.sh, with one response lost on purpose                      */
/* ------------------------------------------------------------------------- */

const relay = { dropNextPublishResponse: false, publishes: 0, dropped: 0 };
const RELAY_PORT = 7900 + Math.floor(Math.random() * 90);
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-relay-cert-'));

function makeCertificate(): { key: Buffer; cert: Buffer; bundle: string } {
  const key = path.join(certDir, 'key.pem');
  const cert = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { stdio: 'ignore' });
  // Trust is added for the relay, on top of whatever this machine already
  // trusts. Nothing here turns verification off.
  const bundle = path.join(certDir, 'bundle.pem');
  const existing = process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)
    ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8')
    : '';
  fs.writeFileSync(bundle, existing + '\n' + fs.readFileSync(cert, 'utf8'));
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), bundle };
}

async function startRelay(tls: { key: Buffer; cert: Buffer }): Promise<https.Server> {
  const server = https.createServer(tls, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    try {
      const upstream = await fetch(`https://ntfy.sh${req.url ?? '/'}`, {
        method: req.method,
        headers: req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {},
        body: req.method === 'POST' ? body : undefined,
      });
      const text = await upstream.text();
      if (req.method === 'POST') {
        relay.publishes += 1;
        if (relay.dropNextPublishResponse) {
          relay.dropNextPublishResponse = false;
          relay.dropped += 1;
          // ntfy.sh has the message. Brain is told the gateway failed.
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('relay lost the response');
          return;
        }
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(RELAY_PORT, '127.0.0.1', resolve));
  return server;
}

/** The topic as ntfy.sh itself reports it — no Brain code involved. */
async function topicMessages(): Promise<Array<{ id?: string; title?: string; time?: number; tags?: string[] }>> {
  const direct = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=1h`);
  return (await direct.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor<T>(label: string, read: () => Promise<T | null>, seconds = 150): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

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
  responses.push(text);
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

type ActionView = {
  id: string;
  kind: string;
  state: string;
  providerRef: string | null;
  readbackState: string | null;
  readbackDetail: string | null;
  operationId: string | null;
  requestedByType: string;
  approvalRequired: boolean;
  returnedAt: string | null;
  outcomeDetail: string | null;
};
type ExternalView = {
  capabilities: Array<{ id: string; state: string; detail: string | null }>;
  actions: ActionView[];
  history: Array<{ kind: string; actionId: string | null; summary: string }>;
};

const RESEARCH_SCOPES = [
  'project:read', 'documents:read', 'research:read', 'research:propose', 'research:write',
  'claims:write', 'contradictions:write', 'checkpoints:write', 'blockers:report',
  'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete',
];

async function main(): Promise<void> {
  const tls = makeCertificate();
  const relayServer = await startRelay(tls);
  const secret = `https://127.0.0.1:${RELAY_PORT}/${topic}`;
  const trust = { NODE_EXTRA_CA_CERTS: tls.bundle };

  await start(trust);
  const boot = await signIn(BOOT_PASSWORD);
  await call('POST', '/api/auth/password', boot, { currentPassword: BOOT_PASSWORD, newPassword: PASSWORD });
  let cookie = await signIn(PASSWORD);

  const projects = await call<{ projects: Array<{ id: string; name: string }> }>('GET', '/api/projects', cookie);
  const project = projects.body.projects[0];
  if (!project) fail('no project');
  step('project', project.name);
  const view = async () => (await call<ExternalView>('GET', `/api/projects/${project.id}/external`, cookie)).body;
  const capability = async () => (await view()).capabilities.find((one) => one.id === 'NOTIFY_OWNER');

  const conversation = await call<{ id: string }>('POST', '/api/russell/conversations', cookie, {
    projectId: project.id,
    title: 'Tell me on my phone when something needs me',
  });
  const conversationId = conversation.body.id;
  if (!conversationId) fail(`could not open a conversation: ${JSON.stringify(conversation.body)}`);
  step('conversation', conversationId);

  const notifyBefore = await capability();
  step('capability before connecting', notifyBefore);
  if (notifyBefore?.state !== 'MISSING') fail('NOTIFY_OWNER should read MISSING before anything is connected');

  const connected = await call<{ connection: { id: string; secretName: string } }>('POST', `/api/projects/${project.id}/external/connections`, cookie, { provider: 'NTFY' });
  if (connected.status !== 200) fail(`connect answered ${connected.status}`);
  const { id: connectionId, secretName } = connected.body.connection;
  step('connected', { connectionId, secretName });
  const waiting = await capability();
  step('capability with a row and no secret', waiting);
  if (waiting?.state !== 'MISSING') fail('a row without a deployed secret read as available');

  // The administrator step: a deployment secret, which restarts the machine.
  await stop();
  await start({ ...trust, [secretName]: secret });
  cookie = await signIn(PASSWORD);
  step('restarted with the secret deployed', secretName);
  const unchecked = await capability();
  if (unchecked?.state !== 'MISSING') fail('a deployed but unchecked secret read as available');

  const checked = await call<{ state: string; says: string }>('POST', `/api/projects/${project.id}/external/connections/${connectionId}/check`, cookie, {});
  step('check', checked.body);
  if (checked.body.state !== 'HEALTHY') fail('the connection did not read HEALTHY after a real check');
  const present = await capability();
  step('capability after a real check', present);
  if (present?.state !== 'PRESENT') fail('NOTIFY_OWNER did not read PRESENT');

  /* ----------------------------------------------------------------------- */
  /* 1. Russell: a person asks, a real worker answers over MCP, the tick acts */
  /* ----------------------------------------------------------------------- */

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', cookie, { name: `prove-worker-${crypto.randomBytes(3).toString('hex')}` });
  const workerId = worker.body.worker?.id;
  if (!workerId) fail(`could not create a worker: ${JSON.stringify(worker.body)}`);
  const granted = await call('POST', `/api/admin/projects/${project.id}/members`, cookie, { principalType: 'WORKER', principalId: workerId, scopes: RESEARCH_SCOPES });
  if (granted.status !== 200) fail(`could not grant the worker the project: ${granted.status} ${JSON.stringify(granted.body)}`);
  const issued = await call<{ secret: string }>('POST', `/api/admin/workers/${workerId}/credentials`, cookie, {});
  const workerCredential = issued.body.secret;
  if (!workerCredential) fail('no worker credential was issued');
  const mcp = new ModernMcpClient({ url: `${BASE}/mcp`, credential: workerCredential, clientName: 'external-prove-worker' });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await mcp.request<{ structuredContent?: Record<string, unknown>; isError?: boolean }>('tools/call', { name, arguments: args });
    if (reply.error || reply.result?.isError) fail(`${name} refused: ${JSON.stringify(reply.error ?? reply.result)}`);
    return (reply.result?.structuredContent ?? {}) as Record<string, unknown>;
  };

  const asked = await call<{ dispatched: boolean }>('POST', `/api/russell/conversations/${conversationId}/turns`, cookie, {
    content: 'Send a message to my phone saying the external-action proof reached it.',
  });
  step('the person asked in the conversation', { status: asked.status, dispatched: asked.body.dispatched });
  if (asked.status !== 202) fail('the turn was not accepted');

  const assignment = await tool('brain_check_in', { session_ref: 'external-prove-session' });
  if (assignment['assigned'] !== true) fail(`the worker was given no bin: ${JSON.stringify(assignment)}`);
  const binId = String(assignment['binId']);
  const leaseId = String(assignment['leaseId']);
  const leaseGeneration = Number(assignment['leaseGeneration']);
  step('a worker checked in over MCP and holds the turn', { binId, kind: assignment['kind'] });
  const proposal = {
    action: 'PREPARE_EXTERNAL_ACTION',
    answer: 'I have asked Brain to send that to your phone; it will say here what happened.',
    confidence: 0.9,
    external: {
      kind: 'NOTIFY_OWNER',
      subject: 'Brain: external action proof',
      body: 'Russell asked for this, Brain sent it, and Brain read it back.',
    },
  };
  await tool('brain_bin_submit_unit', { bin_id: binId, lease_id: leaseId, lease_generation: leaseGeneration, unit_key: 'proposal', value: JSON.stringify(proposal) });
  const completed = await tool('brain_bin_complete', { bin_id: binId, lease_id: leaseId, lease_generation: leaseGeneration });
  step('the worker submitted a proposal and completed the bin', completed['state'] ?? completed);

  let action = await waitFor('the tick to prepare and send Russell’s action', async () => {
    const found = (await view()).actions.find((one) => one.kind === 'NOTIFY_OWNER' && one.requestedByType === 'WORKER');
    return found && found.state !== 'APPROVED' && found.state !== 'SENDING' ? found : null;
  });
  step('the proposal became an action, prepared under the owner and sent by the tick', {
    id: action.id, state: action.state, approvalRequired: action.approvalRequired, providerRef: action.providerRef, operation: action.operationId,
  });
  if (action.state !== 'CONFIRMED' || !action.providerRef) fail(`Russell's action did not confirm: ${JSON.stringify(action)}`);

  // The provider writes its cache a moment after answering; ask as the tick would.
  for (let tries = 0; action.readbackState !== 'PUBLISHED' && tries < 10; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    action = (await call<{ action: ActionView }>('POST', `/api/projects/${project.id}/external/actions/${action.id}/refresh`, cookie, {})).body.action;
    step('read back', { readbackState: action.readbackState, readbackDetail: action.readbackDetail });
  }
  if (action.readbackState !== 'PUBLISHED') fail(`the read-back did not find it: ${action.readbackState}`);

  const direct = await topicMessages();
  const russellsOwn = direct.filter((one) => one.tags?.includes(tagFor(action.id)));
  step('independent provider read', russellsOwn.map((one) => ({ id: one.id, title: one.title, time: one.time && new Date(one.time * 1000).toISOString() })));
  if (russellsOwn.length !== 1 || russellsOwn[0]!.id !== action.providerRef) fail('ntfy.sh does not hold exactly the one message Brain says it sent');

  const thread = JSON.stringify((await call('GET', `/api/russell/conversations/${conversationId}`, cookie)).body);
  if (!thread.includes(action.providerRef!)) fail('the result did not return to the conversation');
  step('returned to the conversation', 'a SYSTEM message carries the provider identifier and the read-back');
  const history = (await view()).history.filter((one) => one.actionId === action.id).map((one) => one.kind);
  step('the action’s own record', history);
  if (!history.includes('EXTERNAL_ACTION_RETURNED') || !history.includes('EXTERNAL_ACTION_PREPARED')) fail('the project history is missing the action');

  /* ----------------------------------------------------------------------- */
  /* 2. An ambiguous send, reconciled against the real provider              */
  /* ----------------------------------------------------------------------- */

  relay.dropNextPublishResponse = true;
  const lost = await call<{ action: ActionView }>('POST', `/api/projects/${project.id}/external/actions`, cookie, {
    kind: 'NOTIFY_OWNER',
    subject: 'Brain: reconciliation proof',
    body: 'The response to this publish was lost on purpose; Brain must find it rather than send it twice.',
    conversationId,
  });
  let ambiguous = lost.body.action;
  step('a publish whose response was lost', { state: ambiguous.state, providerRef: ambiguous.providerRef, outcome: ambiguous.outcomeDetail, relayDropped: relay.dropped });
  if (relay.dropped !== 1) fail('the relay did not lose the response');
  if (ambiguous.state !== 'CONFIRMED' && ambiguous.state !== 'UNCERTAIN') fail(`an ambiguous send became ${ambiguous.state}`);
  if (ambiguous.state === 'UNCERTAIN' && (ambiguous.providerRef || ambiguous.readbackState)) fail('an unknown outcome carried a receipt');
  ambiguous = await waitFor('the provider to be asked again and answer', async () => {
    const found = (await view()).actions.find((one) => one.id === ambiguous.id)!;
    return found.state === 'CONFIRMED' ? found : null;
  });
  const publishesBefore = relay.publishes;
  await new Promise((resolve) => setTimeout(resolve, 35_000)); // at least one more tick
  const copies = (await topicMessages()).filter((one) => one.tags?.includes(tagFor(ambiguous.id)));
  step('reconciled', { state: ambiguous.state, providerRef: ambiguous.providerRef, outcome: ambiguous.outcomeDetail, copiesOnNtfy: copies.length, publishesSinceConfirmed: relay.publishes - publishesBefore });
  if (copies.length !== 1 || copies[0]!.id !== ambiguous.providerRef) fail('the reconciled message is not on ntfy.sh exactly once');
  if (relay.publishes !== publishesBefore) fail('something was published again after the action was reconciled');

  /* ----------------------------------------------------------------------- */
  /* 3. The same request is the same action                                  */
  /* ----------------------------------------------------------------------- */

  const same = { kind: 'NOTIFY_OWNER', subject: 'Brain: idempotency proof', body: 'Asked for twice; sent once.' };
  const first = await call<{ created: boolean; action: ActionView }>('POST', `/api/projects/${project.id}/external/actions`, cookie, same);
  const again = await call<{ created: boolean; action: ActionView }>('POST', `/api/projects/${project.id}/external/actions`, cookie, same);
  // ntfy writes its cache a moment after answering, so wait until the message
  // is visible, then count: visible once is the claim, not "not visible yet".
  await waitFor('the idempotency message to be visible on ntfy.sh', async () =>
    (await topicMessages()).some((one) => one.tags?.includes(tagFor(first.body.action.id))) ? true : null, 60);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const once = (await topicMessages()).filter((one) => one.tags?.includes(tagFor(first.body.action.id)));
  step('same request again', { firstCreated: first.body.created, againCreated: again.body.created, sameAction: again.body.action?.id === first.body.action?.id, copiesOnNtfy: once.length });
  if (again.body.created || again.body.action?.id !== first.body.action.id || once.length !== 1) fail('a repeated request produced a second action or a second message');

  /* ----------------------------------------------------------------------- */
  /* 4. Revoked means refused                                                */
  /* ----------------------------------------------------------------------- */

  const revoked = await call('POST', `/api/projects/${project.id}/external/connections/${connectionId}/revoke`, cookie, { reason: 'end of proof' });
  step('revoke', revoked.status);
  const notifyGone = await capability();
  step('capability after revoking', notifyGone);
  if (notifyGone?.state !== 'MISSING') fail('the capability did not read MISSING after revoking');
  const refused = await call<{ error?: string; message?: string }>('POST', `/api/projects/${project.id}/external/actions`, cookie, { kind: 'NOTIFY_OWNER', subject: 'after revoke', body: 'must not be sent' });
  step('prepare after revoking', { status: refused.status, body: refused.body });
  if (refused.status !== 422) fail('a revoked connection still accepted an action');
  const publishesAtRevoke = relay.publishes;
  await new Promise((resolve) => setTimeout(resolve, 35_000));
  if (relay.publishes !== publishesAtRevoke) fail('something was published after the connection was revoked');

  /* ----------------------------------------------------------------------- */
  /* 5. The credential is nowhere                                            */
  /* ----------------------------------------------------------------------- */

  const everything = log + responses.join('\n');
  if (everything.includes(topic)) fail('the credential appeared in the server log or an HTTP response');
  if (everything.includes(workerCredential.slice(8))) {
    // The worker credential was shown once, by design, in its own issuing response only.
    const leaks = responses.filter((one) => one.includes(workerCredential.slice(8))).length;
    if (leaks > 1 || log.includes(workerCredential.slice(8))) fail('the worker credential appeared somewhere other than its one issuing response');
  }
  const dbFile = fs.readdirSync(dataDir).find((one) => one.endsWith('.db'));
  if (!dbFile) fail('no database file to search');
  for (const file of fs.readdirSync(dataDir).filter((one) => /\.db(-wal)?$/.test(one))) {
    if (fs.readFileSync(path.join(dataDir, file)).includes(Buffer.from(topic))) fail(`the credential appeared in ${file}`);
  }
  step('credential', `absent from the server log, ${responses.length} HTTP responses, and the database`);

  await stop();
  relayServer.close();
  console.log(
    `EXTERNAL-PROVE: OK provider=ntfy.sh russell=${action.providerRef}/${action.readbackState} ` +
      `reconciled=${ambiguous.providerRef} operation=${action.operationId}`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
