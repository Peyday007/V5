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
 * spaced, a bounded queue, and a pause after the endpoint answers with an
 * anomaly page instead of results.
 *
 * In front of it sits a keyed provider (`keyedSearch.ts`, Google Programmable
 * Search), inert until its secret is set: while it is configured, under its
 * daily ceiling and not resting after a refusal, a fragment's search is
 * answered by it, and anything else falls back to this path unchanged.
 * Production, 2026-11-20: DuckDuckGo refused 650 times in 24 hours.
 */
import {
  availableKeyedProvider,
  keyedSearch,
  resetKeyedSearchState,
  type KeyedSearchEvent,
} from './keyedSearch.ts';

export interface SearchDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  /**
   * LOW is dead-link recovery (`searchSuccessor`): it waits only when the queue
   * is short, so a fragment's own discovery keeps the budget the endpoint allows.
   */
  priority?: 'NORMAL' | 'LOW';
  /** Test seam: how a search waits for a paused endpoint to reopen. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Where the keyed provider's secret is read; the deployment's environment by default. */
  env?: NodeJS.ProcessEnv;
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
/**
 * How many searches may wait their turn. The pacing above is what keeps Brain
 * polite to the endpoint; this only decides whether a search waits or is
 * dropped as an empty candidate list.
 *
 * Production, 2026-11-17 (after #1057): the queue held a fixed 12, sized when
 * the free lane ran two slots. The GPU lane now runs up to 32 slots started in
 * one tick (SPEED_JOBS_PEAK 14), and every fragment asks two searches at once
 * after its first model call, so most searches found 12 already waiting and
 * came back empty without being sent. Those fragments were left with the
 * model's remembered pages (PA DEP and NAICS index pages, 403s on guessed deep
 * links): 64% of GPU research fragments failed "no readable source" or listed
 * no claims, while the same queries through the same code returned 5-8
 * readable, on-topic pages. A fragment's lease is 20 minutes and a job takes
 * ~5, so a search may now wait up to `MAX_QUEUE_WAIT_MS` at the current
 * spacing (30 waiters at the 4 s default), never fewer than the 12 it always
 * could, never more than `MAX_WAITERS_CEILING`. The endpoint sees the same rate.
 */
const MIN_WAITERS = 12;
const MAX_WAITERS_CEILING = 64;
const MAX_QUEUE_WAIT_MS = 120_000;
/** The searches that may wait now, at the given spacing. Pure; exported for tests. */
export function maxWaiters(spacing = spacingMs): number {
  return Math.min(MAX_WAITERS_CEILING, Math.max(MIN_WAITERS, Math.floor(MAX_QUEUE_WAIT_MS / Math.max(1, spacing))));
}
const MAX_LOW_WAITERS = 3;
/**
 * How long an endpoint rests after an anomaly page: a minute, doubling on each
 * refusal in a row, up to ten; one answer resets it.
 *
 * Production, 2026-11-17 20:16-21:02Z (release 04b754ce): every one of 64 GPU
 * research-fragment failures read "none from web search". A refusal paused its
 * endpoint for a flat ten minutes, so two refusals in a row (one per endpoint)
 * closed search for every fragment for ten minutes, and each search in that
 * time came back empty without being sent. The endpoint's throttle is not ten
 * minutes long: measured from a shared egress the same evening, html and lite
 * answered 202 and 200 alternately four seconds apart, and a run of four 202s
 * was followed by answers 40 s later. The 2026-11-05 reading (both endpoints
 * refusing "right after the pause lifted", every ten minutes) is this pause
 * re-arming, not a ten-minute block.
 */
const PAUSE_BASE_MS = 60_000;
const PAUSE_MAX_MS = 10 * 60_000;
export function pauseAfterRefusals(streak: number): number {
  return Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** Math.max(0, streak - 1));
}
const MAX_RESULTS = 8;
/** The same query within ten minutes is answered from memory: dead links on one site repeat. */
const RESULT_TTL_MS = 10 * 60_000;
/**
 * A query that returned pages is answered from memory for six hours. The keyed
 * provider's daily ceiling was spent in the first hour of the UTC day
 * (production, 2026-11-25) partly on the same fragments' same queries, each
 * re-run of a handed-back fragment buying its two searches again once ten
 * minutes had passed. Result pages do not change in hours; an empty answer is
 * still asked again after ten minutes.
 */
const ANSWERED_TTL_MS = 6 * 3_600_000;
/** How long a remembered answer stands. Pure. */
export function rememberedFor(urls: readonly string[]): number {
  return urls.length > 0 ? ANSWERED_TTL_MS : RESULT_TTL_MS;
}

let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;
let lastAt = 0;
let turn = 0;
const pausedUntil = new Map<string, number>();
const refusalStreak = new Map<string, number>();
const remembered = new Map<string, { at: number; urls: string[] }>();

/** What the last searches did, for tests and the capability map. */
export const searchStats = { queries: 0, withResults: 0, empty: 0, refused: 0, skipped: 0, cached: 0, keyed: 0 };

