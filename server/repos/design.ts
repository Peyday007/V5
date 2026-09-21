/**
 * The design kernel's rows.
 *
 * ---------------------------------------------------------------------------
 * What this layer is responsible for, and what it deliberately is not
 * ---------------------------------------------------------------------------
 *
 * Reads, writes and the two representations of a boolean meeting. It holds
 * **no** design judgement: which finding is worse, whether a correction should
 * become a rule, whether a capability has been proved — every one of those is a
 * derivation in `services/design/`, over rows this module hands back unchanged.
 *
 * Three properties are enforced here rather than there, because they are
 * properties of the *write* and a guard on one caller is not a guard:
 *
 *  1. **A finding is written once per capture, kind and region.** The unique
 *     index is the arbiter, and `recordFinding` reads back the row it collided
 *     with rather than failing — so re-evaluating a capture that has not changed
 *     produces the same finding rather than a second copy of it, and two ticks
 *     reading one completed review produce one list. §20's shape at a small
 *     table: idempotent by the thing that identifies the operation.
 *  2. **A capability dimension moves through one function**, which writes the
 *     append-only event in the same call. A setter that could move a state
 *     without recording why would make `design_capability_events` a table that
 *     is sometimes right, which is worse than not having it.
 *  3. **One live expansion per capability**, by partial unique index. Two ticks
 *     both concluding that mobile interaction is the weakest thing Brain does
 *     must produce one piece of work.
 *
 * Every `ORDER BY` here is sayable in both dialects and tiebreaks on `id`,
 * never on `rowid` — `dialect.ts` rewrites that to `seq`, and §27 records the
 * third time a tiebreak on a column only one backend has passed the entire
 * SQLite suite and threw in production.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import {
  type CaptureReadings,
  type DesignAbilityState,
  type DesignBinRequest,
  type DesignCapability,
  type DesignCapture,
  type DesignConfidence,
  type DesignCorrection,
  type DesignCycle,
  type DesignEvidenceState,
  type DesignExpansion,
  type DesignExpansionOrigin,
  type DesignExpansionRoute,
  type DesignExpansionState,
  type DesignFinding,
  type DesignFindingKind,
  type DesignFindingState,
  type DesignIndependenceTier,
  type DesignLane,
  type DesignPattern,
  type DesignPatternOrigin,
  type DesignPatternState,
  type DesignPrimitive,
  type DesignRequestKind,
  type DesignReview,
  type DesignScope,
  type DesignSeverity,
  type DesignStopReason,
  type DesignSurface,
  type DesignTrigger,
  type DesignVerdict,
  type SurfaceAction,
  type SurfacePrecondition,
  type SurfaceViewport,
} from '../domain/design.ts';
import { isDesignRequestKind } from '../domain/design.ts';
import { fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

/* =========================================================================
 * Surfaces
 * ====================================================================== */

interface SurfaceRow {
  id: string;
  surface_key: string;
  screen: string;
  state_key: string;
  title: string;
  route: string;
  preconditions: string;
  concepts: string;
  actions: string;
  viewports: string;
  faculty: string | null;
  registered_by: string;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
}

const SURFACE_COLUMNS =
  'id, surface_key, screen, state_key, title, route, preconditions, concepts, actions, ' +
  'viewports, faculty, registered_by, retired_at, retired_reason, created_at, updated_at';

