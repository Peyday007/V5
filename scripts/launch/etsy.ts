/**
 * Etsy stage of the launch runner: publish the 8 digital-download listings in
 * fast-cash/launch-2026-11-11/etsy/ through the Etsy Open API v3, so the owner
 * never builds a listing by hand.
 *
 * What the owner does, once: open the shop, create a Seller App at
 * etsy.com/developers (approved within minutes for an active shop), register
 * the callback URL, give the workflow the keystring and shared secret, click
 * the consent URL this stage prints, and hand back the URL his browser landed
 * on. Everything after that is this file.
 *
 * Authorization without a server: the PKCE verifier and the `state` are
 * derived from the shared secret (HMAC), so whichever process prints the
 * consent URL and whichever later process exchanges the code agree on them
 * without storing anything. The redirect target never has to load: the code
 * is read from the URL in the address bar. Refresh tokens rotate, so every
 * refresh writes the new one to `.launch-out/etsy-refresh-token` for the
 * workflow to store back as ETSY_REFRESH_TOKEN.
 *
 * Idempotent by title: a run lists every listing in the shop (any state), and
 * a kit listing whose title is already there is not created again; a match
 * that is missing photos, files or tags is completed, and a matching draft is
 * published. Only a 429 is retried (the request had no effect); a create
 * whose outcome is unknown is never retried in-run — the next run finds it by
 * title instead.
 *
 * API facts (Open API v3, checked 2026-11-11 against developers.etsy.com and
 * the published OpenAPI spec www.etsy.com/openapi/generated/oas/3.0.0.json):
 *   - every request: `x-api-key: <keystring>:<shared secret>` (mandatory since
 *     2026-02-09, github.com/etsy/open-api/discussions/1529)
 *   - OAuth 2 authorization code + PKCE S256; access token 3600 s, refresh 90 d
 *   - createDraftListing requires quantity, title, description, price,
 *     who_made, when_made, taxonomy_id; type=download needs no shipping or
 *     processing profile; a download can only be activated with a file and an
 *     image attached.
 *
 *   npx tsx scripts/launch/etsy.ts dry-run | authorize | exchange <url> | run
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types.ts';

export const ETSY_API = 'https://api.etsy.com/v3';
export const ETSY_CONNECT = 'https://www.etsy.com/oauth/connect';
export const ETSY_TOKEN_URL = `${ETSY_API}/public/oauth/token`;
export const KIT_DIR = 'fast-cash/launch-2026-11-11/etsy';
/** Etsy's own quick-start tutorial value; the page never has to load. */
export const DEFAULT_REDIRECT_URI = 'http://localhost:3003/oauth/redirect';
export const SCOPES = ['listings_r', 'listings_w', 'shops_r'];
export const REFRESH_OUT = '.launch-out/etsy-refresh-token';

// Etsy limits (help.etsy.com digital listings; OpenAPI spec field descriptions).
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_IMAGES = 20; // spec: "image_ids … can include up to 20 images"
const MAX_TITLE = 140;
const MAX_TAGS = 13;
const MAX_TAG_LEN = 20;
const TITLE_BAD = /[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u;
const TAG_BAD = /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u;

type Json = Record<string, any>;
type Item = StageResult['items'][number];

// ───────────────────────────── the kit ─────────────────────────────

export interface KitListing {
  order: number;
  slug: string;
  title: string;
  price: number;
  quantity: number;
  type: 'download';
  whoMade: 'i_did' | 'someone_else' | 'collective';
  whenMade: string;
  isSupply: boolean;
  categoryPath: string[];
  taxonomyId: number;
  tags: string[];
  materials: string[];
  files: string[]; // relative to the kit dir
  images: string[]; // relative to the kit dir, in rank order
  description: string;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const WHO: Record<string, KitListing['whoMade']> = { 'i did': 'i_did', 'someone else': 'someone_else', 'a member of my shop': 'collective', collective: 'collective' };

function whenMade(v: string): string {
  const t = v.trim().toLowerCase();
  if (t === 'made to order') return 'made_to_order';
  const m = /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(t);
  if (m) return `${m[1]}_${m[2]}`;
  return t.replace(/\s+/g, '_');
}

const splitList = (v: string, sep: string) => v.split(sep).map((s) => s.trim()).filter(Boolean);

export function loadKit(root: string): KitListing[] {
  const csv = fs.readFileSync(path.join(root, KIT_DIR, 'listings.csv'), 'utf8');
  const [header, ...rows] = parseCsv(csv);
  if (!header) throw new Error('listings.csv is empty');
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`listings.csv has no column ${name}`);
    return r[i] ?? '';
  };
  return rows.map((r) => {
    const type = col(r, 'type').trim().toLowerCase();
    if (type !== 'digital files') throw new Error(`${col(r, 'slug')}: type "${col(r, 'type')}" is not a digital listing`);
    return {
      order: Number(col(r, 'listing_order')),
      slug: col(r, 'slug'),
      title: col(r, 'title'),
      price: Number(col(r, 'price_usd')),
      quantity: Number(col(r, 'quantity')),
      type: 'download' as const,
      whoMade: WHO[col(r, 'who_made').trim().toLowerCase()] ?? ('' as KitListing['whoMade']),
      whenMade: whenMade(col(r, 'when_made')),
      isSupply: col(r, 'what_is_it').trim().toLowerCase() === 'a supply or tool to make things',
      categoryPath: splitList(col(r, 'category'), '>'),
      taxonomyId: Number(col(r, 'taxonomy_id')),
      tags: splitList(col(r, 'tags'), ','),
      materials: splitList(col(r, 'materials'), ','),
      files: splitList(col(r, 'files'), '|'),
      images: splitList(col(r, 'images_in_order'), '|'),
      description: col(r, 'description'),
    };
  });
}

