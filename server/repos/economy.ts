/**
 * Economic edges and activity variables, the possibility store, and stage
 * measurements. Every read is scoped by project, and the stores a person's
 * goals touch are scoped by owner as well. Writes are idempotent by a unique
 * index: a loser reads back the winner's row.
 *
 * Stage measurements are benchmarks: `services/economy/measure` derives a
 * goal's per-stage reading on the read path and stores nothing, and
 * `recordGoalBenchmark` is how a reading is kept — five rows, one per stage,
 * sharing one benchmark id and one timestamp — so a later reading can be set
 * against it (`npm run goals -- benchmark`). The table's columns are NOT NULL,
 * so a figure the reading could not state is written as 0 and named in the
 * row's note; `goalBenchmarks` restores it to null. An unknown is never read
 * back as a zero.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import { evidenceProblem } from '../domain/economy.ts';
import type {
  ActivityVariable, EconomicEdge, EconomicRelation, EndpointKind, EvidenceStatus, OperatorKind,
  Possibility, PossibilityCondition, PossibilityEdge, PossibilityKind, PossibilityRelation,
  PossibilityRequirements, Stage, StageMeasurement, GoalPolicyRecord,
} from '../domain/economy.ts';
import { STAGES } from '../domain/economy.ts';

interface Row { [key: string]: unknown }
const s = (v: unknown): string => v as string;
const sn = (v: unknown): string | null => (v as string | null) ?? null;

function mapEdge(r: Row): EconomicEdge {
  return {
    id: s(r['id']), projectId: s(r['project_id']),
    fromKind: s(r['from_kind']) as EndpointKind, fromRef: s(r['from_ref']),
    toKind: s(r['to_kind']) as EndpointKind, toRef: s(r['to_ref']),
    relation: s(r['relation']) as EconomicRelation, status: s(r['status']) as EvidenceStatus,
    sourceClaimId: sn(r['source_claim_id']), basis: sn(r['basis']),
    operatorKind: s(r['operator_kind']) as OperatorKind, createdAt: s(r['created_at']),
  };
}

export async function recordEconomicEdge(input: {
  projectId: string; fromKind: EndpointKind; fromRef: string; toKind: EndpointKind; toRef: string;
  relation: EconomicRelation; status: EvidenceStatus; sourceClaimId?: string | null;
  basis?: string | null; operatorKind: OperatorKind;
}): Promise<{ edge: EconomicEdge; created: boolean }> {
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  const id = newId('eed');
  await getDb().run(
    `INSERT INTO economic_edges (id, project_id, from_kind, from_ref, to_kind, to_ref, relation,
       status, source_claim_id, basis, operator_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.fromKind, input.fromRef, input.toKind, input.toRef, input.relation,
      input.status, input.sourceClaimId ?? null, input.basis ?? null, input.operatorKind, nowIso()],
  );
  const row = await getDb().get<Row>(
    `SELECT * FROM economic_edges WHERE project_id = ? AND from_kind = ? AND from_ref = ?
       AND relation = ? AND to_kind = ? AND to_ref = ? AND operator_kind = ?`,
    [input.projectId, input.fromKind, input.fromRef, input.relation, input.toKind, input.toRef, input.operatorKind],
  );
  const edge = mapEdge(row!);
  return { edge, created: edge.id === id };
}

export async function edgesAround(projectId: string, ref: string): Promise<EconomicEdge[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM economic_edges WHERE project_id = ? AND (from_ref = ? OR to_ref = ?)
     ORDER BY created_at, id`,
    [projectId, ref, ref],
  );
  return rows.map(mapEdge);
}

function mapVariable(r: Row): ActivityVariable {
  return {
    id: s(r['id']), projectId: s(r['project_id']), activityRef: s(r['activity_ref']),
    name: s(r['name']), value: r['value'] === null ? null : Number(r['value']), unit: sn(r['unit']),
    status: s(r['status']) as EvidenceStatus, sourceClaimId: sn(r['source_claim_id']),
    basis: sn(r['basis']), operatorKind: s(r['operator_kind']) as OperatorKind,
    createdAt: s(r['created_at']),
  };
}

/** A newer reading is a new row; the older ones stay as history. */
export async function recordVariable(input: {
  projectId: string; activityRef: string; name: string; value: number | null; unit?: string | null;
  status: EvidenceStatus; sourceClaimId?: string | null; basis?: string | null; operatorKind: OperatorKind;
}): Promise<ActivityVariable> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A variable must have a name.');
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  const id = newId('avr');
  await getDb().run(
    `INSERT INTO activity_variables (id, project_id, activity_ref, name, value, unit, status,
       source_claim_id, basis, operator_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.activityRef, name, input.value, input.unit ?? null, input.status,
      input.sourceClaimId ?? null, input.basis ?? null, input.operatorKind, nowIso()],
  );
  return mapVariable((await getDb().get<Row>('SELECT * FROM activity_variables WHERE id = ?', [id]))!);
}

/** The current reading of each variable: the newest per (name, operator kind). */
export async function currentVariables(projectId: string, activityRef: string): Promise<ActivityVariable[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM activity_variables WHERE project_id = ? AND activity_ref = ?
     ORDER BY created_at, id`,
    [projectId, activityRef],
  );
  const latest = new Map<string, ActivityVariable>();
  for (const r of rows) {
    const v = mapVariable(r);
    latest.set(`${v.name}\u0000${v.operatorKind}`, v);
  }
  return [...latest.values()];
}

