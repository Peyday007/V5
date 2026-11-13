import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadKit } from '../scripts/launch/etsy.ts';
import { BOARDS, PIN_API, REFRESH_OUT, linkKey, liveProducts, planPins, runPinterest } from '../scripts/launch/pinterest.ts';
import { LISTINGS } from '../scripts/launch/store.ts';
import type { StageContext, StageResult } from '../scripts/launch/types.ts';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// A root whose kits are the real ones, and whose .launch-out is disposable.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-pinterest-'));
fs.symlinkSync(path.join(REPO, 'fast-cash'), path.join(ROOT, 'fast-cash'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const APP = { PINTEREST_APP_ID: '1234', PINTEREST_APP_SECRET: 'app-sekret', PINTEREST_CALL_SPACING_MS: '0' };
const STANDARD = { ...APP, PINTEREST_STANDARD_ACCESS: 'approved' };
const kit = loadKit(REPO);
const SHOP = 'https://exactlyonesolution.fourthwall.com';

const storeLive: StageResult = {
  stage: 'store', status: 'DONE', detail: '12 listings (10 products): 12 EXISTS',
  items: LISTINGS.map((l) => ({ key: l.key, state: 'EXISTS', url: `${SHOP}/products/${l.key}` })),
  outputs: { promoCode: 'PUZZLE10', promoPercent: '10' },
};
const etsyLive: StageResult = {
  stage: 'etsy', status: 'DONE', detail: 'shop 777: 8 created',
  items: kit.map((l, i) => ({ key: l.slug, state: 'CREATED', url: `https://www.etsy.com/listing/${1000 + i}/${l.slug}?utm_source=OpenAPI` })),
};
const storeNotLive: StageResult = { stage: 'store', status: 'NEEDS_OWNER', detail: '12/12 listings validated; no Fourthwall API credentials', items: [] };
const etsyNotLive: StageResult = { stage: 'etsy', status: 'NEEDS_OWNER', detail: 'no Etsy app credentials', items: [] };

interface Pin { id: string; board_id: string; link: string; title: string; description: string; alt_text: string; media: { source_type: string; content_type: string; data: string } }

/** An in-memory Pinterest v5: token, user_account, boards and pins. */
function fakePinterest(opts: { pins?: Array<Partial<Pin>>; boards?: Array<{ id: string; name: string }>; accountType?: string } = {}) {
  const boards = [...(opts.boards ?? [])];
  const pins = [...(opts.pins ?? [])] as Pin[];
  const calls: string[] = [];
  let seq = 0;
  let refreshSeq = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace('/v5', '');
    calls.push(`${method} ${p}`);
    if (!String(input).startsWith(PIN_API)) return json(500, { message: `unexpected host ${url.host}` });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (p === '/oauth/token') {
      if (headers.Authorization !== `Basic ${Buffer.from('1234:app-sekret').toString('base64')}`) return json(401, { message: 'bad client' });
      const b = new URLSearchParams(String(init?.body));
      if (b.get('grant_type') === 'refresh_token' && !b.get('refresh_token')?.startsWith('rt-')) return json(400, { message: 'invalid refresh token' });
      if (b.get('grant_type') === 'authorization_code' && b.get('code') !== 'good-code') return json(400, { message: 'invalid code' });
      return json(200, { access_token: 'pina_access', refresh_token: `rt-${++refreshSeq}`, expires_in: 2592000, refresh_token_expires_in: 5184000 });
    }
    if (headers.Authorization !== 'Bearer pina_access') return json(401, { message: 'unauthorized' });
    if (method === 'GET' && p === '/user_account') return json(200, { username: 'exactlyonesolution', account_type: opts.accountType ?? 'BUSINESS' });
    if (method === 'GET' && p === '/boards') return json(200, { items: boards, bookmark: null });
    if (method === 'POST' && p === '/boards') {
      const b = JSON.parse(String(init?.body)) as { name: string; privacy: string };
      const board = { id: `b${++seq}`, name: b.name, privacy: b.privacy };
      boards.push(board);
      return json(201, board);
    }
    if (method === 'GET' && p === '/pins') {
      // two pages, to prove the bookmark is followed
      const page = url.searchParams.get('bookmark') === 'p2' ? pins.slice(5) : pins.slice(0, 5);
      return json(200, { items: page, bookmark: !url.searchParams.get('bookmark') && pins.length > 5 ? 'p2' : null });
    }
    if (method === 'POST' && p === '/pins') {
      const b = JSON.parse(String(init?.body)) as Omit<Pin, 'id' | 'media'> & { media_source: Pin['media'] };
      if (!boards.some((x) => x.id === b.board_id)) return json(404, { message: 'board not found' });
      const pin: Pin = { id: `${900 + ++seq}`, board_id: b.board_id, link: b.link, title: b.title, description: b.description, alt_text: b.alt_text, media: b.media_source };
      pins.push(pin);
      return json(201, pin);
    }
    return json(500, { message: `unhandled ${method} ${p}` });
  }) as typeof fetch;
  return { fetchImpl, boards, pins, calls, writes: () => calls.filter((c) => c === 'POST /pins' || c === 'POST /boards').length };
}

