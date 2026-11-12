/**
 * Decks, their append-only versions, design intents, analyses and the
 * collection. Everything here is owner-scoped: every function takes the owner
 * and a miss — absent, or somebody else's — returns the same null/false, so a
 * caller cannot tell the two apart (invariant 23).
 *
 * A version is never updated. Undo moves the deck's `current_version_id`
 * pointer to an earlier version; the rows it leaves behind stay.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  MagicAnalysisRow, MagicCollectionRow, MagicDeckCardRow, MagicDeckRow, MagicDeckVersionRow,
  MagicDesignIntentRow, MagicFormat, MagicZone, DesignState,
} from '../domain/magicTypes.ts';

export interface DeckCardInput {
  zone: MagicZone;
  cardName: string;
  quantity: number;
  oracleId?: string | null;
  printingId?: string | null;
  role?: string | null;
}

export interface DeckVersionView {
  id: string;
  deckId: string;
  versionNumber: number;
  parentVersionId: string | null;
  reason: string;
  source: string;
  validation: unknown;
  createdAt: string;
  cards: DeckCardInput[];
}

export interface DeckView {
  id: string;
  ownerUserId: string;
  name: string;
  format: MagicFormat;
  currentVersionId: string | null;
  cardListStatus: 'VERIFIED' | 'UNVERIFIED';
  notes: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const mapDeck = (r: MagicDeckRow): DeckView => ({
  id: r.id, ownerUserId: r.owner_user_id, name: r.name, format: r.format, currentVersionId: r.current_version_id,
  cardListStatus: r.card_list_status, notes: r.notes, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapCard = (r: MagicDeckCardRow): DeckCardInput => ({
  zone: r.zone, cardName: r.card_name, quantity: Number(r.quantity), oracleId: r.oracle_id, printingId: r.printing_id, role: r.role,
});

export async function createDeck(input: {
  ownerUserId: string; name: string; format: MagicFormat; cardListStatus?: 'VERIFIED' | 'UNVERIFIED'; notes?: string;
}): Promise<DeckView> {
  const id = newId('mdk');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO magic_decks (id, owner_user_id, name, format, current_version_id, card_list_status, notes, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    [id, input.ownerUserId, input.name, input.format, input.cardListStatus ?? 'VERIFIED', input.notes ?? '', at, at],
  );
  return (await getDeck(input.ownerUserId, id))!;
}

export async function getDeck(ownerUserId: string, deckId: string): Promise<DeckView | null> {
  const row = await getDb().get<MagicDeckRow>('SELECT * FROM magic_decks WHERE id = ? AND owner_user_id = ?', [deckId, ownerUserId]);
  return row ? mapDeck(row) : null;
}

export async function listDecks(ownerUserId: string, includeArchived = false): Promise<DeckView[]> {
  const rows = await getDb().all<MagicDeckRow>(
    `SELECT * FROM magic_decks WHERE owner_user_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC, id`,
    [ownerUserId],
  );
  return rows.map(mapDeck);
}

export async function archiveDeck(ownerUserId: string, deckId: string): Promise<boolean> {
  const at = nowIso();
  const r = await getDb().run(
    'UPDATE magic_decks SET archived_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND archived_at IS NULL',
    [at, at, deckId, ownerUserId],
  );
  return r.changes === 1;
}

async function loadVersion(row: MagicDeckVersionRow): Promise<DeckVersionView> {
  const cards = await getDb().all<MagicDeckCardRow>(
    `SELECT * FROM magic_deck_cards WHERE version_id = ? ORDER BY CASE zone WHEN 'commander' THEN 0 WHEN 'main' THEN 1 ELSE 2 END, card_name`,
    [row.id],
  );
  return {
    id: row.id, deckId: row.deck_id, versionNumber: Number(row.version_number), parentVersionId: row.parent_version_id,
    reason: row.reason, source: row.source, validation: parseJson(row.validation, {}), createdAt: row.created_at,
    cards: cards.map(mapCard),
  };
}

/**
 * Append a new version and point the deck at it. The version number is
 * claimed by the UNIQUE (deck_id, version_number) index, so two writers racing
 * for the same number produce one winner and one retry rather than a gap.
 */
