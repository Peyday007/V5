import { loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './store/db.ts';
import { ScryfallClient } from './games/mtg/scryfall.ts';
import { CardCatalog } from './games/mtg/catalog.ts';
import { RulesBook } from './games/mtg/rules.ts';
import { ForgeBridge } from './games/mtg/forge.ts';

/** The long-lived services one server process shares. */
export interface Ctx {
  config: Config;
  db: Db;
  scryfall: ScryfallClient;
  catalog: CardCatalog;
  rules: RulesBook;
  forge: ForgeBridge;
  fetchImpl: typeof fetch;
}

export function createContext(overrides: Partial<Config> = {}, fetchImpl: typeof fetch = fetch): Ctx {
  const config = { ...loadConfig(), ...overrides };
  const db = openDb(config.dataDir);
  const scryfall = new ScryfallClient(config.scryfallApi, config.scryfallUserAgent, fetchImpl);
  return {
    config, db, scryfall, fetchImpl,
    catalog: new CardCatalog(db, scryfall),
    rules: new RulesBook(db, config.rulesPageUrl, config.scryfallUserAgent, fetchImpl),
    forge: new ForgeBridge(config.bridgeUrl, fetchImpl),
  };
}
