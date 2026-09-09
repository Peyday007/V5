/**
 * The same question, asked many ways — as an automated matrix rather than as
 * homework for a person.
 *
 * The semantic merge was demonstrated in production once, on one pair of
 * messages that were chosen after measuring them against
 * `SEMANTIC_MERGE_FLOOR`. That is recovery evidence for a repaired mechanism
 * and it is reported at that strength (evidence §56.4). What it is not is
 * coverage: one pair says nothing about the tenth rewording, the one that
 * changes tense, or the one that shares every word and means something else.
 *
 * Getting that coverage by asking the owner to type variations turns a person
 * into a test harness, which is both slow and a worse test — they would
 * naturally write pairs that feel similar, which is the easy half. So the
 * variations live here, they run on every commit, and the live run stays what
 * it is: one real pair, reported as one real pair.
 *
 * **This file is automated evidence and never live evidence.** It exercises
 * `clearsFloor`, the guard `capture` applies before it merges anything. It
 * does not exercise a worker's `duplicateOf` claim, which is the other half and
 * only a model can produce — the two are deliberately separate, because §24's
 * whole point is that neither is sufficient alone.
 */
import { describe, expect, it } from 'vitest';
import { clearsFloor, overlap, SEMANTIC_MERGE_FLOOR } from '../server/services/russell/similarity.ts';

/** The statement an idea was first captured from. */
const ORIGINAL =
  'establish which Michigan counties publish building permit data in a usable form, and on what terms';

/**
 * Rewordings of that same question.
 *
 * Chosen to vary one thing at a time — word order, tense, register, synonym,
 * length, punctuation — rather than to be easy. Each says the same thing to a
 * reader, so a floor that refuses one is refusing a genuine repeat.
 */
const SAME_QUESTION = [
  ['reordered', 'on what terms do Michigan counties publish building permit data, and which of them do'],
  ['past tense', 'we established which Michigan counties published building permit data and on what terms'],
  ['plainer register', 'which Michigan counties put out building permit data we can actually use, and how'],
  ['abbreviated', 'which MI counties publish usable building permit data, and on what terms'],
  ['longer, with an aside', 'the question is which Michigan counties publish building permit data in a form we could consume, and what the licence terms on that data are — it matters for the coverage layer'],
  ['punctuation and case', 'WHICH MICHIGAN COUNTIES PUBLISH BUILDING PERMIT DATA?! In a usable form, on what terms?'],
  ['question form', 'do Michigan counties publish building permit data in a usable form, and what terms apply'],
] as const;

/**
 * Genuinely different questions, which the floor does refuse.
 *
 * Different subject words, so the overlap is low and `clearsFloor` says no.
 */
const DIFFERENT_QUESTION = [
  ['same domain, different fact', 'when a property changes hands, how long does the county register take to show the transfer'],
  ['unrelated', 'whether a success-fee intermediary needs a broker licence in Florida'],
] as const;

/**
 * Different questions the floor **does not** refuse, recorded rather than
 * asserted away.
 *
 * These share almost every content word with the original and differ in the one
 * that carries the meaning — `restaurant inspection` for `building permit`,
 * `what does it cost` for `who publishes it`. A subject-word overlap cannot
 * see that, and measured here they score 0.71 and 0.50 against a floor of
 * 0.34.
 *
 * **That is the design working, not a defect.** §24 is explicit that the floor
 * "is a guard, never the decision, and it only ever *refuses*" — a merge needs
 * the worker's `duplicateOf` claim **as well**, and neither half is sufficient:
 * "the claim alone would let a confident model fold unrelated ideas into one,
 * and the floor alone cannot recognise a rewording." These pairs are precisely
 * the case the claim exists to decide, and pinning their scores here is what
 * stops somebody later reading the floor as a similarity judge.
 */
const NEAR_VOCABULARY = [
  ['same words, different subject', 'which Michigan counties publish restaurant inspection data in a usable form'],
  ['adjacent but separate', 'what does Michigan charge for a building permit, and who sets the fee'],
] as const;

