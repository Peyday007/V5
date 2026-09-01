/**
 * The document store, both implementations (section: cloud persistence).
 *
 * The local provider is exercised against a real temporary directory and the
 * cloud provider against an injected `fetch` that records what was sent. That
 * distinction is deliberate and is repeated in the report: these tests prove
 * the provider speaks Supabase's protocol correctly, and they prove nothing
 * whatever about a live Supabase project. Only a run against a real bucket can
 * do that.
 *
 * What they do prove is the part that is Brain's own responsibility: that a key
 * is an address Brain controls, that bytes survive a round trip unchanged, that
 * nothing overwrites silently, and that a credential never appears in anything
 * a caller can see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalStorageProvider } from '../server/services/storage/local.ts';
import { SupabaseStorageProvider } from '../server/services/storage/supabase.ts';
import {
  ObjectNotFoundError,
  StorageConfigurationError,
} from '../server/services/storage/types.ts';
import {
  assertSafeKey,
  documentKey,
  derivedKey,
  researchKey,
  safeSegment,
} from '../server/services/storage/keys.ts';
import { initStorage, resetStorage, getStorage } from '../server/services/storage/index.ts';

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-storage-'));
});
afterEach(() => {
  resetStorage();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe('an object key is an address Brain controls', () => {
  it('reduces a caller-supplied filename to a leaf, keeping only its name', () => {
    expect(safeSegment('../../brain.db')).toBe('brain.db');
    expect(safeSegment('/etc/passwd')).toBe('passwd');
    expect(safeSegment('C:\\Windows\\system32\\cmd.exe')).toBe('cmd.exe');
    // A name that sanitises away entirely still becomes a usable leaf rather
    // than an empty segment: the store must always get something addressable.
    for (const nothing of ['..', '', '.', '...']) {
      const segment = safeSegment(nothing);
      expect(segment.length, nothing).toBeGreaterThan(0);
      expect(segment, nothing).not.toContain('/');
      expect(segment.startsWith('.'), nothing).toBe(false);
    }
  });

  it('builds document keys from identifiers, so a rename moves nothing', () => {
    const key = documentKey({
      projectId: 'prj_1',
      documentId: 'doc_1',
      filename: 'World Model v1.pdf',
    });
    expect(key).toBe('projects/prj_1/documents/doc_1/original/World Model v1.pdf');
    // The same document with a traversal attempt for a filename lands in the
    // same place, under a name that is only ever a leaf.
    expect(
      documentKey({ projectId: 'prj_1', documentId: 'doc_1', filename: '../../../brain.db' }),
    ).toBe('projects/prj_1/documents/doc_1/original/brain.db');
  });

  it('separates originals, derived artifacts and research output', () => {
    expect(derivedKey({ projectId: 'p', documentId: 'd', artifact: 'text.txt' })).toContain(
      '/derived/',
    );
    expect(researchKey({ projectId: 'p', orchestrationId: 'o', artifact: 'report.md' })).toContain(
      '/research/',
    );
  });

  it('refuses a stored key that could name something outside the store', () => {
    for (const bad of [
      '',
      '/etc/passwd',
      'C:/Windows/system32',
      'projects/../../brain.db',
      'projects//documents/x.pdf',
      'projects/a\u0000b/x.pdf',
    ]) {
      expect(() => assertSafeKey(bad), bad).toThrow();
    }
  });

  it('accepts the keys Brain itself writes', () => {
    expect(assertSafeKey('projects/deal-dispatch/documents/world-model/World Model v1.pdf')).toBe(
      'projects/deal-dispatch/documents/world-model/World Model v1.pdf',
    );
    // A Windows separator names the same object and is normalised.
    expect(assertSafeKey('projects\\a\\b.pdf')).toBe('projects/a/b.pdf');
  });

  it('refuses an absolute key instead of quietly making it relative', () => {
    // The refusal is the point: silently turning "/etc/passwd" into
    // "etc/passwd" inside the store would be a key nobody asked for.
    expect(() => assertSafeKey('/projects/a/b.pdf')).toThrow(/absolute/i);
  });
});

// ---------------------------------------------------------------------------
// Local provider
// ---------------------------------------------------------------------------

describe('the local store', () => {
  it('round-trips bytes unchanged, and reports the checksum it computed', async () => {
    const store = new LocalStorageProvider(root);
    const body = crypto.randomBytes(4096);
    const meta = await store.put({ key: 'projects/p/documents/l/a.pdf', body });

    expect(meta.checksum).toBe(sha256(body));
    expect(meta.size).toBe(body.byteLength);
    expect(await store.get('projects/p/documents/l/a.pdf')).toEqual(body);
  });

  it('keeps the original filename as metadata rather than as the key', async () => {
    const store = new LocalStorageProvider(root);
    await store.put({
      key: 'projects/p/documents/d/original/report.pdf',
      body: Buffer.from('x'),
      originalFilename: 'Q3 findings (final) v2.pdf',
      contentType: 'application/pdf',
    });
    const head = await store.head('projects/p/documents/d/original/report.pdf');
    expect(head?.originalFilename).toBe('Q3 findings (final) v2.pdf');
    expect(head?.contentType).toBe('application/pdf');
  });

  it('refuses to overwrite unless asked, because a superseded document keeps its bytes', async () => {
    const store = new LocalStorageProvider(root);
    const key = 'projects/p/documents/l/a.pdf';
    await store.put({ key, body: Buffer.from('first') });

    await expect(store.put({ key, body: Buffer.from('second') })).rejects.toThrow(/already exists/i);
    expect((await store.get(key)).toString()).toBe('first');

    await store.put({ key, body: Buffer.from('second'), overwrite: true });
    expect((await store.get(key)).toString()).toBe('second');
  });

  it('cannot be made to read or write outside its root', async () => {
    const store = new LocalStorageProvider(root);
    const outside = path.join(root, '..', 'escaped.txt');
    for (const key of ['../escaped.txt', '/etc/passwd', 'a/../../escaped.txt']) {
      await expect(store.put({ key, body: Buffer.from('x') }), key).rejects.toThrow();
      await expect(store.get(key), key).rejects.toThrow();
    }
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('says an object is missing rather than inventing an empty one', async () => {
    const store = new LocalStorageProvider(root);
    await expect(store.get('projects/p/documents/l/nothing.pdf')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(await store.exists('projects/p/documents/l/nothing.pdf')).toBe(false);
    expect(await store.head('projects/p/documents/l/nothing.pdf')).toBeNull();
  });

  it('moves an object keeping its bytes, and lists what a prefix holds', async () => {
    const store = new LocalStorageProvider(root);
    const body = Buffer.from('evidence');
    await store.put({ key: 'projects/p/documents/_unfiled/a.pdf', body });
    await store.move('projects/p/documents/_unfiled/a.pdf', 'projects/p/documents/wm/a.pdf');

    expect(await store.exists('projects/p/documents/_unfiled/a.pdf')).toBe(false);
    expect(await store.get('projects/p/documents/wm/a.pdf')).toEqual(body);
    expect(await store.list('projects/p/documents/')).toEqual(['projects/p/documents/wm/a.pdf']);
  });

  it('streams for serving, with the size it will actually send', async () => {
    const store = new LocalStorageProvider(root);
    const body = crypto.randomBytes(9000);
    await store.put({ key: 'projects/p/documents/l/big.pdf', body, contentType: 'application/pdf' });

    const opened = await store.openRead('projects/p/documents/l/big.pdf');
    expect(opened.size).toBe(body.byteLength);
    expect(opened.contentType).toBe('application/pdf');

    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// Supabase provider, against an injected fetch
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for Supabase Storage: enough of the protocol to answer honestly. */
function fakeSupabase(options: { objects?: Map<string, Buffer>; fail?: number } = {}) {
  const objects = options.objects ?? new Map<string, Buffer>();
  const calls: Call[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url: href, method, headers, body: init?.body });

    if (options.fail) return new Response('denied', { status: options.fail });

    const listMatch = /\/storage\/v1\/object\/list\/([^/?]+)$/.exec(href);
    if (listMatch) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { prefix?: string };
      const prefix = (parsed.prefix ?? '').replace(/^\/+|\/+$/g, '');
      const seen = new Map<string, { name: string; id: string | null; size: number }>();
      for (const [key, value] of objects) {
        const scope = prefix ? `${prefix}/` : '';
        if (!key.startsWith(scope)) continue;
        const rest = key.slice(scope.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        // A folder is reported with no id, exactly as Supabase does.
        seen.set(name, { name, id: slash === -1 ? key : null, size: value.byteLength });
      }
      return new Response(
        JSON.stringify(
          [...seen.values()].map((e) => ({
            name: e.name,
            id: e.id,
            metadata: { size: e.size },
            updated_at: '2026-01-01T00:00:00.000Z',
          })),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (href.endsWith('/storage/v1/object/move')) {
      const { sourceKey, destinationKey } = JSON.parse(String(init?.body ?? '{}'));
      const found = objects.get(sourceKey);
      if (!found) return new Response('not found', { status: 404 });
      objects.delete(sourceKey);
      objects.set(destinationKey, found);
      return new Response('{}', { status: 200 });
    }

    const objectMatch = /\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(href);
    if (objectMatch) {
      const key = decodeURIComponent(objectMatch[2]!)
        .split('/')
        .map((s) => decodeURIComponent(s))
        .join('/');
      if (method === 'POST' || method === 'PUT') {
        const upsert = headers['x-upsert'] === 'true';
        if (objects.has(key) && !upsert) return new Response('duplicate', { status: 409 });
        objects.set(key, Buffer.from(init!.body as Uint8Array));
        return new Response('{}', { status: 200 });
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response('{}', { status: 200 });
      }
      const found = objects.get(key);
      if (!found) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(found), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(found.byteLength),
        },
      });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, objects };
}

