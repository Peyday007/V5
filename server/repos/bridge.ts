/**
 * The conversation entrance's rows.
 *
 * Three things live here and each one is the answer to a property the bridge
 * has to keep:
 *
 *   * **`bridge_credentials`** — a person's bearer. Digest-stored, found by an
 *     indexed prefix and compared in constant time, which is the shape
 *     `worker_credentials`, `worker_invitations`, the project invitation and
 *     the passkey enrollment all already have. It is the fifth door in this
 *     Brain built that way, and none of them stores a secret.
 *   * **`bridge_conversations` / `bridge_messages`** — what was actually said,
 *     in the order it was said, with edits kept beside what they replaced.
 *   * **`bridge_sync_receipts`** — what one synchronization did, keyed so that
 *     a client which lost the reply is told the same thing rather than
 *     performing the delivery twice.
 *
 * The one rule this module enforces by itself is **exactness**: nothing here
 * trims, normalizes, re-wraps or re-encodes content. A transcript that was
 * tidied on the way in is not the transcript, and the hash stored beside each
 * message is over the bytes as they arrived.
 */
import crypto from 'node:crypto';
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import { constantTimeEquals, digestSecret } from '../services/identity/secrets.ts';
import type {
  BridgeConversation,
  BridgeConversationRow,
  BridgeCredential,
  BridgeCredentialRow,
  BridgeMessage,
  BridgeMessageRow,
  BridgeReceipt,
  BridgeReceiptRow,
  BridgeRole,
  BridgeRouting,
  BridgeSource,
} from '../domain/register.ts';

/** The hash stored beside every message. Over the bytes exactly as they came. */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// CREDENTIALS
// ---------------------------------------------------------------------------

function mapCredential(row: BridgeCredentialRow): BridgeCredential {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    prefix: row.prefix,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at,
  };
}

export async function insertBridgeCredential(input: {
  userId: string;
  label: string;
  prefix: string;
  verifier: string;
  expiresAt: string | null;
}): Promise<BridgeCredential> {
  const id = newId('bcr');
  await getDb().run(
    `INSERT INTO bridge_credentials (id, user_id, label, prefix, verifier, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.label, input.prefix, input.verifier, nowIso(), input.expiresAt],
  );
  const row = await getDb().get<BridgeCredentialRow>(
    `SELECT * FROM bridge_credentials WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error('The credential was written and could not be read back.');
  return mapCredential(row);
}

/**
 * Resolve a presented credential, or nothing.
 *
 * Unknown prefix, wrong secret, revoked and expired are **one answer** here, so
 * a caller cannot build a different refusal out of them. The prefix lookup says
 * which row; the constant-time comparison decides whether the holder has the
 * secret half and takes the same time however wrong they are.
 */
export async function resolveBridgeCredential(
  prefix: string,
  secret: string,
): Promise<BridgeCredential | null> {
  const row = await getDb().get<BridgeCredentialRow>(
    `SELECT * FROM bridge_credentials WHERE prefix = ?`,
    [prefix],
  );
  if (!row) return null;
  if (!constantTimeEquals(digestSecret(secret), row.verifier)) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= nowIso()) return null;
  return mapCredential(row);
}

/** Best effort, and deliberately not transactional with the request. */
export async function markBridgeCredentialUsed(id: string): Promise<void> {
  await getDb().run(`UPDATE bridge_credentials SET last_used_at = ? WHERE id = ?`, [nowIso(), id]);
}

export async function listBridgeCredentials(userId: string): Promise<BridgeCredential[]> {
  const rows = await getDb().all<BridgeCredentialRow>(
    `SELECT * FROM bridge_credentials WHERE user_id = ? ORDER BY issued_at DESC, id DESC`,
    [userId],
  );
  return rows.map(mapCredential);
}

/**
 * Give one back.
 *
 * Guarded on it still being live, so two revocations produce one and the loser
 * is an ordinary outcome. Revoked rows stay with their reason: §5 applies to a
 * credential as much as to a run, and a deleted one answers nothing later.
 */