export async function appendVersion(
  ownerUserId: string,
  deckId: string,
  input: { cards: DeckCardInput[]; reason?: string; source?: string; validation?: unknown },
): Promise<DeckVersionView | null> {
  const deck = await getDeck(ownerUserId, deckId);
  if (!deck) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await getDb().transaction(async () => {
        const db = getDb();
        const last = await db.get<{ n: number | string | null }>('SELECT MAX(version_number) AS n FROM magic_deck_versions WHERE deck_id = ?', [deckId]);
        const number = Number(last?.n ?? 0) + 1;
        const id = newId('mdv');
        const at = nowIso();
        const parent = (await db.get<{ current_version_id: string | null }>('SELECT current_version_id FROM magic_decks WHERE id = ?', [deckId]))?.current_version_id ?? null;
        await db.run(
          `INSERT INTO magic_deck_versions (id, deck_id, owner_user_id, version_number, parent_version_id, reason, source, validation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, deckId, ownerUserId, number, parent, input.reason ?? '', input.source ?? 'MANUAL', toJson(input.validation ?? {}), at],
        );
        const merged = new Map<string, DeckCardInput>();
        for (const c of input.cards) {
          const key = `${c.zone}|${c.cardName}`;
          const prev = merged.get(key);
          merged.set(key, prev ? { ...prev, quantity: prev.quantity + c.quantity } : { ...c });
        }
        for (const c of merged.values()) {
          await db.run(
            `INSERT INTO magic_deck_cards (id, version_id, zone, oracle_id, card_name, printing_id, quantity, role)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId('mdc'), id, c.zone, c.oracleId ?? null, c.cardName, c.printingId ?? null, c.quantity, c.role ?? null],
          );
        }
        await db.run('UPDATE magic_decks SET current_version_id = ?, updated_at = ? WHERE id = ?', [id, at, deckId]);
        const row = (await db.get<MagicDeckVersionRow>('SELECT * FROM magic_deck_versions WHERE id = ?', [id]))!;
        return loadVersion(row);
      });
    } catch (error) {
      if (attempt === 4 || !/unique|duplicate/i.test(String((error as Error).message))) throw error;
    }
  }
  return null;
}

export async function getVersion(ownerUserId: string, versionId: string): Promise<DeckVersionView | null> {
  const row = await getDb().get<MagicDeckVersionRow>('SELECT * FROM magic_deck_versions WHERE id = ? AND owner_user_id = ?', [versionId, ownerUserId]);
  return row ? loadVersion(row) : null;
}

export async function listVersions(ownerUserId: string, deckId: string): Promise<Omit<DeckVersionView, 'cards'>[]> {
  const rows = await getDb().all<MagicDeckVersionRow>(
    'SELECT * FROM magic_deck_versions WHERE deck_id = ? AND owner_user_id = ? ORDER BY version_number',
    [deckId, ownerUserId],
  );
  return rows.map((row) => ({
    id: row.id, deckId: row.deck_id, versionNumber: Number(row.version_number), parentVersionId: row.parent_version_id,
    reason: row.reason, source: row.source, validation: parseJson(row.validation, {}), createdAt: row.created_at,
  }));
}

export async function currentVersion(ownerUserId: string, deckId: string): Promise<DeckVersionView | null> {
  const deck = await getDeck(ownerUserId, deckId);
  return deck?.currentVersionId ? getVersion(ownerUserId, deck.currentVersionId) : null;
}

