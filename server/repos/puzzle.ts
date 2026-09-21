/**
 * The universe, the standards, the rights, the masters, the instances they
 * generated, the validation runs that judged them, the outputs compiled from
 * them, the monetization ledger, the economics, the rounds and what attempts
 * taught.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 *
 * **Nothing here derives anything.** There is no maturity, no qualification,
 * no leverage multiplier, no contribution and no rank in this file — those are
 * read from these rows by `services/puzzle/`, on the read path, and stored
 * nowhere.
 *
 * **There is no delete anywhere in this file.** Not for a route, which the
 * directive says never to delete or hide; not for an instance or a validation,
 * which are the provenance of every product compiled from them; and not for an
 * observation, which is the only record of what an attempt taught. Retiring
 * sets a timestamp and a reason and destroys nothing — §5.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import { formatKey, routeKey } from '../domain/puzzle.ts';
import type {
  DemandPosture,
  DifferentiatorAxis,
  EconomicComponent,
  ProductionClass,
  PuzzleEconomicLine,
  PuzzleEconomicsRow,
  PuzzleFormat,
  PuzzleFormatRow,
  PuzzleInstance,
  PuzzleInstanceRow,
  PuzzleMaster,
  PuzzleMasterRow,
  PuzzleObservation,
  PuzzleObservationKind,
  PuzzleObservationRow,
  PuzzleOrigin,
  PuzzleOutput,
  PuzzleOutputMember,
  PuzzleOutputMemberRow,
  PuzzleOutputRow,
  PuzzlePayload,
  PuzzleRightsConstraint,
  PuzzleRightsRow,
  PuzzleRound,
  PuzzleRoundPurpose,
  PuzzleRoundRow,
  PuzzleRoundState,
  PuzzleRoute,
  PuzzleRouteEvidence,
  PuzzleRouteEvidenceRow,
  PuzzleRouteRow,
  PuzzleStandard,
  PuzzleStandardRow,
  PuzzleValidation,
  PuzzleValidationRow,
  RightsKind,
  RouteClass,
  RouteDisposition,
  ValidationCheck,
  ValidationCheckResult,
  ValidationVerdict,
} from '../domain/types.ts';

const tidy = (value: string): string => value.replace(/\s+/g, ' ').trim();

/* --------------------------------------------------------------------------
 * Formats — the universe
 * ------------------------------------------------------------------------ */

function mapFormat(row: PuzzleFormatRow): PuzzleFormat {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    formatKey: row.format_key,
    audience: row.audience,
    note: row.note,
    origin: row.origin as PuzzleOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createFormat(input: {
  projectId: string;
  name: string;
  audience?: string | null;
  note?: string | null;
  origin: PuzzleOrigin;
  sourceClaimId?: string | null;
}): Promise<{ format: PuzzleFormat; created: boolean }> {
  const name = tidy(input.name);
  if (!name) throw new Error('A format must have a name.');
  /*
   * The schema says this too, and both are deliberate. A CHECK stops a row
   * being written whatever reaches the database; this names the rule in the
   * words a caller can act on. `SEED` is the one origin Brain may never write,
   * because a machine that could name its own formats would be deciding what
   * the universe is.
   */
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded format may exist without the claim that established it.');
  }
  const key = formatKey(name);
  const id = newId('pzf');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_formats
       (id, project_id, name, format_key, audience, note, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      name,
      key,
      input.audience ?? null,
      input.note ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? AND format_key = ?',
    [input.projectId, key],
  );
  if (!rows[0]) throw new Error('The format disappeared immediately after being written.');
  return { format: mapFormat(rows[0]), created: rows[0].id === id };
}

export async function listFormats(projectId: string): Promise<PuzzleFormat[]> {
  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapFormat);
}

export async function getFormatByKey(
  projectId: string,
  key: string,
): Promise<PuzzleFormat | null> {
  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? AND format_key = ?',
    [projectId, formatKey(key)],
  );
  return rows[0] ? mapFormat(rows[0]) : null;
}