export async function revokeBridgeCredential(
  id: string,
  userId: string,
  reason: string,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE bridge_credentials SET revoked_at = ?, revoked_reason = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [nowIso(), reason, id, userId],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// CONVERSATIONS
// ---------------------------------------------------------------------------

function mapConversation(row: BridgeConversationRow): BridgeConversation {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    source: row.source as BridgeSource,
    externalId: row.external_id,
    title: row.title,
    russellConversationId: row.russell_conversation_id,
    highestOrdinal: row.highest_ordinal,
    messageCount: row.message_count,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findBridgeConversation(input: {
  ownerUserId: string;
  source: BridgeSource;
  externalId: string;
}): Promise<BridgeConversation | null> {
  const row = await getDb().get<BridgeConversationRow>(
    `SELECT * FROM bridge_conversations
      WHERE owner_user_id = ? AND source = ? AND external_id = ?`,
    [input.ownerUserId, input.source, input.externalId],
  );
  return row ? mapConversation(row) : null;
}

export async function getBridgeConversation(id: string): Promise<BridgeConversation | null> {
  const row = await getDb().get<BridgeConversationRow>(
    `SELECT * FROM bridge_conversations WHERE id = ?`,
    [id],
  );
  return row ? mapConversation(row) : null;
}

export async function getBridgeConversationByRussell(
  russellConversationId: string,
): Promise<BridgeConversation | null> {
  const row = await getDb().get<BridgeConversationRow>(
    `SELECT * FROM bridge_conversations WHERE russell_conversation_id = ?`,
    [russellConversationId],
  );
  return row ? mapConversation(row) : null;
}

export async function insertBridgeConversation(input: {
  ownerUserId: string;
  source: BridgeSource;
  externalId: string;
  title: string;
  russellConversationId: string;
}): Promise<BridgeConversation> {
  const id = newId('bcv');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO bridge_conversations
       (id, owner_user_id, source, external_id, title, russell_conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.ownerUserId, input.source, input.externalId, input.title, input.russellConversationId, at, at],
  );
  const created = await getBridgeConversation(id);
  if (!created) throw new Error('The conversation was written and could not be read back.');
  return created;
}

export async function listBridgeConversations(ownerUserId: string): Promise<BridgeConversation[]> {
  const rows = await getDb().all<BridgeConversationRow>(
    `SELECT * FROM bridge_conversations
      WHERE owner_user_id = ?
      ORDER BY updated_at DESC, id DESC`,
    [ownerUserId],
  );
  return rows.map(mapConversation);
}

/**
 * Re-count after a synchronization.
 *
 * Derived from the rows rather than incremented, because an increment is a
 * second copy of a fact the messages already carry — and the second copy is the
 * one nobody reconciles. It costs one aggregate per sync and cannot drift.
 */
export async function refreshBridgeConversation(id: string, title?: string): Promise<BridgeConversation | null> {
  const totals = await getDb().get<{ live: number; top: number | null }>(
    `SELECT COUNT(*) AS live, MAX(ordinal) AS top
       FROM bridge_messages
      WHERE conversation_id = ? AND superseded_at IS NULL`,
    [id],
  );
  const at = nowIso();
  await getDb().run(
    `UPDATE bridge_conversations
        SET message_count = ?, highest_ordinal = ?, last_sync_at = ?, updated_at = ?
            ${title === undefined ? '' : ', title = ?'}
      WHERE id = ?`,
    title === undefined
      ? [totals?.live ?? 0, totals?.top ?? -1, at, at, id]
      : [totals?.live ?? 0, totals?.top ?? -1, at, at, title, id],
  );
  return await getBridgeConversation(id);
}

// ---------------------------------------------------------------------------
// MESSAGES
// ---------------------------------------------------------------------------

function mapMessage(row: BridgeMessageRow): BridgeMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    revision: row.revision,
    externalId: row.external_id,
    role: row.role as BridgeRole,
    authorLabel: row.author_label,
    content: row.content,
    contentHash: row.content_hash,
    saidAt: row.said_at,
    receivedAt: row.received_at,
    supersededAt: row.superseded_at,
    branchNote: row.branch_note,
  };
}

/** Every revision at one position, newest revision last. */
export async function revisionsAt(conversationId: string, ordinal: number): Promise<BridgeMessage[]> {
  const rows = await getDb().all<BridgeMessageRow>(
    `SELECT * FROM bridge_messages
      WHERE conversation_id = ? AND ordinal = ?
      ORDER BY revision`,
    [conversationId, ordinal],
  );
  return rows.map(mapMessage);
}

