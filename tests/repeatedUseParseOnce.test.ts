import { afterEach, describe, expect, it, vi } from 'vitest';
import { repeatedUseFromRows } from '../server/services/sources/acquisition.ts';

/*
 * Production, 2026-11-17 (04b754ce): `repeatedUseFromRows` was the top Brain
 * self-time frame in every stall profile while ~12 GPU research jobs read
 * pages, because each page read re-parsed the JSON of all 5 000 held
 * SOURCE_ACCESS rows. A held row is parsed once; the counts are unchanged.
 */
const NOW = Date.parse('2026-11-17T20:42:00.000Z');

function row(i: number, host: string, path: string, attempts: string[], at = new Date(NOW - i * 60_000).toISOString()) {
  return {
    provider: attempts[attempts.length - 1] ?? 'DIRECT',
    measures: JSON.stringify({
      host,
      url: `https://${host}${path}?page=${i}`,
      attempts: attempts.map((method) => ({ method, readable: method !== 'DIRECT', reason: null, status: 200, ms: 10 })),
      methodConsidered: [{ method: 'HTTP', fit: true, note: 'x'.repeat(200) }],
    }),
    at,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('repeatedUseFromRows parses a held row once', () => {
  it('counts the most-repeated workflow of the host, with its fallbacks, as before', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row(i, 'www.houzz.com', '/pro/list', ['DIRECT', 'BROWSER'])),
      ...Array.from({ length: 2 }, (_, i) => row(10 + i, 'WWW.HOUZZ.COM', '/pro/list/', ['DIRECT'])),
      ...Array.from({ length: 3 }, (_, i) => row(20 + i, 'www.houzz.com', '/other', ['DIRECT'])),
      ...Array.from({ length: 9 }, (_, i) => row(30 + i, 'archive.org', '/pro/list', ['ARCHIVE'])),
      // Outside the 14-day window, undated, and unparseable rows count toward nothing.
      row(40, 'www.houzz.com', '/pro/list', ['BROWSER'], new Date(NOW - 15 * 86_400_000).toISOString()),
      { provider: 'BROWSER', measures: JSON.stringify({ host: 'www.houzz.com', url: 'https://www.houzz.com/pro/list' }), at: null },
      { provider: 'BROWSER', measures: '{not json', at: new Date(NOW).toISOString() },
      { provider: 'BROWSER', measures: null, at: new Date(NOW).toISOString() },
    ];
    expect(repeatedUseFromRows(rows, 'www.houzz.com', { now: NOW })).toEqual({ repeatedUses: 6, repeatedUsesNeedingFallback: 4 });
    expect(repeatedUseFromRows(rows, 'Www.Houzz.com', { now: NOW })).toEqual({ repeatedUses: 6, repeatedUsesNeedingFallback: 4 });
    expect(repeatedUseFromRows(rows, 'archive.org', { now: NOW })).toEqual({ repeatedUses: 9, repeatedUsesNeedingFallback: 9 });
    expect(repeatedUseFromRows(rows, 'none.example', { now: NOW })).toEqual({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 });
  });

  it('does not parse the held rows again on every read', () => {
    const hosts = ['www.houzz.com', 'www.bizbuysell.com', 'archive.org', 'en.wikipedia.org'];
    const rows = Array.from({ length: 2_000 }, (_, i) => row(i, hosts[i % hosts.length]!, `/p/${i % 7}`, ['DIRECT', 'BROWSER']));
    const parse = vi.spyOn(JSON, 'parse');
    const first = repeatedUseFromRows(rows, 'www.houzz.com', { now: NOW });
    expect(parse.mock.calls.length).toBe(rows.length);
    parse.mockClear();
    for (const host of hosts) repeatedUseFromRows(rows, host, { now: NOW });
    expect(repeatedUseFromRows(rows, 'www.houzz.com', { now: NOW })).toEqual(first);
    // Before the fix this was rows.length per call: 10 000 parses for these five reads.
    expect(parse.mock.calls.length).toBe(0);
  });

  it('reads a row again when its contents changed', () => {
    const one = row(0, 'www.houzz.com', '/a', ['DIRECT']);
    expect(repeatedUseFromRows([one], 'www.houzz.com', { now: NOW })).toEqual({ repeatedUses: 1, repeatedUsesNeedingFallback: 0 });
    one.measures = JSON.stringify({ host: 'archive.org', url: 'https://archive.org/a', attempts: [{ method: 'ARCHIVE' }] });
    expect(repeatedUseFromRows([one], 'www.houzz.com', { now: NOW })).toEqual({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 });
    expect(repeatedUseFromRows([one], 'archive.org', { now: NOW })).toEqual({ repeatedUses: 1, repeatedUsesNeedingFallback: 1 });
  });
});