const WHEN_ALLOWED = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007', '2000_2006', '1990s', '1980s', '1970s', '1960s', '1950s', '1940s', '1930s', '1920s', '1910s', '1900s', '1800s', '1700s', 'before_1700'];

/** Every reason Etsy (or the upload) would refuse this listing, read locally. */
export function validateListing(root: string, l: KitListing): string[] {
  const p: string[] = [];
  if (!l.title || l.title.length > MAX_TITLE) p.push(`title is ${l.title.length} chars (max ${MAX_TITLE})`);
  if (TITLE_BAD.test(l.title)) p.push('title has a character Etsy refuses');
  for (const ch of ['%', ':', '&', '+']) if (l.title.split(ch).length > 2) p.push(`title uses "${ch}" more than once`);
  if (!Number.isFinite(l.price) || l.price <= 0) p.push(`price "${l.price}" is not a positive number`);
  else if (Math.abs(l.price * 100 - Math.round(l.price * 100)) > 1e-6) p.push('price has more than 2 decimals');
  if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 999) p.push(`quantity ${l.quantity} not in 1..999`);
  if (!l.whoMade) p.push('who_made not recognized');
  if (!WHEN_ALLOWED.includes(l.whenMade)) p.push(`when_made "${l.whenMade}" is not an Etsy value`);
  if (!Number.isInteger(l.taxonomyId) || l.taxonomyId <= 0) p.push('taxonomy_id missing');
  if (!l.description.trim()) p.push('description empty');
  if (l.tags.length > MAX_TAGS) p.push(`${l.tags.length} tags (max ${MAX_TAGS})`);
  if (new Set(l.tags.map((t) => t.toLowerCase())).size !== l.tags.length) p.push('duplicate tags');
  for (const t of l.tags) {
    if (t.length > MAX_TAG_LEN) p.push(`tag "${t}" is ${t.length} chars (max ${MAX_TAG_LEN})`);
    if (TAG_BAD.test(t)) p.push(`tag "${t}" has a character Etsy refuses`);
  }
  if (l.files.length < 1 || l.files.length > MAX_FILES) p.push(`${l.files.length} files (need 1..${MAX_FILES})`);
  if (new Set(l.files.map((f) => path.basename(f))).size !== l.files.length) p.push('two files share a filename');
  if (l.images.length < 1 || l.images.length > MAX_IMAGES) p.push(`${l.images.length} images (need 1..${MAX_IMAGES})`);
  for (const rel of [...l.files, ...l.images]) {
    const abs = path.join(root, KIT_DIR, rel);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { p.push(`missing file ${rel}`); continue; }
    if (!st.isFile() || st.size === 0) p.push(`empty file ${rel}`);
    else if (st.size >= MAX_FILE_BYTES) p.push(`${rel} is ${(st.size / 1048576).toFixed(1)} MB (max 20 MB)`);
  }
  return p;
}

