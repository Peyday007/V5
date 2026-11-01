/**
 * The shared Magic card catalog: one catalog for the whole Brain, never per
 * account. Cards are keyed by Scryfall oracle id; printings are separate rows.
 *
 * Names are matched by a structured key (`nameKey`), never by fuzzy search: the
 * key folds case, accents and punctuation spacing and nothing else, and a
 * double-faced card is also found by its front face. A name that matches more
 * than one card comes back as several, so ambiguity is surfaced to the caller.
 */
import { getDb } from '../db/database.ts';
import { nowIso, parseJson, toJson } from './util.ts';
import type { MagicCardRow, MagicCatalogSourceRow, MagicColor, MagicPrintingRow } from '../domain/magicTypes.ts';

export interface CatalogCard {
  oracleId: string;
  name: string;
  nameKey: string;
  layout: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  colors: MagicColor[];
  colorIdentity: MagicColor[];
  keywords: string[];
  faces: unknown[];
  legalities: Record<string, string>;
  rulings: { source?: string; publishedAt?: string; comment: string }[];
  gameChanger: boolean;
  sourceKey: string;
  fetchedAt: string;
}

export interface CatalogPrinting {
  id: string;
  oracleId: string;
  setCode: string;
  collectorNumber: string;
  rarity: string;
  finishes: string[];
  imageUris: Record<string, string>;
  priceUsdCents: number | null;
  priceUsdFoilCents: number | null;
  priceFetchedAt: string | null;
  releasedAt: string | null;
}

export type CatalogSource = {
  sourceKey: string;
  downloadUri: string | null;
  sourceUpdatedAt: string | null;
  fetchedAt: string | null;
  status: MagicCatalogSourceRow['status'];
  cardCount: number;
  lastError: string | null;
  updatedAt: string;
};

/** Case, accent and whitespace folding. Nothing fuzzier. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*\/\/\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape LIKE wildcards with `!`, which neither dialect treats specially in a string. */
const likeEscape = (text: string): string => text.replace(/[!%_]/g, (c) => `!${c}`);

const mapCard = (r: MagicCardRow): CatalogCard => ({
  oracleId: r.oracle_id,
  name: r.name,
  nameKey: r.name_key,
  layout: r.layout,
  manaCost: r.mana_cost,
  cmc: Number(r.cmc),
  typeLine: r.type_line,
  oracleText: r.oracle_text,
  colors: parseJson<MagicColor[]>(r.colors, []),
  colorIdentity: parseJson<MagicColor[]>(r.color_identity, []),
  keywords: parseJson<string[]>(r.keywords, []),
  faces: parseJson<unknown[]>(r.faces, []),
  legalities: parseJson<Record<string, string>>(r.legalities, {}),
  rulings: parseJson(r.rulings, []),
  gameChanger: Number(r.game_changer) === 1,
  sourceKey: r.source_key,
  fetchedAt: r.fetched_at,
});

const mapPrinting = (r: MagicPrintingRow): CatalogPrinting => ({
  id: r.id,
  oracleId: r.oracle_id,
  setCode: r.set_code,
  collectorNumber: r.collector_number,
  rarity: r.rarity,
  finishes: parseJson<string[]>(r.finishes, []),
  imageUris: parseJson<Record<string, string>>(r.image_uris, {}),
  priceUsdCents: r.price_usd_cents === null ? null : Number(r.price_usd_cents),
  priceUsdFoilCents: r.price_usd_foil_cents === null ? null : Number(r.price_usd_foil_cents),
  priceFetchedAt: r.price_fetched_at,
  releasedAt: r.released_at,
});

const mapSource = (r: MagicCatalogSourceRow): CatalogSource => ({
  sourceKey: r.source_key,
  downloadUri: r.download_uri,
  sourceUpdatedAt: r.source_updated_at,
  fetchedAt: r.fetched_at,
  status: r.status,
  cardCount: Number(r.card_count),
  lastError: r.last_error,
  updatedAt: r.updated_at,
});

export async function upsertCatalogSource(input: Partial<CatalogSource> & { sourceKey: string; status: CatalogSource['status'] }): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO magic_catalog_sources (source_key, download_uri, source_updated_at, fetched_at, status, card_count, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_key) DO UPDATE SET
       download_uri = COALESCE(excluded.download_uri, magic_catalog_sources.download_uri),
       source_updated_at = COALESCE(excluded.source_updated_at, magic_catalog_sources.source_updated_at),
       fetched_at = COALESCE(excluded.fetched_at, magic_catalog_sources.fetched_at),
       status = excluded.status,
       card_count = excluded.card_count,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [
      input.sourceKey,
      input.downloadUri ?? null,
      input.sourceUpdatedAt ?? null,
      input.fetchedAt ?? null,
      input.status,
      input.cardCount ?? 0,
      input.lastError ?? null,
      at,
    ],
  );
}

