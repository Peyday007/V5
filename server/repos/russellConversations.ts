/**
 * Russell's conversations, their context history, and their turns.
 *
 * Three things here are load-bearing and worth stating before the code.
 *
 * **A thread may have no project.** `project_id` is nullable, so a person can
 * start talking before anything is chosen and Russell can attach the thread
 * when it is confident enough. `NULL` is a real state, not a missing value, and
 * nothing below defaults it to a project to make a query simpler.
 *
 * **A correction inserts.** `russell_conversation_context` is append-only.
 * Re-attaching a thread writes a new row and leaves the old one saying what
 * Russell thought and why, which is what makes a later equivalent conversation
 * routable against the fact that a person disagreed here before. Overwriting
 * would make correction indistinguishable from obedience.
 *
 * **Legacy messages are read, never moved.** A pre-12A `conversations` row is
 * adopted by linking it, and `listTurns` unions its `messages` with
 * `russell_messages` in time order. Copying them into a new table would have
 * been simpler to query and would have produced a second copy of the project's
 * own history — and the copy is always the one that drifts.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  AttachmentSource,
  RussellConversation,
  RussellConversationContext,
  RussellConversationContextRow,
  RussellConversationRow,
  RussellMessage,
  RussellMessageRole,
  RussellMessageRow,
  RussellMessageState,
  RussellVisibility,
} from '../domain/types.ts';

function mapConversation(row: RussellConversationRow): RussellConversation {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    title: row.title,
    visibility: row.visibility as RussellVisibility,
    attachmentConfidence: row.attachment_confidence,
    attachmentSource: row.attachment_source as AttachmentSource,
    grounding: parseJson<Record<string, unknown>>(row.grounding, {}),
    legacyConversationId: row.legacy_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContext(row: RussellConversationContextRow): RussellConversationContext {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    source: row.source as AttachmentSource,
    confidence: row.confidence,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

function mapMessage(row: RussellMessageRow): RussellMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as RussellMessageRole,
    authorUserId: row.author_user_id,
    content: row.content,
    status: row.status as RussellMessageState,
    pendingReason: row.pending_reason,
    produced: parseJson<Record<string, unknown>>(row.produced, {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    answersMessageId: row.answers_message_id ?? null,
    // Postgres hands an integer back as a number and SQLite as a number too,
    // but a driver that ever produced a string here would silently break the
    // arithmetic the ceiling depends on. Normalised once, in the one place the
    // two representations meet.
    attempt: row.attempt === null || row.attempt === undefined ? null : Number(row.attempt),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function createConversation(input: {
  ownerUserId: string;
  title: string;
  projectId?: string | null;
  visibility?: RussellVisibility;
  legacyConversationId?: string | null;
}): Promise<RussellConversation> {
  const id = newId('rcv');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_conversations
       (id, owner_user_id, project_id, title, visibility, attachment_confidence,
        attachment_source, grounding, legacy_conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'NONE', '{}', ?, ?, ?)`,
    [
      id,
      input.ownerUserId,
      input.projectId ?? null,
      input.title,
      input.visibility ?? 'PRIVATE',
      input.legacyConversationId ?? null,
      at,
      at,
    ],
  );
  const created = await getConversation(id);
  if (!created) throw new Error('The conversation disappeared immediately after being written.');
  return created;
}

export async function getConversation(id: string): Promise<RussellConversation | null> {
  const rows = await getDb().all<RussellConversationRow>(
    'SELECT * FROM russell_conversations WHERE id = ?',
    [id],
  );
  return rows[0] ? mapConversation(rows[0]) : null;
}

/**
 * The threads one person may see.
 *
 * Scoped by owner rather than filtered afterwards. A listing that fetched
 * everything and then removed rows is one forgotten `.filter()` from being a
 * disclosure, and the count alone is information.
 */
