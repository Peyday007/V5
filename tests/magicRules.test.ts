import { describe, expect, it } from 'vitest';
import { validateDeck, validateWithCommanders, type DeckEntry, type RuleCard } from '../server/services/magic/rules/index.ts';
import type { MagicColor } from '../server/domain/magicTypes.ts';

const legal = { commander: 'legal', standard: 'legal' };
function card(name: string, over: Partial<RuleCard> = {}): RuleCard {
  return { oracleId: `o-${name}`, name, typeLine: 'Artifact', colorIdentity: [], legalities: legal, ...over };
}
const kardur = card('Kardur, Doomscourge', { typeLine: 'Legendary Creature — Demon Berserker', colorIdentity: ['B', 'R'] });
const forest = card('Forest', { typeLine: 'Basic Land — Forest', colorIdentity: ['G'] });
const swamp = card('Swamp', { typeLine: 'Basic Land — Swamp', colorIdentity: ['B'] });
const e = (c: RuleCard, zone: DeckEntry['zone'], quantity = 1): DeckEntry => ({ zone, name: c.name, quantity, card: c });

function commanderDeck(commander: RuleCard, extra: DeckEntry[] = [], fillerCount = 99 - extra.length): DeckEntry[] {
  const filler = Array.from({ length: fillerCount }, (_, i) => e(card(`Rock ${i}`), 'main'));
  return [e(commander, 'commander'), ...filler, ...extra];
}
const base = { analysisDate: '2026-11-01' };
const codes = (r: ReturnType<typeof validateDeck>) => r.issues.map((i) => i.code);

describe('Commander', () => {
  it('accepts exactly 100 including the commander', () => {
    const r = validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur) });
    expect(r.ok).toBe(true);
    expect(r.counts.commander + r.counts.main).toBe(100);
    expect(r.colorIdentity).toEqual(['B', 'R']);
  });
  it('reports 99 and 101', () => {
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [], 98) }))).toContain('DECK_SIZE');
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [], 100) }))).toContain('DECK_SIZE');
  });
  it('reports an off-identity card, including a basic land', () => {
    const r = validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(forest, 'main')]) });
    expect(codes(r)).toContain('COLOR_IDENTITY');
  });
  it('allows many basics of identity and reports a duplicate nonbasic', () => {
    const ok = validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(swamp, 'main', 30)], 69) });
    expect(ok.ok).toBe(true);
    const dup = validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(card('Sol Ring'), 'main', 2)], 97) });
    expect(codes(dup)).toContain('SINGLETON');
  });
  it('allows any-number cards by the rules table and by printed text', () => {
    const rats = card('Relentless Rats', { typeLine: 'Creature — Rat', oracleText: 'Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats. A deck can have any number of cards named Relentless Rats.' });
    expect(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(rats, 'main', 20)], 79) }).ok).toBe(true);
    const bareRats = card('Persistent Petitioners', { typeLine: 'Creature — Human Advisor' });
    expect(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(bareRats, 'main', 5)], 94) }).ok).toBe(true);
    const dwarves = card('Seven Dwarves', { typeLine: 'Creature — Dwarf' });
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(dwarves, 'main', 8)], 91) }))).toContain('SINGLETON');
  });
  it('uses catalog legality for bans and flags unknown cards', () => {
    const banned = card('Banned Thing', { legalities: { commander: 'banned' } });
    const r = validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur, [e(banned, 'main')]) });
    expect(codes(r)).toContain('BANNED');
    const unknown = commanderDeck(kardur, [{ zone: 'main', name: 'Nope', quantity: 1, card: null }]);
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: unknown }))).toContain('UNKNOWN_CARD');
  });
  it('checks partner pairs', () => {
    const p1 = card('Partner A', { typeLine: 'Legendary Creature — Human', keywords: ['Partner'], oracleText: 'Partner', colorIdentity: ['R'] });
    const p2 = card('Partner B', { typeLine: 'Legendary Creature — Human', keywords: ['Partner'], oracleText: 'Partner', colorIdentity: ['G'] });
    const entries = (a: RuleCard, b: RuleCard) => [e(a, 'commander'), e(b, 'commander'), ...Array.from({ length: 98 }, (_, i) => e(card(`R${i}`), 'main'))];
    const ok = validateDeck({ ...base, format: 'COMMANDER', entries: entries(p1, p2) });
    expect(ok.ok).toBe(true);
    expect(ok.colorIdentity).toEqual(['R', 'G']);
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: entries(p1, kardur) }))).toContain('INVALID_PAIR');
    const w1 = card('Pir', { typeLine: 'Legendary Creature — Human', oracleText: 'Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library.)' });
    const w2 = card('Toothy, Imaginary Friend', { typeLine: 'Legendary Creature — Illusion', oracleText: 'Partner with Pir, Imaginary Friend\nWhenever you draw a card' });
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: entries(w1, w2) }))).toContain('INVALID_PAIR'); // names don't match each other here
    const bg = card('Acolyte', { typeLine: 'Legendary Enchantment — Background' });
    const choose = card('Chooser', { typeLine: 'Legendary Creature — Human', oracleText: 'Choose a Background' });
    expect(validateDeck({ ...base, format: 'COMMANDER', entries: entries(choose, bg) }).ok).toBe(true);
  });
  it('revalidating with a different commander changes the result', () => {
    const entries = commanderDeck(kardur, [e(swamp, 'main', 10)], 89);
    const input = { ...base, format: 'COMMANDER' as const, entries };
    expect(validateDeck(input).ok).toBe(true);
    const green = card('Greenie', { typeLine: 'Legendary Creature — Elf', colorIdentity: ['G'] });
    const swapped = validateWithCommanders(input, [e(green, 'commander')]);
    expect(swapped.ok).toBe(false);
    expect(codes(swapped)).toContain('COLOR_IDENTITY');
  });
  it('rejects a non-creature commander and a missing one', () => {
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(card('Sol Ring')) }))).toContain('NOT_A_COMMANDER');
    expect(codes(validateDeck({ ...base, format: 'COMMANDER', entries: commanderDeck(kardur).slice(1) }))).toContain('NO_COMMANDER');
  });
});