/** Retiring destroys nothing: a deleted format arrives again on the next round as a discovery. */
export async function retireFormat(input: {
  id: string;
  reason: string;
}): Promise<PuzzleFormat | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_formats SET retired_at = ?, retired_reason = ?, updated_at = ?
     WHERE id = ? AND retired_at IS NULL`,
    [at, input.reason, at, input.id],
  );
  const rows = await getDb().all<PuzzleFormatRow>('SELECT * FROM puzzle_formats WHERE id = ?', [
    input.id,
  ]);
  return rows[0] ? mapFormat(rows[0]) : null;
}

/* --------------------------------------------------------------------------
 * Standards — what a good one of these must satisfy
 * ------------------------------------------------------------------------ */

function mapStandard(row: PuzzleStandardRow): PuzzleStandard {
  return {
    id: row.id,
    projectId: row.project_id,
    formatKey: row.format_key,
    checkKind: row.check_kind as ValidationCheck,
    statement: row.statement,
    authority: row.authority,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordStandard(input: {
  projectId: string;
  formatKey: string;
  checkKind: ValidationCheck;
  statement: string;
  authority?: string | null;
  sourceClaimId: string;
}): Promise<{ standard: PuzzleStandard; created: boolean }> {
  const key = formatKey(input.formatKey);
  const id = newId('pzs');
  await getDb().run(
    `INSERT INTO puzzle_standards
       (id, project_id, format_key, check_kind, statement, authority, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      key,
      input.checkKind,
      input.statement,
      input.authority ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleStandardRow>(
    `SELECT * FROM puzzle_standards
     WHERE project_id = ? AND format_key = ? AND check_kind = ? AND source_claim_id = ?`,
    [input.projectId, key, input.checkKind, input.sourceClaimId],
  );
  if (!rows[0]) throw new Error('The standard disappeared immediately after being written.');
  return { standard: mapStandard(rows[0]), created: rows[0].id === id };
}