export async function listConversationsForOwner(
  ownerUserId: string,
  limit = 50,
): Promise<RussellConversation[]> {
  const rows = await getDb().all<RussellConversationRow>(
    `SELECT * FROM russell_conversations
      WHERE owner_user_id = ?
      ORDER BY updated_at DESC
      LIMIT ?`,
    [ownerUserId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(mapConversation);
}

/** The shared threads of one project. PRIVATE threads never appear here. */
export async function listSharedConversations(
  projectId: string,
  limit = 50,
): Promise<RussellConversation[]> {
  const rows = await getDb().all<RussellConversationRow>(
    `SELECT * FROM russell_conversations
      WHERE project_id = ? AND visibility = 'SHARED'
      ORDER BY updated_at DESC
      LIMIT ?`,
    [projectId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(mapConversation);
}

/**
 * How many threads about this project a given person may see.
 *
 * A count, and counts leak. The site card in the Ideas map shows this, so it is
 * scoped exactly the way a listing would be: every shared thread on the
 * project, plus the viewer's own private ones, and nobody else's. A total that
 * included other people's private threads would disclose that they exist, which
 * is the same disclosure §24 refuses to make one thread at a time.
 */
export async function countVisibleConversationsForProject(
  projectId: string,
  viewerUserId: string,
): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM russell_conversations
      WHERE project_id = ?
        AND (visibility = 'SHARED' OR owner_user_id = ?)`,
    [projectId, viewerUserId],
  );
  return Number(row?.n ?? 0);
}

/**
 * Attach, re-attach or detach a thread — and record why.
 *
 * Two writes, always both: the current attachment on the conversation, and an
 * append to the history. The history row is what a later route reads, so a
 * caller that updated only the first would leave Russell unable to learn from
 * the correction it had just been given.
 */
export async function attachConversation(input: {
  conversationId: string;
  projectId: string | null;
  source: AttachmentSource;
  confidence: number | null;
  reason: string;
  actorUserId?: string | null;
}): Promise<RussellConversationContext> {
  const at = nowIso();
  await getDb().run(
    `UPDATE russell_conversations
        SET project_id = ?, attachment_source = ?, attachment_confidence = ?, updated_at = ?
      WHERE id = ?`,
    [input.projectId, input.source, input.confidence, at, input.conversationId],
  );
  const id = newId('rcx');
  await getDb().run(
    `INSERT INTO russell_conversation_context
       (id, conversation_id, project_id, source, confidence, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.conversationId,
      input.projectId,
      input.source,
      input.confidence,
      input.reason,
      input.actorUserId ?? null,
      at,
    ],
  );
  const rows = await getDb().all<RussellConversationContextRow>(
    'SELECT * FROM russell_conversation_context WHERE id = ?',
    [id],
  );
  return mapContext(rows[0]!);
}

export async function listContextHistory(
  conversationId: string,
): Promise<RussellConversationContext[]> {
  const rows = await getDb().all<RussellConversationContextRow>(
    `SELECT * FROM russell_conversation_context
      WHERE conversation_id = ?
      ORDER BY created_at, rowid`,
    [conversationId],
  );
  return rows.map(mapContext);
}

/**
 * Every correction a person has ever made, across their threads.
 *
 * This is the evidence a later route is judged against. It reads only `USER`
 * rows, because an automatic attachment agreeing with itself is not evidence of
 * anything.
 */
export async function listCorrections(
  ownerUserId: string,
  limit = 200,
): Promise<RussellConversationContext[]> {
  const rows = await getDb().all<RussellConversationContextRow>(
    `SELECT c.* FROM russell_conversation_context c
       JOIN russell_conversations v ON v.id = c.conversation_id
      WHERE v.owner_user_id = ? AND c.source = 'USER'
      ORDER BY c.created_at DESC
      LIMIT ?`,
    [ownerUserId, Math.min(1000, Math.max(1, limit))],
  );
  return rows.map(mapContext);
}

export async function setVisibility(
  conversationId: string,
  visibility: RussellVisibility,
): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE russell_conversations SET visibility = ?, updated_at = ? WHERE id = ?',
    [visibility, nowIso(), conversationId],
  );
  return result.changes === 1;
}

