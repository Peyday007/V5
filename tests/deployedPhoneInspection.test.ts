/**
 * The read-only deployed phone inspection, driven through a real browser
 * against a real Brain.
 *
 * ---------------------------------------------------------------------------
 * Why this suite exists rather than more source-pattern assertions
 * ---------------------------------------------------------------------------
 *
 * The first version of `--deployed` was covered by tests that read its source
 * and checked which strings were in it. Every one of them passed while the mode
 * was wrong in six independent ways — a role that does not exist, a cookie on
 * the wrong host, two routes the router answers `NOT_FOUND` for, an acceptance
 * of `FAILED` as answered, a screen check satisfied by any text at all, and a
 * "chain" made of two unrelated rows. **A test that reads the code cannot find
 * a mistake about the product**, and the owner found all six by reading.
 *
 * So this boots a Brain, seeds the exact shape the mode is meant to recognise,
 * drives the real thing through Chromium, and asserts the record it writes. The
 * negative cases matter more than the positive one: a mode that passes on a
 * login screen, a pending answer or somebody else's conclusion is worse than no
 * mode, because it produces evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './helpers/ports.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(6800, 100);
const BASE = `http://127.0.0.1:${PORT}`;

const EMAIL = 'phone-inspection@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const PASSWORD = 'phone-inspection-pass-1';

/** What the seeded answer says, so the screen check has something exact to find. */
const ANSWER = 'The register of deeds confirmed the fee is nineteen dollars per instrument.';
const CONCLUSION = 'Washtenaw County charges $19 for the first page of a recorded instrument.';

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let log = '';
let cookie = '';
let projectId = '';
let outDir = '';

async function call<T = Record<string, unknown>>(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['origin'] = BASE;
  }
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a string body is a fine answer here */
  }
  return { status: response.status, body: parsed as T };
}

/**
 * Seeding goes through the repositories in the server's own process, because
 * the shape being seeded is one no route creates: a *worker's* answer and a
 * mission's writeback. Nothing here is what the mode under test does — the mode
 * only reads.
 */
async function seed(script: string): Promise<string> {
  const file = path.join(dataDir, `seed-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    file,
    `process.env.BRAIN_DATA_DIR = ${JSON.stringify(dataDir)};\n` +
      `process.env.BRAIN_DB_PATH = ${JSON.stringify(path.join(dataDir, 'brain.db'))};\n` +
      `const { initDatabase, closeDatabase } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/db/database.ts'))});\n` +
      'await initDatabase();\n' +
      `${script}\n` +
      'await closeDatabase();\n',
  );
  /*
   * `BRAIN_DB_PATH` is stripped from the child's environment as well as set in
   * the script, because `tests/setup.ts` exports one for the *suite's* own
   * scratch database — and a seed that inherited it would write into that
   * instead of into the Brain this suite booted. The symptom was
   * `listUsers()` returning nothing on a Brain that plainly had an
   * administrator: the seed was looking at a different, empty database.
   */
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), file],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, BRAIN_DB_PATH: path.join(dataDir, 'brain.db'), BRAIN_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`seed failed (${code}):\n${err}`)),
    );
  });
}

/** Run the mode under test and read back what it wrote. */
async function inspect(
  extra: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number; output: string; record: Record<string, unknown> | null }> {
  const emit = path.join(dataDir, `phone-${Math.random().toString(36).slice(2)}.json`);
  const shots = path.join(dataDir, 'shots');
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(REPO_ROOT, 'scripts', 'visual-qa.ts'),
        shots,
        `--deployed=${BASE}`,
        `--emit-phone=${emit}`,
        ...extra,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, BRAIN_PHONE_SESSION: cookie, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => {
      let record: Record<string, unknown> | null = null;
      try {
        record = JSON.parse(fs.readFileSync(emit, 'utf8')) as Record<string, unknown>;
      } catch {
        record = null;
      }
      resolve({ code: code ?? -1, output, record });
    });
  });
}

