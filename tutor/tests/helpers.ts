import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/store/db.ts';
import { CardCatalog } from '../server/games/mtg/catalog.ts';
import { ScryfallClient } from '../server/games/mtg/scryfall.ts';
import type { ForgeBridge } from '../server/games/mtg/forge.ts';

/** A catalog loaded from a committed subset of Scryfall's Oracle data (no network). */
export function fixtureCatalog() {
  const dir = mkdtempSync(join(tmpdir(), 'tutor-test-'));
  const db = openDb(dir);
  const scryfall = new ScryfallClient('http://127.0.0.1:9', 'tutor-tests/1.0',(async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch);
  const catalog = new CardCatalog(db, scryfall);
  catalog.load(JSON.parse(readFileSync(new URL('./fixtures/cards.json', import.meta.url), 'utf8')), '2026-10-14T00:00:00Z', 'tests/fixtures/cards.json');
  return { db, catalog, dir };
}

/** A Forge bridge stand-in that reports a named set of cards as unsupported. */
export function fakeForge(unsupported: string[] = []): ForgeBridge {
  return {
    health: async () => ({ ok: true, engine: 'Forge', forgeVersion: 'test', forgeRevision: 'b6f135e649de6ab8fd98df3cf8b32905b02340ba', uniqueCards: 1, multiplayer: true }),
    checkCards: async (cards: Array<{ name: string }>) => cards.map((c) => ({ name: c.name, supported: !unsupported.includes(c.name), forgeName: c.name, printingFound: true, aiPlayable: true })),
    validate: async () => ({ conforms: true, mainCount: 99, commanderCount: 1 }),
  } as unknown as ForgeBridge;
}

export const fixtureText = (name: string) => readFileSync(new URL(`../fixtures/decks/${name}.txt`, import.meta.url), 'utf8');
