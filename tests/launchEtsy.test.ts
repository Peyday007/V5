import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { consentUrl, loadKit, REFRESH_OUT, runEtsy } from '../scripts/launch/etsy.ts';
import type { StageContext } from '../scripts/launch/types.ts';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// A root whose kit is the real one, and whose .launch-out is disposable.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-etsy-'));
fs.symlinkSync(path.join(REPO, 'fast-cash'), path.join(ROOT, 'fast-cash'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const KEYS = { ETSY_API_KEY: 'keystr', ETSY_SHARED_SECRET: 'sekret', ETSY_CALL_SPACING_MS: '0' };
const SHOP = 777;

interface FakeListing { listing_id: number; title: string; state: string; tags: string[]; type: string; price: string; images: number[]; files: string[]; taxonomy_id: number }

/** An in-memory Etsy: the endpoints the stage uses, with Etsy's activation rules. */
function fakeEtsy(opts: { canPublish?: boolean; listings?: FakeListing[] } = {}) {
  const shop = { canPublish: opts.canPublish ?? true, listings: opts.listings ?? [] as FakeListing[], nextId: 1000 };
  const calls: Array<{ method: string; path: string }> = [];
  const badKeyHeaders: string[] = [];
  const codes = new Map<string, string>(); // code → challenge
  let refreshSeq = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname;
    calls.push({ method, path: p });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['x-api-key'] !== 'keystr:sekret') badKeyHeaders.push(`${method} ${p}: ${headers['x-api-key']}`);

    if (p === '/v3/public/oauth/token') {
      const b = new URLSearchParams(String(init?.body));
      if (b.get('grant_type') === 'refresh_token') {
        if (!b.get('refresh_token')?.startsWith('rt-')) return json(400, { error: 'invalid_grant', error_description: 'refresh token is revoked' });
      } else {
        const challenge = codes.get(b.get('code') ?? '');
        const verifier = b.get('code_verifier') ?? '';
        const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (!challenge || challenge !== actual) return json(400, { error: 'invalid_grant', error_description: 'code_verifier mismatch' });
      }
      return json(200, { access_token: `1.at-${++refreshSeq}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${refreshSeq}` });
    }
    if (!headers['Authorization']?.startsWith('Bearer 1.at-')) return json(401, { error: 'invalid_token' });

    let m: RegExpExecArray | null;
    if (p === '/v3/application/users/me') return json(200, { user_id: 1, shop_id: SHOP });
    if (p === '/v3/application/seller-taxonomy/nodes') {
      return json(200, { count: 1, results: [{ id: 1, name: 'Toys & Games', children: [{ id: 2, name: 'Games & Puzzles', children: [{ id: 3, name: 'Puzzles', children: [{ id: 12626, name: 'Word & Number Puzzles', children: [] }] }] }] }] });
    }
    if (p === `/v3/application/shops/${SHOP}/listings` && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'active';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const rows = shop.listings.filter((l) => l.state === state).slice(offset, offset + limit);
      return json(200, { count: rows.length, results: rows.map((l) => ({ listing_id: l.listing_id, title: l.title.replace(/&/g, '&amp;'), state: l.state, tags: l.tags })) });
    }
    if (p === `/v3/application/shops/${SHOP}/listings` && method === 'POST') {
      const b = new URLSearchParams(String(init?.body));
      for (const f of ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id']) if (!b.get(f)) return json(400, { error: `${f} is required` });
      const l: FakeListing = { listing_id: shop.nextId++, title: b.get('title')!, state: 'draft', tags: (b.get('tags') ?? '').split(',').filter(Boolean), type: b.get('type') ?? 'physical', price: b.get('price')!, images: [], files: [], taxonomy_id: Number(b.get('taxonomy_id')) };
      if (l.type !== 'download') return json(400, { error: 'physical listing needs shipping_profile_id' });
      shop.listings.push(l);
      return json(201, { listing_id: l.listing_id, title: l.title, state: l.state, url: `https://www.etsy.com/listing/${l.listing_id}` });
    }
    const find = (id: string) => shop.listings.find((l) => l.listing_id === Number(id));
    if ((m = /^\/v3\/application\/shops\/777\/listings\/(\d+)\/images$/.exec(p))) {
      const l = find(m[1]!)!;
      const fd = init?.body as FormData;
      if (!(fd.get('image') instanceof Blob)) return json(400, { error: 'image missing' });
      const rank = Number(fd.get('rank'));
      if (!l.images.includes(rank)) l.images.push(rank);
      return json(201, { listing_image_id: rank, rank });
    }
    if ((m = /^\/v3\/application\/listings\/(\d+)\/images$/.exec(p))) {
      const l = find(m[1]!)!;
      return json(200, { count: l.images.length, results: l.images.map((rank) => ({ listing_image_id: rank, rank })) });
    }
    if ((m = /^\/v3\/application\/shops\/777\/listings\/(\d+)\/files$/.exec(p))) {
      const l = find(m[1]!)!;
      if (method === 'GET') return json(200, { count: l.files.length, results: l.files.map((filename, i) => ({ listing_file_id: i, filename, rank: i + 1 })) });
      const fd = init?.body as FormData;
      const file = fd.get('file');
      if (!(file instanceof Blob) || file.size === 0) return json(400, { error: 'file missing' });
      if (l.files.length >= 5) return json(400, { error: 'max 5 files' });
      l.files.push(String(fd.get('name')));
      return json(201, { listing_file_id: l.files.length, filename: fd.get('name') });
    }
    if ((m = /^\/v3\/application\/shops\/777\/listings\/(\d+)$/.exec(p)) && method === 'PATCH') {
      const l = find(m[1]!)!;
      const b = new URLSearchParams(String(init?.body));
      if (b.get('tags')) l.tags = b.get('tags')!.split(',');
      if (b.get('state') === 'active') {
        if (!shop.canPublish) return json(403, { error: 'Your shop must be open and have a valid billing method to activate listings.' });
        if (l.images.length === 0 || l.files.length === 0) return json(400, { error: 'A digital listing needs an image and a file to be activated' });
        l.state = 'active';
      }
      return json(200, { listing_id: l.listing_id, state: l.state, url: `https://www.etsy.com/listing/${l.listing_id}` });
    }
    return json(404, { error: `fake: no route ${method} ${p}` });
  }) as typeof fetch;
  return { shop, calls, badKeyHeaders, codes, fetch: fetchImpl };
}