/** Called once per refusal, so a blocked endpoint is a row and not a silence. */
let onRefusal: ((endpoint: string, status: number) => void) | null = null;
export function setSearchRefusalRecorder(fn: ((endpoint: string, status: number) => void) | null): void {
  onRefusal = fn;
}

/**
 * What one sent search did and which provider did it — `google-cse`, or the
 * DuckDuckGo endpoint (`html`, `lite`) — so production measures who answers.
 * A cached answer and a search never sent are not events. Never carries a secret.
 */
export type SearchEvent = KeyedSearchEvent;
let onSearch: ((event: SearchEvent) => void) | null = null;
export function setSearchEventRecorder(fn: ((event: SearchEvent) => void) | null): void {
  onSearch = fn;
}
function emit(event: SearchEvent): void {
  try {
    onSearch?.(event);
  } catch {
    // A recorder that fails never fails the search.
  }
}

/**
 * Whether web search is refusing now: every endpoint's last answer was a
 * refusal. A fragment that found no readable source in that time says nothing
 * about its question (production 0ba2eb30, 2026-11-18 01:00–01:45Z), and the
 * free lane hands it back with its attempt refunded instead of spending it.
 */
export function webSearchRefusing(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  return ENDPOINTS.every((one) => (refusalStreak.get(one.name) ?? 0) > 0) && availableKeyedProvider(env, now) === null;
}

/** The web searches one research fragment asks for its candidates (`searchQueries` in the free lane). */
export const SEARCHES_PER_FRAGMENT = 2;
/**
 * Fragments that may still run while web search is refusing: enough that
 * search's recovery is found by a fragment's own query, and that a question an
 * encyclopedia or a remembered page can answer still is, without the rest of
 * the queue being worked against a search that answers nobody.
 */
export const SEARCH_OUTAGE_FRAGMENTS = 2;

/**
 * How many research fragments web search can feed at once now: unbounded while
 * a keyed provider can answer; `SEARCH_OUTAGE_FRAGMENTS` while every DuckDuckGo
 * endpoint is refusing; otherwise as many as the search queue can hold the
 * searches of (`maxWaiters`), because a search past it comes back empty unsent.
 *
 * Production, 24 h to 2026-11-25 06:00Z: the GPU free lane handed 2,627
 * research fragments back RELEASED_TRANSIENT and submitted 342. The keyed
 * provider's daily ceiling was spent within the first hour of the UTC day;
 * after it DuckDuckGo answered 202 to most queries, and 1,773 fragment runs
 * ended "no readable source … none from web search" and most of the rest "0
 * claim(s) offered" over encyclopedia and remembered pages — each run the
 * lane's model calls and two more refused searches, re-queued and claimed again
 * by the next free slot. Pure over the module's state; exported for the lane's
 * admission and for tests.
 */