// ───────────────────────────── authorization ─────────────────────────────

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Deterministic: same app secret → same verifier, in any process, with nothing stored. */
export function pkceVerifier(env: StageContext['env']): string {
  if (env['ETSY_PKCE_VERIFIER']) return env['ETSY_PKCE_VERIFIER'];
  const key = env['ETSY_API_KEY'] ?? '';
  const secret = env['ETSY_SHARED_SECRET'] ?? '';
  return b64url(crypto.createHmac('sha256', secret).update(`brain-etsy-pkce-v1:${key}`).digest()); // 43 chars
}

function oauthState(env: StageContext['env']): string {
  return b64url(crypto.createHmac('sha256', env['ETSY_SHARED_SECRET'] ?? '').update(`brain-etsy-state-v1:${env['ETSY_API_KEY'] ?? ''}`).digest()).slice(0, 22);
}

export const redirectUri = (env: StageContext['env']) => env['ETSY_REDIRECT_URI'] || DEFAULT_REDIRECT_URI;

export function consentUrl(env: StageContext['env']): string {
  const challenge = b64url(crypto.createHash('sha256').update(pkceVerifier(env)).digest());
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env['ETSY_API_KEY'] ?? '',
    redirect_uri: redirectUri(env),
    scope: SCOPES.join(' '),
    state: oauthState(env),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${ETSY_CONNECT}?${q.toString().replace(/\+/g, '%20')}`;
}

const apiKeyHeader = (env: StageContext['env']) => `${env['ETSY_API_KEY']}:${env['ETSY_SHARED_SECRET']}`;

interface Tokens { access: string; refresh: string }

async function tokenRequest(ctx: StageContext, body: Record<string, string>): Promise<Tokens> {
  const res = await ctx.fetch(ETSY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'x-api-key': apiKeyHeader(ctx.env) },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || !json['access_token']) {
    throw new Error(`Etsy token ${body['grant_type']} → ${res.status}: ${json['error'] ?? ''} ${json['error_description'] ?? ''}`.trim());
  }
  return { access: String(json['access_token']), refresh: String(json['refresh_token'] ?? '') };
}

/** Trade the URL the browser landed on (…?code=…&state=…) for tokens. */
export async function exchangeRedirect(ctx: StageContext, landedUrl: string): Promise<Tokens> {
  let u: URL;
  try { u = new URL(landedUrl.trim()); } catch { throw new Error('ETSY_AUTH_REDIRECT_URL is not a URL'); }
  const err = u.searchParams.get('error');
  if (err) throw new Error(`Etsy consent was refused: ${err} ${u.searchParams.get('error_description') ?? ''}`.trim());
  const code = u.searchParams.get('code');
  if (!code) throw new Error('the redirect URL has no ?code= (copy the whole address bar after clicking Allow)');
  const state = u.searchParams.get('state');
  if (state && state !== oauthState(ctx.env)) throw new Error('the redirect URL\'s state does not match this app (consent URL from a different key/secret)');
  return tokenRequest(ctx, {
    grant_type: 'authorization_code',
    client_id: ctx.env['ETSY_API_KEY'] ?? '',
    redirect_uri: redirectUri(ctx.env),
    code,
    code_verifier: pkceVerifier(ctx.env),
  });
}

export function writeRefreshToken(root: string, token: string): string {
  const out = path.join(root, REFRESH_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${token}\n`, { mode: 0o600 });
  return out;
}

// ───────────────────────────── API calls ─────────────────────────────

class EtsyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

class Etsy {
  calls = 0;
  private readonly spacing: number;
  constructor(private readonly ctx: StageContext, private readonly access: string) {
    // ETSY_CALL_SPACING_MS=0 (tests) also removes the 429 back-off wait.
    this.spacing = Number(ctx.env['ETSY_CALL_SPACING_MS'] ?? 250);
  }

