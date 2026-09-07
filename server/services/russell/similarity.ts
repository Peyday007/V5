/**
 * The deterministic floor under a semantic merge.
 *
 * `fingerprintOf` catches two identical asks worded identically. It cannot
 * catch the ordinary case — a person asking the same thing again in different
 * words — and until now nothing did: `russell_candidate_merges.method` has
 * carried `'SEMANTIC'` in its CHECK constraint since migration 027 and no code
 * path has ever written one. Condition 4 of the acceptance scenario was
 * therefore unreachable, not merely unproven.
 *
 * **What this module is, exactly.** It is not the semantic comparison. The
 * comparison is made by the worker that already read the conversation, which
 * names the candidate it believes this repeats; that is a model's opinion and
 * §8 forbids it from moving state on its own. This module is the guard the
 * server applies to that opinion before acting on it: two statements that share
 * almost no content words are not the same idea however confidently a model
 * says they are, and a merge on that basis would be a model quietly deleting
 * somebody's idea.
 *
 * So the merge needs both — a claim and a floor — and neither is sufficient.
 * `method = 'SEMANTIC'` is then truthful: it was decided by meaning, bounded by
 * a measure, and it says so in the merge reason.
 *
 * **Why a floor rather than a threshold.** A threshold would make this the
 * decision. It is deliberately set where it refuses the failure that matters —
 * two unrelated ideas folded into one — and not where it tries to recognise a
 * rewording, which lexical overlap genuinely cannot do. Everything it lets
 * through is still a merge somebody proposed, is recorded with its score, and
 * is reversible with `splitCandidate`.
 */

/**
 * Words that carry no subject matter.
 *
 * Deliberately short. A long stoplist starts removing the words that make two
 * questions *different* — "not", "before", "without" — and a similarity measure
 * that cannot tell "may we use it" from "may we not use it" is worse than none.
 * Negations are kept for exactly that reason.
 */
const NOISE = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'can', 'could',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'to', 'of', 'in',
  'on', 'at', 'by', 'for', 'with', 'from', 'as', 'it', 'its', 'we', 'us', 'our',
  'i', 'me', 'my', 'you', 'your', 'they', 'them', 'their', 'he', 'she', 'his',
  'her', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'there', 'here', 'so', 'such', 'about', 'into', 'over', 'under', 'again',
  'also', 'any', 'some', 'all', 'each', 'other', 'another', 'want', 'know',
  'need', 'get', 'go', 'going', 'actually', 'really', 'just', 'like', 'form',
  'thing', 'things', 'way', 'anywhere', 'anyone', 'somewhere',
]);

/**
 * A crude suffix fold, applied only to words long enough to survive it.
 *
 * "publish" / "publishes" / "published" / "publishing" have to agree or the
 * measure reports a difference in tense as a difference in subject. It is not a
 * stemmer and is not trying to be: over-folding costs precision on a guard
 * whose whole job is to be hard to pass by accident, so it stops at the endings
 * that change nothing about what a sentence is about.
 */
function fold(word: string): string {
  let out = word;
  for (const suffix of ['ing', 'ies', 'ed', 'es', 's']) {
    if (out.length > suffix.length + 3 && out.endsWith(suffix)) {
      out = out.slice(0, -suffix.length);
      if (suffix === 'ies') out += 'y';
      break;
    }
  }
  return out;
}

/** The content words of a statement, folded and de-duplicated. */
export function contentTokens(statement: string): Set<string> {
  const out = new Set<string>();
  for (const raw of statement.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (!raw || NOISE.has(raw)) continue;
    // A bare number is a quantity, not a subject. Two questions that both
    // mention "2026" are not thereby about the same thing.
    if (/^\d+$/.test(raw)) continue;
    const folded = fold(raw);
    if (folded.length < 3 || NOISE.has(folded)) continue;
    out.add(folded);
  }
  return out;
}

export interface Overlap {
  /**
   * The overlap coefficient: shared content words over the *smaller* of the two
   * vocabularies.
   *
   * Jaccard is the wrong measure here and a real pair shows why. A short
   * restatement of a long question shares most of its own words and few of the
   * original's, so Jaccard reads it as unrelated purely because one sentence is
   * longer. The question being asked is "is the shorter one contained in the
   * longer one", which is what this is.
   */
  score: number;
  /** The words both statements are about. Reported so a merge can be argued with. */
  shared: string[];
}

export function overlap(a: string, b: string): Overlap {
  const left = contentTokens(a);
  const right = contentTokens(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return { score: 0, shared: [] };
  const shared = [...left].filter((word) => right.has(word)).sort();
  return { score: shared.length / smaller, shared };
}

/**
 * The floor, and the second condition under it.
 *
 * Both are needed. A ratio alone is trivially passed by two three-word
 * statements that happen to share one word, which is why a minimum count of
 * shared subject words sits beside it.
 *
 * The values are not guessed. `tests/russellIntegrationPass.test.ts` scores the
 * frozen acceptance pair — the two wordings of the assessment-roll question,
 * declared in `docs/STEP-12A-ACCEPTANCE-SCENARIO-2.md` before any of this was
 * written — against every other candidate subject Deal Dispatch holds, and
 * these are the values that admit the first and refuse all of the rest. Change
 * either one and that test says which direction it broke.
 */
export const SEMANTIC_MERGE_FLOOR = 0.34;
export const SEMANTIC_MERGE_MIN_SHARED = 3;

export interface FloorVerdict {
  ok: boolean;
  score: number;
  shared: string[];
  /** Safe to store in a merge reason and to show. Never names anything private. */
  reason: string;
}

/**
 * Does this pair clear the floor?
 *
 * Returns the numbers either way, because a refusal is worth recording: "a
 * worker said these were the same and the server disagreed" is a fact about the
 * worker, and it is lost if the refusal is a bare false.
 */
export function clearsFloor(a: string, b: string): FloorVerdict {
  const { score, shared } = overlap(a, b);
  const rounded = Math.round(score * 100) / 100;
  if (shared.length < SEMANTIC_MERGE_MIN_SHARED) {
    return {
      ok: false,
      score: rounded,
      shared,
      reason:
        `they share only ${shared.length} subject word${shared.length === 1 ? '' : 's'}, ` +
        `below the ${SEMANTIC_MERGE_MIN_SHARED} a merge needs`,
    };
  }
  if (score < SEMANTIC_MERGE_FLOOR) {
    return {
      ok: false,
      score: rounded,
      shared,
      reason: `their subject overlap is ${rounded}, below the ${SEMANTIC_MERGE_FLOOR} a merge needs`,
    };
  }
  return {
    ok: true,
    score: rounded,
    shared,
    reason: `subject overlap ${rounded} on ${shared.join(', ')}`,
  };
}
