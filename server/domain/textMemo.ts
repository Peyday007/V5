/**
 * A pure function of one string, remembered (W15, 2026-11-17).
 *
 * The readers this wraps — who pays, which population a payer is filed under,
 * the canonical form of a plan's dimension — are pure and regex-heavy, and a
 * plan read asked them about the same few hundred strings hundreds of
 * thousands of times (production stall profiles: `canonical` 2.8–4.9 s and
 * `payerNamedIn` 2.1 s of every 60 s). The answer for a string never changes,
 * so it is computed once. The table is bounded: past `max` entries it starts
 * over rather than grow with every string the process ever saw.
 */
export function memoText<T>(name: string, fn: (text: string) => T, max = 20_000): (text: string) => T {
  const seen = new Map<string, T>();
  const stats = { calls: 0, computed: 0 };
  STATS.set(name, stats);
  return (text: string): T => {
    stats.calls += 1;
    const hit = seen.get(text);
    if (hit !== undefined || seen.has(text)) return hit as T;
    stats.computed += 1;
    const value = fn(text);
    if (seen.size >= max) seen.clear();
    seen.set(text, value);
    return value;
  };
}

const STATS = new Map<string, { calls: number; computed: number }>();

/** How often each remembered reader was asked, and how often it actually read: what a linear-work test measures. */
export function memoStats(name: string): { calls: number; computed: number } {
  const one = STATS.get(name);
  return one ? { ...one } : { calls: 0, computed: 0 };
}