export async function getCatalogSource(sourceKey: string): Promise<CatalogSource | null> {
  const row = await getDb().get<MagicCatalogSourceRow>('SELECT * FROM magic_catalog_sources WHERE source_key = ?', [sourceKey]);
  return row ? mapSource(row) : null;
}

export async function listCatalogSources(): Promise<CatalogSource[]> {
  const rows = await getDb().all<MagicCatalogSourceRow>('SELECT * FROM magic_catalog_sources ORDER BY source_key');
  return rows.map(mapSource);
}

export type NewCatalogCard = Omit<CatalogCard, 'nameKey' | 'fetchedAt'> & { fetchedAt?: string };

export async function upsertCard(card: NewCatalogCard): Promise<void> {
  await getDb().run(
    `INSERT INTO magic_cards (oracle_id, name, name_key, layout, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
                              keywords, faces, legalities, rulings, game_changer, source_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (oracle_id) DO UPDATE SET
       name = excluded.name, name_key = excluded.name_key, layout = excluded.layout, mana_cost = excluded.mana_cost,
       cmc = excluded.cmc, type_line = excluded.type_line, oracle_text = excluded.oracle_text, colors = excluded.colors,
       color_identity = excluded.color_identity, keywords = excluded.keywords, faces = excluded.faces,
       legalities = excluded.legalities, rulings = excluded.rulings, game_changer = excluded.game_changer,
       source_key = excluded.source_key, fetched_at = excluded.fetched_at`,
    [
      card.oracleId, card.name, nameKey(card.name), card.layout, card.manaCost, Math.round(card.cmc), card.typeLine,
      card.oracleText, toJson(card.colors), toJson(card.colorIdentity), toJson(card.keywords), toJson(card.faces),
      toJson(card.legalities), toJson(card.rulings), card.gameChanger ? 1 : 0, card.sourceKey, card.fetchedAt ?? nowIso(),
    ],
  );
}

export async function upsertPrinting(p: CatalogPrinting): Promise<void> {
  await getDb().run(
    `INSERT INTO magic_printings (id, oracle_id, set_code, collector_number, rarity, finishes, image_uris,
                                  price_usd_cents, price_usd_foil_cents, price_fetched_at, released_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       rarity = excluded.rarity, finishes = excluded.finishes, image_uris = excluded.image_uris,
       price_usd_cents = excluded.price_usd_cents, price_usd_foil_cents = excluded.price_usd_foil_cents,
       price_fetched_at = excluded.price_fetched_at, released_at = excluded.released_at`,
    [
      p.id, p.oracleId, p.setCode, p.collectorNumber, p.rarity, toJson(p.finishes), toJson(p.imageUris),
      p.priceUsdCents, p.priceUsdFoilCents, p.priceFetchedAt, p.releasedAt,
    ],
  );
}

export async function getCard(oracleId: string): Promise<CatalogCard | null> {
  const row = await getDb().get<MagicCardRow>('SELECT * FROM magic_cards WHERE oracle_id = ?', [oracleId]);
  return row ? mapCard(row) : null;
}

/** Every card the name could mean: the full name, or the front face of a double-faced card. */
export async function findCardsByName(name: string): Promise<CatalogCard[]> {
  const key = nameKey(name);
  const rows = await getDb().all<MagicCardRow>(
    `SELECT * FROM magic_cards WHERE name_key = ? OR name_key LIKE ? ESCAPE '!' ORDER BY name_key, oracle_id`,
    [key, `${likeEscape(key)} // %`],
  );
  return rows.map(mapCard);
}

export async function searchCardsByPrefix(prefix: string, limit = 20): Promise<CatalogCard[]> {
  const rows = await getDb().all<MagicCardRow>(
    `SELECT * FROM magic_cards WHERE name_key LIKE ? ESCAPE '!' ORDER BY name_key LIMIT ?`,
    [`${likeEscape(nameKey(prefix))}%`, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(mapCard);
}

export async function countCards(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM magic_cards');
  return Number(row?.n ?? 0);
}

export async function listPrintings(oracleId: string): Promise<CatalogPrinting[]> {
  const rows = await getDb().all<MagicPrintingRow>(
    'SELECT * FROM magic_printings WHERE oracle_id = ? ORDER BY released_at, set_code, collector_number',
    [oracleId],
  );
  return rows.map(mapPrinting);
}

export async function getPrinting(id: string): Promise<CatalogPrinting | null> {
  const row = await getDb().get<MagicPrintingRow>('SELECT * FROM magic_printings WHERE id = ?', [id]);
  return row ? mapPrinting(row) : null;
}
