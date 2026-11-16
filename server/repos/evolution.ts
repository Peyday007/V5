/**
 * The experiment rows (§111, migration 156 / pg 147). State moves by compare-and-set:
 * every transition names the state it leaves in the statement that makes it, so two
 * evaluators, a restart or a retry never decide one experiment twice. Results are
 * append-only.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  EvolutionApproachStatRow,
  EvolutionExperimentRow,
  EvolutionHiddenCaseRow,
  EvolutionResultRow,
  EvolutionVariantRow,
} from '../domain/types.ts';
import type { ApproachStat, ApproachType, BenchCase, Verdict } from '../domain/evolution.ts';

export type ExperimentState = 'BUILDING' | 'EVALUATING' | 'DECIDED' | 'HELD';
export type VariantState = 'BUILDING' | 'PR_READY' | 'FAILED' | 'ADOPTED' | 'REJECTED';

export interface Experiment {
  id: string;
  candidateId: string;
  deficiency: string;
  capabilityClass: string;
  suite: string;
  baselineSha: string;
  state: ExperimentState;
  verdict: Verdict | null;
  winnerVariantId: string | null;
  origin: string;
  runId: string | null;
  cause: string | null;
  rationale: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Variant {
  id: string;
  experimentId: string;
  label: string;
  approachType: ApproachType;
  approachText: string;
  signature: string;
  ownerPaths: string[];
  candidateId: string | null;
  campaignId: string | null;
  prUrl: string | null;
  headSha: string | null;
  branch: string | null;
  linesChanged: number | null;
  state: VariantState;
  score: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvolutionResult {
  id: string;
  experimentId: string | null;
  variantId: string | null;
  sha: string;
  ref: string | null;
  suite: string;
  metrics: Record<string, number>;
  cases: BenchCase[];
  hidden: boolean;
  cause: string | null;
  ownerPaths: string[];
  ranAt: string;
  recordedAt: string;
}

const mapExperiment = (r: EvolutionExperimentRow): Experiment => ({
  id: r.id,
  candidateId: r.candidate_id,
  deficiency: r.deficiency,
  capabilityClass: r.capability_class,
  suite: r.suite,
  baselineSha: r.baseline_sha,
  state: r.state as ExperimentState,
  verdict: (r.verdict as Verdict | null) ?? null,
  winnerVariantId: r.winner_variant_id,
  origin: r.origin,
  runId: r.run_id,
  cause: r.cause,
  rationale: r.rationale,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const mapVariant = (r: EvolutionVariantRow): Variant => ({
  id: r.id,
  experimentId: r.experiment_id,
  label: r.label,
  approachType: r.approach_type as ApproachType,
  approachText: r.approach_text,
  signature: r.signature,
  ownerPaths: parseJson<string[]>(r.owner_paths, []),
  candidateId: r.candidate_id,
  campaignId: r.campaign_id,
  prUrl: r.pr_url,
  headSha: r.head_sha,
  branch: r.branch,
  linesChanged: r.lines_changed === null ? null : Number(r.lines_changed),
  state: r.state as VariantState,
  score: parseJson<Record<string, unknown> | null>(r.score, null),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapResult = (r: EvolutionResultRow): EvolutionResult => ({
  id: r.id,
  experimentId: r.experiment_id,
  variantId: r.variant_id,
  sha: r.sha,
  ref: r.ref,
  suite: r.suite,
  metrics: parseJson<Record<string, number>>(r.metrics_json, {}),
  cases: parseJson<BenchCase[]>(r.cases_json, []),
  hidden: Number(r.hidden) === 1,
  cause: r.cause,
  ownerPaths: parseJson<string[]>(r.owner_paths, []),
  ranAt: r.ran_at,
  recordedAt: r.recorded_at,
});

/* ------------------------------------------------------------------------- */
/* Experiments                                                                */
/* ------------------------------------------------------------------------- */

export async function insertExperiment(input: {
  /** Chosen by the caller when the register row must name it before the experiment exists. */
  id?: string;
  candidateId: string;
  deficiency: string;
  capabilityClass: string;
  suite: string;
  baselineSha: string;
  origin: string;
  runId: string | null;
  cause: string | null;
}): Promise<Experiment> {
  const id = input.id ?? newExperimentId();
  await getDb().run(
    `INSERT INTO evolution_experiments (id, candidate_id, deficiency, capability_class, suite, baseline_sha, state, origin, run_id, cause, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'BUILDING', ?, ?, ?, ?)`,
    [id, input.candidateId, input.deficiency, input.capabilityClass, input.suite, input.baselineSha, input.origin, input.runId, input.cause, nowIso()],
  );
  return (await getExperiment(id))!;
}

export function newExperimentId(): string {
  return newId('evx');
}

