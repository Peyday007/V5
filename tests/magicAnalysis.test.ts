import { describe, expect, it } from 'vitest';
import {
  acceptProposals, analyzeDeck, choose, pAtLeastOne, pCastable, pJointAtLeast, pmf, simulate, tagCard, toNumber,
  DEFAULT_MULLIGAN, type AnalysisCard, type SimCard,
} from '../server/services/magic/analysis/index.ts';

describe('exact hypergeometric', () => {
  it('matches independently computed values for a 99-card library, 37 lands, 7 cards', () => {
    const r = pAtLeastOne(99, 37, 7);
    // 1 - C(62,7)/C(99,7), reduced, computed independently with Python fractions.
    expect(`${r.num}/${r.den}`).toBe('3055016/3159387');
    expect(toNumber(r)).toBeCloseTo(0.966964794119872, 12);
  });
  it('pmf sums to exactly one and the keepable band matches', () => {
    const d = pmf(99, 37, 7);
    const sum = d.reduce((a, r) => ({ num: a.num * r.den + r.num * a.den, den: a.den * r.den }), { num: 0n, den: 1n });
    expect(sum.num).toBe(sum.den);
    const keep = d.slice(2, 6).reduce((a, r) => ({ num: a.num * r.den + r.num * a.den, den: a.den * r.den }), { num: 0n, den: 1n });
    expect(toNumber({ num: keep.num, den: keep.den })).toBeCloseTo(0.8038033689679942, 12);
  });
  it('choose handles edges exactly', () => {
    expect(choose(5, 0)).toBe(1n);
    expect(choose(5, 6)).toBe(0n);
  });
});

describe('joint events never double count', () => {
  it('matches brute-force enumeration over a small overlapping library', () => {
    // 6 cards: A (ramp+draw), B (ramp), C (draw), three blanks. Draw 3; need >=1 ramp and >=1 draw.
    const library = [
      { categories: ['ramp', 'draw'], quantity: 1 },
      { categories: ['ramp'], quantity: 1 },
      { categories: ['draw'], quantity: 1 },
      { categories: [], quantity: 3 },
    ];
    const cards = [['ramp', 'draw'], ['ramp'], ['draw'], [], [], []];
    let good = 0;
    let total = 0;
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) {
      total++;
      const cats = [a, b, c].flatMap((i) => cards[i]!);
      if (cats.includes('ramp') && cats.includes('draw')) good++;
    }
    const r = pJointAtLeast(library, 3, { ramp: 1, draw: 1 });
    expect(Number(r.num) / Number(r.den)).toBeCloseTo(good / total, 12);
    // Adding the two marginals would overcount.
    const marginal = Number(pAtLeastOne(6, 2, 3).num) / Number(pAtLeastOne(6, 2, 3).den);
    expect(marginal + marginal).toBeGreaterThan(Number(r.num) / Number(r.den));
  });
});

describe('colored castability', () => {
  it('equals the plain hypergeometric for a single color requirement', () => {
    // Library 99: 20 Swamps, 17 other lands that make no B, 62 spells. {B} on turn 1 on the play: 7 cards, need 1 land & 1 B source.
    const lands = [{ quantity: 20, produces: ['B' as const] }, { quantity: 17, produces: ['G' as const] }];
    const r = pCastable('{B}', lands, 99, 1, true);
    expect(r.value).toBeCloseTo(toNumber(pAtLeastOne(99, 20, 7)), 12);
    expect(r.label).toBe('EXACT_PROBABILITY');
  });
  it('requires both colors and enough lands, and tapped lands do not count when untapped only', () => {
    const lands = [{ quantity: 6, produces: ['B' as const] }, { quantity: 6, produces: ['R' as const] }];
    const both = pCastable('{B}{R}', lands, 40, 3, true);
    const one = pCastable('{B}', lands, 40, 3, true);
    expect(both.value).toBeLessThan(one.value);
    const tapped = [{ quantity: 6, produces: ['B' as const], entersTapped: true }, { quantity: 6, produces: ['R' as const] }];
    expect(pCastable('{B}', tapped, 40, 3, true).value).toBeLessThan(one.value);
    expect(pCastable('{B}', tapped, 40, 3, true, false).value).toBeCloseTo(one.value, 12);
  });
});

