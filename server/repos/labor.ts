/**
 * Workflows, tasks, who produces each one, and what has been asked about them.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 *
 * Two tables here are append-only — `labor_allocations` and
 * `labor_necessity_answers` — and both supersede through a guarded `UPDATE`
 * before the successor is written. That ordering is the compare-and-swap: the
 * claimant does not supply the previous row's live-ness, so two callers
 * answering one decision produce one successor and the loser's supersede
 * matches nothing.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  HumanNecessityReason,
  LaborAllocation,
  LaborAllocationRow,
  LaborChannel,
  LaborMarketOption,
  LaborMarketOptionRow,
  LaborNecessityAnswer,
  LaborNecessityAnswerRow,
  LaborOrigin,
  LaborRound,
  LaborRoundPurpose,
  LaborRoundRow,
  LaborTask,
  LaborTaskRow,
  LaborWorkflow,
  LaborWorkflowRow,
  NecessityAnswer,
  NecessityBasis,
  NecessityQuestion,
  ProductionLayer,
  RateBasis,
} from '../domain/types.ts';

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function mapWorkflow(row: LaborWorkflowRow): LaborWorkflow {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    origin: row.origin as LaborOrigin,
    opportunityId: row.opportunity_id,
    declaredByRef: row.declared_by_ref,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Add a workflow, or find the one that is already there.
 *
 * The name is the identity within a project, deliberately: a derivation that
 * ran twice writes the same name, and a second row would split one workflow's
 * tasks between two nothing joins. `created` is decided by comparing the id
 * back rather than by the driver's changed count, which the two backends
 * report differently for an insert that conflicted.
 */
export async function createWorkflow(input: {
  projectId: string;
  name: string;
  description?: string | null;
  origin: LaborOrigin;
  opportunityId?: string | null;
  declaredByRef?: string | null;
}): Promise<{ workflow: LaborWorkflow; created: boolean }> {
  const name = tidy(input.name);
  if (!name) throw new Error('A workflow must have a name.');
  if (input.origin !== 'SEED' && !input.opportunityId) {
    throw new Error('Only a seeded workflow may exist without the opening it was derived from.');
  }
  const id = newId('lwf');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO labor_workflows
       (id, project_id, name, description, origin, opportunity_id, declared_by_ref,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      name,
      input.description ?? null,
      input.origin,
      input.opportunityId ?? null,
      input.declaredByRef ?? null,
      at,
      at,
    ],
  );
  /*
   * Read back by whichever key could have collided.
   *
   * A derived workflow has two unique indexes over it — the name and the
   * opening — and the second is the one that matters on a re-derivation,
   * because a person may well have renamed it since. Looking up by opening
   * first is what stops a rename producing a duplicate.
   */
  const rows = input.opportunityId
    ? await getDb().all<LaborWorkflowRow>(
        'SELECT * FROM labor_workflows WHERE opportunity_id = ?',
        [input.opportunityId],
      )
    : await getDb().all<LaborWorkflowRow>(
        'SELECT * FROM labor_workflows WHERE project_id = ? AND name = ?',
        [input.projectId, name],
      );
  if (!rows[0]) {
    // Two unique indexes and the insert lost on the *other* one: a seeded
    // workflow already holds this name, and this derivation's opening is not
    // on it. Reported rather than guessed at, because attaching the opening to
    // somebody's hand-written workflow would be Brain deciding they meant the
    // same thing.
    const byName = await getDb().all<LaborWorkflowRow>(
      'SELECT * FROM labor_workflows WHERE project_id = ? AND name = ?',
      [input.projectId, name],
    );
    if (!byName[0]) throw new Error('The workflow disappeared immediately after being written.');
    return { workflow: mapWorkflow(byName[0]), created: false };
  }
  return { workflow: mapWorkflow(rows[0]), created: rows[0].id === id };
}

