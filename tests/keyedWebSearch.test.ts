/**
 * A keyed web-search provider in front of the DuckDuckGo scraper.
 *
 * Production, 2026-11-20: DuckDuckGo's html and lite endpoints refused Brain
 * 650 times in 24 hours, and fragments whose search came back empty were filled
 * from remembered pages and Wikipedia (166 claims refused in 48 hours, e.g. a
 * payphone price offered for a goal's price question). These pin the provider
 * that answers first while its secret is set, the fallback that keeps the old
 * path unchanged, the daily ceiling, and that its key never leaves the request.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetSearchState,
  searchStats,
  setSearchEventRecorder,
  webSearch,
  webSearchRefusing,
  type SearchEvent,
} from '../server/services/sources/discover.ts';
import { keyedSearchUsed, seedKeyedSearchUsage } from '../server/services/sources/keyedSearch.ts';
import { readIntegrations } from '../server/services/integrations/health.ts';
import { integration } from '../server/services/integrations/registry.ts';

const KEY = 'AIzaSyTEST-not-a-real-key-0123456789abc';
const CX = 'a1b2c3d4e5f6g7h8i';
const ENV = { BRAIN_SEARCH_API_KEY: KEY, BRAIN_SEARCH_ENGINE_ID: CX } as NodeJS.ProcessEnv;

const DDG_HTML = `
<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Fone&amp;rut=a">1</a>
<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Ftwo&amp;rut=b">2</a>`;

const GOOGLE_JSON = JSON.stringify({
  items: [
    { link: 'https://www.bls.gov/oes/current/oes472061.htm' },
    { link: 'https://www.bls.gov/oes/current/oes472061.htm#tab' },
    { link: 'ftp://not.web/x' },
    ...Array.from({ length: 9 }, (_, i) => ({ link: `https://source${i}.example/page` })),
  ],
});

/** A fetch answering googleapis with `google` and DuckDuckGo with its HTML, recording every URL asked. */
function router(google: () => Response, seen: string[], clock?: { t: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (clock) clock.t += 40_000; // past DuckDuckGo's spacing, so no real timer waits
    if (url.startsWith('https://www.googleapis.com/customsearch/v1?')) return google();
    return new Response(DDG_HTML, { status: 200 });
  }) as typeof fetch;
}