const ctxFor = (fetchImpl: typeof fetch, env: Record<string, string>, results?: StageResult[], dryRun = false): StageContext => ({
  env, dryRun, fetch: fetchImpl, log: () => {}, root: ROOT, ...(results ? { results } : {}),
});

describe('launch Pinterest stage', () => {
  it('dry run validates a pin for every store listing and Etsy listing without a network call', async () => {
    const fake = fakePinterest();
    const r = await runPinterest(ctxFor(fake.fetchImpl, {}, undefined, true));
    expect(r.status).toBe('DONE');
    expect(r.items).toHaveLength(LISTINGS.length + kit.length);
    expect(r.items.every((i) => i.state === 'WOULD_CREATE')).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('asks only for account creation and app authorization when there is no app', async () => {
    const fake = fakePinterest();
    const r = await runPinterest(ctxFor(fake.fetchImpl, {}, [storeLive, etsyLive]));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toContain('business account');
    expect(r.ownerAction).toContain('PINTEREST_APP_ID');
    expect(r.ownerAction).toContain('PINTEREST_APP_SECRET');
    expect(fake.calls).toEqual([]);

    const consent = await runPinterest(ctxFor(fake.fetchImpl, APP, [storeLive, etsyLive]));
    expect(consent.status).toBe('NEEDS_OWNER');
    expect(consent.ownerAction).toContain('https://www.pinterest.com/oauth/?client_id=1234');
    expect(consent.ownerAction).toContain('pins%3Awrite');
    expect(consent.ownerAction).toContain('pinterest_redirect_url');
    expect(fake.calls).toEqual([]);
  });

  it('under Trial access verifies the account, keeps the login, and creates nothing (Trial pins are private)', async () => {
    const fake = fakePinterest();
    const landed = 'http://localhost:8085/?code=good-code';
    const r = await runPinterest(ctxFor(fake.fetchImpl, { ...APP, PINTEREST_AUTH_REDIRECT_URL: landed }, [storeLive, etsyLive]));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toContain('Standard access');
    expect(r.ownerAction).toContain('PINTEREST_STANDARD_ACCESS');
    expect(r.items.filter((i) => i.state === 'WOULD_CREATE')).toHaveLength(LISTINGS.length + kit.length);
    expect(fake.writes()).toBe(0);
    expect(fs.readFileSync(path.join(ROOT, REFRESH_OUT), 'utf8').trim()).toBe('rt-1');
  });

  it('reports WAITING, not an error, while neither store is live', async () => {
    const fake = fakePinterest();
    const r = await runPinterest(ctxFor(fake.fetchImpl, { ...STANDARD, PINTEREST_REFRESH_TOKEN: 'rt-0' }, [storeNotLive, etsyNotLive]));
    expect(r.status).toBe('WAITING');
    expect(r.ownerAction).toBeUndefined();
    expect(r.items.map((i) => [i.key, i.state])).toEqual([['fourthwall', 'WAITING'], ['etsy', 'WAITING']]);
    expect(fake.writes()).toBe(0);
  });

  it('pins every live product once, linked to its page, and a second run creates nothing', async () => {
    const fake = fakePinterest();
    const env = { ...STANDARD, PINTEREST_REFRESH_TOKEN: 'rt-0' };
    const first = await runPinterest(ctxFor(fake.fetchImpl, env, [storeLive, etsyLive]));
    expect(first.status).toBe('DONE');
    expect(fake.boards.map((b) => b.name).sort()).toEqual([BOARDS.gifts.name, BOARDS.printables.name].sort());
    expect(fake.pins).toHaveLength(LISTINGS.length + kit.length);
    // links: the live URLs, Etsy's tracking query removed
    expect(fake.pins.map((p) => p.link)).toContain(`${SHOP}/products/${LISTINGS[0]!.key}`);
    expect(fake.pins.filter((p) => p.link.includes('etsy.com')).every((p) => !p.link.includes('?'))).toBe(true);
    // the promo code is in store pins only; every pin carries a real PNG
    const storePins = fake.pins.filter((p) => p.link.startsWith(SHOP));
    expect(storePins.every((p) => p.description.includes('PUZZLE10'))).toBe(true);
    expect(fake.pins.filter((p) => p.link.includes('etsy.com')).some((p) => p.description.includes('PUZZLE10'))).toBe(false);
    expect(fake.pins.every((p) => p.media.source_type === 'image_base64' && Buffer.from(p.media.data, 'base64').subarray(1, 4).toString() === 'PNG')).toBe(true);
    expect(fake.pins.every((p) => p.title.length <= 100 && p.description.length <= 800 && /puzzle lover/i.test(p.description))).toBe(true);
    const giftBoard = fake.boards.find((b) => b.name === BOARDS.gifts.name)!;
    expect(storePins.every((p) => p.board_id === giftBoard.id)).toBe(true);

    const writes = fake.writes();
    const second = await runPinterest(ctxFor(fake.fetchImpl, env, [storeLive, etsyLive]));
    expect(second.status).toBe('DONE');
    expect(fake.writes()).toBe(writes);
    expect(second.items.every((i) => i.state === 'EXISTS')).toBe(true);
    expect(fake.pins).toHaveLength(LISTINGS.length + kit.length);
  });

  it('finds existing pins by link (an Etsy pin by listing id) and existing boards by name', async () => {
    const etsyItem = etsyLive.items[0]!;
    const fake = fakePinterest({
      boards: [{ id: 'old-board', name: 'large print & printable puzzles' }],
      pins: [{ id: '1', board_id: 'old-board', link: 'https://etsy.com/listing/1000/an-older-slug?ref=shop_home' }],
    });
    const r = await runPinterest(ctxFor(fake.fetchImpl, { ...STANDARD, PINTEREST_REFRESH_TOKEN: 'rt-0' }, [storeNotLive, etsyLive]));
    expect(r.status).toBe('WAITING'); // Fourthwall not live yet
    expect(r.items.find((i) => i.key === etsyItem.key)?.state).toBe('EXISTS');
    expect(fake.calls.filter((c) => c === 'POST /boards')).toHaveLength(0);
    expect(fake.calls.filter((c) => c === 'POST /pins')).toHaveLength(kit.length - 1);
    expect(r.items.find((i) => i.key === 'fourthwall')?.state).toBe('WAITING');
  });

  it('pins a store as soon as it goes live, without touching what is already pinned', async () => {
    const fake = fakePinterest();
    const env = { ...STANDARD, PINTEREST_REFRESH_TOKEN: 'rt-0' };
    const early = await runPinterest(ctxFor(fake.fetchImpl, env, [storeLive, etsyNotLive]));
    expect(early.status).toBe('WAITING');
    expect(fake.pins).toHaveLength(LISTINGS.length);
    const later = await runPinterest(ctxFor(fake.fetchImpl, env, [storeLive, etsyLive]));
    expect(later.status).toBe('DONE');
    expect(later.items.filter((i) => i.state === 'CREATED' && !i.key.startsWith('board:'))).toHaveLength(kit.length);
    expect(later.items.filter((i) => i.key.startsWith('board:')).map((i) => i.key)).toEqual([`board:${BOARDS.printables.name}`]);
    expect(fake.pins).toHaveLength(LISTINGS.length + kit.length);
  });

  it('reads the last saved results when the store stages did not run in this run', async () => {
    fs.mkdirSync(path.join(ROOT, '.launch-out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.launch-out', 'results.json'), JSON.stringify([{ ...storeLive, name: 'Print-on-demand store' }, { ...etsyNotLive, name: 'Etsy listings' }]));
    const fake = fakePinterest();
    const r = await runPinterest(ctxFor(fake.fetchImpl, { ...STANDARD, PINTEREST_REFRESH_TOKEN: 'rt-0' }));
    fs.rmSync(path.join(ROOT, '.launch-out', 'results.json'));
    expect(r.status).toBe('WAITING');
    expect(fake.pins).toHaveLength(LISTINGS.length);
  });

  it('never treats a hidden product, an inactive Etsy listing or a dry run as live', () => {
    const live = liveProducts([
      { ...storeLive, items: [{ key: 'a', state: 'EXISTS', url: `${SHOP}/products/a`, note: 'access ARCHIVED, left as is' }, { key: 'b', state: 'FAILED' }] },
      { ...etsyLive, items: [{ key: 'c', state: 'EXISTS', url: 'https://www.etsy.com/listing/5', note: 'listing 5 is inactive; left as the owner set it' }] },
    ]);
    expect(live.urls.size).toBe(0);
    const dry = liveProducts([{ ...storeLive, detail: 'dry run — 12 listings' }, { ...etsyLive, detail: 'dry run: 8/8 listings valid' }]);
    expect(dry.waiting.map((w) => w.store)).toEqual(['fourthwall', 'etsy']);
    expect(linkKey('https://www.etsy.com/listing/42/x?ref=a')).toBe(linkKey('https://etsy.com/listing/42/y'));
    expect(planPins(REPO).every((p) => fs.existsSync(p.image))).toBe(true);
  });

  it('asks for a business account when the authorized account is personal', async () => {
    const fake = fakePinterest({ accountType: 'PINNER' });
    const r = await runPinterest(ctxFor(fake.fetchImpl, { ...STANDARD, PINTEREST_REFRESH_TOKEN: 'rt-0' }, [storeLive, etsyLive]));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toContain('business account');
    expect(fake.writes()).toBe(0);
  });
});
