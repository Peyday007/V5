import { describe, expect, it } from 'vitest';
import { recordContentHash, type CollectedRecord } from '../server/services/collect/dedupe/keys.ts';
import { diffPull, pageChanged, type HeldRecord } from '../server/services/collect/changes/diff.ts';
import { falsePositiveRate, routeChanges } from '../server/services/collect/changes/triggers.ts';

const rec = (o: Partial<CollectedRecord>): CollectedRecord => ({
  source: 'remoteok', externalId: '1', url: 'https://x.com/1', title: 'Data Analyst', organization: 'Acme', publishedAt: '2026-10-28T00:00:00Z', body: 'b', ...o,
});
const held = (r: CollectedRecord, id: string): HeldRecord => ({ ...r, id, contentHash: recordContentHash(r) });

describe('collect changes', () => {
  it('versions new, changed and disappeared records; skips unchanged and duplicate deliveries', () => {
    const a = rec({ externalId: 'a' });
    const b = rec({ externalId: 'b' });
    const c = rec({ externalId: 'c' });
    const { changes, unchanged } = diffPull({
      held: [held(a, 'ra'), held(b, 'rb'), held(c, 'rc')],
      pulled: [a, { ...b, title: 'Data Lead' }, rec({ externalId: 'n' }), rec({ externalId: 'n' })],
      complete: true,
    });
    expect(unchanged).toBe(1);
    expect(changes.map((x) => [x.kind, x.externalId])).toEqual([['CHANGED', 'b'], ['NEW', 'n'], ['DISAPPEARED', 'c']]);
    expect(changes[0]!.fields).toEqual(['title']);
  });
  it('an incomplete pull never calls a record gone', () => {
    const a = rec({ externalId: 'a' });
    expect(diffPull({ held: [held(a, 'ra')], pulled: [], complete: false }).changes).toEqual([]);
  });
  it('page watch does not reprocess unchanged content', () => {
    expect(pageChanged(null, 'h')).toBe('FIRST');
    expect(pageChanged('h', 'h')).toBe('UNCHANGED');
    expect(pageChanged('h', 'g')).toBe('CHANGED');
  });
  it('matched changes route to code (no cheap lane); unusual unmatched go to the cheap lane', () => {
    const now = new Date('2026-10-29T00:00:00Z');
    const titles = ['Data Analyst', 'Data Engineer', 'Analytics Manager'];
    const changes = diffPull({ held: [], pulled: titles.map((t, i) => rec({ externalId: String(i), title: t })), complete: false }).changes;
    const routed = routeChanges(changes, [], now);
    expect(routed.every((r) => r.route === 'MATCHED_BY_CODE')).toBe(true);
    const gone = diffPull({ held: [held(rec({ externalId: 'z', organization: 'Solo' }), 'rz')], pulled: [], complete: true }).changes;
    expect(routeChanges(gone, [], now)[0]!.route).toBe('CHEAP_LANE');
  });
  it('false-positive rate is null until a rule fires', () => {
    expect(falsePositiveRate({ rule: 'r', fired: 0, falsePositives: 0 })).toBeNull();
    expect(falsePositiveRate({ rule: 'r', fired: 4, falsePositives: 1 })).toBe(0.25);
  });
});