export async function listStandards(projectId: string): Promise<PuzzleStandard[]> {
  const rows = await getDb().all<PuzzleStandardRow>(
    'SELECT * FROM puzzle_standards WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapStandard);
}

/* --------------------------------------------------------------------------
 * Rights — what we may not do
 * ------------------------------------------------------------------------ */

function mapRights(row: PuzzleRightsRow): PuzzleRightsConstraint {
  return {
    id: row.id,
    projectId: row.project_id,
    formatKey: row.format_key,
    rightsKind: row.rights_kind as RightsKind,
    statement: row.statement,
    authority: row.authority,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordRightsConstraint(input: {
  projectId: string;
  formatKey: string;
  rightsKind: RightsKind;
  statement: string;
  authority?: string | null;
  sourceClaimId: string;
}): Promise<{ constraint: PuzzleRightsConstraint; created: boolean }> {
  const key = formatKey(input.formatKey);
  const id = newId('pzr');
  await getDb().run(
    `INSERT INTO puzzle_rights
       (id, project_id, format_key, rights_kind, statement, authority, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      key,
      input.rightsKind,
      input.statement,
      input.authority ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleRightsRow>(
    `SELECT * FROM puzzle_rights
     WHERE project_id = ? AND format_key = ? AND rights_kind = ? AND source_claim_id = ?`,
    [input.projectId, key, input.rightsKind, input.sourceClaimId],
  );
  if (!rows[0]) throw new Error('The constraint disappeared immediately after being written.');
  return { constraint: mapRights(rows[0]), created: rows[0].id === id };
}

export async function listRightsConstraints(
  projectId: string,
): Promise<PuzzleRightsConstraint[]> {
  const rows = await getDb().all<PuzzleRightsRow>(
    'SELECT * FROM puzzle_rights WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRights);
}

/* --------------------------------------------------------------------------
 * Masters — the reusable production system
 * ------------------------------------------------------------------------ */

function mapMaster(row: PuzzleMasterRow): PuzzleMaster {
  return {
    id: row.id,
    projectId: row.project_id,
    formatKey: row.format_key,
    name: row.name,
    engineId: row.engine_id,
    engineVersion: row.engine_version,
    params: parseJson<Record<string, unknown>>(row.params_json, {}),
    corpusRef: row.corpus_ref,
    rightsBasis: row.rights_basis,
    reviewedAt: row.reviewed_at,
    reviewedById: row.reviewed_by_id,
    reviewedNote: row.reviewed_note,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMaster(input: {
  projectId: string;
  formatKey: string;
  name: string;
  engineId: string;
  engineVersion: string;
  params: Record<string, unknown>;
  corpusRef?: string | null;
  rightsBasis: string;
}): Promise<{ master: PuzzleMaster; created: boolean }> {
  const name = tidy(input.name);
  if (!name) throw new Error('A master must have a name.');
  /*
   * The rights standard, refused here as well as by the NOT NULL column. The
   * directive is explicit that scraped or lightly-rewritten source material is
   * the one thing this business may not be built on, and a generator whose
   * corpus nobody has accounted for is exactly that with a layer of
   * indirection.
   */
  const rightsBasis = tidy(input.rightsBasis);
  if (!rightsBasis) {
    throw new Error(
      'A master must state the basis on which its source material may be sold. A generator ' +
        'whose corpus nobody has accounted for is the one thing this catalog may not contain.',
    );
  }
  const id = newId('pzm');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_masters
       (id, project_id, format_key, name, engine_id, engine_version, params_json,
        corpus_ref, rights_basis, reviewed_at, reviewed_by_id, reviewed_note,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      formatKey(input.formatKey),
      name,
      input.engineId,
      input.engineVersion,
      toJson(input.params),
      input.corpusRef ?? null,
      rightsBasis,
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleMasterRow>(
    'SELECT * FROM puzzle_masters WHERE project_id = ? AND name = ?',
    [input.projectId, name],
  );
  if (!rows[0]) throw new Error('The master disappeared immediately after being written.');
  return { master: mapMaster(rows[0]), created: rows[0].id === id };
}

export async function getMaster(id: string): Promise<PuzzleMaster | null> {
  const rows = await getDb().all<PuzzleMasterRow>('SELECT * FROM puzzle_masters WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapMaster(rows[0]) : null;
}

export async function listMasters(projectId: string): Promise<PuzzleMaster[]> {
  const rows = await getDb().all<PuzzleMasterRow>(
    'SELECT * FROM puzzle_masters WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapMaster);
}

/**
 * A person's editorial review of a generator or template.
 *
 * The directive requires it of every new generator, and nothing automatic can
 * write it: the guard on `reviewed_at IS NULL` makes it single-shot, so a
 * second review does not quietly overwrite the first reviewer's name.
 */
export async function recordMasterReview(input: {
  id: string;
  reviewedById: string;
  note: string;
}): Promise<PuzzleMaster | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_masters
        SET reviewed_at = ?, reviewed_by_id = ?, reviewed_note = ?, updated_at = ?
      WHERE id = ? AND reviewed_at IS NULL`,
    [at, input.reviewedById, input.note, at, input.id],
  );
  return getMaster(input.id);
}

export async function retireMaster(input: {
  id: string;
  reason: string;
}): Promise<PuzzleMaster | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_masters SET retired_at = ?, retired_reason = ?, updated_at = ?
     WHERE id = ? AND retired_at IS NULL`,
    [at, input.reason, at, input.id],
  );
  return getMaster(input.id);
}

/* --------------------------------------------------------------------------
 * Instances — what a generator produced
 * ------------------------------------------------------------------------ */

function mapInstance(row: PuzzleInstanceRow): PuzzleInstance {
  return {
    id: row.id,
    projectId: row.project_id,
    masterId: row.master_id,
    formatKey: row.format_key,
    seed: row.seed,
    engineId: row.engine_id,
    engineVersion: row.engine_version,
    payload: parseJson<PuzzlePayload>(row.payload_json, {
      puzzle: null,
      solution: null,
      answerKey: null,
      instructions: '',
      meta: {},
    }),
    contentHash: row.content_hash,
    difficulty: row.difficulty,
    expectedSolveSeconds: row.expected_solve_seconds,
    locale: row.locale,
    createdAt: row.created_at,
  };
}

/**
 * Record one generated puzzle.
 *
 * `created: false` is the duplicate gate the directive asks for, and it is an
 * ordinary outcome rather than an error: two runs that produced the same
 * puzzle are one puzzle, whatever seed reached them. The caller counts it
 * as a duplicate and carries on, which is what makes a batch's duplicate rate
 * a measurement rather than a guess.
 */
export async function recordInstance(input: {
  projectId: string;
  masterId: string;
  formatKey: string;
  seed: string;
  engineId: string;
  engineVersion: string;
  payload: PuzzlePayload;
  contentHash: string;
  difficulty?: string | null;
  expectedSolveSeconds?: number | null;
  locale?: string | null;
}): Promise<{ instance: PuzzleInstance; created: boolean }> {
  const id = newId('pzi');
  await getDb().run(
    `INSERT INTO puzzle_instances
       (id, project_id, master_id, format_key, seed, engine_id, engine_version,
        payload_json, content_hash, difficulty, expected_solve_seconds, locale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.masterId,
      formatKey(input.formatKey),
      input.seed,
      input.engineId,
      input.engineVersion,
      toJson(input.payload),
      input.contentHash,
      input.difficulty ?? null,
      input.expectedSolveSeconds ?? null,
      input.locale ?? null,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE project_id = ? AND content_hash = ?',
    [input.projectId, input.contentHash],
  );
  if (!rows[0]) throw new Error('The instance disappeared immediately after being written.');
  return { instance: mapInstance(rows[0]), created: rows[0].id === id };
}

export async function getInstance(id: string): Promise<PuzzleInstance | null> {
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE id = ?',
    [id],
  );
  return rows[0] ? mapInstance(rows[0]) : null;
}

export async function listInstancesForMaster(masterId: string): Promise<PuzzleInstance[]> {
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE master_id = ? ORDER BY created_at ASC, id ASC',
    [masterId],
  );
  return rows.map(mapInstance);
}

