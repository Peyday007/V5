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
import type { SqlParam } from '../db/types.ts';
import { mayAnswer } from '../domain/monetization.ts';
import { mayReplace } from './cashCardFacts.ts';
import { newId, nowIso } from './util.ts';
import type { Position } from '../domain/construction.ts';
import type {
  ConstructedArrangementRecord,
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
  MonetizationPathEvaluationRow,
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
        AND method = ?
        AND design_signature IS NULL`,
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
  // A constructed arrangement (migration 152) is a hypothesis in the library,
  // not a possibility the ledger ranks: it is read through
  // `listConstructedArrangements`, never through here.
  const where = ['project_id = ?', "origin <> 'CONSTRUCTED'"];
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
  /*
   * Only rows whose stamp is older than `EVALUATED_STAMP_MS`. Restamping every
   * path on every pass was the largest writer of the database's log: on
   * production, 6.4 million updates of 3 695 rows and about 2.5 GB of WAL in
   * eight days, to move a timestamp nothing decides on. A stamp at most an hour
   * old still answers "was this looked at since Brain last learned something";
   * a position that moved is recorded with its own instant on the snapshot.
   */
  const stale = new Date(new Date(at).getTime() - EVALUATED_STAMP_MS).toISOString();
  await getDb().run(
    `UPDATE monetization_paths SET last_evaluated_at = ?, updated_at = ?
      WHERE id IN (${placeholders}) AND (last_evaluated_at IS NULL OR last_evaluated_at < ?)`,
    [at, at, ...pathIds, stale],
  );
}

/** How old a path's last-evaluated stamp may be before a pass rewrites it. */
export const EVALUATED_STAMP_MS = 60 * 60_000;

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

/**
 * Bring an answer carried from the opening's card into line with the card, in
 * one guarded statement (W3b).
 *
 * Only for a fact the caller read as a card copy, and only while it is still the
 * row the caller read (`id` and `updated_at`), so a person's or research's own
 * answer written since is never touched and two ticks correct it once. It
 * follows the card whatever the kind, because the card is the authority the
 * copy rests on: when the card's evidence is withdrawn and replaced, the copy
 * of the withdrawn claim must not outlive it. Nothing is deleted — the old
 * claim keeps its row in `research_claims`, and the caller records the
 * correction as an event. `mayAnswer` still refuses what it always refuses.
 */
export async function replaceCarriedFact(input: {
  id: string;
  expectUpdatedAt: string;
  attribute: MonetizationAttribute;
  kind: FactKind;
  value: string;
  amountCents: number | null;
  days: number | null;
  claimId: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  decidedBy: string;
}): Promise<boolean> {
  if (!mayAnswer(input.attribute, input.kind)) return false;
  const result = await getDb().run(
    `UPDATE monetization_path_facts
        SET kind = ?, value = ?, amount_cents = ?, days = ?, claim_id = ?, basis = ?,
            assumptions = ?, uncertainty = ?, decided_by = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`,
    [
      input.kind,
      input.value,
      input.amountCents,
      input.days,
      input.claimId,
      input.basis,
      input.assumptions,
      input.uncertainty,
      input.decidedBy,
      nowIso(),
      input.id,
      input.expectUpdatedAt,
    ],
  );
  return (result.changes ?? 0) > 0;
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
 * Many snapshots in a few statements, and none of them read back.
 *
 * `recordSnapshot` is an insert and a read per row. A movement pass over a
 * ledger where one new possibility near the top shifts everything beneath it
 * records thousands of movements (production, 2026-11-17: 8 948 inserts and
 * 8 946 read-backs in one process's window), and every one of those round trips
 * allocated and parsed a row nothing used. The rows are identical; only the
 * number of statements changes. Chunked so a chunk stays well inside both
 * drivers' parameter limits, and a pass that dies between chunks leaves the
 * paths it reached recorded, exactly as the row-at-a-time loop did.
 */
const SNAPSHOT_CHUNK = 500;
export async function recordSnapshots(
  inputs: readonly {
    projectId: string;
    pathId: string;
    rank: number;
    previousRank: number | null;
    reason: RankMovementReason;
    status: MonetizationStatus;
    criterion: string | null;
    evaluatedAt: string;
  }[],
): Promise<number> {
  for (let start = 0; start < inputs.length; start += SNAPSHOT_CHUNK) {
    const chunk = inputs.slice(start, start + SNAPSHOT_CHUNK);
    const params: SqlParam[] = [];
    for (const input of chunk) {
      params.push(
        newId('mrs'),
        input.projectId,
        input.pathId,
        input.rank,
        input.previousRank,
        input.reason,
        input.status,
        input.criterion,
        input.evaluatedAt,
      );
    }
    await getDb().run(
      `INSERT INTO monetization_rank_snapshots
         (id, project_id, path_id, rank, previous_rank, reason, status, criterion, evaluated_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params,
    );
  }
  return inputs.length;
}

