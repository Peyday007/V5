/**
 * The optimizer behind POST /api/magic/optimize.
 *
 * Multi-objective beam search over real swaps (cut one copy, add one copy from
 * the pool). A candidate that breaks construction rules, a protected card,
 * colour identity, an exclusion, the price ceiling or the collection limit is
 * rejected before it is scored. Deterministic: a fixed order for every
 * iteration and tie-break, no clock, no randomness.
 */
import { tagCard } from '../analysis/tags.ts';
import { validateDeck, type DeckEntry, type ValidationIssue } from '../rules/validate.ts';
import {
  composite, dominates, normalizeWeights, scoreObjectives, type ScoreContext,
} from './score.ts';
import {
  OBJECTIVES, type DeckLine, type Objective, type OptCard, type OptimizeInput, type OptimizeResult,
  type ScoredBuild, type Swap, type UpgradeRanking, type Weights,
} from './types.ts';

type Counts = Map<string, number>;

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function keyOf(counts: Counts): string {
  return [...counts.entries()].filter(([, q]) => q > 0).sort((a, b) => byName(a[0], b[0])).map(([n, q]) => `${q}:${n}`).join('|');
}

export function optimizeDeck(input: OptimizeInput): OptimizeResult {
  const weights = normalizeWeights(input.weights);
  const cons = input.constraints ?? {};
  const protectedNames = new Set(cons.protectedNames ?? []);
  const excluded = new Set(cons.excludedNames ?? []);
  const ceiling = cons.priceCeilingCents ?? null;
  const owned = cons.owned ?? {};
  const beamWidth = Math.max(1, input.beamWidth ?? 4);
  const maxSwaps = Math.max(1, Math.min(input.maxSwaps ?? 4, 12));
  const maxScored = Math.max(1, input.maxScoredPerLevel ?? 400);
  const topN = Math.max(1, input.topN ?? 10);
  const notes: string[] = [];

  const registry = new Map<string, OptCard>();
  for (const l of input.deck) registry.set(l.card.name, l.card);
  const pool = [...input.pool].sort((a, b) => byName(a.name, b.name));
  for (const c of pool) if (!registry.has(c.name)) registry.set(c.name, c);

  const fixed = input.deck.filter((l) => l.zone !== 'main');
  const base: Counts = new Map();
  for (const l of input.deck) if (l.zone === 'main') base.set(l.card.name, (base.get(l.card.name) ?? 0) + l.quantity);
  const baseKey = keyOf(base);

  const ctx: ScoreContext = {
    format: input.format,
    opponents: input.opponents,
    preferredRoles: input.preferredRoles ?? [],
    priceCeilingCents: ceiling,
  };

  const linesOf = (counts: Counts): DeckLine[] => [
    ...fixed,
    ...[...counts.entries()]
      .filter(([, q]) => q > 0)
      .sort((a, b) => byName(a[0], b[0]))
      .map(([name, quantity]): DeckLine => ({ zone: 'main', quantity, card: registry.get(name)! })),
  ];

  const issuesOf = (lines: DeckLine[]): ValidationIssue[] => {
    const entries: DeckEntry[] = lines.map((l) => ({ zone: l.zone, name: l.card.name, quantity: l.quantity, card: l.card }));
    return validateDeck({ format: input.format, entries, analysisDate: input.analysisDate }).issues.filter((i) => i.severity === 'ERROR');
  };

  /** Cost of the copies added beyond the baseline that are not already owned; null reason = fine. */
  const spend = (counts: Counts): { cents: number; violation: string | null } => {
    let cents = 0;
    for (const [name, q] of counts) {
      const added = q - (base.get(name) ?? 0);
      if (added <= 0) continue;
      const spare = Math.max(0, (owned[name] ?? 0) - (base.get(name) ?? 0));
      const bought = Math.max(0, added - spare);
      if (bought === 0) continue;
      if (cons.ownedOnly) return { cents, violation: `${name}: not owned` };
      const price = registry.get(name)?.priceCents ?? null;
      if (price === null) {
        if (ceiling !== null) return { cents, violation: `${name}: price unknown under a price ceiling` };
        continue;
      }
      cents += price * bought;
    }
    if (ceiling !== null && cents > ceiling) return { cents, violation: `spend ${cents} is over the ${ceiling} ceiling` };
    return { cents, violation: null };
  };

  const hardOk = (counts: Counts): { ok: boolean; cents: number } => {
    for (const n of protectedNames) if ((counts.get(n) ?? 0) < (base.get(n) ?? 0)) return { ok: false, cents: 0 };
    for (const n of excluded) if ((counts.get(n) ?? 0) > (base.get(n) ?? 0)) return { ok: false, cents: 0 };
    const s = spend(counts);
    if (s.violation) return { ok: false, cents: s.cents };
    if (issuesOf(linesOf(counts)).length > 0) return { ok: false, cents: s.cents };
    return { ok: true, cents: s.cents };
  };

  const swapsOf = (counts: Counts): Swap[] => {
    const cuts: string[] = [];
    const adds: string[] = [];
    const names = new Set([...counts.keys(), ...base.keys()]);
    for (const n of [...names].sort(byName)) {
      const d = (counts.get(n) ?? 0) - (base.get(n) ?? 0);
      for (let i = 0; i < -d; i++) cuts.push(n);
      for (let i = 0; i < d; i++) adds.push(n);
    }
    return adds.map((add, i) => ({ cut: cuts[i] ?? '', add, addPriceCents: registry.get(add)?.priceCents ?? null }));
  };

  const baselineIssues = issuesOf(linesOf(base));
  const baselineValid = baselineIssues.length === 0;
  if (!baselineValid) notes.push('The unchanged deck breaks a rule, so no swap that leaves it broken is returned.');

  const build = (counts: Counts, cents: number, baseObjs: ScoredBuild['objectives'] | null): ScoredBuild => {
    const { objectives } = scoreObjectives(linesOf(counts), cents, ctx);
    const vs = {} as Record<Objective, number>;
    for (const o of OBJECTIVES) vs[o] = Math.round((objectives[o].value - (baseObjs ? baseObjs[o].value : objectives[o].value)) * 1000) / 1000;
    return {
      key: keyOf(counts),
      swaps: swapsOf(counts),
      costCents: cents,
      objectives,
      composite: {
        value: composite(objectives, weights),
        label: 'HEURISTIC_SCORE',
        note: 'Weighted mean of the objective scores. A score for comparing builds, never a win rate.',
      },
      vsBaseline: vs,
    };
  };

  const baselineBuild = build(base, 0, null);
  const all = new Map<string, ScoredBuild>([[baseKey, baselineBuild]]);
  const levelOne: ScoredBuild[] = [];
  const stateCounts = new Map<string, Counts>([[baseKey, base]]);
  let rejected = 0;
  let scored = 0;
  let levels = 0;

  const roleCount = new Map<string, number>();
  const roles = (c: OptCard) => {
    let n = roleCount.get(c.name);
    if (n === undefined) {
      n = tagCard({ name: c.name, typeLine: c.typeLine, oracleText: c.oracleText, cmc: c.cmc }).roles.length;
      roleCount.set(c.name, n);
    }
    return n;
  };

  // Additions that can never be legal are dropped once, before any search.
  const adds = pool.filter((c) => !excluded.has(c.name));

  let beam: ScoredBuild[] = [baselineBuild];
  for (let level = 1; level <= maxSwaps; level++) {
    const pairs: { from: string; cut: string; add: string; rank: number }[] = [];
    for (const state of beam) {
      const counts = stateCounts.get(state.key)!;
      const cutNames = [...counts.entries()].filter(([n, q]) => q > 0 && !protectedNames.has(n)).map(([n]) => n).sort(byName);
      for (const cut of cutNames) {
        for (const add of adds) {
          if (add.name === cut) continue;
          pairs.push({ from: state.key, cut, add: add.name, rank: roles(add) - roles(registry.get(cut)!) });
        }
      }
    }
    pairs.sort((a, b) => b.rank - a.rank || byName(a.cut, b.cut) || byName(a.add, b.add) || byName(a.from, b.from));

    const next: ScoredBuild[] = [];
    let tried = 0;
    for (const p of pairs) {
      if (tried >= maxScored) break;
      const counts = new Map(stateCounts.get(p.from)!);
      counts.set(p.cut, (counts.get(p.cut) ?? 0) - 1);
      counts.set(p.add, (counts.get(p.add) ?? 0) + 1);
      const key = keyOf(counts);
      if (all.has(key)) continue;
      tried++;
      const check = hardOk(counts);
      if (!check.ok) { rejected++; all.set(key, null as unknown as ScoredBuild); continue; }
      const b = build(counts, check.cents, baselineBuild.objectives);
      scored++;
      all.set(key, b);
      stateCounts.set(key, counts);
      next.push(b);
      if (level === 1) levelOne.push(b);
    }
    if (next.length === 0) break;
    levels = level;
    next.sort((a, b) => b.composite.value - a.composite.value || byName(a.key, b.key));
    beam = next.slice(0, beamWidth);
  }

  const valid = [...all.values()].filter((b): b is ScoredBuild => b !== null);
  const baselineOk = baselineValid;
  const pickable = valid.filter((b) => b.key !== baseKey);
  const order = (a: ScoredBuild, b: ScoredBuild) => b.composite.value - a.composite.value || a.swaps.length - b.swaps.length || byName(a.key, b.key);
  const candidates = pickable.sort(order).slice(0, topN);

  const frontierPool = baselineOk ? valid : pickable;
  const frontier = frontierPool
    .filter((b) => !frontierPool.some((o) => o !== b && dominates(o.objectives, b.objectives)))
    .sort(order);

  const noPrice = (b: ScoredBuild) => composite(b.objectives, weights, ['price']);
  const baseNoPrice = noPrice(baselineBuild);
  const upgrades: UpgradeRanking[] = levelOne
    .map((b): UpgradeRanking => {
      const gain = Math.round((noPrice(b) - baseNoPrice) * 1000) / 1000;
      const swap = b.swaps[0]!;
      return { swap, gain, costCents: b.costCents, gainPerDollar: b.costCents > 0 ? Math.round((gain / (b.costCents / 100)) * 1000) / 1000 : null, free: b.costCents === 0 };
    })
    .filter((u) => u.gain > 0)
    .sort((a, b) =>
      Number(b.free) - Number(a.free) ||
      (a.free ? b.gain - a.gain : (b.gainPerDollar ?? 0) - (a.gainPerDollar ?? 0)) ||
      byName(a.swap.add, b.swap.add) || byName(a.swap.cut, b.swap.cut));

  const recommended = (baselineOk ? valid : pickable).slice().sort(order)[0] ?? baselineBuild;
  const spendNote = recommended.costCents > 0 && ceiling !== null && recommended.costCents < ceiling
    ? ` It spends ${recommended.costCents} of ${ceiling} cents; the rest is left unspent.` : '';
  const comparison = recommended.key === baseKey
    ? `No valid swap beats the unchanged deck on the weighted score, so the unchanged deck is recommended.`
    : `Against the unchanged deck the recommended build makes ${recommended.swaps.length} swap(s) and moves the weighted score from ${baselineBuild.composite.value} to ${recommended.composite.value} (a heuristic score, not a win rate).${spendNote}`;

  if (pool.some((c) => c.priceCents === null)) notes.push('Some pool cards have no known price; under a price ceiling they cannot be bought.');
  if (pool.some((c) => c.priceStatus === 'ESTIMATE')) notes.push('Prices marked ESTIMATE come from Scryfall and are not verified market prices.');

  return {
    format: input.format,
    baseline: { valid: baselineValid, issues: baselineIssues, build: baselineBuild },
    candidates,
    frontier,
    upgrades,
    recommended,
    comparison,
    weights,
    searched: { scored, rejected, levels },
    notes,
  };
}

/** Re-rank an existing result under different weights without searching again. */
export function reweigh(result: OptimizeResult, weights: Partial<Weights>): OptimizeResult {
  const w = normalizeWeights(weights);
  const re = (b: ScoredBuild): ScoredBuild => ({ ...b, composite: { ...b.composite, value: composite(b.objectives, w) } });
  const order = (a: ScoredBuild, b: ScoredBuild) => b.composite.value - a.composite.value || a.swaps.length - b.swaps.length || byName(a.key, b.key);
  const candidates = result.candidates.map(re).sort(order);
  const frontier = result.frontier.map(re).sort(order);
  const pool = [re(result.baseline.build), ...candidates];
  return { ...result, weights: w, candidates, frontier, recommended: pool.sort(order)[0]! };
}
