import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_MERGE_FLOOR,
  SEMANTIC_MERGE_MIN_SHARED,
  clearsFloor,
  contentTokens,
  negationWords,
} from '../server/services/russell/similarity.ts';

describe('the semantic-merge floor and negation', () => {
  it('refuses a question and its negation', () => {
    const v = clearsFloor('Should we publish the fees report', 'Should we not publish the fees report');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/negation/);
  });

  it('refuses can / can\'t even with enough shared words', () => {
    const v = clearsFloor(
      'Can the county assessor publish the assessment roll online',
      "The county assessor can't publish the assessment roll online",
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/negation/);
  });

  it('still clears a same-negation pair and a plain pair', () => {
    expect(
      clearsFloor(
        'We should never publish the county assessment roll',
        'Should we never publish the county assessment roll online',
      ).reason,
    ).not.toMatch(/negation/);
    expect(
      clearsFloor('Publish the county assessment roll online', 'Should we publish the county assessment roll online').ok,
    ).toBe(true);
  });

  it('does not refuse when both sides carry the same negation word', () => {
    const v = clearsFloor(
      'Why is the county assessment roll not published online',
      'The county assessment roll is not published online, why',
    );
    expect(v.reason).not.toMatch(/negation/);
    expect(v.ok).toBe(true);
  });

  it('keeps non-ASCII letters intact', () => {
    const t = contentTokens('Zürich café');
    expect(t.has('zürich')).toBe(true);
    expect(t.has('café')).toBe(true);
  });

  it('reads negation words before the length filter', () => {
    expect([...negationWords("No, we won't go without it")].sort()).toEqual(['no', 'not', 'without']);
  });

  it('leaves the floor constants alone', () => {
    expect(SEMANTIC_MERGE_FLOOR).toBe(0.34);
    expect(SEMANTIC_MERGE_MIN_SHARED).toBe(3);
  });
});
