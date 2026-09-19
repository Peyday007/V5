/**
 * The industry graph, what has been asked about it, and the two kinds of fact
 * that hang off a piece of work rather than off a subject.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  CapitalStructure,
  CapitalStructureRow,
  IndustryNode,
  IndustryNodeKind,
  IndustryNodeOrigin,
  IndustryNodeRow,
  IndustryRound,
  IndustryRoundPurpose,
  IndustryRoundRow,
  OpportunityConstraint,
  OpportunityConstraintRow,
} from '../domain/types.ts';

function mapNode(row: IndustryNodeRow): IndustryNode {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    kind: row.kind as IndustryNodeKind,
    name: row.name,
    description: row.description,
    origin: row.origin as IndustryNodeOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Add a subject to the map, or find the one that is already there.
 *
 * The name is the identity within a parent, deliberately: two workers reading
 * two sources about one industry write the same name, and a second node would
 * split that subject's evidence between two rows that nothing joins. It is
 * normalized to a single-spaced trimmed form so that whitespace cannot make
 * one subject into two.
 *
 * `created` is what a caller needs to know — whether this tick is the one that
 * found it — and it is decided by comparing the id back rather than by the
 * driver's changed count, which the two backends report differently for an
 * insert that conflicted.
 */
export async function createNode(input: {
  projectId: string;
  parentId: string | null;
  kind: IndustryNodeKind;
  name: string;
  description?: string | null;
  origin: IndustryNodeOrigin;
  sourceClaimId?: string | null;
}): Promise<{ node: IndustryNode; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('An industry node must have a name.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded node may exist without the claim that established it.');
  }
  const id = newId('ind');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO industry_nodes
       (id, project_id, parent_id, kind, name, description, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.parentId,
      input.kind,
      name,
      input.description ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = input.parentId
    ? await getDb().all<IndustryNodeRow>(
        'SELECT * FROM industry_nodes WHERE project_id = ? AND parent_id = ? AND name = ?',
        [input.projectId, input.parentId, name],
      )
    : await getDb().all<IndustryNodeRow>(
        'SELECT * FROM industry_nodes WHERE project_id = ? AND parent_id IS NULL AND name = ?',
        [input.projectId, name],
      );
  if (!rows[0]) throw new Error('The industry node disappeared immediately after being written.');
  return { node: mapNode(rows[0]), created: rows[0].id === id };
}

