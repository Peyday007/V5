import { describe, expect, it } from 'vitest';
import { parseDecklistText, parseDecklistCsv, looksLikeCsv } from '../server/decks/parse.ts';
import { resolveDeck } from '../server/games/mtg/resolve.ts';
import { validateCommander } from '../server/games/mtg/validate.ts';
import { fakeForge, fixtureCatalog, fixtureText } from './helpers.ts';

const noFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

describe('decklist parsing', () => {
  it('reads quantities, set/number, sections and the commander marker', () => {
    const p = parseDecklistText('Commander\n1 Caesar, Legion\'s Emperor (PIP) 1\n\nDeck\n4x Plains\n1 Sol Ring (PIP) 234\nSB: 1 Lightning Bolt\n1 Fire // Ice *CMDR*');
    const byName = Object.fromEntries(p.lines.map((l) => [l.name, l]));
    expect(byName["Caesar, Legion's Emperor"]).toMatchObject({ quantity: 1, section: 'commander', set: 'PIP', number: '1' });
    expect(byName.Plains).toMatchObject({ quantity: 4, section: 'main' });
    expect(byName['Lightning Bolt']!.section).toBe('sideboard');
    expect(byName['Fire // Ice']!.section).toBe('commander');
  });

  it('reads a CSV export with a header row', () => {
    const csv = 'Quantity,Name,Edition,Collector Number\n1,Sol Ring,PIP,234\n10,Plains,PIP,317\n';
    expect(looksLikeCsv(csv, 'deck.csv')).toBe(true);
    const p = parseDecklistCsv(csv);
    expect(p.lines.map((l) => [l.quantity, l.name])).toEqual([[1, 'Sol Ring'], [10, 'Plains']]);
  });
});

describe('Hail, Caesar fixture', () => {
  it('imports with Caesar as commander, Mr. House in the 99, and quantities preserved', async () => {
    const { catalog } = fixtureCatalog();
    const deck = await resolveDeck(catalog, parseDecklistText(fixtureText('hail-caesar')), {}, { checkPrintings: false });
    const cmd = deck.lines.filter((l) => l.section === 'commander');
    expect(cmd.map((l) => l.card?.name)).toEqual(["Caesar, Legion's Emperor"]);
    expect(deck.commanderSource).toBe('stated');
    const house = deck.lines.find((l) => l.card?.name === 'Mr. House, President and CEO');
    expect(house?.section).toBe('main');
    const qty = (n: string) => deck.lines.filter((l) => l.card?.name === n).reduce((a, l) => a + l.quantity, 0);
    expect([qty('Plains'), qty('Swamp'), qty('Mountain')]).toEqual([5, 4, 5]);
    expect(deck.lines.reduce((n, l) => n + l.quantity, 0)).toBe(100);

    const report = await validateCommander(deck, { catalog, forge: fakeForge(), fetchImpl: noFetch });
    expect(report.issues.filter((i) => i.blocking)).toEqual([]);
    expect(report.counts.total).toBe(100);
    expect(report.playable).toBe(true);
  });
});

describe('the four kinds of problem stay separate', () => {
  const list = [
    'Commander', "1 Caesar, Legion's Emperor",
    'Deck', '1 Lightnig Bolt', '1 Wear', '1 Black Lotus', '1 Counterspell', '2 Sol Ring', '1 Costume Shop',
  ].join('\n');

  it('names each kind with its own message and correction', async () => {
    const { catalog } = fixtureCatalog();
    const deck = await resolveDeck(catalog, parseDecklistText(list), {}, { checkPrintings: false });
    const report = await validateCommander(deck, { catalog, forge: fakeForge(['Costume Shop']), fetchImpl: noFetch });
    const by = (code: string) => report.issues.find((i) => i.code === code);

    // recognition: a typo with a suggestion, and an ambiguous half-name
    expect(by('unrecognized-name')).toMatchObject({ kind: 'recognition', blocking: true });
    expect(by('unrecognized-name')!.correction).toMatch(/Lightning Bolt/);
    expect(by('ambiguous-name')).toMatchObject({ kind: 'recognition' });
    expect(by('ambiguous-name')!.correction).toMatch(/Wear \/\/ Tear/);

    // format / deckbuilding
    expect(by('banned')).toMatchObject({ kind: 'format', cards: ['Black Lotus'] });
    expect(by('color-identity')).toMatchObject({ kind: 'format', cards: ['Counterspell'] });
    expect(by('singleton')).toMatchObject({ kind: 'format', cards: ['Sol Ring'] });
    expect(by('deck-size')).toMatchObject({ kind: 'format' });

    // a legal card this Forge build cannot play
    const unsupported = by('unsupported-card');
    expect(unsupported).toMatchObject({ kind: 'engine-support', cards: ['Costume Shop'], blocking: true });
    expect(unsupported!.message).toMatch(/stays in your deck/);

    // nothing was silently replaced or dropped
    expect(deck.lines.map((l) => l.typedName)).toEqual(["Caesar, Legion's Emperor", 'Lightnig Bolt', 'Wear', 'Black Lotus', 'Counterspell', 'Sol Ring', 'Costume Shop']);
    expect(deck.lines.find((l) => l.typedName === 'Lightnig Bolt')!.card).toBeNull();
    expect(report.playable).toBe(false);
    expect(new Set(report.issues.map((i) => i.message)).size).toBe(report.issues.length);
  });

  it('never guesses a commander that was not stated', async () => {
    const { catalog } = fixtureCatalog();
    const deck = await resolveDeck(catalog, parseDecklistText("1 Caesar, Legion's Emperor\n1 Mr. House, President and CEO\n1 Sol Ring"), {}, { checkPrintings: false });
    expect(deck.commanderIds).toEqual([]);
    expect(deck.commanderSource).toBe('none');
    expect(deck.commanderCandidates.map((c) => c.name).sort()).toEqual(["Caesar, Legion's Emperor", 'Mr. House, President and CEO']);
  });
});
