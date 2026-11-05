/**
 * Finding pages that exist: a free, keyless web search for research.
 *
 * Production, 2026-11-04 (`sources show 24`): 25 of 37 source reads failed and
 * the largest class by far was a 404 on a page that never existed — sba.gov,
 * census.gov, gsa.gov, business.gov.au, nasscom.in — because the free lane,
 * which §85 made the owner of commercial research, discovered sources by asking
 * a model to *remember* URLs, plus two Wikipedia titles. A remembered deep link
 * is a guess, and every route `access.ts` adds (browser, sitemap, archive) reads
 * a page that exists; none of them can find one. Discovery was the missing
 * capability, not access.
 *
 * DuckDuckGo's HTML endpoint answers without a key or an account. It returns
 * result links as `uddg=` redirect parameters, which are parsed here; Brain
 * then opens and reads each page itself, so a search result is only ever a
 * candidate — nothing a search engine says is evidence.
 *
 * It is a shared public service, so it is used politely: one query at a time,
 * spaced, a short queue that gives up rather than piling up, and a pause after
 * the endpoint answers with an anomaly page instead of results.
 */

export interface SearchDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  /**
   * LOW is dead-link recovery (`searchSuccessor`): it waits only when the queue
   * is short, so a fragment's own discovery keeps the budget the endpoint allows.
   */
  priority?: 'NORMAL' | 'LOW';
}

/**
 * Two front doors to the same index. Production and this sandbox both saw the
 * html endpoint answer 202 (an anomaly page) after a few queries while lite
 * still answered, so a refusal pauses only the endpoint that refused.
 */
const ENDPOINTS = [
  { name: 'html', url: 'https://html.duckduckgo.com/html/?q=' },
  { name: 'lite', url: 'https://lite.duckduckgo.com/lite/?q=' },
] as const;
/**
 * Paced by what the endpoint tolerates, measured. Production, 2026-11-05
 * 05:27–08:27Z: both endpoints refused together every ten minutes, each time
 * right after the pause lifted, because queued searches resumed 1.5 s apart;
 * search fed 3 of 42 fragments. A refusal now doubles the spacing (to 30 s);
 * every ten answered searches take a fifth off it again (to 2 s).
 */
const MIN_SPACING_MS = 2_000;
const MAX_SPACING_MS = 30_000;
let spacingMs = 4_000;
let answeredSinceRefusal = 0;
const MAX_WAITERS = 12;
const MAX_LOW_WAITERS = 3;
const PAUSE_AFTER_ANOMALY_MS = 10 * 60_000;
const MAX_RESULTS = 8;
/** The same query within ten minutes is answered from memory: dead links on one site repeat. */
const RESULT_TTL_MS = 10 * 60_000;

let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;
let lastAt = 0;
let turn = 0;
const pausedUntil = new Map<string, number>();
const remembered = new Map<string, { at: number; urls: string[] }>();

/** What the last searches did, for tests and the capability map. */
export const searchStats = { queries: 0, withResults: 0, empty: 0, refused: 0, skipped: 0, cached: 0 };

/** Called once per refusal, so a blocked endpoint is a row and not a silence. */
let onRefusal: ((endpoint: string, status: number) => void) | null = null;
export function setSearchRefusalRecorder(fn: ((endpoint: string, status: number) => void) | null): void {
  onRefusal = fn;
}

/** The current spacing between searches, for tests and `sources search`. */
export function searchSpacingMs(): number {
  return spacingMs;
}

export function resetSearchState(): void {
  chain = Promise.resolve();
  waiting = 0;
  lastAt = 0;
  turn = 0;
  spacingMs = 4_000;
  answeredSinceRefusal = 0;
  pausedUntil.clear();
  remembered.clear();
  for (const key of Object.keys(searchStats) as (keyof typeof searchStats)[]) searchStats[key] = 0;
}