  async call(method: 'GET' | 'POST' | 'PATCH', p: string, body?: URLSearchParams | FormData): Promise<Json> {
    const headers: Record<string, string> = { 'x-api-key': apiKeyHeader(this.ctx.env), Authorization: `Bearer ${this.access}` };
    if (body instanceof URLSearchParams) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    for (let attempt = 0; ; attempt++) {
      if (this.calls++ > 0) await sleep(this.spacing); // stay far below Etsy's per-second limit
      const res = await this.ctx.fetch(`${ETSY_API}${p}`, { method, headers, body: body instanceof URLSearchParams ? body.toString() : body });
      if (res.status === 429 && attempt < 4) {
        // A 429 is a refusal before any effect: safe to repeat after the advertised wait.
        const wait = Math.max(Number(res.headers.get('retry-after') ?? 1) * 1000, 1000 * 2 ** attempt);
        this.ctx.log(`etsy: 429 on ${method} ${p.split('?')[0]}; waiting ${wait} ms`);
        await sleep(this.spacing > 0 ? Math.min(wait, 60_000) : 0);
        continue;
      }
      const text = await res.text();
      let json: Json = {};
      try { json = text ? (JSON.parse(text) as Json) : {}; } catch { json = { error: text.slice(0, 300) }; }
      if (!res.ok) throw new EtsyError(`Etsy ${method} ${p.split('?')[0]} → ${res.status}: ${json['error'] ?? 'no message'}`, res.status);
      return json;
    }
  }
}

function readBlob(root: string, rel: string, type: string): Blob {
  return new Blob([fs.readFileSync(path.join(root, KIT_DIR, rel))], { type });
}

const normTitle = (t: string) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
// The API returns titles HTML-escaped in some fields; compare unescaped.
const unescape = (t: string) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function findNode(nodes: Json[], names: string[]): Json | undefined {
  let level = nodes;
  let node: Json | undefined;
  for (const name of names) {
    node = level.find((n) => normTitle(String(n['name'])) === normTitle(name));
    if (!node) return undefined;
    level = (node['children'] as Json[]) ?? [];
  }
  return node;
}

function hasNode(nodes: Json[], id: number): boolean {
  for (const n of nodes) if (n['id'] === id || hasNode((n['children'] as Json[]) ?? [], id)) return true;
  return false;
}

// ───────────────────────────── the stage ─────────────────────────────

const STAGE = 'etsy';

function ownerSetupText(env: StageContext['env']): string {
  return [
    'One-time Etsy API setup (after your shop is open):',
    '1. Signed in as the shop owner, open https://www.etsy.com/developers/register and choose "Create a seller app" (name: anything, e.g. "Brain launcher"; description: "Uploads and publishes my own shop\'s digital listings").',
    `2. In https://www.etsy.com/developers/your-apps open the app and add this callback URL exactly: ${redirectUri(env)}`,
    '3. Copy the app\'s Keystring and Shared secret into the repository secrets ETSY_API_KEY and ETSY_SHARED_SECRET, then re-run the launch workflow.',
  ].join('\n');
}

function consentText(env: StageContext['env'], why = ''): string {
  return [
    `${why}Authorize Brain on your shop (one time):`,
    `1. Open this link signed in to Etsy and click "Grant access": ${consentUrl(env)}`,
    `2. Your browser lands on ${redirectUri(env)}?code=… — the page will NOT load ("can't be reached"); that is expected.`,
    '3. Copy the whole address-bar URL, open GitHub → Actions → Launch → "Run workflow", paste it into "etsy_redirect_url" and press Run, within about 5 minutes (the code is short-lived; if it expires, click the link again). Brain publishes every listing in that run.',
  ].join('\n');
}