function mapPossibility(r: Row): Possibility {
  return {
    id: s(r['id']), projectId: s(r['project_id']), ownerUserId: s(r['owner_user_id']),
    kind: s(r['kind']) as PossibilityKind, title: s(r['title']),
    requirements: parseJson<PossibilityRequirements>(r['requirements'] as string, {}),
    sourceRef: sn(r['source_ref']), parkedReason: sn(r['parked_reason']),
    shared: Number(r['shared']) === 1, createdAt: s(r['created_at']), updatedAt: s(r['updated_at']),
  };
}

export async function keepPossibility(input: {
  projectId: string; ownerUserId: string; kind: PossibilityKind; title: string;
  requirements: PossibilityRequirements; sourceRef?: string | null; parkedReason?: string | null;
}): Promise<{ possibility: Possibility; created: boolean }> {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('A possibility must have a title.');
  const id = newId('pos');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO possibilities (id, project_id, owner_user_id, kind, title, requirements,
       source_ref, parked_reason, shared, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.ownerUserId, input.kind, title, toJson(input.requirements),
      input.sourceRef ?? null, input.parkedReason ?? null, at, at],
  );
  const row = input.sourceRef
    ? await getDb().get<Row>(
        'SELECT * FROM possibilities WHERE project_id = ? AND owner_user_id = ? AND source_ref = ?',
        [input.projectId, input.ownerUserId, input.sourceRef])
    : await getDb().get<Row>('SELECT * FROM possibilities WHERE id = ?', [id]);
  const possibility = mapPossibility(row!);
  return { possibility, created: possibility.id === id };
}

export async function listPossibilities(projectId: string, ownerUserId: string): Promise<Possibility[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM possibilities WHERE project_id = ? AND owner_user_id = ? ORDER BY created_at, id',
    [projectId, ownerUserId],
  );
  return rows.map(mapPossibility);
}

/** One possibility, only when it belongs to this owner in this project. */
export async function getPossibility(
  projectId: string, ownerUserId: string, id: string,
): Promise<Possibility | null> {
  const row = await getDb().get<Row>(
    'SELECT * FROM possibilities WHERE project_id = ? AND owner_user_id = ? AND id = ?',
    [projectId, ownerUserId, id],
  );
  return row ? mapPossibility(row) : null;
}

/** Replace a possibility's requirements and parked reason, owner-scoped. */
export async function updatePossibilityRequirements(input: {
  projectId: string; ownerUserId: string; id: string;
  requirements: PossibilityRequirements; parkedReason: string | null;
}): Promise<void> {
  await getDb().run(
    `UPDATE possibilities SET requirements = ?, parked_reason = ?, updated_at = ?
      WHERE project_id = ? AND owner_user_id = ? AND id = ?`,
    [toJson(input.requirements), input.parkedReason, nowIso(), input.projectId, input.ownerUserId, input.id],
  );
}