function provider(fake: ReturnType<typeof fakeSupabase>) {
  return new SupabaseStorageProvider({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-secret-value',
    bucket: 'brain',
    fetchImpl: fake.fetchImpl,
  });
}

describe('the cloud store speaks Supabase Storage', () => {
  it('round-trips bytes unchanged and computes the checksum itself', async () => {
    const fake = fakeSupabase();
    const store = provider(fake);
    const body = crypto.randomBytes(2048);

    const meta = await store.put({ key: 'projects/p/documents/d/original/a.pdf', body });
    expect(meta.checksum).toBe(sha256(body));
    expect(meta.size).toBe(body.byteLength);
    expect(await store.get('projects/p/documents/d/original/a.pdf')).toEqual(body);
  });

  it('does not overwrite unless asked: POST without upsert, PUT with it', async () => {
    const fake = fakeSupabase();
    const store = provider(fake);
    const key = 'projects/p/documents/d/original/a.pdf';

    await store.put({ key, body: Buffer.from('first') });
    const first = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/object/brain/'));
    expect(first?.headers['x-upsert']).toBe('false');

    await expect(store.put({ key, body: Buffer.from('second') })).rejects.toThrow(/already exists/i);
    expect((await store.get(key)).toString()).toBe('first');

    await store.put({ key, body: Buffer.from('second'), overwrite: true });
    expect((await store.get(key)).toString()).toBe('second');
  });

  it('reports a missing object as missing', async () => {
    const store = provider(fakeSupabase());
    await expect(store.get('projects/p/documents/d/original/gone.pdf')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(await store.exists('projects/p/documents/d/original/gone.pdf')).toBe(false);
  });

  it('lists a prefix by walking the folders Supabase reports', async () => {
    const fake = fakeSupabase();
    const store = provider(fake);
    await store.put({ key: 'projects/p/documents/a/one.pdf', body: Buffer.from('1') });
    await store.put({ key: 'projects/p/documents/b/two.pdf', body: Buffer.from('2') });

    expect(await store.list('projects/p/documents/')).toEqual([
      'projects/p/documents/a/one.pdf',
      'projects/p/documents/b/two.pdf',
    ]);
  });

  it('moves an object and keeps its bytes', async () => {
    const fake = fakeSupabase();
    const store = provider(fake);
    await store.put({ key: 'projects/p/documents/_unfiled/a.pdf', body: Buffer.from('evidence') });
    await store.move('projects/p/documents/_unfiled/a.pdf', 'projects/p/documents/wm/a.pdf');

    expect((await store.get('projects/p/documents/wm/a.pdf')).toString()).toBe('evidence');
    expect(await store.exists('projects/p/documents/_unfiled/a.pdf')).toBe(false);
  });

  it('refuses an unsafe key before it reaches the network', async () => {
    const fake = fakeSupabase();
    const store = provider(fake);
    await expect(store.get('../../brain.db')).rejects.toThrow();
    await expect(store.put({ key: '/etc/passwd', body: Buffer.from('x') })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('tells a missing bucket apart from a rejected credential', async () => {
    await expect(provider(fakeSupabase({ fail: 404 })).verify()).rejects.toThrow(
      /bucket "brain" does not exist/i,
    );
    await expect(provider(fakeSupabase({ fail: 401 })).verify()).rejects.toThrow(
      /rejected Brain's credentials/i,
    );
    // And a bucket that answers is not reported as a failure.
    await expect(provider(fakeSupabase()).verify()).resolves.toBeUndefined();
  });

  it('never puts the service-role key in anything a caller can see', async () => {
    const secret = 'service-role-secret-value';
    const failures: string[] = [];

    for (const status of [400, 401, 403, 404, 500]) {
      const store = provider(fakeSupabase({ fail: status }));
      for (const attempt of [
        () => store.verify(),
        () => store.get('projects/p/documents/d/original/a.pdf'),
        () => store.put({ key: 'projects/p/documents/d/original/a.pdf', body: Buffer.from('x') }),
        () => store.list('projects/'),
      ]) {
        await attempt().catch((error: unknown) => {
          const e = error as StorageConfigurationError;
          failures.push(`${e.message} ${e.detail ?? ''}`);
        });
      }
    }

    expect(failures.length).toBeGreaterThan(0);
    for (const text of failures) expect(text).not.toContain(secret);
    // The description an operator is shown names the host and bucket only.
    expect(provider(fakeSupabase()).describe()).toBe('example.supabase.co/brain');
    expect(provider(fakeSupabase()).describe()).not.toContain(secret);
  });

  it('sends the key as a bearer token and nowhere else', async () => {
    const fake = fakeSupabase();
    await provider(fake).put({
      key: 'projects/p/documents/d/original/a.pdf',
      body: Buffer.from('x'),
    });
    const call = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/object/brain/'))!;
    expect(call.headers['Authorization']).toBe('Bearer service-role-secret-value');
    // Never in the URL, where it would be logged by every proxy in between.
    expect(call.url).not.toContain('service-role-secret-value');
  });
});

// ---------------------------------------------------------------------------
// Choosing a provider
// ---------------------------------------------------------------------------


describe('a busy store is not a missing document', () => {
  /*
   * A deploy failed on exactly this. The bucket answered 429 to a read issued
   * 2.2 seconds after the write, and the caller reported the freshly filed
   * report as having no bytes — the conflation §9 exists to prevent and §20
   * states outright: a transient refusal is not evidence about the data. A
   * research packet whose document was perfectly present would have been
   * refused because its store was briefly busy.
   */

  /** A store that refuses `refusals` times with `status`, then serves. */
  function flakyStore(status: number, refusals: number, retryAfter?: string) {
    const body = Buffer.from('the filed report');
    let seen = 0;
    const calls: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        return new Response(JSON.stringify({ Key: 'k' }), { status: 200 });
      }
      seen += 1;
      calls.push(seen);
      if (seen <= refusals) {
        return new Response('slow down', {
          status,
          headers: retryAfter ? { 'retry-after': retryAfter } : {},
        });
      }
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    return {
      calls,
      store: new SupabaseStorageProvider({
        url: 'https://example.supabase.co',
        serviceRoleKey: 'service-role-secret-value',
        bucket: 'brain',
        fetchImpl,
      }),
    };
  }

  it('asks again when the store says 429, and returns the bytes', async () => {
    const flaky = flakyStore(429, 1);
    const bytes = await flaky.store.get('projects/p/documents/l/report.md');
    expect(bytes.toString()).toBe('the filed report');
    expect(flaky.calls.length).toBe(2);
  });

  it('retries the other transient refusals too', async () => {
    for (const status of [500, 502, 503, 504]) {
      const flaky = flakyStore(status, 1);
      const bytes = await flaky.store.get('projects/p/documents/l/report.md');
      expect(bytes.toString()).toBe('the filed report');
    }
  });

  it('gives up after a bounded number of attempts, and says the store declined', async () => {
    const flaky = flakyStore(429, 99);
    await expect(flaky.store.get('projects/p/documents/l/report.md')).rejects.toThrow(
      /declining, not a statement about the document/,
    );
    // Bounded: a busy store must not become an unbounded retry loop.
    expect(flaky.calls.length).toBe(3);
  });

  it('never retries a 404, because that is an answer', async () => {
    let seen = 0;
    const fetchImpl = (async () => {
      seen += 1;
      return new Response('no such object', { status: 404 });
    }) as unknown as typeof fetch;
    const store = new SupabaseStorageProvider({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret-value',
      bucket: 'brain',
      fetchImpl,
    });
    await expect(store.get('projects/p/documents/l/gone.md')).rejects.toThrow();
    expect(seen).toBe(1);
  });

  it('honours Retry-After rather than inventing its own delay', async () => {
    const flaky = flakyStore(429, 1, '0');
    const started = Date.now();
    await flaky.store.get('projects/p/documents/l/report.md');
    // Retry-After: 0 means immediately; the default backoff would be 250ms.
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('choosing where documents are kept', () => {
  it('defaults to the local store', async () => {
    const store = await initStorage({
      config: { provider: 'local', supabaseUrl: null, serviceRoleKey: null, bucket: null },
      root,
    });
    expect(store.kind).toBe('local');
    expect(getStorage().kind).toBe('local');
  });

  it('never falls back to local disk when the bucket cannot be reached', async () => {
    const fake = fakeSupabase({ fail: 404 });
    await expect(
      initStorage({
        config: {
          provider: 'supabase',
          supabaseUrl: 'https://example.supabase.co',
          serviceRoleKey: 'k',
          bucket: 'brain',
        },
        root,
        fetchImpl: fake.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(StorageConfigurationError);

    // Nothing was written locally, and nothing quietly became the active store.
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('proves the bucket answers rather than trusting the configuration', async () => {
    const fake = fakeSupabase();
    const store = await initStorage({
      config: {
        provider: 'supabase',
        supabaseUrl: 'https://example.supabase.co',
        serviceRoleKey: 'k',
        bucket: 'brain',
      },
      root,
      fetchImpl: fake.fetchImpl,
    });
    expect(store.kind).toBe('supabase');
    // A real request was made. Having the variables set is not the same fact.
    expect(fake.calls.some((c) => c.url.includes('/object/list/brain'))).toBe(true);
  });
});
