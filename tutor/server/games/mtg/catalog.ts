import type { Db } from '../../store/db.ts';
import { getMeta, nowIso, setMeta } from '../../store/db.ts';
import type { Ruling, ScryfallCard, ScryfallClient } from './scryfall.ts';

/**
 * Card identities, Oracle text, legalities and rulings, from Scryfall's bulk files, cached
 * locally. A specific printing (set + collector number) is fetched once and cached.
 */
export function normName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s*\/\/?\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Layouts where Forge and people name the card by its front face alone. */
const FRONT_FACE_LAYOUTS = new Set(['transform', 'modal_dfc', 'adventure', 'flip', 'meld', 'prepare', 'battle', 'reversible_card']);
const NOT_GAME_CARDS = new Set(['token', 'double_faced_token', 'art_series', 'emblem', 'vanguard', 'scheme', 'planar']);

export interface CatalogStatus { cards: number; updatedAt: string | null; source: string | null }

export class CardCatalog {
  constructor(private db: Db, private scryfall: ScryfallClient) {}

  status(): CatalogStatus {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
    return { cards: n, updatedAt: getMeta(this.db, 'oracle_updated_at'), source: getMeta(this.db, 'oracle_source') };
  }

  /** Replaces the local Oracle catalog from Scryfall's daily Oracle Cards bulk file. */
  async sync(log: (m: string) => void = () => undefined): Promise<CatalogStatus> {
    const { uri, updatedAt } = await this.scryfall.bulkUri('oracle_cards');
    log(`downloading ${uri}`);
    const cards: ScryfallCard[] = [];
    for await (const c of this.scryfall.streamBulk<ScryfallCard>(uri)) cards.push(c);
    this.load(cards, updatedAt, uri);
    try {
      const r = await this.scryfall.bulkUri('rulings');
      log(`downloading ${r.uri}`);
      const by = new Map<string, Ruling[]>();
      for await (const x of this.scryfall.streamBulk<Ruling & { oracle_id: string }>(r.uri)) {
        const list = by.get(x.oracle_id) ?? [];
        list.push({ source: x.source, published_at: x.published_at, comment: x.comment });
        by.set(x.oracle_id, list);
      }
      this.db.exec('BEGIN');
      this.db.exec('DELETE FROM rulings');
      const ins = this.db.prepare('INSERT INTO rulings (oracle_id, json) VALUES (?, ?)');
      for (const [k, v] of by) ins.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
      setMeta(this.db, 'rulings_updated_at', r.updatedAt);
    } catch (e) {
      log(`rulings not loaded: ${String(e)}`);
    }
    return this.status();
  }

