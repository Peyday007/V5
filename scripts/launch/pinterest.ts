/**
 * Pinterest stage of the launch runner: $0 customer acquisition for both
 * stores. Once the owner has authorized a free Pinterest business account,
 * every run makes sure there is one pin for every live Fourthwall product and
 * every live Etsy listing, each linking to the live product page, on two
 * boards ("Puzzle gifts", "Large print & printable puzzles"). No ads, no money.
 *
 * Which products are live is read from the store and etsy stages' results in
 * this same run (run.ts passes them in `ctx.results`), or, when this stage runs
 * alone, from `.launch-out/results.json`. A store that is not live yet is
 * reported WAITING — it is never pinned early and never an error.
 *
 * Idempotent by link: a run lists every pin on the account before it creates
 * anything, and a product whose page already has a pin is not pinned again
 * (Etsy links are compared by listing id, others by URL without query/hash).
 * Only a 429 is retried; a create whose outcome is unknown is not retried in
 * this run — the next run finds it by link.
 *
 * Pinterest API v5 facts (developers.pinterest.com, read 2026-11-11):
 *   - OAuth 2 authorization code at https://www.pinterest.com/oauth/; token at
 *     POST https://api.pinterest.com/v5/oauth/token with HTTP Basic
 *     app_id:app_secret. Access token 30 days; refresh token 60 days and
 *     "continuous": every refresh returns a new one, so the newest is written
 *     to `.launch-out/pinterest-refresh-token` and launch.yml carries it,
 *     encrypted, to the next run (as with Etsy).
 *   - A new app is reviewed, then gets TRIAL access: 1,000 calls a day, and
 *     every pin and board it creates is a Sandbox entity visible only to its
 *     creator. Public pins need STANDARD access, which Pinterest grants after a
 *     manual review of a screen recording that shows the OAuth flow and an API
 *     call (no published turnaround). So this stage creates nothing until the
 *     secret PINTEREST_STANDARD_ACCESS says the upgrade was approved: a pin made
 *     under Trial would be invisible, and its link would then block the real pin.
 *   - POST /v5/pins: board_id, title ≤ 100, description ≤ 800, link ≤ 2048,
 *     alt_text ≤ 500, media_source image_base64 (PNG/JPEG ≤ 20 MB).
 *     Standard limits: 100 org_write calls a minute per user.
 *
 *   npx tsx scripts/launch/pinterest.ts dry-run | authorize | run
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_DIR, loadKit } from './etsy.ts';
import { LISTINGS, PROMO, STORE_DIR, parseCsv, pngSize, readCatalog } from './store.ts';
import type { StageContext, StageResult } from './types.ts';

export const PIN_API = 'https://api.pinterest.com/v5';
export const PIN_OAUTH = 'https://www.pinterest.com/oauth/';
export const PIN_TOKEN_URL = `${PIN_API}/oauth/token`;
/** Pinterest's own quick-start redirect; the page never has to load. */
export const DEFAULT_REDIRECT_URI = 'http://localhost:8085/';
export const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];
export const REFRESH_OUT = '.launch-out/pinterest-refresh-token';

export const BOARDS = {
  gifts: { name: 'Puzzle gifts', description: 'Sudoku mugs, tees and gifts for puzzle lovers. Every puzzle has exactly one solution.' },
  printables: { name: 'Large print & printable puzzles', description: 'Printable sudoku, word search and maze books, many in large print. Instant download PDFs with solutions.' },
} as const;
type BoardKey = keyof typeof BOARDS;

const MAX_TITLE = 100;
const MAX_DESC = 800;
const MAX_ALT = 500;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type Json = Record<string, any>;
type Item = StageResult['items'][number];
const STAGE = 'pinterest';

// ───────────────────────────── what to pin ─────────────────────────────

