import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { MAGIC_TABLES } from '../server/domain/magicTypes.ts';
import { loadMagicFixtures, printingIdFor } from './helpers/magicFixtures.ts';
import { recordPriceSnapshot, latestPrice, lockPriceSnapshot, PriceRefused } from '../server/repos/magicPrices.ts';
import { createDeck, appendVersion, getDeck, getVersion, setCollectionQuantity, listCollection, saveDesignIntent, getDesignIntent, saveAnalysis, listAnalyses } from '../server/repos/magicDecks.ts';
import { appendLedger, appendObservation, appendPurchase, ensureLeague, ensurePlayer, getGame, listLedger, listPurchases, recordGame, appendLeagueDeck } from '../server/repos/magicLeague.ts';

let owner = '';
let other = '';
const mk = async (name: string) =>
  (await createUser({ email: `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`, displayName: name, password: 'a-long-enough-password' })).id;

beforeEach(async () => {
  await freshProject();
  owner = await mk('owner');
  other = await mk('other');
  await loadMagicFixtures();
});

describe('magic repositories', () => {
  it('every table exists on the active backend', async () => {
    for (const table of MAGIC_TABLES) await getDb().get(`SELECT 1 FROM ${table} LIMIT 1`);
  });

  it('round-trips decks, versions, collection, intents, analyses, prices, league, games and observations', async () => {
    const deck = await createDeck({ ownerUserId: owner, name: 'Test', format: 'COMMANDER' });
    const v = await appendVersion(owner, deck.id, { cards: [{ zone: 'commander', cardName: 'Kardur, Doomscourge', quantity: 1 }, { zone: 'main', cardName: 'Sol Ring', quantity: 1 }], reason: 'first' });
    expect(v?.versionNumber).toBe(1);
    expect((await getDeck(owner, deck.id))?.currentVersionId).toBe(v?.id);

    await setCollectionQuantity(owner, { cardName: 'Sol Ring', status: 'OWNED', quantity: 1 });
    await setCollectionQuantity(owner, { cardName: 'Sol Ring', status: 'PROXY', quantity: 2 });
    expect((await listCollection(owner)).map((c) => `${c.status}:${c.quantity}`).sort()).toEqual(['OWNED:1', 'PROXY:2']);

    const intent = await saveDesignIntent(owner, { rawText: 'defensive', structured: { format: 'COMMANDER' }, state: 'DRAFT' });
    expect((await getDesignIntent(owner, intent.id))?.raw_text).toBe('defensive');
    await saveAnalysis(owner, { deckId: deck.id, versionId: v!.id, kind: 'ANALYZE', seed: '7', result: { ok: true } });
    expect(await listAnalyses(owner, deck.id)).toHaveLength(1);

    const printing = printingIdFor('fx-sol-ring', 'c21', '263');
    const snap = await recordPriceSnapshot({ ownerUserId: owner, printingId: printing, priceCents: 999, status: 'CONFIRMED', source: 'local shop', observedOn: '2026-11-01' });
    expect(await lockPriceSnapshot(owner, snap.id)).toBe(true);
    expect((await latestPrice(printing, owner))?.priceCents).toBe(999);

    const league = await ensureLeague(owner, { seedKey: 'test', name: 'L' });
    const a = (await ensurePlayer(owner, league.id, { seedKey: 'a', ordinal: 0, label: 'A', isOwner: true }))!;
    const b = (await ensurePlayer(owner, league.id, { seedKey: 'b', ordinal: 1, label: 'B' }))!;
    await appendLeagueDeck(owner, a.id, { cardListStatus: 'VERIFIED', isBaseline: true });
    const ledger = await appendLedger(owner, league.id, { weekStart: '2026-11-02', allowanceCents: 1000, option: 'SINGLES', valueCents: 999, priceStatus: 'CONFIRMED' });
    await appendPurchase(owner, league.id, { ledgerId: ledger!.id, kind: 'SINGLE', description: 'Sol Ring', costCents: 999, priceStatus: 'CONFIRMED', purchasedOn: '2026-11-02' });
    expect(await listLedger(owner, league.id)).toHaveLength(1);
    expect(await listPurchases(owner, league.id)).toHaveLength(1);
    const game = await recordGame(owner, league.id, {
      playedOn: '2026-11-03',
      participants: [{ playerId: a.id, seat: 1 }, { playerId: b.id, seat: 2 }],
      eliminations: [{ eliminatedPlayerId: b.id, orderIndex: 1, creditedPlayerId: a.id, points: 1, attribution: 'OWN_SOURCE' }],
    });
    expect((await getGame(owner, game!.id))?.eliminations).toHaveLength(1);
    const obs = await appendObservation(owner, league.id, { playerId: b.id, kind: 'NOTE', label: 'OBSERVED', detail: { text: 'hi' }, observedOn: '2026-11-03' });
    expect(obs?.label).toBe('OBSERVED');
  });

  it('a foreign owner reads and writes nothing, indistinguishably from absent', async () => {
    const deck = await createDeck({ ownerUserId: owner, name: 'Mine', format: 'STANDARD' });
    const v = await appendVersion(owner, deck.id, { cards: [{ zone: 'main', cardName: 'Forest', quantity: 4 }] });
    const league = await ensureLeague(owner, { seedKey: 'mine', name: 'Mine' });
    const player = await ensurePlayer(owner, league.id, { seedKey: 'p', ordinal: 0, label: 'P' });

    expect(await getDeck(other, deck.id)).toBeNull();
    expect(await getDeck(other, 'mdk_doesnotexist')).toBeNull();
    expect(await getVersion(other, v!.id)).toBeNull();
    expect(await appendVersion(other, deck.id, { cards: [] })).toBeNull();
    expect(await appendObservation(other, league.id, { kind: 'NOTE', label: 'OBSERVED', detail: {}, observedOn: '2026-11-01' })).toBeNull();
    expect(await ensurePlayer(other, league.id, { seedKey: 'x', ordinal: 9, label: 'X' })).toBeNull();
    expect(await recordGame(other, league.id, { playedOn: '2026-11-01', participants: [], eliminations: [] })).toBeNull();
    expect(await appendLeagueDeck(other, player!.id, { cardListStatus: 'UNVERIFIED' })).toBeNull();
    expect((await getDeck(owner, deck.id))?.currentVersionId).toBe(v!.id);
  });

  it('refuses a Scryfall price as confirmed and a bad figure', async () => {
    const printing = printingIdFor('fx-sol-ring', 'c21', '263');
    await expect(recordPriceSnapshot({ ownerUserId: owner, printingId: printing, priceCents: 100, status: 'CONFIRMED', source: 'Scryfall bulk', observedOn: '2026-11-01' })).rejects.toBeInstanceOf(PriceRefused);
    await expect(recordPriceSnapshot({ ownerUserId: owner, printingId: printing, priceCents: 9.99, status: 'ESTIMATE', source: 'x', observedOn: '2026-11-01' })).rejects.toBeInstanceOf(PriceRefused);
    const est = await recordPriceSnapshot({ ownerUserId: null, printingId: printing, priceCents: 150, status: 'ESTIMATE', source: 'Scryfall bulk', observedOn: '2026-11-01' });
    expect(est.status).toBe('ESTIMATE');
  });
});