function toSurface(row: SurfaceRow): DesignSurface {
  return {
    id: row.id,
    surfaceKey: row.surface_key,
    screen: row.screen,
    stateKey: row.state_key,
    title: row.title,
    route: row.route,
    preconditions: parseJson<SurfacePrecondition[]>(row.preconditions, []),
    concepts: parseJson<string[]>(row.concepts, []),
    actions: parseJson<SurfaceAction[]>(row.actions, []),
    viewports: parseJson<SurfaceViewport[]>(row.viewports, []),
    faculty: row.faculty,
    registeredBy: row.registered_by,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RegisterSurfaceInput {
  surfaceKey: string;
  screen: string;
  stateKey: string;
  title: string;
  route: string;
  preconditions: SurfacePrecondition[];
  concepts: string[];
  actions: SurfaceAction[];
  viewports: SurfaceViewport[];
  faculty: string | null;
  registeredBy: string;
}

/**
 * Register a surface, or bring an existing one up to date.
 *
 * An upsert rather than an insert, because the seed set is written from code on
 * every boot and a screen that gained an action should say so without anybody
 * deleting a row. What it never does is un-retire: a surface a person retired
 * stays retired until they say otherwise, so a redeploy cannot quietly bring
 * back something somebody took out.
 */
export async function registerSurface(
  input: RegisterSurfaceInput,
): Promise<{ surface: DesignSurface; created: boolean }> {
  const existing = await getSurface(input.surfaceKey);
  const at = nowIso();
  if (existing) {
    await getDb().run(
      `UPDATE design_surfaces
          SET screen = ?, state_key = ?, title = ?, route = ?, preconditions = ?,
              concepts = ?, actions = ?, viewports = ?, faculty = ?, updated_at = ?
        WHERE surface_key = ?`,
      [
        input.screen,
        input.stateKey,
        input.title,
        input.route,
        toJson(input.preconditions),
        toJson(input.concepts),
        toJson(input.actions),
        toJson(input.viewports),
        input.faculty,
        at,
        input.surfaceKey,
      ],
    );
    return { surface: (await getSurface(input.surfaceKey))!, created: false };
  }

  await getDb().run(
    `INSERT INTO design_surfaces (${SURFACE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      newId('dsf'),
      input.surfaceKey,
      input.screen,
      input.stateKey,
      input.title,
      input.route,
      toJson(input.preconditions),
      toJson(input.concepts),
      toJson(input.actions),
      toJson(input.viewports),
      input.faculty,
      input.registeredBy,
      at,
      at,
    ],
  );
  return { surface: (await getSurface(input.surfaceKey))!, created: true };
}

export async function getSurface(surfaceKey: string): Promise<DesignSurface | null> {
  const row = await getDb().get<SurfaceRow>(
    `SELECT ${SURFACE_COLUMNS} FROM design_surfaces WHERE surface_key = ?`,
    [surfaceKey],
  );
  return row ? toSurface(row) : null;
}

export async function listSurfaces(
  options: { includeRetired?: boolean } = {},
): Promise<DesignSurface[]> {
  const where = options.includeRetired ? '' : ' WHERE retired_at IS NULL';
  const rows = await getDb().all<SurfaceRow>(
    `SELECT ${SURFACE_COLUMNS} FROM design_surfaces${where} ORDER BY screen ASC, state_key ASC, id ASC`,
  );
  return rows.map(toSurface);
}

export async function retireSurface(surfaceKey: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_surfaces SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE surface_key = ? AND retired_at IS NULL`,
    [nowIso(), reason, nowIso(), surfaceKey],
  );
  return (result.changes ?? 0) > 0;
}

/* =========================================================================
 * Cycles
 * ====================================================================== */

interface CycleRow {
  id: string;
  trigger_kind: string;
  trigger_ref: string | null;
  surface_keys: string;
  revision: string | null;
  passes: number;
  state: string;
  stop_reason: string | null;
  stop_detail: string | null;
  opened_at: string;
  closed_at: string | null;
}

const CYCLE_COLUMNS =
  'id, trigger_kind, trigger_ref, surface_keys, revision, passes, state, stop_reason, ' +
  'stop_detail, opened_at, closed_at';

function toCycle(row: CycleRow): DesignCycle {
  return {
    id: row.id,
    triggerKind: row.trigger_kind as DesignTrigger,
    triggerRef: row.trigger_ref,
    surfaceKeys: parseJson<string[]>(row.surface_keys, []),
    revision: row.revision,
    passes: row.passes,
    state: row.state as 'OPEN' | 'CLOSED',
    stopReason: row.stop_reason as DesignStopReason | null,
    stopDetail: row.stop_detail,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

export async function openCycle(input: {
  triggerKind: DesignTrigger;
  triggerRef: string | null;
  surfaceKeys: string[];
  revision: string | null;
}): Promise<DesignCycle> {
  const id = newId('dcy');
  await getDb().run(
    `INSERT INTO design_cycles (${CYCLE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, 0, 'OPEN', NULL, NULL, ?, NULL)`,
    [
      id,
      input.triggerKind,
      input.triggerRef,
      toJson(input.surfaceKeys),
      input.revision,
      nowIso(),
    ],
  );
  return (await getCycle(id))!;
}

export async function getCycle(id: string): Promise<DesignCycle | null> {
  const row = await getDb().get<CycleRow>(`SELECT ${CYCLE_COLUMNS} FROM design_cycles WHERE id = ?`, [
    id,
  ]);
  return row ? toCycle(row) : null;
}

export async function listCycles(
  filter: { state?: 'OPEN' | 'CLOSED'; limit?: number } = {},
): Promise<DesignCycle[]> {
  const where = filter.state ? ' WHERE state = ?' : '';
  const params = filter.state ? [filter.state] : [];
  const rows = await getDb().all<CycleRow>(
    `SELECT ${CYCLE_COLUMNS} FROM design_cycles${where}
      ORDER BY opened_at DESC, id DESC LIMIT ${Math.max(1, Math.min(500, filter.limit ?? 50))}`,
    params,
  );
  return rows.map(toCycle);
}

/**
 * Advance a cycle's pass counter, guarded on the count the caller read.
 *
 * A compare-and-swap rather than `passes = passes + 1`, because the repair
 * ceiling is counted from this column: two ticks that both increment would let
 * a cycle spend a round nobody performed, and a cycle that spent a round nobody
 * performed reaches its ceiling early and reports REPAIR_EXHAUSTED about work it
 * never did. The loser is an ordinary outcome — it re-reads and finds the pass
 * already advanced.
 */
export async function advanceCyclePass(id: string, fromPass: number): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_cycles SET passes = ? WHERE id = ? AND state = 'OPEN' AND passes = ?`,
    [fromPass + 1, id, fromPass],
  );
  return (result.changes ?? 0) > 0;
}

export async function closeCycle(input: {
  id: string;
  stopReason: DesignStopReason;
  stopDetail: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_cycles SET state = 'CLOSED', stop_reason = ?, stop_detail = ?, closed_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.stopReason, input.stopDetail, nowIso(), input.id],
  );
  return (result.changes ?? 0) > 0;
}

/* =========================================================================
 * Captures
 * ====================================================================== */

interface CaptureRow {
  id: string;
  cycle_id: string | null;
  pass: number;
  surface_key: string;
  screen: string;
  state_key: string;
  viewport_name: string;
  width: number;
  height: number;
  revision: string | null;
  tree_dirty: number;
  content_hash: string;
  byte_size: number;
  artifact_ref: string;
  engine: string;
  engine_version: string | null;
  readings: string;
  captured_at: string;
  created_at: string;
}

const CAPTURE_COLUMNS =
  'id, cycle_id, pass, surface_key, screen, state_key, viewport_name, width, height, ' +
  'revision, tree_dirty, content_hash, byte_size, artifact_ref, engine, engine_version, ' +
  'readings, captured_at, created_at';

/** The readings a row carries when the stored JSON cannot be read at all. */
const NO_READINGS: CaptureReadings = {
  horizontalOverflow: false,
  clipped: [],
  offenders: [],
  unreachable: [],
  overlaps: [],
  smallTargets: [],
  lowContrast: [],
  reachableControls: [],
  deepestNesting: null,
  counts: { interactive: 0, headings: 0, landmarks: 0, textNodes: 0 },
  outline: [],
  unreadable: ['the stored readings for this capture could not be parsed'],
  partial: [],
};

function toCapture(row: CaptureRow): DesignCapture {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    pass: row.pass,
    surfaceKey: row.surface_key,
    screen: row.screen,
    stateKey: row.state_key,
    viewportName: row.viewport_name,
    width: row.width,
    height: row.height,
    revision: row.revision,
    treeDirty: toBool(row.tree_dirty),
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    artifactRef: row.artifact_ref,
    engine: row.engine,
    engineVersion: row.engine_version,
    readings: parseJson<CaptureReadings>(row.readings, NO_READINGS),
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  };
}

export interface RecordCaptureInput {
  cycleId: string | null;
  pass: number;
  surfaceKey: string;
  screen: string;
  stateKey: string;
  viewportName: string;
  width: number;
  height: number;
  revision: string | null;
  treeDirty: boolean;
  contentHash: string;
  byteSize: number;
  artifactRef: string;
  engine: string;
  engineVersion: string | null;
  readings: CaptureReadings;
  capturedAt: string;
}

export async function recordCapture(input: RecordCaptureInput): Promise<DesignCapture> {
  const id = newId('dcp');
  await getDb().run(
    `INSERT INTO design_captures (${CAPTURE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.cycleId,
      input.pass,
      input.surfaceKey,
      input.screen,
      input.stateKey,
      input.viewportName,
      input.width,
      input.height,
      input.revision,
      fromBool(input.treeDirty),
      input.contentHash,
      input.byteSize,
      input.artifactRef,
      input.engine,
      input.engineVersion,
      toJson(input.readings),
      input.capturedAt,
      nowIso(),
    ],
  );
  return (await getCapture(id))!;
}

export async function getCapture(id: string): Promise<DesignCapture | null> {
  const row = await getDb().get<CaptureRow>(
    `SELECT ${CAPTURE_COLUMNS} FROM design_captures WHERE id = ?`,
    [id],
  );
  return row ? toCapture(row) : null;
}

export async function listCaptures(filter: {
  cycleId?: string;
  pass?: number;
  surfaceKey?: string;
  limit?: number;
}): Promise<DesignCapture[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.cycleId !== undefined) {
    clauses.push('cycle_id = ?');
    params.push(filter.cycleId);
  }
  if (filter.pass !== undefined) {
    clauses.push('pass = ?');
    params.push(filter.pass);
  }
  if (filter.surfaceKey !== undefined) {
    clauses.push('surface_key = ?');
    params.push(filter.surfaceKey);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().all<CaptureRow>(
    `SELECT ${CAPTURE_COLUMNS} FROM design_captures${where}
      ORDER BY captured_at DESC, id DESC LIMIT ${Math.max(1, Math.min(2000, filter.limit ?? 500))}`,
    params,
  );
  return rows.map(toCapture);
}

/* =========================================================================
 * Reviews
 * ====================================================================== */

interface ReviewRow {
  id: string;
  cycle_id: string;
  pass: number;
  lane: string;
  capture_digest: string;
  capture_count: number;
  bin_id: string | null;
  worker_id: string | null;
  session_ref: string | null;
  account_id: string | null;
  routine_id: string | null;
  independence_tier: string | null;
  verdict: string;
  detail: string | null;
  findings_count: number;
  created_at: string;
}

const REVIEW_COLUMNS =
  'id, cycle_id, pass, lane, capture_digest, capture_count, bin_id, worker_id, session_ref, ' +
  'account_id, routine_id, independence_tier, verdict, detail, findings_count, created_at';

function toReview(row: ReviewRow): DesignReview {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    pass: row.pass,
    lane: row.lane as 'MEASURED' | 'JUDGED',
    captureDigest: row.capture_digest,
    captureCount: row.capture_count,
    binId: row.bin_id,
    workerId: row.worker_id,
    sessionRef: row.session_ref,
    accountId: row.account_id,
    routineId: row.routine_id,
    independenceTier: row.independence_tier as DesignIndependenceTier | null,
    verdict: row.verdict as DesignVerdict,
    detail: row.detail,
    findingsCount: row.findings_count,
    createdAt: row.created_at,
  };
}

export async function recordReview(input: {
  cycleId: string;
  pass: number;
  lane: 'MEASURED' | 'JUDGED';
  captureDigest: string;
  captureCount: number;
  binId?: string | null;
  workerId?: string | null;
  sessionRef?: string | null;
  accountId?: string | null;
  routineId?: string | null;
  /**
   * Null on a `REFUSED` judged review, which is a real and required state: a
   * submission that did not validate achieved no separation, and recording one
   * would be claiming a tier the review never earned.
   */
  independenceTier: DesignIndependenceTier | null;
  verdict: DesignVerdict;
  detail: string | null;
  findingsCount: number;
}): Promise<DesignReview> {
  const id = newId('drv');
  await getDb().run(
    `INSERT INTO design_reviews (${REVIEW_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.cycleId,
      input.pass,
      input.lane,
      input.captureDigest,
      input.captureCount,
      input.binId ?? null,
      input.workerId ?? null,
      input.sessionRef ?? null,
      input.accountId ?? null,
      input.routineId ?? null,
      input.independenceTier,
      input.verdict,
      input.detail,
      input.findingsCount,
      nowIso(),
    ],
  );
  return (await getReview(id))!;
}

export async function getReview(id: string): Promise<DesignReview | null> {
  const row = await getDb().get<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM design_reviews WHERE id = ?`, [
    id,
  ]);
  return row ? toReview(row) : null;
}

export async function listReviews(cycleId: string): Promise<DesignReview[]> {
  const rows = await getDb().all<ReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM design_reviews WHERE cycle_id = ?
      ORDER BY pass ASC, created_at ASC, id ASC`,
    [cycleId],
  );
  return rows.map(toReview);
}

/* =========================================================================
 * What a design bin was asked about
 * ====================================================================== */

interface BinRequestRow {
  bin_id: string;
  cycle_id: string;
  pass: number;
  kind: string;
  surface_keys: string;
  revision: string | null;
  capture_digest: string | null;
  capture_count: number;
  created_at: string;
}

const BIN_REQUEST_COLUMNS =
  'bin_id, cycle_id, pass, kind, surface_keys, revision, capture_digest, capture_count, created_at';

function toBinRequest(row: BinRequestRow): DesignBinRequest {
  return {
    binId: row.bin_id,
    cycleId: row.cycle_id,
    pass: row.pass,
    kind: isDesignRequestKind(row.kind) ? row.kind : 'RENDER',
    surfaceKeys: parseJson<string[]>(row.surface_keys, []),
    revision: row.revision,
    captureDigest: row.capture_digest,
    captureCount: row.capture_count,
    createdAt: row.created_at,
  };
}

/**
 * Record what a design bin is being asked, once per cycle, pass and kind.
 *
 * `ON CONFLICT DO NOTHING` against the round key, and the winner is whoever
 * inserted: two ticks both deciding the same cycle needs a review produce one
 * request and one bin's worth of work. The loser reads back the row it collided
 * with, so the caller can retire the bin it had already made rather than leave
 * a second one claimable — §20's shape, at the smallest table in this kernel.
 *
 * Returns the row that now governs the round and whether this caller wrote it.
 */
export async function openBinRequest(input: {
  binId: string;
  cycleId: string;
  pass: number;
  kind: DesignRequestKind;
  surfaceKeys: readonly string[];
  revision: string | null;
  captureDigest: string | null;
  captureCount: number;
}): Promise<{ request: DesignBinRequest; created: boolean }> {
  await getDb().run(
    `INSERT INTO design_bin_requests (${BIN_REQUEST_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cycle_id, pass, kind) DO NOTHING`,
    [
      input.binId,
      input.cycleId,
      input.pass,
      input.kind,
      toJson([...input.surfaceKeys]),
      input.revision,
      input.captureDigest,
      input.captureCount,
      nowIso(),
    ],
  );
  const row = await getDb().get<BinRequestRow>(
    `SELECT ${BIN_REQUEST_COLUMNS} FROM design_bin_requests
      WHERE cycle_id = ? AND pass = ? AND kind = ?`,
    [input.cycleId, input.pass, input.kind],
  );
  const request = toBinRequest(row!);
  return { request, created: request.binId === input.binId };
}

export async function getBinRequest(binId: string): Promise<DesignBinRequest | null> {
  const row = await getDb().get<BinRequestRow>(
    `SELECT ${BIN_REQUEST_COLUMNS} FROM design_bin_requests WHERE bin_id = ?`,
    [binId],
  );
  return row ? toBinRequest(row) : null;
}

export async function binRequestFor(filter: {
  cycleId: string;
  pass: number;
  kind: DesignRequestKind;
}): Promise<DesignBinRequest | null> {
  const row = await getDb().get<BinRequestRow>(
    `SELECT ${BIN_REQUEST_COLUMNS} FROM design_bin_requests
      WHERE cycle_id = ? AND pass = ? AND kind = ?`,
    [filter.cycleId, filter.pass, filter.kind],
  );
  return row ? toBinRequest(row) : null;
}

export async function listBinRequests(filter: {
  cycleId?: string;
  kind?: DesignRequestKind;
  limit?: number;
}): Promise<DesignBinRequest[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.cycleId !== undefined) {
    clauses.push('cycle_id = ?');
    params.push(filter.cycleId);
  }
  if (filter.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().all<BinRequestRow>(
    `SELECT ${BIN_REQUEST_COLUMNS} FROM design_bin_requests ${where}
      ORDER BY created_at DESC, bin_id DESC LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
  return rows.map(toBinRequest);
}

/* =========================================================================
 * Findings
 * ====================================================================== */

interface FindingRow {
  id: string;
  cycle_id: string | null;
  review_id: string | null;
  capture_id: string;
  pass: number;
  surface_key: string;
  region: string;
  lane: string;
  kind: string;
  primitive: string;
  statement: string;
  why_it_matters: string;
  severity: string;
  evidence: string;
  proposed_repair: string;
  state: string;
  resolved_by: string | null;
  resolution: string | null;
  pattern_id: string | null;
  created_at: string;
  updated_at: string;
}

const FINDING_COLUMNS =
  'id, cycle_id, review_id, capture_id, pass, surface_key, region, lane, kind, primitive, ' +
  'statement, why_it_matters, severity, evidence, proposed_repair, state, resolved_by, ' +
  'resolution, pattern_id, created_at, updated_at';

function toFinding(row: FindingRow): DesignFinding {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    reviewId: row.review_id,
    captureId: row.capture_id,
    pass: row.pass,
    surfaceKey: row.surface_key,
    region: row.region,
    lane: row.lane as DesignLane,
    kind: row.kind as DesignFindingKind,
    primitive: row.primitive as DesignPrimitive,
    statement: row.statement,
    whyItMatters: row.why_it_matters,
    severity: row.severity as DesignSeverity,
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
    proposedRepair: row.proposed_repair,
    state: row.state as DesignFindingState,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
    patternId: row.pattern_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RecordFindingInput {
  cycleId: string | null;
  reviewId: string | null;
  captureId: string;
  pass: number;
  surfaceKey: string;
  region: string;
  lane: DesignLane;
  kind: DesignFindingKind;
  primitive: DesignPrimitive;
  statement: string;
  whyItMatters: string;
  severity: DesignSeverity;
  evidence: Record<string, unknown>;
  proposedRepair: string;
  patternId?: string | null;
}

/**
 * Write a finding, or hand back the one already there.
 *
 * The unique index decides, and losing it is an ordinary outcome rather than an
 * error: re-evaluating a capture whose bytes have not changed must produce the
 * same finding rather than a duplicate, because the count of open findings is
 * what the repair loop's stopping condition is read from — and a loop that
 * counted the same defect three times would report progress by not finding it
 * again.
 */
export async function recordFinding(
  input: RecordFindingInput,
): Promise<{ finding: DesignFinding; created: boolean }> {
  const existing = await findingFor(input.captureId, input.kind, input.region, input.reviewId);
  if (existing) return { finding: existing, created: false };

  const id = newId('dfn');
  const at = nowIso();
  try {
    await getDb().run(
      `INSERT INTO design_findings (${FINDING_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, ?, ?, ?)`,
      [
        id,
        input.cycleId,
        input.reviewId,
        input.captureId,
        input.pass,
        input.surfaceKey,
        input.region,
        input.lane,
        input.kind,
        input.primitive,
        input.statement,
        input.whyItMatters,
        input.severity,
        toJson(input.evidence),
        input.proposedRepair,
        input.patternId ?? null,
        at,
        at,
      ],
    );
  } catch {
    const other = await findingFor(input.captureId, input.kind, input.region, input.reviewId);
    if (other) return { finding: other, created: false };
    throw new Error('The finding could not be written and no existing one was found.');
  }
  return { finding: (await getFinding(id))!, created: true };
}

async function findingFor(
  captureId: string,
  kind: string,
  region: string,
  reviewId: string | null,
): Promise<DesignFinding | null> {
  const row = await getDb().get<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM design_findings
      WHERE capture_id = ? AND kind = ? AND region = ? AND COALESCE(review_id, '-') = ?`,
    [captureId, kind, region, reviewId ?? '-'],
  );
  return row ? toFinding(row) : null;
}

export async function getFinding(id: string): Promise<DesignFinding | null> {
  const row = await getDb().get<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM design_findings WHERE id = ?`,
    [id],
  );
  return row ? toFinding(row) : null;
}

export async function listFindings(filter: {
  cycleId?: string;
  surfaceKey?: string;
  state?: DesignFindingState;
  lane?: DesignLane;
  since?: string;
  limit?: number;
}): Promise<DesignFinding[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.cycleId !== undefined) {
    clauses.push('cycle_id = ?');
    params.push(filter.cycleId);
  }
  if (filter.surfaceKey !== undefined) {
    clauses.push('surface_key = ?');
    params.push(filter.surfaceKey);
  }
  if (filter.state !== undefined) {
    clauses.push('state = ?');
    params.push(filter.state);
  }
  if (filter.lane !== undefined) {
    clauses.push('lane = ?');
    params.push(filter.lane);
  }
  if (filter.since !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.since);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().all<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM design_findings${where}
      ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(2000, filter.limit ?? 500))}`,
    params,
  );
  return rows.map(toFinding);
}

/**
 * Settle a finding, guarded on it still being open.
 *
 * Guarded because two readers can reach the same finding — the repair pass that
 * fixed it and the re-evaluation that no longer sees it — and the first honest
 * answer should stand. The second gets `false`, which is an ordinary outcome.
 */
export async function settleFinding(input: {
  id: string;
  state: Exclude<DesignFindingState, 'OPEN'>;
  resolution: string;
  resolvedBy: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_findings SET state = ?, resolution = ?, resolved_by = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.state, input.resolution, input.resolvedBy, nowIso(), input.id],
  );
  return (result.changes ?? 0) > 0;
}

export async function attachPattern(findingId: string, patternId: string): Promise<void> {
  await getDb().run('UPDATE design_findings SET pattern_id = ?, updated_at = ? WHERE id = ?', [
    patternId,
    nowIso(),
    findingId,
  ]);
}

/** How many findings of each kind a surface has ever had, for the self-model. */
export async function findingCountsByPrimitive(
  since?: string,
): Promise<{ primitive: string; lane: string; count: number }[]> {
  const where = since ? ' WHERE created_at >= ?' : '';
  const params = since ? [since] : [];
  return getDb().all<{ primitive: string; lane: string; count: number }>(
    `SELECT primitive, lane, COUNT(*) AS count FROM design_findings${where}
      GROUP BY primitive, lane ORDER BY primitive ASC, lane ASC`,
    params,
  );
}

/* =========================================================================
 * Corrections
 * ====================================================================== */

interface CorrectionRow {
  id: string;
  surface_key: string | null;
  before_capture_id: string | null;
  after_capture_id: string | null;
  correction: string;
  components: string;
  lesson: string | null;
  scope: string;
  scope_ref: string | null;
  confidence: string;
  recorded_by_user_id: string;
  promoted_pattern_id: string | null;
  created_at: string;
  updated_at: string;
}

const CORRECTION_COLUMNS =
  'id, surface_key, before_capture_id, after_capture_id, correction, components, lesson, ' +
  'scope, scope_ref, confidence, recorded_by_user_id, promoted_pattern_id, created_at, updated_at';

function toCorrection(row: CorrectionRow): DesignCorrection {
  return {
    id: row.id,
    surfaceKey: row.surface_key,
    beforeCaptureId: row.before_capture_id,
    afterCaptureId: row.after_capture_id,
    correction: row.correction,
    components: parseJson<string[]>(row.components, []),
    lesson: row.lesson,
    scope: row.scope as DesignScope,
    scopeRef: row.scope_ref,
    confidence: row.confidence as DesignConfidence,
    recordedByUserId: row.recorded_by_user_id,
    promotedPatternId: row.promoted_pattern_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordCorrection(input: {
  surfaceKey: string | null;
  beforeCaptureId: string | null;
  afterCaptureId: string | null;
  correction: string;
  components: string[];
  lesson: string | null;
  scope: DesignScope;
  scopeRef: string | null;
  confidence: DesignConfidence;
  /** Resolved from the authenticated principal by the caller. Never a field. */
  recordedByUserId: string;
}): Promise<DesignCorrection> {
  const id = newId('dcr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO design_corrections (${CORRECTION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.surfaceKey,
      input.beforeCaptureId,
      input.afterCaptureId,
      input.correction,
      toJson(input.components),
      input.lesson,
      input.scope,
      input.scopeRef,
      input.confidence,
      input.recordedByUserId,
      at,
      at,
    ],
  );
  return (await getCorrection(id))!;
}

export async function getCorrection(id: string): Promise<DesignCorrection | null> {
  const row = await getDb().get<CorrectionRow>(
    `SELECT ${CORRECTION_COLUMNS} FROM design_corrections WHERE id = ?`,
    [id],
  );
  return row ? toCorrection(row) : null;
}

export async function listCorrections(filter: {
  surfaceKey?: string;
  scope?: DesignScope;
  scopeRef?: string;
  limit?: number;
}): Promise<DesignCorrection[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.surfaceKey !== undefined) {
    clauses.push('surface_key = ?');
    params.push(filter.surfaceKey);
  }
  if (filter.scope !== undefined) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.scopeRef !== undefined) {
    clauses.push('scope_ref = ?');
    params.push(filter.scopeRef);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().all<CorrectionRow>(
    `SELECT ${CORRECTION_COLUMNS} FROM design_corrections${where}
      ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(1000, filter.limit ?? 200))}`,
    params,
  );
  return rows.map(toCorrection);
}

export async function markCorrectionPromoted(
  correctionId: string,
  patternId: string,
): Promise<void> {
  await getDb().run(
    'UPDATE design_corrections SET promoted_pattern_id = ?, updated_at = ? WHERE id = ?',
    [patternId, nowIso(), correctionId],
  );
}

export async function setCorrectionLesson(id: string, lesson: string): Promise<void> {
  await getDb().run('UPDATE design_corrections SET lesson = ?, updated_at = ? WHERE id = ?', [
    lesson,
    nowIso(),
    id,
  ]);
}

/* =========================================================================
 * Patterns
 * ====================================================================== */

interface PatternRow {
  id: string;
  primitive: string;
  branch: string | null;
  statement: string;
  applies_when: string;
  exceptions: string | null;
  scope: string;
  scope_ref: string | null;
  confidence: string;
  origin: string;
  evidence: string;
  state: string;
  retired_reason: string | null;
  fingerprint: string;
  created_at: string;
  updated_at: string;
}

const PATTERN_COLUMNS =
  'id, primitive, branch, statement, applies_when, exceptions, scope, scope_ref, confidence, ' +
  'origin, evidence, state, retired_reason, fingerprint, created_at, updated_at';

function toPattern(row: PatternRow): DesignPattern {
  return {
    id: row.id,
    primitive: row.primitive as DesignPrimitive,
    branch: row.branch,
    statement: row.statement,
    appliesWhen: row.applies_when,
    exceptions: row.exceptions,
    scope: row.scope as DesignScope,
    scopeRef: row.scope_ref,
    confidence: row.confidence as DesignConfidence,
    origin: row.origin as DesignPatternOrigin,
    evidence: parseJson<string[]>(row.evidence, []),
    state: row.state as DesignPatternState,
    retiredReason: row.retired_reason,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertPatternInput {
  primitive: DesignPrimitive;
  branch: string | null;
  statement: string;
  appliesWhen: string;
  exceptions: string | null;
  scope: DesignScope;
  scopeRef: string | null;
  confidence: DesignConfidence;
  origin: DesignPatternOrigin;
  evidence: string[];
  state: DesignPatternState;
  /** Derived by the caller from the statement, never supplied by a request. */
  fingerprint: string;
}

/**
 * Write a pattern, or add evidence to the one that already says this.
 *
 * The second half is what makes the knowledge accumulate rather than duplicate:
 * the same lesson learned from a correction and again from a piece of research
 * is one rule with two pieces of evidence behind it, and confidence rises
 * because the evidence did — never because it was asserted again.
 */
export async function upsertPattern(
  input: UpsertPatternInput,
): Promise<{ pattern: DesignPattern; created: boolean }> {
  const existing = await patternByFingerprint(input.fingerprint);
  const at = nowIso();
  if (existing) {
    const merged = [...new Set([...existing.evidence, ...input.evidence])];
    await getDb().run(
      `UPDATE design_patterns SET evidence = ?, confidence = ?, branch = ?, updated_at = ?
        WHERE id = ?`,
      [toJson(merged), input.confidence, input.branch ?? existing.branch, at, existing.id],
    );
    return { pattern: (await getPattern(existing.id))!, created: false };
  }
  const id = newId('dpt');
  await getDb().run(
    `INSERT INTO design_patterns (${PATTERN_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      id,
      input.primitive,
      input.branch,
      input.statement,
      input.appliesWhen,
      input.exceptions,
      input.scope,
      input.scopeRef,
      input.confidence,
      input.origin,
      toJson(input.evidence),
      input.state,
      input.fingerprint,
      at,
      at,
    ],
  );
  return { pattern: (await getPattern(id))!, created: true };
}

