/**
 * The monetization possibility ledger, as rows.
 *
 * Five tables and one rule between them: **nothing here is ever deleted.** A
 * possibility that ranks 40th today is the one that ranks 2nd the week a
 * supplier is found, so there is no `deletePath`, no `DELETE` statement and no
 * hard removal of a judgement, an edge or a snapshot anywhere in this file. A
 * merge is a pointer, an invalidation is an appended row, and a rank that moved
 * leaves the position it moved from behind it.
 *
 * What is **not** here is as deliberate: no status column, no rank column, no
 * score and no margin. Every one of those is derived on the read path by
 * `services/cash/monetization/`, for `tier.ts`'s own reason — a stored verdict
 * is stale the moment the evidence it was waiting on arrives, and deriving it
 * is what reclassifies everything already written by deploying rather than by a
 * backfill that cannot reach what a later tick produced.
 */
import { getDb } from '../db/database.ts';
import { mayAnswer } from '../domain/monetization.ts';
import { mayReplace } from './cashCardFacts.ts';
import { newId, nowIso } from './util.ts';
import type {
  FactKind,
  MonetizationAttribute,
  MonetizationCommission,
  MonetizationCommissionRow,
  MonetizationCommissionState,
  MonetizationEdgeKind,
  MonetizationMethod,
  MonetizationPath,
  MonetizationPathEdge,
  MonetizationPathEdgeRow,
  MonetizationPathFact,
  MonetizationPathFactRow,
  MonetizationPathJudgment,
  MonetizationPathJudgmentRow,
  MonetizationPathRow,
  MonetizationRankSnapshot,
  MonetizationRankSnapshotRow,
  MonetizationStatus,
  PathJudgment,
  PathOrigin,
  RankMovementReason,
} from '../domain/types.ts';

/* --------------------------------------------------------------------------
 * Paths
 * ------------------------------------------------------------------------ */

function mapPath(row: MonetizationPathRow): MonetizationPath {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    industryNodeId: row.industry_node_id,
    method: row.method as MonetizationMethod,
    title: row.title,
    thesis: row.thesis,
    origin: row.origin as PathOrigin,
    sourceClaimId: row.source_claim_id,
    mergedIntoId: row.merged_into_id,
    splitFromId: row.split_from_id,
    lastEvaluatedAt: row.last_evaluated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewPath {
  projectId: string;
  /** Exactly one of these. The CHECK refuses both and neither. */
  opportunityId?: string | null;
  industryNodeId?: string | null;
  method: MonetizationMethod;
  title: string;
  thesis?: string | null;
  origin: PathOrigin;
  sourceClaimId?: string | null;
  splitFromId?: string | null;
}

/**
 * Write a possibility, or find the one that is already there.
 *
 * `ON CONFLICT DO NOTHING` on `(project, subject, method)` then read back —
 * the shape every idempotent write in this repository takes. Two ticks
 * enumerating one subject at once produce one row, and a worker that later
 * *evidences* a method the table had already enumerated collides with it rather
 * than forking the ledger into two entries for one shape of transaction.
 *
 * The loser is told it lost. `created` is what lets an enumeration pass report
 * how many possibilities it actually added rather than how many it considered,
 * and what stops it writing an event on every pass over an unchanged subject.
 */
export async function recordPath(input: NewPath): Promise<{ path: MonetizationPath; created: boolean }> {
  const id = newId('mpx');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO monetization_paths
       (id, project_id, opportunity_id, industry_node_id, method, title, thesis,
        origin, source_claim_id, merged_into_id, split_from_id, last_evaluated_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId ?? null,
      input.industryNodeId ?? null,
      input.method,
      input.title,
      input.thesis ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      input.splitFromId ?? null,
      at,
      at,
    ],
  );
  const found = await pathForMethod({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    industryNodeId: input.industryNodeId ?? null,
    method: input.method,
  });
  if (!found) throw new Error('The monetization path disappeared immediately after being written.');
  return { path: found, created: found.id === id };
}

