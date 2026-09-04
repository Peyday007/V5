/**
 * Candidates — Russell's own judgment, stored as state rather than as prose.
 *
 * The reason this table exists at all is that a decision which lives only in a
 * generated sentence cannot be ranked against another decision, cannot be
 * overridden, cannot survive a restart, and cannot be disagreed with a week
 * later. Russell has to be able to say "this should not be built yet, and here
 * is why" and have that outlive the conversation it was said in.
 *
 * Two mechanisms carry most of the weight.
 *
 * **Dedupe is cheap first, then careful.** `claimFingerprint` is a guarded
 * insert on a deterministic key, so two identical asks — including two that
 * arrive at the same moment — resolve to one canonical candidate without any
 * semantic comparison at all. Only what survives that is worth comparing by
 * meaning, and a semantic merge is a *pointer*, never a delete.
 *
 * **A merge is reversible.** `splitCandidate` restores both identities and
 * leaves the merge and the correction on the record. A model's similarity score
 * is a judgement, and a judgement that can permanently erase a valid idea is a
 * judgement with no appeal.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CandidatePriority,
  CandidateState,
  RussellCandidate,
  RussellCandidateMergeRow,
  RussellCandidateRow,
  RussellVisibility,
} from '../domain/types.ts';

function mapCandidate(row: RussellCandidateRow): RussellCandidate {
  return {
    id: row.id,
    projectId: row.project_id,
    visibility: row.visibility as RussellVisibility,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    title: row.title,
    statement: row.statement,
    fingerprint: row.fingerprint,
    state: row.state as CandidateState,
    canonicalCandidateId: row.canonical_candidate_id,
    priority: row.priority as CandidatePriority | null,
    ordinal: row.ordinal,
    confidence: row.confidence,
    reason: row.reason,
    judgment: parseJson<Record<string, unknown>>(row.judgment, {}),
    supporting: parseJson<string[]>(row.supporting, []),
    contradicting: parseJson<string[]>(row.contradicting, []),
    overrideUserId: row.override_user_id,
    overrideReason: row.override_reason,
    overrideAt: row.override_at,
    supersededDecision: row.superseded_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The deterministic duplicate key.
 *
 * Lower-cased, punctuation-stripped, whitespace-collapsed, and sorted-word — so
 * "charge the buyer a fee" and "a fee charged the buyer" collide, and neither
 * needs a model to notice. Cheap keys first is not an optimisation; it is what
 * keeps the expensive comparison rare enough to be affordable.
 */
export function fingerprintOf(statement: string): string {
  const words = statement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  return words.join(' ');
}