export async function insertBridgeMessage(input: {
  conversationId: string;
  ordinal: number;
  revision: number;
  externalId: string | null;
  role: BridgeRole;
  authorLabel: string | null;
  content: string;
  saidAt: string | null;
  branchNote: string | null;
}): Promise<BridgeMessage> {
  const id = newId('bms');
  await getDb().run(
    `INSERT INTO bridge_messages
       (id, conversation_id, ordinal, revision, external_id, role, author_label,
        content, content_hash, said_at, received_at, branch_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.conversationId,
      input.ordinal,
      input.revision,
      input.externalId,
      input.role,
      input.authorLabel,
      input.content,
      hashContent(input.content),
      input.saidAt,
      nowIso(),
      input.branchNote,
    ],
  );
  const row = await getDb().get<BridgeMessageRow>(`SELECT * FROM bridge_messages WHERE id = ?`, [id]);
  if (!row) throw new Error('The message was written and could not be read back.');
  return mapMessage(row);
}

/** An edit supersedes what it replaced and never deletes it. */
export async function supersedeBridgeMessage(id: string): Promise<void> {
  await getDb().run(
    `UPDATE bridge_messages SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`,
    [nowIso(), id],
  );
}

/**
 * The transcript as it currently reads.
 *
 * Live revisions only, in the transcript's own order. Ordered by `ordinal` with
 * `revision` as the tiebreak — an ordering **both dialects can say**, which
 * §27 records as the difference between a suite passing and production
 * throwing.
 */
export async function listBridgeMessages(
  conversationId: string,
  options?: { includeSuperseded?: boolean; limit?: number },
): Promise<BridgeMessage[]> {
  const rows = await getDb().all<BridgeMessageRow>(
    `SELECT * FROM bridge_messages
      WHERE conversation_id = ?
        ${options?.includeSuperseded ? '' : 'AND superseded_at IS NULL'}
      ORDER BY ordinal, revision`,
    [conversationId],
  );
  const mapped = rows.map(mapMessage);
  return options?.limit === undefined ? mapped : mapped.slice(-options.limit);
}

/** Which positions this Brain has never been given. */
export async function missingOrdinals(conversationId: string): Promise<number[]> {
  const rows = await getDb().all<{ ordinal: number }>(
    `SELECT DISTINCT ordinal FROM bridge_messages
      WHERE conversation_id = ? AND superseded_at IS NULL
      ORDER BY ordinal`,
    [conversationId],
  );
  const present = new Set(rows.map((row) => row.ordinal));
  const top = rows.length ? Math.max(...present) : -1;
  const gaps: number[] = [];
  for (let i = 0; i <= top; i += 1) if (!present.has(i)) gaps.push(i);
  return gaps;
}

// ---------------------------------------------------------------------------
// RECEIPTS
// ---------------------------------------------------------------------------

function mapReceipt(row: BridgeReceiptRow): BridgeReceipt {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requestKey: row.request_key,
    accepted: row.accepted,
    duplicates: row.duplicates,
    revisions: row.revisions,
    branches: row.branches,
    firstOrdinal: row.first_ordinal,
    lastOrdinal: row.last_ordinal,
    missing: parseJson<number[]>(row.missing, []),
    routing: parseJson<BridgeRouting>(row.routing, {
      outcome: 'NOTHING',
      reason: 'no routing was recorded',
    }),
    createdAt: row.created_at,
  };
}

export async function findReceipt(requestKey: string): Promise<BridgeReceipt | null> {
  const row = await getDb().get<BridgeReceiptRow>(
    `SELECT * FROM bridge_sync_receipts WHERE request_key = ?`,
    [requestKey],
  );
  return row ? mapReceipt(row) : null;
}

/**
 * Reserve this delivery, or discover somebody already did.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` and then a read: exactly one caller
 * inserts, and every other equivalent caller reads the row it collided with and
 * replays it. §20's shape, and the reason it is here rather than a check-then-
 * write is that a check leaves a window two deliveries can both pass through.
 */
export async function reserveReceipt(input: {
  conversationId: string;
  requestKey: string;
}): Promise<{ mine: boolean; receipt: BridgeReceipt }> {
  const id = newId('brc');
  const result = await getDb().run(
    `INSERT INTO bridge_sync_receipts (id, conversation_id, request_key, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (request_key) DO NOTHING`,
    [id, input.conversationId, input.requestKey, nowIso()],
  );
  const receipt = await findReceipt(input.requestKey);
  if (!receipt) throw new Error('The receipt was reserved and could not be read back.');
  return { mine: result.changes > 0, receipt };
}

export async function completeReceipt(input: {
  id: string;
  accepted: number;
  duplicates: number;
  revisions: number;
  branches: number;
  firstOrdinal: number | null;
  lastOrdinal: number | null;
  missing: number[];
  routing: BridgeRouting;
}): Promise<BridgeReceipt> {
  await getDb().run(
    `UPDATE bridge_sync_receipts
        SET accepted = ?, duplicates = ?, revisions = ?, branches = ?,
            first_ordinal = ?, last_ordinal = ?, missing = ?, routing = ?
      WHERE id = ?`,
    [
      input.accepted,
      input.duplicates,
      input.revisions,
      input.branches,
      input.firstOrdinal,
      input.lastOrdinal,
      toJson(input.missing),
      toJson(input.routing),
      input.id,
    ],
  );
  const row = await getDb().get<BridgeReceiptRow>(
    `SELECT * FROM bridge_sync_receipts WHERE id = ?`,
    [input.id],
  );
  if (!row) throw new Error('The receipt was completed and could not be read back.');
  return mapReceipt(row);
}
