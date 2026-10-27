/**
 * Broken money paths: named local businesses whose website is losing them
 * customers today, found and proved by plain code.
 *
 * The businesses come from OpenStreetMap through the public Overpass API —
 * each one has a real name, a city and a website somebody mapped. Code then
 * opens each website and records only what it can show: the security
 * certificate is invalid (visitors get a full-page warning), the address does
 * not resolve, the server refuses or answers an error, the home page is gone,
 * or the domain is parked for sale. A timeout, a bot block or anything else
 * code cannot tell apart from our own network is recorded as nothing.
 *
 * A problem becomes a lead only after it is seen on two checks at least an
 * hour apart. Then it is filed once as a feed item, and from there it goes
 * through the same shortlist and Claude verification as every other lead.
 * Nothing here contacts anybody.
 */
import { getDb } from '../../db/database.ts';
import { newId } from '../../repos/util.ts';
import { insertFeedItems, pullState, recordFeedPull } from '../../repos/feeds.ts';

export const SITE_SOURCE = 'broken-site';

/** Metro areas to look in, as bounding boxes [south, west, north, east]. No state names: a lead line must name none. */
export const METROS: readonly { id: string; city: string; bbox: [number, number, number, number] }[] = [
  { id: 'phoenix', city: 'Phoenix', bbox: [33.29, -112.32, 33.72, -111.86] },
  { id: 'dallas', city: 'Dallas', bbox: [32.62, -97.0, 33.02, -96.55] },
  { id: 'atlanta', city: 'Atlanta', bbox: [33.65, -84.55, 33.89, -84.29] },
  { id: 'tampa', city: 'Tampa', bbox: [27.86, -82.58, 28.14, -82.33] },
  { id: 'denver', city: 'Denver', bbox: [39.61, -105.11, 39.91, -104.77] },
  { id: 'charlotte', city: 'Charlotte', bbox: [35.08, -80.98, 35.39, -80.66] },
  { id: 'nashville', city: 'Nashville', bbox: [36.03, -86.99, 36.31, -86.6] },
  { id: 'austin', city: 'Austin', bbox: [30.13, -97.94, 30.52, -97.56] },
  { id: 'houston', city: 'Houston', bbox: [29.58, -95.65, 29.96, -95.2] },
  { id: 'orlando', city: 'Orlando', bbox: [28.39, -81.51, 28.62, -81.22] },
  { id: 'las-vegas', city: 'Las Vegas', bbox: [36.03, -115.33, 36.3, -115.04] },
  { id: 'san-antonio', city: 'San Antonio', bbox: [29.3, -98.71, 29.62, -98.33] },
];

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Each metro is mapped again at most weekly; the map does not change faster. */
export const METRO_INTERVAL_MS = 7 * 86_400_000;
/** And Overpass is asked at most this often, whichever metro is due. */
export const OVERPASS_SPACING_MS = 30 * 60_000;
/** A problem must still be there this long after it was first seen. */
export const CONFIRM_AFTER_MS = 60 * 60_000;
/** A healthy site is looked at again after this long. */
export const RECHECK_HEALTHY_MS = 14 * 86_400_000;
export const SITES_PER_PASS = 40;
const SITE_PARALLEL = 8;
const SITE_TIMEOUT_MS = 12_000;
const MAX_BODY = 200_000;

/** The Overpass query for one metro: named businesses with a website, of kinds that sell to people. */
export function overpassQuery(bbox: [number, number, number, number]): string {
  const b = bbox.join(',');
  return (
    '[out:json][timeout:90];(' +
    `nwr["website"]["name"]["shop"](${b});` +
    `nwr["website"]["name"]["craft"](${b});` +
    `nwr["website"]["name"]["amenity"~"^(restaurant|cafe|fast_food|bar|dentist|doctors|clinic|veterinary|car_repair|car_wash|childcare|driving_school|fuel)$"](${b});` +
    `nwr["website"]["name"]["leisure"~"^(fitness_centre|sports_centre)$"](${b});` +
    `nwr["website"]["name"]["office"~"^(estate_agent|insurance|lawyer|accountant|tax_advisor)$"](${b});` +
    ');out tags 600;'
  );
}