/** One pin's content, built from the kits. `url` is filled from the store's live result. */
export interface PinSpec {
  key: string; // the store/etsy stage's item key
  source: 'fourthwall' | 'etsy';
  board: BoardKey;
  title: string;
  description: string;
  altText: string;
  image: string; // absolute path
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  // Prefer ending at a whole phrase (a comma) over a word, and a word over a cut word.
  const comma = t.slice(0, max + 1).lastIndexOf(', ');
  if (comma > max * 0.5) return t.slice(0, comma);
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,\s—-]+$/, '')}…`;
}

/** Description = the product's own copy, the promo (store only), then honest gift keywords. */
function describe(copy: string, keywords: string[], promo?: string): string {
  const kw = `Gift for a puzzle lover: ${[...new Set(keywords.map((k) => k.trim()).filter(Boolean))].join(', ')}.`;
  const tail = [promo, kw].filter(Boolean).join(' ');
  const room = MAX_DESC - tail.length - 1;
  return `${clip(copy, Math.max(room, 200))} ${tail}`.slice(0, MAX_DESC);
}

/** Every pin the kits describe (12 Fourthwall listings + every Etsy listing). */
export function planPins(root: string, promoCode?: string): PinSpec[] {
  const catalog = readCatalog(root);
  const tagsOf = readCatalogTags(root); // catalog.csv's ;-separated tags, which store.ts does not read
  const promo = promoCode ? `Launch offer: ${PROMO.percentage}% off with code ${promoCode} at checkout.` : undefined;

  const pins: PinSpec[] = [];
  for (const l of LISTINGS) {
    const row = catalog.get(l.catalogId);
    if (!row) throw new Error(`catalog.csv has no row ${l.catalogId}`);
    const dir = path.posix.dirname(row.designFiles[0] ?? '');
    const shade = l.nameSuffix?.includes('Light') ? '-light' : l.nameSuffix?.includes('Dark') ? '-dark' : '';
    const title = row.title + (l.nameSuffix ?? '');
    pins.push({
      key: l.key, source: 'fourthwall', board: 'gifts',
      title: clip(title, MAX_TITLE),
      description: describe(l.description ?? row.description, [...(tagsOf.get(l.catalogId) ?? []), 'gift for puzzle lover', 'sudoku gift'], promo),
      altText: clip(`Product photo: ${title}, printed with a real sudoku puzzle.`, MAX_ALT),
      image: path.join(root, STORE_DIR, dir, `mockup-preview${shade}.png`),
    });
  }
  for (const l of loadKit(root)) {
    const firstPara = l.description.split(/\n\s*\n/)[0] ?? l.description;
    pins.push({
      key: l.slug, source: 'etsy', board: 'printables',
      title: clip(l.title, MAX_TITLE),
      description: describe(firstPara, [...l.tags, 'gift for puzzle lover', 'printable puzzles']),
      altText: clip(`Cover image of the printable puzzle book: ${l.title}.`, MAX_ALT),
      image: path.join(root, KIT_DIR, l.images[0] ?? ''),
    });
  }
  return pins;
}

function readCatalogTags(root: string): Map<string, string[]> {
  const [header, ...rows] = parseCsv(fs.readFileSync(path.join(root, STORE_DIR, 'catalog.csv'), 'utf8'));
  if (!header) throw new Error('catalog.csv is empty');
  const id = header.indexOf('id');
  const tags = header.indexOf('tags');
  if (id < 0 || tags < 0) throw new Error('catalog.csv has no id/tags column');
  return new Map(rows.map((r) => [r[id] ?? '', (r[tags] ?? '').split(';').map((t) => t.trim()).filter(Boolean)]));
}

/** Every reason Pinterest would refuse this pin, read locally. */
export function validatePin(p: PinSpec): string[] {
  const out: string[] = [];
  if (!p.title || p.title.length > MAX_TITLE) out.push(`title is ${p.title.length} chars (max ${MAX_TITLE})`);
  if (!p.description || p.description.length > MAX_DESC) out.push(`description is ${p.description.length} chars (max ${MAX_DESC})`);
  if (p.altText.length > MAX_ALT) out.push(`alt text is ${p.altText.length} chars (max ${MAX_ALT})`);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(p.image); } catch { return [...out, `missing image ${p.image}`]; }
  if (bytes.byteLength > MAX_IMAGE_BYTES) out.push(`image is ${(bytes.byteLength / 1048576).toFixed(1)} MB (max 20)`);
  if (!pngSize(new Uint8Array(bytes))) out.push('image is not a PNG');
  return out;
}

// ───────────────────────────── which products are live ─────────────────────────────

export interface LiveProducts {
  urls: Map<string, string>; // item key → live product URL
  waiting: Array<{ store: 'fourthwall' | 'etsy'; why: string }>;
  promoCode?: string;
}

/** Earlier stages' results: this run's first, else the last saved results.json. */
function earlierResults(ctx: StageContext): ReadonlyArray<StageResult> {
  const now = ctx.results ?? [];
  if (now.some((r) => r.stage === 'store') && now.some((r) => r.stage === 'etsy')) return now;
  let saved: StageResult[] = [];
  try { saved = JSON.parse(fs.readFileSync(path.join(ctx.root, '.launch-out', 'results.json'), 'utf8')) as StageResult[]; } catch { /* none yet */ }
  return [...now, ...saved.filter((s) => !now.some((r) => r.stage === s.stage))];
}

/**
 * Live = the stage's own run put the item on sale. Fourthwall: the store stage
 * DONE or PARTIAL (NEEDS_OWNER means no API user yet, or a shop still "coming
 * soon" that takes no orders). Etsy: an active listing (never a draft).
 */
export function liveProducts(results: ReadonlyArray<StageResult>): LiveProducts {
  const urls = new Map<string, string>();
  const waiting: LiveProducts['waiting'] = [];
  let promoCode: string | undefined;
  const onSale = (s: StageResult['status']) => s === 'DONE' || s === 'PARTIAL';

  const store = results.find((r) => r.stage === 'store');
  if (!store) waiting.push({ store: 'fourthwall', why: 'the store stage has not reported yet' });
  else if (store.detail.startsWith('dry run')) waiting.push({ store: 'fourthwall', why: 'dry run of the store stage' });
  else if (!onSale(store.status)) waiting.push({ store: 'fourthwall', why: `store is ${store.status}: ${store.detail}` });
  else {
    for (const i of store.items) {
      if (!i.url || !['CREATED', 'UPDATED', 'EXISTS'].includes(i.state)) continue;
      if (i.note?.startsWith('access ')) continue; // exists but not PUBLIC
      urls.set(i.key, i.url);
    }
    promoCode = store.outputs?.promoCode;
  }

  const etsy = results.find((r) => r.stage === 'etsy');
  if (!etsy) waiting.push({ store: 'etsy', why: 'the etsy stage has not reported yet' });
  else if (etsy.detail.startsWith('dry run')) waiting.push({ store: 'etsy', why: 'dry run of the etsy stage' });
  else if (!onSale(etsy.status)) waiting.push({ store: 'etsy', why: `Etsy is ${etsy.status}: ${etsy.detail}` });
  else {
    for (const i of etsy.items) {
      if (!i.url || !['CREATED', 'UPDATED', 'EXISTS'].includes(i.state)) continue;
      if (/listing \d+ is \w+; left/.test(i.note ?? '')) continue; // inactive / expired / sold out
      urls.set(i.key, i.url);
    }
  }
  return { urls, waiting, ...(promoCode ? { promoCode } : {}) };
}

/** The identity of a product page: Etsy by listing id, anything else by URL without query/hash/trailing slash. */
export function linkKey(link: string): string {
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const etsy = /^\/listing\/(\d+)/.exec(u.pathname);
    if (host.endsWith('etsy.com') && etsy) return `etsy:${etsy[1]}`;
    return `${host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch { return link.trim().toLowerCase(); }
}

