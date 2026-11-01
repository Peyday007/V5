import { describe, expect, it } from 'vitest';
import {
  alternativesFor, buildDeck, chooseAlternative, detectConflicts, parseIdea, planDesign, refineIntent,
} from '../server/services/magic/design/index.ts';
import type { OptCard } from '../server/services/magic/optimizer/types.ts';

const IDEA = 'extremely defensive Commander deck, lots of ways to stop threats, lifegain, but able to finish games quickly';

const legal = { commander: 'legal', standard: 'legal' };
const card = (name: string, text: string, extra: Partial<OptCard> = {}): OptCard => ({
  oracleId: `o-${name}`, name, typeLine: 'Sorcery', oracleText: text, manaCost: '{1}{W}', cmc: 2,
  colorIdentity: ['W'], legalities: legal, priceCents: 25, priceStatus: 'ESTIMATE', ...extra,
});
const pool: OptCard[] = [
  card('Saint Commander', 'Whenever you gain life, each opponent loses 1 life.', {
    typeLine: 'Legendary Creature — Cleric', manaCost: '{2}{W}', cmc: 3, priceCents: 100,
  }),
  card('Plains', '', { typeLine: 'Basic Land — Plains', manaCost: '', cmc: 0, producedMana: ['W'], priceCents: 0 }),
  card('Sunlit Haven', '{T}: Add {W}.', { typeLine: 'Land', manaCost: '', cmc: 0, producedMana: ['W'] }),
  ...Array.from({ length: 14 }, (_, i) => card(`Ramp Rock ${i}`, '{T}: Add {W}.', { typeLine: 'Artifact', cmc: 2 })),
  ...Array.from({ length: 12 }, (_, i) => card(`Insight ${i}`, 'Draw two cards.')),
  ...Array.from({ length: 16 }, (_, i) => card(`Smite ${i}`, 'Destroy target creature.')),
  ...Array.from({ length: 5 }, (_, i) => card(`Wrath ${i}`, 'Destroy all creatures.', { cmc: 4 })),
  ...Array.from({ length: 12 }, (_, i) => card(`Healing Light ${i}`, 'You gain 4 life.')),
  ...Array.from({ length: 8 }, (_, i) => card(`Siphon ${i}`, 'Each opponent loses 3 life.')),
  ...Array.from({ length: 8 }, (_, i) => card(`Aegis ${i}`, 'Target creature gains hexproof until end of turn.')),
  ...Array.from({ length: 14 }, (_, i) => card(`Angel ${i}`, 'Flying', { typeLine: 'Creature — Angel', cmc: 4 })),
  ...Array.from({ length: 12 }, (_, i) => card(`Soldier ${i}`, '', { typeLine: 'Creature — Soldier', cmc: 2 })),
  card('Outside Identity', 'Draw a card.', { colorIdentity: ['R'], manaCost: '{R}' }),
  card('Banned Card', 'Draw three cards.', { legalities: { commander: 'banned' } }),
];