function ctxFor(fake: { fetch: typeof fetch }, env: Record<string, string>, dryRun = false): StageContext {
  return { env, dryRun, fetch: fake.fetch, log: () => {}, root: ROOT };
}

describe('Etsy launch stage', () => {
  const kit = loadKit(REPO);

  it('reads the real kit: 8 digital listings, the bundle with 5 PDFs', () => {
    expect(kit).toHaveLength(8);
    expect(kit.find((l) => l.slug === 'large-print-puzzle-bundle')!.files).toHaveLength(5);
    expect(kit.every((l) => l.whoMade === 'i_did' && l.whenMade === '2020_2026' && !l.isSupply && l.tags.length === 13)).toBe(true);
  });

  it('dry-run validates the real kit files without a single fetch', async () => {
    const fetchSpy = (() => { throw new Error('dry run must not call the network'); }) as unknown as typeof fetch;
    const r = await runEtsy({ env: { ...KEYS, ETSY_REFRESH_TOKEN: 'rt-0' }, dryRun: true, fetch: fetchSpy, log: () => {}, root: ROOT });
    expect(r.status).toBe('DONE');
    expect(r.items.map((i) => i.state)).toEqual(Array(8).fill('WOULD_CREATE'));
  });

  it('without an app key it asks the owner for exactly the app setup', async () => {
    const fake = fakeEtsy();
    const r = await runEtsy(ctxFor(fake, {}));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toContain('https://www.etsy.com/developers/register');
    expect(r.ownerAction).toContain('http://localhost:3003/oauth/redirect');
    expect(r.ownerAction).toContain('ETSY_SHARED_SECRET');
    expect(fake.calls).toHaveLength(0);
  });

  it('with a key but no token it hands back the PKCE consent URL', async () => {
    const fake = fakeEtsy();
    const r = await runEtsy(ctxFor(fake, KEYS));
    expect(r.status).toBe('NEEDS_OWNER');
    const url = new URL(/https:\/\/www\.etsy\.com\/oauth\/connect\S+/.exec(r.ownerAction ?? '')![0]);
    expect(url.searchParams.get('client_id')).toBe('keystr');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('listings_r listings_w shops_r');
    expect(r.ownerAction).toContain('etsy_redirect_url');
    expect(fake.calls).toHaveLength(0);
  });

  it('first run creates, fills and publishes all 8; the second run is all EXISTS', async () => {
    const fake = fakeEtsy();
    // The consent round trip: Etsy issues a code bound to the URL's challenge.
    const consent = new URL(consentUrl(KEYS));
    fake.codes.set('the-code', consent.searchParams.get('code_challenge')!);
    const landed = `http://localhost:3003/oauth/redirect?code=the-code&state=${consent.searchParams.get('state')}`;

    const first = await runEtsy(ctxFor(fake, { ...KEYS, ETSY_AUTH_REDIRECT_URL: landed }));
    expect(first.status, first.detail).toBe('DONE');
    expect(first.items.map((i) => i.state)).toEqual(Array(8).fill('CREATED'));
    expect(fake.shop.listings).toHaveLength(8);
    for (const l of kit) {
      const made = fake.shop.listings.find((x) => x.title === l.title)!;
      expect(made.state).toBe('active');
      expect(made.type).toBe('download');
      expect(made.price).toBe(l.price.toFixed(2));
      expect(made.taxonomy_id).toBe(12626);
      expect(made.tags).toEqual(l.tags);
      expect(made.images.sort()).toEqual(l.images.map((_, i) => i + 1));
      expect(made.files).toEqual(l.files.map((f) => path.basename(f)));
    }
    expect(fake.badKeyHeaders).toEqual([]);
    expect(fs.readFileSync(path.join(ROOT, REFRESH_OUT), 'utf8').trim()).toBe('rt-1');
    expect(first.detail).toContain(REFRESH_OUT);

    fake.calls.length = 0;
    const second = await runEtsy(ctxFor(fake, { ...KEYS, ETSY_REFRESH_TOKEN: 'rt-1', ETSY_AUTH_REDIRECT_URL: landed }));
    expect(second.status).toBe('DONE');
    expect(second.items.map((i) => i.state)).toEqual(Array(8).fill('EXISTS'));
    expect(fake.calls.filter((c) => c.method !== 'GET' && c.path !== '/v3/public/oauth/token')).toEqual([]);
    expect(fake.shop.listings).toHaveLength(8);
    expect(fs.readFileSync(path.join(ROOT, REFRESH_OUT), 'utf8').trim()).toBe('rt-2'); // rotated again
  });

  it('a refused activation leaves complete drafts (PARTIAL), and the next run publishes them', async () => {
    const fake = fakeEtsy({ canPublish: false });
    const r = await runEtsy(ctxFor(fake, { ...KEYS, ETSY_REFRESH_TOKEN: 'rt-9' }));
    expect(r.status).toBe('PARTIAL');
    expect(r.detail).toContain('valid billing method');
    expect(r.ownerAction).toContain('valid billing method');
    expect(fake.shop.listings.every((l) => l.state === 'draft' && l.files.length > 0 && l.images.length > 0)).toBe(true);

    fake.shop.canPublish = true;
    const uploadsBefore = fake.calls.filter((c) => c.method === 'POST').length;
    const again = await runEtsy(ctxFor(fake, { ...KEYS, ETSY_REFRESH_TOKEN: 'rt-9' }));
    expect(again.status).toBe('DONE');
    expect(again.items.map((i) => i.state)).toEqual(Array(8).fill('UPDATED'));
    expect(fake.shop.listings.every((l) => l.state === 'active')).toBe(true);
    // Only the token refresh posted: nothing re-uploaded, nothing re-created.
    expect(fake.calls.filter((c) => c.method === 'POST').length - uploadsBefore).toBe(1);
  });

  it('completes the listing the owner made during shop onboarding instead of duplicating it', async () => {
    const first = kit[0]!;
    const fake = fakeEtsy({ listings: [{ listing_id: 1, title: first.title, state: 'active', tags: [], type: 'download', price: '3.99', images: [1], files: [], taxonomy_id: 12626 }] });
    const r = await runEtsy(ctxFor(fake, { ...KEYS, ETSY_REFRESH_TOKEN: 'rt-5' }));
    expect(r.status).toBe('DONE');
    expect(r.items[0]).toMatchObject({ key: first.slug, state: 'UPDATED' });
    expect(fake.shop.listings).toHaveLength(8);
    const own = fake.shop.listings[0]!;
    expect(own.images.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(own.files).toEqual([path.basename(first.files[0]!)]);
    expect(own.tags).toEqual(first.tags);
  });

  it('a revoked refresh token with no fresh code asks for consent again', async () => {
    const fake = fakeEtsy();
    const r = await runEtsy(ctxFor(fake, { ...KEYS, ETSY_REFRESH_TOKEN: 'revoked' }));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.detail).toContain('refresh failed');
    expect(r.ownerAction).toContain('https://www.etsy.com/oauth/connect?');
  });
});
