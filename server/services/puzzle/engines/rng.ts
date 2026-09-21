/**
 * A deterministic pseudo-random sequence from a seed string.
 *
 * Every engine draws from this and none of them calls `Math.random`, because
 * determinism is not a nicety here: it is what makes a generator defect
 * reproducible, and a defect you cannot reproduce is one you can only patch
 * per artifact. The directive is explicit that patching artifacts and leaving
 * the source defect alive is the wrong repair.
 *
 * It is deliberately a small, fixed, well-known construction rather than
 * anything from `node:crypto`. A cryptographic generator would be *stronger*
 * and would also make the sequence depend on the runtime's implementation,
 * which is the one property this must not have: the same seed has to give the
 * same puzzle on the machine that generated it, on the machine that validates
 * it, and on a machine that reproduces it in two years to find out why a book
 * printed wrong.
 *
 * This is not a security primitive and nothing may use it as one. Seeds here
 * are content identifiers, not secrets.
 */

/** FNV-1a over the seed string, so any text is a usable 32-bit state. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). Returns 0 for a bound of zero or less. */
  int(bound: number): number;
  /** A copy of `items` in a deterministic shuffled order. Never mutates the input. */
  shuffled<T>(items: readonly T[]): T[];
  /** One of `items`, or undefined when there are none. */
  pick<T>(items: readonly T[]): T | undefined;
}

/**
 * Mulberry32. Fast, tiny, and — the property that matters — exactly specified
 * by these four lines, so it cannot change underneath a seed.
 */
export function rngFor(seed: string): Rng {
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => (bound <= 0 ? 0 : Math.floor(next() * bound));
  return {
    next,
    int,
    shuffled<T>(items: readonly T[]): T[] {
      const out = [...items];
      // Fisher-Yates, downward, which is the form whose bias is zero rather
      // than merely small.
      for (let index = out.length - 1; index > 0; index -= 1) {
        const swap = int(index + 1);
        const a = out[index] as T;
        const b = out[swap] as T;
        out[index] = b;
        out[swap] = a;
      }
      return out;
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[int(items.length)];
    },
  };
}
