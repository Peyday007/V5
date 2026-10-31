/**
 * Brain reads a public source for a research worker whose own sandbox cannot.
 *
 * The goal's own search abandoned 29 of 30 rounds on unreadable sources. What
 * is pinned here is what makes the remedy safe rather than merely useful:
 * nothing but a public address is ever fetched, every redirect is re-checked,
 * an unreadable page is said to be unreadable, and only a worker holding a live
 * lease on research may ask.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { claimWork, enqueueWork } from '../server/repos/workQueue.ts';
import { findTool } from '../server/mcp/tools.ts';
import type { Principal, ProjectMembership, WorkerScope } from '../server/domain/types.ts';
import {
  checkDestination,
  fetchForWorker,
  isPublicAddress,
  textOf,
  type HttpFetch,
  type Resolver,
} from '../server/services/sources/fetchForWorker.ts';

const publicResolver: Resolver = async () => ['93.184.216.34'];

function page(body: string, init: { status?: number; type?: string; location?: string } = {}): Response {
  const headers = new Headers({ 'content-type': init.type ?? 'text/html; charset=utf-8' });
  if (init.location) headers.set('location', init.location);
  return new Response(init.status && init.status >= 300 && init.status < 400 ? null : body, {
    status: init.status ?? 200,
    headers,
  });
}

describe('which addresses Brain will open', () => {
  it('refuses every private, loopback, link-local and reserved range', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('accepts ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('refuses a hostname that resolves to a private address, a bad scheme, a port and credentials', async () => {
    const internal: Resolver = async () => ['10.0.0.5'];
    expect(await checkDestination('https://intranet.example/', internal)).toMatchObject({ ok: false, reason: 'ADDRESS_NOT_PUBLIC' });
    expect(await checkDestination('file:///etc/passwd', publicResolver)).toMatchObject({ ok: false, reason: 'SCHEME_NOT_ALLOWED' });
    expect(await checkDestination('https://example.com:8080/', publicResolver)).toMatchObject({ ok: false, reason: 'PORT_NOT_ALLOWED' });
    expect(await checkDestination('https://a:b@example.com/', publicResolver)).toMatchObject({ ok: false, reason: 'CREDENTIALS_IN_URL' });
    expect(await checkDestination('http://169.254.169.254/latest/meta-data', publicResolver)).toMatchObject({ ok: false, reason: 'ADDRESS_NOT_PUBLIC' });
    // Any one private answer among several is enough to refuse.
    const mixed: Resolver = async () => ['93.184.216.34', '127.0.0.1'];
    expect(await checkDestination('https://rebind.example/', mixed)).toMatchObject({ ok: false, reason: 'ADDRESS_NOT_PUBLIC' });
  });

  it('refuses loopback and private IPv4 written inside an IPv6 literal, however it is spelled', async () => {
    // The URL parser rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1]; a check
    // that only knew the dotted spelling let it through to loopback.
    for (const raw of [
      'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
      'http://[::127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:a00:1]/', 'http://[2002:7f00:1::]/',
    ]) {
      expect(await checkDestination(raw, publicResolver), raw).toMatchObject({ ok: false, reason: 'ADDRESS_NOT_PUBLIC' });
    }
    for (const address of ['::ffff:7f00:1', '::ffff:c0a8:101', '::7f00:1', '2002:a00:1::1', 'fe80::1%eth0']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('::ffff:808:808')).toBe(true);
    expect(isPublicAddress('2002:5db8:d822::1')).toBe(true);
  });
});

describe('reading a page', () => {
  it('returns the readable text, the final URL and a hash', async () => {
    const fetch: HttpFetch = async () =>
      page('<html><head><style>x{}</style><script>evil()</script></head><body><h1>Rates</h1><p>Ad slot: $400 &amp; up</p></body></html>');
    const result = await fetchForWorker('https://example.com/rates', { resolve: publicResolver, fetch });
    expect(result.readable).toBe(true);
    if (!result.readable) return;
    expect(result.text).toContain('Ad slot: $400 & up');
    expect(result.text).not.toContain('evil');
    expect(result.finalUrl).toBe('https://example.com/rates');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.truncated).toBe(false);
  });

  it('re-checks a redirect, and refuses one that points inside', async () => {
    let calls = 0;
    const fetch: HttpFetch = async (url) => {
      calls += 1;
      if (url.startsWith('https://example.com/')) return page('', { status: 302, location: 'http://169.254.169.254/' });
      return page('should never be read');
    };
    const result = await fetchForWorker('https://example.com/go', { resolve: publicResolver, fetch });
    expect(result).toMatchObject({ readable: false, reason: 'ADDRESS_NOT_PUBLIC' });
    expect(calls).toBe(1);
  });

  it('follows a public redirect to the page', async () => {
    const fetch: HttpFetch = async (url) =>
      url.endsWith('/old') ? page('', { status: 301, location: '/new' }) : page('<p>moved here</p>');
    const result = await fetchForWorker('https://example.com/old', { resolve: publicResolver, fetch });
    expect(result).toMatchObject({ readable: true, finalUrl: 'https://example.com/new' });
  });

  it('says a page is unreadable rather than returning nothing', async () => {
    expect(await fetchForWorker('https://example.com/', { resolve: publicResolver, fetch: async () => page('no', { status: 403 }) }))
      .toMatchObject({ readable: false, reason: 'HTTP_ERROR', status: 403 });
    expect(await fetchForWorker('https://example.com/', { resolve: publicResolver, fetch: async () => page('%PDF', { type: 'application/pdf' }) }))
      .toMatchObject({ readable: false, reason: 'NOT_TEXT' });
    expect(await fetchForWorker('https://example.com/', { resolve: publicResolver, fetch: async () => page('<script>only()</script>') }))
      .toMatchObject({ readable: false, reason: 'EMPTY' });
    expect(await fetchForWorker('https://nowhere.example/', { resolve: async () => { throw new Error('ENOTFOUND'); } }))
      .toMatchObject({ readable: false, reason: 'DNS_FAILED' });
    expect(await fetchForWorker('https://example.com/', { resolve: publicResolver, fetch: async () => { throw new Error('connect ECONNRESET'); } }))
      .toMatchObject({ readable: false, reason: 'NETWORK_ERROR' });
  });

  it('reports truncation instead of hiding it', async () => {
    const long = 'word '.repeat(20_000);
    const result = await fetchForWorker('https://example.com/', { resolve: publicResolver, fetch: async () => page(long, { type: 'text/plain' }) });
    expect(result.readable && result.truncated).toBe(true);
    if (result.readable) expect(result.totalChars).toBeGreaterThan(result.text.length);
  });

  it('strips markup without inventing text', () => {
    expect(textOf('<p>a</p><p>b</p>', 'text/html')).toBe('a\n b');
  });
});

describe('the door: only a worker holding live research', () => {
  const SCOPES: WorkerScope[] = ['project:read', 'research:read', 'research:write', 'queue:claim'] as WorkerScope[];
  let projectId = '';
  let workerId = '';

  function principal(id: string): Principal {
    return {
      type: 'WORKER',
      id,
      handle: 'w',
      displayName: 'w',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: `cred_${id}`,
      authMethod: 'WORKER_BEARER',
      memberships: [
        {
          id: `mem_${id}`,
          projectId,
          principalType: 'WORKER',
          principalId: id,
          role: 'MEMBER',
          scopes: SCOPES,
          active: true,
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: new Date().toISOString(),
          revokedAt: null,
        } as ProjectMembership,
      ],
      requestId: 'req',
    } as Principal;
  }

  async function worker(): Promise<string> {
    const made = await createWorker({ name: `w-${Math.random().toString(36).slice(2, 8)}`, displayName: 'w', createdByType: 'SYSTEM', createdById: 'test' });
    await grantMembership({ projectId, principalType: 'WORKER', principalId: made.id, role: 'MEMBER', scopes: SCOPES, grantedByType: 'SYSTEM', grantedById: 'test' });
    return made.id;
  }

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    workerId = await worker();
  });

  const tool = findTool('brain_fetch_source')!;
  // An unresolvable hostname: the door is under test, not the network, and
  // DNS_FAILED proves the reader was reached without any outbound request.
  const url = 'https://brain-fetch-source-test.invalid/';

  it('is on the tool surface', () => {
    expect(tool).toBeTruthy();
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('reads for the worker that holds the lease, and refuses everybody else identically', async () => {
    const item = await enqueueWork({ projectId, workType: 'SYNTHETIC_ECHO', payload: { note: 'x' }, requiredScopes: ['research:read'] as WorkerScope[], createdByType: 'SYSTEM', createdById: 'test' });
    // Not yet claimed: nobody holds it.
    await expect(tool.run({ work_item_id: item.id, url }, { principal: principal(workerId), requestId: 'r' })).rejects.toThrow();

    const [claimed] = await claimWork({ workerId, scopes: [{ projectId, scopes: SCOPES }], workTypes: ['SYNTHETIC_ECHO'] });
    expect(claimed?.workItemId).toBe(item.id);
    const outcome = await tool.run({ work_item_id: item.id, url }, { principal: principal(workerId), requestId: 'r' });
    expect((outcome.value['source'] as any).reason).toBe('DNS_FAILED');

    const other = await worker();
    let refusal: unknown = null;
    try {
      await tool.run({ work_item_id: item.id, url }, { principal: principal(other), requestId: 'r' });
    } catch (error) {
      refusal = error;
    }
    let missing: unknown = null;
    try {
      await tool.run({ work_item_id: 'wki_does_not_exist', url }, { principal: principal(other), requestId: 'r' });
    } catch (error) {
      missing = error;
    }
    expect(refusal).toBeTruthy();
    expect(String((refusal as Error).message)).toBe(String((missing as Error).message));
  });
});
