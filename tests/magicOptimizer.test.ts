import { describe, expect, it } from 'vitest';
import { optimizeDeck, reweigh, dominates, type DeckLine, type OptCard, type OptimizeInput } from '../server/services/magic/optimizer/index.ts';

const legal = { standard: 'legal', commander: 'legal' };
const card = (name: string, extra: Partial<OptCard> = {}): OptCard => ({
  oracleId: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  typeLine: 'Creature — Goblin',
  oracleText: '',
  manaCost: '{1}{R}',
  cmc: 2,
  colorIdentity: ['R'],
  legalities: legal,
  priceCents: 0,
  priceStatus: 'CONFIRMED',
  ...extra,
});

const mountain = card('Mountain', { typeLine: 'Basic Land — Mountain', manaCost: '', cmc: 0, producedMana: ['R'], priceCents: 0 });
const filler = ['Filler A', 'Filler B', 'Filler C', 'Filler D', 'Filler E', 'Filler F', 'Filler G', 'Filler H', 'Filler I'].map((n) => card(n));

const deck: DeckLine[] = [
  { zone: 'main', quantity: 24, card: mountain },
  ...filler.map((c): DeckLine => ({ zone: 'main', quantity: 4, card: c })),
];

const pool: OptCard[] = [
  card('Ramp Rock', { typeLine: 'Artifact', oracleText: '{T}: Add {R}.', manaCost: '{2}', cmc: 2, priceCents: 150, priceStatus: 'ESTIMATE' }),
  card('Divination', { typeLine: 'Sorcery', oracleText: 'Draw two cards.', manaCost: '{2}{U}', cmc: 3, colorIdentity: ['U'], priceCents: 999 }),
  card('Zap', { typeLine: 'Instant', oracleText: 'Destroy target creature.', manaCost: '{1}{R}', cmc: 2, priceCents: 500 }),
  card('Drain Bolt', { typeLine: 'Sorcery', oracleText: 'Each opponent loses 3 life.', manaCost: '{2}{R}', cmc: 3, priceCents: 1001 }),
  card('Banned Wonder', { typeLine: 'Sorcery', oracleText: 'Draw three cards.', legalities: { standard: 'banned' }, priceCents: 0 }),
  card('Mystery Card', { typeLine: 'Artifact', oracleText: 'Add {R}.', priceCents: null, priceStatus: null }),
];

const base = (extra: Partial<OptimizeInput> = {}): OptimizeInput => ({
  format: 'STANDARD', deck, pool, analysisDate: '2026-11-01', maxSwaps: 3, beamWidth: 3, ...extra,
});

describe('optimizer', () => {
  it('returns the same output for the same input', () => {
    const a = optimizeDeck(base({ constraints: { priceCeilingCents: 2000 } }));
    const b = optimizeDeck(base({ constraints: { priceCeilingCents: 2000 } }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never returns a build that breaks a hard constraint', () => {
    const r = optimizeDeck(base({
      constraints: { protectedNames: ['Filler A'], excludedNames: ['Zap'], priceCeilingCents: 1000 },
    }));
    expect(r.baseline.valid).toBe(true);
    for (const b of [...r.candidates, ...r.frontier, r.recommended]) {
      expect(b.costCents).toBeLessThanOrEqual(1000);
      for (const s of b.swaps) {
        expect(s.cut).not.toBe('Filler A');
        expect(s.add).not.toBe('Zap');
        expect(s.add).not.toBe('Banned Wonder');
        expect(s.add).not.toBe('Mystery Card'); // unknown price cannot be bought under a ceiling
        expect(s.add).not.toBe('Drain Bolt'); // 10.01 is over a 10.00 ceiling
      }
    }
    expect(r.searched.rejected).toBeGreaterThan(0);
  });

  it('applies the 9.99 / 10.00 / 10.01 boundary exactly', () => {
    const only = (name: string, ceiling: number) =>
      optimizeDeck(base({ pool: pool.filter((c) => c.name === name), maxSwaps: 1, constraints: { priceCeilingCents: ceiling } }));
    expect(only('Divination', 999).searched.scored).toBeGreaterThan(0); // 9.99 at 9.99
    expect(only('Divination', 998).searched.scored).toBe(0);
    expect(only('Drain Bolt', 1000).searched.scored).toBe(0); // 10.01 refused at 10.00
    expect(only('Drain Bolt', 1001).searched.scored).toBeGreaterThan(0);
  });

  it('respects collection limits', () => {
    const r = optimizeDeck(base({ constraints: { ownedOnly: true, owned: { Zap: 1 } } }));
    for (const b of r.candidates) {
      for (const s of b.swaps) expect(['Zap']).toContain(s.add);
      expect(b.swaps.length).toBeLessThanOrEqual(1);
    }
  });

  it('states the comparison to the unchanged baseline', () => {
    const r = optimizeDeck(base({ constraints: { priceCeilingCents: 5000 } }));
    expect(r.comparison).toMatch(/unchanged deck/);
    expect(r.recommended.composite.label).toBe('HEURISTIC_SCORE');
    for (const b of r.candidates) {
      expect(Object.keys(b.vsBaseline).length).toBe(8);
      expect(b.objectives.consistency.components.length).toBeGreaterThan(0);
    }
  });

  it('keeps only non-dominated builds on the frontier', () => {
    const r = optimizeDeck(base({ constraints: { priceCeilingCents: 5000 } }));
    expect(r.frontier.length).toBeGreaterThan(0);
    for (const a of r.frontier) for (const b of r.frontier) {
      if (a !== b) expect(dominates(a.objectives, b.objectives)).toBe(false);
    }
  });

  it('ranks upgrades by gain per dollar and does not force spending', () => {
    const r = optimizeDeck(base({ constraints: { priceCeilingCents: 5000 } }));
    const paid = r.upgrades.filter((u) => !u.free);
    for (let i = 1; i < paid.length; i++) expect(paid[i - 1]!.gainPerDollar!).toBeGreaterThanOrEqual(paid[i]!.gainPerDollar!);
    const useless = optimizeDeck(base({ pool: [card('Another Filler', { priceCents: 400 })], constraints: { priceCeilingCents: 5000 } }));
    expect(useless.recommended.costCents).toBeLessThanOrEqual(400);
    expect(useless.recommended.swaps.length === 0 || useless.recommended.composite.value >= useless.baseline.build.composite.value).toBe(true);
  });

  it('can be re-ranked under different weights without searching again', () => {
    const r = optimizeDeck(base({ constraints: { priceCeilingCents: 5000 } }));
    const cheap = reweigh(r, { price: 100 });
    expect(cheap.weights.price).toBe(100);
    expect(cheap.recommended.costCents).toBeLessThanOrEqual(r.recommended.costCents);
  });

  it('reports a rule-breaking baseline rather than pretending', () => {
    const short = optimizeDeck(base({ deck: deck.slice(0, 3) }));
    expect(short.baseline.valid).toBe(false);
    expect(short.baseline.issues.length).toBeGreaterThan(0);
    for (const b of short.candidates) expect(b.swaps.length).toBeGreaterThan(0);
  });
});
