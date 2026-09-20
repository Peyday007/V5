/**
 * The bound the hosted verification declares, and whether it applies.
 *
 * Both clients set `AbortSignal.timeout(15 * 60 * 1000)` and both reported, in
 * words, that they had waited fifteen minutes. Neither ever did. Measured on
 * this Node against a server that accepts the connection and never answers,
 * with a signal far longer than undici's own default:
 *
 *     AbortSignal.timeout(400_000)  ->  threw after 300.8s
 *                                       TypeError: fetch failed
 *                                       cause UND_ERR_HEADERS_TIMEOUT
 *
 * `headersTimeout` is a separate bound from the signal and it is the one that
 * fires. Deploy run 274 is that reading twice: `brain_submit_audit` gave up
 * 320s after the adversarial pass, `brain_submit_synthesis` 336s after the
 * claim before it, and both blamed a nine-hundred-second wait that never
 * happened.
 *
 * Nothing here re-measures the five-minute wall, because doing so costs five
 * minutes per assertion and the reading above is already recorded. What it
 * pins is everything about the replacement that a test can see in a second —
 * and, since the wall itself cannot be, that the two clients still go through
 * it rather than back to `fetch`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { boundedRequest } from '../scripts/boundedRequest.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

let server: Server | null = null;

afterEach(async () => {
  const running = server;
  server = null;
  if (running) await new Promise<void>((done) => running.close(() => done()));
});

/** A server this test controls entirely, so "never answers" means exactly that. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const made = createServer(handler);
  server = made;
  await new Promise<void>((ready) => made.listen(0, '127.0.0.1', ready));
  const address = made.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('a request with a bound this process applies', () => {
  it('reports the status, the body and the headers', async () => {
    const url = await serve((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-method', req.method ?? '');
      res.statusCode = 201;
      res.end(JSON.stringify({ seen: true }));
    });

    const reply = await boundedRequest(`${url}/thing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      timeoutMs: 30_000,
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toBe('{"seen":true}');
    expect(reply.headers['x-method']).toBe('POST');
  });

  /*
   * `verify-hosted.ts` reads one header out of this and it is `set-cookie`,
   * which Node hands back as an array. Joining rather than taking the first:
   * dropping one would be dropping a credential the gate then asserts about.
   */
  it('joins a header the server sent more than once', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('set-cookie', ['brain_session=abc; Path=/', 'other=1; Path=/']);
      res.end('ok');
    });
    const reply = await boundedRequest(url, { timeoutMs: 30_000 });
    expect(reply.headers['set-cookie']).toContain('brain_session=abc');
    expect(reply.headers['set-cookie']).toContain('other=1');
  });

  /*
   * The property the whole module exists for, at a scale a suite can afford:
   * a server that has sent nothing for well over any inactivity timer must
   * still be waited for, because a Brain working on a judge pass looks exactly
   * like this. `req.setTimeout` would have cut it off; the deadline does not.
   */
  it('waits through a silence longer than an inactivity timer would allow', async () => {
    const url = await serve((_req, res) => {
      setTimeout(() => res.end('eventually'), 1_500);
    });
    const started = Date.now();
    const reply = await boundedRequest(url, { timeoutMs: 30_000 });
    expect(reply.body).toBe('eventually');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  });

  it('gives up at its own bound, saying what it waited for', async () => {
    const url = await serve(() => {
      /* accept, never answer */
    });
    const started = Date.now();
    await expect(boundedRequest(url, { timeoutMs: 600 })).rejects.toThrow(
      /nothing answered within 1s/,
    );
    // The bound, not something underneath it.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not follow a redirect', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/from') {
        res.statusCode = 302;
        res.setHeader('location', '/to');
        res.end();
        return;
      }
      res.end('followed');
    });
    const reply = await boundedRequest(`${url}/from`, { timeoutMs: 30_000 });
    expect(reply.status).toBe(302);
    expect(reply.headers['location']).toBe('/to');
    expect(reply.body).not.toContain('followed');
  });

  it('names the failure when nothing is listening', async () => {
    // Port 1 on loopback: refused immediately rather than after a bound.
    await expect(boundedRequest('http://127.0.0.1:1/', { timeoutMs: 30_000 })).rejects.toThrow(
      /the connection failed after/,
    );
  });
});

/*
 * The half a behavioural test cannot reach.
 *
 * Whether `fetch` respects a fifteen-minute signal takes fifteen minutes to
 * ask, or five to answer wrongly, so what is pinned instead is that the two
 * clients whose requests actually hit the wall do not use it. A regression
 * here is a one-line edit back to `fetch`, and it would be invisible for
 * exactly as long as it takes somebody to deploy.
 */
describe('the hosted verification clients', () => {
  /*
   * Comments stripped before anything is asserted, and that is the point
   * rather than a convenience. Both files *describe* the signal that never
   * applied, at length, because a correction this repository records is worth
   * more than one it quietly deletes — so a test that banned the words would
   * be a test against its own history. It classifies instead of banning, the
   * way `operatorConsoleRemoved` does: what must not exist is the call.
   */
  function code(file: string): string {
    return readFileSync(`${REPO}${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
  }

  const sources = {
    'scripts/verify-hosted.ts': code('scripts/verify-hosted.ts'),
    'scripts/mcpModernClient.ts': code('scripts/mcpModernClient.ts'),
  };

  for (const [name, source] of Object.entries(sources)) {
    it(`${name} sends its long request through the bounded helper`, () => {
      expect(source).toContain("from './boundedRequest.ts'");
      expect(source).toContain('boundedRequest(');
    });

    it(`${name} does not reach for an AbortSignal that undici would pre-empt`, () => {
      expect(source).not.toContain('AbortSignal.timeout');
    });
  }
});
