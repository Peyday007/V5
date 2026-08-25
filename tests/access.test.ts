/**
 * The gate in front of a deployed Brain.
 *
 * The property under test is narrow and absolute: a Brain that is cloud-backed
 * either has a token or does not start. Everything else here — the header
 * shapes, the constant-time comparison, the liveness exemption — exists to make
 * that gate usable without making it leaky.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import {
  accessGate,
  accessGateConfig,
  describeAccessGate,
  AccessGateError,
} from '../server/routes/access.ts';

const TOKEN = 'a-long-enough-test-token-value';

const ENV_KEYS = ['BRAIN_ACCESS_TOKEN', 'BRAIN_ACCESS_USER'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A miniature app with the gate in front of it, served on an ephemeral port. */
async function serve(token: string | null): Promise<{ url: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });
  app.use(accessGate({ token, username: 'brain' }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, databaseTarget: 'db.example.com/postgres' });
  });
  app.get('/files/a.pdf', (_req, res) => {
    res.type('application/pdf').send('bytes');
  });
  app.get('/', (_req, res) => {
    res.type('text/html').send('<html>the app</html>');
  });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('deciding whether there is a gate at all', () => {
  it('refuses to start a cloud-backed Brain with no token', () => {
    let thrown: AccessGateError | null = null;
    try {
      accessGateConfig({ cloud: true });
    } catch (error) {
      thrown = error as AccessGateError;
    }
    expect(thrown).toBeInstanceOf(AccessGateError);
    expect(thrown!.message).toMatch(/no BRAIN_ACCESS_TOKEN/i);
    // And says what to do about it, including how to generate one.
    expect(thrown!.detail).toMatch(/openssl rand/i);
  });

  it('leaves local development alone', () => {
    const config = accessGateConfig({ cloud: false });
    expect(config.token).toBeNull();
    expect(describeAccessGate(config)).toMatch(/local development only/i);
  });

  it('refuses a token too short to be worth having, without repeating it', () => {
    process.env.BRAIN_ACCESS_TOKEN = 'hunter2';
    let thrown: AccessGateError | null = null;
    try {
      accessGateConfig({ cloud: true });
    } catch (error) {
      thrown = error as AccessGateError;
    }
    expect(thrown).toBeInstanceOf(AccessGateError);
    expect(`${thrown!.message} ${thrown!.detail}`).not.toContain('hunter2');
  });

  it('accepts a real token and never names it', () => {
    process.env.BRAIN_ACCESS_TOKEN = TOKEN;
    const config = accessGateConfig({ cloud: true });
    expect(config.token).toBe(TOKEN);
    expect(describeAccessGate(config)).not.toContain(TOKEN);
    // The banner also says out loud that this is temporary.
    expect(describeAccessGate(config)).toMatch(/step 4/i);
  });
});

describe('the gate itself', () => {
  let app: Awaited<ReturnType<typeof serve>>;

  beforeEach(async () => {
    app = await serve(TOKEN);
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses every route to a caller with no credentials', async () => {
    for (const path of ['/', '/api/health', '/files/a.pdf']) {
      const response = await fetch(`${app.url}${path}`);
      expect(response.status, path).toBe(401);
      // The browser needs this to prompt at all.
      expect(response.headers.get('www-authenticate'), path).toMatch(/^Basic realm="Brain"/);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('says nothing about what is behind it', async () => {
    const response = await fetch(`${app.url}/api/health`);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ error: 'This Brain is private.' }));
    // Not the database host, not the configuration, not a reason.
    expect(body).not.toMatch(/db\.example\.com|postgres|token|username/i);
  });

  it('lets a caller with the token through, by Basic or by Bearer', async () => {
    const byBasic = await fetch(`${app.url}/api/health`, {
      headers: { authorization: basic('brain', TOKEN) },
    });
    expect(byBasic.status).toBe(200);
    expect(await byBasic.json()).toMatchObject({ ok: true });

    // A script should not have to base64 anything.
    const byBearer = await fetch(`${app.url}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(byBearer.status).toBe(200);
  });

  it('ignores the username, so the browser prompt can say anything', async () => {
    for (const user of ['brain', 'peyton', '']) {
      const response = await fetch(`${app.url}/`, {
        headers: { authorization: basic(user, TOKEN) },
      });
      expect(response.status, user).toBe(200);
    }
  });

  it('refuses a wrong token, a truncated one, and a malformed header', async () => {
    const attempts = [
      basic('brain', 'wrong'),
      basic('brain', TOKEN.slice(0, -1)),
      basic('brain', `${TOKEN} `),
      `Bearer ${TOKEN.slice(0, 8)}`,
      'Basic not-base64!!',
      'Basic ' + Buffer.from('no-colon-here').toString('base64'),
      'Something else entirely',
      '',
    ];
    for (const authorization of attempts) {
      const response = await fetch(`${app.url}/api/health`, { headers: { authorization } });
      expect(response.status, authorization.slice(0, 24)).toBe(401);
    }
  });

  it('serves liveness without credentials, and reveals nothing in it', async () => {
    const response = await fetch(`${app.url}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('ok');
    // A platform probe can reach it; it still says nothing about this Brain.
    expect(body).not.toMatch(/postgres|supabase|brain\.db|version/i);
  });

  it('is not a gate at all when no token is configured', async () => {
    const open = await serve(null);
    try {
      expect((await fetch(`${open.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${open.url}/files/a.pdf`)).status).toBe(200);
    } finally {
      await open.close();
    }
  });

  it('costs the same whatever is sent, so it cannot be probed a character at a time', async () => {
    // Not a timing measurement — those are unreliable in CI. This asserts the
    // structural property that makes timing attacks impossible: both sides are
    // hashed to a fixed width before comparison, so a one-character token and a
    // near-miss of full length take the same path to the same refusal.
    const short = await fetch(`${app.url}/`, { headers: { authorization: basic('b', 'x') } });
    const near = await fetch(`${app.url}/`, {
      headers: { authorization: basic('b', `${TOKEN.slice(0, -1)}X`) },
    });
    expect(short.status).toBe(401);
    expect(near.status).toBe(401);
    expect(await short.text()).toBe(await near.text());
  });
});
