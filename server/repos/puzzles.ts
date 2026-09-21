/**
 * Formats, masters, the puzzles themselves, what checked them, and what has
 * been asked about them.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 *
 * Two things here are append-only and have no update path at all.
 * `puzzle_instances` is immutable because a verdict is about bytes — §9's
 * extraction runs, at a generated artifact — and `puzzle_validations` is
 * append-only because a check that changed its mind is a fact worth keeping,
 * which is why the unique index is over the validator *version* rather than
 * over the check alone.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { slugFor } from '../domain/puzzles.ts';
import type {
  DistinctnessAxis,
  ProductClass,
  PuzzleEdition,
  PuzzleEditionInstance,
  PuzzleEditionInstanceRow,
  PuzzleEditionRow,
  PuzzleFormat,
  PuzzleFormatRow,
  PuzzleInstance,
  PuzzleInstanceRow,
  PuzzleMaster,
  PuzzleMasterRow,
  PuzzleOrigin,
  PuzzleRound,
  PuzzleRoundPurpose,
  PuzzleRoundRow,
  PuzzleValidation,
  PuzzleValidationRow,
  PuzzleVerdict,
  RightsBasis,
} from '../domain/types.ts';

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Parse JSON stored in a column, answering `{}` rather than throwing.
 *
 * A master whose spec could not be parsed is a defect worth seeing on a
 * screen; a repository that threw while listing would take the whole reading
 * down and show nothing at all. The generator refuses an unusable spec on its
 * own terms, which is where that refusal belongs.
 */
function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