export interface MappedBusiness {
  key: string;
  name: string;
  category: string | null;
  website: string;
  phone: string | null;
}

/** Normalise a mapped website to an absolute URL, or null when it is not one. */
export function normaliseWebsite(raw: string): string | null {
  const value = raw.trim().split(/[;\s]/)[0] ?? '';
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Overpass JSON to businesses. Never throws on a strange body. */
export function parseOverpass(body: unknown): MappedBusiness[] {
  const elements = body && typeof body === 'object' ? (body as Record<string, unknown>)['elements'] : null;
  if (!Array.isArray(elements)) return [];
  const out: MappedBusiness[] = [];
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const e = element as { type?: unknown; id?: unknown; tags?: Record<string, unknown> };
    const tags = e.tags ?? {};
    const name = typeof tags['name'] === 'string' ? tags['name'].trim() : '';
    const site = typeof tags['website'] === 'string' ? normaliseWebsite(tags['website']) : null;
    if (!name || !site || (typeof e.id !== 'number' && typeof e.id !== 'string')) continue;
    const kind = ['shop', 'craft', 'amenity', 'leisure', 'office'].find((k) => typeof tags[k] === 'string');
    const phone = typeof tags['phone'] === 'string' ? tags['phone'] : typeof tags['contact:phone'] === 'string' ? (tags['contact:phone'] as string) : null;
    out.push({
      key: `osm:${String(e.type ?? 'n')}:${String(e.id)}`,
      name: name.slice(0, 160),
      category: kind ? `${kind}=${String(tags[kind])}`.slice(0, 80) : null,
      website: site,
      phone: phone?.slice(0, 40) ?? null,
    });
  }
  return out;
}

export type SiteProblem = 'CERT_INVALID' | 'NO_DNS' | 'REFUSED' | 'SERVER_ERROR' | 'NOT_FOUND' | 'PARKED';

/** How a problem reads to a person. */
export const PROBLEM_TITLE: Record<SiteProblem, string> = {
  CERT_INVALID: 'website shows visitors a security warning instead of the site',
  NO_DNS: 'website address does not load at all',
  REFUSED: 'website server refuses every visitor',
  SERVER_ERROR: 'website answers with a server error',
  NOT_FOUND: 'website home page is gone',
  PARKED: 'website domain shows a parked or for-sale page',
};

const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
]);

const PARKED_MARKERS = [
  'this domain is for sale',
  'this domain may be for sale',
  'buy this domain',
  'domain is for sale',
  'is parked free',
  'domain parking',
  'parkingcrew',
  'sedoparking',
  'hugedomains.com',
  'afternic.com',
  'dan.com/buy-domain',
];

export interface ProbeResult {
  problem: SiteProblem | null;
  /** What code saw, in words, or why nothing can be said. */
  detail: string;
}

/**
 * Classify a failed or successful request. Pure, so every rule can be tested.
 * Anything code cannot tell apart from our own network is no problem at all.
 */
export function classify(input: { errorCode?: string | null; errorName?: string | null; status?: number | null; body?: string | null; finalUrl?: string | null }): ProbeResult {
  if (input.errorName === 'TimeoutError') return { problem: null, detail: 'timed out (not counted)' };
  const code = input.errorCode ?? null;
  if (code && CERT_CODES.has(code)) return { problem: 'CERT_INVALID', detail: `the browser refuses the certificate (${code})` };
  if (code === 'ENOTFOUND') return { problem: 'NO_DNS', detail: 'the domain name does not resolve (ENOTFOUND)' };
  if (code === 'ECONNREFUSED') return { problem: 'REFUSED', detail: 'the server refuses connections (ECONNREFUSED)' };
  if (code) return { problem: null, detail: `could not tell (${code})` };
  const status = input.status ?? null;
  if (status === null) return { problem: null, detail: 'no answer (not counted)' };
  if (status >= 500) return { problem: 'SERVER_ERROR', detail: `the home page answers HTTP ${status}` };
  if (status === 404 || status === 410) return { problem: 'NOT_FOUND', detail: `the home page answers HTTP ${status}` };
  if (status >= 400) return { problem: null, detail: `HTTP ${status} (often a bot block; not counted)` };
  const text = (input.body ?? '').toLowerCase();
  const host = input.finalUrl ? safeHost(input.finalUrl) : '';
  const marker = PARKED_MARKERS.find((one) => text.includes(one) || host.includes(one.split('/')[0]!));
  if (marker) return { problem: 'PARKED', detail: `the page is a parked domain ("${marker}")` };
  return { problem: null, detail: `HTTP ${status}, looks fine` };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export type SiteFetch = (url: string) => Promise<{ status: number; body: string; finalUrl: string }>;

export const httpSiteFetch: SiteFetch = async (url) => {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; brain-site-check/1.0)', accept: 'text/html' },
    signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
  });
  const reader = response.body?.getReader();
  let body = '';
  if (reader) {
    const decoder = new TextDecoder();
    while (body.length < MAX_BODY) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
  }
  return { status: response.status, body, finalUrl: response.url || url };
};