export async function listInstances(projectId: string): Promise<PuzzleInstance[]> {
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapInstance);
}

/* --------------------------------------------------------------------------
 * Validations — append-only, exactly one current
 * ------------------------------------------------------------------------ */

function mapValidation(row: PuzzleValidationRow): PuzzleValidation {
  return {
    id: row.id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    validatorId: row.validator_id,
    validatorVersion: row.validator_version,
    verdict: row.verdict as ValidationVerdict,
    checks: parseJson<ValidationCheckResult[]>(row.checks_json, []),
    failedCheck: (row.failed_check as ValidationCheck | null) ?? null,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/**
 * Record a validation run, superseding whatever was current.
 *
 * §9's extraction shape, for §9's reason: a validation recorded months ago
 * must still resolve to the checks that actually ran, so nothing is edited and
 * the previous run keeps its row, its verdict and its timestamp. The
 * supersession happens first, so a reader that lands between the two statements
 * sees no current run rather than two — which every reader here treats as
 * "not validated", the safe direction.
 */
export async function recordValidation(input: {
  projectId: string;
  instanceId: string;
  validatorId: string;
  validatorVersion: string;
  verdict: ValidationVerdict;
  checks: ValidationCheckResult[];
  failedCheck?: ValidationCheck | null;
}): Promise<PuzzleValidation> {
  const at = nowIso();
  await getDb().run(
    'UPDATE puzzle_validations SET superseded_at = ? WHERE instance_id = ? AND superseded_at IS NULL',
    [at, input.instanceId],
  );
  const id = newId('pzv');
  await getDb().run(
    `INSERT INTO puzzle_validations
       (id, project_id, instance_id, validator_id, validator_version, verdict,
        checks_json, failed_check, superseded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id,
      input.projectId,
      input.instanceId,
      input.validatorId,
      input.validatorVersion,
      input.verdict,
      toJson(input.checks),
      input.failedCheck ?? null,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleValidationRow>(
    'SELECT * FROM puzzle_validations WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The validation disappeared immediately after being written.');
  return mapValidation(rows[0]);
}

/**
 * The current run for one instance, or null where nothing has validated it.
 *
 * Null is never "fine". Every reader in this kernel treats an instance with no
 * current PASSED run as something it does not have — §9's rule that a BLOCKED
 * document is not an empty document.
 */
export async function currentValidation(instanceId: string): Promise<PuzzleValidation | null> {
  const rows = await getDb().all<PuzzleValidationRow>(
    `SELECT * FROM puzzle_validations
      WHERE instance_id = ? AND superseded_at IS NULL
      ORDER BY created_at DESC, id DESC`,
    [instanceId],
  );
  return rows[0] ? mapValidation(rows[0]) : null;
}

export async function currentValidations(projectId: string): Promise<PuzzleValidation[]> {
  const rows = await getDb().all<PuzzleValidationRow>(
    `SELECT * FROM puzzle_validations
      WHERE project_id = ? AND superseded_at IS NULL
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapValidation);
}

export async function validationHistory(instanceId: string): Promise<PuzzleValidation[]> {
  const rows = await getDb().all<PuzzleValidationRow>(
    'SELECT * FROM puzzle_validations WHERE instance_id = ? ORDER BY created_at ASC, id ASC',
    [instanceId],
  );
  return rows.map(mapValidation);
}

/* --------------------------------------------------------------------------
 * Routes — the monetization possibility ledger
 * ------------------------------------------------------------------------ */

function mapRoute(row: PuzzleRouteRow): PuzzleRoute {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    routeKey: row.route_key,
    routeClass: row.route_class as RouteClass,
    note: row.note,
    disposition: row.disposition as RouteDisposition,
    dispositionReason: row.disposition_reason,
    dispositionById: row.disposition_by_id,
    dispositionAt: row.disposition_at,
    origin: row.origin as PuzzleOrigin,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createRoute(input: {
  projectId: string;
  name: string;
  routeClass: RouteClass;
  note?: string | null;
  origin: PuzzleOrigin;
  sourceClaimId?: string | null;
}): Promise<{ route: PuzzleRoute; created: boolean }> {
  const name = tidy(input.name);
  if (!name) throw new Error('A route must have a name.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded route may exist without the claim that established it.');
  }
  const key = routeKey(name);
  const id = newId('pzt');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_routes
       (id, project_id, name, route_key, route_class, note, disposition,
        disposition_reason, disposition_by_id, disposition_at, origin, source_claim_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      name,
      key,
      input.routeClass,
      input.note ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleRouteRow>(
    'SELECT * FROM puzzle_routes WHERE project_id = ? AND route_key = ?',
    [input.projectId, key],
  );
  if (!rows[0]) throw new Error('The route disappeared immediately after being written.');
  return { route: mapRoute(rows[0]), created: rows[0].id === id };
}

export async function listRoutes(projectId: string): Promise<PuzzleRoute[]> {
  const rows = await getDb().all<PuzzleRouteRow>(
    'SELECT * FROM puzzle_routes WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRoute);
}

export async function getRoute(id: string): Promise<PuzzleRoute | null> {
  const rows = await getDb().all<PuzzleRouteRow>('SELECT * FROM puzzle_routes WHERE id = ?', [id]);
  return rows[0] ? mapRoute(rows[0]) : null;
}

/**
 * A person's disposition on a route.
 *
 * Only a person's: `byId` is required and the schema's CHECK refuses a
 * non-default disposition with nobody's name or no reason on it. Nothing in
 * this kernel blocks, archives or rejects a route by itself — the directive
 * says the slower and lower-ranked paths stay, and a machine that could
 * archive them would be deleting the ledger one row at a time.
 */
export async function setRouteDisposition(input: {
  id: string;
  disposition: RouteDisposition;
  reason: string;
  byId: string;
}): Promise<PuzzleRoute | null> {
  if (input.disposition !== 'ACTIVE' && !tidy(input.reason)) {
    throw new Error('A disposition that is not ACTIVE must say why.');
  }
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_routes
        SET disposition = ?, disposition_reason = ?, disposition_by_id = ?,
            disposition_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.disposition,
      input.disposition === 'ACTIVE' ? null : tidy(input.reason),
      input.disposition === 'ACTIVE' ? null : input.byId,
      input.disposition === 'ACTIVE' ? null : at,
      at,
      input.id,
    ],
  );
  return getRoute(input.id);
}

/* --------------------------------------------------------------------------
 * Route evidence — whether anybody is actually buying
 * ------------------------------------------------------------------------ */

function mapRouteEvidence(row: PuzzleRouteEvidenceRow): PuzzleRouteEvidence {
  return {
    id: row.id,
    projectId: row.project_id,
    routeId: row.route_id,
    posture: row.posture as DemandPosture,
    buyer: row.buyer,
    formatKey: row.format_key,
    statement: row.statement,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordRouteEvidence(input: {
  projectId: string;
  routeId: string;
  posture: DemandPosture;
  buyer: string;
  formatKey?: string | null;
  statement: string;
  observedOn?: string | null;
  sourceClaimId: string;
}): Promise<PuzzleRouteEvidence> {
  if (input.posture === 'DEMAND_FOUND' && !input.observedOn) {
    throw new Error(
      'A demand signal must carry the date the source observed it. An undated signal cannot ' +
        'be told apart from one somebody remembers from years ago.',
    );
  }
  const id = newId('pze');
  await getDb().run(
    `INSERT INTO puzzle_route_evidence
       (id, project_id, route_id, posture, buyer, format_key, statement, observed_on,
        source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.routeId,
      input.posture,
      input.buyer,
      input.formatKey ? formatKey(input.formatKey) : null,
      input.statement,
      input.observedOn ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleRouteEvidenceRow>(
    'SELECT * FROM puzzle_route_evidence WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The evidence disappeared immediately after being written.');
  return mapRouteEvidence(rows[0]);
}

export async function listRouteEvidence(projectId: string): Promise<PuzzleRouteEvidence[]> {
  const rows = await getDb().all<PuzzleRouteEvidenceRow>(
    'SELECT * FROM puzzle_route_evidence WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRouteEvidence);
}

/* --------------------------------------------------------------------------
 * Economics
 * ------------------------------------------------------------------------ */

function mapEconomics(row: PuzzleEconomicsRow): PuzzleEconomicLine {
  return {
    id: row.id,
    projectId: row.project_id,
    routeId: row.route_id,
    formatKey: row.format_key,
    outputId: row.output_id,
    component: row.component as EconomicComponent,
    basis: row.basis,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    statement: row.statement,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordEconomicLine(input: {
  projectId: string;
  routeId?: string | null;
  formatKey?: string | null;
  outputId?: string | null;
  component: EconomicComponent;
  basis: string;
  amountMinor: number;
  currency: string;
  statement: string;
  observedOn?: string | null;
  sourceClaimId: string;
}): Promise<PuzzleEconomicLine> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new Error('An economic line must carry a non-negative whole number of minor units.');
  }
  if (!tidy(input.basis)) {
    throw new Error('An economic line must say what its figure is per.');
  }
  const id = newId('pzn');
  await getDb().run(
    `INSERT INTO puzzle_economics
       (id, project_id, route_id, format_key, output_id, component, basis,
        amount_minor, currency, statement, observed_on, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.routeId ?? null,
      input.formatKey ? formatKey(input.formatKey) : null,
      input.outputId ?? null,
      input.component,
      tidy(input.basis),
      input.amountMinor,
      input.currency.toUpperCase(),
      input.statement,
      input.observedOn ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleEconomicsRow>(
    'SELECT * FROM puzzle_economics WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The economic line disappeared immediately after being written.');
  return mapEconomics(rows[0]);
}

export async function listEconomics(projectId: string): Promise<PuzzleEconomicLine[]> {
  const rows = await getDb().all<PuzzleEconomicsRow>(
    'SELECT * FROM puzzle_economics WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapEconomics);
}

/* --------------------------------------------------------------------------
 * Outputs
 * ------------------------------------------------------------------------ */

function mapOutput(row: PuzzleOutputRow): PuzzleOutput {
  return {
    id: row.id,
    projectId: row.project_id,
    masterId: row.master_id,
    title: row.title,
    productionClass: row.production_class as ProductionClass,
    differentiators: parseJson<DifferentiatorAxis[]>(row.differentiators_json, []),
    targetBuyer: row.target_buyer,
    routeId: row.route_id,
    releasedAt: row.released_at,
    releasedById: row.released_by_id,
    opportunityId: row.opportunity_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createOutput(input: {
  projectId: string;
  masterId: string;
  title: string;
  productionClass: ProductionClass;
  differentiators: DifferentiatorAxis[];
  targetBuyer?: string | null;
  routeId?: string | null;
}): Promise<{ output: PuzzleOutput; created: boolean }> {
  const title = tidy(input.title);
  if (!title) throw new Error('An output must have a title.');
  const id = newId('pzo');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_outputs
       (id, project_id, master_id, title, production_class, differentiators_json,
        target_buyer, route_id, released_at, released_by_id, opportunity_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.masterId,
      title,
      input.productionClass,
      toJson(input.differentiators),
      input.targetBuyer ?? null,
      input.routeId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleOutputRow>(
    'SELECT * FROM puzzle_outputs WHERE project_id = ? AND title = ?',
    [input.projectId, title],
  );
  if (!rows[0]) throw new Error('The output disappeared immediately after being written.');
  return { output: mapOutput(rows[0]), created: rows[0].id === id };
}

export async function getOutput(id: string): Promise<PuzzleOutput | null> {
  const rows = await getDb().all<PuzzleOutputRow>('SELECT * FROM puzzle_outputs WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapOutput(rows[0]) : null;
}

export async function listOutputs(projectId: string): Promise<PuzzleOutput[]> {
  const rows = await getDb().all<PuzzleOutputRow>(
    'SELECT * FROM puzzle_outputs WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapOutput);
}

export async function addOutputMember(input: {
  outputId: string;
  instanceId: string;
  position: number;
}): Promise<{ member: PuzzleOutputMember; created: boolean }> {
  const id = newId('pzp');
  await getDb().run(
    `INSERT INTO puzzle_output_members (id, output_id, instance_id, position, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.outputId, input.instanceId, input.position, nowIso()],
  );
  const rows = await getDb().all<PuzzleOutputMemberRow>(
    'SELECT * FROM puzzle_output_members WHERE output_id = ? AND instance_id = ?',
    [input.outputId, input.instanceId],
  );
  if (!rows[0]) throw new Error('The member disappeared immediately after being written.');
  return {
    member: {
      id: rows[0].id,
      outputId: rows[0].output_id,
      instanceId: rows[0].instance_id,
      position: rows[0].position,
      createdAt: rows[0].created_at,
    },
    created: rows[0].id === id,
  };
}

export async function listOutputMembers(outputId: string): Promise<PuzzleOutputMember[]> {
  const rows = await getDb().all<PuzzleOutputMemberRow>(
    'SELECT * FROM puzzle_output_members WHERE output_id = ? ORDER BY position ASC, id ASC',
    [outputId],
  );
  return rows.map((row) => ({
    id: row.id,
    outputId: row.output_id,
    instanceId: row.instance_id,
    position: row.position,
    createdAt: row.created_at,
  }));
}

/**
 * A person's release decision.
 *
 * Guarded on `released_at IS NULL`, so it is single-shot and a second call
 * does not overwrite the first releaser's name. Nothing automatic can reach
 * it: publishing under the operator's identity is outside everything this
 * kernel may do.
 */
export async function releaseOutput(input: {
  id: string;
  byId: string;
}): Promise<PuzzleOutput | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_outputs SET released_at = ?, released_by_id = ?, updated_at = ?
      WHERE id = ? AND released_at IS NULL`,
    [at, input.byId, at, input.id],
  );
  return getOutput(input.id);
}

export async function linkOutputOpportunity(input: {
  id: string;
  opportunityId: string;
}): Promise<PuzzleOutput | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_outputs SET opportunity_id = ?, updated_at = ?
      WHERE id = ? AND opportunity_id IS NULL`,
    [input.opportunityId, at, input.id],
  );
  return getOutput(input.id);
}

export async function retireOutput(input: {
  id: string;
  reason: string;
}): Promise<PuzzleOutput | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_outputs SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, input.reason, at, input.id],
  );
  return getOutput(input.id);
}

/* --------------------------------------------------------------------------
 * Rounds
 * ------------------------------------------------------------------------ */

function mapRound(row: PuzzleRoundRow): PuzzleRound {
  return {
    id: row.id,
    projectId: row.project_id,
    purpose: row.purpose as PuzzleRoundPurpose,
    subjectKey: row.subject_key,
    subjectLabel: row.subject_label,
    round: row.round,
    candidateId: row.candidate_id,
    why: row.why,
    state: row.state as PuzzleRoundState,
    found: row.found,
    settledAt: row.settled_at,
    settledReason: row.settled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open a round.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index on the live
 * rounds, so two ticks both deciding correctly produce one round and the loser
 * is an ordinary outcome rather than an error — the exclusion is the database,
 * never the allocator, which is pure and therefore useless as a safety
 * mechanism.
 */
export async function openRound(input: {
  projectId: string;
  purpose: PuzzleRoundPurpose;
  subjectKey?: string | null;
  subjectLabel?: string | null;
  round: number;
  candidateId: string;
  why: string;
}): Promise<{ round: PuzzleRound; created: boolean }> {
  const id = newId('pzq');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_rounds
       (id, project_id, purpose, subject_key, subject_label, round, candidate_id, why,
        state, found, settled_at, settled_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.purpose,
      input.subjectKey ?? null,
      input.subjectLabel ?? null,
      input.round,
      input.candidateId,
      input.why,
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleRoundRow>('SELECT * FROM puzzle_rounds WHERE id = ?', [id]);
  if (rows[0]) return { round: mapRound(rows[0]), created: true };

  /*
   * The loser reads back whichever live round won. Not an error: two ticks
   * deciding correctly is exactly what the partial unique index is for.
   */
  const live = await getDb().all<PuzzleRoundRow>(
    input.subjectKey
      ? `SELECT * FROM puzzle_rounds
          WHERE project_id = ? AND purpose = ? AND subject_key = ? AND state = 'OPEN'`
      : `SELECT * FROM puzzle_rounds
          WHERE project_id = ? AND purpose = ? AND subject_key IS NULL AND state = 'OPEN'`,
    input.subjectKey
      ? [input.projectId, input.purpose, input.subjectKey]
      : [input.projectId, input.purpose],
  );
  if (!live[0]) throw new Error('The round was refused and no live round explains why.');
  return { round: mapRound(live[0]), created: false };
}

export async function listRounds(projectId: string): Promise<PuzzleRound[]> {
  const rows = await getDb().all<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRound);
}

export async function roundForCandidate(candidateId: string): Promise<PuzzleRound | null> {
  const rows = await getDb().all<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

/** Every live round, keyed by the candidate that asked it. */
export async function openRoundsByCandidate(
  projectId: string,
): Promise<Map<string, PuzzleRound>> {
  const rows = await getDb().all<PuzzleRoundRow>(
    `SELECT * FROM puzzle_rounds WHERE project_id = ? AND state = 'OPEN'
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  const out = new Map<string, PuzzleRound>();
  for (const row of rows) out.set(row.candidate_id, mapRound(row));
  return out;
}

/**
 * Settle a round with what it established.
 *
 * `found` is supplied by the caller from a **count of rows**, never tallied
 * from what one pass happened to write. §33 and §45 both record the defect:
 * claims are filed on the pass they are gated and a round settles on a later
 * one, so a tick that dies between them makes a round that established five
 * things record none — and `BARREN_ROUNDS` of those retires the question that
 * was working best.
 */
export async function settleRound(input: {
  id: string;
  state: Exclude<PuzzleRoundState, 'OPEN'>;
  found: number;
  reason: string;
}): Promise<PuzzleRound | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_rounds
        SET state = ?, found = ?, settled_at = ?, settled_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.state, input.found, at, input.reason, at, input.id],
  );
  const rows = await getDb().all<PuzzleRoundRow>('SELECT * FROM puzzle_rounds WHERE id = ?', [
    input.id,
  ]);
  return rows[0] ? mapRound(rows[0]) : null;
}

/* --------------------------------------------------------------------------
 * Observations
 * ------------------------------------------------------------------------ */

function mapObservation(row: PuzzleObservationRow): PuzzleObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as PuzzleObservationKind,
    subjectKey: row.subject_key,
    statement: row.statement,
    observer: row.observer as 'BRAIN' | 'PERSON',
    observerId: row.observer_id,
    masterId: row.master_id,
    outputId: row.output_id,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordObservation(input: {
  projectId: string;
  kind: PuzzleObservationKind;
  subjectKey?: string | null;
  statement: string;
  observer: 'BRAIN' | 'PERSON';
  observerId?: string | null;
  masterId?: string | null;
  outputId?: string | null;
  sourceClaimId?: string | null;
}): Promise<PuzzleObservation> {
  if (input.observer === 'PERSON' && !input.observerId) {
    throw new Error("A person's observation must say whose it is.");
  }
  const id = newId('pzb');
  await getDb().run(
    `INSERT INTO puzzle_observations
       (id, project_id, kind, subject_key, statement, observer, observer_id,
        master_id, output_id, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.kind,
      input.subjectKey ?? null,
      input.statement,
      input.observer,
      input.observerId ?? null,
      input.masterId ?? null,
      input.outputId ?? null,
      input.sourceClaimId ?? null,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleObservationRow>(
    'SELECT * FROM puzzle_observations WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The observation disappeared immediately after being written.');
  return mapObservation(rows[0]);
}

export async function listObservations(projectId: string): Promise<PuzzleObservation[]> {
  const rows = await getDb().all<PuzzleObservationRow>(
    'SELECT * FROM puzzle_observations WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapObservation);
}