export async function runEtsy(ctx: StageContext): Promise<StageResult> {
  const env = ctx.env;
  let kit: KitListing[];
  try { kit = loadKit(ctx.root); } catch (e) {
    return { stage: STAGE, status: 'FAILED', detail: `kit unreadable: ${(e as Error).message}`, items: [] };
  }
  const problems = new Map(kit.map((l) => [l.slug, validateListing(ctx.root, l)]));
  const invalid = [...problems.entries()].filter(([, p]) => p.length);

  if (ctx.dryRun) {
    const items: Item[] = kit.map((l) => {
      const p = problems.get(l.slug)!;
      return p.length
        ? { key: l.slug, state: 'FAILED', note: p.join('; ') }
        : { key: l.slug, state: 'WOULD_CREATE', note: `$${l.price.toFixed(2)}, ${l.images.length} images, ${l.files.length} file(s), ${l.tags.length} tags, taxonomy ${l.taxonomyId}` };
    });
    const auth = !env['ETSY_API_KEY'] || !env['ETSY_SHARED_SECRET'] ? 'no API key yet' : env['ETSY_REFRESH_TOKEN'] ? 'refresh token present' : env['ETSY_AUTH_REDIRECT_URL'] ? 'consent redirect present' : 'key present, consent pending';
    return {
      stage: STAGE,
      status: invalid.length ? 'FAILED' : 'DONE',
      detail: `dry run: ${kit.length - invalid.length}/${kit.length} listings valid; no network calls; auth: ${auth}`,
      items,
    };
  }

  if (invalid.length) {
    return { stage: STAGE, status: 'FAILED', detail: `kit invalid: ${invalid.map(([s, p]) => `${s}: ${p.join('; ')}`).join(' | ')}`, items: [] };
  }
  if (!env['ETSY_API_KEY'] || !env['ETSY_SHARED_SECRET']) {
    return { stage: STAGE, status: 'NEEDS_OWNER', detail: 'no Etsy app credentials (ETSY_API_KEY + ETSY_SHARED_SECRET)', ownerAction: ownerSetupText(env), items: [] };
  }

  // ── tokens ──
  let tokens: Tokens | undefined;
  const notes: string[] = [];
  if (env['ETSY_REFRESH_TOKEN']) {
    try {
      tokens = await tokenRequest(ctx, { grant_type: 'refresh_token', client_id: env['ETSY_API_KEY'], refresh_token: env['ETSY_REFRESH_TOKEN'] });
    } catch (e) { notes.push(`refresh failed (${(e as Error).message})`); }
  }
  if (!tokens && env['ETSY_AUTH_REDIRECT_URL']) {
    try { tokens = await exchangeRedirect(ctx, env['ETSY_AUTH_REDIRECT_URL']); } catch (e) { notes.push(`code exchange failed (${(e as Error).message})`); }
  }
  if (!tokens) {
    const why = notes.length ? `Previous authorization unusable: ${notes.join('; ')}.\n` : '';
    return { stage: STAGE, status: 'NEEDS_OWNER', detail: `Etsy consent needed${notes.length ? `: ${notes.join('; ')}` : ''}`, ownerAction: consentText(env, why), items: [] };
  }
  let tokenNote = '';
  if (tokens.refresh) {
    const out = writeRefreshToken(ctx.root, tokens.refresh);
    tokenNote = ` Refresh token rotated → ${path.relative(ctx.root, out)} (store it back as ETSY_REFRESH_TOKEN; valid 90 days).`;
  }

  const api = new Etsy(ctx, tokens.access);

  // ── shop ──
  let shopId: number;
  try {
    const me = await api.call('GET', '/application/users/me');
    shopId = Number(me['shop_id'] ?? 0);
    if (!shopId) shopId = Number((await api.call('GET', `/application/users/${me['user_id']}/shops`))['shop_id'] ?? 0);
  } catch (e) {
    if (e instanceof EtsyError && e.status === 404) shopId = 0;
    else return { stage: STAGE, status: 'FAILED', detail: `could not read the shop: ${(e as Error).message}.${tokenNote}`, items: [] };
  }
  if (!shopId) {
    return { stage: STAGE, status: 'NEEDS_OWNER', detail: `the authorized Etsy account has no shop yet.${tokenNote}`, ownerAction: 'Finish opening the Etsy shop (SHOP-SETUP.md §6 steps 1–10), signed in as the same account that granted access, then re-run the launch workflow.', items: [] };
  }

  // ── taxonomy: confirm the CSV id against Etsy's live seller taxonomy ──
  const taxonomy = new Map<string, number>();
  try {
    const nodes = ((await api.call('GET', '/application/seller-taxonomy/nodes'))['results'] as Json[]) ?? [];
    for (const l of kit) {
      const key = l.categoryPath.join(' > ');
      if (taxonomy.has(key)) continue;
      const byPath = findNode(nodes, l.categoryPath);
      if (byPath) taxonomy.set(key, Number(byPath['id']));
      else if (hasNode(nodes, l.taxonomyId)) taxonomy.set(key, l.taxonomyId);
      else notes.push(`category "${key}" not found in Etsy's taxonomy; using CSV id ${l.taxonomyId}`);
    }
  } catch (e) { notes.push(`taxonomy lookup failed (${(e as Error).message}); using CSV ids`); }

  // ── what is already in the shop (any state) ──
  const existing = new Map<string, Json>();
  try {
    for (const state of ['active', 'draft', 'inactive', 'expired', 'sold_out']) {
      for (let offset = 0; ; offset += 100) {
        const page = await api.call('GET', `/application/shops/${shopId}/listings?state=${state}&limit=100&offset=${offset}`);
        const results = (page['results'] as Json[]) ?? [];
        for (const r of results) {
          const k = normTitle(unescape(String(r['title'] ?? '')));
          if (!existing.has(k) || r['state'] === 'active') existing.set(k, r);
        }
        if (results.length < 100) break;
      }
    }
  } catch (e) {
    return { stage: STAGE, status: 'FAILED', detail: `could not list the shop's listings: ${(e as Error).message}.${tokenNote}`, items: [] };
  }

  const items: Item[] = [];
  const refused: string[] = [];
  for (const l of [...kit].sort((a, b) => a.order - b.order)) {
    const taxonomyId = taxonomy.get(l.categoryPath.join(' > ')) ?? l.taxonomyId;
    const found = existing.get(normTitle(l.title));
    try {
      items.push(found ? await finish(ctx, api, shopId, l, found, refused) : await create(ctx, api, shopId, l, taxonomyId, refused));
    } catch (e) {
      items.push({ key: l.slug, state: 'FAILED', note: (e as Error).message });
    }
  }

  const failed = items.filter((i) => i.state === 'FAILED').length;
  const ok = items.length - failed;
  const status: StageResult['status'] = failed === 0 && refused.length === 0 ? 'DONE' : ok === 0 && refused.length === 0 ? 'FAILED' : 'PARTIAL';
  const counts = (['CREATED', 'EXISTS', 'UPDATED', 'FAILED'] as const).map((s) => `${items.filter((i) => i.state === s).length} ${s.toLowerCase()}`).join(', ');
  const result: StageResult = {
    stage: STAGE,
    status,
    detail: `shop ${shopId}: ${counts}${refused.length ? `; Etsy refused publishing (drafts kept): ${[...new Set(refused)].join(' | ')}` : ''}${notes.length ? `; notes: ${notes.join('; ')}` : ''}.${tokenNote} ${api.calls} API calls.`,
    items,
  };
  if (refused.length) {
    result.ownerAction = `Etsy kept the listings as drafts because: ${[...new Set(refused)].join(' | ')}. Fix that in Shop Manager (usually: finish shop opening / billing card / identity check), then re-run the launch workflow — it publishes the drafts without re-uploading.`;
  }
  return result;
}

