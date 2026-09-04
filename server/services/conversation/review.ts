/**
 * The teacher loop: what a stronger reader makes of a fast answer.
 *
 * A fast model is allowed to be wrong in the way a person talking quickly is
 * allowed to be wrong — provided something checks, and provided the check
 * cannot silently become policy. Both halves are here.
 *
 * **A review reads a manifest, not a conversation.** The manifest names the
 * exact messages, inherits the conversation's most restrictive visibility, and
 * carries the human and project scope a reviewer must already be authorized
 * for. Handing a private transcript to whichever surface has capacity is the
 * disclosure the conversation boundary exists to prevent, and spare capacity is
 * not a reason to widen it — least of all onto somebody else's account.
 *
 * **A lesson becomes a proposal.** One reviewer deciding that Russell should
 * behave differently from now on is a proposal, and it stays `PROPOSED` until a
 * person accepts it. A reviewer that could promote its own rule would be a
 * model writing policy, which is §8 at a new altitude.
 *
 * **Reviews are debounced by conversation version.** At most one pending review
 * per version, enforced by a unique index rather than by a timer, so a busy
 * conversation cannot fire a Routine after every reply — which would recreate
 * the latency problem the fast lane exists to solve, and pay for it twice.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { getConversation, listTurns } from '../../repos/russellConversations.ts';

export const REVIEW_CLASSIFICATIONS = [
  'PASS',
  'CORRECT',
  'RESEARCH',
  'PLAN',
  'CAPTURE',
  'IGNORE',
] as const;
export type ReviewClassification = (typeof REVIEW_CLASSIFICATIONS)[number];

export type ReviewState = 'PENDING' | 'RUNNING' | 'DONE' | 'REFUSED';

export interface ConversationReview {
  id: string;
  conversationId: string;
  conversationVersion: number;
  /** The message ids the reviewer may see. Never "the conversation". */
  manifest: string[];
  visibility: 'PRIVATE' | 'SHARED';
  ownerUserId: string;
  projectId: string | null;
  state: ReviewState;
  classification: ReviewClassification | null;
  findings: string[];
  reviewerNote: string | null;
  requestedBy: 'AUTOMATIC' | 'USER';
}

interface ReviewRow {
  id: string;
  conversation_id: string;
  conversation_version: number;
  manifest: string;
  visibility: string;
  owner_user_id: string;
  project_id: string | null;
  state: string;
  classification: string | null;
  findings: string;
  reviewer_note: string | null;
  requested_by: string;
}

function mapReview(row: ReviewRow): ConversationReview {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    conversationVersion: Number(row.conversation_version),
    manifest: parseJson<string[]>(row.manifest, []),
    visibility: row.visibility === 'SHARED' ? 'SHARED' : 'PRIVATE',
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    state: row.state as ReviewState,
    classification: row.classification as ReviewClassification | null,
    findings: parseJson<string[]>(row.findings, []),
    reviewerNote: row.reviewer_note,
    requestedBy: row.requested_by === 'USER' ? 'USER' : 'AUTOMATIC',
  };
}

export type QueueOutcome =
  | { ok: true; review: ConversationReview; created: boolean }
  | { ok: false; reason: string };

/**
 * Queue at most one review of this conversation at this version.
 *
 * The version is the turn count, which is what actually changes when there is
 * something new to review. Two callers racing on the same version collide on
 * the unique index, and the loser reads the winner's row — the same
 * insert-and-read shape every idempotent path in this codebase uses.
 *
 * `deep` — a person asking for it explicitly — is allowed to queue a second
 * review at a version that already has one only by being a different request:
 * it is not, and it does not. A person who asks twice gets the one review that
 * already exists, which is the honest answer.
 */