export async function pathForMethod(input: {
  projectId: string;
  opportunityId: string | null;
  industryNodeId: string | null;
  method: MonetizationMethod;
}): Promise<MonetizationPath | null> {
  const rows = await getDb().all<MonetizationPathRow>(
    `SELECT * FROM monetization_paths
      WHERE project_id = ?
        AND COALESCE(opportunity_id, '-') = ?
        AND COALESCE(industry_node_id, '-') = ?
        AND method = ?`,
    [
      input.projectId,
      input.opportunityId ?? '-',
      input.industryNodeId ?? '-',
      input.method,
    ],
  );
  return rows[0] ? mapPath(rows[0]) : null;
}

export async function getPath(id: string): Promise<MonetizationPath | null> {
  const rows = await getDb().all<MonetizationPathRow>(
    'SELECT * FROM monetization_paths WHERE id = ?',
    [id],
  );
  return rows[0] ? mapPath(rows[0]) : null;
}

/**
 * Every possibility in one project, merged ones included.
 *
 * Deliberately unfiltered. A caller deciding what to *show* filters; a caller
 * deriving a rank has to see everything, because a merged path still carries
 * the facts that were established about it and a reader asking "where did this
 * go" needs the row to still be there. §22's rule: simplification happens in
 * the presentation, never by withholding rows from the thing that reasons.
 *
 * Ordered by creation then id, in both dialects. `ORDER BY rowid` would pass
 * the SQLite suite and throw in production — §27 records that happening three
 * times.
 */
export async function listPaths(input: {
  projectId: string;
  opportunityId?: string;
}): Promise<MonetizationPath[]> {
  const where = ['project_id = ?'];
  const args: string[] = [input.projectId];
  if (input.opportunityId !== undefined) {
    where.push('opportunity_id = ?');
    args.push(input.opportunityId);
  }
  const rows = await getDb().all<MonetizationPathRow>(
    `SELECT * FROM monetization_paths WHERE ${where.join(' AND ')} ORDER BY created_at, id`,
    args,
  );
  return rows.map(mapPath);
}

/**
 * Record that the derivation looked at this path.
 *
 * The brief asks for a *last evaluated timestamp*, and this is the only thing
 * in the ledger that writes one. It is not a cache of the reading: what was
 * read is re-derived on every request, and this answers the different question
 * of whether a recorded position is current or predates the last thing Brain
 * learned.
 */
export async function markEvaluated(pathIds: string[], at: string): Promise<void> {
  if (pathIds.length === 0) return;
  const placeholders = pathIds.map(() => '?').join(', ');
  await getDb().run(
    `UPDATE monetization_paths SET last_evaluated_at = ?, updated_at = ?
      WHERE id IN (${placeholders})`,
    [at, at, ...pathIds],
  );
}

/**
 * Point one possibility at another, or stop pointing.
 *
 * Guarded on the column's current value, so two callers merging the same pair
 * produce one merge and the second is told it changed nothing. Nothing is
 * destroyed either way: the absorbed path keeps its id, its facts, its
 * judgements and its whole rank history, which is what makes §20's "merged,
 * split, revived" reversible rather than a claim in a comment.
 */
export async function setMergedInto(input: {
  pathId: string;
  /** Null unmerges. */
  intoId: string | null;
  expectCurrent: string | null;
}): Promise<boolean> {
  const at = nowIso();
  const result =
    input.expectCurrent === null
      ? await getDb().run(
          `UPDATE monetization_paths SET merged_into_id = ?, updated_at = ?
            WHERE id = ? AND merged_into_id IS NULL`,
          [input.intoId, at, input.pathId],
        )
      : await getDb().run(
          `UPDATE monetization_paths SET merged_into_id = ?, updated_at = ?
            WHERE id = ? AND merged_into_id = ?`,
          [input.intoId, at, input.pathId, input.expectCurrent],
        );
  return (result.changes ?? 0) > 0;
}

/**
 * Record the claim that established a possibility the table had already
 * enumerated.
 *
 * Guarded on the column being empty, so the first source to name a shape of
 * transaction is the one recorded against it and a later one does not overwrite
 * it. The origin is deliberately **not** changed: the row was produced by the
 * enumeration and saying otherwise would rewrite how it came to exist. What is
 * added is the passage a reader can now go and check.
 */
