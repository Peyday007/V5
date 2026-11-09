import { describe, expect, it } from 'vitest';
import { judgeAcquisitionNeed, repeatedUseFromRows } from '../server/services/sources/acquisition.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const row = (url: string, at: string, provider = 'DIRECT', attempts?: string[]) => ({
  provider,
  at,
  measures: JSON.stringify({ host: 'example.org', url, ...(attempts ? { attempts: attempts.map((method) => ({ method })) } : {}) }),
});

describe('repeatedUseFromRows counts repeated work, not host traffic', () => {
  it('many different pages on one host are not repetition', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`https://example.org/page-${i}`, hoursAgo(i), 'BROWSER'));
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW }).repeatedUses).toBe(1);
  });

  it('the same workflow read again counts, whatever its query string', () => {
    const rows = [
      row('https://example.org/search?q=a', hoursAgo(1)),
      row('https://example.org/search?q=b', hoursAgo(2)),
      row('https://example.org/search/', hoursAgo(3)),
      row('https://example.org/other', hoursAgo(4)),
    ];
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW }).repeatedUses).toBe(3);
  });

  it('rows outside the window or undated are ignored', () => {
    const rows = [
      row('https://example.org/a', hoursAgo(1)),
      row('https://example.org/a', hoursAgo(24 * 30)),
      { provider: 'DIRECT', at: null, measures: JSON.stringify({ host: 'example.org', url: 'https://example.org/a' }) },
    ];
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW }).repeatedUses).toBe(1);
  });

  it('a fallback is a read whose attempts went beyond DIRECT, not any non-DIRECT provider label', () => {
    const rows = [
      row('https://example.org/a', hoursAgo(1), 'ARCHIVE', ['DIRECT']),
      row('https://example.org/a', hoursAgo(2), 'DIRECT', ['DIRECT', 'BROWSER']),
      row('https://example.org/a', hoursAgo(3), 'DIRECT', ['DIRECT']),
    ];
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW })).toEqual({ repeatedUses: 3, repeatedUsesNeedingFallback: 1 });
  });

  it('host volume alone does not justify a connector', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`https://example.org/p${i}`, hoursAgo(i), 'BROWSER', ['DIRECT', 'BROWSER']));
    const counted = repeatedUseFromRows(rows, 'example.org', { now: NOW });
    const j = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'x', host: 'example.org' }, { authorizedAccountOnRecord: true, ...counted });
    expect(j.reusableConnectorJustified).toBe(false);
  });
});