async function countRows(): Promise<Record<string, number>> {
  const raw = await seed(`
    const { getDb } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/db/database.ts'))});
    const tables = ['russell_messages', 'russell_missions', 'russell_knowledge',
                    'russell_candidates', 'russell_goals', 'bins'];
    const counts = {};
    for (const table of tables) {
      const row = await getDb().get('SELECT COUNT(*) AS n FROM ' + table);
      counts[table] = Number(row.n);
    }
    console.log(JSON.stringify(counts));
  `);
  return JSON.parse(raw.split('\n').pop() ?? '{}') as Record<string, number>;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-phone-inspect-'));
  outDir = path.join(dataDir, 'shots');
  // The client bundle has to exist, because the mode reads the rendered page.
  await new Promise<void>((resolve, reject) => {
    const build = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    build.stdout.on('data', (c: Buffer) => (out += c.toString()));
    build.stderr.on('data', (c: Buffer) => (out += c.toString()));
    build.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`build failed:\n${out}`))));
  });

  server = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRAIN_DB_PATH: undefined,
        BRAIN_DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'production',
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  server.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`the server never became healthy:\n${log}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const first = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: BOOTSTRAP }),
  });
  cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  await call('POST', '/api/auth/password', { currentPassword: BOOTSTRAP, newPassword: PASSWORD });
  const again = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = (again.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const projects = await call<{ projects: { id: string }[] }>('GET', '/api/projects');
  projectId = projects.body.projects[0]?.id ?? '';
  expect(projectId).not.toBe('');
}, 300_000);

afterAll(() => {
  try {
    if (server?.pid) process.kill(-server.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
});

describe('the deployed phone inspection, driven for real', () => {
  it('refuses an origin that is neither https nor loopback', async () => {
    const run = await inspect([]);
    // Sanity: the harness itself accepts the loopback origin this suite uses.
    expect(run.output).not.toContain('--deployed must be an https origin');
  }, 300_000);

  it('finds nothing, and says so, on a Brain with no answered question', async () => {
    const run = await inspect();
    expect(run.record).not.toBeNull();
    const answered = run.record!['answeredQuestion'] as Record<string, unknown>;
    const result = run.record!['missionLinkedResult'] as Record<string, unknown>;
    expect(answered['found']).toBe(false);
    expect(result['found']).toBe(false);
    // A fact about the Brain, never a defect in the product.
    expect((run.record!['findings'] as string[]).join(' ')).toContain('fact about the Brain');
  }, 300_000);

  it('does not accept a question whose answer is still PENDING', async () => {
    await seed(`
      const { listProjects } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/projects.ts'))});
      const { listUsers } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/identity.ts'))});
      const { createConversation, addMessage } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/russellConversations.ts'))});
      const project = (await listProjects())[0];
      const person = (await listUsers())[0];
      const thread = await createConversation({
        ownerUserId: person.id, title: 'Still waiting', visibility: 'SHARED', projectId: project.id,
      });
      await addMessage({ conversationId: thread.id, role: 'USER', content: 'How much does recording cost?', authorUserId: person.id });
      await addMessage({ conversationId: thread.id, role: 'RUSSELL', content: '', status: 'PENDING', pendingReason: 'A worker has not taken this yet.' });
      console.log(thread.id);
    `);
    const run = await inspect();
    expect((run.record!['answeredQuestion'] as Record<string, unknown>)['found']).toBe(false);
  }, 300_000);

  it('does not accept an answer in one thread and a conclusion from another', async () => {
    await seed(`
      const { listProjects } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/projects.ts'))});
      const { listUsers } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/identity.ts'))});
      const { createConversation, addMessage } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/russellConversations.ts'))});
      const { launchMission, recordKnowledge } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/russellMissions.ts'))});
      const project = (await listProjects())[0];
      const person = (await listUsers())[0];

      // A thread with a real, completed answer — and no mission of its own.
      const answeredThread = await createConversation({
        ownerUserId: person.id, title: 'Answered, unlinked', visibility: 'SHARED', projectId: project.id,
      });
      await addMessage({ conversationId: answeredThread.id, role: 'USER', content: 'What is the fee?', authorUserId: person.id });
      await addMessage({ conversationId: answeredThread.id, role: 'RUSSELL', content: ${JSON.stringify(ANSWER)}, status: 'COMPLETE' });

      // A conclusion that belongs to an entirely different conversation.
      const other = await createConversation({
        ownerUserId: person.id, title: 'Somewhere else', visibility: 'SHARED', projectId: project.id,
      });
      const mission = await launchMission({
        projectId: project.id, visibility: 'SHARED', objective: 'Something else',
        whyNow: 'unrelated', idempotencyKey: 'phone-test-unrelated', conversationId: other.id,
      });
      await recordKnowledge({
        projectId: project.id, visibility: 'SHARED', kind: 'CONCLUSION',
        statement: ${JSON.stringify(CONCLUSION)}, provenance: { documentId: 'doc_x', auditId: 'aud_x' },
        authorType: 'RUSSELL', confidence: 'ESTABLISHED', missionId: mission.mission.id,
      });
      console.log('seeded');
    `);
    const run = await inspect();
    const answered = run.record!['answeredQuestion'] as Record<string, unknown>;
    const result = run.record!['missionLinkedResult'] as Record<string, unknown>;
    // The answered thread has no mission; the conclusion's mission belongs to
    // another thread. Neither half may be reported on the strength of the other.
    expect(answered['found']).toBe(false);
    expect(result['found']).toBe(false);
  }, 300_000);

  it('reads the chain, on screen, when a conversation really produced a conclusion', async () => {
    const conversationId = await seed(`
      const { listProjects } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/projects.ts'))});
      const { listUsers } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/identity.ts'))});
      const { createConversation, addMessage } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/russellConversations.ts'))});
      const { launchMission, recordKnowledge } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/repos/russellMissions.ts'))});
      const project = (await listProjects())[0];
      const person = (await listUsers())[0];
      const thread = await createConversation({
        ownerUserId: person.id, title: 'The recording fee', visibility: 'SHARED', projectId: project.id,
      });
      await addMessage({ conversationId: thread.id, role: 'USER', content: 'What does Washtenaw charge to record a deed?', authorUserId: person.id });
      await addMessage({ conversationId: thread.id, role: 'RUSSELL', content: ${JSON.stringify(ANSWER)}, status: 'COMPLETE' });
      const mission = await launchMission({
        projectId: project.id, visibility: 'SHARED', objective: 'Establish the recording fee',
        whyNow: 'a person asked', idempotencyKey: 'phone-test-linked', conversationId: thread.id,
      });
      await recordKnowledge({
        projectId: project.id, visibility: 'SHARED', kind: 'CONCLUSION',
        statement: ${JSON.stringify(CONCLUSION)}, provenance: { documentId: 'doc_real', auditId: 'aud_real' },
        authorType: 'RUSSELL', confidence: 'ESTABLISHED', missionId: mission.mission.id, conversationId: thread.id,
      });
      console.log(thread.id);
    `);

    const run = await inspect();
    const record = run.record!;
    const answered = record['answeredQuestion'] as Record<string, unknown>;
    const result = record['missionLinkedResult'] as Record<string, unknown>;

    expect(answered['found']).toBe(true);
    expect(answered['status']).toBe('COMPLETE');
    expect(answered['conversationId']).toBe(conversationId.split('\n').pop());
    // The screen, not the row: READY rather than signed-out, loading or errored,
    // and carrying this answer's own words.
    expect(answered['screenSaw']).toMatch(/^READY:/);
    expect(answered['readOnScreen']).toBe(true);

    expect(result['found']).toBe(true);
    expect(result['missionFromConversation']).toBe(true);
    expect(result['citesDocument']).toBe(true);
    expect(result['citesAudit']).toBe(true);
    expect(result['screenSaw']).toMatch(/^READY:/);
    expect(result['readOnScreen']).toBe(true);

    expect(record['findings']).toEqual([]);
    expect(fs.existsSync(path.join(outDir, 'deployed-01-the-answer.png'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'deployed-02-the-result.png'))).toBe(true);
  }, 300_000);

  it('reports a login screen as a login screen rather than passing on it', async () => {
    const run = await inspect([], { BRAIN_PHONE_SESSION: 'brain_session=not-a-real-session' });
    // With no valid session nothing can be resolved from the API either, so the
    // honest outcome is "no chain" — never a pass, and never a crash.
    expect(run.record).not.toBeNull();
    expect((run.record!['answeredQuestion'] as Record<string, unknown>)['found']).toBe(false);
  }, 300_000);

  it('binds the reading to a revision, and says when it cannot', async () => {
    const run = await inspect(['--expect-revision=' + 'f'.repeat(40)]);
    const record = run.record!;
    // This Brain is a local run with no build stamp, so it reports none — and
    // the record says so rather than filling one in.
    expect(record['deployedRevision']).toBeNull();
    expect(record['expectedRevision']).toBe('f'.repeat(40));
    expect(record['revisionMatches']).toBeNull();
    expect((record['findings'] as string[]).join(' ')).toContain('did not report a revision');
  }, 300_000);

  it('changes nothing it read', async () => {
    const before = await countRows();
    await inspect();
    const after = await countRows();
    expect(after).toEqual(before);
  }, 300_000);
});