/** Open one website and classify what came back. */
export async function probeSite(url: string, fetcher: SiteFetch = httpSiteFetch): Promise<ProbeResult> {
  try {
    const result = await fetcher(url);
    return classify({ status: result.status, body: result.body, finalUrl: result.finalUrl });
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } };
    return classify({ errorName: err?.name ?? null, errorCode: err?.cause?.code ?? (err as { code?: string })?.code ?? null });
  }
}

interface Row {
  id: string;
  business_key: string;
  name: string;
  city: string;
  category: string | null;
  website: string;
  phone: string | null;
  checked_at: string | null;
  checks: number;
  problem: string | null;
  first_seen_at: string | null;
  confirmed_at: string | null;
  lead_item_id: string | null;
}

/** Map the next due metro, at most one Overpass request per spacing. */
export async function mapNextMetro(input: { now?: Date; fetcher?: (url: string) => Promise<unknown> } = {}): Promise<{ metro: string; added: number; error: string | null } | null> {
  const now = input.now ?? new Date();
  const states = await Promise.all(METROS.map(async (metro) => ({ metro, state: await pullState(`osm:${metro.id}`) })));
  const lastAny = states
    .map(({ state }) => [state.lastSuccessAt, state.lastFailureAt])
    .flat()
    .filter((at): at is string => !!at)
    .reduce((max, at) => Math.max(max, Date.parse(at)), 0);
  if (now.getTime() - lastAny < OVERPASS_SPACING_MS) return null;
  const due = states
    .filter(({ state }) => !state.lastSuccessAt || now.getTime() - Date.parse(state.lastSuccessAt) >= METRO_INTERVAL_MS)
    .sort((a, b) => (a.state.lastSuccessAt ?? '').localeCompare(b.state.lastSuccessAt ?? ''))[0];
  if (!due) return null;
  const source = `osm:${due.metro.id}`;
  try {
    const url = `${OVERPASS_URL}?data=${encodeURIComponent(overpassQuery(due.metro.bbox))}`;
    const body = input.fetcher
      ? await input.fetcher(url)
      : await (async () => {
          const response = await fetch(url, { headers: { 'user-agent': 'brain-site-check/1.0' }, signal: AbortSignal.timeout(120_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })();
    const businesses = parseOverpass(body);
    let added = 0;
    for (const one of businesses) {
      const result = await getDb().run(
        `INSERT INTO site_checks (id, business_key, name, city, category, website, phone, found_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (business_key) DO NOTHING`,
        [newId('sck'), one.key, one.name, due.metro.city, one.category, one.website, one.phone, now.toISOString()],
      );
      added += result.changes ?? 0;
    }
    await recordFeedPull({ source, ok: true, fetched: businesses.length, inserted: added, error: null, at: now.toISOString() });
    return { metro: due.metro.id, added, error: null };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await recordFeedPull({ source, ok: false, fetched: 0, inserted: 0, error: message, at: now.toISOString() });
    return { metro: due.metro.id, added: 0, error: message };
  }
}

/** Check the sites that are due, confirm what repeats, and file confirmed problems as leads. */
export async function checkDueSites(input: { now?: Date; fetcher?: SiteFetch; limit?: number } = {}): Promise<{ checked: number; problems: number; filed: number }> {
  const now = input.now ?? new Date();
  const db = getDb();
  const healthyBefore = new Date(now.getTime() - RECHECK_HEALTHY_MS).toISOString();
  const pendingBefore = new Date(now.getTime() - CONFIRM_AFTER_MS).toISOString();
  const due = await db.all<Row>(
    `SELECT * FROM site_checks
      WHERE confirmed_at IS NULL
        AND (checked_at IS NULL
             OR (problem IS NULL AND checked_at < ?)
             OR (problem IS NOT NULL AND checked_at < ?))
      ORDER BY CASE WHEN problem IS NOT NULL THEN 0 WHEN checked_at IS NULL THEN 1 ELSE 2 END, found_at
      LIMIT ?`,
    [healthyBefore, pendingBefore, input.limit ?? SITES_PER_PASS],
  );
  let next = 0;
  let problems = 0;
  let filed = 0;
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const row = due[next++]!;
      const probe = await probeSite(row.website, input.fetcher);
      const at = now.toISOString();
      if (!probe.problem) {
        await db.run(
          'UPDATE site_checks SET checked_at = ?, checks = checks + 1, problem = NULL, problem_detail = ?, first_seen_at = NULL WHERE id = ?',
          [at, probe.detail, row.id],
        );
        continue;
      }
      problems += 1;
      const same = row.problem === probe.problem && row.first_seen_at;
      const confirmed = same && now.getTime() - Date.parse(row.first_seen_at!) >= CONFIRM_AFTER_MS ? at : null;
      await db.run(
        `UPDATE site_checks SET checked_at = ?, checks = checks + 1, problem = ?, problem_detail = ?,
                first_seen_at = ?, confirmed_at = ? WHERE id = ?`,
        [at, probe.problem, probe.detail, same ? row.first_seen_at : at, confirmed, row.id],
      );
      if (confirmed && (await fileLead({ ...row, problem: probe.problem }, probe.detail, confirmed))) filed += 1;
    }
  };
  await Promise.all(Array.from({ length: SITE_PARALLEL }, () => worker()));
  return { checked: due.length, problems, filed };
}

async function fileLead(row: Row & { problem: SiteProblem }, detail: string, confirmedAt: string): Promise<boolean> {
  if (row.lead_item_id) return false;
  const externalId = `${row.business_key}:${row.problem}`;
  await insertFeedItems(SITE_SOURCE, [
    {
      externalId,
      url: row.website,
      title: `${row.name} in ${row.city}: ${PROBLEM_TITLE[row.problem]}`,
      body:
        `Checked twice, at least an hour apart: ${detail}. ` +
        `Kind of business: ${row.category ?? 'not mapped'}. Found on OpenStreetMap.`,
      organization: row.name,
      publishedAt: confirmedAt,
    },
  ]);
  const item = await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE source = ? AND external_id = ?', [SITE_SOURCE, externalId]);
  if (!item) return false;
  await getDb().run('UPDATE site_checks SET lead_item_id = ? WHERE id = ? AND lead_item_id IS NULL', [item.id, row.id]);
  return true;
}

export interface SiteReading {
  businesses: number;
  checked: number;
  pending: number;
  confirmed: number;
  byProblem: Record<string, number>;
}

export async function siteReading(): Promise<SiteReading> {
  const db = getDb();
  const one = async (sql: string) => Number((await db.get<{ n: number | string }>(sql))?.n ?? 0);
  const rows = await db.all<{ problem: string; n: number | string }>(
    'SELECT problem, COUNT(*) AS n FROM site_checks WHERE confirmed_at IS NOT NULL GROUP BY problem',
  );
  return {
    businesses: await one('SELECT COUNT(*) AS n FROM site_checks'),
    checked: await one('SELECT COUNT(*) AS n FROM site_checks WHERE checked_at IS NOT NULL'),
    pending: await one('SELECT COUNT(*) AS n FROM site_checks WHERE problem IS NOT NULL AND confirmed_at IS NULL'),
    confirmed: await one('SELECT COUNT(*) AS n FROM site_checks WHERE confirmed_at IS NOT NULL'),
    byProblem: Object.fromEntries(rows.map((row) => [row.problem, Number(row.n)])),
  };
}

