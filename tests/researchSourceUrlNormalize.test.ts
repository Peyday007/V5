import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../server/services/research/sources.ts';

const norm = (raw: string) => normalizeUrl(new URL(raw));

describe('normalizeUrl tracking parameters', () => {
  it('strips every utm_* key and known trackers, keeps content parameters, drops the fragment', () => {
    const out = norm(
      'https://Example.com/page?utm_source=x&utm_medium=y&utm_campaign=z&id=3&fbclid=z#section',
    );
    expect(out).toBe('https://example.com/page?id=3');
  });

  it('reads one page cited with different campaign tags as one URL', () => {
    expect(norm('https://example.com/a?utm_source=one')).toBe(norm('https://example.com/a?utm_source=two&gclid=9'));
  });

  it('strips the other named trackers case-insensitively and leaves other keys alone', () => {
    expect(norm('https://example.com/a?UTM_Term=q&mc_cid=1&mc_eid=2&ref=r&page=2')).toBe(
      'https://example.com/a?page=2',
    );
  });
});