export async function getExperiment(id: string): Promise<Experiment | null> {
  const row = await getDb().get<EvolutionExperimentRow>('SELECT * FROM evolution_experiments WHERE id = ?', [id]);
  return row ? mapExperiment(row) : null;
}

export async function experimentForCandidate(candidateId: string): Promise<Experiment | null> {
  const row = await getDb().get<EvolutionExperimentRow>('SELECT * FROM evolution_experiments WHERE candidate_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [candidateId]);
  return row ? mapExperiment(row) : null;
}

export async function listExperiments(options: { states?: ExperimentState[]; limit?: number } = {}): Promise<Experiment[]> {
  const states = options.states ?? [];
  const rows = await getDb().all<EvolutionExperimentRow>(
    `SELECT * FROM evolution_experiments ${states.length ? `WHERE state IN (${states.map(() => '?').join(', ')})` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...states, options.limit ?? 200],
  );
  return rows.map(mapExperiment);
}

/** Move an experiment from one state to another, once: false when another caller moved it first. */
export async function transitionExperiment(
  id: string,
  from: ExperimentState,
  to: ExperimentState,
  patch: { verdict?: Verdict | null; winnerVariantId?: string | null; rationale?: string | null; decidedAt?: string | null } = {},
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE evolution_experiments
        SET state = ?, verdict = COALESCE(?, verdict), winner_variant_id = COALESCE(?, winner_variant_id),
            rationale = COALESCE(?, rationale), decided_at = COALESCE(?, decided_at)
      WHERE id = ? AND state = ?`,
    [to, patch.verdict ?? null, patch.winnerVariantId ?? null, patch.rationale ?? null, patch.decidedAt ?? null, id, from],
  );
  return Number(result.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------------- */
/* Variants                                                                   */
/* ------------------------------------------------------------------------- */

export async function insertVariant(input: {
  experimentId: string;
  label: string;
  approachType: string;
  approachText: string;
  signature: string;
  ownerPaths: string[];
}): Promise<Variant> {
  const id = newId('evv');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO evolution_variants (id, experiment_id, label, approach_type, approach_text, signature, owner_paths, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BUILDING', ?, ?)`,
    [id, input.experimentId, input.label, input.approachType, input.approachText, input.signature, toJson(input.ownerPaths), at, at],
  );
  return (await getVariant(id))!;
}

export async function getVariant(id: string): Promise<Variant | null> {
  const row = await getDb().get<EvolutionVariantRow>('SELECT * FROM evolution_variants WHERE id = ?', [id]);
  return row ? mapVariant(row) : null;
}

export async function variantForCandidate(candidateId: string): Promise<Variant | null> {
  const row = await getDb().get<EvolutionVariantRow>('SELECT * FROM evolution_variants WHERE candidate_id = ?', [candidateId]);
  return row ? mapVariant(row) : null;
}

export async function listVariants(experimentId: string): Promise<Variant[]> {
  const rows = await getDb().all<EvolutionVariantRow>('SELECT * FROM evolution_variants WHERE experiment_id = ? ORDER BY label, id', [experimentId]);
  return rows.map(mapVariant);
}

/** Link facts to a variant (its register row, campaign, pull request). Only fields given are written. */
export async function linkVariant(
  id: string,
  patch: Partial<{ candidateId: string; campaignId: string; prUrl: string; headSha: string; branch: string; linesChanged: number }>,
): Promise<void> {
  const cols: Record<string, string> = {
    candidateId: 'candidate_id',
    campaignId: 'campaign_id',
    prUrl: 'pr_url',
    headSha: 'head_sha',
    branch: 'branch',
    linesChanged: 'lines_changed',
  };
  const sets: string[] = [];
  const values: (string | number)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    sets.push(`${cols[k]} = ?`);
    values.push(v as string | number);
  }
  if (!sets.length) return;
  await getDb().run(`UPDATE evolution_variants SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...values, nowIso(), id]);
}

/** Compare-and-set on a variant's state. */
export async function transitionVariant(id: string, from: VariantState[], to: VariantState, score: Record<string, unknown> | null = null): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE evolution_variants SET state = ?, score = COALESCE(?, score), updated_at = ?
      WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`,
    [to, score ? toJson(score) : null, nowIso(), id, ...from],
  );
  return Number(result.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------------- */
/* Results (append-only)                                                      */
/* ------------------------------------------------------------------------- */

export async function insertResult(input: {
  experimentId: string | null;
  variantId: string | null;
  sha: string;
  ref: string | null;
  suite: string;
  metrics: Record<string, number>;
  cases: BenchCase[];
  hidden: boolean;
  cause: string | null;
  ownerPaths: string[];
  ranAt: string;
}): Promise<EvolutionResult> {
  const id = newId('evr');
  await getDb().run(
    `INSERT INTO evolution_results (id, experiment_id, variant_id, sha, ref, suite, metrics_json, cases_json, hidden, cause, owner_paths, ran_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.experimentId,
      input.variantId,
      input.sha,
      input.ref,
      input.suite,
      toJson(input.metrics),
      toJson(input.cases),
      input.hidden ? 1 : 0,
      input.cause,
      input.ownerPaths.length ? toJson(input.ownerPaths) : null,
      input.ranAt,
      nowIso(),
    ],
  );
  const row = await getDb().get<EvolutionResultRow>('SELECT * FROM evolution_results WHERE id = ?', [id]);
  return mapResult(row!);
}

export async function listResults(experimentId: string): Promise<EvolutionResult[]> {
  const rows = await getDb().all<EvolutionResultRow>('SELECT * FROM evolution_results WHERE experiment_id = ? ORDER BY ran_at, id', [experimentId]);
  return rows.map(mapResult);
}

/** Production baselines of a suite (variant_id NULL), oldest first, bounded. */
export async function listBaselines(suite: string, limit = 50): Promise<EvolutionResult[]> {
  const rows = await getDb().all<EvolutionResultRow>(
    'SELECT * FROM evolution_results WHERE suite = ? AND variant_id IS NULL ORDER BY ran_at DESC, id DESC LIMIT ?',
    [suite, limit],
  );
  return rows.map(mapResult).reverse();
}

export async function firstBaseline(suite: string): Promise<EvolutionResult | null> {
  const row = await getDb().get<EvolutionResultRow>(
    'SELECT * FROM evolution_results WHERE suite = ? AND variant_id IS NULL ORDER BY ran_at, id LIMIT 1',
    [suite],
  );
  return row ? mapResult(row) : null;
}

/* ------------------------------------------------------------------------- */
/* Hidden cases                                                               */
/* ------------------------------------------------------------------------- */

export async function insertHiddenCase(input: { suite: string; caseJson: unknown; createdBy: string }): Promise<{ id: string }> {
  const id = newId('evh');
  await getDb().run('INSERT INTO evolution_hidden_cases (id, suite, case_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.suite,
    toJson(input.caseJson),
    input.createdBy,
    nowIso(),
  ]);
  return { id };
}

export async function listHiddenCases(suite: string): Promise<{ id: string; suite: string; case: unknown; createdBy: string; createdAt: string }[]> {
  const rows = await getDb().all<EvolutionHiddenCaseRow>('SELECT * FROM evolution_hidden_cases WHERE suite = ? ORDER BY created_at, id', [suite]);
  return rows.map((r) => ({ id: r.id, suite: r.suite, case: parseJson<unknown>(r.case_json, null), createdBy: r.created_by, createdAt: r.created_at }));
}

export async function countHiddenCases(): Promise<Record<string, number>> {
  const rows = await getDb().all<{ suite: string; n: number | string }>('SELECT suite, COUNT(*) AS n FROM evolution_hidden_cases GROUP BY suite', []);
  return Object.fromEntries(rows.map((r) => [r.suite, Number(r.n)]));
}

/* ------------------------------------------------------------------------- */
/* Approach statistics                                                        */
/* ------------------------------------------------------------------------- */

const mapStat = (r: EvolutionApproachStatRow): ApproachStat => ({
  approachType: r.approach_type,
  capabilityClass: r.capability_class,
  trials: Number(r.trials),
  wins: Number(r.wins),
  totalLift: Number(r.total_lift),
  retiredAt: r.retired_at,
});

export async function listApproachStats(): Promise<ApproachStat[]> {
  const rows = await getDb().all<EvolutionApproachStatRow>('SELECT * FROM evolution_approach_stats ORDER BY capability_class, approach_type', []);
  return rows.map(mapStat);
}

/** Credit one trial of an approach type in a class; the increment is in the statement. */
export async function creditApproach(input: { approachType: string; capabilityClass: string; won: boolean; lift: number }): Promise<ApproachStat> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO evolution_approach_stats (approach_type, capability_class, trials, wins, total_lift, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (approach_type, capability_class)
     DO UPDATE SET trials = evolution_approach_stats.trials + 1, wins = evolution_approach_stats.wins + ?,
                   total_lift = evolution_approach_stats.total_lift + ?, updated_at = ?`,
    [input.approachType, input.capabilityClass, input.won ? 1 : 0, input.lift, at, input.won ? 1 : 0, input.lift, at],
  );
  const row = await getDb().get<EvolutionApproachStatRow>(
    'SELECT * FROM evolution_approach_stats WHERE approach_type = ? AND capability_class = ?',
    [input.approachType, input.capabilityClass],
  );
  return mapStat(row!);
}

export async function retireApproach(approachType: string, capabilityClass: string): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE evolution_approach_stats SET retired_at = ?, updated_at = ? WHERE approach_type = ? AND capability_class = ? AND retired_at IS NULL',
    [nowIso(), nowIso(), approachType, capabilityClass],
  );
  return Number(result.changes ?? 0) > 0;
}
