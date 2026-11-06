/**
 * The document store's fetch keeps and bounds its connections.
 *
 * Production 2026-11-06: 246 new TLS sockets a minute to the storage host,
 * because built-in fetch opens one connection per parallel request and closes
 * them after four idle seconds. Pinned against a real HTTP server: a burst of
 * forty requests, then another after a pause, is carried on at most eight
 * connections in all, and bodies, statuses and headers come back intact.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_MAX_SOCKETS, keepAliveFetch } from '../server/services/storage/keepAliveFetch.ts';

let server: Server;
let base = '';
let connections = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not here');
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.method ?? '' });
        res.end(JSON.stringify({ got: body }));
      }, 5);
    });
  });
  server.on('connection', () => (connections += 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('keepAliveFetch', () => {
  it('carries bursts on a bounded set of kept connections', async () => {
    const burst = () =>
      Promise.all(
        [...Array(40)].map(async (_, i) => {
          const r = await keepAliveFetch(`${base}/list`, { method: 'POST', body: JSON.stringify({ i }), headers: { 'content-type': 'application/json' } });
          return ((await r.json()) as { got: string }).got;
        }),
      );
    const first = await burst();
    expect(first[7]).toBe(JSON.stringify({ i: 7 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await burst();
    expect(connections).toBeLessThanOrEqual(STORE_MAX_SOCKETS);
  });

  it('returns status, headers and byte bodies like fetch', async () => {
    const ok = await keepAliveFetch(`${base}/obj`, { method: 'PUT', body: new Uint8Array([104, 105]) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-echo')).toBe('PUT');
    expect(await ok.json()).toEqual({ got: 'hi' });
    const missing = await keepAliveFetch(`${base}/missing`);
    expect(missing.ok).toBe(false);
    expect(await missing.text()).toBe('not here');
  });

  it('rejects when the signal times out', async () => {
    await expect(keepAliveFetch(`${base}/list`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1) })).rejects.toBeTruthy();
  });
});
