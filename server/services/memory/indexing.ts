/**
 * Indexing: messages into classified, searchable passages.
 *
 * Derived and deterministic. A message row is immutable — changed text is a
 * new row — so a message's passages are written once and never rewritten,
 * which is what lets idea evidence point at a passage for good.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, toJson } from '../../repos/util.ts';
import { padded, readPassage, segment, termsOf } from './classify.ts';

interface MessageRow {
  id: string;
  role: string;
  text: string;
  said_at: string | null;
  on_current_path: number;
  hidden: number;
  content_type: string;
}

/** How much one occurrence counts toward a conversation's subject. */
const ROLE_WEIGHT: Record<string, number> = { USER: 2, ASSISTANT: 1 };
const TITLE_WEIGHT = 3;
const CONVERSATION_TERMS = 40;
const INSERT_CHUNK = 40;

/** Terms are stored with `_` inside a pair, so a space always separates terms. */
export function storedTerm(term: string): string {
  return term.replace(/ /g, '_');
}

export async function indexConversation(conversationId: string): Promise<{ passages: number }> {
  const db = getDb();
  const conversation = await db.get<{ id: string; owner_user_id: string; title: string; version: number; first_said_at: string | null }>(
    'SELECT id, owner_user_id, title, version, first_said_at FROM memory_conversations WHERE id = ?',
    [conversationId],
  );
  if (!conversation) return { passages: 0 };

  const messages = await db.all<MessageRow>(
    `SELECT m.id, m.role, m.text, m.said_at, m.on_current_path, m.hidden, m.content_type
       FROM memory_messages m
      WHERE m.conversation_id = ?
      ORDER BY m.depth, m.sibling_index`,
    [conversationId],
  );
  const done = new Set(
    (await db.all<{ message_id: string }>('SELECT DISTINCT message_id FROM memory_passages WHERE conversation_id = ?', [conversationId])).map((r) => r.message_id),
  );

  const weights = new Map<string, number>();
  const bump = (term: string, by: number): void => {
    weights.set(term, (weights.get(term) ?? 0) + by);
  };
  for (const term of termsOf(conversation.title)) bump(term, TITLE_WEIGHT);

  const rows: unknown[][] = [];
  const at = nowIso();
  for (const message of messages) {
    if (!message.text.trim()) continue;
    // Tool output and hidden context are kept in the record and not read as
    // anybody's words: a web page the model fetched is not something the
    // person said, and indexing it would let it pose as their history.
    const readable = (message.role === 'USER' || message.role === 'ASSISTANT') && message.hidden === 0;
    if (!readable) continue;
    const pieces = segment(message.text);
    pieces.forEach((text, seq) => {
      const reading = readPassage(text, message.role);
      const terms = termsOf(text);
      if (message.on_current_path === 1) {
        const weight = ROLE_WEIGHT[message.role] ?? 1;
        for (const term of terms) bump(term, weight);
      }
      if (done.has(message.id)) return;
      rows.push([
        newId('mps'),
        conversation.owner_user_id,
        conversationId,
        message.id,
        seq,
        message.role,
        message.on_current_path,
        text,
        message.said_at ?? conversation.first_said_at,
        padded(reading.kinds),
        padded([...reading.facets, ...reading.domains.map((d) => `DOMAIN_${d}`), ...reading.obstacles.map((o) => `OBSTACLE_${o}`)]),
        padded(terms.slice(0, 80).map(storedTerm)),
        at,
      ]);
    });
  }

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await db.run(
      `INSERT INTO memory_passages (id, owner_user_id, conversation_id, message_id, seq, role, on_current_path, text,
         said_at, kinds, facets, terms, created_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT (message_id, seq) DO NOTHING`,
      chunk.flat() as never[],
    );
  }

  const top = [...weights.entries()]
    .filter(([term, weight]) => weight >= 2 || term.includes(' '))
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONVERSATION_TERMS)
    .map(([term, weight]) => [term, weight]);
  await db.run('UPDATE memory_conversations SET indexed_version = ?, terms = ?, updated_at = ? WHERE id = ?', [
    conversation.version,
    toJson(top),
    nowIso(),
    conversationId,
  ]);
  return { passages: rows.length };
}

/** Conversations whose passages are behind their version, oldest-first by what was said. */
export async function conversationsToIndex(ownerId: string | null, limit: number): Promise<string[]> {
  // Summer 2025 onward first (the owner's priority), then everything earlier;
  // nothing is skipped, only ordered.
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM memory_conversations
      WHERE ${ownerId ? 'owner_user_id = ? AND' : ''} indexed_version < version
      ORDER BY CASE WHEN COALESCE(last_said_at, '') >= '2025-06-01' THEN 0 ELSE 1 END,
               last_said_at DESC
      LIMIT ?`,
    ownerId ? [ownerId, limit] : [limit],
  );
  return rows.map((r) => r.id);
}