/** Undo or redo: point the deck at a version of its own. No version row is touched. */
export async function setCurrentVersion(ownerUserId: string, deckId: string, versionId: string): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE magic_decks SET current_version_id = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?
        AND EXISTS (SELECT 1 FROM magic_deck_versions v WHERE v.id = ? AND v.deck_id = ? AND v.owner_user_id = ?)`,
    [versionId, nowIso(), deckId, ownerUserId, versionId, deckId, ownerUserId],
  );
  return r.changes === 1;
}

export interface VersionDiff {
  added: DeckCardInput[];
  removed: DeckCardInput[];
  changed: { zone: MagicZone; cardName: string; from: number; to: number }[];
}

export function diffCards(from: DeckCardInput[], to: DeckCardInput[]): VersionDiff {
  const key = (c: DeckCardInput) => `${c.zone}|${c.cardName}`;
  const a = new Map(from.map((c) => [key(c), c]));
  const b = new Map(to.map((c) => [key(c), c]));
  const diff: VersionDiff = { added: [], removed: [], changed: [] };
  for (const [k, c] of b) {
    const prev = a.get(k);
    if (!prev) diff.added.push(c);
    else if (prev.quantity !== c.quantity) diff.changed.push({ zone: c.zone, cardName: c.cardName, from: prev.quantity, to: c.quantity });
  }
  for (const [k, c] of a) if (!b.has(k)) diff.removed.push(c);
  return diff;
}

export async function diffVersions(ownerUserId: string, fromId: string, toId: string): Promise<VersionDiff | null> {
  const [from, to] = await Promise.all([getVersion(ownerUserId, fromId), getVersion(ownerUserId, toId)]);
  if (!from || !to) return null;
  return diffCards(from.cards, to.cards);
}

/* ---- collection: owned vs proxy, apart from deck membership ---- */

export async function setCollectionQuantity(
  ownerUserId: string,
  input: { cardName: string; status: 'OWNED' | 'PROXY'; quantity: number; oracleId?: string | null; printingId?: string | null },
): Promise<void> {
  await getDb().run(
    `INSERT INTO magic_collections (id, owner_user_id, oracle_id, card_name, printing_id, status, quantity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_user_id, card_name, status) DO UPDATE SET
       quantity = excluded.quantity, oracle_id = excluded.oracle_id, printing_id = excluded.printing_id, updated_at = excluded.updated_at`,
    [newId('mcl'), ownerUserId, input.oracleId ?? null, input.cardName, input.printingId ?? null, input.status, input.quantity, nowIso()],
  );
}

export async function listCollection(ownerUserId: string): Promise<MagicCollectionRow[]> {
  return getDb().all<MagicCollectionRow>('SELECT * FROM magic_collections WHERE owner_user_id = ? AND quantity > 0 ORDER BY card_name, status', [ownerUserId]);
}

/* ---- design intents and analyses ---- */

export async function saveDesignIntent(
  ownerUserId: string,
  input: {
    deckId?: string | null; rawText: string; structured: unknown; conflicts?: unknown[]; alternatives?: unknown[];
    question?: string | null; assumptions?: unknown[]; state: DesignState; parentIntentId?: string | null;
  },
): Promise<MagicDesignIntentRow> {
  const id = newId('mdi');
  await getDb().run(
    `INSERT INTO magic_design_intents (id, owner_user_id, deck_id, raw_text, structured, conflicts, alternatives, question, assumptions, state, parent_intent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ownerUserId, input.deckId ?? null, input.rawText, toJson(input.structured), toJson(input.conflicts ?? []), toJson(input.alternatives ?? []),
      input.question ?? null, toJson(input.assumptions ?? []), input.state, input.parentIntentId ?? null, nowIso()],
  );
  return (await getDb().get<MagicDesignIntentRow>('SELECT * FROM magic_design_intents WHERE id = ?', [id]))!;
}

export async function getDesignIntent(ownerUserId: string, id: string): Promise<MagicDesignIntentRow | null> {
  return (await getDb().get<MagicDesignIntentRow>('SELECT * FROM magic_design_intents WHERE id = ? AND owner_user_id = ?', [id, ownerUserId])) ?? null;
}

export async function listDesignIntents(ownerUserId: string, limit = 50): Promise<MagicDesignIntentRow[]> {
  return getDb().all<MagicDesignIntentRow>(
    'SELECT * FROM magic_design_intents WHERE owner_user_id = ? ORDER BY created_at DESC, id LIMIT ?',
    [ownerUserId, limit],
  );
}

export async function saveAnalysis(
  ownerUserId: string,
  input: { deckId?: string | null; versionId?: string | null; kind: 'ANALYZE' | 'OPTIMIZE'; seed?: string | null; assumptions?: unknown; result: unknown },
): Promise<MagicAnalysisRow> {
  const id = newId('man');
  await getDb().run(
    `INSERT INTO magic_analyses (id, owner_user_id, deck_id, version_id, kind, seed, assumptions, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ownerUserId, input.deckId ?? null, input.versionId ?? null, input.kind, input.seed ?? null, toJson(input.assumptions ?? {}), toJson(input.result), nowIso()],
  );
  return (await getDb().get<MagicAnalysisRow>('SELECT * FROM magic_analyses WHERE id = ?', [id]))!;
}

export async function listAnalyses(ownerUserId: string, deckId: string, limit = 20): Promise<MagicAnalysisRow[]> {
  return getDb().all<MagicAnalysisRow>(
    'SELECT * FROM magic_analyses WHERE owner_user_id = ? AND deck_id = ? ORDER BY created_at DESC, id LIMIT ?',
    [ownerUserId, deckId, limit],
  );
}
