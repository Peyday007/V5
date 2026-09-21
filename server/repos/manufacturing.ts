/**
 * The program, the ladder of machine categories, the capability ledger, the
 * edges between them, what is known about entering a category, and what has
 * been asked about which.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 *
 * One rule is enforced here rather than only documented: **nothing in this
 * file lets a caller that is filing research set `held_at`.** `recordEdge`
 * creates a capability and never marks one held; `declareCapabilityHeld` is a
 * separate function with a separate signature that takes an actor, and
 * `absorb` does not import it.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { capabilitySlug } from '../domain/manufacturing.ts';
import type {
  Capability,
  CapabilityEdge,
  CapabilityEdgeRow,
  CapabilityHeldEvidence,
  CapabilityRelation,
  CapabilityRow,
  CategoryEvidenceEntry,
  CategoryEvidenceKind,
  CategoryEvidenceRow,
  MachineCategory,
  MachineCategoryKind,
  MachineCategoryOrigin,
  MachineCategoryRow,
  AcquisitionCandidate,
  AcquisitionCandidateRow,
  AcquisitionContribution,
  CapitalBasis,
  CapitalScenario,
  CategoryCapitalEntry,
  CategoryCapitalRow,
  MachineCapitalRequirement,
  ProgrammeDecision,
  ProgrammeDecisionRow,
  ProgrammeDecisionTopic,
  ManufacturingProgram,
  ManufacturingProgramRow,
  ManufacturingProgramState,
  ManufacturingRound,
  ManufacturingRoundPurpose,
  ManufacturingRoundRow,
} from '../domain/types.ts';

// ---------------------------------------------------------------------------
// THE PROGRAM
// ---------------------------------------------------------------------------

function mapProgram(row: ManufacturingProgramRow): ManufacturingProgram {
  return {
    id: row.id,
    projectId: row.project_id,
    objective: row.objective,
    state: row.state as ManufacturingProgramState,
    blueprintPath: row.blueprint_path,
    blueprintSha256: row.blueprint_sha256,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Start a program, or read back the one already there.
 *
 * `ON CONFLICT DO NOTHING` against the one-per-project index, so two people
 * pressing start at once produce one program and the second is told about the
 * first rather than being refused. Re-activating an archived program is a
 * separate transition (`setProgramState`) rather than a silent overwrite: the
 * objective on the row is the one somebody authorized, and replacing it here
 * would change what every open round is research *for*.
 */
export async function createProgram(input: {
  projectId: string;
  objective: string;
  ownerUserId: string;
  createdByUserId: string;
  /**
   * The directive as the *server* read it, never as a caller described it.
   *
   * There is no path here a request could choose and no hash a request could
   * supply: `startProgramme` opens the file, parses it and computes the digest,
   * and what arrives here is what it found. A caller-supplied hash would be
   * indistinguishable afterwards from one Brain computed, which is the whole
   * value the column has.
   */
  blueprintPath?: string | null;
  blueprintSha256?: string | null;
}): Promise<{ program: ManufacturingProgram; created: boolean }> {
  const objective = input.objective.replace(/\s+/g, ' ').trim();
  if (!objective) throw new Error('A manufacturing program needs an objective somebody wrote.');
  const id = newId('mfp');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO manufacturing_programs
       (id, project_id, objective, state, blueprint_path, blueprint_sha256,
        owner_user_id, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      objective,
      input.blueprintPath ?? null,
      input.blueprintSha256 ?? null,
      input.ownerUserId,
      input.createdByUserId,
      at,
      at,
    ],
  );
  const program = await getProgram(input.projectId);
  if (!program) throw new Error('The manufacturing program disappeared immediately after being written.');
  return { program, created: program.id === id };
}

export async function getProgram(projectId: string): Promise<ManufacturingProgram | null> {
  const rows = await getDb().all<ManufacturingProgramRow>(
    'SELECT * FROM manufacturing_programs WHERE project_id = ?',
    [projectId],
  );
  return rows[0] ? mapProgram(rows[0]) : null;
}

export async function getProgramById(id: string): Promise<ManufacturingProgram | null> {
  const rows = await getDb().all<ManufacturingProgramRow>(
    'SELECT * FROM manufacturing_programs WHERE id = ?',
    [id],
  );
  return rows[0] ? mapProgram(rows[0]) : null;
}