  /** Loads card objects (from a bulk file or a fixture) as the whole catalog. */
  load(cards: ScryfallCard[], updatedAt: string, source: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM cards; DELETE FROM card_names;');
      const ins = this.db.prepare('INSERT OR REPLACE INTO cards (oracle_id, name, layout, json) VALUES (?, ?, ?, ?)');
      const nm = this.db.prepare('INSERT OR IGNORE INTO card_names (norm, oracle_id, kind) VALUES (?, ?, ?)');
      for (const c of cards) {
        if (!c.oracle_id && !c.card_faces) continue;
        if (NOT_GAME_CARDS.has(c.layout)) continue;
        const oid = c.oracle_id ?? c.id;
        ins.run(oid, c.name, c.layout, JSON.stringify(slim(c)));
        nm.run(normName(c.name), oid, 'FULL');
        for (const f of c.card_faces ?? []) {
          if (normName(f.name) !== normName(c.name)) nm.run(normName(f.name), oid, 'FACE');
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    setMeta(this.db, 'oracle_updated_at', updatedAt);
    setMeta(this.db, 'oracle_source', source);
  }

  byOracleId(oid: string): ScryfallCard | null {
    const r = this.db.prepare('SELECT json FROM cards WHERE oracle_id = ?').get(oid) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as ScryfallCard) : null;
  }

  /** Every card whose full name or a face name normalizes to this. */
  exact(name: string): Array<{ card: ScryfallCard; kind: 'FULL' | 'FACE' }> {
    const rows = this.db.prepare('SELECT oracle_id, kind FROM card_names WHERE norm = ?').all(normName(name)) as Array<{ oracle_id: string; kind: 'FULL' | 'FACE' }>;
    const out: Array<{ card: ScryfallCard; kind: 'FULL' | 'FACE' }> = [];
    for (const r of rows) {
      const card = this.byOracleId(r.oracle_id);
      if (card) out.push({ card, kind: r.kind });
    }
    return out;
  }

  /** Names close to what was typed, best first — offered to a person, never applied silently. */
  suggest(name: string, limit = 5): string[] {
    const q = normName(name);
    if (q.length < 2) return [];
    const first = q.slice(0, 1);
    const words = q.split(' ').filter((w) => w.length > 2);
    const rows = this.db.prepare(
      "SELECT DISTINCT c.name AS name, n.norm AS norm FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id WHERE n.norm LIKE ? OR n.norm LIKE ?",
    ).all(`${first}%`, `%${words[0] ?? q}%`) as Array<{ name: string; norm: string }>;
    const scored = rows
      .map((r) => ({ name: r.name, d: distance(q, r.norm) - (words.every((w) => r.norm.includes(w)) ? 3 : 0) }))
      .filter((r) => r.d <= Math.max(3, Math.floor(q.length / 3)))
      .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of scored) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      out.push(r.name);
      if (out.length >= limit) break;
    }
    return out;
  }

  rulings(oid: string): Ruling[] {
    const r = this.db.prepare('SELECT json FROM rulings WHERE oracle_id = ?').get(oid) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Ruling[]) : [];
  }

  /** A specific printing, from the cache or Scryfall. Null when Scryfall says it does not exist. */
  async printing(set: string, number: string): Promise<ScryfallCard | null> {
    const key = [set.toLowerCase(), number];
    const row = this.db.prepare('SELECT json FROM printings WHERE set_code = ? AND number = ?').get(...key) as { json: string | null } | undefined;
    if (row) return row.json ? (JSON.parse(row.json) as ScryfallCard) : null;
    const card = await this.scryfall.printing(set, number);
    this.db.prepare('INSERT OR REPLACE INTO printings (set_code, number, json, fetched_at) VALUES (?, ?, ?, ?)')
      .run(key[0]!, key[1]!, card ? JSON.stringify(slim(card)) : null, nowIso());
    return card ? slim(card) : null;
  }

  /** Fetches every uncached printing in as few requests as Scryfall allows, and caches the answers. */
  async prefetchPrintings(list: Array<{ set: string; number: string }>): Promise<void> {
    const missing: Array<{ set: string; collector_number: string }> = [];
    const seen = new Set<string>();
    for (const p of list) {
      const k = `${p.set.toLowerCase()}|${p.number}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const row = this.db.prepare('SELECT 1 FROM printings WHERE set_code = ? AND number = ?').get(p.set.toLowerCase(), p.number);
      if (!row) missing.push({ set: p.set.toLowerCase(), collector_number: p.number });
    }
    if (!missing.length) return;
    const res = await this.scryfall.collection(missing);
    const ins = this.db.prepare('INSERT OR REPLACE INTO printings (set_code, number, json, fetched_at) VALUES (?, ?, ?, ?)');
    for (const c of res.data) ins.run((c.set ?? '').toLowerCase(), c.collector_number ?? '', JSON.stringify(slim(c)), nowIso());
    for (const n of res.not_found) ins.run(n.set.toLowerCase(), n.collector_number, null, nowIso());
  }

  /** The name Forge's card database uses for this card. */
  static forgeName(card: ScryfallCard): string {
    if (FRONT_FACE_LAYOUTS.has(card.layout) && card.card_faces?.[0]) return card.card_faces[0].name;
    return card.name;
  }

  static usesFrontFaceName(card: ScryfallCard): boolean {
    return FRONT_FACE_LAYOUTS.has(card.layout);
  }
}

function slim(c: ScryfallCard): ScryfallCard {
  const keep: ScryfallCard = {
    id: c.id, oracle_id: c.oracle_id, name: c.name, layout: c.layout, mana_cost: c.mana_cost, cmc: c.cmc,
    type_line: c.type_line, oracle_text: c.oracle_text, power: c.power, toughness: c.toughness, loyalty: c.loyalty,
    colors: c.colors, color_identity: c.color_identity, keywords: c.keywords, legalities: c.legalities,
    set: c.set, set_name: c.set_name, collector_number: c.collector_number, released_at: c.released_at,
    image_uris: c.image_uris, scryfall_uri: c.scryfall_uri, game_changer: c.game_changer,
  };
  if (c.card_faces) {
    keep.card_faces = c.card_faces.map((f) => ({
      name: f.name, mana_cost: f.mana_cost, type_line: f.type_line, oracle_text: f.oracle_text,
      power: f.power, toughness: f.toughness, loyalty: f.loyalty, image_uris: f.image_uris,
    }));
  }
  return keep;
}

export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 8) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Text of a card, both faces where it has them. */
export function cardText(c: ScryfallCard): string {
  if (c.card_faces?.length) {
    return c.card_faces.map((f) => `${f.name}${f.mana_cost ? ' ' + f.mana_cost : ''}\n${f.type_line ?? ''}\n${f.oracle_text ?? ''}`).join('\n—\n');
  }
  return `${c.oracle_text ?? ''}`;
}

export function typeLine(c: ScryfallCard): string {
  return c.type_line ?? c.card_faces?.map((f) => f.type_line).join(' // ') ?? '';
}

export function imageFor(c: ScryfallCard, face = 0, size: 'normal' | 'large' | 'small' = 'normal'): string | null {
  if (c.image_uris?.[size]) return c.image_uris[size]!;
  return c.card_faces?.[face]?.image_uris?.[size] ?? null;
}