const listingUrl = (j: Json) => String(j['url'] ?? `https://www.etsy.com/listing/${j['listing_id']}`);

async function create(ctx: StageContext, api: Etsy, shopId: number, l: KitListing, taxonomyId: number, refused: string[]): Promise<Item> {
  const body = new URLSearchParams({
    quantity: String(l.quantity),
    title: l.title,
    description: l.description,
    price: l.price.toFixed(2),
    who_made: l.whoMade,
    when_made: l.whenMade,
    taxonomy_id: String(taxonomyId),
    type: 'download',
    is_supply: String(l.isSupply),
    should_auto_renew: 'true',
    tags: l.tags.join(','),
  });
  if (l.materials.length) body.set('materials', l.materials.join(','));
  const draft = await api.call('POST', `/application/shops/${shopId}/listings`, body);
  const id = Number(draft['listing_id']);
  ctx.log(`etsy: draft ${id} created for ${l.slug}`);
  try {
    await attach(ctx, api, shopId, id, l, new Set(), new Set());
  } catch (e) {
    return { key: l.slug, state: 'FAILED', url: listingUrl(draft), note: `draft ${id} created, uploads failed: ${(e as Error).message} (next run completes it)` };
  }
  const pub = await publish(api, shopId, id, refused);
  return { key: l.slug, state: pub.ok ? 'CREATED' : 'FAILED', url: listingUrl(pub.listing ?? draft), note: pub.ok ? `listing ${id} published` : `draft ${id} complete, not published: ${pub.reason}` };
}