export async function createCandidate(input: {
  title: string;
  statement: string;
  projectId?: string | null;
  visibility?: RussellVisibility;
  conversationId?: string | null;
  sourceMessageId?: string | null;
}): Promise<RussellCandidate> {
  const id = newId('rcn');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_candidates
       (id, project_id, visibility, conversation_id, source_message_id, title, statement,
        fingerprint, state, canonical_candidate_id, priority, ordinal, confidence, reason,
        judgment, supporting, contradicting, override_user_id, override_reason, override_at,
        superseded_decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CAPTURED', NULL, NULL, NULL, NULL, NULL,
             '{}', '[]', '[]', NULL, NULL, NULL, NULL, ?, ?)`,
    [
      id,
      input.projectId ?? null,
      input.visibility ?? 'PRIVATE',
      input.conversationId ?? null,
      input.sourceMessageId ?? null,
      input.title,
      input.statement,
      fingerprintOf(input.statement),
      at,
      at,
    ],
  );
  const created = await getCandidate(id);
  if (!created) throw new Error('The candidate disappeared immediately after being written.');
  return created;
}

export async function getCandidate(id: string): Promise<RussellCandidate | null> {
  const rows = await getDb().all<RussellCandidateRow>(
    'SELECT * FROM russell_candidates WHERE id = ?',
    [id],
  );
  return rows[0] ? mapCandidate(rows[0]) : null;
}

/**
 * An existing candidate with this exact meaning, in this exact scope.
 *
 * Scope is part of the query rather than a filter afterwards. Comparing across
 * scopes would let a private candidate be discovered through a duplicate match
 * in a project the asker cannot see — a leak through timing and wording rather
 * than through content, which is still a leak.
 */
export async function findByFingerprint(input: {
  projectId: string | null;
  fingerprint: string;
  visibility: RussellVisibility;
  /** Ignore this row when looking — used to ask "is there an *earlier* one?" */
  excludeId?: string;
}): Promise<RussellCandidate | null> {
  const exclude = input.excludeId ? ' AND id <> ?' : '';
  const rows = await getDb().all<RussellCandidateRow>(
    input.projectId === null
      ? `SELECT * FROM russell_candidates
          WHERE project_id IS NULL AND fingerprint = ? AND visibility = ?
            AND state <> 'MERGED'${exclude}
          ORDER BY created_at, id LIMIT 1`
      : `SELECT * FROM russell_candidates
          WHERE project_id = ? AND fingerprint = ? AND visibility = ?
            AND state <> 'MERGED'${exclude}
          ORDER BY created_at, id LIMIT 1`,
    [
      ...(input.projectId === null ? [] : [input.projectId]),
      input.fingerprint,
      input.visibility,
      ...(input.excludeId ? [input.excludeId] : []),
    ],
  );
  return rows[0] ? mapCandidate(rows[0]) : null;
}

export async function listCandidates(input: {
  projectId: string;
  states?: CandidateState[];
  limit?: number;
}): Promise<RussellCandidate[]> {
  const states = input.states ?? [];
  const placeholders = states.map(() => '?').join(',');
  const rows = await getDb().all<RussellCandidateRow>(
    `SELECT * FROM russell_candidates
      WHERE project_id = ?
      ${states.length ? `AND state IN (${placeholders})` : ''}
      ORDER BY
        CASE priority
          WHEN 'MUST_DO' THEN 0 WHEN 'BIG_MOVE' THEN 1 WHEN 'WORTH_DOING' THEN 2
          WHEN 'EXPLORE' THEN 3 WHEN 'PARKED' THEN 4 ELSE 5 END,
        COALESCE(ordinal, 999),
        updated_at DESC
      LIMIT ?`,
    [input.projectId, ...states, Math.min(500, Math.max(1, input.limit ?? 100))],
  );
  return rows.map(mapCandidate);
}

/**
 * Record what Russell decided, and why.
 *
 * `reason` is not optional and is not generated wording: it is the sentence a
 * person reads when they ask why something is ranked where it is, and a
 * decision that cannot answer that question is not one Russell is entitled to
 * make. `judgment` holds the structured inputs so the ranking can be
 * re-derived rather than merely re-asserted after the model changes.
 */
export async function recordJudgment(input: {
  candidateId: string;
  state: CandidateState;
  priority: CandidatePriority;
  ordinal?: number | null;
  confidence?: number | null;
  reason: string;
  judgment?: Record<string, unknown>;
  supporting?: string[];
  contradicting?: string[];
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_candidates
        SET state = ?, priority = ?, ordinal = ?, confidence = ?, reason = ?,
            judgment = ?, supporting = ?, contradicting = ?, updated_at = ?
      WHERE id = ? AND state <> 'MERGED'`,
    [
      input.state,
      input.priority,
      input.ordinal ?? null,
      input.confidence ?? null,
      input.reason,
      toJson(input.judgment ?? {}),
      toJson(input.supporting ?? []),
      toJson(input.contradicting ?? []),
      nowIso(),
      input.candidateId,
    ],
  );
  return result.changes === 1;
}

/**
 * A person disagrees.
 *
 * The override supersedes Russell's decision; it does not erase it. The
 * previous priority and reason are kept in `superseded_decision`, so "Russell
 * thought this was premature and I overruled it" stays readable — which is the
 * only way anyone can later tell whether Russell was right.
 *
 * An override changes a recommendation. It cannot bypass project access,
 * privacy, budget, audit independence or an external-effect prohibition, and
 * none of those are reachable from here.
 */