export function fragmentSearchRoom(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  if (availableKeyedProvider(env, now) !== null) return Number.POSITIVE_INFINITY;
  if (webSearchRefusing(env, now)) return SEARCH_OUTAGE_FRAGMENTS;
  return Math.max(SEARCH_OUTAGE_FRAGMENTS, Math.floor(maxWaiters() / SEARCHES_PER_FRAGMENT));
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
  refusalStreak.clear();
  remembered.clear();
  readWithoutAnswer.clear();
  resetKeyedSearchState();
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
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!q) return [];
  const known = remembered.get(q);
  if (known && now() - known.at < rememberedFor(known.urls)) {
    searchStats.cached += 1;
    return known.urls;
  }
  // The keyed provider answers a fragment's search while it can; dead-link
  // recovery (LOW) keeps to DuckDuckGo so it never spends the daily ceiling.
  if (deps.priority !== 'LOW') {
    const keyed = await keyedSearch(q, { fetchImpl, nowMs: now, env: deps.env ?? process.env, emit });
    if (keyed) {
      searchStats.keyed += 1;
      searchStats.withResults += 1;
      remembered.set(q, { at: now(), urls: keyed });
      if (remembered.size > 2000) remembered.clear();
      return keyed;
    }
  }
  const open = (): (typeof ENDPOINTS)[number] | null => {
    for (let i = 0; i < ENDPOINTS.length; i += 1) {
      const one = ENDPOINTS[(turn + i) % ENDPOINTS.length]!;
      if ((pausedUntil.get(one.name) ?? 0) <= now()) return one;
    }
    return null;
  };
  /*
   * With every endpoint resting, a fragment's search waits for the first to
   * reopen when that is within the queue's wait bound, instead of coming back
   * empty unsent. Dead-link recovery (LOW) never waits for a pause.
   */
  const reopenWait = (): number => Math.max(0, Math.min(...ENDPOINTS.map((one) => pausedUntil.get(one.name) ?? 0)) - now());
  const mayWaitForReopen = (): boolean => deps.priority !== 'LOW' && reopenWait() <= MAX_QUEUE_WAIT_MS;
  if ((!open() && !mayWaitForReopen()) || waiting >= maxWaiters() || (deps.priority === 'LOW' && waiting >= MAX_LOW_WAITERS)) {
    searchStats.skipped += 1;
    return [];
  }
  waiting += 1;
  const run = chain.then(async () => {
    const wait = lastAt + spacingMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, spacingMs)));
    // Each endpoint at most once before a rest and once after it.
    let waitedForReopen = false;
    for (let tries = 0; tries < ENDPOINTS.length * 2; tries += 1) {
      let endpoint = open();
      if (!endpoint) {
        if (waitedForReopen || !mayWaitForReopen()) break;
        waitedForReopen = true;
        await sleep(reopenWait());
        endpoint = open();
        if (!endpoint) break;
      }
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
          const streak = (refusalStreak.get(endpoint.name) ?? 0) + 1;
          refusalStreak.set(endpoint.name, streak);
          pausedUntil.set(endpoint.name, now() + pauseAfterRefusals(streak));
          spacingMs = Math.min(MAX_SPACING_MS, spacingMs * 2);
          answeredSinceRefusal = 0;
          onRefusal?.(endpoint.name, response.status);
          emit({
            provider: endpoint.name, outcome: 'REFUSED', status: response.status, results: 0,
            detail: `search endpoint ${endpoint.name} answered ${response.status}; it rests before its next query`,
          });
          continue;
        }
        refusalStreak.delete(endpoint.name);
        answeredSinceRefusal += 1;
        if (answeredSinceRefusal % 10 === 0) spacingMs = Math.max(MIN_SPACING_MS, Math.round(spacingMs * 0.8));
        const urls = parseDuckDuckGo(html).slice(0, MAX_RESULTS);
        if (urls.length > 0) searchStats.withResults += 1;
        else searchStats.empty += 1;
        emit({
          provider: endpoint.name, outcome: urls.length > 0 ? 'ANSWERED' : 'EMPTY', status: response.status, results: urls.length,
          detail: `search endpoint ${endpoint.name} answered ${urls.length} page(s)`,
        });
        remembered.set(q, { at: now(), urls });
        if (remembered.size > 2000) remembered.clear();
        return urls;
      } catch (error) {
        searchStats.empty += 1;
        emit({
          provider: endpoint.name, outcome: 'ERROR', status: null, results: 0,
          detail: `search endpoint ${endpoint.name} request failed (${error instanceof Error ? error.name : 'Error'})`,
        });
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

/**
 * Pages Brain read for a question and the model then said state nothing it
 * asks, so a later attempt at the same question opens other pages (§15: a
 * retry is not a repair).
 *
 * Production, 2026-11-18 15:00–17:00Z (GPU run, release 62c38137): DuckDuckGo
 * answered 202 on both endpoints every hour (`SOURCE_SEARCH` REFUSED rows), so
 * each fragment's candidates were Wikipedia's (91 of 116 pages read). Fragment
 * frg_a3abc1519bfb4c0197ae and its repair frg_8fdaeab3271f49359197 ran six
 * work items, twelve attempts, on the same four encyclopedia pages — every one
 * "None of the provided sources contain any sentence about GitHub's bug bounty
 * program" — and blocked WORK_FAULTED; the overnight dive on the same opening
 * did the same twelve times on one GitHub press page. Same question, same
 * cached search, same pages, same answer.
 *
 * Keyed by the question's own words, so a replacement item and a repair
 * fragment (same question) both see it. In memory and bounded: it steers which
 * pages are opened, and nothing is concluded from it.
 */
const READ_WITHOUT_ANSWER_TTL_MS = 6 * 60 * 60_000;
const READ_WITHOUT_ANSWER_MAX = 1000;
const readWithoutAnswer = new Map<string, { at: number; urls: Set<string> }>();

function questionKey(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 600);
}

/** Record pages the model read for `question` and listed no claim from. */
export function rememberReadWithoutAnswer(question: string, urls: readonly string[], now = Date.now()): void {
  const key = questionKey(question);
  if (!key || urls.length === 0) return;
  const known = readWithoutAnswer.get(key);
  const fresh = known && now - known.at < READ_WITHOUT_ANSWER_TTL_MS ? known.urls : new Set<string>();
  for (const url of urls) fresh.add(url);
  readWithoutAnswer.delete(key);
  readWithoutAnswer.set(key, { at: now, urls: fresh });
  while (readWithoutAnswer.size > READ_WITHOUT_ANSWER_MAX) readWithoutAnswer.delete(readWithoutAnswer.keys().next().value!);
}

/** Pages already read for `question` that answered nothing, within the last six hours. */
export function readWithoutAnswerFor(question: string, now = Date.now()): ReadonlySet<string> {
  const known = readWithoutAnswer.get(questionKey(question));
  return known && now - known.at < READ_WITHOUT_ANSWER_TTL_MS ? known.urls : new Set<string>();
}

/** Wikipedia: what Brain falls back to when web search gives nothing. Pure. */
export function isEncyclopediaPage(url: string): boolean {
  try {
    return /(^|\.)wikipedia\.org$/.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
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