async function attach(ctx: StageContext, api: Etsy, shopId: number, id: number, l: KitListing, haveRanks: Set<number>, haveFiles: Set<string>): Promise<string[]> {
  const done: string[] = [];
  for (const [i, rel] of l.images.entries()) {
    if (haveRanks.has(i + 1)) continue;
    const fd = new FormData();
    fd.append('image', readBlob(ctx.root, rel, 'image/png'), path.basename(rel));
    fd.append('rank', String(i + 1));
    fd.append('overwrite', 'true');
    await api.call('POST', `/application/shops/${shopId}/listings/${id}/images`, fd);
    done.push(`image ${i + 1}`);
  }
  for (const [i, rel] of l.files.entries()) {
    const name = path.basename(rel);
    if (haveFiles.has(name.toLowerCase())) continue;
    const fd = new FormData();
    fd.append('file', readBlob(ctx.root, rel, 'application/pdf'), name);
    fd.append('name', name);
    fd.append('rank', String(i + 1));
    await api.call('POST', `/application/shops/${shopId}/listings/${id}/files`, fd);
    done.push(name);
  }
  return done;
}

async function publish(api: Etsy, shopId: number, id: number, refused: string[]): Promise<{ ok: boolean; reason?: string; listing?: Json }> {
  try {
    const listing = await api.call('PATCH', `/application/shops/${shopId}/listings/${id}`, new URLSearchParams({ state: 'active' }));
    return { ok: true, listing };
  } catch (e) {
    if (e instanceof EtsyError && e.status >= 400 && e.status < 500 && e.status !== 401) {
      refused.push(e.message.replace(/^Etsy PATCH \S+ → /, ''));
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

/** A kit listing already in the shop: complete what is missing; publish it if it is a draft. */
async function finish(ctx: StageContext, api: Etsy, shopId: number, l: KitListing, found: Json, refused: string[]): Promise<Item> {
  const id = Number(found['listing_id']);
  const state = String(found['state'] ?? '');
  if (state !== 'active' && state !== 'draft') {
    return { key: l.slug, state: 'EXISTS', url: listingUrl(found), note: `listing ${id} is ${state}; left as the owner set it` };
  }
  const images = ((await api.call('GET', `/application/listings/${id}/images`))['results'] as Json[]) ?? [];
  const files = ((await api.call('GET', `/application/shops/${shopId}/listings/${id}/files`))['results'] as Json[]) ?? [];
  const done = await attach(ctx, api, shopId, id, l,
    new Set(images.map((i) => Number(i['rank']))),
    new Set(files.map((f) => String(f['filename'] ?? '').toLowerCase())));
  const tags = (found['tags'] as string[] | undefined) ?? [];
  if (tags.length === 0) {
    await api.call('PATCH', `/application/shops/${shopId}/listings/${id}`, new URLSearchParams({ tags: l.tags.join(',') }));
    done.push('tags');
  }
  if (state === 'draft') {
    const pub = await publish(api, shopId, id, refused);
    if (!pub.ok) return { key: l.slug, state: 'FAILED', url: listingUrl(found), note: `draft ${id}${done.length ? ` completed (${done.join(', ')})` : ''}, not published: ${pub.reason}` };
    done.push('published');
  }
  return done.length
    ? { key: l.slug, state: 'UPDATED', url: listingUrl(found), note: `listing ${id}: added ${done.join(', ')}` }
    : { key: l.slug, state: 'EXISTS', url: listingUrl(found), note: `listing ${id} already ${state} and complete` };
}

// ───────────────────────────── CLI ─────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const ctx: StageContext = { env: process.env, dryRun: mode !== 'run', fetch, log: (l) => console.error(l), root };
  const main = async (): Promise<number> => {
    if (mode === 'authorize') {
      if (!process.env['ETSY_API_KEY'] || !process.env['ETSY_SHARED_SECRET']) { console.log(ownerSetupText(process.env)); return 1; }
      console.log(consentText(process.env));
      return 0;
    }
    if (mode === 'exchange') {
      const url = process.argv[3] ?? process.env['ETSY_AUTH_REDIRECT_URL'];
      if (!url) { console.error('usage: etsy.ts exchange "<the URL your browser landed on>"'); return 1; }
      const t = await exchangeRedirect(ctx, url);
      const out = writeRefreshToken(root, t.refresh);
      console.log(`Refresh token (store as the secret ETSY_REFRESH_TOKEN; also written to ${out}):\n${t.refresh}`);
      return 0;
    }
    if (mode !== 'dry-run' && mode !== 'run') { console.error('usage: etsy.ts dry-run | authorize | exchange <url> | run'); return 1; }
    const r = await runEtsy(ctx);
    console.log(JSON.stringify(r, null, 2));
    return r.status === 'FAILED' ? 1 : 0;
  };
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
