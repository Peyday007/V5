/**
 * Firecrawl as an optional keyed fallback: the second search provider after
 * Google, and the FIRECRAWL read route after DIRECT and BROWSER. Inert without
 * its key, counted in credits before anything is sent, falling through on any
 * refusal, and its key in no detail it produces.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readSource, type AccessDeps } from '../server/services/sources/access.ts';
import { firecrawlScrape, type FirecrawlScrapeEvent } from '../server/services/sources/firecrawl.ts';
import type { Resolver, SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import {
  firecrawlSearch,
  keyedSearch,
  keyedSearchUsed,
  KEYED_SEARCH_PROVIDERS,
  resetKeyedSearchState,
  type KeyedSearchEvent,
} from '../server/services/sources/keyedSearch.ts';
import { integration } from '../server/services/integrations/registry.ts';

const FC_KEY = 'fc-0123456789abcdefTESTKEYnotreal';
const G_KEY = 'AIzaSyTEST-not-a-real-key-0123456789abc';
const FC_ENV = { FIRECRAWL_API_KEY: FC_KEY } as NodeJS.ProcessEnv;
const BOTH_ENV = { ...FC_ENV, BRAIN_SEARCH_API_KEY: G_KEY, BRAIN_SEARCH_ENGINE_ID: 'a1b2c3d4e5f6g7h8i' } as NodeJS.ProcessEnv;
const T0 = Date.parse('2026-11-21T10:00:00Z');

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fetchRouter(answers: { google?: () => Response; search?: () => Response; scrape?: () => Response }, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://www.googleapis.com/')) return (answers.google ?? (() => new Response('{}', { status: 500 })))();
    if (url === 'https://api.firecrawl.dev/v1/search') return (answers.search ?? (() => new Response('{}', { status: 500 })))();
    if (url === 'https://api.firecrawl.dev/v1/scrape') return (answers.scrape ?? (() => new Response('{}', { status: 500 })))();
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

const fcSearchOk = () =>
  new Response(
    JSON.stringify({
      success: true,
      data: [
        { url: 'https://www.bls.gov/oes/current/oes472061.htm', title: 'OES', description: 'wages' },
        { url: 'https://www.bls.gov/oes/current/oes472061.htm#x', title: 'dup', description: '' },
        { url: 'ftp://not.web/x', title: 'no', description: '' },
        { url: 'https://source.example/page', title: 'Two', description: 'two' },
      ],
    }),
    { status: 200 },
  );
const googleOk = () => new Response(JSON.stringify({ items: [{ link: 'https://google.example/a' }] }), { status: 200 });
const status = (code: number, body: unknown = { success: false, error: `bad key ${FC_KEY}`, code: 'SOME_CODE' }) => () =>
  new Response(JSON.stringify(body), { status: code });

let events: KeyedSearchEvent[] = [];
const emit = (event: KeyedSearchEvent) => events.push(event);

beforeEach(() => {
  resetKeyedSearchState();
  events = [];
});

describe('Firecrawl is declared once and inert without its key', () => {
  it('is registered with its secret and a free-tier credit ceiling, and ordered after Google', () => {
    const one = integration('firecrawl');
    expect(one.credentials.map((c) => c.name)).toEqual(['FIRECRAWL_API_KEY']);
    expect(one.dailyCeiling).toBe(15);
    expect(KEYED_SEARCH_PROVIDERS.map((p) => p.id)).toEqual(['google-cse', 'firecrawl']);
  });

  it('sends nothing to Firecrawl, for search or scrape, when the key is not set', async () => {
    const calls: Call[] = [];
    const fetchImpl = fetchRouter({ search: fcSearchOk, scrape: fcSearchOk }, calls);
    expect(await keyedSearch('a question', { fetchImpl, nowMs: () => T0, env: {}, emit })).toBeNull();
    expect(await firecrawlScrape('https://example.com/a', { fetchImpl, env: {}, nowMs: () => T0, record: () => undefined })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('Firecrawl search', () => {
  it('posts {query, limit} with a Bearer header and parses data[].url', async () => {
    const calls: Call[] = [];
    const urls = await keyedSearch('excavator wage', { fetchImpl: fetchRouter({ search: fcSearchOk }, calls), nowMs: () => T0, env: FC_ENV, emit });
    expect(urls).toEqual(['https://www.bls.gov/oes/current/oes472061.htm', 'https://source.example/page']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ query: 'excavator wage', limit: 8 });
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${FC_KEY}`);
    expect(calls[0]!.url).not.toContain(FC_KEY);
    expect(events).toEqual([expect.objectContaining({ provider: 'firecrawl', outcome: 'ANSWERED', results: 2 })]);
    expect(keyedSearchUsed('firecrawl', T0)).toBe(firecrawlSearch.cost);
  });

  for (const code of [429, 401, 402, 500, 503]) {
    it(`a Google ${code} falls through to Firecrawl, and a Firecrawl ${code} falls through to DuckDuckGo (null)`, async () => {
      const calls: Call[] = [];
      const first = await keyedSearch('q1', { fetchImpl: fetchRouter({ google: status(code), search: fcSearchOk }, calls), nowMs: () => T0, env: BOTH_ENV, emit });
      expect(first).toEqual(['https://www.bls.gov/oes/current/oes472061.htm', 'https://source.example/page']);
      expect(events.map((e) => [e.provider, e.outcome])).toEqual([
        ['google-cse', code >= 500 ? 'ERROR' : 'REFUSED'],
        ['firecrawl', 'ANSWERED'],
      ]);

      resetKeyedSearchState();
      events = [];
      const second = await keyedSearch('q2', { fetchImpl: fetchRouter({ google: status(code), search: status(code) }, calls), nowMs: () => T0, env: BOTH_ENV, emit });
      expect(second).toBeNull();
      expect(events.map((e) => [e.provider, e.outcome])).toEqual([
        ['google-cse', code >= 500 ? 'ERROR' : 'REFUSED'],
        ['firecrawl', code >= 500 ? 'ERROR' : 'REFUSED'],
      ]);
      // Both rest: the next query sends nothing and goes straight to DuckDuckGo.
      const before = calls.length;
      expect(await keyedSearch('q3', { fetchImpl: fetchRouter({ google: googleOk, search: fcSearchOk }, calls), nowMs: () => T0 + 1000, env: BOTH_ENV, emit })).toBeNull();
      expect(calls.length).toBe(before);
    });
  }

  it('counts credits before sending, so a burst never passes the ceiling, and records reaching it once', async () => {
    const calls: Call[] = [];
    const env = { ...FC_ENV, BRAIN_FIRECRAWL_DAILY_CEILING: '5' };
    // Never answers until every search has been started.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      await gate;
      return fcSearchOk();
    }) as typeof fetch;
    const runs = Array.from({ length: 6 }, (_, i) => keyedSearch(`burst ${i}`, { fetchImpl, nowMs: () => T0, env, emit }));
    release();
    const answers = await Promise.all(runs);
    // 2 credits a search, ceiling 5: two searches sent, the rest fall through.
    expect(calls).toHaveLength(2);
    expect(answers.filter((a) => a === null)).toHaveLength(4);
    expect(keyedSearchUsed('firecrawl', T0)).toBe(4);
    expect(events.filter((e) => e.outcome === 'CEILING')).toHaveLength(1);
    expect(events.find((e) => e.outcome === 'CEILING')!.detail).toContain('BRAIN_FIRECRAWL_DAILY_CEILING');
  });

  it('counts a timed-out search', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error(`timeout calling with ${FC_KEY}`), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await keyedSearch('slow', { fetchImpl, nowMs: () => T0, env: FC_ENV, emit })).toBeNull();
    expect(keyedSearchUsed('firecrawl', T0)).toBe(2);
    expect(events[0]).toEqual(expect.objectContaining({ provider: 'firecrawl', outcome: 'ERROR' }));
  });
});

/* --------------------------------------------------------------------------- */