export async function overrideJudgment(input: {
  candidateId: string;
  actorUserId: string;
  priority: CandidatePriority;
  state: CandidateState;
  reason: string;
}): Promise<boolean> {
  const current = await getCandidate(input.candidateId);
  if (!current) return false;
  const superseded = toJson({
    priority: current.priority,
    state: current.state,
    reason: current.reason,
    at: current.updatedAt,
  });
  const result = await getDb().run(
    `UPDATE russell_candidates
        SET priority = ?, state = ?, override_user_id = ?, override_reason = ?,
            override_at = ?, superseded_decision = ?, updated_at = ?
      WHERE id = ? AND state <> 'MERGED'`,
    [
      input.priority,
      input.state,
      input.actorUserId,
      input.reason,
      nowIso(),
      superseded,
      nowIso(),
      input.candidateId,
    ],
  );
  return result.changes === 1;
}

/**
 * Fold one candidate into another.
 *
 * Guarded on the loser not already being merged, so two concurrent dedupe
 * passes cannot chain a candidate through two canonicals and leave a cycle. The
 * merge row records how it was decided — fingerprint, semantic or a person —
 * because "these were judged the same by a similarity score" and "a person said
 * so" are different facts with different reversibility.
 */
export async function mergeCandidate(input: {
  candidateId: string;
  canonicalId: string;
  method: 'FINGERPRINT' | 'SEMANTIC' | 'USER';
  confidence?: number | null;
  reason: string;
  actorUserId?: string | null;
}): Promise<boolean> {
  if (input.candidateId === input.canonicalId) return false;
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE russell_candidates
        SET state = 'MERGED', canonical_candidate_id = ?, updated_at = ?
      WHERE id = ? AND state <> 'MERGED'`,
    [input.canonicalId, at, input.candidateId],
  );
  if (result.changes !== 1) return false;
  await getDb().run(
    `INSERT INTO russell_candidate_merges
       (id, candidate_id, canonical_id, action, method, confidence, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, 'MERGE', ?, ?, ?, ?, ?)`,
    [
      newId('rcm'),
      input.candidateId,
      input.canonicalId,
      input.method,
      input.confidence ?? null,
      input.reason,
      input.actorUserId ?? null,
      at,
    ],
  );
  return true;
}

/**
 * Undo a mistaken merge.
 *
 * The candidate returns to `CAPTURED` with its canonical link cleared, and the
 * split is appended beside the merge that caused it. Neither history is lost,
 * so the record reads "these were merged, then a person said they were not" —
 * which is what makes a wrong merge a correctable event rather than a silent
 * loss.
 */
export async function splitCandidate(input: {
  candidateId: string;
  reason: string;
  actorUserId?: string | null;
}): Promise<boolean> {
  const current = await getCandidate(input.candidateId);
  if (!current || current.state !== 'MERGED' || !current.canonicalCandidateId) return false;
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE russell_candidates
        SET state = 'CAPTURED', canonical_candidate_id = NULL, updated_at = ?
      WHERE id = ? AND state = 'MERGED'`,
    [at, input.candidateId],
  );
  if (result.changes !== 1) return false;
  await getDb().run(
    `INSERT INTO russell_candidate_merges
       (id, candidate_id, canonical_id, action, method, confidence, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, 'SPLIT', 'USER', NULL, ?, ?, ?)`,
    [
      newId('rcm'),
      input.candidateId,
      current.canonicalCandidateId,
      input.reason,
      input.actorUserId ?? null,
      at,
    ],
  );
  return true;
}

export async function listMergeHistory(candidateId: string): Promise<RussellCandidateMergeRow[]> {
  return getDb().all<RussellCandidateMergeRow>(
    `SELECT * FROM russell_candidate_merges
      WHERE candidate_id = ? OR canonical_id = ?
      ORDER BY created_at, rowid`,
    [candidateId, candidateId],
  );
}

/**
 * Move a candidate between states, guarded on where it is now.
 *
 * A compare-and-swap on the state the caller believes it read, so a parked
 * candidate resumed by two paths at once resumes once. Returning `false` is an
 * ordinary outcome, not an error: it means somebody else moved it first.
 */
export async function transitionCandidate(input: {
  candidateId: string;
  from: CandidateState;
  to: CandidateState;
}): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE russell_candidates SET state = ?, updated_at = ? WHERE id = ? AND state = ?',
    [input.to, nowIso(), input.candidateId, input.from],
  );
  return result.changes === 1;
}