describe('Standard', () => {
  const std = (n: number, side = 0, extra: DeckEntry[] = []): DeckEntry[] => [
    ...Array.from({ length: n }, (_, i) => e(card(`S${i}`), 'main')),
    ...Array.from({ length: side }, (_, i) => e(card(`Side${i}`), 'sideboard')),
    ...extra,
  ];
  it('accepts 60 with a 15 sideboard', () => {
    expect(validateDeck({ ...base, format: 'STANDARD', entries: std(60, 15) }).ok).toBe(true);
  });
  it('reports under 60, sideboard 16, over 4 copies across zones, illegal cards', () => {
    expect(codes(validateDeck({ ...base, format: 'STANDARD', entries: std(59) }))).toContain('DECK_SIZE');
    expect(codes(validateDeck({ ...base, format: 'STANDARD', entries: std(60, 16) }))).toContain('SIDEBOARD_SIZE');
    const bolt = card('Bolt');
    const five = validateDeck({ ...base, format: 'STANDARD', entries: std(56, 0, [e(bolt, 'main', 3), e(bolt, 'sideboard', 2)]) });
    expect(codes(five)).toContain('COPY_LIMIT');
    const rotated = card('Old Card', { legalities: { standard: 'not_legal' } });
    expect(codes(validateDeck({ ...base, format: 'STANDARD', entries: std(59, 0, [e(rotated, 'main')]) }))).toContain('NOT_LEGAL');
  });
  it('allows basics in any number and warns when the legality snapshot is not the analysis date', () => {
    const r = validateDeck({ ...base, format: 'STANDARD', legalitySnapshotAt: '2026-09-01T00:00:00Z', entries: std(36, 0, [e(swamp, 'main', 24)]) });
    expect(r.ok).toBe(true);
    expect(codes(r)).toContain('LEGALITY_SNAPSHOT');
  });
});