/** The link a pin carries: the product page with query and hash removed. */
const cleanLink = (link: string): string => { try { const u = new URL(link); u.search = ''; u.hash = ''; return u.toString(); } catch { return link; } };

// ───────────────────────────── authorization ─────────────────────────────

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const redirectUri = (env: StageContext['env']) => env['PINTEREST_REDIRECT_URI'] || DEFAULT_REDIRECT_URI;
const oauthState = (env: StageContext['env']) =>
  b64url(crypto.createHmac('sha256', env['PINTEREST_APP_SECRET'] ?? '').update(`brain-pinterest-state-v1:${env['PINTEREST_APP_ID'] ?? ''}`).digest()).slice(0, 22);

export function consentUrl(env: StageContext['env']): string {
  const q = new URLSearchParams({
    client_id: env['PINTEREST_APP_ID'] ?? '', redirect_uri: redirectUri(env), response_type: 'code',
    scope: SCOPES.join(','), state: oauthState(env),
  });
  return `${PIN_OAUTH}?${q.toString()}`;
}

interface Tokens { access: string; refresh: string }

async function tokenRequest(ctx: StageContext, body: Record<string, string>): Promise<Tokens> {
  const basic = Buffer.from(`${ctx.env['PINTEREST_APP_ID']}:${ctx.env['PINTEREST_APP_SECRET']}`).toString('base64');
  const res = await ctx.fetch(PIN_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || !json['access_token']) {
    throw new Error(`Pinterest token ${body['grant_type']} → ${res.status}: ${json['message'] ?? json['error'] ?? ''}`.trim());
  }
  return { access: String(json['access_token']), refresh: String(json['refresh_token'] ?? '') };
}