const googleOk = () => new Response(GOOGLE_JSON, { status: 200 });
const googleQuota = () =>
  new Response(JSON.stringify({ error: { code: 429, message: `Quota exceeded for key ${KEY}`, errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 429 });
const googleForbidden = () =>
  new Response(JSON.stringify({ error: { code: 403, message: 'This project does not have the access', errors: [{ reason: 'accessNotConfigured' }] } }), { status: 403 });

let events: SearchEvent[] = [];
beforeEach(() => {
  resetSearchState();
  events = [];
  setSearchEventRecorder((event) => events.push(event));
});

describe('the keyed provider answers first while its secret is set', () => {
  it('(a) searches Google Programmable Search and returns its pages, eight at most, without duplicates', async () => {
    const seen: string[] = [];
    const urls = await webSearch('excavator operator hourly wage pennsylvania', { fetchImpl: router(googleOk, seen), env: ENV });
    expect(urls).toHaveLength(8);
    expect(urls[0]).toBe('https://www.bls.gov/oes/current/oes472061.htm');
    expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
    expect(seen).toHaveLength(1);
    const asked = new URL(seen[0]!);
    expect(asked.origin + asked.pathname).toBe('https://www.googleapis.com/customsearch/v1');
    expect(asked.searchParams.get('cx')).toBe(CX);
    expect(asked.searchParams.get('q')).toBe('excavator operator hourly wage pennsylvania');
    expect(events).toEqual([expect.objectContaining({ provider: 'google-cse', outcome: 'ANSWERED', results: 8 })]);
    expect(searchStats.keyed).toBe(1);
    // The result cache still answers the same query, without a second paid query.
    expect(await webSearch('excavator operator hourly wage pennsylvania', { fetchImpl: router(googleOk, seen), env: ENV })).toEqual(urls);
    expect(seen).toHaveLength(1);
    expect(keyedSearchUsed('google-cse')).toBe(1);
  });

  it('leaves dead-link recovery (LOW) on DuckDuckGo, so it never spends the ceiling', async () => {
    const seen: string[] = [];
    const clock = { t: 1_000_000 };
    await webSearch('site:sba.gov size standards table', { fetchImpl: router(googleOk, seen, clock), env: ENV, nowMs: () => clock.t, priority: 'LOW' });
    expect(seen.every((u) => u.includes('duckduckgo.com'))).toBe(true);
    expect(keyedSearchUsed('google-cse')).toBe(0);
  });
});

describe('a refusal, a quota or an error falls back to DuckDuckGo unchanged', () => {
  for (const [status, google] of [[429, googleQuota], [403, googleForbidden]] as const) {
    it(`(b) a ${status} answers from DuckDuckGo, and the provider rests`, async () => {
      const seen: string[] = [];
      const clock = { t: 1_000_000 };
      const nowMs = () => clock.t;
      const urls = await webSearch('first question', { fetchImpl: router(google, seen, clock), env: ENV, nowMs });
      expect(urls).toEqual(['https://ddg.example/one', 'https://ddg.example/two']);
      expect(seen.map((u) => (u.includes('googleapis') ? 'google' : 'ddg'))).toEqual(['google', 'ddg']);
      expect(events.map((e) => [e.provider, e.outcome])).toEqual([['google-cse', 'REFUSED'], [expect.stringMatching(/^(html|lite)$/), 'ANSWERED']]);
      // Resting: the next search does not ask Google again.
      await webSearch('second question', { fetchImpl: router(googleOk, seen, clock), env: ENV, nowMs });
      expect(seen.filter((u) => u.includes('googleapis'))).toHaveLength(1);
      // After the rest it is asked again.
      clock.t += 16 * 60_000;
      expect(await webSearch('third question', { fetchImpl: router(googleOk, seen, clock), env: ENV, nowMs })).toHaveLength(8);
    });
  }

  it('a thrown request or an empty answer also falls back', async () => {
    const seen: string[] = [];
    const clock = { t: 1_000_000 };
    const nowMs = () => clock.t;
    const broken = () => {
      throw new TypeError(`fetch failed for https://www.googleapis.com/customsearch/v1?key=${KEY}`);
    };
    expect(await webSearch('a question', { fetchImpl: router(broken, seen, clock), env: ENV, nowMs })).toHaveLength(2);
    clock.t += 2 * 60_000;
    const empty = () => new Response(JSON.stringify({ searchInformation: { totalResults: '0' } }), { status: 200 });
    expect(await webSearch('another question', { fetchImpl: router(empty, seen, clock), env: ENV, nowMs })).toHaveLength(2);
    expect(events.filter((e) => e.provider === 'google-cse').map((e) => e.outcome)).toEqual(['ERROR', 'EMPTY']);
  });
});

describe('the daily ceiling is never exceeded, and never silently', () => {
  it('(c) sends at most the ceiling, records reaching it once, then falls back', async () => {
    const seen: string[] = [];
    const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
    const nowMs = () => clock.t;
    const env = { ...ENV, BRAIN_SEARCH_DAILY_CEILING: '3' };
    for (let i = 0; i < 5; i += 1) await webSearch(`question ${i}`, { fetchImpl: router(googleOk, seen, clock), env, nowMs });
    expect(seen.filter((u) => u.includes('googleapis'))).toHaveLength(3);
    expect(seen.filter((u) => u.includes('duckduckgo'))).toHaveLength(2);
    expect(events.filter((e) => e.outcome === 'CEILING')).toHaveLength(1);
    expect(events.find((e) => e.outcome === 'CEILING')!.detail).toContain('daily ceiling of 3');
    // A new UTC day opens it again.
    clock.t = Date.parse('2026-11-21T00:05:00Z');
    await webSearch('next day question', { fetchImpl: router(googleOk, seen, clock), env, nowMs });
    expect(seen.filter((u) => u.includes('googleapis'))).toHaveLength(4);
  });

  it('defaults to the registry ceiling of 100 (no spend until the owner raises it), and holds across a restart', async () => {
    expect(integration('google-search').dailyCeiling).toBe(100);
    const seen: string[] = [];
    const now = Date.parse('2026-11-20T10:00:00Z');
    seedKeyedSearchUsage('google-cse', 100, now);
    await webSearch('after a restart', { fetchImpl: router(googleOk, seen, { t: now }), env: ENV, nowMs: () => now });
    expect(seen.every((u) => u.includes('duckduckgo'))).toBe(true);
  });

  it('counts concurrent searches before they are sent, so a burst cannot overshoot', async () => {
    const seen: string[] = [];
    const env = { ...ENV, BRAIN_SEARCH_DAILY_CEILING: '5' };
    const google = router(googleOk, []);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return String(input).includes('googleapis') ? google(input, init) : new Response(DDG_HTML, { status: 200 });
    }) as typeof fetch;
    let clock = 1_000_000;
    await Promise.all(Array.from({ length: 12 }, (_, i) => webSearch(`burst ${i}`, { fetchImpl, env, nowMs: () => (clock += 5_000) })));
    expect(seen.filter((u) => u.includes('googleapis'))).toHaveLength(5);
  });
});