/**
 * Move a program between states, guarded on the state it is moving from.
 *
 * A compare-and-swap rather than a write, so two people pausing and archiving
 * at once produce one outcome and the loser is told which. Returns false when
 * the row was not in `from`, which is an ordinary outcome.
 */
export async function setProgramState(input: {
  programId: string;
  from: readonly ManufacturingProgramState[];
  to: ManufacturingProgramState;
}): Promise<boolean> {
  if (input.from.length === 0) return false;
  const holes = input.from.map(() => '?').join(', ');
  const result = await getDb().run(
    `UPDATE manufacturing_programs SET state = ?, updated_at = ?
      WHERE id = ? AND state IN (${holes})`,
    [input.to, nowIso(), input.programId, ...input.from],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// THE LADDER
// ---------------------------------------------------------------------------

function mapCategory(row: MachineCategoryRow): MachineCategory {
  return {
    id: row.id,
    programId: row.program_id,
    projectId: row.project_id,
    parentId: row.parent_id,
    kind: row.kind as MachineCategoryKind,
    name: row.name,
    description: row.description,
    origin: row.origin as MachineCategoryOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Add a category to the ladder, or find the one already there.
 *
 * The name is the identity within a parent, deliberately: two workers reading
 * two sources about one class of machine write the same name, and a second row
 * would split that category's evidence between two rows nothing joins. It is
 * normalized to a single-spaced trimmed form so whitespace cannot make one
 * category into two.
 */
export async function createCategory(input: {
  programId: string;
  projectId: string;
  parentId: string | null;
  kind: MachineCategoryKind;
  name: string;
  description?: string | null;
  origin: MachineCategoryOrigin;
  sourceClaimId?: string | null;
}): Promise<{ category: MachineCategory; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A machine category must have a name.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded category may exist without the claim that established it.');
  }
  const id = newId('mcat');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO machine_categories
       (id, program_id, project_id, parent_id, kind, name, description, origin,
        source_claim_id, retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
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
    ? await getDb().all<MachineCategoryRow>(
        'SELECT * FROM machine_categories WHERE program_id = ? AND parent_id = ? AND name = ?',
        [input.programId, input.parentId, name],
      )
    : await getDb().all<MachineCategoryRow>(
        'SELECT * FROM machine_categories WHERE program_id = ? AND parent_id IS NULL AND name = ?',
        [input.programId, name],
      );
  if (!rows[0]) throw new Error('The machine category disappeared immediately after being written.');
  return { category: mapCategory(rows[0]), created: rows[0].id === id };
}

export async function listCategories(programId: string): Promise<MachineCategory[]> {
  const rows = await getDb().all<MachineCategoryRow>(
    `SELECT * FROM machine_categories
      WHERE program_id = ?
      ORDER BY created_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapCategory);
}

export async function getCategory(id: string): Promise<MachineCategory | null> {
  const rows = await getDb().all<MachineCategoryRow>(
    'SELECT * FROM machine_categories WHERE id = ?',
    [id],
  );
  return rows[0] ? mapCategory(rows[0]) : null;
}

/**
 * A person deciding not to pursue a category.
 *
 * Destroys nothing: the row keeps its id, its evidence, its children and every
 * round ever run against it, and `listCategories` still returns it. What
 * changes is that the allocator stops offering it and the verdict reads
 * `RETIRED` with the person's own reason — the one verdict no derivation could
 * ever reach.
 */
export async function retireCategory(id: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE machine_categories SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [nowIso(), reason, nowIso(), id],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// THE CAPABILITY LEDGER
// ---------------------------------------------------------------------------

function mapCapability(row: CapabilityRow): Capability {
  return {
    id: row.id,
    programId: row.program_id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    origin: row.origin as 'SEED' | 'DISCOVERED',
    sourceClaimId: row.source_claim_id,
    heldAt: row.held_at,
    heldEvidence: row.held_evidence as CapabilityHeldEvidence | null,
    heldBy: row.held_by,
    heldNote: row.held_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Put a capability in the ledger, or find the one already there.
 *
 * **It never touches `held_at`.** A capability arriving from research is a
 * capability somebody published a fact about, and a row that appeared unheld
 * stays unheld however many sources name it. That is the whole separation this
 * kernel rests on, and it is a property of there being no parameter for it
 * rather than a convention somebody follows.
 *
 * The slug is the identity and the name is what a reader sees, so the first
 * spelling to arrive is the one displayed. A later source writing it
 * differently finds the same row rather than creating a second.
 */
export async function ensureCapability(input: {
  programId: string;
  projectId: string;
  name: string;
  description?: string | null;
  origin: 'SEED' | 'DISCOVERED';
  sourceClaimId?: string | null;
}): Promise<{ capability: Capability; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A capability must have a name.');
  const slug = capabilitySlug(name);
  if (!slug) {
    throw new Error(`"${name}" reduces to nothing a capability could be identified by.`);
  }
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded capability may exist without the claim that established it.');
  }
  const id = newId('cap');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO capabilities
       (id, program_id, project_id, name, slug, description, origin, source_claim_id,
        held_at, held_evidence, held_by, held_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
      input.projectId,
      name,
      slug,
      input.description ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CapabilityRow>(
    'SELECT * FROM capabilities WHERE program_id = ? AND slug = ?',
    [input.programId, slug],
  );
  if (!rows[0]) throw new Error('The capability disappeared immediately after being written.');
  return { capability: mapCapability(rows[0]), created: rows[0].id === id };
}

export async function listCapabilities(programId: string): Promise<Capability[]> {
  const rows = await getDb().all<CapabilityRow>(
    `SELECT * FROM capabilities WHERE program_id = ? ORDER BY created_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapCapability);
}

export async function getCapability(id: string): Promise<Capability | null> {
  const rows = await getDb().all<CapabilityRow>('SELECT * FROM capabilities WHERE id = ?', [id]);
  return rows[0] ? mapCapability(rows[0]) : null;
}

/**
 * Record that this company holds a capability.
 *
 * The one write in this kernel that a research path must never be able to
 * reach, and its signature is what keeps it that way: it demands an actor and
 * an evidence kind from a closed set, neither of which `absorb` has or could
 * invent.
 *
 * Guarded on `held_at IS NULL`, so it is a claim rather than an overwrite: a
 * capability already recorded as held keeps the evidence that established it
 * and the date it was established, and re-declaring one reports the row that is
 * there. Rewriting it would lose when this company actually became able to do
 * something, which is the one thing the row is for.
 */
export async function declareCapabilityHeld(input: {
  capabilityId: string;
  evidence: CapabilityHeldEvidence;
  heldBy: string;
  note?: string | null;
}): Promise<{ capability: Capability | null; changed: boolean }> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capabilities
        SET held_at = ?, held_evidence = ?, held_by = ?, held_note = ?, updated_at = ?
      WHERE id = ? AND held_at IS NULL`,
    [at, input.evidence, input.heldBy, input.note ?? null, at, input.capabilityId],
  );
  return { capability: await getCapability(input.capabilityId), changed: result.changes === 1 };
}

/**
 * A person withdrawing a declaration they made.
 *
 * The answering transition for a mistake. Guarded on the evidence kind in the
 * statement that makes the change: today `DECLARED` is the only kind, so the
 * guard matches everything, and it is written now so the rule lives in the
 * `UPDATE` rather than in somebody's memory when a derived kind arrives — a
 * holding that rests on something that actually happened is not a claim to be
 * corrected.
 */
export async function withdrawCapabilityHeld(capabilityId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capabilities
        SET held_at = NULL, held_evidence = NULL, held_by = NULL, held_note = NULL, updated_at = ?
      WHERE id = ? AND held_evidence = 'DECLARED'`,
    [nowIso(), capabilityId],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// THE CHAIN
// ---------------------------------------------------------------------------

function mapEdge(row: CapabilityEdgeRow): CapabilityEdge {
  return {
    id: row.id,
    programId: row.program_id,
    categoryId: row.category_id,
    capabilityId: row.capability_id,
    relation: row.relation as CapabilityRelation,
    statement: row.statement,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordEdge(input: {
  programId: string;
  categoryId: string;
  capabilityId: string;
  relation: CapabilityRelation;
  statement: string;
  sourceClaimId: string;
}): Promise<CapabilityEdge | null> {
  const id = newId('cedge');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO capability_edges
       (id, program_id, category_id, capability_id, relation, statement, source_claim_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
      input.categoryId,
      input.capabilityId,
      input.relation,
      input.statement,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CapabilityEdgeRow>(
    `SELECT * FROM capability_edges
      WHERE category_id = ? AND capability_id = ? AND relation = ?`,
    [input.categoryId, input.capabilityId, input.relation],
  );
  if (!rows[0]) return null;
  return rows[0].id === id ? mapEdge(rows[0]) : null;
}

export async function listEdges(programId: string): Promise<CapabilityEdge[]> {
  const rows = await getDb().all<CapabilityEdgeRow>(
    `SELECT * FROM capability_edges WHERE program_id = ? ORDER BY created_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapEdge);
}

// ---------------------------------------------------------------------------
// WHAT IS KNOWN ABOUT ENTERING
// ---------------------------------------------------------------------------

function mapEvidence(row: CategoryEvidenceRow): CategoryEvidenceEntry {
  return {
    id: row.id,
    programId: row.program_id,
    categoryId: row.category_id,
    kind: row.kind as CategoryEvidenceKind,
    subject: row.subject,
    statement: row.statement,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordCategoryEvidence(input: {
  programId: string;
  categoryId: string;
  kind: CategoryEvidenceKind;
  subject: string;
  statement: string;
  observedOn?: string | null;
  sourceClaimId: string;
}): Promise<CategoryEvidenceEntry | null> {
  const id = newId('cev');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO category_evidence
       (id, program_id, category_id, kind, subject, statement, observed_on, source_claim_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
      input.categoryId,
      input.kind,
      input.subject,
      input.statement,
      input.observedOn ?? null,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CategoryEvidenceRow>(
    'SELECT * FROM category_evidence WHERE source_claim_id = ? AND kind = ?',
    [input.sourceClaimId, input.kind],
  );
  if (!rows[0]) return null;
  return rows[0].id === id ? mapEvidence(rows[0]) : null;
}

export async function listCategoryEvidence(programId: string): Promise<CategoryEvidenceEntry[]> {
  const rows = await getDb().all<CategoryEvidenceRow>(
    `SELECT * FROM category_evidence WHERE program_id = ? ORDER BY created_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapEvidence);
}

// ---------------------------------------------------------------------------
// WHAT HAS BEEN ASKED
// ---------------------------------------------------------------------------

function mapRound(row: ManufacturingRoundRow): ManufacturingRound {
  return {
    id: row.id,
    programId: row.program_id,
    projectId: row.project_id,
    categoryId: row.category_id,
    purpose: row.purpose as ManufacturingRoundPurpose,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as 'OPEN' | 'HARVESTED' | 'ABANDONED',
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function openManufacturingRound(input: {
  programId: string;
  projectId: string;
  categoryId: string | null;
  purpose: ManufacturingRoundPurpose;
  round: number;
  candidateId: string;
}): Promise<{ round: ManufacturingRound; created: boolean }> {
  const id = newId('mfr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO manufacturing_rounds
       (id, program_id, project_id, category_id, purpose, round, candidate_id, state,
        opened_at, harvested_at, found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
      input.projectId,
      input.categoryId,
      input.purpose,
      input.round,
      input.candidateId,
      at,
      at,
      at,
    ],
  );
  const rows = input.categoryId
    ? await getDb().all<ManufacturingRoundRow>(
        `SELECT * FROM manufacturing_rounds
          WHERE program_id = ? AND category_id = ? AND purpose = ? AND round = ?`,
        [input.programId, input.categoryId, input.purpose, input.round],
      )
    : await getDb().all<ManufacturingRoundRow>(
        `SELECT * FROM manufacturing_rounds
          WHERE program_id = ? AND category_id IS NULL AND purpose = ? AND round = ?`,
        [input.programId, input.purpose, input.round],
      );
  if (!rows[0]) throw new Error('The manufacturing round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

export async function listManufacturingRounds(programId: string): Promise<ManufacturingRound[]> {
  const rows = await getDb().all<ManufacturingRoundRow>(
    `SELECT * FROM manufacturing_rounds
      WHERE program_id = ?
      ORDER BY opened_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapRound);
}

/**
 * The live rounds, keyed by the candidate that asked each one.
 *
 * `absorb` needs to go from an orchestration back to the question it was
 * answering, and the candidate is that link. Unique by schema, so the map
 * cannot be ambiguous.
 */
export async function openRoundsByCandidate(
  programId: string,
): Promise<Map<string, ManufacturingRound>> {
  const rows = await getDb().all<ManufacturingRoundRow>(
    `SELECT * FROM manufacturing_rounds WHERE program_id = ? AND state = 'OPEN'`,
    [programId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

/** The round one candidate asked, for the compiler's envelope decision. */
export async function manufacturingRoundForCandidate(
  candidateId: string,
): Promise<ManufacturingRound | null> {
  const rows = await getDb().all<ManufacturingRoundRow>(
    'SELECT * FROM manufacturing_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

/**
 * Settle a round with what it produced.
 *
 * Guarded on `OPEN`, so two ticks reading one finished mission settle it once.
 * `found` is required by the schema for anything but OPEN, which is what stops
 * a round recording "nothing counted yet" as "nothing found".
 */
export async function closeManufacturingRound(input: {
  id: string;
  to: 'HARVESTED' | 'ABANDONED';
  found: number;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE manufacturing_rounds
        SET state = ?, harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, at, Math.max(0, Math.trunc(input.found)), at, input.id],
  );
  return result.changes === 1;
}

/**
 * How many rows one orchestration's findings actually put on the ladder.
 *
 * What a programme round *found*, derived from what was filed rather than
 * tallied from what a pass happened to write. `countFiledFromOrchestration` in
 * `repos/industry.ts` is the same repair one kernel along and carries the full
 * argument: tallying is correct only while every pass that absorbs a round also
 * closes it, and a tick dying between the two would record a round that
 * established five things as having established none — which is what barrenness
 * is decided against.
 *
 * Counting *rows* rather than declared claims is what keeps this a repair
 * rather than a change. Two claims naming the same category file one row, and
 * the tally counted one; counting claims would have counted two and quietly
 * moved a number on rounds that settled correctly.
 *
 * A capability row is deliberately not counted on its own — only the edge is. A
 * capability with no edge to this category is not a finding *about* this
 * category, and counting it would make a round that merely renamed something
 * look productive.
 */
export async function countFiledFromOrchestration(orchestrationId: string): Promise<number> {
  const row = await getDb().get<{ total: number }>(
    `SELECT
       (SELECT COUNT(*) FROM machine_categories m
          JOIN research_claims c ON c.id = m.source_claim_id
         WHERE c.orchestration_id = ?)
     + (SELECT COUNT(*) FROM capability_edges e
          JOIN research_claims c ON c.id = e.source_claim_id
         WHERE c.orchestration_id = ?)
     + (SELECT COUNT(*) FROM category_evidence v
          JOIN research_claims c ON c.id = v.source_claim_id
         WHERE c.orchestration_id = ?) AS total`,
    [orchestrationId, orchestrationId, orchestrationId],
  );
  return Number(row?.total ?? 0);
}


// ---------------------------------------------------------------------------
// WHAT ENTERING COSTS
//
// One row per established requirement, keyed by the claim it came from, so a
// tick re-reading a finished packet writes what it wrote before rather than a
// second copy of it. A row with no amount is the honest record of *this is
// required and nobody publishes what it costs*, and `capital.ts` is where that
// stops a total being reported rather than being quietly summed past.
// ---------------------------------------------------------------------------

function mapCapital(row: CategoryCapitalRow): CategoryCapitalEntry {
  return {
    id: row.id,
    programId: row.program_id,
    categoryId: row.category_id,
    requirement: row.requirement as MachineCapitalRequirement,
    scenario: row.scenario as CapitalScenario,
    amountLowMinor: row.amount_low_minor === null ? null : Number(row.amount_low_minor),
    amountHighMinor: row.amount_high_minor === null ? null : Number(row.amount_high_minor),
    currency: row.currency,
    basis: row.basis as CapitalBasis,
    asOf: row.as_of,
    statement: row.statement,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordCategoryCapital(input: {
  programId: string;
  categoryId: string;
  requirement: MachineCapitalRequirement;
  scenario: CapitalScenario;
  amountLowMinor: number | null;
  amountHighMinor: number | null;
  currency: string | null;
  basis: CapitalBasis;
  asOf: string;
  statement: string;
  sourceClaimId: string;
}): Promise<CategoryCapitalEntry | null> {
  const id = newId('mcap');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO category_capital
       (id, program_id, category_id, requirement, scenario, amount_low_minor, amount_high_minor,
        currency, basis, as_of, statement, source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
      input.categoryId,
      input.requirement,
      input.scenario,
      input.amountLowMinor,
      input.amountHighMinor,
      input.currency,
      input.basis,
      input.asOf,
      input.statement,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CategoryCapitalRow>(
    'SELECT * FROM category_capital WHERE source_claim_id = ?',
    [input.sourceClaimId],
  );
  if (!rows[0]) return null;
  return rows[0].id === id ? mapCapital(rows[0]) : null;
}

export async function listCategoryCapital(programId: string): Promise<CategoryCapitalEntry[]> {
  const rows = await getDb().all<CategoryCapitalRow>(
    `SELECT * FROM category_capital WHERE program_id = ? ORDER BY created_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapCapital);
}

// ---------------------------------------------------------------------------
// WHO COULD BE BOUGHT
//
// Identification only. There is no function here that approaches, values,
// offers to or commits to anybody, and there is no column one could write
// into — which is the mechanism rather than a promise. `setAsideCandidate` is
// the one verdict no derivation reaches: a person read it and said no, and the
// row keeps its evidence so the same candidate does not arrive again next
// round as a fresh discovery.
// ---------------------------------------------------------------------------

function mapCandidate(row: AcquisitionCandidateRow): AcquisitionCandidate {
  return {
    id: row.id,
    programId: row.program_id,
    categoryId: row.category_id,
    capabilityId: row.capability_id,
    name: row.name,
    contribution: row.contribution as AcquisitionContribution,
    statement: row.statement,
    sourceClaimId: row.source_claim_id,
    setAsideAt: row.set_aside_at,
    setAsideReason: row.set_aside_reason,
    setAsideBy: row.set_aside_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordAcquisitionCandidate(input: {
  programId: string;
  categoryId: string | null;
  capabilityId: string | null;
  name: string;
  contribution: AcquisitionContribution;
  statement: string;
  sourceClaimId: string;
}): Promise<AcquisitionCandidate | null> {
  const id = newId('macq');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO acquisition_candidates
       (id, program_id, category_id, capability_id, name, contribution, statement,
        source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.programId,
      input.categoryId,
      input.capabilityId,
      input.name,
      input.contribution,
      input.statement,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<AcquisitionCandidateRow>(
    'SELECT * FROM acquisition_candidates WHERE source_claim_id = ?',
    [input.sourceClaimId],
  );
  if (!rows[0]) return null;
  return rows[0].id === id ? mapCandidate(rows[0]) : null;
}

export async function listAcquisitionCandidates(
  programId: string,
): Promise<AcquisitionCandidate[]> {
  const rows = await getDb().all<AcquisitionCandidateRow>(
    `SELECT * FROM acquisition_candidates WHERE program_id = ? ORDER BY created_at ASC, id ASC`,
    [programId],
  );
  return rows.map(mapCandidate);
}

/**
 * A person says no to a candidate.
 *
 * Guarded on it not already being set, so two requests produce one decision
 * and the first reason stands. It destroys nothing and it is not a delete:
 * deleting would let the same firm arrive again on the next round as a fresh
 * discovery, spending the allowance to learn something somebody had settled.
 */
export async function setAsideCandidate(input: {
  candidateId: string;
  programId: string;
  reason: string;
  actorUserId: string;
}): Promise<AcquisitionCandidate | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE acquisition_candidates
        SET set_aside_at = ?, set_aside_reason = ?, set_aside_by = ?, updated_at = ?
      WHERE id = ? AND program_id = ? AND set_aside_at IS NULL`,
    [at, input.reason, input.actorUserId, at, input.candidateId, input.programId],
  );
  const row = await getDb().get<AcquisitionCandidateRow>(
    'SELECT * FROM acquisition_candidates WHERE id = ? AND program_id = ?',
    [input.candidateId, input.programId],
  );
  return row ? mapCandidate(row) : null;
}

// ---------------------------------------------------------------------------
// THE DECISIONS THIS KERNEL CANNOT MAKE
//
// `OPEN` is valid state, and the row exists so that a question nobody can
// answer yet is not the same thing as a question nobody remembers. What its
// criteria, dependencies and reconsideration trigger *are* is derived in
// `services/manufacturing/decisions.ts` rather than stored: a stored criterion
// is stale the moment the thing it depends on changes.
// ---------------------------------------------------------------------------

function mapDecision(row: ProgrammeDecisionRow): ProgrammeDecision {
  return {
    id: row.id,
    programId: row.program_id,
    topic: row.topic as ProgrammeDecisionTopic,
    state: row.state as 'OPEN' | 'RESOLVED',
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensureProgrammeDecision(input: {
  programId: string;
  topic: ProgrammeDecisionTopic;
}): Promise<ProgrammeDecision> {
  const id = newId('mdec');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO programme_decisions
       (id, program_id, topic, state, created_at, updated_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.programId, input.topic, at, at],
  );
  const row = await getDb().get<ProgrammeDecisionRow>(
    'SELECT * FROM programme_decisions WHERE program_id = ? AND topic = ?',
    [input.programId, input.topic],
  );
  if (!row) throw new Error(`programme decision ${input.topic} could not be read back`);
  return mapDecision(row);
}

export async function listProgrammeDecisions(programId: string): Promise<ProgrammeDecision[]> {
  const rows = await getDb().all<ProgrammeDecisionRow>(
    `SELECT * FROM programme_decisions WHERE program_id = ? ORDER BY topic ASC`,
    [programId],
  );
  return rows.map(mapDecision);
}

/**
 * A person resolves one, in their own words.
 *
 * Guarded on `OPEN`, so two requests produce one resolution. Nothing validates
 * the words against a vocabulary and no research round can reach this: the
 * whole point of the row is that the question is not a researchable one.
 */
export async function resolveProgrammeDecision(input: {
  programId: string;
  topic: ProgrammeDecisionTopic;
  resolution: string;
  actorUserId: string;
}): Promise<ProgrammeDecision | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE programme_decisions
        SET state = 'RESOLVED', resolution = ?, resolved_at = ?, resolved_by = ?, updated_at = ?
      WHERE program_id = ? AND topic = ? AND state = 'OPEN'`,
    [input.resolution, at, input.actorUserId, at, input.programId, input.topic],
  );
  const row = await getDb().get<ProgrammeDecisionRow>(
    'SELECT * FROM programme_decisions WHERE program_id = ? AND topic = ?',
    [input.programId, input.topic],
  );
  return row ? mapDecision(row) : null;
}

/**
 * A person reopens one they had resolved.
 *
 * The answering transition, and it exists because the directive's own reason
 * for leaving the brand open — *do not lock these division names prematurely*
 * — is a reason a name chosen early may need unchoosing. Guarded on
 * `RESOLVED`, and the previous resolution is cleared rather than kept, because
 * a decision that reads OPEN while still carrying an answer is the status
 * contradicting the control beside it.
 */
export async function reopenProgrammeDecision(input: {
  programId: string;
  topic: ProgrammeDecisionTopic;
}): Promise<ProgrammeDecision | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE programme_decisions
        SET state = 'OPEN', resolution = NULL, resolved_at = NULL, resolved_by = NULL,
            updated_at = ?
      WHERE program_id = ? AND topic = ? AND state = 'RESOLVED'`,
    [at, input.programId, input.topic],
  );
  const row = await getDb().get<ProgrammeDecisionRow>(
    'SELECT * FROM programme_decisions WHERE program_id = ? AND topic = ?',
    [input.programId, input.topic],
  );
  return row ? mapDecision(row) : null;
}
