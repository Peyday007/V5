/**
 * One Claude connection experience, proved from more than one account.
 *
 * ---------------------------------------------------------------------------
 * Why this is driven over HTTP rather than against the component
 * ---------------------------------------------------------------------------
 *
 * The property under test is that **two accounts are shown the same thing**,
 * and the only way to establish that is to be two accounts. A component test
 * renders one fixture: whatever it proves about parity, it proves about the
 * fixture. A service test resolves no principal at all. So this signs in as a
 * Brain administrator and as two ordinary members with no project membership
 * between them — the production shape exactly — and compares what the server
 * actually hands each of them.
 *
 * ---------------------------------------------------------------------------
 * What parity means here, precisely
 * ---------------------------------------------------------------------------
 *
 * Identical **structure**: the same top-level fields, the same steps in the
 * same order with the same titles and the same words, the same checks, the same
 * controls with the same labels, and the same troubleshooting list.
 *
 * Different **values**, and only these: the names Brain assigns from the
 * person's own id (the connector, the Routine, the deployment variable, the
 * worker), the ids, the timestamps, and whatever the rows say about that
 * person's own progress and health. Those are the account-specific facts the
 * screen exists to carry.
 *
 * The comparison is written as *whole-array equality after the dynamic values
 * are named*, rather than as a handful of spot checks. A test that asserted
 * three fields match would pass a payload that had quietly dropped a fourth.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/*
 * 7500. Every other HTTP suite's range is below it, and `deploymentOwnership`
 * refuses an overlap at the merge — two suites on one range do not fail
 * loudly, because `/healthz` is unauthenticated, so the second suite waits
 * happily for the first suite's server and then signs in against a Brain with a
 * different bootstrap administrator.
 */
const PORT = pickPort(7500, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const AIRYN_PASSWORD = 'airyn-password-0000001';
const CALEB_PASSWORD = 'caleb-password-0000001';

let adminCookie = '';
let airynCookie = '';
let calebCookie = '';
let airynId = '';
let calebId = '';
let workerBearer = '';

interface Result<T = unknown> {
  status: number;
  body: T;
  text: string;
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: response.status, body: body as T, text };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in for ${email} failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function makePerson(email: string, password: string): Promise<string> {
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName: email.split('@')[0], password: 'temporary-password-01' },
  });
  const first = await signIn(email, 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: password },
  });
  return created.body.user.id;
}

async function startServer(): Promise<void> {
  server = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(REPO_ROOT, 'server', 'index.ts'),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRAIN_DB_PATH: undefined,
        BRAIN_DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'test',
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        BRAIN_PROVIDER: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface Step {
  key: string;
  title: string;
  detail: string;
  copy?: { label: string; value: string }[];
  state: string;
}
interface Check {
  key: string;
  title: string;
  state: string;
  detail: string;
  remedy: string | null;
}
interface Control {
  key: string;
  label: string;
  enabled: boolean;
  disabledReason: string | null;
}
interface View {
  connection: Record<string, unknown>;
  state: string;
  headline: string;
  nextAction: string | null;
  steps: Step[];
  checks: Check[];
  controls: Control[];
  troubleshooting: { symptom: string; meaning: string; remedy: string }[];
  identity: Record<string, unknown>;
  secretPresent: boolean;
  connectorAuthenticated: boolean;
  authorizationExpired: boolean;
  proven: unknown;
}

async function view(cookie: string): Promise<View> {
  const answer = await call<View>('GET', '/api/people/me/claude', { cookie });
  expect(answer.status, answer.text).toBe(200);
  return answer.body;
}

/**
 * The instruction text with this account's own values taken back out.
 *
 * Parity is about the *sentence*, and three of the four values Brain assigns
 * are derived from the person's own id and therefore appear inside it. Blanking
 * them is what lets the sentences be compared as sentences — and it is
 * deliberately narrow: anything else that differed would still show up.
 */
function neutral(text: string, subject: View): string {
  const connection = subject.connection as Record<string, string | undefined>;
  const mine = [connection.connectorName, connection.routineName, connection.secretName].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return mine.reduce<string>((out, value) => out.split(value).join('«mine»'), text);
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-claude-parity-'));
  await startServer();

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  /*
   * Two ordinary members of this Brain, **neither of them a member of any
   * project**, which is exactly what joining produces. If parity held only for
   * somebody who had been granted something, it would not be parity.
   */
  airynId = await makePerson('airyn@example.invalid', AIRYN_PASSWORD);
  airynCookie = await signIn('airyn@example.invalid', AIRYN_PASSWORD);
  calebId = await makePerson('caleb@example.invalid', CALEB_PASSWORD);
  calebCookie = await signIn('caleb@example.invalid', CALEB_PASSWORD);

  // A worker credential, to prove a machine is refused at these doors by type.
  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'a-research-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${seeded.body.projects[0]!.id}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      // Generously scoped on purpose: the refusal must not depend on the worker
      // being under-configured.
      scopes: ['project:read', 'work:claim', 'work:complete', 'research:propose'],
    },
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerBearer = issued.body.secret;
}, 120_000);

