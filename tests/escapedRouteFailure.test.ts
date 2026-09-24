import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Production, 2026-09-24 02:25:29Z: the pool timed out inside `POST
 * /oauth/token`, the rejection escaped a fire-and-forget async handler, and
 * the Brain exited with code 1. These pin both halves: that route answers a
 * throwing database with a 503 rather than an unhandled rejection, and no
 * route in the repository can start an async body nothing catches.
 */
vi.mock('../server/repos/oauth.ts', async (original) => ({
  ...(await original<typeof import('../server/repos/oauth.ts')>()),
  getClientByClientId: async () => {
    throw new Error('The database pool had no free connection within 10000ms');
  },
}));

const { oauthRouter } = await import('../server/routes/oauth.ts');
const { ESCAPED_FAILURE_BODY } = await import('../server/routes/escape.ts');

describe('an error escaping a route is that request failing, not the process', () => {
  let base = '';
  let close: () => Promise<void>;
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    escaped.push(reason);
  };

  beforeAll(async () => {
    process.on('unhandledRejection', onRejection);
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use('/oauth', oauthRouter());
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    process.off('unhandledRejection', onRejection);
    await close();
  });

  it('answers 503 and escapes nothing when the database throws inside /oauth/token', async () => {
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&client_id=cli_any&refresh_token=x',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(ESCAPED_FAILURE_BODY);
    await new Promise((resolve) => setImmediate(resolve));
    expect(escaped).toEqual([]);
  });
});

describe('no async route body starts without somewhere for its error to go', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  }
  const files = [...walk('server/routes'), ...walk('server/mcp')];

  it('reads the files it claims to', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never fires an async body with `void`, where a rejection has nowhere to go', () => {
    const offenders = files.filter((file) => /void \(async/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('and every async IIFE that does start is caught', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const opens = source.match(/^\s*\(async \([^)]*\)(?:: Promise<void>)? => \{\s*$/gm) ?? [];
      const caught = source.match(/\}\)\(\)\.catch\(answerEscapedFailure\(res, '[^']+'\)\);/g) ?? [];
      expect({ file, opens: opens.length }).toEqual({ file, opens: caught.length });
    }
  });

  it('and the process keeps serving if one slips past anyway', () => {
    const source = readFileSync('server/index.ts', 'utf8');
    expect(source).toMatch(/process\.on\('unhandledRejection'/);
  });
});
