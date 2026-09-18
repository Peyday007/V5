/**
 * The capability registry: sources, candidates, faculties and their edges.
 *
 * Three rules are enforced here rather than left to callers, because each of
 * them is the kind of mistake that reads as correct at the call site:
 *
 * **Nothing writes `faculties` except `promoteCandidate`.** There is no
 * `createFaculty`. A definition reaches canonical state only by being a
 * candidate that a deterministic validation and an independent audit both
 * passed, so the absence of that function is the mechanism rather than a
 * convention somebody follows.
 *
 * **Every dimension change is an append-only event.** `moveDimension` writes
 * `faculty_state_events` in the same statement sequence that moves the column,
 * so a registry that holds only current values cannot happen. Somebody will
 * eventually ask when Brain started believing a faculty was implemented and on
 * what evidence, and a bare column answers neither half.
 *
 * **A dimension move names its evidence.** `reason` is required and
 * `evidenceRef` is where the row that justifies it goes. A move with no reason
 * is refused, because "it changed" is not a thing a later reader can check.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import {
  assertIngestionScope,
  type AvailabilityState,
  type ContractState,
  type DefinitionState,
  type EvaluationState,
  type FacultyDefinition,
  type FacultyDimension,
  type FacultyRelationship,
  type FreshnessState,
  type ImplementationState,
} from '../domain/faculties.ts';

/* ------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* ------------------------------------------------------------------------- */

export type SourceKind = 'BLUEPRINT' | 'AMENDMENT';
export type SourceIngestState =
  | 'REGISTERED'
  | 'EXTRACTING'
  | 'PROPOSED'
  | 'AUDITING'
  | 'PROMOTED'
  | 'FAILED';

export interface CapabilitySource {
  id: string;
  kind: SourceKind;
  title: string;
  documentId: string;
  projectId: string;
  amendsId: string | null;
  version: number;
  contentHash: string;
  byteSize: number;
  origin: string;
  privacyScope: 'BRAIN_ARCHITECTURE' | 'PROJECT';
  ingestState: SourceIngestState;
  ingestDetail: string | null;
  binId: string | null;
  registeredBy: string;
  createdAt: string;
  updatedAt: string;
}

export type CandidateState = 'PROPOSED' | 'VALIDATED' | 'REJECTED' | 'PROMOTED' | 'SUPERSEDED';

export interface FacultyCandidate {
  id: string;
  sourceId: string;
  binId: string | null;
  slug: string;
  ordinal: number | null;
  canonicalName: string;
  definition: FacultyDefinition;
  evidenceQuote: string;
  evidenceBlockId: string | null;
  evidencePage: number | null;
  state: CandidateState;
  rejectionReason: string | null;
  auditId: string | null;
  promotedFacultyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Faculty {
  id: string;
  slug: string;
  ordinal: number | null;
  canonicalName: string;
  definition: FacultyDefinition;
  definitionState: DefinitionState;
  contractState: ContractState;
  implementationState: ImplementationState;
  evaluationState: EvaluationState;
  availabilityState: AvailabilityState;
  freshnessState: FreshnessState;
  sourceId: string;
  candidateId: string;
  amendedBySourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacultyEdge {
  id: string;
  fromFacultyId: string;
  toFacultyId: string | null;
  toComponent: string | null;
  relationship: FacultyRelationship;
  rationale: string;
  sourceId: string;
  createdAt: string;
}

export interface FacultyStateEvent {
  id: string;
  facultyId: string;
  dimension: FacultyDimension;
  fromState: string;
  toState: string;
  reason: string;
  evidenceRef: string | null;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key] ?? '');
}
function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}
function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