export async function setSourceClaim(pathId: string, claimId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE monetization_paths SET source_claim_id = ?, updated_at = ?
      WHERE id = ? AND source_claim_id IS NULL`,
    [claimId, nowIso(), pathId],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Record that this possibility came out of another, where nothing already says
 * so.
 *
 * Guarded on the column being empty, so a split whose child *already existed*
 * as an enumerated path keeps its lineage without overwriting a different
 * parent it was already recorded against. §5's rule at a column: history is
 * written once and never rewritten.
 */
export async function setSplitFrom(pathId: string, parentId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE monetization_paths SET split_from_id = ?, updated_at = ?
      WHERE id = ? AND split_from_id IS NULL AND id <> ?`,
    [parentId, nowIso(), pathId, parentId],
  );
  return (result.changes ?? 0) > 0;
}

/* --------------------------------------------------------------------------
 * Facts
 * ------------------------------------------------------------------------ */

function mapFact(row: MonetizationPathFactRow): MonetizationPathFact {
  return {
    id: row.id,
    projectId: row.project_id,
    pathId: row.path_id,
    attribute: row.attribute as MonetizationAttribute,
    kind: row.kind as FactKind,
    value: row.value,
    amountCents: row.amount_cents,
    days: row.days,
    claimId: row.claim_id,
    basis: row.basis,
    assumptions: row.assumptions,
    uncertainty: row.uncertainty,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewPathFact {
  projectId: string;
  pathId: string;
  attribute: MonetizationAttribute;
  kind: FactKind;
  value: string;
  amountCents?: number | null;
  days?: number | null;
  claimId?: string | null;
  basis?: string | null;
  assumptions?: string | null;
  uncertainty?: string | null;
  decidedBy: string;
}

/**
 * Record what an attribute now says, and where it came from.
 *
 * `ON CONFLICT ... DO UPDATE`, because the second writer is usually a
 * correction: research answering something Brain proposed, or a person
 * overruling either. What it must never do is let a weaker answer overwrite a
 * stronger one, and that rule is `mayReplace` in `cashCardFacts.ts` — **one
 * function, two tables.** A second copy of the authority order here is the
 * two-readers-disagreeing defect this repository keeps correcting, so the
 * caller asks that one and this writes what it decided.
 */
export async function recordPathFact(input: NewPathFact): Promise<MonetizationPathFact> {
  /*
   * The one narrowing in the attribute table, enforced here rather than
   * described in a comment.
   *
   * `probabilityOfSuccess` admits a published base rate and a person's own
   * decision, and refuses Brain's proposal — so this is the statement that
   * makes that a property of the ledger rather than a claim about it. It is in
   * the repository because every writer goes through this one function, and a
   * guard on one of several entrances is not a guard.
   */
  if (!mayAnswer(input.attribute, input.kind)) {
    throw new Error(
      `A ${input.kind} answer may not be recorded against ${input.attribute}. See ATTRIBUTE in ` +
        'domain/monetization.ts for what it admits and why.',
    );
  }
  /*
   * Authority, not recency — and asked here rather than only at the callers.
   *
   * The statement below is an upsert, so without this a later pass could
   * replace a gated answer with a proposal, or a person's own decision with
   * either. Both callers that existed when this was written already asked
   * `mayReplace` and skipped, correctly; **a guard on one of several entrances
   * is not a guard**, and this file's own comment two paragraphs up makes that
   * argument about `mayAnswer`. It is the same argument.
   *
   * It throws rather than silently declining, for `mayAnswer`'s reason: a
   * caller that reaches here without checking has a defect, and returning the
   * row it failed to write would let that defect look like success. Nothing in
   * production reaches it, and a test asserts that it refuses.
   */
  const held = await pathFact(input.pathId, input.attribute);
  /*
   * A person may revise their own answer. Nothing else may overwrite a
   * stronger one.
   *
   * `mayReplace` is the authority *order* and is reused rather than restated,
   * because a second copy of it would eventually disagree with the first about
   * what outranks what. What it does not decide — because the table it was
   * written for never needed to — is whether an authority may replace *itself*,
   * and there it answers no for `PERSON`.
   *
   * Taking that verbatim would mean a person who recorded the wrong figure
   * could never correct it, which is §24's *escalation with no answering
   * transition* one column along. So a person revising a person's answer is
   * permitted, explicitly, and everything else falls to the order: Brain's
   * research may not overwrite somebody's decision, and Brain's proposal may
   * not overwrite a gated claim.
   */
  const revisingOwn = held !== null && held.kind === 'PERSON' && input.kind === 'PERSON';
  if (!revisingOwn && !mayReplace(held, input.kind)) {
    throw new Error(
      `A ${input.kind} answer may not replace the ${held?.kind} answer already recorded against ` +
        `${input.attribute}. Authority decides this, never recency: ask mayReplace first.`,
    );
  }
  const at = nowIso();
  await getDb().run(
    `INSERT INTO monetization_path_facts
       (id, project_id, path_id, attribute, kind, value, amount_cents, days,
        claim_id, basis, assumptions, uncertainty, decided_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (path_id, attribute) DO UPDATE SET
       kind = excluded.kind,
       value = excluded.value,
       amount_cents = excluded.amount_cents,
       days = excluded.days,
       claim_id = excluded.claim_id,
       basis = excluded.basis,
       assumptions = excluded.assumptions,
       uncertainty = excluded.uncertainty,
       decided_by = excluded.decided_by,
       updated_at = excluded.updated_at`,
    [
      newId('mpf'),
      input.projectId,
      input.pathId,
      input.attribute,
      input.kind,
      input.value,
      input.amountCents ?? null,
      input.days ?? null,
      input.claimId ?? null,
      input.basis ?? null,
      input.assumptions ?? null,
      input.uncertainty ?? null,
      input.decidedBy,
      at,
      at,
    ],
  );
  const found = await pathFact(input.pathId, input.attribute);
  if (!found) throw new Error('The path fact disappeared immediately after being written.');
  return found;
}

export async function pathFact(
  pathId: string,
  attribute: MonetizationAttribute,
): Promise<MonetizationPathFact | null> {
  const rows = await getDb().all<MonetizationPathFactRow>(
    'SELECT * FROM monetization_path_facts WHERE path_id = ? AND attribute = ?',
    [pathId, attribute],
  );
  return rows[0] ? mapFact(rows[0]) : null;
}

/**
 * Every recorded answer in one project, in one query.
 *
 * A project's ledger is composed for every page that shows it, and a query per
 * path would be one per possibility — `cardFactsForProject`'s own reason, at a
 * table with an order of magnitude more rows in it.
 */
export async function pathFactsForProject(projectId: string): Promise<MonetizationPathFact[]> {
  const rows = await getDb().all<MonetizationPathFactRow>(
    'SELECT * FROM monetization_path_facts WHERE project_id = ? ORDER BY path_id, attribute',
    [projectId],
  );
  return rows.map(mapFact);
}

export async function pathFactsFor(pathId: string): Promise<MonetizationPathFact[]> {
  const rows = await getDb().all<MonetizationPathFactRow>(
    'SELECT * FROM monetization_path_facts WHERE path_id = ? ORDER BY attribute',
    [pathId],
  );
  return rows.map(mapFact);
}

/* --------------------------------------------------------------------------
 * Judgements
 * ------------------------------------------------------------------------ */

function mapJudgment(row: MonetizationPathJudgmentRow): MonetizationPathJudgment {
  return {
    id: row.id,
    projectId: row.project_id,
    pathId: row.path_id,
    judgment: row.judgment as PathJudgment,
    reason: row.reason,
    decidedById: row.decided_by_id,
    channel: row.channel as MonetizationPathJudgment['channel'],
    createdAt: row.created_at,
  };
}

/**
 * Append what a person decided. Append-only, and there is no way to take one
 * back — a revival is its own row, because deleting the doubt would make the
 * ledger claim nobody ever had any.
 */
export async function recordJudgment(input: {
  projectId: string;
  pathId: string;
  judgment: PathJudgment;
  reason: string;
  decidedById: string | null;
  channel: MonetizationPathJudgment['channel'];
}): Promise<MonetizationPathJudgment> {
  const id = newId('mpj');
  await getDb().run(
    `INSERT INTO monetization_path_judgments
       (id, project_id, path_id, judgment, reason, decided_by_id, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.pathId,
      input.judgment,
      input.reason,
      input.decidedById,
      input.channel,
      nowIso(),
    ],
  );
  const rows = await getDb().all<MonetizationPathJudgmentRow>(
    'SELECT * FROM monetization_path_judgments WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The judgement disappeared immediately after being written.');
  return mapJudgment(rows[0]);
}

/**
 * Every judgement in one project, oldest first.
 *
 * Oldest first because the derivation folds them in order and the *last* one
 * about a path is what holds — a revival after an invalidation means the path
 * is live again, and reading them newest-first would need the caller to reverse
 * them before it could say so.
 */
export async function listJudgments(projectId: string): Promise<MonetizationPathJudgment[]> {
  const rows = await getDb().all<MonetizationPathJudgmentRow>(
    'SELECT * FROM monetization_path_judgments WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapJudgment);
}

export async function judgmentsFor(pathId: string): Promise<MonetizationPathJudgment[]> {
  const rows = await getDb().all<MonetizationPathJudgmentRow>(
    'SELECT * FROM monetization_path_judgments WHERE path_id = ? ORDER BY created_at, id',
    [pathId],
  );
  return rows.map(mapJudgment);
}

/* --------------------------------------------------------------------------
 * Edges
 * ------------------------------------------------------------------------ */

function mapEdge(row: MonetizationPathEdgeRow): MonetizationPathEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    fromPathId: row.from_path_id,
    toPathId: row.to_path_id,
    kind: row.kind as MonetizationEdgeKind,
    rationale: row.rationale,
    source: row.source as MonetizationPathEdge['source'],
    sourceClaimId: row.source_claim_id,
    decidedById: row.decided_by_id,
    createdAt: row.created_at,
  };
}

/**
 * Record an edge that is true of *these two paths* rather than of their two
 * methods.
 *
 * Everything derivable from the method table is derived and not stored, so
 * anything written here is a fact a derivation could not have had: a source
 * establishing that this supplier will not deal through a broker, or a person
 * recording that one of these has to happen first in this case.
 */
export async function recordEdge(input: {
  projectId: string;
  fromPathId: string;
  toPathId: string;
  kind: MonetizationEdgeKind;
  rationale: string;
  source: MonetizationPathEdge['source'];
  sourceClaimId?: string | null;
  decidedById?: string | null;
}): Promise<{ edge: MonetizationPathEdge; created: boolean }> {
  const id = newId('mpe');
  await getDb().run(
    `INSERT INTO monetization_path_edges
       (id, project_id, from_path_id, to_path_id, kind, rationale, source,
        source_claim_id, decided_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.fromPathId,
      input.toPathId,
      input.kind,
      input.rationale,
      input.source,
      input.sourceClaimId ?? null,
      input.decidedById ?? null,
      nowIso(),
    ],
  );
  const rows = await getDb().all<MonetizationPathEdgeRow>(
    `SELECT * FROM monetization_path_edges
      WHERE from_path_id = ? AND to_path_id = ? AND kind = ?`,
    [input.fromPathId, input.toPathId, input.kind],
  );
  if (!rows[0]) throw new Error('The edge disappeared immediately after being written.');
  return { edge: mapEdge(rows[0]), created: rows[0].id === id };
}

export async function listEdges(projectId: string): Promise<MonetizationPathEdge[]> {
  const rows = await getDb().all<MonetizationPathEdgeRow>(
    'SELECT * FROM monetization_path_edges WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapEdge);
}

/* --------------------------------------------------------------------------
 * Rank snapshots
 * ------------------------------------------------------------------------ */

function mapSnapshot(row: MonetizationRankSnapshotRow): MonetizationRankSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    pathId: row.path_id,
    rank: row.rank,
    previousRank: row.previous_rank,
    reason: row.reason as RankMovementReason,
    status: row.status as MonetizationStatus,
    criterion: row.criterion,
    evaluatedAt: row.evaluated_at,
  };
}

export async function recordSnapshot(input: {
  projectId: string;
  pathId: string;
  rank: number;
  previousRank: number | null;
  reason: RankMovementReason;
  status: MonetizationStatus;
  criterion: string | null;
  evaluatedAt: string;
}): Promise<MonetizationRankSnapshot> {
  const id = newId('mrs');
  await getDb().run(
    `INSERT INTO monetization_rank_snapshots
       (id, project_id, path_id, rank, previous_rank, reason, status, criterion, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.pathId,
      input.rank,
      input.previousRank,
      input.reason,
      input.status,
      input.criterion,
      input.evaluatedAt,
    ],
  );
  const rows = await getDb().all<MonetizationRankSnapshotRow>(
    'SELECT * FROM monetization_rank_snapshots WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The rank snapshot disappeared immediately after being written.');
  return mapSnapshot(rows[0]);
}

/**
 * The most recent recorded position of every path in a project.
 *
 * Read as the whole history ordered oldest-first and folded, rather than as a
 * correlated subquery per path. The history is small — one row per *movement*
 * rather than per pass — and a `SELECT DISTINCT ... ORDER BY MAX(...)` is
 * precisely the shape this codebase's conventions warn about: it passes on
 * SQLite and throws on Postgres unless the aggregate is named in the select
 * list. Folding in TypeScript is sayable in both dialects by construction.
 */
export async function latestSnapshots(
  projectId: string,
): Promise<Map<string, MonetizationRankSnapshot>> {
  const rows = await getDb().all<MonetizationRankSnapshotRow>(
    `SELECT * FROM monetization_rank_snapshots
      WHERE project_id = ? ORDER BY evaluated_at, id`,
    [projectId],
  );
  const out = new Map<string, MonetizationRankSnapshot>();
  for (const row of rows) out.set(row.path_id, mapSnapshot(row));
  return out;
}

/** One path's whole movement history, oldest first. */
export async function snapshotsFor(pathId: string): Promise<MonetizationRankSnapshot[]> {
  const rows = await getDb().all<MonetizationRankSnapshotRow>(
    'SELECT * FROM monetization_rank_snapshots WHERE path_id = ? ORDER BY evaluated_at, id',
    [pathId],
  );
  return rows.map(mapSnapshot);
}

/* --------------------------------------------------------------------------
 * Commissions — what Brain asked, and what came of it
 * ------------------------------------------------------------------------ */

function mapCommission(row: MonetizationCommissionRow): MonetizationCommission {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    pathId: row.path_id,
    attribute: row.attribute as MonetizationAttribute,
    round: row.round,
    candidateId: row.candidate_id,
    reason: row.reason,
    ruleRank: row.rule_rank,
    state: row.state as MonetizationCommissionState,
    openedAt: row.opened_at,
    settledAt: row.settled_at,
    answered: row.answered,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Ask one question about one attribute of one possibility, at most once.
 *
 * The whole concurrency design is the unique index this collides with. Two
 * ticks may both decide, correctly, that the same attribute is the decisive
 * unknown on the same path — the allocator is pure and is therefore no
 * protection at all, exactly as `services/dispatch/router.ts` says of its own.
 * Exactly one `INSERT` matches; the loser reads back the row it collided with
 * and is told it did not create it, which is an ordinary outcome rather than
 * an error.
 *
 * `created` is decided by comparing the id that came back against the id this
 * call generated, never by comparing timestamps: two inserts inside one
 * millisecond are indistinguishable by clock and perfectly distinguishable by
 * key. `openRound` settled this question first and this follows it.
 */
export async function openCommission(input: {
  projectId: string;
  cashModeId: string;
  pathId: string;
  attribute: MonetizationAttribute;
  round: number;
  candidateId: string;
  reason: string;
  ruleRank: number;
}): Promise<{ created: boolean; commission: MonetizationCommission }> {
  const id = newId('mzc');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO monetization_commissions
       (id, project_id, cash_mode_id, path_id, attribute, round, candidate_id,
        reason, rule_rank, state, opened_at, settled_at, answered, outcome,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (project_id, path_id, attribute, round) DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.pathId,
      input.attribute,
      input.round,
      input.candidateId,
      input.reason,
      input.ruleRank,
      at,
      at,
      at,
    ],
  );
  const rows = await getDb().all<MonetizationCommissionRow>(
    `SELECT * FROM monetization_commissions
      WHERE project_id = ? AND path_id = ? AND attribute = ? AND round = ?`,
    [input.projectId, input.pathId, input.attribute, input.round],
  );
  const row = rows[0];
  if (!row) throw new Error('The commission disappeared immediately after being written.');
  return { created: row.id === id, commission: mapCommission(row) };
}

/** Every commission in a project, oldest first. */
export async function listCommissions(input: {
  projectId: string;
  state?: MonetizationCommissionState;
}): Promise<MonetizationCommission[]> {
  const where: string[] = ['project_id = ?'];
  const params: string[] = [input.projectId];
  if (input.state) {
    where.push('state = ?');
    params.push(input.state);
  }
  const rows = await getDb().all<MonetizationCommissionRow>(
    `SELECT * FROM monetization_commissions
      WHERE ${where.join(' AND ')} ORDER BY opened_at, id`,
    params,
  );
  return rows.map(mapCommission);
}

/** Every commission ever opened about one possibility, oldest first. */
export async function commissionsFor(pathId: string): Promise<MonetizationCommission[]> {
  const rows = await getDb().all<MonetizationCommissionRow>(
    'SELECT * FROM monetization_commissions WHERE path_id = ? ORDER BY opened_at, id',
    [pathId],
  );
  return rows.map(mapCommission);
}

/** The live askings of a project, keyed by the idea each one asked. */
export async function openCommissionsByCandidate(
  projectId: string,
): Promise<Map<string, MonetizationCommission>> {
  const rows = await getDb().all<MonetizationCommissionRow>(
    `SELECT * FROM monetization_commissions
      WHERE project_id = ? AND state = 'OPEN' ORDER BY opened_at, id`,
    [projectId],
  );
  const out = new Map<string, MonetizationCommission>();
  for (const row of rows) out.set(row.candidate_id, mapCommission(row));
  return out;
}

/**
 * Close one asking, once.
 *
 * Guarded on `state = 'OPEN'` in the statement that makes the change, so two
 * ticks reading one finished mission settle it exactly once and the loser is
 * told it changed nothing. It never reopens: a settled commission keeps its
 * outcome, its count and its timestamp for ever, and asking the same question
 * again is a *new* round with its own row and its own reason.
 */
export async function settleCommission(input: {
  id: string;
  state: Exclude<MonetizationCommissionState, 'OPEN'>;
  answered: number;
  outcome: string;
}): Promise<MonetizationCommission | null> {
  const at = nowIso();
  const moved = await getDb().run(
    `UPDATE monetization_commissions
        SET state = ?, answered = ?, outcome = ?, settled_at = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.state, Math.max(0, Math.trunc(input.answered)), input.outcome, at, at, input.id],
  );
  if (moved.changes !== 1) return null;
  const rows = await getDb().all<MonetizationCommissionRow>(
    'SELECT * FROM monetization_commissions WHERE id = ?',
    [input.id],
  );
  return rows[0] ? mapCommission(rows[0]) : null;
}

/**
 * Which question this idea is asking, if it is asking one.
 *
 * `envelopeIdFor` reads this to know it is compiling a question about one way
 * of being paid rather than a broad market search. The answer is unambiguous
 * because `idx_monetization_commissions_candidate` makes one candidate at most
 * one commission — `industry_rounds` carries the same index for the same
 * reason, and without it a lookup that has to be certain would be a guess.
 */
export async function commissionForCandidate(
  candidateId: string,
): Promise<MonetizationCommission | null> {
  const rows = await getDb().all<MonetizationCommissionRow>(
    'SELECT * FROM monetization_commissions WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapCommission(rows[0]) : null;
}