afterAll(() => {
  server?.kill('SIGTERM');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('every account gets the same screen', () => {
  it('hands an administrator and two members the same top-level shape', async () => {
    const admin = await view(adminCookie);
    const airyn = await view(airynCookie);
    const caleb = await view(calebCookie);

    /*
     * The same keys, compared as whole sorted lists rather than by spot check.
     * A payload that dropped a section for one reader — which is precisely the
     * reduced screen this must rule out — changes this list.
     */
    const keys = (one: View): string[] => Object.keys(one).sort();
    expect(keys(airyn)).toEqual(keys(admin));
    expect(keys(caleb)).toEqual(keys(admin));
  });

  it('gives every account the same steps, in the same order, in the same words', async () => {
    const admin = await view(adminCookie);
    const airyn = await view(airynCookie);
    const caleb = await view(calebCookie);

    const shape = (one: View): unknown =>
      one.steps.map((step) => ({
        key: step.key,
        title: step.title,
        detail: neutral(step.detail, one),
        copy: (step.copy ?? []).map((box) => box.label),
      }));

    expect(shape(airyn)).toEqual(shape(admin));
    expect(shape(caleb)).toEqual(shape(admin));
    // And it really is the whole journey rather than a fragment of it.
    expect(airyn.steps.map((one) => one.key)).toEqual([
      'INVITATION',
      'CONNECTOR',
      'ROUTINE',
      'TRIGGER',
      'SECRET',
      'PROBE',
      'HEALTHY',
    ]);
  });

  it('gives every account the same checks and the same controls', async () => {
    const admin = await view(adminCookie);
    const airyn = await view(airynCookie);

    expect(airyn.checks.map((one) => [one.key, one.title])).toEqual(
      admin.checks.map((one) => [one.key, one.title]),
    );
    /*
     * Labels as well as keys. A control whose *words* differed per account
     * would be a screen two people cannot be talked through over a phone, which
     * is the failure this is actually about.
     */
    expect(airyn.controls.map((one) => [one.key, one.label])).toEqual(
      admin.controls.map((one) => [one.key, one.label]),
    );
    expect(airyn.controls.map((one) => one.key)).toEqual([
      'REQUEST_INVITATION',
      'SUBMIT_TRIGGER',
      'SEND_PROBE',
      'VERIFY',
      'REVOKE',
      'RECONNECT',
    ]);
  });

  it('gives every account the same troubleshooting, word for word', async () => {
    const admin = await view(adminCookie);
    const airyn = await view(airynCookie);
    const caleb = await view(calebCookie);
    // It describes the mechanism rather than this connection, so it is a
    // constant — and a constant is the strongest parity there is.
    expect(airyn.troubleshooting).toEqual(admin.troubleshooting);
    expect(caleb.troubleshooting).toEqual(admin.troubleshooting);
    expect(airyn.troubleshooting.length).toBeGreaterThan(3);
  });

  it('differs only in the values Brain derives from the person', async () => {
    const airyn = await view(airynCookie);
    const caleb = await view(calebCookie);

    const mine = airyn.connection as Record<string, string>;
    const theirs = caleb.connection as Record<string, string>;
    // Account-specific by construction, so that two members cannot collide on a
    // connector name, a Routine name or — worst of the three — a deployment
    // variable somebody pastes into a console by hand.
    expect(mine.connectorName).not.toBe(theirs.connectorName);
    expect(mine.routineName).not.toBe(theirs.routineName);
    expect(mine.secretName).not.toBe(theirs.secretName);
    expect(airyn.identity.workerName).not.toBe(caleb.identity.workerName);

    // And everything that is not one of those is identical, which is the half
    // that makes the previous line safe rather than alarming.
    expect(neutral(airyn.headline, airyn)).toBe(neutral(caleb.headline, caleb));
    expect(airyn.state).toBe(caleb.state);
  });

  it('never offers one account a control the other does not have', async () => {
    const admin = await view(adminCookie);
    const airyn = await view(airynCookie);
    /*
     * A control an account may not use arrives **disabled with a reason**,
     * never absent. This is the whole parity mechanism in one assertion: the
     * shape is fixed and only `enabled` and `disabledReason` move.
     */
    for (const control of airyn.controls) {
      const counterpart = admin.controls.find((one) => one.key === control.key);
      expect(counterpart, `administrator has no ${control.key}`).toBeTruthy();
      if (!control.enabled) expect(control.disabledReason).toBeTruthy();
      if (control.enabled) expect(control.disabledReason).toBeNull();
    }
  });

  it('shows the same MCP URL to everybody, and it is the real one', async () => {
    const airyn = await view(airynCookie);
    const caleb = await view(calebCookie);
    const urlOf = (one: View): string | undefined =>
      one.steps
        .find((step) => step.key === 'CONNECTOR')
        ?.copy?.find((box) => box.label === 'MCP URL')?.value;
    // Not an example. The address this very request arrived on, so a person
    // pasting it into Claude reaches the Brain they are reading.
    expect(urlOf(airyn)).toBe(`${BASE}/mcp`);
    expect(urlOf(caleb)).toBe(urlOf(airyn));
  });
});

/* -------------------------------------------------------------------------- */

describe('who may reach it', () => {
  const memberRoutes: [string, string][] = [
    ['GET', '/api/people/me/claude'],
    ['POST', '/api/people/me/claude/invitation-request'],
    ['POST', '/api/people/me/claude/verify'],
    ['POST', '/api/people/me/claude/revoke'],
    ['POST', '/api/people/me/claude/reconnect'],
    ['POST', '/api/people/me/claude/trigger'],
    ['POST', '/api/people/me/claude/probe'],
  ];

  it('refuses an unauthenticated caller at every one of them', async () => {
    for (const [method, route] of memberRoutes) {
      const answer = await call(method, route, { body: method === 'POST' ? {} : undefined });
      expect([401, 403, 404], `${method} ${route} answered ${answer.status}`).toContain(
        answer.status,
      );
    }
  });

  it('sends the foundation matrix to an administrator and to nobody else', async () => {
    /*
     * It is a per-account judgement about *other people* — what each of them
     * is short of, and which remedies only an administrator holds. So it is
     * **absent** from an ordinary member's payload rather than emptied, which
     * is the only form of that distinction a forgotten `.filter()` in a client
     * cannot undo.
     */
    const asAdmin = await call<{ foundation?: { accounts: unknown[] } }>('GET', '/api/people', {
      cookie: adminCookie,
    });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body?.foundation?.accounts.length, 'an administrator got no matrix').toBeTruthy();

    for (const [who, cookie] of [
      ['Airyn', airynCookie],
      ['Caleb', calebCookie],
    ] as const) {
      const asMember = await call<Record<string, unknown>>('GET', '/api/people', { cookie });
      expect(asMember.status, `${who} could not read the page at all`).toBe(200);
      expect(
        Object.prototype.hasOwnProperty.call(asMember.body ?? {}, 'foundation'),
        `${who} was sent the foundation matrix`,
      ).toBe(false);
      // And no other account's state reached them under any other key.
      expect(JSON.stringify(asMember.body ?? {})).not.toContain('BLOCKED');
    }
  });

  it('refuses a worker principal by type, however well scoped it is', async () => {
    for (const [method, route] of memberRoutes) {
      const answer = await call(method, route, {
        bearer: workerBearer,
        body: method === 'POST' ? {} : undefined,
      });
      // §22: a machine that could mint itself a capacity surface is exactly
      // what the split forbids. No membership configuration changes this.
      expect([401, 403, 404], `${method} ${route} answered ${answer.status}`).toContain(
        answer.status,
      );
    }
  });

  it('keeps an ordinary member out of the administrator’s half', async () => {
    const list = await call('GET', '/api/people/connections', { cookie: airynCookie });
    expect(list.status).toBe(404);
    const issue = await call('POST', `/api/people/${calebId}/claude/invitation`, {
      cookie: airynCookie,
      body: {},
    });
    expect(issue.status).toBe(404);
    const revoke = await call('POST', `/api/people/${calebId}/claude/revoke`, {
      cookie: airynCookie,
      body: {},
    });
    expect(revoke.status).toBe(404);
  });

  it('resolves the subject from the principal, so there is no id to substitute', async () => {
    const airyn = await view(airynCookie);
    const caleb = await view(calebCookie);
    expect((airyn.connection as Record<string, string>).userId).toBe(airynId);
    expect((caleb.connection as Record<string, string>).userId).toBe(calebId);
  });
});

/* -------------------------------------------------------------------------- */

describe('the journey, over HTTP, as a member walks it', () => {
  it('asks for a link, is answered by an administrator, and says so on both sides', async () => {
    const asked = await call<View>('POST', '/api/people/me/claude/invitation-request', {
      cookie: airynCookie,
      body: {},
    });
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body.state).toBe('INVITATION_REQUESTED');
    expect(asked.body.steps[0]!.state).toBe('ADMINISTRATOR');

    /*
     * The other half of the answering transition. A member's request reaches an
     * administrator through this row and through no other channel — there is no
     * email in this Brain and no notification — so a list that did not carry it
     * would be an escalation nobody is ever asked about.
     */
    const list = await call<{ connections: { userId: string; invitationRequestedAt: string | null }[] }>(
      'GET',
      '/api/people/connections',
      { cookie: adminCookie },
    );
    expect(list.status).toBe(200);
    const mine = list.body.connections.find((one) => one.userId === airynId);
    expect(mine?.invitationRequestedAt).toBeTruthy();

    // There is no Cash frontier in this Brain, so the identity a link would be
    // minted against has nowhere to be a member of — and the refusal says that
    // rather than failing silently.
    const issued = await call<{ error?: string }>(
      'POST',
      `/api/people/${airynId}/claude/invitation`,
      { cookie: adminCookie, body: {} },
    );
    expect([200, 422]).toContain(issued.status);
    if (issued.status === 422) expect(issued.text).toMatch(/shared frontier/i);
  });

  it('verifies against rows, and says what is missing rather than failing generically', async () => {
    const verified = await call<View>('POST', '/api/people/me/claude/verify', {
      cookie: calebCookie,
      body: {},
    });
    expect(verified.status, verified.text).toBe(200);
    for (const check of verified.body.checks) {
      // Every answer that is not a pass carries something to do about it, or
      // is a *not yet* that genuinely has no remedy but time.
      expect(['PASS', 'FAIL', 'PENDING']).toContain(check.state);
      if (check.state === 'FAIL') expect(check.remedy).toBeTruthy();
    }
    // Verifying writes nothing anybody can see: pressing it twice is the same
    // answer, and it is available in every state.
    const again = await call<View>('POST', '/api/people/me/claude/verify', {
      cookie: calebCookie,
      body: {},
    });
    expect(again.body.state).toBe(verified.body.state);
  });

  it('refuses a credential pasted into the trigger field', async () => {
    const answer = await call('POST', '/api/people/me/claude/trigger', {
      cookie: calebCookie,
      body: { triggerRef: 'sk-ant-a-thing-that-looks-like-a-secret' },
    });
    expect(answer.status).toBe(422);
    expect(answer.text).toMatch(/never the credential/i);
  });

  it('carries no credential of any shape to any account', async () => {
    for (const cookie of [adminCookie, airynCookie, calebCookie]) {
      const answer = await call('GET', '/api/people/me/claude', { cookie });
      /*
       * Against the serialized payload rather than named fields, because a test
       * that checked `body.secret === undefined` would pass a payload that had
       * moved a value one key along.
       */
      expect(answer.text).not.toMatch(/"secret"\s*:/);
      expect(answer.text).not.toMatch(/tokenDigest/);
      expect(answer.text).not.toMatch(/brnw_/);
      expect(answer.text).not.toMatch(/sk-ant/);
    }
  });

  it('takes a connection back and gives it back, over the same two routes', async () => {
    const revoked = await call<View>('POST', '/api/people/me/claude/revoke', {
      cookie: calebCookie,
      body: { reason: 'Testing the way back.' },
    });
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body.state).toBe('REVOKED');
    expect(revoked.body.headline).toMatch(/Testing the way back/);

    // The controls swap, and the screen keeps its shape while they do.
    const controlOf = (one: View, key: string): Control =>
      one.controls.find((each) => each.key === key)!;
    expect(controlOf(revoked.body, 'RECONNECT').enabled).toBe(true);
    expect(controlOf(revoked.body, 'REVOKE').enabled).toBe(false);
    expect(controlOf(revoked.body, 'REVOKE').disabledReason).toBeTruthy();

    const back = await call<View>('POST', '/api/people/me/claude/reconnect', {
      cookie: calebCookie,
      body: {},
    });
    expect(back.status, back.text).toBe(200);
    expect(back.body.state).toBe('NOT_STARTED');
    expect(controlOf(back.body, 'RECONNECT').enabled).toBe(false);

    // And a reconnect on something nobody took back is refused with a sentence
    // rather than quietly doing nothing.
    const again = await call('POST', '/api/people/me/claude/reconnect', {
      cookie: calebCookie,
      body: {},
    });
    expect(again.status).toBe(422);
    expect(again.text).toMatch(/has not been taken back/i);
  });

  it('lets an administrator take somebody else’s back, for the case they cannot', async () => {
    const answer = await call<View>('POST', `/api/people/${calebId}/claude/revoke`, {
      cookie: adminCookie,
      body: { reason: 'Their device was lost.' },
    });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.state).toBe('REVOKED');

    // And it is *their* connection that moved, not the administrator's.
    expect((await view(adminCookie)).state).not.toBe('REVOKED');
    expect((await view(calebCookie)).state).toBe('REVOKED');

    // Put it back, so the shared fixtures below see an ordinary connection.
    await call('POST', '/api/people/me/claude/reconnect', { cookie: calebCookie, body: {} });
  });

  it('refuses an administrator a person who is not one', async () => {
    // A user id is not an oracle: a real machine identity and an invented id
    // are the same 404.
    const invented = await call('POST', '/api/people/usr_nothing/claude/revoke', {
      cookie: adminCookie,
      body: {},
    });
    expect(invented.status).toBe(404);
    expect(invented.text).toBe(
      (
        await call('POST', '/api/people/usr_alsonothing/claude/revoke', {
          cookie: adminCookie,
          body: {},
        })
      ).text,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('what the Software Factory is told', () => {
  it('reports contributed capacity to every account, and counts none of it usable', async () => {
    const page = await call<{
      contributed: { usable: number; total: number; surfaces: { usable: boolean; because: string | null }[] };
    }>('GET', '/api/people', { cookie: airynCookie });
    expect(page.status, page.text).toBe(200);

    /*
     * Nobody here has completed the four-row chain, so nothing is usable — and
     * every entry names *why*, which is the difference between a reading and a
     * bare count. Silently treating an unproven connection as capacity is the
     * failure this exists to make impossible.
     */
    expect(page.body.contributed.usable).toBe(0);
    for (const surface of page.body.contributed.surfaces) {
      expect(surface.usable).toBe(false);
      expect(surface.because).toBeTruthy();
    }
  });

  it('gives an ordinary member the same reading as an administrator', async () => {
    const asMember = await call<{ contributed: unknown }>('GET', '/api/people', {
      cookie: airynCookie,
    });
    const asAdmin = await call<{ contributed: unknown }>('GET', '/api/people', {
      cookie: adminCookie,
    });
    // Capacity somebody contributed is not a secret from the people
    // contributing it. What an administrator gets extra is diagnostics, which
    // is a different field.
    expect(asMember.body.contributed).toEqual(asAdmin.body.contributed);
  });
});