describe('with no secret, search is exactly what it was', () => {
  it('(d) never asks Google and answers from DuckDuckGo as before', async () => {
    const seen: string[] = [];
    for (const env of [{} as NodeJS.ProcessEnv, { BRAIN_SEARCH_API_KEY: KEY } as NodeJS.ProcessEnv]) {
      resetSearchState();
      seen.length = 0;
      events = [];
      const urls = await webSearch('sba size standards', { fetchImpl: router(googleOk, seen), env });
      expect(urls).toEqual(['https://ddg.example/one', 'https://ddg.example/two']);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('duckduckgo.com/');
      expect(searchStats.keyed).toBe(0);
      expect(events.map((e) => e.provider)).toEqual([expect.stringMatching(/^(html|lite)$/)]);
    }
  });

  it('says search is refusing only when DuckDuckGo refuses and no keyed provider can answer', async () => {
    const refused = (async () => new Response('anomaly-modal', { status: 202 })) as unknown as typeof fetch;
    await webSearch('refused everywhere', { fetchImpl: refused, env: {}, sleepMs: async () => {}, nowMs: () => 1_000_000 });
    expect(webSearchRefusing({}, 1_000_000)).toBe(true);
    expect(webSearchRefusing(ENV, 1_000_000)).toBe(false);
  });

  it('the registry reports the integration missing until both settings are present', async () => {
    const missing = (await readIntegrations({ env: {} })).find((one) => one.id === 'google-search')!;
    expect(missing.state).toBe('REPAIRING');
    expect(missing.detail).toContain('BRAIN_SEARCH_API_KEY');
    const owner = (await readIntegrations({ env: {}, githubSecrets: new Set() })).find((one) => one.id === 'google-search')!;
    expect(owner.state).toBe('NEEDS_OWNER');
    const set = (await readIntegrations({ env: ENV })).find((one) => one.id === 'google-search')!;
    expect(set.state).toBe('CONFIGURED');
    expect(JSON.stringify(set)).not.toContain(KEY);
  });
});

describe('the key never leaves the request', () => {
  it('(e) appears in no recorded event and no error text, whatever Google or the network said', async () => {
    const seen: string[] = [];
    const clock = { t: 1_000_000 };
    const nowMs = () => clock.t;
    const leaky = () => {
      throw new Error(`connect ECONNREFUSED https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(KEY)}&cx=${CX}`);
    };
    for (const [i, google] of [googleOk, googleQuota, leaky, googleForbidden].entries()) {
      clock.t += 7 * 60 * 60_000; // past any rest
      await webSearch(`question ${i}`, { fetchImpl: router(google, seen, clock), env: ENV, nowMs });
    }
    expect(events.filter((e) => e.provider === 'google-cse').map((e) => e.outcome)).toEqual(['ANSWERED', 'REFUSED', 'ERROR', 'REFUSED']);
    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain(KEY);
    expect(recorded).not.toContain(encodeURIComponent(KEY));
    expect(recorded).not.toContain('key=');
    expect(recorded).toContain('rateLimitExceeded');
  });
});
