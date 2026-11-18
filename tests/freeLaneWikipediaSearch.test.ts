/**
 * Wikipedia is the research lane's only keyless search beside DuckDuckGo, so
 * when DuckDuckGo refuses for longer than a fragment waits it must still answer
 * a topic phrase.
 *
 * Production 0ba2eb30, 2026-11-18 01:00–01:45Z: 27 fragments failed "no readable
 * source among N candidate page(s), none from web search". DuckDuckGo was
 * refusing, and Wikipedia's `action=opensearch` matches titles by prefix, so a
 * phrase like "PA DEP abandoned mine reclamation contractor rates" returned
 * nothing. Measured from a sandbox the same day: opensearch and ANDed full-text
 * search both 0 results for that phrase and for "EDDM postcard printing price
 * per piece"; the words ORed returned "Pennsylvania Department of Environmental
 * Protection", "Mine reclamation", "Variable data printing" and "Postcard".
 */
import { describe, expect, it } from 'vitest';
import { wikipediaCandidates, wikipediaSearchQuery } from '../server/services/freeLane/worker.ts';

describe('wikipediaSearchQuery', () => {
  it('ORs the words of a topic phrase so a partial match still answers', () => {
    expect(wikipediaSearchQuery('PA DEP abandoned mine reclamation contractor rates')).toBe(
      'PA OR DEP OR abandoned OR mine OR reclamation OR contractor OR rates',
    );
  });

  it('drops search syntax and operator words a model phrase may carry', () => {
    expect(wikipediaSearchQuery('"EDDM" postcard (printing) price-per-piece OR and $0.20?')).toBe(
      'EDDM OR postcard OR printing OR price-per-piece OR 0 OR 20',
    );
    expect(wikipediaSearchQuery('  ??? ')).toBe('');
  });

  it('caps the term count', () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    expect(wikipediaSearchQuery(many).split(' OR ')).toHaveLength(12);
  });
});

describe('wikipediaCandidates', () => {
  const answer = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('asks the full-text search API, not prefix opensearch, and returns article URLs', async () => {
    let asked = '';
    const fetchImpl = (async (url: string | URL) => {
      asked = String(url);
      return new Response(
        JSON.stringify({
          query: {
            search: [
              { ns: 0, title: 'Pennsylvania Department of Environmental Protection' },
              { ns: 0, title: 'Mine reclamation' },
              { ns: 0, title: 'Surface Mining Control and Reclamation Act of 1977' },
              { ns: 0, title: 'Fourth' },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const urls = await wikipediaCandidates('PA DEP abandoned mine reclamation contractor rates', fetchImpl);
    expect(asked).toContain('list=search');
    expect(asked).not.toContain('opensearch');
    expect(new URL(asked).searchParams.get('srsearch')).toBe(
      'PA OR DEP OR abandoned OR mine OR reclamation OR contractor OR rates',
    );
    expect(urls).toEqual([
      'https://en.wikipedia.org/wiki/Pennsylvania_Department_of_Environmental_Protection',
      'https://en.wikipedia.org/wiki/Mine_reclamation',
      'https://en.wikipedia.org/wiki/Surface_Mining_Control_and_Reclamation_Act_of_1977',
    ]);
  });

  it('answers nothing, without throwing, on a refusal or a malformed body', async () => {
    expect(await wikipediaCandidates('postcard printing', answer({}, 429))).toEqual([]);
    expect(await wikipediaCandidates('postcard printing', answer({ query: { search: 'x' } }))).toEqual([]);
    const throwing = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(await wikipediaCandidates('postcard printing', throwing)).toEqual([]);
  });
});
