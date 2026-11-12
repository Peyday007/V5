/**
 * A revised search method's round is asked differently, and the revision rides
 * on the bucket rather than on a `questionFor` parameter (repair-F4-3).
 *
 * Production rewrote `questionFor`'s signature and body (it gained an
 * exclusions parameter and the standing operating sentence), and the campaign
 * had added a revision parameter in the same place, so the two could not be
 * merged. Carrying the revision in the bucket's question keeps every caller,
 * production's included, asking the revised round with no signature change.
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_BUCKETS, questionFor, withRevision } from '../server/services/cash/discovery.ts';

describe('withRevision', () => {
  const bucket = SEARCH_BUCKETS[0]!;
  const revision = 'Revision 2 (HIGH_FALSE_POSITIVES): earlier rounds mostly re-reported openings Brain already held.';

  it('leaves the bucket untouched when there is no revision', () => {
    expect(withRevision(bucket, null)).toBe(bucket);
    expect(withRevision(bucket, '')).toBe(bucket);
  });

  it('puts the revision into the question questionFor asks, without mutating the listed bucket', () => {
    const before = bucket.question;
    const revised = withRevision(bucket, revision);
    expect(revised.id).toBe(bucket.id);
    expect(bucket.question).toBe(before);
    const asked = questionFor(revised, 'Maximize additional usable cash.', 1, []);
    expect(asked).toContain(before);
    expect(asked).toContain(revision);
    expect(questionFor(bucket, 'Maximize additional usable cash.', 1, [])).not.toContain(revision);
  });
});