export async function linkPossibilities(input: {
  projectId: string; fromId: string; toId: string; relation: PossibilityRelation;
}): Promise<PossibilityEdge> {
  await getDb().run(
    `INSERT INTO possibility_edges (id, project_id, from_id, to_id, relation, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('ped'), input.projectId, input.fromId, input.toId, input.relation, nowIso()],
  );
  const r = (await getDb().get<Row>(
    'SELECT * FROM possibility_edges WHERE from_id = ? AND relation = ? AND to_id = ?',
    [input.fromId, input.relation, input.toId]))!;
  return {
    id: s(r['id']), projectId: s(r['project_id']), fromId: s(r['from_id']), toId: s(r['to_id']),
    relation: s(r['relation']) as PossibilityRelation, createdAt: s(r['created_at']),
  };
}

/**
 * One owner's possibility graph in a project, as a research dispatcher needs
 * it: which possibility stands for each source row it was kept from, and every
 * edge between that owner's possibilities. Read by the owner index and the
 * edge identity index; another owner's rows and edges are never returned, and
 * an edge is returned only when both its ends are this owner's.
 */
export async function possibilityGraphOf(
  projectId: string, ownerUserId: string,
): Promise<{ idBySource: Map<string, string>; edges: PossibilityEdge[] }> {
  const sources = await getDb().all<Row>(
    `SELECT id, source_ref FROM possibilities
      WHERE project_id = ? AND owner_user_id = ? AND source_ref IS NOT NULL`,
    [projectId, ownerUserId],
  );
  const rows = await getDb().all<Row>(
    `SELECT e.* FROM possibility_edges e
       JOIN possibilities f ON f.id = e.from_id
       JOIN possibilities t ON t.id = e.to_id
      WHERE e.project_id = ? AND f.project_id = ? AND f.owner_user_id = ?
        AND t.project_id = ? AND t.owner_user_id = ?
      ORDER BY e.created_at, e.id`,
    [projectId, projectId, ownerUserId, projectId, ownerUserId],
  );
  return {
    idBySource: new Map(sources.map((r) => [s(r['source_ref']), s(r['id'])])),
    edges: rows.map((r) => ({
      id: s(r['id']), projectId: s(r['project_id']), fromId: s(r['from_id']), toId: s(r['to_id']),
      relation: s(r['relation']) as PossibilityRelation, createdAt: s(r['created_at']),
    })),
  };
}

function mapCondition(r: Row): PossibilityCondition {
  return {
    id: s(r['id']), projectId: s(r['project_id']), possibilityId: s(r['possibility_id']),
    conditionKey: s(r['condition_key']), createdAt: s(r['created_at']),
    triggeredAt: sn(r['triggered_at']), triggerChangeRef: sn(r['trigger_change_ref']),
  };
}

export async function watchCondition(input: {
  projectId: string; possibilityId: string; conditionKey: string;
}): Promise<PossibilityCondition> {
  await getDb().run(
    `INSERT INTO possibility_conditions (id, project_id, possibility_id, condition_key, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('pco'), input.projectId, input.possibilityId, input.conditionKey, nowIso()],
  );
  return mapCondition((await getDb().get<Row>(
    `SELECT * FROM possibility_conditions WHERE possibility_id = ? AND condition_key = ?
       AND triggered_at IS NULL`, [input.possibilityId, input.conditionKey]))!);
}

/** Untriggered watches for one fact, by the indexed key; never a scan of possibilities. */
export async function watchersOf(projectId: string, conditionKey: string): Promise<PossibilityCondition[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM possibility_conditions WHERE project_id = ? AND condition_key = ?
       AND triggered_at IS NULL ORDER BY created_at, id`,
    [projectId, conditionKey],
  );
  return rows.map(mapCondition);
}

/** Triggers a watch once, by a guarded UPDATE. Returns whether this call did. */
export async function triggerCondition(conditionId: string, changeRef: string): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE possibility_conditions SET triggered_at = ?, trigger_change_ref = ?
     WHERE id = ? AND triggered_at IS NULL`,
    [nowIso(), changeRef, conditionId],
  );
  return r.changes === 1;
}

export async function recordStageMeasurement(
  input: Omit<StageMeasurement, 'id' | 'measuredAt' | 'note'> & { note?: string | null },
): Promise<StageMeasurement> {
  const id = newId('smm');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO stage_measurements (id, project_id, owner_user_id, goal_id, stage, duration_ms,
       screened, rejected, advanced, research_jobs, premium_ai_jobs, note, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.ownerUserId, input.goalId, input.stage, input.durationMs,
      input.screened, input.rejected, input.advanced, input.researchJobs, input.premiumAiJobs,
      input.note ?? null, at],
  );
  return { ...input, id, note: input.note ?? null, measuredAt: at };
}