export async function getPattern(id: string): Promise<DesignPattern | null> {
  const row = await getDb().get<PatternRow>(`SELECT ${PATTERN_COLUMNS} FROM design_patterns WHERE id = ?`, [
    id,
  ]);
  return row ? toPattern(row) : null;
}

export async function patternByFingerprint(fingerprint: string): Promise<DesignPattern | null> {
  const row = await getDb().get<PatternRow>(
    `SELECT ${PATTERN_COLUMNS} FROM design_patterns WHERE fingerprint = ?`,
    [fingerprint],
  );
  return row ? toPattern(row) : null;
}

export async function listPatterns(filter: {
  primitive?: DesignPrimitive;
  branch?: string;
  state?: DesignPatternState;
  limit?: number;
} = {}): Promise<DesignPattern[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.primitive !== undefined) {
    clauses.push('primitive = ?');
    params.push(filter.primitive);
  }
  if (filter.branch !== undefined) {
    clauses.push('branch = ?');
    params.push(filter.branch);
  }
  if (filter.state !== undefined) {
    clauses.push('state = ?');
    params.push(filter.state);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().all<PatternRow>(
    `SELECT ${PATTERN_COLUMNS} FROM design_patterns${where}
      ORDER BY primitive ASC, created_at ASC, id ASC
      LIMIT ${Math.max(1, Math.min(1000, filter.limit ?? 500))}`,
    params,
  );
  return rows.map(toPattern);
}