export async function exchangeRedirect(ctx: StageContext, landedUrl: string): Promise<Tokens> {
  let u: URL;
  try { u = new URL(landedUrl.trim()); } catch { throw new Error('PINTEREST_AUTH_REDIRECT_URL is not a URL'); }
  const err = u.searchParams.get('error');
  if (err) throw new Error(`Pinterest consent was refused: ${err}`);
  const code = u.searchParams.get('code');
  if (!code) throw new Error('the redirect URL has no ?code= (copy the whole address bar after clicking "Give access")');
  const state = u.searchParams.get('state');
  if (state && state !== oauthState(ctx.env)) throw new Error('the redirect URL\'s state does not match this app');
  // continuous_refresh: required for apps made before 2025-09-25, harmless for newer ones.
  return tokenRequest(ctx, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(ctx.env), continuous_refresh: 'true' });
}

export function writeRefreshToken(root: string, token: string): void {
  const out = path.join(root, REFRESH_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${token}\n`, { mode: 0o600 });
}

// ───────────────────────────── owner text ─────────────────────────────

export function setupText(): string {
  return [
    'Pinterest, one time, free (account creation and authorization only):',
    '1. Create a free Pinterest business account at https://www.pinterest.com/business/create/ (or convert an existing one: Settings → Account management → Convert to a business account). No ads, no card.',
    '2. Signed in, open https://developers.pinterest.com/apps/ → "Connect app": app name "Brain pin publisher", description "Publishes pins for my own shop\'s products", website = the Fourthwall shop URL, privacy policy = the shop\'s Privacy Policy page. Pinterest reviews the app (usually days).',
    `3. When the app shows "Trial access", open it → Configure → add the redirect URI ${DEFAULT_REDIRECT_URI} exactly, and save its App ID and App secret key as the repository secrets PINTEREST_APP_ID and PINTEREST_APP_SECRET. The next Launch run prints the authorization link.`,
  ].join('\n');
}

export function consentText(env: StageContext['env'], why = ''): string {
  return [
    `${why}Authorize Brain on your Pinterest business account (one time):`,
    `1. Open this link signed in to Pinterest and click "Give access": ${consentUrl(env)}`,
    `2. The browser lands on ${redirectUri(env)}?code=… and the page does NOT load; that is expected.`,
    '3. Copy the whole address-bar URL into GitHub → Actions → Launch → "Run workflow" → pinterest_redirect_url and press Run within a few minutes. The login then carries over from run to run.',
  ].join('\n');
}

export function upgradeText(user: string): string {
  return [
    `Pinterest authorized${user ? ` (@${user})` : ''}, but a new app has Trial access, and Pinterest shows pins made with Trial access to nobody but you. Request Standard access (one time):`,
    '1. https://developers.pinterest.com/apps/ → the app card → "Upgrade". Pinterest requires a screen recording that shows the OAuth flow and one API call: record your screen while you open the authorization link above, click "Give access", and open the Launch run whose log says "Pinterest account verified" (a terminal or browser recording is accepted).',
    '2. Pinterest reviews it by hand and emails the decision; it publishes no turnaround (developers report one to several weeks).',
    '3. When the approval email arrives, add the repository secret PINTEREST_STANDARD_ACCESS = approved. The next run pins every live product.',
  ].join('\n');
}

// ───────────────────────────── API ─────────────────────────────

class PinError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

class Pinterest {
  calls = 0;
  private readonly spacing: number;
  constructor(private readonly ctx: StageContext, private readonly access: string) {
    // PINTEREST_CALL_SPACING_MS=0 (tests) also removes the 429 back-off wait.
    this.spacing = Number(ctx.env['PINTEREST_CALL_SPACING_MS'] ?? 700);
  }

  async call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<Json> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.access}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      if (this.calls++ > 0) await sleep(this.spacing);
      const res = await this.ctx.fetch(`${PIN_API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 429 && attempt < 3) {
        // A 429 is a refusal before any effect: safe to repeat after the wait.
        const wait = Math.max(Number(res.headers.get('retry-after') ?? 1) * 1000, 2000 * 2 ** attempt);
        this.ctx.log(`pinterest: 429 on ${method} ${p.split('?')[0]}; waiting ${wait} ms`);
        await sleep(this.spacing > 0 ? Math.min(wait, 60_000) : 0);
        continue;
      }
      const text = await res.text();
      let json: Json = {};
      try { json = text ? (JSON.parse(text) as Json) : {}; } catch { json = { message: text.slice(0, 200) }; }
      if (!res.ok) throw new PinError(`Pinterest ${method} ${p.split('?')[0]} → ${res.status}: ${json['message'] ?? 'no message'}`, res.status);
      return json;
    }
  }

  async all(p: string): Promise<Json[]> {
    const out: Json[] = [];
    let bookmark: string | undefined;
    for (let page = 0; page < 100; page++) {
      const sep = p.includes('?') ? '&' : '?';
      const r = await this.call('GET', `${p}${sep}page_size=250${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`);
      out.push(...((r['items'] as Json[]) ?? []));
      bookmark = r['bookmark'] ? String(r['bookmark']) : undefined;
      if (!bookmark) break;
    }
    return out;
  }
}

