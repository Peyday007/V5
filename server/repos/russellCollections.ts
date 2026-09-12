/**
 * Collections — the durable shape of a person's conversations.
 *
 * Everything here obeys one rule that is not obvious from the table: **the
 * automatic pass may write only over its own decisions.** A person who moves a
 * thread, renames a collection, or files something under "Personal" has made a
 * judgment, and a nightly re-classification that overwrote it would make the
 * correction indistinguishable from an accident. So every write that the
 * organizer performs is guarded on `collection_source = 'AUTOMATIC'` or on the
 * column still being unset, in the statement that makes the change — the same
 * shape as every other guarded write in this codebase.
 *
 * Nothing here ranks. Rank is a fact about live missions and the last turn, and
 * a stored one would be stale the moment a worker answered something.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  CollectionKind,
  RussellCollection,
  RussellCollectionRow,
} from '../domain/types.ts';

function map(row: RussellCollectionRow): RussellCollection {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind as CollectionKind,
    source: row.source === 'USER' ? 'USER' : 'AUTOMATIC',
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCollections(ownerUserId: string): Promise<RussellCollection[]> {
  const rows = await getDb().all<RussellCollectionRow>(
    `SELECT * FROM russell_collections
      WHERE owner_user_id = ?
      ORDER BY name`,
    [ownerUserId],
  );
  return rows.map(map);
}

export async function getCollection(id: string): Promise<RussellCollection | null> {
  const rows = await getDb().all<RussellCollectionRow>(
    'SELECT * FROM russell_collections WHERE id = ?',
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The collection with this name, creating it if the person has none.
 *
 * `ON CONFLICT DO NOTHING` against the unique index rather than
 * read-then-write: two requests organizing the same person's threads at once
 * would otherwise both see nothing and both insert, and one of them would fail
 * on the index having already done half its work. The loser reads the row it
 * collided with, which is the same shape §20 uses for an effect reservation.
 */
export async function ensureCollection(input: {
  ownerUserId: string;
  name: string;
  kind: CollectionKind;
  projectId?: string | null;
  source?: 'AUTOMATIC' | 'USER';
}): Promise<RussellCollection> {
  const db = getDb();
  const now = nowIso();
  const id = newId('rcl');
  await db.run(
    `INSERT INTO russell_collections
       (id, owner_user_id, project_id, name, kind, source, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (owner_user_id, name) DO NOTHING`,
    [
      id,
      input.ownerUserId,
      input.projectId ?? null,
      input.name,
      input.kind,
      input.source ?? 'AUTOMATIC',
      now,
      now,
    ],
  );
  const rows = await getDb().all<RussellCollectionRow>(
    'SELECT * FROM russell_collections WHERE owner_user_id = ? AND name = ?',
    [input.ownerUserId, input.name],
  );
  const row = rows[0];
  if (!row) throw new Error('collection vanished between insert and read');
  return map(row);
}

/**
 * File a thread, without ever overwriting a person's decision.
 *
 * `actor` says who is filing. `AUTOMATIC` is guarded so it can only move a
 * thread nobody has placed or one it placed itself; `USER` moves anything the
 * person owns. The owner check is in the statement rather than in a caller,
 * because a filing route that forgot it would be a way to read which
 * collections somebody else has.
 */
export async function fileConversation(input: {
  conversationId: string;
  ownerUserId: string;
  collectionId: string | null;
  actor: 'AUTOMATIC' | 'USER';
}): Promise<boolean> {
  const guard =
    input.actor === 'USER'
      ? ''
      : " AND (collection_source = 'NONE' OR collection_source = 'AUTOMATIC')";
  const result = await getDb().run(
    `UPDATE russell_conversations
        SET collection_id = ?, collection_source = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?${guard}`,
    [input.collectionId, input.actor, nowIso(), input.conversationId, input.ownerUserId],
  );
  return result.changes > 0;
}

/**
 * Say a thread is finished, or that it is not.
 *
 * A person's statement, never a derivation: a thread whose mission completed
 * may still be where the next question goes, and one nobody has touched for a
 * month may be abandoned rather than done.
 */
export async function setConversationClosed(input: {
  conversationId: string;
  ownerUserId: string;
  closed: boolean;
}): Promise<boolean> {
  const now = nowIso();
  const result = await getDb().run(
    `UPDATE russell_conversations
        SET closed_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?`,
    [input.closed ? now : null, now, input.conversationId, input.ownerUserId],
  );
  return result.changes > 0;
}
