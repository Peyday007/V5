/**
 * A Brain whose cloud dependency is briefly slow at boot becomes healthy by
 * itself, and one whose dependency is misconfigured still says so.
 *
 * Deploy #319 (2026-09-23): the new image's one bucket probe got Supabase's
 * `HTTP 544 DatabaseTimeout`, boot handed that answer to the error server, and
 * `/healthz` answered 500 for the life of the process — so the machine reached
 * `started`, Fly's health check never passed, and `flyctl deploy` timed out.
 *
 * The last block here reproduces that boot against a real `server/index.ts`
 * and a fake store that answers 544 twice before it answers properly. Against
 * the defect it never becomes healthy; with the fix it does, without a restart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isTransientBootFailure, untilAvailable } from '../server/bootWait.ts';
import { isTransientConnectionFailure } from '../server/db/database.ts';
import { DatabaseConfigurationError } from '../server/db/types.ts';
import { SupabaseStorageProvider, isTransientStatus } from '../server/services/storage/supabase.ts';
import { StorageConfigurationError } from '../server/services/storage/types.ts';
import { pickPort } from './helpers/ports.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(8000, 100);

function storeAnswering(status: number, body = ''): SupabaseStorageProvider {
  return new SupabaseStorageProvider({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-key-never-shown',
    bucket: 'brain-documents',
    fetchImpl: (async () => new Response(body, { status })) as typeof fetch,
  });
}

describe('which failures are worth waiting for', () => {
  it('reads every 5xx — Supabase’s 544 included — and 408/429 as transient', () => {
    for (const status of [500, 502, 503, 504, 544, 408, 429]) expect(isTransientStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409]) expect(isTransientStatus(status)).toBe(false);
  });

  it('marks the production 544 transient, and a missing bucket or a bad key not', async () => {
    const timeout = await storeAnswering(
      544,
      '{"statusCode":"544","error":"DatabaseTimeout","message":"The connection to the database timed out"}',
    )
      .verify()
      .catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(StorageConfigurationError);
    expect(isTransientBootFailure(timeout)).toBe(true);

    for (const status of [400, 401, 403, 404]) {
      const refused = await storeAnswering(status).verify().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(StorageConfigurationError);
      expect(isTransientBootFailure(refused), `HTTP ${status}`).toBe(false);
    }
  });

  it('marks a store that could not be reached at all transient', async () => {
    const store = new SupabaseStorageProvider({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'k',
      bucket: 'b',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const error = await store.verify().catch((e: unknown) => e);
    expect(isTransientBootFailure(error)).toBe(true);
  });

  it('waits on a database that timed out, and never on one that is configured wrongly', () => {
    for (const reason of [
      'timeout exceeded when trying to connect',
      'Connection terminated due to connection timeout',
      'read ECONNRESET',
      '(EMAXCONNSESSION) max clients reached in session mode',
      'the database system is starting up',
      'connect ETIMEDOUT 1.2.3.4:5432',
    ]) {
      expect(isTransientConnectionFailure(reason), reason).toBe(true);
    }
    for (const reason of [
      'password authentication failed for user "postgres"',
      'getaddrinfo ENOTFOUND db.example.supabase.co',
      'connect ECONNREFUSED 127.0.0.1:5432',
      'The server does not support SSL connections',
      'self-signed certificate in certificate chain',
      'database "brain" does not exist',
    ]) {
      expect(isTransientConnectionFailure(reason), reason).toBe(false);
    }
  });
});

describe('waiting', () => {
  it('asks again after a transient failure and returns what the dependency finally answered', async () => {
    let calls = 0;
    const slept: number[] = [];
    const lines: string[] = [];
    const value = await untilAvailable(
      'The document store',
      async () => {
        calls += 1;
        if (calls < 4) throw new StorageConfigurationError('HTTP 544', '', { transient: true });
        return 'ready';
      },
      { sleep: async (ms) => void slept.push(ms), log: (l) => lines.push(l), delaysMs: [1, 2, 5] },
    );
    expect(value).toBe('ready');
    expect(calls).toBe(4);
    expect(slept).toEqual([1, 2, 5]);
    expect(lines.at(-1)).toMatch(/answered after 3 failed attempt/);
    expect(lines[0]).toMatch(/not falling back/);
  });

  it('rethrows a configuration failure on the first attempt, unchanged', async () => {
    const wrong = new DatabaseConfigurationError('password authentication failed');
    let calls = 0;
    const error = await untilAvailable('The database', async () => {
      calls += 1;
      throw wrong;
    }).catch((e: unknown) => e);
    expect(error).toBe(wrong);
    expect(calls).toBe(1);
  });

  it('rethrows anything that is not a configuration error at all — a migration failure is not waited on', async () => {
    const edited = new Error('checksum mismatch');
    const error = await untilAvailable('The database', async () => {
      throw edited;
    }).catch((e: unknown) => e);
    expect(error).toBe(edited);
  });
});

describe('a boot whose store answers 544 first (Deploy #319)', () => {
  let brain: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let store: http.Server | null = null;

  afterEach(async () => {
    brain?.kill('SIGKILL');
    brain = null;
    await new Promise<void>((resolve) => (store ? store.close(() => resolve()) : resolve()));
    store = null;
  });

  it('becomes healthy by itself once the store answers, without a restart', async () => {
    let probes = 0;
    store = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/storage/v1/object/list/')) {
        probes += 1;
        if (probes <= 2) {
          res.writeHead(544, { 'Content-Type': 'application/json' });
          res.end(
            '{"statusCode":"544","error":"DatabaseTimeout","message":"The connection to the database timed out","code":"DatabaseTimeout"}',
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"statusCode":"404","error":"not_found"}');
    });
    await new Promise<void>((resolve) => store!.listen(0, '127.0.0.1', () => resolve()));
    const storePort = (store.address() as { port: number }).port;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-boot-wait-'));
    let log = '';
    brain = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BRAIN_DB_PATH: undefined,
          BRAIN_DATA_DIR: dataDir,
          PORT: String(PORT),
          NODE_ENV: 'test',
          BRAIN_STORAGE_PROVIDER: 'supabase',
          SUPABASE_URL: `http://127.0.0.1:${storePort}`,
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-never-shown',
          BRAIN_STORAGE_BUCKET: 'brain-documents',
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          BRAIN_PROVIDER: undefined,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    brain.stdout.on('data', (c: Buffer) => (log += c.toString()));
    brain.stderr.on('data', (c: Buffer) => (log += c.toString()));

    // 2s + 4s of backoff, plus a boot. The defect answers 500 here for ever.
    const deadline = Date.now() + 60_000;
    let last = 0;
    for (;;) {
      try {
        last = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).status;
        if (last === 200) break;
      } catch {
        /* not listening while it waits — which is the honest answer */
      }
      if (Date.now() > deadline) throw new Error(`never healthy (last ${last}):\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(probes).toBe(3);
    expect(log).toMatch(/The document store did not answer \(attempt 1\)/);
    expect(log).toMatch(/The document store answered after 2 failed attempt\(s\)/);
    expect(log).not.toMatch(/Serving the migration error/);
    // The key never reaches the log, retries included.
    expect(log).not.toContain('service-role-key-never-shown');
  }, 90_000);
});