export async function stageMeasurements(
  projectId: string, ownerUserId: string, goalId: string,
): Promise<StageMeasurement[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM stage_measurements WHERE project_id = ? AND owner_user_id = ? AND goal_id = ?
     ORDER BY measured_at, id`, [projectId, ownerUserId, goalId]);
  return rows.map((r) => ({
    id: s(r['id']), projectId: s(r['project_id']), ownerUserId: s(r['owner_user_id']),
    goalId: s(r['goal_id']), stage: s(r['stage']) as Stage, durationMs: Number(r['duration_ms']),
    screened: Number(r['screened']), rejected: Number(r['rejected']), advanced: Number(r['advanced']),
    researchJobs: Number(r['research_jobs']), premiumAiJobs: Number(r['premium_ai_jobs']),
    note: sn(r['note']), measuredAt: s(r['measured_at']),
  }));
}

// ── Benchmarks: a goal's stage reading, kept so a later one can be compared ──

/** One stage of a benchmark. A null is a figure the reading could not state. */
export interface BenchmarkStage {
  stage: Stage;
  timeMs: number | null;
  screened: number | null;
  rejected: number | null;
  advanced: number | null;
  researchJobs: number | null;
  aiPasses: number | null;
}

export interface GoalBenchmark {
  benchmarkId: string;
  goalId: string;
  label: string | null;
  measuredAt: string;
  stages: BenchmarkStage[];
  relevantOpenings: number | null;
  supportedPlans: number | null;
}

export const BENCHMARK_FIELDS = ['timeMs', 'screened', 'rejected', 'advanced', 'researchJobs', 'aiPasses'] as const;
export type BenchmarkField = (typeof BENCHMARK_FIELDS)[number];

interface BenchmarkNote {
  benchmark: string;
  label: string | null;
  unknown: BenchmarkField[];
  relevantOpenings: number | null;
  supportedPlans: number | null;
}

function nonNegative(value: number | null, what: string): number {
  if (value === null) return 0;
  if (!Number.isFinite(value) || value < 0) throw new Error(`A benchmark figure must be a non-negative number: ${what} was ${value}.`);
  return Math.round(value);
}

/**
 * Keeps one reading of a goal as a benchmark: a row per stage it names, all
 * written in one transaction under one id and one timestamp, so a benchmark is
 * either whole or absent.
 */
export async function recordGoalBenchmark(input: {
  projectId: string;
  ownerUserId: string;
  goalId: string;
  label?: string | null;
  stages: BenchmarkStage[];
  relevantOpenings: number | null;
  supportedPlans: number | null;
}): Promise<GoalBenchmark> {
  if (input.stages.length === 0) throw new Error('A benchmark needs at least one stage.');
  const seen = new Set<string>();
  for (const one of input.stages) {
    if (!(STAGES as readonly string[]).includes(one.stage)) throw new Error(`Unknown stage ${one.stage}.`);
    if (seen.has(one.stage)) throw new Error(`Stage ${one.stage} appears twice in one benchmark.`);
    seen.add(one.stage);
  }
  const benchmarkId = newId('smb');
  const at = nowIso();
  const label = input.label?.trim() ? input.label.trim().slice(0, 120) : null;
  const db = getDb();
  await db.transaction(async () => {
    for (const one of input.stages) {
      const note: BenchmarkNote = {
        benchmark: benchmarkId,
        label,
        unknown: BENCHMARK_FIELDS.filter((field) => one[field] === null),
        relevantOpenings: input.relevantOpenings,
        supportedPlans: input.supportedPlans,
      };
      await db.run(
        `INSERT INTO stage_measurements (id, project_id, owner_user_id, goal_id, stage, duration_ms,
           screened, rejected, advanced, research_jobs, premium_ai_jobs, note, measured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('smm'), input.projectId, input.ownerUserId, input.goalId, one.stage,
          nonNegative(one.timeMs, `${one.stage} time`), nonNegative(one.screened, `${one.stage} screened`),
          nonNegative(one.rejected, `${one.stage} rejected`), nonNegative(one.advanced, `${one.stage} advanced`),
          nonNegative(one.researchJobs, `${one.stage} research jobs`), nonNegative(one.aiPasses, `${one.stage} AI passes`),
          toJson(note), at],
      );
    }
  });
  return {
    benchmarkId, goalId: input.goalId, label, measuredAt: at,
    stages: input.stages.map((one) => ({ ...one })),
    relevantOpenings: input.relevantOpenings, supportedPlans: input.supportedPlans,
  };
}

function readNote(note: string | null): BenchmarkNote | null {
  if (!note) return null;
  const parsed = parseJson<Partial<BenchmarkNote> | null>(note, null);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.benchmark !== 'string') return null;
  return {
    benchmark: parsed.benchmark,
    label: typeof parsed.label === 'string' ? parsed.label : null,
    unknown: Array.isArray(parsed.unknown) ? parsed.unknown.filter((f): f is BenchmarkField => (BENCHMARK_FIELDS as readonly string[]).includes(f)) : [],
    relevantOpenings: typeof parsed.relevantOpenings === 'number' ? parsed.relevantOpenings : null,
    supportedPlans: typeof parsed.supportedPlans === 'number' ? parsed.supportedPlans : null,
  };
}

