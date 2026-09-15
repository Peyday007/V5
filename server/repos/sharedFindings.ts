/**
 * The promotion record behind one shared Brain.
 *
 * ---------------------------------------------------------------------------
 * Why this table holds no knowledge
 * ---------------------------------------------------------------------------
 *
 * `research_claims` already holds the statement, the canonical source, the
 * publisher, the date, the passage, the locator and the scope fields, and it
 * resolves to the fragment that gated it, the orchestration that produced it
 * and the pass that executed it. Copying any of that into a "shared knowledge"
 * table would be the mistake `knows.ts` refuses in its own opening paragraph: a
 * copy is a second place for the truth to live, it is the one nobody
 * reconciles, and it is precisely what loses a claim's evidence chain.
 *
 * So a row here is a pointer plus the two facts a claim row cannot carry — a
 * person's revocation, and an absolute horizon somebody declared. Everything
 * else about whether a finding may be reused is **re-derived on every read**
 * against the live claim and fragment. A claim that becomes contested, loses
 * its acceptance, or whose fragment leaves ACCEPTED, stops being eligible with
 * nothing written anywhere and no pass having to notice.
 *
 * ---------------------------------------------------------------------------
 * The rule, in one place
 * ---------------------------------------------------------------------------
 *
 * `ELIGIBLE_SQL` is both halves: the derivation that promotes, and the
 * predicate that retrieves. Two copies of it is a design where one of them
 * drifts and the drifting one is whichever nobody reads — this repository has
 * had to write that sentence four times already.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { SharedFinding, SharedFindingRow, SharedFindingState } from '../domain/types.ts';

/**
 * Which conditions admitted a finding, by name.
 *
 * Recorded on every row, because "Brain shared this" is auditable only if you
 * can tell which rule applied. A second rule is a code change somebody reviews,
 * never a row somebody edits.
 */
export const SHARED_PROMOTION_RULE = 'SHARED_PROMOTION_RULE_V1';

/**
 * The six conditions, as SQL over `research_claims c` and
 * `research_fragments fr`.
 *
 * 1. the claim cleared the seven-condition evidence gate
 * 2. it resolves to a canonical source that validated structurally
 * 3. nothing has contested or refuted it
 * 4. it is not a calculation resting on inputs that did not travel with it
 * 5. its fragment met its declared scope, lanes and independent-source minimum
 * 6. (in the join) it resolves to an orchestration, so its origin is never unknown
 *
 * **Condition 2 is redundant today and is kept deliberately**, which is worth
 * saying rather than leaving somebody to discover by deleting it and watching
 * the tests pass. The gate's own first condition is a canonical source URL, so
 * nothing can be `accepted` while `sourced` is 0 — removing either half of
 * condition 2 changes no behaviour a test can reach. It stays because it is
 * what *reusable as a fact about the world* means structurally: if acceptance
 * ever widened, this is the line that would still refuse working material, and
 * a rule that states its own reason is worth more than one that relies on a
 * property of a different module holding.
 */
const ELIGIBLE_SQL = `
      c.accepted = 1
  AND c.sourced = 1
  AND c.validation_state = 'SOURCED'
  AND c.source_url IS NOT NULL
  AND c.contradiction_state IN ('UNCHALLENGED','SUPPORTED')
  AND c.derived = 0
  AND fr.status = 'ACCEPTED'
`;