/**
 * The most recent recorded position of every path in a project.
 *
 * Only the newest row per path leaves the database. This once read the whole
 * history and folded it here, on the reasoning that the history is small —
 * one row per *movement*. It was not: production held 89 636 rows and the
 * read took 5.8 s on average (37.8 s at worst), 284 times in eight hours,
 * shipping some 32 MB per call into a single-CPU process (2026-10-16). The
 * `NOT EXISTS` is answered by `idx_monetization_snapshots_path (path_id,
 * evaluated_at)` and is sayable in both dialects, which is the property the
 * fold existed for — a `SELECT DISTINCT … ORDER BY MAX(…)` still is not.
 * The tie is broken by id, exactly as the oldest-first fold broke it.
 */
export async function latestSnapshots(
  projectId: string,
): Promise<Map<string, MonetizationRankSnapshot>> {
  /*
   * One grouped pass for each path's newest time, joined back on the
   * (path_id, evaluated_at) index. The correlated NOT EXISTS with an OR could
   * not use that index on Postgres: production (pg_stat_statements,
   * 2026-11-05) shows 11 171 calls spilling 596 GB to temporary files, about
   * 53 MB a call, beside the pool floods. Rows sharing a path's newest time
   * (one pass writes one per path, so rare) arrive ordered by id and the last
   * wins below, the same tie-break as before.
   */
  const rows = await getDb().all<MonetizationRankSnapshotRow>(
    `SELECT s.* FROM monetization_rank_snapshots s
       JOIN (SELECT path_id, MAX(evaluated_at) AS newest FROM monetization_rank_snapshots
              WHERE project_id = ? GROUP BY path_id) m
         ON m.path_id = s.path_id AND m.newest = s.evaluated_at
      WHERE s.project_id = ?
      ORDER BY s.evaluated_at, s.id`,
    [projectId, projectId],
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

/**
 * Which recorded answers rest on a claim that has since been contradicted.
 *
 * One join rather than a read per fact. The durable tick asks this every pass
 * for every project running a sprint, and the loop it replaces was `getClaim`
 * once per `EVIDENCE` answer — which is a query per row of a table that grows
 * with the ledger, on a path that runs every thirty seconds. §49's own
 * enumeration made the same mistake and issued seven hundred no-op inserts a
 * tick before it was measured.
 *
 * It reads `contradiction_state` and interprets nothing about what the
 * contradiction says: that column is written by `brain_report_contradiction`
 * and is a row, not a reading.
 *
 * Returns `pathId::attribute` keys, which is the shape the allocator compares
 * against — built here rather than by the caller so the two cannot disagree
 * about how a key is spelled.
 */
export async function contradictedPathAnswers(projectId: string): Promise<Set<string>> {
  const rows = await getDb().all<{ path_id: string; attribute: string }>(
    `SELECT f.path_id AS path_id, f.attribute AS attribute
       FROM monetization_path_facts f
       JOIN research_claims c ON c.id = f.claim_id
      WHERE f.project_id = ?
        AND f.kind = 'EVIDENCE'
        AND c.contradiction_state <> 'UNCHALLENGED'`,
    [projectId],
  );
  return new Set(rows.map((row) => `${row.path_id}::${row.attribute}`));
}

/* --------------------------------------------------------------------------
 * Constructed arrangements (§81/§82, migration 152)
 *
 * The library of arrangements Brain composed itself. One row per structure per
 * project (`design_signature`), written by the plan after construction and
 * read back by the next construction, the next goal and the next process — a
 * restart or a deploy no longer starts the space from zero. Nothing here is
 * deleted; an arrangement nobody composes any more keeps its row, its
 * evaluations and its verdict.
 * ------------------------------------------------------------------------ */

function parseDesign(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A stored §92 position, or null when absent or unreadable — never a guessed one. */
function parsePosition(text: string | null | undefined): Position | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<Position> | null;
    return parsed && typeof parsed.contract === 'string' && typeof parsed.supply === 'string' ? (parsed as Position) : null;
  } catch {
    return null;
  }
}

function mapArrangement(row: MonetizationPathRow): ConstructedArrangementRecord {
  return {
    pathId: row.id,
    projectId: row.project_id,
    signature: row.design_signature ?? '',
    legacyKey: row.legacy_key,
    constructionOrigin: (row.construction_origin ?? 'FORWARD') as ConstructedArrangementRecord['constructionOrigin'],
    design: parseDesign(row.design_json),
    inputsDigest: row.inputs_digest ?? '',
    precedentOpportunityId: row.precedent_opportunity_id,
    opportunityId: row.opportunity_id,
    industryNodeId: row.industry_node_id,
    firstGoalId: row.first_goal_id,
    lastComposedAt: row.last_composed_at,
    askedCount: Number(row.asked_count ?? 0),
    lastAskedAt: row.last_asked_at,
    evaluatedCount: Number(row.evaluated_count ?? 0),
    lastEvaluation: row.last_evaluation_goal_id
      ? {
          goalId: row.last_evaluation_goal_id,
          readingId: row.last_evaluation_reading_id,
          contributionCents: row.last_evaluation_contribution_cents === null ? null : Number(row.last_evaluation_contribution_cents),
          picked: Number(row.last_evaluation_picked ?? 0) === 1,
        }
      : null,
    verdict:
      row.research_verdict === 'CONFIRMED' || row.research_verdict === 'REFUTED'
        ? { verdict: row.research_verdict, inputsDigest: row.verdict_inputs_digest ?? '', roundId: row.verdict_round_id, at: row.verdict_at }
        : null,
    position: parsePosition(row.position_json),
    positionKey: row.position_key ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What a construction pass hands the library for one arrangement. */
export interface ArrangementToRecord {
  signature: string;
  legacyKey: string;
  method: MonetizationMethod;
  title: string;
  thesis: string | null;
  constructionOrigin: 'FORWARD' | 'TRANSFER' | 'REVERSE';
  /** The buyer, when it is a row: an opening's payer or a map node. Neither for a reverse design. */
  opportunityId: string | null;
  industryNodeId: string | null;
  precedentOpportunityId: string | null;
  inputsDigest: string;
  designJson: string;
  /** The §92 position the design occupies, as JSON, and its key (K-6); null where the adapter has none. */
  positionJson: string | null;
  positionKey: string | null;
}

/**
 * Record a pass's arrangements in the library, idempotently by signature.
 *
 * One read of what the project already holds, then a write only for a
 * structure that is new or whose stored design changed — a pass over an
 * unchanged space writes nothing, which is what keeps a ten-minute plan cycle
 * from rewriting four hundred rows. The unique index on
 * `(project_id, design_signature)` decides between two processes composing
 * the same structure at once: the loser's insert becomes an update of the
 * winner's row, never a second row. Near-identical recompositions therefore
 * cannot inflate the count — a structure is one row however often, by however
 * many goals, it is composed.
 */
export async function recordConstructedArrangements(
  projectId: string,
  goalId: string | null,
  arrangements: readonly ArrangementToRecord[],
  at: string = nowIso(),
): Promise<{ created: number; updated: number; unchanged: number }> {
  const report = { created: 0, updated: 0, unchanged: 0 };
  if (arrangements.length === 0) return report;
  const held = new Map<string, { design_json: string | null; inputs_digest: string | null; legacy_key: string | null; position_json: string | null }>();
  for (const row of await getDb().all<{ design_signature: string; design_json: string | null; inputs_digest: string | null; legacy_key: string | null; position_json: string | null }>(
    `SELECT design_signature, design_json, inputs_digest, legacy_key, position_json FROM monetization_paths
      WHERE project_id = ? AND design_signature IS NOT NULL`,
    [projectId],
  )) {
    held.set(row.design_signature, row);
  }
  const seen = new Set<string>();
  const writes: ArrangementToRecord[] = [];
  for (const one of arrangements) {
    if (seen.has(one.signature)) continue;
    seen.add(one.signature);
    const prior = held.get(one.signature);
    if (prior && prior.design_json === one.designJson && prior.inputs_digest === one.inputsDigest && prior.legacy_key === one.legacyKey && (prior.position_json ?? null) === one.positionJson) {
      report.unchanged += 1;
      continue;
    }
    writes.push(one);
    if (prior) report.updated += 1;
    else report.created += 1;
  }
  // A few multi-row statements rather than one per arrangement: a plan read is
  // counted in statements (goalPlan's bounded-read test), and a remote
  // database pays a round trip for each.
  for (let i = 0; i < writes.length; i += ARRANGEMENT_WRITE_BATCH) {
    const chunk = writes.slice(i, i + ARRANGEMENT_WRITE_BATCH);
    await getDb().run(
      `INSERT INTO monetization_paths
         (id, project_id, opportunity_id, industry_node_id, method, title, thesis, origin,
          source_claim_id, merged_into_id, split_from_id, last_evaluated_at, created_at, updated_at,
          design_signature, legacy_key, design_json, construction_origin, precedent_opportunity_id,
          first_goal_id, inputs_digest, last_composed_at, position_json, position_key)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, 'CONSTRUCTED', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(', ')}
       ON CONFLICT (project_id, design_signature) DO UPDATE SET
         opportunity_id = excluded.opportunity_id,
         industry_node_id = excluded.industry_node_id,
         method = excluded.method,
         title = excluded.title,
         thesis = excluded.thesis,
         legacy_key = excluded.legacy_key,
         design_json = excluded.design_json,
         construction_origin = excluded.construction_origin,
         precedent_opportunity_id = excluded.precedent_opportunity_id,
         inputs_digest = excluded.inputs_digest,
         last_composed_at = excluded.last_composed_at,
         position_json = excluded.position_json,
         position_key = excluded.position_key,
         updated_at = excluded.updated_at`,
      chunk.flatMap((one) => [
        newId('mpx'),
        projectId,
        one.opportunityId,
        one.industryNodeId,
        one.method,
        one.title.slice(0, 300),
        one.thesis,
        at,
        at,
        one.signature,
        one.legacyKey,
        one.designJson,
        one.constructionOrigin,
        one.precedentOpportunityId,
        goalId,
        one.inputsDigest,
        at,
        one.positionJson,
        one.positionKey,
      ]),
    );
  }
  return report;
}

/** Arrangements written per statement: 19 parameters each, far inside both drivers' limits. */
const ARRANGEMENT_WRITE_BATCH = 100;

/** Every constructed arrangement one project holds, oldest first. */
export async function listConstructedArrangements(projectId: string): Promise<ConstructedArrangementRecord[]> {
  const rows = await getDb().all<MonetizationPathRow>(
    `SELECT * FROM monetization_paths
      WHERE project_id = ? AND design_signature IS NOT NULL
      ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map(mapArrangement);
}

/**
 * One structure across every project that holds it (K-5): the same buyer
 * kind, need, supply and design composed in another project is the same
 * arrangement, and its research and evaluations are reusable there when its
 * parts resolve. Ordered by project then creation, in both dialects.
 */
export async function arrangementsBySignature(signature: string): Promise<ConstructedArrangementRecord[]> {
  const rows = await getDb().all<MonetizationPathRow>(
    'SELECT * FROM monetization_paths WHERE design_signature = ? ORDER BY project_id, created_at, id',
    [signature],
  );
  return rows.map(mapArrangement);
}

/**
 * Each stored arrangement's research verdict, by signature, without its
 * design: the question a goal pass asks before it opens a round, answered
 * from the narrow columns rather than four hundred designs.
 */
export async function arrangementVerdicts(projectId: string): Promise<Map<string, Pick<ConstructedArrangementRecord, 'verdict'>>> {
  const rows = await getDb().all<{ design_signature: string; research_verdict: string | null; verdict_inputs_digest: string | null; verdict_round_id: string | null; verdict_at: string | null }>(
    `SELECT design_signature, research_verdict, verdict_inputs_digest, verdict_round_id, verdict_at FROM monetization_paths
      WHERE project_id = ? AND design_signature IS NOT NULL AND research_verdict IS NOT NULL`,
    [projectId],
  );
  return new Map(
    rows.map((row) => [
      row.design_signature,
      { verdict: { verdict: row.research_verdict as 'CONFIRMED' | 'REFUTED', inputsDigest: row.verdict_inputs_digest ?? '', roundId: row.verdict_round_id, at: row.verdict_at } },
    ]),
  );
}

/** The arrangement a `goal-…-mx-<key>` round asked about, by its 12-hex key. */
export async function arrangementForLegacyKey(projectId: string, legacyKey: string): Promise<ConstructedArrangementRecord | null> {
  const rows = await getDb().all<MonetizationPathRow>(
    `SELECT * FROM monetization_paths
      WHERE project_id = ? AND legacy_key = ? AND design_signature IS NOT NULL
      ORDER BY updated_at DESC, id`,
    [projectId, legacyKey],
  );
  return rows[0] ? mapArrangement(rows[0]) : null;
}

/** A research round was opened for this arrangement. */
export async function noteArrangementAsked(projectId: string, legacyKey: string, at: string = nowIso()): Promise<boolean> {
  const path = await arrangementForLegacyKey(projectId, legacyKey);
  if (!path) return false;
  const result = await getDb().run(
    'UPDATE monetization_paths SET asked_count = asked_count + 1, last_asked_at = ?, updated_at = ? WHERE id = ?',
    [at, at, path.pathId],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * What research concluded about an arrangement, under the inputs it had then.
 *
 * A REFUTED verdict holds only while `inputs_digest` still equals the
 * `verdict_inputs_digest` written here: new evidence about any of its parts
 * changes the digest and reopens the question. Guarded on the round, so a
 * second tick reading the same closed round writes nothing.
 */
export async function recordArrangementVerdict(input: {
  pathId: string;
  verdict: 'CONFIRMED' | 'REFUTED';
  inputsDigest: string;
  roundId: string;
  at?: string;
}): Promise<boolean> {
  const at = input.at ?? nowIso();
  const result = await getDb().run(
    `UPDATE monetization_paths
        SET research_verdict = ?, verdict_inputs_digest = ?, verdict_round_id = ?, verdict_at = ?, updated_at = ?
      WHERE id = ? AND design_signature IS NOT NULL
        AND (verdict_round_id IS NULL OR verdict_round_id <> ? OR research_verdict IS NULL OR research_verdict <> ?)`,
    [input.verdict, input.inputsDigest, input.roundId, at, at, input.pathId, input.roundId, input.verdict],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * One goal model's weighing of constructed arrangements, for one stored plan
 * reading: an append-only row each, plus the count and the last one on the
 * path. Idempotent by `(path, reading)`, so a retried write counts once.
 */
export async function recordArrangementEvaluations(input: {
  projectId: string;
  goalId: string;
  readingId: string;
  at?: string;
  entries: ReadonlyArray<{ legacyKey: string; picked: boolean; refused: boolean; contributionCents: number | null }>;
}): Promise<number> {
  if (input.entries.length === 0) return 0;
  const at = input.at ?? nowIso();
  let written = 0;
  const keys = [...new Set(input.entries.map((one) => one.legacyKey))];
  const byKey = new Map<string, { pathId: string }>();
  for (const row of await getDb().all<{ id: string; legacy_key: string }>(
    `SELECT id, legacy_key FROM monetization_paths
      WHERE project_id = ? AND design_signature IS NOT NULL AND legacy_key IN (${keys.map(() => '?').join(', ')})
      ORDER BY updated_at, id`,
    [input.projectId, ...keys],
  )) {
    byKey.set(row.legacy_key, { pathId: row.id });
  }
  for (const one of input.entries) {
    const path = byKey.get(one.legacyKey);
    if (!path) continue;
    const cents = one.contributionCents === null ? null : Math.max(-2_000_000_000, Math.min(2_000_000_000, Math.round(one.contributionCents)));
    const inserted = await getDb().run(
      `INSERT INTO monetization_path_evaluations
         (id, project_id, path_id, goal_id, reading_id, picked, refused, contribution_cents, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [newId('mpe'), input.projectId, path.pathId, input.goalId, input.readingId, one.picked ? 1 : 0, one.refused ? 1 : 0, cents, at],
    );
    if ((inserted.changes ?? 0) === 0) continue;
    await getDb().run(
      `UPDATE monetization_paths
          SET evaluated_count = evaluated_count + 1, last_evaluated_at = ?, last_evaluation_goal_id = ?,
              last_evaluation_reading_id = ?, last_evaluation_contribution_cents = ?, last_evaluation_picked = ?,
              updated_at = ?
        WHERE id = ?`,
      [at, input.goalId, input.readingId, cents, one.picked ? 1 : 0, at, path.pathId],
    );
    written += 1;
  }
  return written;
}

/**
 * The structures a goal's last plan readings led with: every arrangement the
 * best combination picked, and the few that contributed most, in each of the
 * goal's `readings` most recent readings. Construction always composes these
 * (P4, 2026-11-18), so a leader is never dropped by the cap between two passes
 * that learned nothing new. One statement (a plan read is counted in
 * statements: goalPlan's bounded-read test); signatures sorted, so the result
 * is the same in both dialects.
 */
export async function recentLeaderSignatures(goalId: string, readings = 2, topPerReading = 3): Promise<string[]> {
  const rows = await getDb().all<{ reading_id: string; design_signature: string; picked: number | string; contribution_cents: number | string | null }>(
    `SELECT e.reading_id, p.design_signature, e.picked, e.contribution_cents
       FROM monetization_path_evaluations e JOIN monetization_paths p ON p.id = e.path_id
      WHERE e.goal_id = ? AND e.refused = 0 AND p.design_signature IS NOT NULL
        AND e.reading_id IN (
          SELECT recent.reading_id FROM (
            SELECT reading_id, MAX(evaluated_at) AS last_at FROM monetization_path_evaluations
             WHERE goal_id = ? GROUP BY reading_id ORDER BY last_at DESC, reading_id DESC LIMIT ?
          ) recent
        )`,
    [goalId, goalId, readings],
  );
  const out = new Set<string>();
  const byReading = new Map<string, typeof rows>();
  for (const row of rows) {
    const lane = byReading.get(row.reading_id);
    if (lane) lane.push(row);
    else byReading.set(row.reading_id, [row]);
  }
  const cents = (row: (typeof rows)[number]): number => (row.contribution_cents === null ? -Infinity : Number(row.contribution_cents));
  for (const group of byReading.values()) {
    for (const row of group) if (Number(row.picked) === 1) out.add(row.design_signature);
    const top = [...group].sort((a, b) => cents(b) - cents(a) || a.design_signature.localeCompare(b.design_signature));
    for (const row of top.slice(0, topPerReading)) out.add(row.design_signature);
  }
  return [...out].sort();
}

export interface ArrangementEvaluation {
  id: string;
  pathId: string;
  goalId: string;
  readingId: string;
  picked: boolean;
  refused: boolean;
  contributionCents: number | null;
  evaluatedAt: string;
}

export async function arrangementEvaluations(pathId: string): Promise<ArrangementEvaluation[]> {
  const rows = await getDb().all<MonetizationPathEvaluationRow>(
    'SELECT * FROM monetization_path_evaluations WHERE path_id = ? ORDER BY evaluated_at, id',
    [pathId],
  );
  return rows.map((row) => ({
    id: row.id,
    pathId: row.path_id,
    goalId: row.goal_id,
    readingId: row.reading_id,
    picked: Number(row.picked) === 1,
    refused: Number(row.refused) === 1,
    contributionCents: row.contribution_cents === null ? null : Number(row.contribution_cents),
    evaluatedAt: row.evaluated_at,
  }));
}