describe('strategy architect', () => {
  it('names the conflict in defensive + lifegain + fast win and offers 2-3 alternatives', () => {
    const plan = planDesign(parseIdea(IDEA));
    expect(plan.state).toBe('NEEDS_DECISION');
    expect(plan.conflicts.map((c) => c.id)).toContain('DEFENSIVE_VS_FAST_CLOSE');
    expect(plan.conflicts[0]!.name).toMatch(/defensive/i);
    expect(plan.conflicts[0]!.cost.length).toBeGreaterThan(40);
    expect(plan.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(plan.alternatives.length).toBeLessThanOrEqual(3);
    for (const a of plan.alternatives) expect(a.tradeoffs.length).toBeGreaterThan(0);
  });

  it('structures the idea into the requested fields', () => {
    const i = parseIdea(IDEA);
    expect(i.format).toBe('COMMANDER');
    expect(i.defensive).toBe(true);
    expect(i.speed).toBe('fast');
    expect(i.secondaryPreferences).toEqual(expect.arrayContaining(['lifegain', 'removal']));
    expect(i.archetypes).toContain('defensive');
    expect(i.opponents).toBe(3);
    expect(i.assumptions.length).toBeGreaterThan(0);
  });

  it('asks at most one question', () => {
    const i = parseIdea(IDEA + ', high curve with big spells');
    const plan = planDesign(i);
    expect(plan.conflicts.length).toBeGreaterThanOrEqual(2);
    expect(plan.question).not.toBeNull();
    expect(plan.question!.options.length).toBeGreaterThanOrEqual(2);
    expect(planDesign(parseIdea('a budget go-wide token deck under $50')).question).toBeNull();
  });

  it('proceeds on provisional assumptions when nothing conflicts', () => {
    const plan = planDesign(parseIdea('a go-wide tokens deck'));
    expect(plan.state).toBe('COHERENT');
    expect(plan.assumptions.join(' ')).toMatch(/assuming Commander/);
  });

  it('detects defensive with no closing path and high curve with no early mana', () => {
    expect(detectConflicts(parseIdea('defensive control commander deck')).map((c) => c.id)).toContain('DEFENSIVE_NO_CLOSER');
    expect(detectConflicts(parseIdea('commander deck with a high curve and big spells')).map((c) => c.id)).toContain('HIGH_CURVE_NO_EARLY_MANA');
  });

  it('refines iteratively and resolves a conflict by choosing an alternative', () => {
    const i1 = parseIdea(IDEA);
    const alt = alternativesFor(detectConflicts(i1)[0]!)[0]!;
    const i2 = chooseAlternative(i1, alt.id);
    expect(i2.revision).toBe(2);
    expect(planDesign(i2).state).toBe('COHERENT');
    const i3 = refineIntent(i2, 'under $100 and no Smite 3');
    expect(i3.revision).toBe(3);
    expect(i3.budgetCents).toBe(10000);
    expect(i3.hardConstraints).toContainEqual({ kind: 'exclude', name: 'Smite 3' });
    expect(i3.history.length).toBe(3);
    expect(() => chooseAlternative(i1, 'nonsense')).toThrow();
  });
});

describe('deck builder', () => {
  it('refuses to build while a conflict is unresolved', () => {
    const r = buildDeck(parseIdea(IDEA), { pool, analysisDate: '2026-11-01' });
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/not coherent/);
    expect(r.cards).toEqual([]);
  });

  it('builds a Commander deck of exactly 100 within identity and singleton, every card with a role', () => {
    const i1 = parseIdea(IDEA);
    const i2 = chooseAlternative(i1, 'fortress-drain');
    const r = buildDeck(i2, { pool, analysisDate: '2026-11-01' });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.commander?.name).toBe('Saint Commander');
    const total = r.cards.reduce((s, c) => s + c.quantity, 0);
    expect(total).toBe(100);
    expect(r.validation!.counts.total).toBe(100);
    for (const c of r.cards) {
      expect(c.role).toBeTruthy();
      expect(c.why.length).toBeGreaterThan(0);
      if (!/Basic/.test(c.card.typeLine)) expect(c.quantity).toBe(1);
      expect(['Outside Identity', 'Banned Card']).not.toContain(c.card.name);
    }
    expect(r.cards.some((c) => c.role === 'lifegain')).toBe(true);
    expect(r.cards.some((c) => c.role === 'drain')).toBe(true);
  });

  it('is deterministic', () => {
    const i = chooseAlternative(parseIdea(IDEA), 'fortress-drain');
    const a = buildDeck(i, { pool, analysisDate: '2026-11-01' });
    const b = buildDeck(i, { pool: [...pool].reverse(), analysisDate: '2026-11-01' });
    expect(JSON.stringify(a.cards.map((c) => [c.card.name, c.quantity, c.role]))).toBe(JSON.stringify(b.cards.map((c) => [c.card.name, c.quantity, c.role])));
  });

  it('respects a budget and excluded cards', () => {
    const i = refineIntent(chooseAlternative(parseIdea(IDEA), 'fortress-drain'), 'no Smite 0 under $60');
    const r = buildDeck(i, { pool, analysisDate: '2026-11-01' });
    expect(r.cards.some((c) => c.card.name === 'Smite 0')).toBe(false);
    const spend = r.cards.filter((c) => !/Basic/.test(c.card.typeLine)).reduce((s, c) => s + (c.card.priceCents ?? 0) * c.quantity, 0);
    expect(spend).toBeLessThanOrEqual(6000 + 100); // the commander is chosen, not budgeted
  });

  it('builds a legal Standard main deck with four-of copies', () => {
    const i = parseIdea('standard aggro deck with removal');
    expect(i.format).toBe('STANDARD');
    const r = buildDeck(i, { pool, analysisDate: '2026-11-01' });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.cards.reduce((s, c) => s + c.quantity, 0)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...r.cards.map((c) => c.quantity))).toBeLessThanOrEqual(24);
  });
});