function mapFinding(row: SharedFindingRow): SharedFinding {
  return {
    id: row.id,
    claimId: row.claim_id,
    originProjectId: row.origin_project_id,
    originOrchestrationId: row.origin_orchestration_id,
    originFragmentId: row.origin_fragment_id,
    originLayerId: row.origin_layer_id,
    originWorkerId: row.origin_worker_id,
    originSessionRef: row.origin_session_ref,
    ruleVersion: row.rule_version,
    state: row.state as SharedFindingState,
    validUntil: row.valid_until,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
    revokedReason: row.revoked_reason,
    promotedAt: row.promoted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PromotableRow {
  claim_id: string;
  origin_project_id: string;
  origin_orchestration_id: string;
  origin_fragment_id: string | null;
  origin_layer_id: string | null;
  origin_worker_id: string | null;
  origin_session_ref: string | null;
}

/**
 * Promote every claim the rule admits and nothing has promoted yet.
 *
 * A derivation over rows rather than a hook on the moment a fragment is
 * accepted — which is what lets it reach everything already written, survive a
 * tick that died halfway, and be run by two instances at once. The unique index
 * on `claim_id` is the arbiter; `ON CONFLICT DO NOTHING` means a loser is an
 * ordinary outcome rather than an error.
 *
 * Nothing here judges, scores or rewrites a claim. It reads rows and writes a
 * pointer.
 */
export async function promoteEligibleClaims(limit = 200): Promise<string[]> {
  const db = getDb();
  const rows = await db.all<PromotableRow>(
    `SELECT c.id            AS claim_id,
            o.project_id    AS origin_project_id,
            o.id            AS origin_orchestration_id,
            fr.id           AS origin_fragment_id,
            fr.layer_id     AS origin_layer_id,
            p.executor_worker_id  AS origin_worker_id,
            p.executor_session_ref AS origin_session_ref
       FROM research_claims c
       JOIN research_fragments fr ON fr.id = c.fragment_id
       JOIN research_orchestrations o ON o.id = c.orchestration_id
       LEFT JOIN research_passes p ON p.id = c.pass_id
      WHERE ${ELIGIBLE_SQL}
        AND NOT EXISTS (SELECT 1 FROM shared_findings s WHERE s.claim_id = c.id)
      ORDER BY c.created_at, c.id
      LIMIT ?`,
    [limit] as never[],
  );

  const promoted: string[] = [];
  const now = nowIso();
  for (const row of rows) {
    const id = newId('shf');
    const result = await db.run(
      `INSERT INTO shared_findings
         (id, claim_id, origin_project_id, origin_orchestration_id, origin_fragment_id,
          origin_layer_id, origin_worker_id, origin_session_ref, rule_version, state,
          valid_until, revoked_at, revoked_by_user_id, revoked_reason,
          promoted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT (claim_id) DO NOTHING`,
      [
        id,
        row.claim_id,
        row.origin_project_id,
        row.origin_orchestration_id,
        row.origin_fragment_id,
        row.origin_layer_id,
        row.origin_worker_id,
        row.origin_session_ref,
        SHARED_PROMOTION_RULE,
        now,
        now,
        now,
      ] as never[],
    );
    if ((result.changes ?? 0) > 0) promoted.push(id);
  }
  return promoted;
}

/**
 * A finding as a reader needs it: the promotion row, plus the claim it points
 * at, read live.
 *
 * The claim fields are *joined*, never stored here. That is what makes a
 * correction to a claim reach every consumer immediately, and what makes this
 * table impossible to use as a second opinion about what a claim says.
 */
export interface SharedFindingEvidence {
  findingId: string;
  claimId: string;
  originProjectId: string;
  originOrchestrationId: string;
  originFragmentId: string | null;
  originLayerId: string | null;
  originWorkerId: string | null;
  originSessionRef: string | null;
  ruleVersion: string;
  state: SharedFindingState;
  validUntil: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  promotedAt: string;
  /** Live from `research_claims`. */
  claim: string;
  claimType: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
  retrievedAt: string | null;
  confidence: number;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  contradictionState: string;
  contentHash: string;
}

const EVIDENCE_COLUMNS = `
  f.id                AS findingId,
  f.claim_id          AS claimId,
  f.origin_project_id AS originProjectId,
  f.origin_orchestration_id AS originOrchestrationId,
  f.origin_fragment_id AS originFragmentId,
  f.origin_layer_id   AS originLayerId,
  f.origin_worker_id  AS originWorkerId,
  f.origin_session_ref AS originSessionRef,
  f.rule_version      AS ruleVersion,
  f.state             AS state,
  f.valid_until       AS validUntil,
  f.revoked_at        AS revokedAt,
  f.revoked_reason    AS revokedReason,
  f.promoted_at       AS promotedAt,
  c.claim             AS claim,
  c.claim_type        AS claimType,
  c.source_url        AS sourceUrl,
  c.source_title      AS sourceTitle,
  c.source_publisher  AS sourcePublisher,
  c.source_date       AS sourceDate,
  c.evidence_excerpt  AS evidenceExcerpt,
  c.evidence_locator  AS evidenceLocator,
  c.retrieved_at      AS retrievedAt,
  c.confidence        AS confidence,
  c.geography         AS geography,
  c.timeframe         AS timeframe,
  c.population        AS population,
  c.definition        AS definition,
  c.contradiction_state AS contradictionState,
  c.content_hash      AS contentHash
`;

/**
 * Every finding that may be reused right now.
 *
 * Three exclusions, and only the first two are rows here: a person's
 * revocation, an expired horizon, and — re-derived from the live claim and
 * fragment — the rule itself. The third is the reason nothing is snapshotted.
 *
 * `excludeProjectId` leaves out the asking project's own findings, because they
 * already reach it through its own archive and counting them twice would make
 * one publisher look like two.
 *
 * Ordered by columns both dialects have. There is no `rowid` tiebreak here on
 * purpose: `dialect.ts` rewrites `rowid` to `seq`, and a tiebreak on a column
 * only one backend has is how an ORDER BY comes to be true in one dialect and
 * throw in the other.
 */
export async function eligibleFindings(input: {
  excludeProjectId?: string;
  now?: string;
  limit?: number;
}): Promise<SharedFindingEvidence[]> {
  const now = input.now ?? nowIso();
  const limit = Math.max(1, Math.min(1000, input.limit ?? 500));
  const params: unknown[] = [now];
  let exclusion = '';
  if (input.excludeProjectId) {
    exclusion = 'AND f.origin_project_id <> ?';
    params.push(input.excludeProjectId);
  }
  params.push(limit);

  return getDb().all<SharedFindingEvidence>(
    `SELECT ${EVIDENCE_COLUMNS}
       FROM shared_findings f
       JOIN research_claims c ON c.id = f.claim_id
       JOIN research_fragments fr ON fr.id = c.fragment_id
      WHERE f.state = 'ACTIVE'
        AND (f.valid_until IS NULL OR f.valid_until > ?)
        ${exclusion}
        AND ${ELIGIBLE_SQL}
      ORDER BY f.promoted_at DESC, f.id DESC
      LIMIT ?`,
    params as never[],
  );
}

/**
 * Every finding, eligible or not, for a person reading the pool.
 *
 * A revoked or expired finding is *shown* with its reason rather than hidden:
 * somebody asking "why is this not being reused" must be able to find out,
 * and a row that vanished answers nothing. It is `eligibleFindings` that
 * decides what Brain may actually reuse, and nothing here widens that.
 */
export async function listFindings(input: { limit?: number } = {}): Promise<SharedFindingEvidence[]> {
  const limit = Math.max(1, Math.min(1000, input.limit ?? 200));
  return getDb().all<SharedFindingEvidence>(
    `SELECT ${EVIDENCE_COLUMNS}
       FROM shared_findings f
       JOIN research_claims c ON c.id = f.claim_id
      ORDER BY f.promoted_at DESC, f.id DESC
      LIMIT ?`,
    [limit] as never[],
  );
}

export async function getFinding(id: string): Promise<SharedFinding | null> {
  const row = await getDb().get<SharedFindingRow>(
    'SELECT * FROM shared_findings WHERE id = ?',
    [id],
  );
  return row ? mapFinding(row) : null;
}

/**
 * Withdraw a finding from the shared pool.
 *
 * Guarded on the state it is leaving, so two people pressing it produce one
 * revocation and one ordinary refusal. It destroys nothing: the row keeps its
 * id, its origin, its rule and — now — who withdrew it and why. The claim it
 * points at is not touched at all, because a finding being unsuitable for reuse
 * elsewhere is not the same fact as the evidence being wrong.
 */
export async function revokeFinding(input: {
  id: string;
  userId: string;
  reason: string;
}): Promise<SharedFinding | null> {
  const now = nowIso();
  const result = await getDb().run(
    `UPDATE shared_findings
        SET state = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?,
            revoked_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'ACTIVE'`,
    [now, input.userId, input.reason, now, input.id] as never[],
  );
  if ((result.changes ?? 0) === 0) return null;
  return getFinding(input.id);
}

/**
 * Declare how long a finding is good for.
 *
 * Nothing derives this: an absolute horizon is a judgement about the world and
 * Brain has no row that states one. Staleness *relative to a question* is a
 * different fact and is already decided by the coverage classifier's own
 * timeframe verdict, which is why it is deliberately not duplicated here.
 */
export async function setFindingHorizon(input: {
  id: string;
  validUntil: string | null;
}): Promise<SharedFinding | null> {
  const result = await getDb().run(
    `UPDATE shared_findings SET valid_until = ?, updated_at = ?
      WHERE id = ? AND state = 'ACTIVE'`,
    [input.validUntil, nowIso(), input.id] as never[],
  );
  if ((result.changes ?? 0) === 0) return null;
  return getFinding(input.id);
}