export async function listNodes(projectId: string): Promise<IndustryNode[]> {
  const rows = await getDb().all<IndustryNodeRow>(
    `SELECT * FROM industry_nodes
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapNode);
}

export async function getNode(id: string): Promise<IndustryNode | null> {
  const rows = await getDb().all<IndustryNodeRow>('SELECT * FROM industry_nodes WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapNode(rows[0]) : null;
}

/**
 * A person decided this path is not worth following.
 *
 * Not a delete, for the reason `cash_discovery_rounds` keeps a barren round: a
 * retired subject is evidence about where Brain has already been, and deleting
 * it would let the same node arrive again as a fresh discovery on the next
 * expansion — the allowance spent to learn something somebody already decided.
 *
 * Guarded on not already being retired, so two callers answering one decision
 * record it once and the first reason stands.
 */
export async function retireNode(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE industry_nodes
        SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes === 1;
}

function mapRound(row: IndustryRoundRow): IndustryRound {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    nodeId: row.node_id,
    purpose: row.purpose as IndustryRoundPurpose,
    bucketId: row.bucket_id,
    opportunityId: row.opportunity_id,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as IndustryRound['state'],
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function openIndustryRound(input: {
  projectId: string;
  cashModeId: string;
  nodeId: string | null;
  purpose: IndustryRoundPurpose;
  bucketId?: string | null;
  opportunityId?: string | null;
  round: number;
  candidateId: string;
}): Promise<{ round: IndustryRound; created: boolean }> {
  const id = newId('irn');
  const at = nowIso();
  const round = Math.max(1, Math.trunc(input.round));
  await getDb().run(
    `INSERT INTO industry_rounds
       (id, project_id, cash_mode_id, node_id, purpose, bucket_id, opportunity_id, round,
        candidate_id, state, opened_at, harvested_at, found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.nodeId,
      input.purpose,
      input.bucketId ?? null,
      input.opportunityId ?? null,
      round,
      input.candidateId,
      at,
      at,
      at,
    ],
  );
  const rows = await getDb().all<IndustryRoundRow>(
    `SELECT * FROM industry_rounds
      WHERE project_id = ?
        AND COALESCE(node_id, '-') = ?
        AND purpose = ?
        AND COALESCE(bucket_id, '-') = ?
        AND COALESCE(opportunity_id, '-') = ?
        AND round = ?`,
    [
      input.projectId,
      input.nodeId ?? '-',
      input.purpose,
      input.bucketId ?? '-',
      input.opportunityId ?? '-',
      round,
    ],
  );
  if (!rows[0]) throw new Error('The industry round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

export async function listIndustryRounds(projectId: string): Promise<IndustryRound[]> {
  const rows = await getDb().all<IndustryRoundRow>(
    `SELECT * FROM industry_rounds
      WHERE project_id = ?
      ORDER BY opened_at DESC, id DESC`,
    [projectId],
  );
  return rows.map(mapRound);
}

/** The kernel round one Russell idea is asking, if it is asking one. */
export async function industryRoundForCandidate(
  candidateId: string,
): Promise<IndustryRound | null> {
  const rows = await getDb().all<IndustryRoundRow>(
    'SELECT * FROM industry_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

export async function openIndustryRoundsByCandidate(
  projectId: string,
): Promise<Map<string, IndustryRound>> {
  const rows = await getDb().all<IndustryRoundRow>(
    "SELECT * FROM industry_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

/**
 * This round's question has been answered.
 *
 * `found` is written here and nowhere else, which is what makes a live round's
 * null honest: §33 records the cost of the alternative, where a `NOT NULL
 * DEFAULT 0` written only by this function made every open round report that
 * it had found nothing.
 */
export async function closeIndustryRound(input: {
  id: string;
  to: 'HARVESTED' | 'ABANDONED';
  found: number;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE industry_rounds
        SET state = ?, harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, at, Math.max(0, Math.trunc(input.found)), at, input.id],
  );
  return result.changes === 1;
}

function mapCapital(row: CapitalStructureRow): CapitalStructure {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    entryKind: row.entry_kind as CapitalStructure['entryKind'],
    requirement: row.requirement as CapitalStructure['requirement'],
    mechanism: row.mechanism as CapitalStructure['mechanism'],
    answersId: row.answers_id,
    amountCents: row.amount_cents,
    residualCents: row.residual_cents,
    statement: row.statement,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordCapitalEntry(input: {
  projectId: string;
  opportunityId: string;
  entryKind: 'REQUIREMENT' | 'RESTRUCTURING';
  requirement?: CapitalStructure['requirement'];
  mechanism?: CapitalStructure['mechanism'];
  answersId?: string | null;
  amountCents?: number | null;
  residualCents?: number | null;
  statement: string;
  sourceClaimId: string;
}): Promise<CapitalStructure | null> {
  const id = newId('cap');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO capital_structures
       (id, project_id, opportunity_id, entry_kind, requirement, mechanism, answers_id,
        amount_cents, residual_cents, statement, source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.entryKind,
      input.requirement ?? null,
      input.mechanism ?? null,
      input.answersId ?? null,
      input.amountCents ?? null,
      input.entryKind === 'RESTRUCTURING' ? (input.residualCents ?? null) : null,
      input.statement,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CapitalStructureRow>(
    'SELECT * FROM capital_structures WHERE id = ?',
    [id],
  );
  return rows[0] ? mapCapital(rows[0]) : null;
}

export async function listCapitalFor(opportunityId: string): Promise<CapitalStructure[]> {
  const rows = await getDb().all<CapitalStructureRow>(
    `SELECT * FROM capital_structures
      WHERE opportunity_id = ?
      ORDER BY entry_kind ASC, created_at ASC, id ASC`,
    [opportunityId],
  );
  return rows.map(mapCapital);
}

export async function listCapitalForProject(projectId: string): Promise<CapitalStructure[]> {
  const rows = await getDb().all<CapitalStructureRow>(
    `SELECT * FROM capital_structures
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapCapital);
}

function mapConstraint(row: OpportunityConstraintRow): OpportunityConstraint {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    nodeId: row.node_id,
    kind: row.kind as OpportunityConstraint['kind'],
    statement: row.statement,
    effect: row.effect,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordConstraint(input: {
  projectId: string;
  opportunityId: string | null;
  nodeId: string | null;
  kind: OpportunityConstraint['kind'];
  statement: string;
  effect?: string | null;
  sourceClaimId: string;
}): Promise<OpportunityConstraint | null> {
  if ((input.opportunityId === null) === (input.nodeId === null)) {
    throw new Error('A constraint belongs to exactly one of a piece of work or a subject.');
  }
  const id = newId('con');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO opportunity_constraints
       (id, project_id, opportunity_id, node_id, kind, statement, effect, source_claim_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.nodeId,
      input.kind,
      input.statement,
      input.effect ?? null,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<OpportunityConstraintRow>(
    'SELECT * FROM opportunity_constraints WHERE id = ?',
    [id],
  );
  return rows[0] ? mapConstraint(rows[0]) : null;
}

export async function listConstraintsForProject(
  projectId: string,
): Promise<OpportunityConstraint[]> {
  const rows = await getDb().all<OpportunityConstraintRow>(
    `SELECT * FROM opportunity_constraints
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapConstraint);
}