describe('tags', () => {
  it('derives roles from rules and refuses unverified proposals', () => {
    const rock = { name: 'Sol Ring', typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.' };
    expect(tagCard(rock).roles).toContain('ramp');
    const { accepted, rejected } = acceptProposals(rock, ['ramp', 'drain']);
    expect(accepted).toEqual(['ramp']);
    expect(rejected).toEqual(['drain']);
  });
});

function deck(): AnalysisCard[] {
  const cards: AnalysisCard[] = [
    { name: 'Kardur', quantity: 1, zone: 'commander', typeLine: 'Legendary Creature', manaCost: '{2}{B}{R}', cmc: 4 },
    { name: 'Swamp', quantity: 18, zone: 'main', typeLine: 'Basic Land — Swamp' },
    { name: 'Mountain', quantity: 17, zone: 'main', typeLine: 'Basic Land — Mountain' },
    { name: 'Sol Ring', quantity: 1, zone: 'main', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, oracleText: '{T}: Add {C}{C}.' },
    { name: 'Fireball', quantity: 1, zone: 'main', typeLine: 'Sorcery', manaCost: '{X}{R}', cmc: 1, oracleText: 'Fireball deals X damage to any target.' },
    { name: 'Doom Blade', quantity: 1, zone: 'main', typeLine: 'Instant', manaCost: '{1}{B}', cmc: 2, oracleText: 'Destroy target nonblack creature.' },
    { name: 'Blasphemous Act', quantity: 1, zone: 'main', typeLine: 'Sorcery', manaCost: '{8}{R}', cmc: 9, oracleText: 'Blasphemous Act deals 13 damage to each creature.' },
    { name: 'Dragon', quantity: 1, zone: 'main', typeLine: 'Creature — Dragon', manaCost: '{4}{R}{R}', cmc: 6, oracleText: 'Flying, haste' },
  ];
  const used = cards.filter((c) => c.zone === 'main').reduce((s, c) => s + c.quantity, 0);
  cards.push({ name: 'Bear', quantity: 99 - used, zone: 'main', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2 });
  return cards;
}

describe('analyzeDeck', () => {
  it('keeps the command zone out of the library and labels every number', () => {
    const r = analyzeDeck({ format: 'COMMANDER', cards: deck(), opponents: 1 });
    expect(r.librarySize).toBe(99);
    expect(r.commanderZone).toEqual(['Kardur']);
    expect(r.openingHand.keepable.label).toBe('EXACT_PROBABILITY');
    for (const t of r.byTurn) expect(t.threeLandsAndRamp.label).toBe('EXACT_PROBABILITY');
    for (const s of Object.values(r.scores)) expect(s.label).toBe('HEURISTIC_SCORE');
    expect(r.commanderCastable.every((c) => c.probability.label === 'EXACT_PROBABILITY')).toBe(true);
    expect(r.counts['land']).toBe(35);
    expect(r.sources['B']).toBe(18);
    expect(r.scores.closing.note).toMatch(/1v1/);
  });
  it('reports single-card reliance', () => {
    const r = analyzeDeck({ format: 'COMMANDER', cards: deck() });
    expect(r.singleCardReliance.map((s) => s.role)).toContain('ramp');
  });
});

describe('seeded Monte Carlo', () => {
  const lib: SimCard[] = [
    ...Array.from({ length: 37 }, () => ({ name: 'L', isLand: true })),
    ...Array.from({ length: 10 }, () => ({ name: 'R', isLand: false, isRamp: true })),
    ...Array.from({ length: 52 }, () => ({ name: 'S', isLand: false })),
  ];
  const opts = { runs: 2000, seed: 7, turns: 4, onThePlay: true, mulligan: DEFAULT_MULLIGAN };
  it('reproduces identical output for the same seed and differs for another', () => {
    const a = simulate(lib, opts);
    const b = simulate(lib, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(simulate(lib, { ...opts, seed: 8 }))).not.toBe(JSON.stringify(a));
  });
  it('states runs, policy, draw rules and intervals, and is close to the exact value', () => {
    const r = simulate(lib, { ...opts, mulligan: { minLands: 0, maxLands: 7, floor: 7 } });
    expect(r.runs).toBe(2000);
    expect(r.drawRules).toMatch(/play/);
    const exact = toNumber(pAtLeastOne(99, 10, 7)); // ramp by turn 1 on the play, no mulligans
    const est = r.rampByTurn[0]!.estimate;
    expect(est.label).toBe('MODEL_ESTIMATE');
    expect(est.low).toBeLessThanOrEqual(exact);
    expect(est.high).toBeGreaterThanOrEqual(exact);
  });
});