describe('the same question asked another way is recognised as the same question', () => {
  for (const [label, variation] of SAME_QUESTION) {
    it(`clears the floor when it is ${label}`, () => {
      const verdict = clearsFloor(ORIGINAL, variation);
      expect(
        verdict.ok,
        `${label}: scored ${verdict.score} against a floor of ${SEMANTIC_MERGE_FLOOR}`,
      ).toBe(true);
      // The verdict carries its numbers either way, because a refusal is a
      // fact about the pair worth recording rather than a bare false.
      expect(verdict.shared.length).toBeGreaterThan(0);
    });
  }

  it('is symmetric, so which message arrived first cannot change the answer', () => {
    for (const [label, variation] of SAME_QUESTION) {
      const forward = clearsFloor(ORIGINAL, variation);
      const backward = clearsFloor(variation, ORIGINAL);
      expect(backward.ok, label).toBe(forward.ok);
      expect(backward.score, label).toBeCloseTo(forward.score, 10);
    }
  });

  it('recognises a statement as itself', () => {
    const verdict = clearsFloor(ORIGINAL, ORIGINAL);
    expect(verdict.ok).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(SEMANTIC_MERGE_FLOOR);
  });
});

describe('a question about something else is refused', () => {
  for (const [label, other] of DIFFERENT_QUESTION) {
    it(`refuses ${label}`, () => {
      const verdict = clearsFloor(ORIGINAL, other);
      expect(
        verdict.ok,
        `${label}: scored ${verdict.score}, which cleared a floor it should not have`,
      ).toBe(false);
      // The refusal says why, in terms a person could read on a merge row —
      // either too few shared subject words, or too low an overlap.
      expect(verdict.reason).toMatch(/subject word|overlap/i);
    });
  }

  it('separates every rewording from every different question', () => {
    /*
     * The property that matters more than the threshold itself: the floor sits
     * between the two populations. If the worst rewording scored below the best
     * different question, no threshold could be right and the guard would be
     * luck rather than a measurement.
     */
    const sameScores = SAME_QUESTION.map(([, text]) => overlap(ORIGINAL, text).score);
    const otherScores = DIFFERENT_QUESTION.map(([, text]) => overlap(ORIGINAL, text).score);
    expect(Math.min(...sameScores)).toBeGreaterThan(Math.max(...otherScores));
    // And the floor is actually between them, rather than merely below both.
    expect(SEMANTIC_MERGE_FLOOR).toBeGreaterThan(Math.max(...otherScores));
    expect(SEMANTIC_MERGE_FLOOR).toBeLessThan(Math.min(...sameScores));
  });
});

describe('the floor alone cannot tell two questions apart, and does not claim to', () => {
  for (const [label, other] of NEAR_VOCABULARY) {
    it(`lets ${label} through, which is why the worker's claim is required`, () => {
      const verdict = clearsFloor(ORIGINAL, other);
      expect(verdict.ok).toBe(true);
      /*
       * Asserted deliberately. If somebody later "fixes" this by raising the
       * floor until these fail, the reworded pairs above fail with them — and
       * the merge stops recognising a rewording, which is the whole feature.
       * The remedy for these is the half that reads the sentences.
       */
    });
  }

  it('merges nothing on its own: a high score is permission to consider, not to merge', () => {
    // `capture` requires the worker to have named the idea it believes this
    // repeats *and* the floor to clear. This file exercises the second only.
    const scored = NEAR_VOCABULARY.map(([, text]) => overlap(ORIGINAL, text).score);
    expect(Math.max(...scored)).toBeGreaterThan(SEMANTIC_MERGE_FLOOR);
  });
});

describe('the floor refuses rather than decides', () => {
  it('says no to an empty or wordless statement instead of merging on nothing', () => {
    for (const empty of ['', '   ', '???', '...']) {
      expect(clearsFloor(ORIGINAL, empty).ok).toBe(false);
    }
  });

  it('does not merge two statements that are both short and generic', () => {
    // Two vague ideas are not one idea. A floor that folded them would make
    // the backlog tidier and the project poorer.
    expect(clearsFloor('look into the data', 'look into the terms').ok).toBe(false);
  });
});
