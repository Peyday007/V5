/**
 * Scryfall card objects to catalog rows. Pure.
 *
 * Money is parsed from Scryfall's decimal strings into integer cents without
 * going through floating point. Double-faced and modal cards keep their faces
 * and take their cost from the front; the card-level name stays "Front // Back"
 * so the repository's structured lookup can find it by either face.
 */
import type { NewCatalogCard, CatalogPrinting } from '../../../repos/magicCatalog.ts';
import type { MagicColor } from '../../../domain/magicTypes.ts';

interface ScryfallFace {
  name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  image_uris?: Record<string, string>;
}

export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  layout?: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  card_faces?: ScryfallFace[];
  legalities?: Record<string, string>;
  game_changer?: boolean;
  set?: string;
  collector_number?: string;
  rarity?: string;
  finishes?: string[];
  image_uris?: Record<string, string>;
  prices?: Record<string, string | null>;
  released_at?: string;
  games?: string[];
}

const NOT_PLAYED_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'planar', 'scheme']);

export function centsFromDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?\d*$/.exec(value.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);
const colors = (list: string[] | undefined): MagicColor[] => (list ?? []).filter((c): c is MagicColor => COLORS.has(c));

/** null when the object is not a card a deck can contain. */
export function normalizeCard(raw: ScryfallCard, sourceKey: string, fetchedAt: string): { card: NewCatalogCard; printing: CatalogPrinting } | null {
  if (!raw.oracle_id || !raw.name) return null;
  if (NOT_PLAYED_LAYOUTS.has(raw.layout ?? '')) return null;
  if (raw.games && !raw.games.includes('paper')) return null;
  const faces = raw.card_faces ?? [];
  const front = faces[0];
  const multi = faces.length > 1;
  const text = multi ? faces.map((f) => f.oracle_text ?? '').join('\n//\n') : raw.oracle_text ?? front?.oracle_text ?? '';
  const card: NewCatalogCard = {
    oracleId: raw.oracle_id,
    name: raw.name,
    layout: raw.layout ?? 'normal',
    manaCost: raw.mana_cost || front?.mana_cost || '',
    cmc: raw.cmc ?? 0,
    typeLine: raw.type_line ?? (multi ? faces.map((f) => f.type_line ?? '').join(' // ') : ''),
    oracleText: text,
    colors: colors(raw.colors ?? front?.colors),
    colorIdentity: colors(raw.color_identity),
    keywords: raw.keywords ?? [],
    faces: multi
      ? faces.map((f) => ({ name: f.name, manaCost: f.mana_cost ?? '', typeLine: f.type_line ?? '', oracleText: f.oracle_text ?? '', imageUris: f.image_uris ?? {} }))
      : [],
    legalities: raw.legalities ?? {},
    rulings: [],
    gameChanger: raw.game_changer === true,
    sourceKey,
    fetchedAt,
  };
  const printing: CatalogPrinting = {
    id: raw.id,
    oracleId: raw.oracle_id,
    setCode: raw.set ?? '',
    collectorNumber: raw.collector_number ?? '',
    rarity: raw.rarity ?? '',
    finishes: raw.finishes ?? [],
    imageUris: raw.image_uris ?? front?.image_uris ?? {},
    priceUsdCents: centsFromDecimal(raw.prices?.['usd']),
    priceUsdFoilCents: centsFromDecimal(raw.prices?.['usd_foil']),
    priceFetchedAt: raw.prices ? fetchedAt : null,
    releasedAt: raw.released_at ?? null,
  };
  return { card, printing };
}
