/**
 * Loads the committed Magic fixture catalog through the same repositories the
 * product uses. No network, ever.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { upsertCard, upsertCatalogSource, upsertPrinting, type NewCatalogCard } from '../../server/repos/magicCatalog.ts';

export const FIXTURE_SOURCE = 'fixture-oracle-cards';

interface FixtureCard extends Omit<NewCatalogCard, 'rulings' | 'gameChanger' | 'sourceKey' | 'faces'> {
  faces?: unknown[];
  printings: { set: string; number: string; usd: number | null }[];
}

export function readFixtureCards(): FixtureCard[] {
  const file = fileURLToPath(new URL('../fixtures/magic/catalog.json', import.meta.url));
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { cards: FixtureCard[] }).cards;
}

export function printingIdFor(oracleId: string, set: string, number: string): string {
  return `${oracleId}:${set}:${number}`;
}

export async function loadMagicFixtures(at = '2026-11-01T00:00:00.000Z'): Promise<{ cards: number; printings: number }> {
  let printings = 0;
  const cards = readFixtureCards();
  for (const { printings: ps, ...card } of cards) {
    await upsertCard({ ...card, faces: card.faces ?? [], rulings: [], gameChanger: false, sourceKey: FIXTURE_SOURCE, fetchedAt: at });
    for (const p of ps) {
      await upsertPrinting({
        id: printingIdFor(card.oracleId, p.set, p.number), oracleId: card.oracleId, setCode: p.set, collectorNumber: p.number,
        rarity: 'common', finishes: ['nonfoil'], imageUris: {}, priceUsdCents: p.usd, priceUsdFoilCents: null, priceFetchedAt: at, releasedAt: null,
      });
      printings++;
    }
  }
  await upsertCatalogSource({ sourceKey: FIXTURE_SOURCE, status: 'FRESH', fetchedAt: at, cardCount: cards.length });
  return { cards: cards.length, printings };
}