// ───────────────────────────── the stage ─────────────────────────────

export async function runPinterest(ctx: StageContext): Promise<StageResult> {
  const env = ctx.env;
  let specs: PinSpec[];
  try { specs = planPins(ctx.root); } catch (e) {
    return { stage: STAGE, status: 'FAILED', detail: `pin plan unreadable: ${(e as Error).message}`, items: [] };
  }
  const problems = new Map(specs.map((p) => [p.key, validatePin(p)]));
  const invalid = [...problems.entries()].filter(([, p]) => p.length);

  if (ctx.dryRun) {
    const items: Item[] = specs.map((p) => {
      const bad = problems.get(p.key)!;
      return bad.length
        ? { key: p.key, state: 'FAILED', note: bad.join('; ') }
        : { key: p.key, state: 'WOULD_CREATE', note: `${p.source} → board "${BOARDS[p.board].name}", ${path.basename(p.image)}, title ${p.title.length}/${MAX_TITLE}, description ${p.description.length}/${MAX_DESC}` };
    });
    const auth = !env['PINTEREST_APP_ID'] || !env['PINTEREST_APP_SECRET'] ? 'no app yet'
      : env['PINTEREST_REFRESH_TOKEN'] ? 'refresh token present' : env['PINTEREST_AUTH_REDIRECT_URL'] ? 'consent redirect present' : 'app present, consent pending';
    const tier = standardAccess(env) ? 'Standard access' : 'Trial access (pins private until Standard)';
    return {
      stage: STAGE, status: invalid.length ? 'FAILED' : 'DONE', items,
      detail: `dry run: ${specs.length - invalid.length}/${specs.length} pins valid; no network calls; auth: ${auth}; ${tier}`,
    };
  }
  if (invalid.length) {
    return { stage: STAGE, status: 'FAILED', detail: `pins invalid: ${invalid.map(([k, p]) => `${k}: ${p.join('; ')}`).join(' | ')}`, items: [] };
  }
  if (!env['PINTEREST_APP_ID'] || !env['PINTEREST_APP_SECRET']) {
    return { stage: STAGE, status: 'NEEDS_OWNER', detail: 'no Pinterest app yet (PINTEREST_APP_ID + PINTEREST_APP_SECRET)', ownerAction: setupText(), items: [] };
  }

  // ── tokens ──
  let tokens: Tokens | undefined;
  const notes: string[] = [];
  if (env['PINTEREST_REFRESH_TOKEN']) {
    try { tokens = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: env['PINTEREST_REFRESH_TOKEN'] }); }
    catch (e) { notes.push(`refresh failed (${(e as Error).message})`); }
  }
  if (!tokens && env['PINTEREST_AUTH_REDIRECT_URL']) {
    try { tokens = await exchangeRedirect(ctx, env['PINTEREST_AUTH_REDIRECT_URL']); }
    catch (e) { notes.push(`code exchange failed (${(e as Error).message})`); }
  }
  if (!tokens) {
    const why = notes.length ? `Previous authorization unusable: ${notes.join('; ')}.\n` : '';
    return { stage: STAGE, status: 'NEEDS_OWNER', detail: `Pinterest consent needed${notes.length ? `: ${notes.join('; ')}` : ''}`, ownerAction: consentText(env, why), items: [] };
  }
  // Continuous refresh: the newest refresh token must reach the next run (launch.yml carries it).
  const refresh = tokens.refresh || env['PINTEREST_REFRESH_TOKEN'] || '';
  if (refresh) writeRefreshToken(ctx.root, refresh);

  const api = new Pinterest(ctx, tokens.access);
  let user: Json;
  try { user = await api.call('GET', '/user_account'); } catch (e) {
    return { stage: STAGE, status: 'FAILED', detail: `could not read the Pinterest account: ${(e as Error).message}`, items: [] };
  }
  const username = String(user['username'] ?? '');
  ctx.log(`pinterest: Pinterest account verified (@${username}, ${user['account_type'] ?? 'type unknown'})`);
  if (user['account_type'] && user['account_type'] !== 'BUSINESS') {
    return {
      stage: STAGE, status: 'NEEDS_OWNER', items: [], detail: `@${username} is a personal account`,
      ownerAction: 'Convert the authorized Pinterest account to a free business account (Settings → Account management → Convert to a business account), then re-run Launch. Nothing else changes.',
    };
  }

  // ── what is live, and the copy for it ──
  const live = liveProducts(earlierResults(ctx));
  const finalSpecs = planPins(ctx.root, live.promoCode);
  const ready = finalSpecs.filter((p) => live.urls.has(p.key));
  const waitingItems: Item[] = live.waiting.map((w) => ({ key: w.store, state: 'WAITING', note: w.why }));
  const waitNote = live.waiting.map((w) => `${w.store === 'etsy' ? 'Etsy' : 'Fourthwall'} not live yet`).join('; ');

  if (!standardAccess(env)) {
    return {
      stage: STAGE, status: 'NEEDS_OWNER', ownerAction: upgradeText(username),
      items: [...ready.map((p): Item => ({ key: p.key, state: 'WOULD_CREATE', url: live.urls.get(p.key), note: 'waits for Standard access' })), ...waitingItems],
      detail: `@${username} authorized (Trial access): ${ready.length} live products ready to pin once Standard access is approved${waitNote ? `; ${waitNote}` : ''}`,
    };
  }
  if (!ready.length) {
    return { stage: STAGE, status: 'WAITING', items: waitingItems, detail: `@${username} ready; nothing to pin yet — ${waitNote || 'no live product URLs reported'}` };
  }

  // ── boards ──
  let boards: Json[];
  let pins: Json[];
  try {
    boards = await api.all('/boards');
    pins = await api.all('/pins');
  } catch (e) {
    return { stage: STAGE, status: 'FAILED', detail: `could not list boards/pins: ${(e as Error).message}`, items: waitingItems };
  }
  const boardIds = new Map<BoardKey, string>();
  const items: Item[] = [];
  for (const key of [...new Set(ready.map((p) => p.board))]) {
    const b = BOARDS[key];
    const found = boards.find((x) => String(x['name'] ?? '').trim().toLowerCase() === b.name.toLowerCase());
    if (found) { boardIds.set(key, String(found['id'])); continue; }
    try {
      const made = await api.call('POST', '/boards', { name: b.name, description: b.description, privacy: 'PUBLIC' });
      boardIds.set(key, String(made['id']));
      items.push({ key: `board:${b.name}`, state: 'CREATED' });
    } catch (e) {
      items.push({ key: `board:${b.name}`, state: 'FAILED', note: (e as Error).message });
    }
  }

  // ── pins, by link ──
  const pinned = new Map(pins.filter((p) => p['link']).map((p) => [linkKey(String(p['link'])), p]));
  for (const p of ready) {
    const link = cleanLink(live.urls.get(p.key)!);
    const have = pinned.get(linkKey(link));
    if (have) { items.push({ key: p.key, state: 'EXISTS', url: pinUrl(have), note: `→ ${link}` }); continue; }
    const boardId = boardIds.get(p.board);
    if (!boardId) { items.push({ key: p.key, state: 'FAILED', note: `board "${BOARDS[p.board].name}" unavailable` }); continue; }
    try {
      const made = await api.call('POST', '/pins', {
        board_id: boardId, link, title: p.title, description: p.description, alt_text: p.altText,
        media_source: { source_type: 'image_base64', content_type: 'image/png', data: fs.readFileSync(p.image).toString('base64') },
      });
      pinned.set(linkKey(link), made);
      items.push({ key: p.key, state: 'CREATED', url: pinUrl(made), note: `→ ${link}` });
    } catch (e) {
      items.push({ key: p.key, state: 'FAILED', note: (e as Error).message });
    }
  }
  items.push(...waitingItems);

  const failed = items.filter((i) => i.state === 'FAILED').length;
  const done = items.filter((i) => i.state === 'CREATED' || i.state === 'EXISTS').length;
  const count = (s: Item['state']) => items.filter((i) => i.state === s && !i.key.startsWith('board:')).length;
  const detail = `@${username}: ${count('CREATED')} pinned, ${count('EXISTS')} already pinned, ${count('FAILED')} failed` +
    `${live.promoCode ? ` · code ${live.promoCode} in store pins` : ''}${waitNote ? ` · ${waitNote}` : ''} · ${api.calls} API calls`;
  const status: StageResult['status'] = failed ? (done ? 'PARTIAL' : 'FAILED') : live.waiting.length ? 'WAITING' : 'DONE';
  return { stage: STAGE, status, detail, items };
}

const standardAccess = (env: StageContext['env']) => /^(approved|standard|yes|true|1)$/i.test(env['PINTEREST_STANDARD_ACCESS']?.trim() ?? '');
const pinUrl = (p: Json): string | undefined => (p['id'] ? `https://www.pinterest.com/pin/${p['id']}/` : undefined);

// ───────────────────────────── CLI ─────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const ctx: StageContext = { env: process.env, dryRun: mode !== 'run', fetch, log: (l) => console.error(l), root };
  if (mode === 'authorize') {
    console.log(process.env['PINTEREST_APP_ID'] && process.env['PINTEREST_APP_SECRET'] ? consentText(process.env) : setupText());
    process.exit(0);
  }
  if (mode !== 'dry-run' && mode !== 'run') { console.error('usage: pinterest.ts dry-run | authorize | run'); process.exit(1); }
  runPinterest(ctx)
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'FAILED' ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