/**
 * Every benchmark kept for a goal, oldest first, scoped to its owner. A row
 * recorded singly by `recordStageMeasurement` is a benchmark of one stage.
 */
export async function goalBenchmarks(projectId: string, ownerUserId: string, goalId: string): Promise<GoalBenchmark[]> {
  const rows = await stageMeasurements(projectId, ownerUserId, goalId);
  const byId = new Map<string, GoalBenchmark>();
  for (const row of rows) {
    const note = readNote(row.note);
    const id = note?.benchmark ?? row.id;
    const unknown = new Set(note?.unknown ?? []);
    const value = (field: BenchmarkField, n: number): number | null => (unknown.has(field) ? null : n);
    const stage: BenchmarkStage = {
      stage: row.stage,
      timeMs: value('timeMs', row.durationMs),
      screened: value('screened', row.screened),
      rejected: value('rejected', row.rejected),
      advanced: value('advanced', row.advanced),
      researchJobs: value('researchJobs', row.researchJobs),
      aiPasses: value('aiPasses', row.premiumAiJobs),
    };
    const held = byId.get(id);
    if (held) held.stages.push(stage);
    else {
      byId.set(id, {
        benchmarkId: id, goalId: row.goalId, label: note?.label ?? null, measuredAt: row.measuredAt,
        stages: [stage], relevantOpenings: note?.relevantOpenings ?? null, supportedPlans: note?.supportedPlans ?? null,
      });
    }
  }
  const out = [...byId.values()];
  for (const one of out) one.stages.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  return out.sort((a, b) => (a.measuredAt === b.measuredAt ? a.benchmarkId.localeCompare(b.benchmarkId) : a.measuredAt.localeCompare(b.measuredAt)));
}

export interface BenchmarkChange {
  stage: Stage | null;
  field: BenchmarkField | 'relevantOpenings' | 'supportedPlans';
  before: number | null;
  after: number | null;
  /** after − before, or null when either side is unknown: no change is claimed from an unknown. */
  delta: number | null;
}

/** Field by field, what moved between two benchmarks of one goal. Pure. */
export function compareBenchmarks(before: GoalBenchmark, after: GoalBenchmark): BenchmarkChange[] {
  const diff = (b: number | null, a: number | null): number | null => (b === null || a === null ? null : a - b);
  const out: BenchmarkChange[] = [];
  for (const stage of STAGES) {
    const b = before.stages.find((one) => one.stage === stage);
    const a = after.stages.find((one) => one.stage === stage);
    if (!b && !a) continue;
    for (const field of BENCHMARK_FIELDS) {
      const bv = b ? b[field] : null;
      const av = a ? a[field] : null;
      if (bv === null && av === null) continue;
      out.push({ stage, field, before: bv, after: av, delta: diff(bv, av) });
    }
  }
  for (const field of ['relevantOpenings', 'supportedPlans'] as const) {
    if (before[field] === null && after[field] === null) continue;
    out.push({ stage: null, field, before: before[field], after: after[field], delta: diff(before[field], after[field]) });
  }
  return out;
}

function mapGoalPolicy(r: Row): GoalPolicyRecord {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: s(r['id']), goalId: s(r['goal_id']), kind: s(r['kind']),
    reliabilityNormal: num(r['reliability_normal']), reliabilityAdverse: num(r['reliability_adverse']),
    setBy: s(r['set_by']), setAt: s(r['set_at']),
  };
}

/**
 * Record a goal's policy. Append-only: the newest row is the goal's policy and
 * the older ones are its history. The kind is checked by the table, and a
 * reliability standard is refused on any kind but SQUEEZE.
 */
export async function recordGoalPolicy(input: {
  goalId: string; kind: string; reliabilityNormal?: number | null; reliabilityAdverse?: number | null; setBy: string;
}): Promise<GoalPolicyRecord> {
  const id = newId('gpl');
  await getDb().run(
    `INSERT INTO goal_policies (id, goal_id, kind, reliability_normal, reliability_adverse, set_by, set_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.goalId, input.kind, input.reliabilityNormal ?? null, input.reliabilityAdverse ?? null, input.setBy, nowIso()],
  );
  return mapGoalPolicy((await getDb().get<Row>('SELECT * FROM goal_policies WHERE id = ?', [id]))!);
}

/** The goal's current recorded policy, or null when none was ever recorded. */
export async function currentGoalPolicy(goalId: string): Promise<GoalPolicyRecord | null> {
  const row = await getDb().get<Row>(
    'SELECT * FROM goal_policies WHERE goal_id = ? ORDER BY set_at DESC, id DESC LIMIT 1',
    [goalId],
  );
  return row ? mapGoalPolicy(row) : null;
}
