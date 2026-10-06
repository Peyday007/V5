/**
 * What a Brain that could not boot answers while it asks again (`bootRetry.ts`).
 *
 * A restarting Brain is not a broken one, and a connector that meets it must be
 * told so in words it treats as temporary: deploys 319, 324 and 337 each served
 * every path a `500` page of text while the cloud proof was retried, and a token
 * endpoint answering that is one a client can read as a failed grant.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bootFailureApp } from '../server/bootFailure.ts';
import { DatabaseConfigurationError } from '../server/db/types.ts';

let server: http.Server | null = null;

async function serve(retrying: boolean): Promise<string> {
  const failure = new DatabaseConfigurationError('Brain could not reach the database.', 'It answered 544.');
  server = bootFailureApp(failure, { retrying, databasePath: '-', dataRoot: '-' }).listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe('a Brain retrying its boot', () => {
  it('answers the token endpoint temporarily_unavailable, never a grant failure', async () => {
    const base = await serve(true);
    const response = await fetch(`${base}/oauth/token`, { method: 'POST', body: 'grant_type=refresh_token' });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('temporarily_unavailable');
    expect(JSON.stringify(body)).not.toMatch(/invalid_grant|Not authorized/);
  });

  it('answers MCP as a retryable infrastructure condition', async () => {
    const base = await serve(true);
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer brnt_x.y' } });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { data: Record<string, unknown>; message: string } };
    expect(body.error.data).toMatchObject({ retryable: true, category: 'INFRA_RETRYABLE' });
    expect(body.error.message).toMatch(/not an authorization failure/);
  });

  it('answers the API and everything else 503 with Retry-After, the API saying it is retryable', async () => {
    const base = await serve(true);
    const api = await fetch(`${base}/api/auth/session`);
    expect(api.status).toBe(503);
    expect(api.headers.get('retry-after')).toBe('5');
    expect(((await api.json()) as Record<string, unknown>)['retryable']).toBe(true);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(503);
  });

  it('a failure that is not being retried still answers 500, without pretending to be temporary', async () => {
    const base = await serve(false);
    const response = await fetch(`${base}/oauth/token`, { method: 'POST' });
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