export async function listWorkflows(projectId: string): Promise<LaborWorkflow[]> {
  const rows = await getDb().all<LaborWorkflowRow>(
    `SELECT * FROM labor_workflows
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapWorkflow);
}

export async function getWorkflow(id: string): Promise<LaborWorkflow | null> {
  const rows = await getDb().all<LaborWorkflowRow>('SELECT * FROM labor_workflows WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapWorkflow(rows[0]) : null;
}

/**
 * A person deciding this is no longer how the work is done.
 *
 * Not a delete, for `retireNode`'s reason: a retired workflow is evidence
 * about what was tried, and deleting it would let the same one arrive again as
 * a fresh derivation on the next tick — with every allocation decision ever
 * made about its tasks gone with it.
 */
export async function retireWorkflow(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE labor_workflows
        SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function mapTask(row: LaborTaskRow): LaborTask {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    name: row.name,
    output: row.output,
    origin: row.origin as LaborOrigin,
    capabilityId: row.capability_id,
    declaredByRef: row.declared_by_ref,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createTask(input: {
  projectId: string;
  workflowId: string;
  name: string;
  output: string;
  origin: LaborOrigin;
  capabilityId?: string | null;
  declaredByRef?: string | null;
}): Promise<{ task: LaborTask; created: boolean }> {
  const name = tidy(input.name);
  const output = tidy(input.output);
  if (!name) throw new Error('A task must have a name.');
  if (!output) {
    // Question 1 of the necessity test, and the reason it is NOT NULL: every
    // one of the other eleven is about this output, so a task without one
    // cannot be assessed at all.
    throw new Error('A task must say what output it produces.');
  }
  if (input.origin !== 'SEED' && !input.capabilityId) {
    throw new Error('Only a seeded task may exist without the capability it produces.');
  }
  const id = newId('ltk');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO labor_tasks
       (id, project_id, workflow_id, name, output, origin, capability_id, declared_by_ref,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.workflowId,
      name,
      output,
      input.origin,
      input.capabilityId ?? null,
      input.declaredByRef ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<LaborTaskRow>(
    'SELECT * FROM labor_tasks WHERE workflow_id = ? AND name = ?',
    [input.workflowId, name],
  );
  if (!rows[0]) throw new Error('The task disappeared immediately after being written.');
  return { task: mapTask(rows[0]), created: rows[0].id === id };
}

export async function listTasks(projectId: string): Promise<LaborTask[]> {
  const rows = await getDb().all<LaborTaskRow>(
    `SELECT * FROM labor_tasks
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapTask);
}