export async function queueReview(input: {
  conversationId: string;
  /** The turns to review. Compiled by the caller, bounded, and purpose-bound. */
  messageIds: string[];
  requestedBy?: 'AUTOMATIC' | 'USER';
  at?: string;
}): Promise<QueueOutcome> {
  const at = input.at ?? nowIso();
  const conversation = await getConversation(input.conversationId);
  if (!conversation) return { ok: false, reason: 'there is no such conversation' };
  if (input.messageIds.length === 0) {
    return { ok: false, reason: 'a review with no turns in it would review nothing' };
  }

  const turns = await listTurns(conversation.id, 500);
  const known = new Set(turns.map((turn) => turn.id));
  // A manifest may only name messages that are actually in this conversation.
  // Otherwise "the turns to review" becomes an arbitrary id list, and a
  // reviewer's scope becomes whatever the caller wrote down.
  if (input.messageIds.some((id) => !known.has(id))) {
    return { ok: false, reason: 'a manifest may only name turns from its own conversation' };
  }

  const version = turns.length;
  const id = newId('rvw');
  await getDb().run(
    `INSERT INTO conversation_reviews
       (id, conversation_id, conversation_version, manifest, visibility, owner_user_id,
        project_id, state, classification, findings, reviewer_note, bin_id, requested_by,
        created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, '[]', NULL, NULL, ?, ?, ?, NULL)
     ON CONFLICT (conversation_id, conversation_version) DO NOTHING`,
    [
      id,
      conversation.id,
      version,
      toJson(input.messageIds),
      // Inherited, never chosen. A review of a private thread is private.
      conversation.visibility,
      conversation.ownerUserId,
      conversation.projectId,
      input.requestedBy ?? 'AUTOMATIC',
      at,
      at,
    ],
  );
  const rows = await getDb().all<ReviewRow>(
    'SELECT * FROM conversation_reviews WHERE conversation_id = ? AND conversation_version = ?',
    [conversation.id, version],
  );
  if (!rows[0]) throw new Error('The review disappeared immediately after being written.');
  return { ok: true, review: mapReview(rows[0]), created: rows[0].id === id };
}

export async function getReview(id: string): Promise<ConversationReview | null> {
  const rows = await getDb().all<ReviewRow>('SELECT * FROM conversation_reviews WHERE id = ?', [id]);
  return rows[0] ? mapReview(rows[0]) : null;
}

export async function listPendingReviews(limit = 50): Promise<ConversationReview[]> {
  const rows = await getDb().all<ReviewRow>(
    `SELECT * FROM conversation_reviews WHERE state = 'PENDING'
      ORDER BY created_at, rowid LIMIT ?`,
    [Math.min(200, Math.max(1, limit))],
  );
  return rows.map(mapReview);
}

/**
 * Whether a surface may carry this review.
 *
 * A pure function over the review and the surface's own scope, so the answer
 * does not depend on who is asking. A private thread may only be reviewed by a
 * surface bound to that person; a shared one additionally needs the project.
 *
 * "This account has spare capacity" is not in the signature, and that is
 * deliberate: capacity is a scheduling fact and this is an authorization
 * question, and the moment they meet in one function the cheap one wins.
 */
export function reviewerMayCarry(
  review: ConversationReview,
  surface: { forUserId: string | null; forProjectIds: readonly string[] },
): { allowed: boolean; reason: string } {
  if (review.visibility === 'PRIVATE') {
    return surface.forUserId === review.ownerUserId
      ? { allowed: true, reason: 'the surface belongs to the person whose thread this is' }
      : { allowed: false, reason: 'a private thread may only be reviewed for its own owner' };
  }
  if (!review.projectId) {
    return { allowed: false, reason: 'a shared review with no project has no scope to check' };
  }
  return surface.forProjectIds.includes(review.projectId)
    ? { allowed: true, reason: 'the surface is authorized for this project' }
    : { allowed: false, reason: 'the surface is not authorized for this project' };
}

