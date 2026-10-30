import { describe, expect, it } from 'vitest';
import { canonicalUrl, recordKey, type CollectedRecord } from '../server/services/collect/dedupe/keys.ts';
import { findDuplicate, mergeSources, type KnownRecord } from '../server/services/collect/dedupe/match.ts';

const rec = (o: Partial<CollectedRecord>): CollectedRecord => ({
  source: 'a', externalId: '1', url: 'https://x.com/j/1', title: 'Data Analyst', organization: 'Acme Inc', publishedAt: '2026-10-01T10:00:00Z', body: 'b', ...o,
});

describe('collect dedupe', () => {
  it('canonicalises urls', () => {
    expect(canonicalUrl('HTTP://www.X.com:80/j/1/?utm_source=a&b=2&a=1#frag')).toBe('https://x.com/j/1?a=1&b=2');
    expect(canonicalUrl('mailto:a@b.c')).toBeNull();
    expect(canonicalUrl(null)).toBeNull();
  });
  it('stores the same posting from two sources once, linked to both', () => {
    const known: KnownRecord[] = [{ ...rec({}), id: 'r1', sources: ['a'] }];
    const incoming = rec({ source: 'b', externalId: 'zz', url: 'https://other.com/p', title: 'Senior Data Analyst (Remote)', organization: 'ACME, Inc.', publishedAt: '2026-10-01T23:00:00Z', body: 'different' });
    const m = findDuplicate(incoming, known);
    expect(m).toEqual({ kind: 'SAME_KEY', earlierId: 'r1' });
    expect(mergeSources(['a'], 'b')).toEqual(['a', 'b']);
  });
  it('matches by url across formatting', () => {
    const known: KnownRecord[] = [{ ...rec({}), id: 'r1', sources: ['a'] }];
    expect(findDuplicate(rec({ source: 'b', externalId: '9', url: 'https://www.x.com/j/1/?utm_campaign=z', title: 'Other' }), known)?.kind).toBe('SAME_URL');
  });
  it('near-matches close titles within days, not different orgs', () => {
    const known: KnownRecord[] = [{ ...rec({ title: 'Data Analyst Reporting Team' }), id: 'r1', sources: ['a'] }];
    const near = rec({ source: 'b', externalId: '2', url: 'https://q.com/2', title: 'Lead Data Analyst Reporting Team', publishedAt: '2026-10-03T00:00:00Z', body: 'x' });
    expect(findDuplicate(near, known)?.kind).toBe('NEAR');
    expect(findDuplicate({ ...near, organization: 'Other Co' }, known)).toBeNull();
  });
  it('never keys an unnamed organisation', () => {
    expect(recordKey({ organization: null, title: 'x', publishedAt: null })).toBeNull();
  });
});