const publicResolver: Resolver = async () => ['93.184.216.34'];
const LONG = 'Official statistics say the median wage was 41,000 dollars in 2025. '.repeat(10);
const ok = (url: string, text = LONG): SourceFetch => ({
  readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text, truncated: false, totalChars: text.length,
});
const no = (url: string, reason: string, statusCode: number | null = null): SourceFetch => ({
  readable: false, requestedUrl: url, finalUrl: url, status: statusCode, retrievedAt: 'now', reason: reason as never, detail: reason,
});

function accessDeps(over: Partial<AccessDeps>): AccessDeps {
  return {
    resolve: publicResolver,
    robotsAllow: async () => true,
    learned: async () => null,
    routine: async () => null,
    record: async () => undefined,
    archive: async () => null,
    sitemap: async () => null,
    browser: null,
    firecrawl: null,
    ...over,
  };
}

const scrapeOk = (markdown = LONG, statusCode = 200) => () =>
  new Response(JSON.stringify({ success: true, data: { markdown, metadata: { sourceURL: 'https://example.com/a', statusCode } } }), { status: 200 });

describe('the FIRECRAWL read route', () => {
  it('is never asked when DIRECT reads the page', async () => {
    let asked = 0;
    const read = await readSource('https://example.com/a', accessDeps({ direct: async (u) => ok(u), firecrawl: async () => (asked++, null) }));
    expect(read.method).toBe('DIRECT');
    expect(asked).toBe(0);
  });

  it('is asked only after DIRECT and BROWSER fail, and cites the page at its own address', async () => {
    const order: string[] = [];
    const calls: Call[] = [];
    const scraped: FirecrawlScrapeEvent[] = [];
    const read = await readSource(
      'https://example.com/a',
      accessDeps({
        direct: async (u) => (order.push('DIRECT'), no(u, 'HTTP_ERROR', 403)),
        browser: async (u) => (order.push('BROWSER'), ok(u, 'Just a moment... Enable JavaScript and cookies to continue')),
        firecrawl: (u) => (order.push('FIRECRAWL'), firecrawlScrape(u, { fetchImpl: fetchRouter({ scrape: scrapeOk() }, calls), env: FC_ENV, nowMs: () => T0, record: (e) => void scraped.push(e) })),
      }),
    );
    expect(order).toEqual(['DIRECT', 'BROWSER', 'FIRECRAWL']);
    expect(read.readable).toBe(true);
    expect(read.method).toBe('FIRECRAWL');
    expect(read.requestedUrl).toBe('https://example.com/a');
    expect(read.finalUrl).toBe('https://example.com/a');
    expect(read.attempts.map((a) => [a.method, a.readable])).toEqual([['DIRECT', false], ['BROWSER', false], ['FIRECRAWL', true]]);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ url: 'https://example.com/a', formats: ['markdown'] });
    expect(keyedSearchUsed('firecrawl', T0)).toBe(1);
    expect(scraped.map((e) => e.outcome)).toEqual(['READ']);
  });

  it('is not asked past an access control, a disallowing robots.txt, or for a page that is gone', async () => {
    let asked = 0;
    const firecrawl = async () => (asked++, null);
    for (const code of [401, 402, 451]) {
      const read = await readSource('https://example.com/a', accessDeps({ direct: async (u) => no(u, 'HTTP_ERROR', code), firecrawl }));
      expect(read.readable).toBe(false);
    }
    await readSource('http://10.0.0.1/a', accessDeps({ direct: async (u) => no(u, 'HTTP_ERROR', 403), firecrawl, resolve: async () => ['10.0.0.1'] }));
    const robots = await readSource('https://example.com/a', accessDeps({ direct: async (u) => no(u, 'HTTP_ERROR', 403), firecrawl, robotsAllow: async () => false }));
    expect(robots.terms?.robotsDisallows).toBe(true);
    await readSource('https://example.com/gone', accessDeps({ direct: async (u) => no(u, 'HTTP_ERROR', 404), firecrawl }));
    expect(asked).toBe(0);
  });

  it('reports a block page or a site error Firecrawl returns as unreadable, never as the page', async () => {
    const calls: Call[] = [];
    const block = await readSource(
      'https://example.com/a',
      accessDeps({
        direct: async (u) => no(u, 'HTTP_ERROR', 403),
        firecrawl: (u) => firecrawlScrape(u, { fetchImpl: fetchRouter({ scrape: scrapeOk('Sorry, you have been blocked. Cloudflare Ray ID: 1') }, calls), env: FC_ENV, nowMs: () => T0, record: () => undefined }),
      }),
    );
    expect(block.readable).toBe(false);
    const gone = await firecrawlScrape('https://example.com/b', { fetchImpl: fetchRouter({ scrape: scrapeOk(LONG, 451) }, calls), env: FC_ENV, nowMs: () => T0, record: () => undefined });
    expect(gone).toEqual(expect.objectContaining({ readable: false, reason: 'HTTP_ERROR', status: 451 }));
  });

  it('spends from the same credit ceiling as search, counted before sending, and records the ceiling once', async () => {
    const env = { ...FC_ENV, BRAIN_FIRECRAWL_DAILY_CEILING: '3' };
    const calls: Call[] = [];
    const recorded: FirecrawlScrapeEvent[] = [];
    await keyedSearch('a search', { fetchImpl: fetchRouter({ search: fcSearchOk }, calls), nowMs: () => T0, env, emit });
    const fetchImpl = fetchRouter({ scrape: scrapeOk() }, calls);
    const reads = [];
    for (let i = 0; i < 3; i += 1) reads.push(await firecrawlScrape(`https://example.com/${i}`, { fetchImpl, env, nowMs: () => T0, record: (e) => void recorded.push(e) }));
    expect(reads.map((r) => (r === null ? null : r.readable))).toEqual([true, null, null]);
    expect(calls).toHaveLength(2);
    expect(recorded.map((e) => e.outcome)).toEqual(['READ', 'CEILING']);
    // A new UTC day opens it again.
    expect(await firecrawlScrape('https://example.com/next', { fetchImpl, env, nowMs: () => T0 + 24 * 3600_000, record: () => undefined })).not.toBeNull();
  });

  it('counts a timed-out scrape and rests after a refusal', async () => {
    const recorded: FirecrawlScrapeEvent[] = [];
    const timeout = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const read = await firecrawlScrape('https://example.com/a', { fetchImpl: timeout, env: FC_ENV, nowMs: () => T0, record: (e) => void recorded.push(e) });
    expect(read).toEqual(expect.objectContaining({ readable: false, reason: 'TIMEOUT' }));
    expect(keyedSearchUsed('firecrawl', T0)).toBe(1);
    resetKeyedSearchState();
    const calls: Call[] = [];
    await firecrawlScrape('https://example.com/a', { fetchImpl: fetchRouter({ scrape: status(402) }, calls), env: FC_ENV, nowMs: () => T0, record: () => undefined });
    expect(await firecrawlScrape('https://example.com/b', { fetchImpl: fetchRouter({ scrape: scrapeOk() }, calls), env: FC_ENV, nowMs: () => T0 + 1000, record: () => undefined })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('the key never leaves the request', () => {
  it('appears in no search event, scrape event, read detail or URL, whatever Firecrawl or the network said', async () => {
    const leakyThrow = (async () => {
      throw new Error(`connect ECONNREFUSED Authorization: Bearer ${FC_KEY}`);
    }) as unknown as typeof fetch;
    const outputs: unknown[] = [];
    const recorded: FirecrawlScrapeEvent[] = [];
    let t = T0;
    const nowMs = () => t;
    for (const answer of [status(401), status(402), status(429), status(503)]) {
      t += 7 * 3600_000;
      const calls: Call[] = [];
      await keyedSearch('q', { fetchImpl: fetchRouter({ search: answer }, calls), nowMs, env: FC_ENV, emit });
      // A refused search rests the shared provider; start the scrape from a clean rest to read its own detail.
      resetKeyedSearchState();
      outputs.push(await firecrawlScrape('https://example.com/a', { fetchImpl: fetchRouter({ scrape: answer }, calls), env: FC_ENV, nowMs, record: (e) => void recorded.push(e) }));
      for (const call of calls) expect(call.url).not.toContain(FC_KEY);
    }
    t += 7 * 3600_000;
    await keyedSearch('q', { fetchImpl: leakyThrow, nowMs, env: FC_ENV, emit });
    resetKeyedSearchState();
    outputs.push(await firecrawlScrape('https://example.com/a', { fetchImpl: leakyThrow, env: FC_ENV, nowMs, record: (e) => void recorded.push(e) }));
    const all = JSON.stringify([events, recorded, outputs]);
    expect(all).not.toContain(FC_KEY);
    expect(all).not.toContain('Bearer');
    expect(events.filter((e) => e.provider === 'firecrawl').length).toBeGreaterThanOrEqual(5);
    expect(recorded.length).toBeGreaterThanOrEqual(5);
  });
});