function mapSource(row: Row): CapabilitySource {
  return {
    id: str(row, 'id'),
    kind: str(row, 'kind') as SourceKind,
    title: str(row, 'title'),
    documentId: str(row, 'document_id'),
    projectId: str(row, 'project_id'),
    amendsId: strOrNull(row, 'amends_id'),
    version: Number(row['version'] ?? 1),
    contentHash: str(row, 'content_hash'),
    byteSize: Number(row['byte_size'] ?? 0),
    origin: str(row, 'origin'),
    privacyScope: str(row, 'privacy_scope') as CapabilitySource['privacyScope'],
    ingestState: str(row, 'ingest_state') as SourceIngestState,
    ingestDetail: strOrNull(row, 'ingest_detail'),
    binId: strOrNull(row, 'bin_id'),
    registeredBy: str(row, 'registered_by'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function mapCandidate(row: Row): FacultyCandidate {
  return {
    id: str(row, 'id'),
    sourceId: str(row, 'source_id'),
    binId: strOrNull(row, 'bin_id'),
    slug: str(row, 'slug'),
    ordinal: numOrNull(row, 'ordinal'),
    canonicalName: str(row, 'canonical_name'),
    definition: parseJson<FacultyDefinition>(str(row, 'definition'), {} as FacultyDefinition),
    evidenceQuote: str(row, 'evidence_quote'),
    evidenceBlockId: strOrNull(row, 'evidence_block_id'),
    evidencePage: numOrNull(row, 'evidence_page'),
    state: str(row, 'state') as CandidateState,
    rejectionReason: strOrNull(row, 'rejection_reason'),
    auditId: strOrNull(row, 'audit_id'),
    promotedFacultyId: strOrNull(row, 'promoted_faculty_id'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function mapFaculty(row: Row): Faculty {
  return {
    id: str(row, 'id'),
    slug: str(row, 'slug'),
    ordinal: numOrNull(row, 'ordinal'),
    canonicalName: str(row, 'canonical_name'),
    definition: parseJson<FacultyDefinition>(str(row, 'definition'), {} as FacultyDefinition),
    definitionState: str(row, 'definition_state') as DefinitionState,
    contractState: str(row, 'contract_state') as ContractState,
    implementationState: str(row, 'implementation_state') as ImplementationState,
    evaluationState: str(row, 'evaluation_state') as EvaluationState,
    availabilityState: str(row, 'availability_state') as AvailabilityState,
    freshnessState: str(row, 'freshness_state') as FreshnessState,
    sourceId: str(row, 'source_id'),
    candidateId: str(row, 'candidate_id'),
    amendedBySourceId: strOrNull(row, 'amended_by_source_id'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

/* ------------------------------------------------------------------------- */
/* Sources                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Register a source, or hand back the one whose bytes these already are.
 *
 * Idempotent by `(content_hash, kind)` rather than by a flag: registering the
 * identical file twice is the same source, and changed bytes are a different
 * one. That makes a re-run of the ingestion path safe in the way §20 means —
 * the effect is present after either call, rather than the second call doing
 * nothing and the caller having to know which it was.
 */
export async function registerSource(input: {
  kind: SourceKind;
  title: string;
  documentId: string;
  projectId: string;
  amendsId?: string | null;
  contentHash: string;
  byteSize: number;
  origin: string;
  privacyScope?: CapabilitySource['privacyScope'];
  registeredBy: string;
}): Promise<{ source: CapabilitySource; created: boolean }> {
  const existing = await getDb().get<Row>(
    `SELECT * FROM capability_sources WHERE content_hash = ? AND kind = ?`,
    [input.contentHash, input.kind] as never[],
  );
  if (existing) return { source: mapSource(existing), created: false };

  // The version is per lineage: a blueprint's own line, or the line of what it
  // amends. Read rather than supplied, so nobody can register a v1 over a v3.
  const lineage = input.amendsId ?? null;
  const prior = await getDb().get<Row>(
    lineage === null
      ? `SELECT MAX(version) AS v FROM capability_sources WHERE kind = ? AND amends_id IS NULL`
      : `SELECT MAX(version) AS v FROM capability_sources WHERE amends_id = ?`,
    (lineage === null ? [input.kind] : [lineage]) as never[],
  );
  const version = Number(prior?.['v'] ?? 0) + 1;

  const id = newId('cps');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO capability_sources
       (id, kind, title, document_id, project_id, amends_id, version, content_hash, byte_size,
        origin, privacy_scope, ingest_state, ingest_detail, bin_id, registered_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED', NULL, NULL, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.title,
      input.documentId,
      input.projectId,
      lineage,
      version,
      input.contentHash,
      input.byteSize,
      input.origin,
      input.privacyScope ?? 'BRAIN_ARCHITECTURE',
      input.registeredBy,
      at,
      at,
    ] as never[],
  );
  const created = await getSource(id);
  if (!created) throw new Error('The source was inserted and could not be read back.');
  return { source: created, created: true };
}

export async function getSource(id: string): Promise<CapabilitySource | null> {
  const row = await getDb().get<Row>(`SELECT * FROM capability_sources WHERE id = ?`, [id] as never[]);
  return row ? mapSource(row) : null;
}

export async function listSources(input: { states?: SourceIngestState[] } = {}): Promise<
  CapabilitySource[]
> {
  const states = input.states ?? [];
  const rows = await getDb().all<Row>(
    states.length === 0
      ? `SELECT * FROM capability_sources ORDER BY created_at DESC`
      : `SELECT * FROM capability_sources WHERE ingest_state IN (${states.map(() => '?').join(',')})
         ORDER BY created_at DESC`,
    states as never[],
  );
  return rows.map(mapSource);
}

/**
 * Move a source's ingestion state, naming the state it came from.
 *
 * A compare-and-swap rather than a plain UPDATE, so two ticks reading one
 * `REGISTERED` source produce one extraction bin. The loser gets `false` and
 * that is an ordinary outcome, not an error — the same shape every claim in
 * this codebase has.
 */
export async function advanceSource(input: {
  id: string;
  from: SourceIngestState;
  to: SourceIngestState;
  detail?: string | null;
  binId?: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capability_sources
        SET ingest_state = ?, ingest_detail = ?, bin_id = COALESCE(?, bin_id), updated_at = ?
      WHERE id = ? AND ingest_state = ?`,
    [
      input.to,
      input.detail ?? null,
      input.binId ?? null,
      nowIso(),
      input.id,
      input.from,
    ] as never[],
  );
  return (result.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------------- */
/* Candidates                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Store one proposed definition, isolated.
 *
 * Nothing that reads `faculties` sees this table. `(source_id, slug)` is unique
 * so a worker proposing the same faculty twice in one extraction replaces
 * rather than duplicates — re-submitting after a correction is the common case
 * and two rows for one faculty would make the coverage count wrong.
 */
export async function putCandidate(input: {
  sourceId: string;
  binId: string | null;
  definition: FacultyDefinition;
  evidenceQuote: string;
  evidenceBlockId: string | null;
  evidencePage: number | null;
  state: CandidateState;
  rejectionReason?: string | null;
}): Promise<FacultyCandidate> {
  const at = nowIso();
  const existing = await getDb().get<Row>(
    `SELECT id FROM faculty_candidates WHERE source_id = ? AND slug = ?`,
    [input.sourceId, input.definition.slug] as never[],
  );
  if (existing) {
    await getDb().run(
      `UPDATE faculty_candidates
          SET bin_id = ?, ordinal = ?, canonical_name = ?, definition = ?, evidence_quote = ?,
              evidence_block_id = ?, evidence_page = ?, state = ?, rejection_reason = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        input.binId,
        input.definition.ordinal,
        input.definition.canonicalName,
        toJson(input.definition),
        input.evidenceQuote,
        input.evidenceBlockId,
        input.evidencePage,
        input.state,
        input.rejectionReason ?? null,
        at,
        String(existing['id']),
      ] as never[],
    );
    const updated = await getCandidate(String(existing['id']));
    if (!updated) throw new Error('The candidate was updated and could not be read back.');
    return updated;
  }

  const id = newId('fcd');
  await getDb().run(
    `INSERT INTO faculty_candidates
       (id, source_id, bin_id, slug, ordinal, canonical_name, definition, evidence_quote,
        evidence_block_id, evidence_page, state, rejection_reason, audit_id,
        promoted_faculty_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      input.sourceId,
      input.binId,
      input.definition.slug,
      input.definition.ordinal,
      input.definition.canonicalName,
      toJson(input.definition),
      input.evidenceQuote,
      input.evidenceBlockId,
      input.evidencePage,
      input.state,
      input.rejectionReason ?? null,
      at,
      at,
    ] as never[],
  );
  const created = await getCandidate(id);
  if (!created) throw new Error('The candidate was inserted and could not be read back.');
  return created;
}

export async function getCandidate(id: string): Promise<FacultyCandidate | null> {
  const row = await getDb().get<Row>(`SELECT * FROM faculty_candidates WHERE id = ?`, [id] as never[]);
  return row ? mapCandidate(row) : null;
}

export async function listCandidates(input: {
  sourceId?: string;
  states?: CandidateState[];
}): Promise<FacultyCandidate[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.sourceId) {
    where.push('source_id = ?');
    params.push(input.sourceId);
  }
  if (input.states && input.states.length > 0) {
    where.push(`state IN (${input.states.map(() => '?').join(',')})`);
    params.push(...input.states);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM faculty_candidates
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ordinal, slug`,
    params as never[],
  );
  return rows.map(mapCandidate);
}

/** Record a decision about a candidate, keeping the reason forever. */
export async function setCandidateState(input: {
  id: string;
  state: CandidateState;
  rejectionReason?: string | null;
  auditId?: string | null;
}): Promise<void> {
  await getDb().run(
    `UPDATE faculty_candidates
        SET state = ?, rejection_reason = COALESCE(?, rejection_reason),
            audit_id = COALESCE(?, audit_id), updated_at = ?
      WHERE id = ?`,
    [
      input.state,
      input.rejectionReason ?? null,
      input.auditId ?? null,
      nowIso(),
      input.id,
    ] as never[],
  );
}

/* ------------------------------------------------------------------------- */
/* Faculties                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The one way a definition becomes canonical.
 *
 * There is no `createFaculty` beside it, deliberately. Everything that could
 * write this table has to come through a candidate that was validated and
 * audited, so the property holds by there being no other function rather than
 * by everybody remembering to use this one.
 *
 * The five dimensions this does **not** set are the point: a promoted faculty
 * is `ABSENT` / `UNTESTED` / `DISABLED` and stays that way until something that
 * is actually about code, evaluation or a person's decision moves it.
 */
export async function promoteCandidate(input: {
  candidateId: string;
  auditId: string;
  actorType: string;
  actorId: string | null;
}): Promise<Faculty> {
  const candidate = await getCandidate(input.candidateId);
  if (!candidate) throw new Error(`No such candidate: ${input.candidateId}`);
  if (candidate.state !== 'VALIDATED') {
    throw new Error(
      `Candidate ${candidate.id} is ${candidate.state}; only a VALIDATED candidate may be promoted.`,
    );
  }

  const at = nowIso();
  const existing = await getFacultyBySlug(candidate.slug);
  if (existing) {
    // A re-ingestion of the same faculty from a later source updates the
    // definition and moves DEFINITION only. §5: the old candidate keeps its row
    // and its state; nothing about the implementation or the evaluation of the
    // faculty is touched by somebody rewriting the document.
    await getDb().run(
      `UPDATE faculties
          SET definition = ?, canonical_name = ?, ordinal = ?, source_id = ?, candidate_id = ?,
              freshness_state = 'CURRENT', updated_at = ?
        WHERE id = ?`,
      [
        toJson(candidate.definition),
        candidate.canonicalName,
        candidate.ordinal,
        candidate.sourceId,
        candidate.id,
        at,
        existing.id,
      ] as never[],
    );
    await moveDimension({
      facultyId: existing.id,
      dimension: 'DEFINITION',
      to: 'CANONICAL',
      reason: `Re-promoted from candidate ${candidate.id} against source ${candidate.sourceId}.`,
      evidenceRef: input.auditId,
      actorType: input.actorType,
      actorId: input.actorId,
    });
    await setCandidateState({
      id: candidate.id,
      state: 'PROMOTED',
      auditId: input.auditId,
    });
    await getDb().run(`UPDATE faculty_candidates SET promoted_faculty_id = ? WHERE id = ?`, [
      existing.id,
      candidate.id,
    ] as never[]);
    const reread = await getFaculty(existing.id);
    if (!reread) throw new Error('The faculty was updated and could not be read back.');
    return reread;
  }

  const id = newId('fac');
  await getDb().run(
    `INSERT INTO faculties
       (id, slug, ordinal, canonical_name, definition, definition_state, contract_state,
        implementation_state, evaluation_state, availability_state, freshness_state,
        source_id, candidate_id, amended_by_source_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CANONICAL', 'MISSING', 'ABSENT', 'UNTESTED', 'DISABLED', 'CURRENT',
             ?, ?, NULL, ?, ?)`,
    [
      id,
      candidate.slug,
      candidate.ordinal,
      candidate.canonicalName,
      toJson(candidate.definition),
      candidate.sourceId,
      candidate.id,
      at,
      at,
    ] as never[],
  );
  await recordStateEvent({
    facultyId: id,
    dimension: 'DEFINITION',
    fromState: 'MISSING',
    toState: 'CANONICAL',
    reason: `Promoted from candidate ${candidate.id} against source ${candidate.sourceId}.`,
    evidenceRef: input.auditId,
    actorType: input.actorType,
    actorId: input.actorId,
  });
  await setCandidateState({ id: candidate.id, state: 'PROMOTED', auditId: input.auditId });
  await getDb().run(`UPDATE faculty_candidates SET promoted_faculty_id = ? WHERE id = ?`, [
    id,
    candidate.id,
  ] as never[]);
  const created = await getFaculty(id);
  if (!created) throw new Error('The faculty was inserted and could not be read back.');
  return created;
}

export async function getFaculty(id: string): Promise<Faculty | null> {
  const row = await getDb().get<Row>(`SELECT * FROM faculties WHERE id = ?`, [id] as never[]);
  return row ? mapFaculty(row) : null;
}

export async function getFacultyBySlug(slug: string): Promise<Faculty | null> {
  const row = await getDb().get<Row>(`SELECT * FROM faculties WHERE slug = ?`, [slug] as never[]);
  return row ? mapFaculty(row) : null;
}

export async function listFaculties(): Promise<Faculty[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM faculties ORDER BY COALESCE(ordinal, 9999), slug`,
  );
  return rows.map(mapFaculty);
}

const DIMENSION_COLUMN: Record<FacultyDimension, string> = {
  DEFINITION: 'definition_state',
  CONTRACT: 'contract_state',
  IMPLEMENTATION: 'implementation_state',
  EVALUATION: 'evaluation_state',
  AVAILABILITY: 'availability_state',
  FRESHNESS: 'freshness_state',
};

/**
 * Move one dimension and say why, in one place.
 *
 * The column and the event are written together and neither is exposed on its
 * own, so there is no way to change what Brain believes without recording what
 * changed it. A move to the state it is already in is a no-op that records
 * nothing — history should hold changes, not ticks.
 */
export async function moveDimension(input: {
  facultyId: string;
  dimension: FacultyDimension;
  to: string;
  reason: string;
  evidenceRef?: string | null;
  actorType: string;
  actorId?: string | null;
  /** Set by an ingestion path, which may only move DEFINITION. */
  viaIngestion?: boolean;
}): Promise<boolean> {
  if (input.viaIngestion === true) assertIngestionScope(input.dimension);
  if (input.reason.trim().length === 0) {
    throw new Error('A dimension move must name its reason; "it changed" is not checkable later.');
  }
  const faculty = await getFaculty(input.facultyId);
  if (!faculty) throw new Error(`No such faculty: ${input.facultyId}`);

  const column = DIMENSION_COLUMN[input.dimension];
  const current = String((faculty as unknown as Record<string, unknown>)[camel(column)] ?? '');
  if (current === input.to) return false;

  await getDb().run(`UPDATE faculties SET ${column} = ?, updated_at = ? WHERE id = ?`, [
    input.to,
    nowIso(),
    input.facultyId,
  ] as never[]);
  await recordStateEvent({
    facultyId: input.facultyId,
    dimension: input.dimension,
    fromState: current,
    toState: input.to,
    reason: input.reason,
    evidenceRef: input.evidenceRef ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
  });
  return true;
}

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

async function recordStateEvent(input: {
  facultyId: string;
  dimension: FacultyDimension;
  fromState: string;
  toState: string;
  reason: string;
  evidenceRef: string | null;
  actorType: string;
  actorId: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO faculty_state_events
       (id, faculty_id, dimension, from_state, to_state, reason, evidence_ref,
        actor_type, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('fse'),
      input.facultyId,
      input.dimension,
      input.fromState,
      input.toState,
      input.reason,
      input.evidenceRef,
      input.actorType,
      input.actorId,
      nowIso(),
    ] as never[],
  );
}

export async function listStateEvents(facultyId: string): Promise<FacultyStateEvent[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM faculty_state_events WHERE faculty_id = ? ORDER BY created_at, id`,
    [facultyId] as never[],
  );
  return rows.map((row) => ({
    id: str(row, 'id'),
    facultyId: str(row, 'faculty_id'),
    dimension: str(row, 'dimension') as FacultyDimension,
    fromState: str(row, 'from_state'),
    toState: str(row, 'to_state'),
    reason: str(row, 'reason'),
    evidenceRef: strOrNull(row, 'evidence_ref'),
    actorType: str(row, 'actor_type'),
    actorId: strOrNull(row, 'actor_id'),
    createdAt: str(row, 'created_at'),
  }));
}

/* ------------------------------------------------------------------------- */
/* Relationships                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Record one edge, idempotently.
 *
 * An edge whose target faculty has not been promoted yet is **not** an error
 * and is **not** silently dropped: the caller resolves what it can and reports
 * what it could not, because the blueprint's own matrix names faculties in an
 * order that guarantees forward references. `linkPendingEdges` is what closes
 * them once the other end exists.
 */
export async function putRelationship(input: {
  fromFacultyId: string;
  toFacultyId: string | null;
  toComponent: string | null;
  relationship: FacultyRelationship;
  rationale: string;
  sourceId: string;
}): Promise<boolean> {
  if ((input.toFacultyId === null) === (input.toComponent === null)) {
    throw new Error('An edge must name exactly one endpoint.');
  }
  const existing = await getDb().get<Row>(
    `SELECT id FROM faculty_relationships
      WHERE from_faculty_id = ? AND relationship = ?
        AND COALESCE(to_faculty_id, '') = ? AND COALESCE(to_component, '') = ?`,
    [
      input.fromFacultyId,
      input.relationship,
      input.toFacultyId ?? '',
      input.toComponent ?? '',
    ] as never[],
  );
  if (existing) return false;
  await getDb().run(
    `INSERT INTO faculty_relationships
       (id, from_faculty_id, to_faculty_id, to_component, relationship, rationale, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('frl'),
      input.fromFacultyId,
      input.toFacultyId,
      input.toComponent,
      input.relationship,
      input.rationale,
      input.sourceId,
      nowIso(),
    ] as never[],
  );
  return true;
}

export async function listRelationships(facultyId?: string): Promise<FacultyEdge[]> {
  const rows = await getDb().all<Row>(
    facultyId
      ? `SELECT * FROM faculty_relationships WHERE from_faculty_id = ? OR to_faculty_id = ?
         ORDER BY created_at, id`
      : `SELECT * FROM faculty_relationships ORDER BY created_at, id`,
    (facultyId ? [facultyId, facultyId] : []) as never[],
  );
  return rows.map((row) => ({
    id: str(row, 'id'),
    fromFacultyId: str(row, 'from_faculty_id'),
    toFacultyId: strOrNull(row, 'to_faculty_id'),
    toComponent: strOrNull(row, 'to_component'),
    relationship: str(row, 'relationship') as FacultyRelationship,
    rationale: str(row, 'rationale'),
    sourceId: str(row, 'source_id'),
    createdAt: str(row, 'created_at'),
  }));
}
