import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { loadMagicFixtures, FIXTURE_SOURCE } from './helpers/magicFixtures.ts';
import { countCards, findCardsByName, getCard, getCatalogSource, listPrintings, nameKey, searchCardsByPrefix, upsertCard, upsertCatalogSource } from '../server/repos/magicCatalog.ts';

beforeEach(async () => {
  await freshProject();
  await loadMagicFixtures();
});

describe('catalog repository', () => {
  it('loads the fixture catalog with separate printings and parsed fields', async () => {
    expect(await countCards()).toBeGreaterThanOrEqual(9);
    const sol = await getCard('fx-sol-ring');
    expect(sol?.colorIdentity).toEqual([]);
    expect(sol?.legalities['commander']).toBe('legal');
    expect(await listPrintings('fx-sol-ring')).toHaveLength(2);
  });
  it('finds a double-faced card by full name or by its front face, structurally', async () => {
    expect((await findCardsByName('Delver of Secrets // Insectile Aberration'))[0]?.oracleId).toBe('fx-delver');
    expect((await findCardsByName('delver of secrets'))[0]?.oracleId).toBe('fx-delver');
    expect(await findCardsByName('Delver')).toEqual([]);
    expect(nameKey('  Kardur,   Doomscourge ')).toBe('kardur, doomscourge');
  });
  it('reports two cards for one name rather than choosing', async () => {
    await upsertCard({ oracleId: 'fx-bolt-b', name: 'Lightning Bolt', layout: 'normal', manaCost: '{R}', cmc: 1, typeLine: 'Instant', oracleText: '', colors: ['R'], colorIdentity: ['R'], keywords: [], faces: [], legalities: {}, rulings: [], gameChanger: false, sourceKey: FIXTURE_SOURCE });
    expect(await findCardsByName('lightning bolt')).toHaveLength(2);
  });
  it('searches by escaped prefix', async () => {
    expect((await searchCardsByPrefix('rel')).map((c) => c.name)).toEqual(['Relentless Rats']);
    expect(await searchCardsByPrefix('%')).toEqual([]);
  });
  it('keeps per-source fetch timestamps and records a failure without losing the last fetch', async () => {
    await upsertCatalogSource({ sourceKey: 'oracle-cards', status: 'FRESH', fetchedAt: '2026-10-31T00:00:00.000Z', downloadUri: 'https://example.invalid/x.json', cardCount: 5 });
    await upsertCatalogSource({ sourceKey: 'oracle-cards', status: 'FAILED', cardCount: 5, lastError: 'timeout' });
    const s = await getCatalogSource('oracle-cards');
    expect(s?.status).toBe('FAILED');
    expect(s?.fetchedAt).toBe('2026-10-31T00:00:00.000Z');
    expect(s?.downloadUri).toBe('https://example.invalid/x.json');
  });
});
