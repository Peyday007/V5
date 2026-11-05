/**
 * Finding pages that exist (§88, DISCOVERY.SEARCH).
 *
 * Production, 2026-11-04: 25 of 37 research reads failed, most of them 404s on
 * official deep links that never existed, because the free lane found sources
 * by asking a model to remember URLs. These pin the search that replaces the
 * guess: results parsed without ads, a throttled endpoint paused rather than
 * hammered, a dead link answered by the same site's own page, and the free
 * lane trying search results before remembered URLs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSearchAnomaly,
  parseDuckDuckGo,
  pathWords,
  resetSearchState,
  sameSite,
  searchStats,
  searchSuccessor,
  webSearch,
} from '../server/services/sources/discover.ts';
import { readSource, type AccessDeps } from '../server/services/sources/access.ts';
import type { Resolver, SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import { guidanceBrief } from '../server/services/freeLane/worker.ts';

const HTML = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sba.gov%2Fdocument%2Fsupport%2Dtable%2Dsize%2Dstandards&amp;rut=abc">Table</a></div>
<div class="result"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sba.gov%2Fdocument%2Fsupport%2Dtable%2Dsize%2Dstandards&amp;rut=abc">dup</a></div>
<div class="result--ad"><a href="//duckduckgo.com/y.js?ad_domain=x&uddg=https%3A%2F%2Fads.example%2F%3Fad_provider%3Dbing">ad</a></div>
<div class="result"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.federalregister.gov%2Fdocuments%2F2026%2Fsize%2Dstandards">FR</a></div>`;

const LONG = 'The size standard for this industry is 500 employees. '.repeat(10);
const ok = (url: string): SourceFetch => ({ readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: LONG, truncated: false, totalChars: LONG.length });
const gone = (url: string): SourceFetch => ({ readable: false, requestedUrl: url, finalUrl: url, status: 404, retrievedAt: 'now', reason: 'HTTP_ERROR', detail: 'HTTP 404' });
const publicResolver: Resolver = async () => ['93.184.216.34'];

function fakeFetch(status: number, body: string, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(body, { status });
  }) as typeof fetch;
}

beforeEach(() => resetSearchState());

describe('a search result is a candidate page that exists', () => {
  it('parses result links in order, without ads, redirects or duplicates', () => {
    expect(parseDuckDuckGo(HTML)).toEqual([
      'https://www.sba.gov/document/support-table-size-standards',
      'https://www.federalregister.gov/documents/2026/size-standards',
    ]);
    expect(parseDuckDuckGo('<html>no results</html>')).toEqual([]);
  });

  it('recognises a throttled or challenged answer', () => {
    expect(isSearchAnomaly(202, '')).toBe(true);
    expect(isSearchAnomaly(200, '<div class="anomaly-modal">')).toBe(true);
    expect(isSearchAnomaly(200, HTML)).toBe(false);
  });

  it('searches, and after an anomaly pauses instead of hammering the endpoint', async () => {
    const seen: string[] = [];
    expect(await webSearch('sba size standards', { fetchImpl: fakeFetch(200, HTML, seen) })).toHaveLength(2);
    expect(seen[0]).toContain('html.duckduckgo.com/html/?q=sba%20size%20standards');
    resetSearchState();
    expect(await webSearch('x y', { fetchImpl: fakeFetch(202, 'anomaly-modal', seen) })).toEqual([]);
    expect(searchStats.refused).toBe(1);
    const before = seen.length;
    expect(await webSearch('x y', { fetchImpl: fakeFetch(200, HTML, seen) })).toEqual([]);
    expect(seen.length).toBe(before);
    expect(searchStats.skipped).toBe(1);
  });

  it('never throws: a failed search is an empty candidate list', async () => {
    const broken = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await webSearch('anything', { fetchImpl: broken })).toEqual([]);
  });
});

describe('a dead deep link is answered by the same site’s own page', () => {
  it('reads the words a link was about', () => {
    expect(pathWords('https://www.sba.gov/funding-programs/loans/7a-loans-size-2026.html')).toEqual(['funding', 'programs', 'loans', 'size']);
    expect(sameSite('https://www.sba.gov/a', 'https://sba.gov/b')).toBe(true);
    expect(sameSite('https://www.sba.gov/a', 'https://evil.example/sba.gov')).toBe(false);
  });

  it('takes only a same-site result Brain can read', async () => {
    const queries: string[] = [];
    const found = await searchSuccessor(
      'https://www.sba.gov/business-guide/size-standards-table',
      async (u) => (u.includes('federalregister') ? ok(u) : u.includes('support-table') ? ok(u) : gone(u)),
      async (q) => (queries.push(q), ['https://www.federalregister.gov/x', 'https://www.sba.gov/document/support-table-size-standards']),
    );
    expect(queries[0]).toBe('site:sba.gov business guide size standards table');
    expect(found?.finalUrl).toBe('https://www.sba.gov/document/support-table-size-standards');
  });

  it('is the route readSource takes after a 404 the sitemap and archive cannot answer, cited at its own address', async () => {
    const deps: AccessDeps = {
      resolve: publicResolver,
      robotsAllow: async () => true,
      learned: async () => null,
      record: async () => undefined,
      archive: async () => null,
      sitemap: async () => null,
      browser: null,
      direct: async (u) => gone(u),
      search: async () => ok('https://www.sba.gov/document/support-table-size-standards'),
    };
    const read = await readSource('https://www.sba.gov/invented/size-standards-page', deps);
    expect(read).toMatchObject({ readable: true, method: 'SEARCH', finalUrl: 'https://www.sba.gov/document/support-table-size-standards' });
    expect(read.requestedUrl).toBe('https://www.sba.gov/invented/size-standards-page');
    expect(read.attempts.map((a) => a.method)).toEqual(['DIRECT', 'SITEMAP', 'ARCHIVE', 'SEARCH']);
  });

  it('is never tried for a page that is blocked rather than gone, and is off when a caller brings its own reader', async () => {
    let searched = 0;
    const base: AccessDeps = {
      resolve: publicResolver, robotsAllow: async () => true, learned: async () => null, record: async () => undefined,
      archive: async () => null, sitemap: async () => null, browser: null,
    };
    const blocked: SourceFetch = { ...gone('u'), status: 401 };
    await readSource('https://example.com/a', { ...base, direct: async () => blocked, search: async () => (searched++, null) });
    expect(searched).toBe(0);
    const own = await readSource('https://example.com/b/c', { ...base, direct: async (u) => gone(u) });
    expect(own.attempts.map((a) => a.method)).not.toContain('SEARCH');
  });
});

describe('the free lane acts on the guidance Brain computed', () => {
  it('carries unreachable hosts, readable routes and the search strategy into the brief, bounded', () => {
    const brief = guidanceBrief({
      unreachableHosts: Array.from({ length: 14 }, (_, i) => ({ host: `h${i}.example`, outcome: 'HTTP_403', at: 'now' })),
      readableRoutes: [{ host: 'find-tender.service.gov.uk', lines: ['/api/1.0/ocdsReleasePackages/<id>'] }],
      searchStrategy: 'Prefer the regulator’s own tables.',
    });
    expect((brief['hostsBrainCannotRead'] as string[]).length).toBe(10);
    expect(brief['readableRoutes']).toEqual([{ host: 'find-tender.service.gov.uk', routes: ['/api/1.0/ocdsReleasePackages/<id>'] }]);
    expect(brief['searchStrategy']).toContain('regulator');
    expect(guidanceBrief(null)).toEqual({});
  });
});
