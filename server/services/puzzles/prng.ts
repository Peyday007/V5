/**
 * The seeded randomness every generator draws on.
 *
 * ---------------------------------------------------------------------------
 * Determinism is not a nicety here; it is what makes a seed evidence
 * ---------------------------------------------------------------------------
 *
 * `puzzle_instances.seed` is recorded so that a defect found in March resolves
 * to the exact input that produced the puzzle. That is only true if the same
 * seed and the same generator version produce the same bytes — so nothing in
 * `services/puzzles/` may call `Math.random()`, and a test asserts it by
 * reading the source rather than by observing behaviour, because a generator
 * that reached for the global once in a rare branch would pass every
 * behavioural check until the branch was taken.
 *
 * Node's own `crypto` is not used for the same reason: it is not reproducible
 * from a recorded seed, which is the whole property being bought.
 *
 * The algorithm is mulberry32, chosen because it is short enough to read in
 * one sitting. It is **not** cryptographically secure and nothing here needs
 * it to be: a puzzle whose seed somebody can predict is still a correct
 * puzzle, and the one thing that must never depend on this is a credential —
 * `services/identity/secrets.ts` owns those and does not import this.
 */

/** A deterministic source of numbers, from one recorded seed. */
export interface Prng {
  /** The next value in [0, 1). */
  next(): number;
  /** The next whole number in [0, bound). Returns 0 for a bound below 1. */
  int(bound: number): number;
  /** A copy of `items`, shuffled. The input is never mutated. */
  shuffle<T>(items: readonly T[]): T[];
  /** One item, or undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined;
}

/**
 * A 32-bit hash of the seed string, so any text is a usable starting state.
 *
 * FNV-1a, for its one relevant property: two seeds differing in one character
 * land far apart, so `puzzle-1` and `puzzle-2` do not produce near-identical
 * puzzles. A stronger hash would buy nothing a puzzle can use.
 */
export function seedToState(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // A zero state is a fixed point for some generators. Mulberry32 is fine with
  // it, and moving off it anyway costs nothing and removes the question.
  return (hash >>> 0) || 0x9e3779b9;
}

export function prngFor(seed: string): Prng {
  let state = seedToState(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (bound: number): number => {
    if (!Number.isFinite(bound) || bound < 1) return 0;
    return Math.floor(next() * Math.trunc(bound));
  };

  return {
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      // Fisher-Yates, downward, which is the only form of it that is uniform.
      const out = items.slice();
      for (let index = out.length - 1; index > 0; index -= 1) {
        const swap = int(index + 1);
        const here = out[index];
        const there = out[swap];
        if (here === undefined || there === undefined) continue;
        out[index] = there;
        out[swap] = here;
      }
      return out;
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[int(items.length)];
    },
  };
}