/** The result pages in a DuckDuckGo HTML answer, in order, without ads or duplicates. Pure. */
export function parseDuckDuckGo(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/uddg=([^"&'\s>]+)/g)) {
    let url: string;
    try {
      url = decodeURIComponent(match[1]!);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host.endsWith('duckduckgo.com')) continue;
    // Ad clicks carry their own tracking redirect.
    if (/[?&](ad_provider|ad_domain)=/.test(url) || host.endsWith('bing.com')) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** True when the endpoint answered with a challenge rather than results. Pure. */
export function isSearchAnomaly(status: number, html: string): boolean {
  if (status === 202 || status === 403 || status === 429) return true;
  return /anomaly-modal|challenge-form|Unfortunately, bots use DuckDuckGo too/i.test(html);
}

/**
 * Up to eight result pages for a query, or none.
 *
 * Never throws: a search that cannot be made is an empty candidate list, and
 * the caller's other candidates still run.
 */
export async function webSearch(query: string, deps: SearchDeps = {}): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.nowMs ?? Date.now;
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!q) return [];
  const known = remembered.get(q);
  if (known && now() - known.at < RESULT_TTL_MS) {
    searchStats.cached += 1;
    return known.urls;
  }
  const open = (): (typeof ENDPOINTS)[number] | null => {
    for (let i = 0; i < ENDPOINTS.length; i += 1) {
      const one = ENDPOINTS[(turn + i) % ENDPOINTS.length]!;
      if ((pausedUntil.get(one.name) ?? 0) <= now()) return one;
    }
    return null;
  };
  if (!open() || waiting >= MAX_WAITERS || (deps.priority === 'LOW' && waiting >= MAX_LOW_WAITERS)) {
    searchStats.skipped += 1;
    return [];
  }
  waiting += 1;
  const run = chain.then(async () => {
    const wait = lastAt + spacingMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, spacingMs)));
    for (let tries = 0; tries < ENDPOINTS.length; tries += 1) {
      const endpoint = open();
      if (!endpoint) break;
      turn += 1;
      lastAt = now();
      searchStats.queries += 1;
      try {
        const response = await fetchImpl(endpoint.url + encodeURIComponent(q), {
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; BrainResearch/1.0; public research)', accept: 'text/html' },
          signal: AbortSignal.timeout(12_000),
        });
        const html = await response.text();
        if (isSearchAnomaly(response.status, html)) {
          searchStats.refused += 1;
          pausedUntil.set(endpoint.name, now() + PAUSE_AFTER_ANOMALY_MS);
          spacingMs = Math.min(MAX_SPACING_MS, spacingMs * 2);
          answeredSinceRefusal = 0;
          onRefusal?.(endpoint.name, response.status);
          continue;
        }
        answeredSinceRefusal += 1;
        if (answeredSinceRefusal % 10 === 0) spacingMs = Math.max(MIN_SPACING_MS, Math.round(spacingMs * 0.8));
        const urls = parseDuckDuckGo(html).slice(0, MAX_RESULTS);
        if (urls.length > 0) searchStats.withResults += 1;
        else searchStats.empty += 1;
        remembered.set(q, { at: now(), urls });
        if (remembered.size > 2000) remembered.clear();
        return urls;
      } catch {
        searchStats.empty += 1;
        return [];
      }
    }
    return [];
  });
  chain = run.catch(() => undefined);
  try {
    return await run;
  } finally {
    waiting -= 1;
  }
}

/** The words a dead deep link was about, for a site search. Pure. */
export function pathWords(url: string): string[] {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return [];
  }
  return path
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w, i, all) => w.length > 2 && !/^\d+$/.test(w) && !['html', 'htm', 'php', 'aspx', 'www', 'index', 'en', 'us', 'pdf'].includes(w) && all.indexOf(w) === i)
    .slice(0, 8);
}

/** The same site, ignoring a leading `www.`. Pure. */
export function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, '');
    const hb = new URL(b).hostname.toLowerCase().replace(/^www\./, '');
    return ha === hb || hb.endsWith(`.${ha}`) || ha.endsWith(`.${hb}`);
  } catch {
    return false;
  }
}

/**
 * The page a site actually has for what a dead link was about: a site search,
 * then the first same-site result Brain can read. Cited at its own address.
 */
export async function searchSuccessor<T extends { readable: boolean }>(
  url: string,
  direct: (url: string) => Promise<T>,
  search: (query: string) => Promise<string[]> = (q) => webSearch(q, { priority: 'LOW' }),
): Promise<T | null> {
  const words = pathWords(url);
  if (words.length < 2) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  const results = (await search(`site:${host} ${words.join(' ')}`)).filter((one) => one !== url && sameSite(url, one));
  for (const candidate of results.slice(0, 2)) {
    const read = await direct(candidate);
    if (read.readable) return read;
  }
  return null;
}