export async function setGrounding(
  conversationId: string,
  grounding: Record<string, unknown>,
): Promise<void> {
  await getDb().run(
    'UPDATE russell_conversations SET grounding = ?, updated_at = ? WHERE id = ?',
    [toJson(grounding), nowIso(), conversationId],
  );
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export async function addMessage(input: {
  conversationId: string;
  role: RussellMessageRole;
  content: string;
  authorUserId?: string | null;
  status?: RussellMessageState;
  pendingReason?: string | null;
  produced?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<RussellMessage> {
  const status = input.status ?? 'COMPLETE';
  if (status === 'PENDING' && !input.pendingReason) {
    // The CHECK constraint enforces this too. Refusing here as well means the
    // caller gets a sentence rather than a constraint violation, and the rule
    // is stated where somebody writing a new caller will read it: a turn that
    // is waiting must say what it is waiting for.
    throw new Error('A pending turn must carry the reason it is pending.');
  }
  const id = newId('rmsg');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_messages
       (id, conversation_id, role, author_user_id, content, status, pending_reason,
        produced, metadata, answers_message_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      input.conversationId,
      input.role,
      input.authorUserId ?? null,
      input.content,
      status,
      input.pendingReason ?? null,
      toJson(input.produced ?? {}),
      toJson(input.metadata ?? {}),
      at,
      at,
    ],
  );
  await getDb().run('UPDATE russell_conversations SET updated_at = ? WHERE id = ?', [
    at,
    input.conversationId,
  ]);
  const rows = await getDb().all<RussellMessageRow>('SELECT * FROM russell_messages WHERE id = ?', [
    id,
  ]);
  return mapMessage(rows[0]!);
}

/**
 * Claim the next attempt at one question, or lose the race.
 *
 * The retry path used to count the attempts already made and then insert the
 * next one. Read, then write, with a window between: two callers both counted
 * one attempt and both created attempt 2 — two pending turns, two bins, two
 * activations against a fixed allowance for a single question. The test that
 * found it is in `tests/turnRetry.test.ts`, and it failed against the code as
 * first written rather than being written to pass.
 *
 * So the arbiter is `UNIQUE (answers_message_id, attempt)` and this is an
 * `INSERT ... ON CONFLICT DO NOTHING`. The caller supplies which question it is
 * answering and which attempt number it believes is next; the index decides
 * whether it was right. A loser gets `null`, which is an ordinary outcome and
 * not an error — the same shape as a lost queue claim or a lost fire slot.
 *
 * It is deliberately not `addMessage` with two more parameters. `addMessage`
 * writes NULL into both columns for every ordinary turn, and a function that
 * could be called either way is one somebody eventually calls the wrong way;
 * the ceiling and the no-duplicates rule both live on this path only.
 */
export async function claimTurnAttempt(input: {
  conversationId: string;
  /** The person's message this attempt is at. */
  answersMessageId: string;
  /** Which attempt this is, counting the original as 1. */
  attempt: number;
  pendingReason: string;
  metadata?: Record<string, unknown>;
}): Promise<RussellMessage | null> {
  const id = newId('rmsg');
  const at = nowIso();
  const result = await getDb().run(
    `INSERT INTO russell_messages
       (id, conversation_id, role, author_user_id, content, status, pending_reason,
        produced, metadata, answers_message_id, attempt, created_at, updated_at)
     VALUES (?, ?, 'RUSSELL', NULL, '', 'PENDING', ?, '{}', ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.conversationId,
      input.pendingReason,
      toJson(input.metadata ?? {}),
      input.answersMessageId,
      input.attempt,
      at,
      at,
    ],
  );
  if (result.changes !== 1) return null;
  await getDb().run('UPDATE russell_conversations SET updated_at = ? WHERE id = ?', [
    at,
    input.conversationId,
  ]);
  const rows = await getDb().all<RussellMessageRow>('SELECT * FROM russell_messages WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapMessage(rows[0]) : null;
}

/** Every attempt at one question, oldest first. The original is not among them. */
export async function listTurnAttempts(answersMessageId: string): Promise<RussellMessage[]> {
  const rows = await getDb().all<RussellMessageRow>(
    `SELECT * FROM russell_messages
      WHERE answers_message_id = ?
      ORDER BY attempt, rowid`,
    [answersMessageId],
  );
  return rows.map(mapMessage);
}

/**
 * Finish a pending turn, exactly once.
 *
 * Guarded on the turn still being `PENDING`, so a provider that answers twice —
 * or a retry racing a late first response — settles it once and the second
 * caller is told nothing changed. Without the guard a duplicated delivery would
 * overwrite the answer a person may already have read.
 */
export async function resolveMessage(input: {
  messageId: string;
  content: string;
  produced?: Record<string, unknown>;
  status?: Extract<RussellMessageState, 'COMPLETE' | 'FAILED'>;
  pendingReason?: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_messages
        SET content = ?, status = ?, pending_reason = ?, produced = ?, updated_at = ?
      WHERE id = ? AND status = 'PENDING'`,
    [
      input.content,
      input.status ?? 'COMPLETE',
      input.pendingReason ?? null,
      toJson(input.produced ?? {}),
      nowIso(),
      input.messageId,
    ],
  );
  return result.changes === 1;
}

/**
 * Attach what a resolved turn produced.
 *
 * Separate from `resolveMessage` because the claim has to happen *before* the
 * effect — the resolve is the once-only guard — so what the effect produced is
 * only known afterwards. Guarded on the turn being settled, so this can never
 * be the thing that ends a turn.
 */
export async function recordProduced(
  messageId: string,
  produced: Record<string, unknown>,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_messages SET produced = ?, updated_at = ?
      WHERE id = ? AND status <> 'PENDING'`,
    [toJson(produced), nowIso(), messageId],
  );
  return result.changes === 1;
}

export async function getMessage(id: string): Promise<RussellMessage | null> {
  const rows = await getDb().all<RussellMessageRow>('SELECT * FROM russell_messages WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapMessage(rows[0]) : null;
}

export async function listPendingMessages(limit = 50): Promise<RussellMessage[]> {
  const rows = await getDb().all<RussellMessageRow>(
    `SELECT * FROM russell_messages WHERE status = 'PENDING' ORDER BY created_at, rowid LIMIT ?`,
    [Math.min(500, Math.max(1, limit))],
  );
  return rows.map(mapMessage);
}

/**
 * The whole thread, legacy turns included.
 *
 * Two queries and a merge rather than one `UNION`, because the two message
 * tables genuinely differ — the legacy one has no author, status or produced
 * links — and a `UNION` would have to invent values for those columns. Inventing
 * an author is worse than admitting there is not one, so a legacy turn arrives
 * flagged `legacy: true` with `authorUserId: null` and the UI can say so.
 */
export async function listTurns(
  conversationId: string,
  limit = 500,
): Promise<RussellMessage[]> {
  const capped = Math.min(2000, Math.max(1, limit));
  const conversation = await getConversation(conversationId);
  if (!conversation) return [];

  const mine = (
    await getDb().all<RussellMessageRow>(
      `SELECT * FROM russell_messages
        WHERE conversation_id = ?
        ORDER BY created_at, rowid
        LIMIT ?`,
      [conversationId, capped],
    )
  ).map(mapMessage);

  if (!conversation.legacyConversationId) return mine;

  const legacy = (
    await getDb().all<{
      id: string;
      role: string;
      content: string;
      metadata: string;
      created_at: string;
    }>(
      `SELECT id, role, content, metadata, created_at FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at, rowid
        LIMIT ?`,
      [conversation.legacyConversationId, capped],
    )
  ).map((row): RussellMessage => ({
    id: row.id,
    conversationId,
    // The legacy vocabulary is `user` / `assistant` / `system`. Mapped, not
    // rewritten: the stored row keeps saying what it always said.
    role: row.role.toUpperCase() === 'USER' ? 'USER' : row.role.toUpperCase() === 'SYSTEM' ? 'SYSTEM' : 'RUSSELL',
    authorUserId: null,
    content: row.content,
    status: 'COMPLETE',
    pendingReason: null,
    produced: {},
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    // A legacy turn predates retries entirely, so it is a first attempt with
    // nothing to record — the same reading as every row written before the
    // columns existed. Inventing an attempt number for it would be worse than
    // admitting there is not one.
    answersMessageId: null,
    attempt: null,
    createdAt: row.created_at,
    updatedAt: row.created_at,
    legacy: true,
  }));

  return [...legacy, ...mine]
    .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, capped);
}

/**
 * Give every pre-12A conversation a Russell thread, once.
 *
 * Idempotent by `legacy_conversation_id`, which is unique, so running it twice
 * adopts nothing twice. It copies no messages and rewrites no rows: the old
 * transcript stays exactly where it is and becomes readable through Russell as
 * authorized provenance, which is the whole point — a shell that only
 * understood post-12A messages would have thrown away the project's history to
 * gain a tidier schema.
 */
export async function adoptLegacyConversations(ownerUserId: string): Promise<number> {
  const rows = await getDb().all<{
    id: string;
    project_id: string;
    title: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT c.id, c.project_id, c.title, c.created_at, c.updated_at
       FROM conversations c
       LEFT JOIN russell_conversations r ON r.legacy_conversation_id = c.id
      WHERE r.id IS NULL
      ORDER BY c.created_at, c.rowid`,
  );

  let adopted = 0;
  for (const row of rows) {
    await getDb().run(
      `INSERT INTO russell_conversations
         (id, owner_user_id, project_id, title, visibility, attachment_confidence,
          attachment_source, grounding, legacy_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'SHARED', 100, 'MIGRATED', '{}', ?, ?, ?)`,
      [newId('rcv'), ownerUserId, row.project_id, row.title, row.id, row.created_at, row.updated_at],
    );
    adopted += 1;
  }
  return adopted;
}