export async function activatePattern(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_patterns SET state = 'ACTIVE', updated_at = ? WHERE id = ? AND state = 'PROPOSED'`,
    [nowIso(), id],
  );
  return (result.changes ?? 0) > 0;
}

export async function retirePattern(id: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_patterns SET state = 'RETIRED', retired_reason = ?, updated_at = ?
      WHERE id = ? AND state <> 'RETIRED'`,
    [reason, nowIso(), id],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * How many patterns sit under each discovered branch.
 *
 * This is the whole of how the taxonomy grows: a branch is worth treating as a
 * distinction when several patterns turned out to be about it, and until then it
 * is a word one pattern happened to use.
 */
export async function branchCounts(): Promise<{ primitive: string; branch: string; count: number }[]> {
  return getDb().all<{ primitive: string; branch: string; count: number }>(
    `SELECT primitive, branch, COUNT(*) AS count FROM design_patterns
      WHERE branch IS NOT NULL AND state <> 'RETIRED'
      GROUP BY primitive, branch ORDER BY count DESC, primitive ASC, branch ASC`,
  );
}

/* =========================================================================
 * Capabilities — the design self-model
 * ====================================================================== */

interface CapabilityRow {
  id: string;
  capability_key: string;
  title: string;
  primitive: string;
  ability_state: string;
  evidence_state: string;
  route: string | null;
  evaluation_method: string | null;
  limitations: string;
  evidence: string;
  observations: number;
  failures: number;
  created_at: string;
  updated_at: string;
}

const CAPABILITY_COLUMNS =
  'id, capability_key, title, primitive, ability_state, evidence_state, route, ' +
  'evaluation_method, limitations, evidence, observations, failures, created_at, updated_at';

function toCapability(row: CapabilityRow): DesignCapability {
  return {
    id: row.id,
    capabilityKey: row.capability_key,
    title: row.title,
    primitive: row.primitive as DesignPrimitive,
    abilityState: row.ability_state as DesignAbilityState,
    evidenceState: row.evidence_state as DesignEvidenceState,
    route: row.route,
    evaluationMethod: row.evaluation_method,
    limitations: parseJson<string[]>(row.limitations, []),
    evidence: parseJson<string[]>(row.evidence, []),
    observations: row.observations,
    failures: row.failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Declare a capability, or bring its description up to date.
 *
 * **It never writes a state.** The two dimensions are moved only by
 * `moveCapabilityDimension`, which records why in the same call — so a seed that
 * could also set `ability_state` would be a path by which "we wrote this down"
 * becomes "this works", which is §37's whole reason for having two columns and
 * no aggregate.
 */
export async function declareCapability(input: {
  capabilityKey: string;
  title: string;
  primitive: DesignPrimitive;
  route: string | null;
  evaluationMethod: string | null;
  limitations: string[];
}): Promise<{ capability: DesignCapability; created: boolean }> {
  const existing = await getCapability(input.capabilityKey);
  const at = nowIso();
  if (existing) {
    await getDb().run(
      `UPDATE design_capabilities
          SET title = ?, primitive = ?, route = ?, evaluation_method = ?, limitations = ?, updated_at = ?
        WHERE capability_key = ?`,
      [
        input.title,
        input.primitive,
        input.route,
        input.evaluationMethod,
        toJson(input.limitations),
        at,
        input.capabilityKey,
      ],
    );
    return { capability: (await getCapability(input.capabilityKey))!, created: false };
  }
  await getDb().run(
    `INSERT INTO design_capabilities (${CAPABILITY_COLUMNS})
     VALUES (?, ?, ?, ?, 'ABSENT', 'UNTESTED', ?, ?, ?, ?, 0, 0, ?, ?)`,
    [
      newId('dcb'),
      input.capabilityKey,
      input.title,
      input.primitive,
      input.route,
      input.evaluationMethod,
      toJson(input.limitations),
      toJson([]),
      at,
      at,
    ],
  );
  return { capability: (await getCapability(input.capabilityKey))!, created: true };
}

export async function getCapability(capabilityKey: string): Promise<DesignCapability | null> {
  const row = await getDb().get<CapabilityRow>(
    `SELECT ${CAPABILITY_COLUMNS} FROM design_capabilities WHERE capability_key = ?`,
    [capabilityKey],
  );
  return row ? toCapability(row) : null;
}

export async function listCapabilities(): Promise<DesignCapability[]> {
  const rows = await getDb().all<CapabilityRow>(
    `SELECT ${CAPABILITY_COLUMNS} FROM design_capabilities ORDER BY primitive ASC, capability_key ASC`,
  );
  return rows.map(toCapability);
}

/**
 * Move one dimension, guarded on the state the caller read, recording why.
 *
 * Guarded so two ticks cannot both "promote" one capability from the same
 * starting point and write two events claiming the same move. The event is
 * written in the same call as the update rather than by the caller, because a
 * dimension that moved with no event is a registry that cannot answer *when did
 * Brain start believing it could do this, and on what* — the question somebody
 * asks the first time it is wrong.
 */
export async function moveCapabilityDimension(input: {
  capabilityKey: string;
  dimension: 'ABILITY' | 'EVIDENCE';
  from: string;
  to: string;
  reason: string;
  evidenceRef: string | null;
  actorType: string;
  actorId: string | null;
}): Promise<boolean> {
  const column = input.dimension === 'ABILITY' ? 'ability_state' : 'evidence_state';
  const result = await getDb().run(
    `UPDATE design_capabilities SET ${column} = ?, updated_at = ?
      WHERE capability_key = ? AND ${column} = ?`,
    [input.to, nowIso(), input.capabilityKey, input.from],
  );
  if ((result.changes ?? 0) === 0) return false;

  await getDb().run(
    `INSERT INTO design_capability_events
       (id, capability_key, dimension, from_state, to_state, reason, evidence_ref, actor_type, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('dce'),
      input.capabilityKey,
      input.dimension,
      input.from,
      input.to,
      input.reason,
      input.evidenceRef,
      input.actorType,
      input.actorId,
      nowIso(),
    ],
  );
  return true;
}

export async function listCapabilityEvents(capabilityKey: string): Promise<
  {
    id: string;
    dimension: string;
    fromState: string;
    toState: string;
    reason: string;
    evidenceRef: string | null;
    createdAt: string;
  }[]
> {
  const rows = await getDb().all<{
    id: string;
    dimension: string;
    from_state: string;
    to_state: string;
    reason: string;
    evidence_ref: string | null;
    created_at: string;
  }>(
    `SELECT id, dimension, from_state, to_state, reason, evidence_ref, created_at
       FROM design_capability_events WHERE capability_key = ?
      ORDER BY created_at ASC, id ASC`,
    [capabilityKey],
  );
  return rows.map((row) => ({
    id: row.id,
    dimension: row.dimension,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    evidenceRef: row.evidence_ref,
    createdAt: row.created_at,
  }));
}

/**
 * Add an observation, and say whether it went wrong.
 *
 * Two counters rather than a rate, because a rate over two observations reads
 * like a measurement. Whatever wants a proportion computes one and stores none.
 */
export async function observeCapability(input: {
  capabilityKey: string;
  failed: boolean;
  evidenceRef: string | null;
}): Promise<void> {
  const capability = await getCapability(input.capabilityKey);
  if (!capability) return;
  const evidence = input.evidenceRef
    ? [...new Set([...capability.evidence, input.evidenceRef])].slice(-50)
    : capability.evidence;
  await getDb().run(
    `UPDATE design_capabilities
        SET observations = observations + 1, failures = failures + ?, evidence = ?, updated_at = ?
      WHERE capability_key = ?`,
    [input.failed ? 1 : 0, toJson(evidence), nowIso(), input.capabilityKey],
  );
}

export async function setCapabilityLimitations(
  capabilityKey: string,
  limitations: string[],
): Promise<void> {
  await getDb().run(
    'UPDATE design_capabilities SET limitations = ?, updated_at = ? WHERE capability_key = ?',
    [toJson(limitations), nowIso(), capabilityKey],
  );
}

/* =========================================================================
 * Expansions
 * ====================================================================== */

interface ExpansionRow {
  id: string;
  capability_key: string;
  origin: string;
  statement: string;
  why: string;
  rank_inputs: string;
  rank: number;
  route: string;
  route_ref: string | null;
  state: string;
  outcome: string | null;
  evidence: string;
  created_at: string;
  updated_at: string;
}

const EXPANSION_COLUMNS =
  'id, capability_key, origin, statement, why, rank_inputs, rank, route, route_ref, state, ' +
  'outcome, evidence, created_at, updated_at';

function toExpansion(row: ExpansionRow): DesignExpansion {
  return {
    id: row.id,
    capabilityKey: row.capability_key,
    origin: row.origin as DesignExpansionOrigin,
    statement: row.statement,
    why: row.why,
    rankInputs: parseJson<Record<string, unknown>>(row.rank_inputs, {}),
    rank: row.rank,
    route: row.route as DesignExpansionRoute,
    routeRef: row.route_ref,
    state: row.state as DesignExpansionState,
    outcome: row.outcome,
    evidence: parseJson<string[]>(row.evidence, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open an expansion, unless one is already live for this capability.
 *
 * `created: false` with the existing row is the answer when the partial unique
 * index refuses, because two ticks reaching the same conclusion is the ordinary
 * case rather than an error — and the caller wants to know which row now carries
 * the work rather than that its own insert lost.
 */
export async function openExpansion(input: {
  capabilityKey: string;
  origin: DesignExpansionOrigin;
  statement: string;
  why: string;
  rankInputs: Record<string, unknown>;
  rank: number;
  route: DesignExpansionRoute;
  evidence: string[];
}): Promise<{ expansion: DesignExpansion; created: boolean }> {
  const live = await liveExpansionFor(input.capabilityKey);
  if (live) return { expansion: live, created: false };

  const id = newId('dex');
  const at = nowIso();
  try {
    await getDb().run(
      `INSERT INTO design_expansions (${EXPANSION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'IDENTIFIED', NULL, ?, ?, ?)`,
      [
        id,
        input.capabilityKey,
        input.origin,
        input.statement,
        input.why,
        toJson(input.rankInputs),
        input.rank,
        input.route,
        toJson(input.evidence),
        at,
        at,
      ],
    );
  } catch {
    const other = await liveExpansionFor(input.capabilityKey);
    if (other) return { expansion: other, created: false };
    throw new Error('The expansion could not be written and no live one was found.');
  }
  return { expansion: (await getExpansion(id))!, created: true };
}

export async function getExpansion(id: string): Promise<DesignExpansion | null> {
  const row = await getDb().get<ExpansionRow>(
    `SELECT ${EXPANSION_COLUMNS} FROM design_expansions WHERE id = ?`,
    [id],
  );
  return row ? toExpansion(row) : null;
}

/**
 * The most recent expansion for a capability, whatever state it is in.
 *
 * Read by the cool-off, which is why it does not filter on state: a gap that
 * *parked* is exactly the case the cool-off exists for, and one that only
 * returned live rows would answer null for it and let the loop open another.
 */
export async function lastExpansionFor(capabilityKey: string): Promise<DesignExpansion | null> {
  const row = await getDb().get<ExpansionRow>(
    `SELECT ${EXPANSION_COLUMNS} FROM design_expansions WHERE capability_key = ?
      ORDER BY created_at DESC, id DESC`,
    [capabilityKey],
  );
  return row ? toExpansion(row) : null;
}

export async function liveExpansionFor(capabilityKey: string): Promise<DesignExpansion | null> {
  const row = await getDb().get<ExpansionRow>(
    `SELECT ${EXPANSION_COLUMNS} FROM design_expansions
      WHERE capability_key = ? AND state IN ('IDENTIFIED', 'ROUTED')
      ORDER BY created_at DESC, id DESC`,
    [capabilityKey],
  );
  return row ? toExpansion(row) : null;
}

export async function listExpansions(filter: {
  state?: DesignExpansionState;
  limit?: number;
} = {}): Promise<DesignExpansion[]> {
  const where = filter.state ? ' WHERE state = ?' : '';
  const params = filter.state ? [filter.state] : [];
  const rows = await getDb().all<ExpansionRow>(
    `SELECT ${EXPANSION_COLUMNS} FROM design_expansions${where}
      ORDER BY rank ASC, created_at DESC, id DESC
      LIMIT ${Math.max(1, Math.min(500, filter.limit ?? 100))}`,
    params,
  );
  return rows.map(toExpansion);
}

/** Record where an identified expansion went. Guarded on it not having gone yet. */
export async function routeExpansion(input: {
  id: string;
  routeRef: string | null;
  route?: DesignExpansionRoute;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE design_expansions
        SET state = 'ROUTED', route_ref = ?, route = COALESCE(?, route), updated_at = ?
      WHERE id = ? AND state = 'IDENTIFIED'`,
    [input.routeRef, input.route ?? null, nowIso(), input.id],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Settle an expansion.
 *
 * `outcome` is required by the schema on every terminal state, which is the
 * point: §33 records thirteen production claims destroyed by a rejection with no
 * reason on it, and an expansion rejected silently would make the same gap
 * arrive again next week with nothing saying it had been looked at.
 */
export async function settleExpansion(input: {
  id: string;
  state: 'EVALUATED' | 'PROMOTED' | 'REJECTED' | 'PARKED';
  outcome: string;
  evidence?: string[];
}): Promise<boolean> {
  const current = await getExpansion(input.id);
  if (!current) return false;
  const evidence = input.evidence
    ? [...new Set([...current.evidence, ...input.evidence])]
    : current.evidence;
  const result = await getDb().run(
    `UPDATE design_expansions SET state = ?, outcome = ?, evidence = ?, updated_at = ?
      WHERE id = ? AND state IN ('IDENTIFIED', 'ROUTED', 'EVALUATED')`,
    [input.state, input.outcome, toJson(evidence), nowIso(), input.id],
  );
  return (result.changes ?? 0) > 0;
}
