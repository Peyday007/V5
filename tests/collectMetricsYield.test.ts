import { describe, expect, it } from 'vitest';
import { joinSourceYield } from '../server/services/collect/metrics/yield.ts';
import type { SourceMetricsReading } from '../server/repos/collectMetrics.ts';

const pull = (source: string, o: Partial<SourceMetricsReading> = {}): SourceMetricsReading => ({
  source, pulls: 4, fetched: 100, inserted: 60, duplicates: 40, relevant: 10, signals: 2, claudeJobs: 0, cheapCalls: 20,
  failuresByCause: {}, method: 'RSS_ATOM', ...o,
});

describe('joinSourceYield', () => {
  it('ranks by downstream yield, not by volume', () => {
    const rows = joinSourceYield(
      [pull('big', { fetched: 5000 }), pull('small', { fetched: 10 })],
      [{ source: 'big', urlKey: 'a.test/1' }, { source: 'small', urlKey: 'b.test/1' }],
      [{ urlKey: 'b.test/1', verified: true, useful: true, qualified: true }],
    );
    expect(rows.map((r) => r.source)).toEqual(['small', 'big']);
    expect(rows[0]).toMatchObject({ openings: 1, qualified: 1, verified: 1 });
    expect(rows[1]).toMatchObject({ shortlisted: 1, shortlistedNoOpening: 1, openings: 0 });
  });

  it('counts an unreachable source as a failure and an empty one as not', () => {
    const [row] = joinSourceYield(
      [pull('s', { failuresByCause: { SOURCE_UNREACHABLE: 1, NO_MATCHING_RECORDS: 2 } })], [], [],
    );
    expect(row?.failedPulls).toBe(1);
    expect(row?.failureRate).toBe(0.25);
    expect(row?.failuresByCause.NO_MATCHING_RECORDS).toBe(2);
  });

  it('reports duplicate rate and leaves it null when nothing was fetched', () => {
    const [a] = joinSourceYield([pull('a')], [], []);
    expect(a?.duplicateRate).toBe(0.4);
    const [b] = joinSourceYield([pull('b', { fetched: 0, duplicates: 0 })], [], []);
    expect(b?.duplicateRate).toBeNull();
  });

  it('counts one page once however many leads point at it', () => {
    const [r] = joinSourceYield(
      [pull('s')],
      [{ source: 's', urlKey: 'x/1' }, { source: 's', urlKey: 'x/1' }],
      [{ urlKey: 'x/1', verified: false, useful: true, qualified: false }],
    );
    expect(r).toMatchObject({ shortlisted: 2, openings: 1, useful: 1, shortlistedNoOpening: 0 });
  });

  it('includes a source that was shortlisted but never pulled by a recorded pull', () => {
    const rows = joinSourceYield([], [{ source: 'ghost', urlKey: null }], []);
    expect(rows[0]).toMatchObject({ source: 'ghost', pulls: 0, failureRate: null, shortlistedNoOpening: 1 });
  });
});