export async function getTask(id: string): Promise<LaborTask | null> {
  const rows = await getDb().all<LaborTaskRow>('SELECT * FROM labor_tasks WHERE id = ?', [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function retireTask(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE labor_tasks
        SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

function mapAllocation(row: LaborAllocationRow): LaborAllocation {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    productionLayer: row.production_layer as ProductionLayer,
    necessityReason: row.necessity_reason as HumanNecessityReason | null,
    decidedBy: row.decided_by as LaborAllocation['decidedBy'],
    decidedByRef: row.decided_by_ref,
    rationale: row.rationale,
    supersedesId: row.supersedes_id,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/**
 * Record who produces a task, superseding whatever said so before.
 *
 * The sequence is the whole concurrency design, and it is the shape
 * `claimWork` and `fleet_routines` already have: the previous live row is
 * retired by a guarded `UPDATE` naming the state it moves from, and only the
 * caller that won that swap writes the successor. Two ticks both deciding
 * correctly therefore produce one allocation, and the loser is refused rather
 * than producing a second live row the unique index would reject anyway.
 *
 * `expected` is the caller's account of what it is superseding, and passing a
 * stale one is refused. A caller that read an allocation, thought about it,
 * and wrote a decision against a row that has since moved is deciding about
 * something that is no longer true.
 */
export async function recordAllocation(input: {
  projectId: string;
  taskId: string;
  productionLayer: ProductionLayer;
  necessityReason?: HumanNecessityReason | null;
  decidedBy: 'BRAIN' | 'PERSON';
  decidedByRef?: string | null;
  rationale: string;
  /** The live allocation this replaces, or null when the task has none. */
  expectedCurrentId: string | null;
}): Promise<LaborAllocation | null> {
  const at = nowIso();

  if (input.expectedCurrentId) {
    const swap = await getDb().run(
      `UPDATE labor_allocations
          SET superseded_at = ?
        WHERE id = ? AND task_id = ? AND superseded_at IS NULL`,
      [at, input.expectedCurrentId, input.taskId],
    );
    if (swap.changes !== 1) return null;
  }

  const id = newId('lal');
  await getDb().run(
    `INSERT INTO labor_allocations
       (id, project_id, task_id, production_layer, necessity_reason, decided_by, decided_by_ref,
        rationale, supersedes_id, superseded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.taskId,
      input.productionLayer,
      input.necessityReason ?? null,
      input.decidedBy,
      input.decidedByRef ?? null,
      input.rationale,
      input.expectedCurrentId,
      at,
    ],
  );
  const rows = await getDb().all<LaborAllocationRow>(
    'SELECT * FROM labor_allocations WHERE id = ?',
    [id],
  );
  /*
   * A first allocation that lost the race leaves nothing behind.
   *
   * With no `expectedCurrentId` there was no swap to lose, so the arbiter is
   * the partial unique index and the loser's insert is a no-op. Returning null
   * says "somebody else decided this" in exactly the words the superseding
   * path uses, which is what lets both callers treat it as one outcome.
   */
  return rows[0] ? mapAllocation(rows[0]) : null;
}

export async function listAllocations(projectId: string): Promise<LaborAllocation[]> {
  const rows = await getDb().all<LaborAllocationRow>(
    `SELECT * FROM labor_allocations
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapAllocation);
}

export async function liveAllocationFor(taskId: string): Promise<LaborAllocation | null> {
  const rows = await getDb().all<LaborAllocationRow>(
    'SELECT * FROM labor_allocations WHERE task_id = ? AND superseded_at IS NULL',
    [taskId],
  );
  return rows[0] ? mapAllocation(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Necessity answers
// ---------------------------------------------------------------------------

function mapAnswer(row: LaborNecessityAnswerRow): LaborNecessityAnswer {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    question: row.question as NecessityQuestion,
    answer: row.answer as NecessityAnswer,
    basis: row.basis as NecessityBasis,
    statement: row.statement,
    sourceClaimId: row.source_claim_id,
    answeredByRef: row.answered_by_ref,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/**
 * Answer one necessity question, superseding whatever answered it before.
 *
 * `recordAllocation`'s shape, and append-only for its reason: an allocation's
 * rationale cites what was believed when it was made, and an answer that
 * overwrote would make every past rationale unverifiable.
 *
 * The supersede is unguarded on a specific id here, deliberately. An answer is
 * about a question rather than about a previous answer, so a second reader
 * with better evidence is not making a stale decision the way a second
 * allocator would be — it is simply answering later.
 */
export async function recordNecessityAnswer(input: {
  projectId: string;
  taskId: string;
  question: NecessityQuestion;
  answer: NecessityAnswer;
  basis: NecessityBasis;
  statement: string;
  sourceClaimId?: string | null;
  answeredByRef?: string | null;
}): Promise<LaborNecessityAnswer | null> {
  if ((input.basis === 'RESEARCHED') !== Boolean(input.sourceClaimId)) {
    throw new Error('A researched answer carries its claim, and only a researched answer does.');
  }
  const at = nowIso();
  await getDb().run(
    `UPDATE labor_necessity_answers
        SET superseded_at = ?
      WHERE task_id = ? AND question = ? AND superseded_at IS NULL`,
    [at, input.taskId, input.question],
  );

  const id = newId('lna');
  await getDb().run(
    `INSERT INTO labor_necessity_answers
       (id, project_id, task_id, question, answer, basis, statement, source_claim_id,
        answered_by_ref, superseded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.taskId,
      input.question,
      input.answer,
      input.basis,
      input.statement,
      input.sourceClaimId ?? null,
      input.answeredByRef ?? null,
      at,
    ],
  );
  const rows = await getDb().all<LaborNecessityAnswerRow>(
    'SELECT * FROM labor_necessity_answers WHERE id = ?',
    [id],
  );
  return rows[0] ? mapAnswer(rows[0]) : null;
}

export async function listNecessityAnswers(projectId: string): Promise<LaborNecessityAnswer[]> {
  const rows = await getDb().all<LaborNecessityAnswerRow>(
    `SELECT * FROM labor_necessity_answers
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapAnswer);
}

// ---------------------------------------------------------------------------
// Market options
// ---------------------------------------------------------------------------

function mapOption(row: LaborMarketOptionRow): LaborMarketOption {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    channel: row.channel as LaborChannel,
    jurisdiction: row.jurisdiction,
    rateCents: row.rate_cents,
    rateBasis: row.rate_basis as RateBasis | null,
    statement: row.statement,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordMarketOption(input: {
  projectId: string;
  taskId: string;
  channel: LaborChannel;
  jurisdiction?: string | null;
  rateCents?: number | null;
  rateBasis?: RateBasis | null;
  statement: string;
  sourceClaimId: string;
}): Promise<LaborMarketOption | null> {
  const id = newId('lmo');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO labor_market_options
       (id, project_id, task_id, channel, jurisdiction, rate_cents, rate_basis, statement,
        source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.taskId,
      input.channel,
      input.jurisdiction ?? null,
      input.rateCents ?? null,
      input.rateCents === null || input.rateCents === undefined ? null : (input.rateBasis ?? null),
      input.statement,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<LaborMarketOptionRow>(
    'SELECT * FROM labor_market_options WHERE id = ?',
    [id],
  );
  return rows[0] ? mapOption(rows[0]) : null;
}

export async function listMarketOptions(projectId: string): Promise<LaborMarketOption[]> {
  const rows = await getDb().all<LaborMarketOptionRow>(
    `SELECT * FROM labor_market_options
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapOption);
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

function mapRound(row: LaborRoundRow): LaborRound {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    purpose: row.purpose as LaborRoundPurpose,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as LaborRound['state'],
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function openLaborRound(input: {
  projectId: string;
  taskId: string;
  purpose: LaborRoundPurpose;
  round: number;
  candidateId: string;
}): Promise<{ round: LaborRound; created: boolean }> {
  const id = newId('lrn');
  const at = nowIso();
  const round = Math.max(1, Math.trunc(input.round));
  await getDb().run(
    `INSERT INTO labor_rounds
       (id, project_id, task_id, purpose, round, candidate_id, state, opened_at, harvested_at,
        found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.taskId, input.purpose, round, input.candidateId, at, at, at],
  );
  const rows = await getDb().all<LaborRoundRow>(
    `SELECT * FROM labor_rounds
      WHERE project_id = ? AND task_id = ? AND purpose = ? AND round = ?`,
    [input.projectId, input.taskId, input.purpose, round],
  );
  if (!rows[0]) throw new Error('The labor round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

export async function listLaborRounds(projectId: string): Promise<LaborRound[]> {
  const rows = await getDb().all<LaborRoundRow>(
    `SELECT * FROM labor_rounds
      WHERE project_id = ?
      ORDER BY opened_at DESC, id DESC`,
    [projectId],
  );
  return rows.map(mapRound);
}

/** The labor round one Russell idea is asking, if it is asking one. */
export async function laborRoundForCandidate(candidateId: string): Promise<LaborRound | null> {
  const rows = await getDb().all<LaborRoundRow>(
    'SELECT * FROM labor_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

export async function openLaborRoundsByCandidate(
  projectId: string,
): Promise<Map<string, LaborRound>> {
  const rows = await getDb().all<LaborRoundRow>(
    "SELECT * FROM labor_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

/**
 * This round's question has been answered.
 *
 * `found` is written here and nowhere else, which is what makes a live round's
 * null honest: §33 records the cost of the alternative, where a column only
 * this function ever wrote made every open round report that it had found
 * nothing.
 */
export async function closeLaborRound(input: {
  id: string;
  to: 'HARVESTED' | 'ABANDONED';
  found: number;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE labor_rounds
        SET state = ?, harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, at, Math.max(0, Math.trunc(input.found)), at, input.id],
  );
  return result.changes === 1;
}