/** Record what the reviewer concluded. Validated, never trusted as prose. */
export async function completeReview(input: {
  reviewId: string;
  classification: ReviewClassification;
  findings: string[];
  note?: string | null;
  at?: string;
}): Promise<boolean> {
  if (!REVIEW_CLASSIFICATIONS.includes(input.classification)) return false;
  const at = input.at ?? nowIso();
  const result = await getDb().run(
    `UPDATE conversation_reviews
        SET state = 'DONE', classification = ?, findings = ?, reviewer_note = ?,
            updated_at = ?, completed_at = ?
      WHERE id = ? AND state IN ('PENDING','RUNNING')`,
    [input.classification, toJson(input.findings), input.note ?? null, at, at, input.reviewId],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleState = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';

export interface RussellRule {
  id: string;
  scope: 'GLOBAL' | 'PROJECT' | 'CONVERSATION';
  scopeId: string | null;
  statement: string;
  rationale: string;
  state: RuleState;
  version: number;
  reviewId: string | null;
  proposedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
}

interface RuleRow {
  id: string;
  scope: string;
  scope_id: string | null;
  statement: string;
  rationale: string;
  state: string;
  version: number;
  review_id: string | null;
  proposed_by: string;
  decided_by: string | null;
  decision_note: string | null;
}

function mapRule(row: RuleRow): RussellRule {
  return {
    id: row.id,
    scope: row.scope as RussellRule['scope'],
    scopeId: row.scope_id,
    statement: row.statement,
    rationale: row.rationale,
    state: row.state as RuleState,
    version: Number(row.version),
    reviewId: row.review_id,
    proposedBy: row.proposed_by,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
  };
}

/**
 * Propose a rule. Always `PROPOSED`, with no argument that changes that.
 *
 * There is deliberately no `state` parameter. A caller that could create an
 * accepted rule is a caller that could make a reviewer's opinion permanent, and
 * the whole point of this table is that it cannot.
 */
export async function proposeRule(input: {
  scope: RussellRule['scope'];
  scopeId?: string | null;
  statement: string;
  rationale: string;
  reviewId?: string | null;
  proposedBy: string;
  at?: string;
}): Promise<RussellRule> {
  const id = newId('rul');
  const at = input.at ?? nowIso();
  await getDb().run(
    `INSERT INTO russell_rules
       (id, scope, scope_id, statement, rationale, state, version, supersedes_id,
        review_id, proposed_by, decided_by, decided_at, decision_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PROPOSED', 1, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      id,
      input.scope,
      input.scopeId ?? null,
      input.statement,
      input.rationale,
      input.reviewId ?? null,
      input.proposedBy,
      at,
      at,
    ],
  );
  return (await getRule(id))!;
}

export async function getRule(id: string): Promise<RussellRule | null> {
  const rows = await getDb().all<RuleRow>('SELECT * FROM russell_rules WHERE id = ?', [id]);
  return rows[0] ? mapRule(rows[0]) : null;
}

/**
 * A person accepts or rejects a proposal.
 *
 * A guarded `UPDATE` on `PROPOSED`, so a double submission decides once, and
 * `decided_by` is the authenticated person rather than anything in a body. The
 * table's CHECK refuses a decided rule with no decider, so an anonymous
 * acceptance is impossible rather than merely discouraged.
 */
export async function decideRule(input: {
  ruleId: string;
  accept: boolean;
  decidedByUserId: string;
  note?: string | null;
  at?: string;
}): Promise<boolean> {
  const at = input.at ?? nowIso();
  const result = await getDb().run(
    `UPDATE russell_rules
        SET state = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
      WHERE id = ? AND state = 'PROPOSED'`,
    [
      input.accept ? 'ACCEPTED' : 'REJECTED',
      input.decidedByUserId,
      at,
      input.note ?? null,
      at,
      input.ruleId,
    ],
  );
  return result.changes > 0;
}

/**
 * The rules that actually apply, for the context hat.
 *
 * Accepted only. A proposed rule is a suggestion nobody has agreed to, and
 * feeding it to the model would make the proposal effective without the
 * decision — which is the loophole this whole mechanism exists to close.
 */
export async function standingInstructions(input: {
  projectId?: string | null;
  conversationId?: string | null;
}): Promise<string[]> {
  const rows = await getDb().all<RuleRow>(
    `SELECT * FROM russell_rules
      WHERE state = 'ACCEPTED'
        AND (scope = 'GLOBAL'
             OR (scope = 'PROJECT' AND scope_id = ?)
             OR (scope = 'CONVERSATION' AND scope_id = ?))
      ORDER BY created_at`,
    [input.projectId ?? '', input.conversationId ?? ''],
  );
  return rows.map((row) => row.statement);
}