function mapFormat(row: PuzzleFormatRow): PuzzleFormat {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    origin: row.origin as PuzzleOrigin,
    sourceClaimId: row.source_claim_id,
    declaredByRef: row.declared_by_ref,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Put a format on the map, or find the one already there.
 *
 * The slug is derived here rather than supplied, so a caller cannot choose the
 * key its own row is deduplicated on — the property every compare-and-swap in
 * this codebase rests on. Two spellings of one name become one row; two names
 * for one thing stay two rows, because joining them needs a reader.
 */
export async function upsertFormat(input: {
  projectId: string;
  name: string;
  description?: string | null;
  origin: PuzzleOrigin;
  sourceClaimId?: string | null;
  declaredByRef?: string | null;
}): Promise<{ format: PuzzleFormat; created: boolean }> {
  const name = tidy(input.name);
  const slug = slugFor(name);
  const id = newId('pfm');
  const at = nowIso();

  await getDb().run(
    `INSERT INTO puzzle_formats
       (id, project_id, slug, name, description, origin, source_claim_id, declared_by_ref,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      slug,
      name,
      input.description ? tidy(input.description) : null,
      input.origin,
      input.sourceClaimId ?? null,
      input.declaredByRef ?? null,
      at,
      at,
    ],
  );

  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? AND slug = ?',
    [input.projectId, slug],
  );
  if (!rows[0]) throw new Error('The puzzle format disappeared immediately after being written.');
  return { format: mapFormat(rows[0]), created: rows[0].id === id };
}

export async function getFormat(id: string): Promise<PuzzleFormat | null> {
  const row = await getDb().get<PuzzleFormatRow>('SELECT * FROM puzzle_formats WHERE id = ?', [id]);
  return row ? mapFormat(row) : null;
}

export async function listFormats(projectId: string): Promise<PuzzleFormat[]> {
  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapFormat);
}

/** Never a delete: a retired format is evidence about what was considered. */
export async function retireFormat(input: {
  id: string;
  projectId: string;
  reason: string;
}): Promise<PuzzleFormat | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_formats SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND retired_at IS NULL`,
    [at, tidy(input.reason), at, input.id, input.projectId],
  );
  return getFormat(input.id);
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

function mapMaster(row: PuzzleMasterRow): PuzzleMaster {
  return {
    id: row.id,
    projectId: row.project_id,
    formatId: row.format_id,
    name: row.name,
    generatorKey: row.generator_key,
    spec: parseObject(row.spec),
    generatorVersion: row.generator_version,
    rightsBasis: row.rights_basis as RightsBasis,
    rightsStatement: row.rights_statement,
    rightsClaimId: row.rights_claim_id,
    blockedAt: row.blocked_at,
    blockedReason: row.blocked_reason,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    declaredByRef: row.declared_by_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMaster(input: {
  projectId: string;
  formatId: string;
  name: string;
  generatorKey: string;
  generatorVersion: string;
  spec: Record<string, unknown>;
  rightsBasis: RightsBasis;
  rightsStatement: string | null;
  rightsClaimId?: string | null;
  declaredByRef?: string | null;
}): Promise<{ master: PuzzleMaster; created: boolean }> {
  const name = tidy(input.name);
  const id = newId('pmr');
  const at = nowIso();

  await getDb().run(
    `INSERT INTO puzzle_masters
       (id, project_id, format_id, name, generator_key, spec, generator_version, rights_basis,
        rights_statement, rights_claim_id, blocked_at, blocked_reason, retired_at, retired_reason,
        declared_by_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.formatId,
      name,
      input.generatorKey,
      JSON.stringify(input.spec),
      input.generatorVersion,
      input.rightsBasis,
      input.rightsStatement ? tidy(input.rightsStatement) : null,
      input.rightsClaimId ?? null,
      input.declaredByRef ?? null,
      at,
      at,
    ],
  );

  const rows = await getDb().all<PuzzleMasterRow>(
    'SELECT * FROM puzzle_masters WHERE project_id = ? AND name = ?',
    [input.projectId, name],
  );
  if (!rows[0]) throw new Error('The puzzle master disappeared immediately after being written.');
  return { master: mapMaster(rows[0]), created: rows[0].id === id };
}

export async function getMaster(id: string): Promise<PuzzleMaster | null> {
  const row = await getDb().get<PuzzleMasterRow>('SELECT * FROM puzzle_masters WHERE id = ?', [id]);
  return row ? mapMaster(row) : null;
}

export async function listMasters(projectId: string): Promise<PuzzleMaster[]> {
  const rows = await getDb().all<PuzzleMasterRow>(
    'SELECT * FROM puzzle_masters WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapMaster);
}

/**
 * Stop a master producing, because its output was systematically wrong.
 *
 * Guarded on it not already being blocked, so two ticks reaching the same
 * conclusion write one block and the first reason recorded is the one that
 * stands — a second would overwrite the evidence of what was actually seen
 * first.
 */
export async function blockMaster(input: {
  id: string;
  projectId: string;
  reason: string;
}): Promise<PuzzleMaster | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_masters SET blocked_at = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND blocked_at IS NULL`,
    [at, tidy(input.reason), at, input.id, input.projectId],
  );
  return getMaster(input.id);
}

/**
 * A person establishing the generator is repaired.
 *
 * Deliberately not something Brain does for itself. The block exists because
 * output was systematically wrong, and the thing that makes it right again is
 * a code change somebody reviewed — a Brain that cleared its own block by
 * generating a fresh batch would be doing exactly the "patch the outputs"
 * move the block exists to prevent.
 */
export async function unblockMaster(input: {
  id: string;
  projectId: string;
  generatorVersion: string;
}): Promise<PuzzleMaster | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_masters
        SET blocked_at = NULL, blocked_reason = NULL, generator_version = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND blocked_at IS NOT NULL`,
    [input.generatorVersion, at, input.id, input.projectId],
  );
  return getMaster(input.id);
}

export async function retireMaster(input: {
  id: string;
  projectId: string;
  reason: string;
}): Promise<PuzzleMaster | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_masters SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND retired_at IS NULL`,
    [at, tidy(input.reason), at, input.id, input.projectId],
  );
  return getMaster(input.id);
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

function mapInstance(row: PuzzleInstanceRow): PuzzleInstance {
  return {
    id: row.id,
    projectId: row.project_id,
    masterId: row.master_id,
    formatId: row.format_id,
    generatorKey: row.generator_key,
    generatorVersion: row.generator_version,
    seed: row.seed,
    payload: parseObject(row.payload),
    contentHash: row.content_hash,
    solutionHash: row.solution_hash,
    canonicalHash: row.canonical_hash,
    measuredDifficulty: row.measured_difficulty,
    difficultyBasis: row.difficulty_basis,
    createdAt: row.created_at,
  };
}

/**
 * Record one produced puzzle, or find the duplicate already there.
 *
 * `created: false` is an ordinary and expected outcome: a generator asked for
 * a hundred puzzles will re-find one it has already made, and that is the
 * duplicate rule working rather than an error. The caller counts them and
 * reports the rate, because a master whose output is mostly duplicates has run
 * out of room and that is worth knowing.
 */
export async function insertInstance(input: {
  projectId: string;
  masterId: string;
  formatId: string;
  generatorKey: string;
  generatorVersion: string;
  seed: string;
  payload: Record<string, unknown>;
  contentHash: string;
  solutionHash: string;
  canonicalHash: string;
  measuredDifficulty: number | null;
  difficultyBasis: string | null;
}): Promise<{ instance: PuzzleInstance; created: boolean }> {
  const id = newId('pin');
  const at = nowIso();

  await getDb().run(
    `INSERT INTO puzzle_instances
       (id, project_id, master_id, format_id, generator_key, generator_version, seed, payload,
        content_hash, solution_hash, canonical_hash, measured_difficulty, difficulty_basis,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.masterId,
      input.formatId,
      input.generatorKey,
      input.generatorVersion,
      input.seed,
      JSON.stringify(input.payload),
      input.contentHash,
      input.solutionHash,
      input.canonicalHash,
      input.measuredDifficulty,
      input.difficultyBasis,
      at,
    ],
  );

  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE project_id = ? AND format_id = ? AND canonical_hash = ?',
    [input.projectId, input.formatId, input.canonicalHash],
  );
  if (!rows[0]) throw new Error('The puzzle disappeared immediately after being written.');
  return { instance: mapInstance(rows[0]), created: rows[0].id === id };
}

export async function getInstance(id: string): Promise<PuzzleInstance | null> {
  const row = await getDb().get<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE id = ?',
    [id],
  );
  return row ? mapInstance(row) : null;
}

export async function listInstances(projectId: string): Promise<PuzzleInstance[]> {
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapInstance);
}

export async function listInstancesForMaster(masterId: string): Promise<PuzzleInstance[]> {
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE master_id = ? ORDER BY created_at ASC, id ASC',
    [masterId],
  );
  return rows.map(mapInstance);
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

function mapValidation(row: PuzzleValidationRow): PuzzleValidation {
  return {
    id: row.id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    checkKey: row.check_key,
    verdict: row.verdict as PuzzleVerdict,
    detail: row.detail,
    validatorKey: row.validator_key,
    validatorVersion: row.validator_version,
    contentHash: row.content_hash,
    ranAt: row.ran_at,
  };
}

export async function recordValidation(input: {
  projectId: string;
  instanceId: string;
  checkKey: string;
  verdict: PuzzleVerdict;
  detail: string | null;
  validatorKey: string;
  validatorVersion: string;
  contentHash: string;
}): Promise<{ validation: PuzzleValidation; created: boolean }> {
  const id = newId('pvl');
  const at = nowIso();

  await getDb().run(
    `INSERT INTO puzzle_validations
       (id, project_id, instance_id, check_key, verdict, detail, validator_key,
        validator_version, content_hash, ran_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.instanceId,
      input.checkKey,
      input.verdict,
      input.detail,
      input.validatorKey,
      input.validatorVersion,
      input.contentHash,
      at,
    ],
  );

  const rows = await getDb().all<PuzzleValidationRow>(
    `SELECT * FROM puzzle_validations
      WHERE instance_id = ? AND check_key = ? AND validator_version = ?`,
    [input.instanceId, input.checkKey, input.validatorVersion],
  );
  if (!rows[0]) throw new Error('The validation disappeared immediately after being written.');
  return { validation: mapValidation(rows[0]), created: rows[0].id === id };
}

export async function listValidations(projectId: string): Promise<PuzzleValidation[]> {
  const rows = await getDb().all<PuzzleValidationRow>(
    'SELECT * FROM puzzle_validations WHERE project_id = ? ORDER BY ran_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapValidation);
}

export async function listValidationsForInstance(instanceId: string): Promise<PuzzleValidation[]> {
  const rows = await getDb().all<PuzzleValidationRow>(
    'SELECT * FROM puzzle_validations WHERE instance_id = ? ORDER BY ran_at ASC, id ASC',
    [instanceId],
  );
  return rows.map(mapValidation);
}

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

function mapEdition(row: PuzzleEditionRow): PuzzleEdition {
  return {
    id: row.id,
    projectId: row.project_id,
    masterId: row.master_id,
    name: row.name,
    productClass: row.product_class as ProductClass,
    distinctnessAxis: row.distinctness_axis as DistinctnessAxis,
    distinctnessValue: row.distinctness_value,
    rationale: row.rationale,
    artifactKey: row.artifact_key,
    artifactHash: row.artifact_hash,
    compiledAt: row.compiled_at,
    declaredByRef: row.declared_by_ref,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createEdition(input: {
  projectId: string;
  masterId: string;
  name: string;
  productClass: ProductClass;
  distinctnessAxis: DistinctnessAxis;
  distinctnessValue: string | null;
  rationale: string;
  declaredByRef?: string | null;
}): Promise<{ edition: PuzzleEdition; created: boolean }> {
  const name = tidy(input.name);
  const id = newId('ped');
  const at = nowIso();

  await getDb().run(
    `INSERT INTO puzzle_editions
       (id, project_id, master_id, name, product_class, distinctness_axis, distinctness_value,
        rationale, artifact_key, artifact_hash, compiled_at, declared_by_ref, retired_at,
        retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.masterId,
      name,
      input.productClass,
      input.distinctnessAxis,
      input.distinctnessValue ? tidy(input.distinctnessValue) : null,
      tidy(input.rationale),
      input.declaredByRef ?? null,
      at,
      at,
    ],
  );

  const rows = await getDb().all<PuzzleEditionRow>(
    'SELECT * FROM puzzle_editions WHERE project_id = ? AND name = ?',
    [input.projectId, name],
  );
  if (!rows[0]) throw new Error('The edition disappeared immediately after being written.');
  return { edition: mapEdition(rows[0]), created: rows[0].id === id };
}

export async function getEdition(id: string): Promise<PuzzleEdition | null> {
  const row = await getDb().get<PuzzleEditionRow>('SELECT * FROM puzzle_editions WHERE id = ?', [
    id,
  ]);
  return row ? mapEdition(row) : null;
}

export async function listEditions(projectId: string): Promise<PuzzleEdition[]> {
  const rows = await getDb().all<PuzzleEditionRow>(
    'SELECT * FROM puzzle_editions WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapEdition);
}

function mapEditionInstance(row: PuzzleEditionInstanceRow): PuzzleEditionInstance {
  return {
    id: row.id,
    editionId: row.edition_id,
    instanceId: row.instance_id,
    position: row.position,
    createdAt: row.created_at,
  };
}

export async function addEditionInstance(input: {
  editionId: string;
  instanceId: string;
  position: number;
}): Promise<{ created: boolean }> {
  const id = newId('pei');
  await getDb().run(
    `INSERT INTO puzzle_edition_instances (id, edition_id, instance_id, position, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.editionId, input.instanceId, Math.max(0, Math.trunc(input.position)), nowIso()],
  );
  const row = await getDb().get<PuzzleEditionInstanceRow>(
    'SELECT * FROM puzzle_edition_instances WHERE edition_id = ? AND instance_id = ?',
    [input.editionId, input.instanceId],
  );
  return { created: row?.id === id };
}

export async function listEditionInstances(editionId: string): Promise<PuzzleEditionInstance[]> {
  const rows = await getDb().all<PuzzleEditionInstanceRow>(
    'SELECT * FROM puzzle_edition_instances WHERE edition_id = ? ORDER BY position ASC, id ASC',
    [editionId],
  );
  return rows.map(mapEditionInstance);
}

/** Every edition membership in one project, for the readings that compare siblings. */
export async function listAllEditionInstances(
  projectId: string,
): Promise<Map<string, PuzzleEditionInstance[]>> {
  const rows = await getDb().all<PuzzleEditionInstanceRow>(
    `SELECT pei.* FROM puzzle_edition_instances pei
       JOIN puzzle_editions pe ON pe.id = pei.edition_id
      WHERE pe.project_id = ?
      ORDER BY pei.position ASC, pei.id ASC`,
    [projectId],
  );
  const out = new Map<string, PuzzleEditionInstance[]>();
  for (const row of rows) {
    const list = out.get(row.edition_id) ?? [];
    list.push(mapEditionInstance(row));
    out.set(row.edition_id, list);
  }
  return out;
}

/**
 * Record that the artifact exists, guarded on it not already existing.
 *
 * A second compile of the same edition is refused rather than overwriting the
 * first, because the hash on the row is what a buyer's copy was built from and
 * replacing it would make every earlier statement about that edition
 * unverifiable. Recompiling is a new edition.
 */
export async function markEditionCompiled(input: {
  id: string;
  projectId: string;
  artifactKey: string;
  artifactHash: string;
}): Promise<PuzzleEdition | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_editions
        SET artifact_key = ?, artifact_hash = ?, compiled_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND compiled_at IS NULL`,
    [input.artifactKey, input.artifactHash, at, at, input.id, input.projectId],
  );
  return getEdition(input.id);
}

export async function retireEdition(input: {
  id: string;
  projectId: string;
  reason: string;
}): Promise<PuzzleEdition | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_editions SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND retired_at IS NULL`,
    [at, tidy(input.reason), at, input.id, input.projectId],
  );
  return getEdition(input.id);
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

function mapRound(row: PuzzleRoundRow): PuzzleRound {
  return {
    id: row.id,
    projectId: row.project_id,
    formatId: row.format_id,
    purpose: row.purpose as PuzzleRoundPurpose,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as PuzzleRound['state'],
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function openPuzzleRound(input: {
  projectId: string;
  formatId: string | null;
  purpose: PuzzleRoundPurpose;
  round: number;
  candidateId: string;
}): Promise<{ round: PuzzleRound; created: boolean }> {
  const id = newId('prn');
  const at = nowIso();
  const round = Math.max(1, Math.trunc(input.round));

  await getDb().run(
    `INSERT INTO puzzle_rounds
       (id, project_id, format_id, purpose, round, candidate_id, state, opened_at, harvested_at,
        found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.formatId, input.purpose, round, input.candidateId, at, at, at],
  );

  /*
   * Read back by the key the index actually uses. A format-scoped ask and the
   * universe ask have different unique indexes — one over the format, one over
   * the project — because the universe question names no format and two ticks
   * must still produce one of it.
   */
  const rows = input.formatId
    ? await getDb().all<PuzzleRoundRow>(
        `SELECT * FROM puzzle_rounds
          WHERE project_id = ? AND format_id = ? AND purpose = ? AND round = ?`,
        [input.projectId, input.formatId, input.purpose, round],
      )
    : await getDb().all<PuzzleRoundRow>(
        `SELECT * FROM puzzle_rounds
          WHERE project_id = ? AND format_id IS NULL AND purpose = ? AND round = ?`,
        [input.projectId, input.purpose, round],
      );
  if (!rows[0]) throw new Error('The puzzle round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

/**
 * Settle a round with what it established.
 *
 * Guarded on it still being OPEN, so a redelivery settles it once and the
 * count recorded is the one the winning pass actually counted.
 */
export async function closePuzzleRound(input: {
  id: string;
  state: 'HARVESTED' | 'ABANDONED';
  found: number;
}): Promise<boolean> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_rounds SET state = ?, harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.state, at, Math.max(0, Math.trunc(input.found)), at, input.id],
  );
  const row = await getDb().get<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE id = ?',
    [input.id],
  );
  // Whether *this* call settled it. A loser reports nothing rather than
  // claiming a settlement it did not make.
  return row?.state === input.state && row.harvested_at === at;
}

export async function listRounds(projectId: string): Promise<PuzzleRound[]> {
  const rows = await getDb().all<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE project_id = ? ORDER BY opened_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRound);
}

export async function openRoundsByCandidate(projectId: string): Promise<Map<string, PuzzleRound>> {
  const rows = await getDb().all<PuzzleRoundRow>(
    "SELECT * FROM puzzle_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

/** Whether a candidate is a puzzle round's, for the compiler's envelope choice. */
export async function puzzleRoundForCandidate(candidateId: string): Promise<PuzzleRound | null> {
  const row = await getDb().get<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return row ? mapRound(row) : null;
}
