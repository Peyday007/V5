/**
 * Capacity claims and capacity experiments, as rows.
 *
 * ---------------------------------------------------------------------------
 * Every transition is a compare-and-swap naming the state it moves from
 * ---------------------------------------------------------------------------
 *
 * This is the sixth place in this codebase to need that sentence — the queue's
 * `lease_generation`, the fleet's `fire_generation`, a connected site's
 * `source_version`, an idempotency reservation, a cash commitment — and the
 * reason is the same each time: **the guard must be on a value the claimant does
 * not supply.** Here the value is the experiment's own `state`, and the two
 * things it buys are worth naming separately.
 *
 * Two ticks reading one `PROPOSED` row both try to authorize it, the `UPDATE`
 * says `WHERE state = 'PROPOSED'`, and exactly one matches. A losing transition
 * is an ordinary outcome and not an error.
 *
 * And a restart in the middle of an experiment resumes it rather than starting a
 * second canary. The kernel's tick is idempotent by these rows rather than by a
 * flag, for §27's reason: a flag can be set by a tick that then dies, and rows
 * cannot. That is the whole of "restarting during an experiment cannot duplicate
 * the canary" — there is no in-memory state to lose.
 *
 * `capacityNow()` exists for `queueNow()`'s reason: every time decision in here
 * uses Brain's clock, never a worker's, and the assumption is written down in one
 * place rather than implied at a dozen call sites.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import {
  isCapacityDimension,
  isCapacityExperimentKind,
  type CapacityBound,
  type CapacityConfidence,
  type CapacityDimension,
  type CapacityEvidenceClass,
  type CapacityExperimentKind,
  type CapacityExperimentState,
  type CapacityExperimentVerdict,
} from '../domain/capacity.ts';
import type { PolicyScope } from '../domain/types.ts';

/** Brain's clock. See the header. */
export function capacityNow(): string {
  return nowIso();
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

export interface CapacityClaimRow {
  id: string;
  dimension: string;
  scope: string;
  scope_id: string | null;
  workload_class: string;
  value: number | null;
  bound: string;
  evidence_class: string;
  explanation: string;
  sample_count: number;
  confidence: string;
  evidence_ids: string;
  contradictions: string;
  staleness: string;
  code_version: string | null;
  config_hash: string | null;
  first_observed_at: string;
  last_verified_at: string;
  superseded_at: string | null;
  superseded_by_id: string | null;
  superseded_reason: string | null;
}

export interface CapacityClaim {
  id: string;
  dimension: CapacityDimension;
  scope: PolicyScope;
  scopeId: string | null;
  workloadClass: string;
  value: number | null;
  bound: CapacityBound;
  evidenceClass: CapacityEvidenceClass;
  explanation: string;
  sampleCount: number;
  confidence: CapacityConfidence;
  evidenceIds: string[];
  contradictions: string[];
  staleness: string[];
  codeVersion: string | null;
  configHash: string | null;
  firstObservedAt: string;
  lastVerifiedAt: string;
  supersededAt: string | null;
  supersededById: string | null;
  supersededReason: string | null;
}

function mapClaim(row: CapacityClaimRow): CapacityClaim {
  return {
    id: row.id,
    dimension: row.dimension as CapacityDimension,
    scope: row.scope as PolicyScope,
    scopeId: row.scope_id,
    workloadClass: row.workload_class,
    value: row.value === null ? null : Number(row.value),
    bound: row.bound as CapacityBound,
    evidenceClass: row.evidence_class as CapacityEvidenceClass,
    explanation: row.explanation,
    sampleCount: row.sample_count,
    confidence: row.confidence as CapacityConfidence,
    evidenceIds: parseJson<string[]>(row.evidence_ids, []),
    contradictions: parseJson<string[]>(row.contradictions, []),
    staleness: parseJson<string[]>(row.staleness, []),
    codeVersion: row.code_version,
    configHash: row.config_hash,
    firstObservedAt: row.first_observed_at,
    lastVerifiedAt: row.last_verified_at,
    supersededAt: row.superseded_at,
    supersededById: row.superseded_by_id,
    supersededReason: row.superseded_reason,
  };
}

export interface CapacityExperimentRow {
  id: string;
  kind: string;
  dimension: string;
  scope: string;
  scope_id: string | null;
  workload_class: string;
  state: string;
  hypothesis: string;
  success_metric: string;
  stop_condition: string;
  resolves_unknown: string;
  factor: string | null;
  baseline_value: number | null;
  canary_value: number | null;
  user_action: string | null;
  rollback_policy_version: number | null;
  rollback_target: number | null;
  applied_policy_version: number | null;
  canary_bin_ids: string;
  baseline_reading: string | null;
  canary_reading: string | null;
  verdict: string | null;
  verdict_reason: string | null;
  requested_by: string;
  authority_channel: string;
  created_at: string;
  updated_at: string;
  canary_until: string | null;
  settled_at: string | null;
}

export interface CapacityExperiment {
  id: string;
  kind: CapacityExperimentKind;
  dimension: CapacityDimension;
  scope: PolicyScope;
  scopeId: string | null;
  workloadClass: string;
  state: CapacityExperimentState;
  hypothesis: string;
  successMetric: string;
  stopCondition: string;
  resolvesUnknown: string;
  factor: string | null;
  baselineValue: number | null;
  canaryValue: number | null;
  userAction: string | null;
  rollbackPolicyVersion: number | null;
  rollbackTarget: number | null;
  appliedPolicyVersion: number | null;
  canaryBinIds: string[];
  baselineReading: unknown;
  canaryReading: unknown;
  verdict: CapacityExperimentVerdict | null;
  verdictReason: string | null;
  requestedBy: string;
  authorityChannel: 'REPORTED' | 'SHELL' | 'BROWSER';
  createdAt: string;
  updatedAt: string;
  canaryUntil: string | null;
  settledAt: string | null;
}

function mapExperiment(row: CapacityExperimentRow): CapacityExperiment {
  return {
    id: row.id,
    kind: row.kind as CapacityExperimentKind,
    dimension: row.dimension as CapacityDimension,
    scope: row.scope as PolicyScope,
    scopeId: row.scope_id,
    workloadClass: row.workload_class,
    state: row.state as CapacityExperimentState,
    hypothesis: row.hypothesis,
    successMetric: row.success_metric,
    stopCondition: row.stop_condition,
    resolvesUnknown: row.resolves_unknown,
    factor: row.factor,
    baselineValue: row.baseline_value === null ? null : Number(row.baseline_value),
    canaryValue: row.canary_value === null ? null : Number(row.canary_value),
    userAction: row.user_action,
    rollbackPolicyVersion: row.rollback_policy_version,
    rollbackTarget: row.rollback_target,
    appliedPolicyVersion: row.applied_policy_version,
    canaryBinIds: parseJson<string[]>(row.canary_bin_ids, []),
    baselineReading: parseJson<unknown>(row.baseline_reading, null),
    canaryReading: parseJson<unknown>(row.canary_reading, null),
    verdict: row.verdict as CapacityExperimentVerdict | null,
    verdictReason: row.verdict_reason,
    requestedBy: row.requested_by,
    authorityChannel: row.authority_channel as 'REPORTED' | 'SHELL' | 'BROWSER',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canaryUntil: row.canary_until,
    settledAt: row.settled_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Claims                                                                     */
/* -------------------------------------------------------------------------- */

export interface RecordClaimInput {
  dimension: CapacityDimension;
  scope: PolicyScope;
  scopeId?: string | null;
  workloadClass?: string;
  value: number | null;
  bound: CapacityBound;
  evidenceClass: CapacityEvidenceClass;
  explanation: string;
  sampleCount: number;
  confidence: CapacityConfidence;
  evidenceIds?: string[];
  contradictions?: string[];
  staleness?: string[];
  codeVersion?: string | null;
  configHash?: string | null;
}

export interface RecordClaimOutcome {
  claim: CapacityClaim;
  /** What happened to the previous live claim, if there was one. */
  action: 'CREATED' | 'REVERIFIED' | 'SUPERSEDED';
}

/**
 * Write what Brain now believes about one dimension.
 *
 * Three outcomes, and the difference between the first two is the reason this
 * table exists at all:
 *
 *   * **CREATED** — nothing was believed about this before.
 *   * **REVERIFIED** — the same conclusion still holds. `last_verified_at` moves
 *     and **`first_observed_at` does not**, which is what makes "we have believed
 *     this since the 14th and re-checked it today" sayable. A row that reset its
 *     own first-observed date on every tick would make every claim look new and
 *     nothing would ever have a history.
 *   * **SUPERSEDED** — the conclusion changed. The old row keeps its value, its
 *     evidence and its dates, gains a pointer to the new one and the reason, and
 *     drops out of the live index. §5 at a conclusion: current state may mutate,
 *     history does not.
 *
 * "The same conclusion" is the value, the bound and the evidence class together.
 * A claim that moved from `AT_LEAST 2 MEASURED` to `AT_LEAST 2 INFERRED` is a
 * different claim about the same number and must not be recorded as a
 * re-verification — the whole point of the evidence vocabulary is that how a
 * number was established is part of the number.
 */
export async function recordClaim(input: RecordClaimInput): Promise<RecordClaimOutcome> {
  if (!isCapacityDimension(input.dimension)) {
    throw new Error(`unknown capacity dimension: ${input.dimension}`);
  }
  /*
   * The database enforces this too, as a CHECK. It is asked here as well so the
   * failure is a sentence naming the rule rather than a constraint violation, and
   * because a caller that got this wrong has a bug worth reading about: a zero
   * dressed as an unknown, or an unknown dressed as a zero, is invariant 39 at
   * the one place it is easiest to write by accident.
   */
  if ((input.evidenceClass === 'UNKNOWN') !== (input.value === null)) {
    throw new Error(
      'an UNKNOWN claim carries no value and a value is never UNKNOWN: ' +
        `${input.dimension} was given ${input.evidenceClass} with value ${String(input.value)}`,
    );
  }

  const db = getDb();
  const now = capacityNow();
  const scopeId = input.scopeId ?? null;
  const workloadClass = input.workloadClass ?? 'ANY';

  const existing = await liveClaim(input.dimension, input.scope, scopeId, workloadClass);

  if (
    existing &&
    existing.value === input.value &&
    existing.bound === input.bound &&
    existing.evidenceClass === input.evidenceClass
  ) {
    await db.run(
      `UPDATE capacity_claims
          SET last_verified_at = ?, sample_count = ?, confidence = ?, evidence_ids = ?,
              contradictions = ?, staleness = ?, explanation = ?, code_version = ?, config_hash = ?
        WHERE id = ? AND superseded_at IS NULL`,
      [
        now,
        input.sampleCount,
        input.confidence,
        toJson(input.evidenceIds ?? []),
        toJson(input.contradictions ?? []),
        toJson(input.staleness ?? []),
        input.explanation,
        input.codeVersion ?? null,
        input.configHash ?? null,
        existing.id,
      ],
    );
    return { claim: (await claimById(existing.id))!, action: 'REVERIFIED' };
  }

  const id = newId('ccl');
  /*
   * Supersede first, then insert.
   *
   * The unique index allows one live row per question, so the old one must stop
   * being live before the new one exists. The other order fails the index and
   * loses the new conclusion; this order can at worst leave a moment with no live
   * claim, which reads as *not yet established* — the safe direction, and the
   * same trade `connectSite` makes by revoking a credential before issuing the
   * replacement so there is never more than one live secret to reason about.
   */
  if (existing) {
    await db.run(
      `UPDATE capacity_claims
          SET superseded_at = ?, superseded_by_id = ?, superseded_reason = ?
        WHERE id = ? AND superseded_at IS NULL`,
      [
        now,
        id,
        `re-derived as ${input.evidenceClass} ${input.bound} ${String(input.value)} from ${input.sampleCount} sample(s)`,
        existing.id,
      ],
    );
  }

  await db.run(
    `INSERT INTO capacity_claims (id, dimension, scope, scope_id, workload_class, value, bound,
       evidence_class, explanation, sample_count, confidence, evidence_ids, contradictions,
       staleness, code_version, config_hash, first_observed_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.dimension,
      input.scope,
      scopeId,
      workloadClass,
      input.value,
      input.bound,
      input.evidenceClass,
      input.explanation,
      input.sampleCount,
      input.confidence,
      toJson(input.evidenceIds ?? []),
      toJson(input.contradictions ?? []),
      toJson(input.staleness ?? []),
      input.codeVersion ?? null,
      input.configHash ?? null,
      now,
      now,
    ],
  );

  return { claim: (await claimById(id))!, action: existing ? 'SUPERSEDED' : 'CREATED' };
}

export async function claimById(id: string): Promise<CapacityClaim | null> {
  const row = await getDb().get<CapacityClaimRow>('SELECT * FROM capacity_claims WHERE id = ?', [id]);
  return row ? mapClaim(row) : null;
}

export async function liveClaim(
  dimension: CapacityDimension,
  scope: PolicyScope,
  scopeId: string | null,
  workloadClass = 'ANY',
): Promise<CapacityClaim | null> {
  const row = scopeId
    ? await getDb().get<CapacityClaimRow>(
        `SELECT * FROM capacity_claims
          WHERE dimension = ? AND scope = ? AND scope_id = ? AND workload_class = ?
            AND superseded_at IS NULL`,
        [dimension, scope, scopeId, workloadClass],
      )
    : await getDb().get<CapacityClaimRow>(
        `SELECT * FROM capacity_claims
          WHERE dimension = ? AND scope = ? AND scope_id IS NULL AND workload_class = ?
            AND superseded_at IS NULL`,
        [dimension, scope, workloadClass],
      );
  return row ? mapClaim(row) : null;
}

/** Every live claim for a scope, newest verification first. */
export async function liveClaims(scope: PolicyScope, scopeId: string | null = null): Promise<CapacityClaim[]> {
  const rows = scopeId
    ? await getDb().all<CapacityClaimRow>(
        `SELECT * FROM capacity_claims WHERE scope = ? AND scope_id = ? AND superseded_at IS NULL
          ORDER BY last_verified_at DESC, id`,
        [scope, scopeId],
      )
    : await getDb().all<CapacityClaimRow>(
        `SELECT * FROM capacity_claims WHERE scope = ? AND scope_id IS NULL AND superseded_at IS NULL
          ORDER BY last_verified_at DESC, id`,
        [scope],
      );
  return rows.map(mapClaim);
}

/**
 * The history of one question, including what was superseded and why.
 *
 * `ORDER BY first_observed_at DESC, id` rather than a tiebreak on `rowid`. The
 * `id` is a column both dialects have; `rowid` is rewritten to `seq`, and an
 * `ORDER BY` that only one dialect can say is the mistake this repository has now
 * made three times.
 */
export async function claimHistory(
  dimension: CapacityDimension,
  scope: PolicyScope,
  scopeId: string | null = null,
  limit = 20,
): Promise<CapacityClaim[]> {
  const bounded = Math.max(1, Math.min(200, limit));
  const rows = scopeId
    ? await getDb().all<CapacityClaimRow>(
        `SELECT * FROM capacity_claims WHERE dimension = ? AND scope = ? AND scope_id = ?
          ORDER BY first_observed_at DESC, id LIMIT ?`,
        [dimension, scope, scopeId, bounded],
      )
    : await getDb().all<CapacityClaimRow>(
        `SELECT * FROM capacity_claims WHERE dimension = ? AND scope = ? AND scope_id IS NULL
          ORDER BY first_observed_at DESC, id LIMIT ?`,
        [dimension, scope, bounded],
      );
  return rows.map(mapClaim);
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                */
/* -------------------------------------------------------------------------- */

export interface ProposeExperimentInput {
  kind: CapacityExperimentKind;
  dimension: CapacityDimension;
  scope: PolicyScope;
  scopeId?: string | null;
  workloadClass?: string;
  hypothesis: string;
  successMetric: string;
  stopCondition: string;
  resolvesUnknown: string;
  factor?: string | null;
  baselineValue?: number | null;
  canaryValue?: number | null;
  /** Whose authority this carries. Attribution, never authentication. */
  requestedBy: string;
  /**
   * How the call got in. Defaults to the weaker, unverifiable value because Brain
   * cannot check a channel and must never assume the stronger one — §23's own
   * column pair, at a new table.
   */
  authorityChannel?: 'REPORTED' | 'SHELL' | 'BROWSER';
}

/**
 * Propose one, or return the live one that already owns this question.
 *
 * Never two. The unique partial index is the arbiter and a loser reads back the
 * row it collided with, which is §20's shape: exactly one caller inserts and
 * every other equivalent caller reads what it collided with rather than being
 * refused. That is what makes the kernel's tick safe to run on two instances.
 */
export async function proposeExperiment(
  input: ProposeExperimentInput,
): Promise<{ experiment: CapacityExperiment; created: boolean }> {
  if (!isCapacityExperimentKind(input.kind)) {
    throw new Error(`unknown capacity experiment kind: ${input.kind}`);
  }
  if (!isCapacityDimension(input.dimension)) {
    throw new Error(`unknown capacity dimension: ${input.dimension}`);
  }
  const scopeId = input.scopeId ?? null;

  const existing = await liveExperiment(input.dimension, input.scope, scopeId);
  if (existing) return { experiment: existing, created: false };

  const id = newId('cex');
  const now = capacityNow();
  try {
    await getDb().run(
      `INSERT INTO capacity_experiments (id, kind, dimension, scope, scope_id, workload_class, state,
         hypothesis, success_metric, stop_condition, resolves_unknown, factor, baseline_value,
         canary_value, requested_by, authority_channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.dimension,
        input.scope,
        scopeId,
        input.workloadClass ?? 'ANY',
        input.hypothesis,
        input.successMetric,
        input.stopCondition,
        input.resolvesUnknown,
        input.factor ?? null,
        input.baselineValue ?? null,
        input.canaryValue ?? null,
        input.requestedBy,
        input.authorityChannel ?? 'REPORTED',
        now,
        now,
      ],
    );
  } catch {
    /*
     * Lost the index. Somebody else proposed the same question between the read
     * above and this insert, which is an ordinary outcome rather than an error —
     * the same sentence §19 uses about a losing claim. Read theirs back.
     */
    const winner = await liveExperiment(input.dimension, input.scope, scopeId);
    if (winner) return { experiment: winner, created: false };
    throw new Error('could not propose a capacity experiment and none is live');
  }
  return { experiment: (await experimentById(id))!, created: true };
}

export async function experimentById(id: string): Promise<CapacityExperiment | null> {
  const row = await getDb().get<CapacityExperimentRow>(
    'SELECT * FROM capacity_experiments WHERE id = ?',
    [id],
  );
  return row ? mapExperiment(row) : null;
}

const LIVE_STATES = "('PROPOSED','AUTHORIZED','CANARY_RUNNING','EVALUATING','NEEDS_USER')";

export async function liveExperiment(
  dimension: CapacityDimension,
  scope: PolicyScope,
  scopeId: string | null,
): Promise<CapacityExperiment | null> {
  const row = scopeId
    ? await getDb().get<CapacityExperimentRow>(
        `SELECT * FROM capacity_experiments
          WHERE dimension = ? AND scope = ? AND scope_id = ? AND state IN ${LIVE_STATES}`,
        [dimension, scope, scopeId],
      )
    : await getDb().get<CapacityExperimentRow>(
        `SELECT * FROM capacity_experiments
          WHERE dimension = ? AND scope = ? AND scope_id IS NULL AND state IN ${LIVE_STATES}`,
        [dimension, scope],
      );
  return row ? mapExperiment(row) : null;
}

/** Every experiment that has not settled, oldest first. */
export async function liveExperiments(): Promise<CapacityExperiment[]> {
  const rows = await getDb().all<CapacityExperimentRow>(
    `SELECT * FROM capacity_experiments WHERE state IN ${LIVE_STATES} ORDER BY created_at, id`,
    [],
  );
  return rows.map(mapExperiment);
}

export async function recentExperiments(limit = 20): Promise<CapacityExperiment[]> {
  const rows = await getDb().all<CapacityExperimentRow>(
    `SELECT * FROM capacity_experiments ORDER BY created_at DESC, id LIMIT ?`,
    [Math.max(1, Math.min(200, limit))],
  );
  return rows.map(mapExperiment);
}

/**
 * Authorize a proposal, recording the rollback point in the same statement.
 *
 * The rollback point is captured **here** rather than read back when a rollback
 * happens, and that ordering is the whole safety of the mechanism: by the time a
 * rollback runs, the current policy row is the experiment's *own* change, so a
 * "revert to the current policy" would quietly adopt the thing it was reverting.
 *
 * Returns false when the row was not `PROPOSED`, which means somebody else
 * authorized it, or it was abandoned, or a restart is replaying a tick that
 * already did this. All three are ordinary.
 */
export async function authorizeExperiment(input: {
  id: string;
  rollbackPolicyVersion: number | null;
  rollbackTarget: number | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_experiments
        SET state = 'AUTHORIZED', rollback_policy_version = ?, rollback_target = ?, updated_at = ?
      WHERE id = ? AND state = 'PROPOSED'`,
    [input.rollbackPolicyVersion, input.rollbackTarget, capacityNow(), input.id],
  );
  return result.changes > 0;
}

/**
 * Park an experiment on an action only a person can take.
 *
 * `user_action` is NOT NULL for this state, enforced by a CHECK: §24's rule that
 * an escalation with no answering transition is stuck rather than waiting, made
 * unsayable rather than merely discouraged. Reachable from `PROPOSED` only —
 * an experiment already changing something must be rolled back rather than
 * parked, or the change would outlive the experiment.
 */
export async function parkExperimentForUser(input: { id: string; userAction: string }): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_experiments
        SET state = 'NEEDS_USER', user_action = ?, updated_at = ?
      WHERE id = ? AND state = 'PROPOSED'`,
    [input.userAction, capacityNow(), input.id],
  );
  return result.changes > 0;
}

/**
 * Start the canary: record what was applied, the bins created for it, and when
 * the window closes.
 *
 * `canary_bin_ids` is written in the same statement that moves the state, so a
 * restart between them is impossible. That is what stops a duplicate canary: a
 * tick that finds `CANARY_RUNNING` reads the bins that already exist instead of
 * making more.
 */
export async function startCanary(input: {
  id: string;
  appliedPolicyVersion: number | null;
  canaryBinIds: string[];
  canaryUntil: string;
  baselineReading: unknown;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_experiments
        SET state = 'CANARY_RUNNING', applied_policy_version = ?, canary_bin_ids = ?,
            canary_until = ?, baseline_reading = ?, updated_at = ?
      WHERE id = ? AND state = 'AUTHORIZED'`,
    [
      input.appliedPolicyVersion,
      toJson(input.canaryBinIds),
      input.canaryUntil,
      toJson(input.baselineReading),
      capacityNow(),
      input.id,
    ],
  );
  return result.changes > 0;
}

/** The canary window has closed; nothing may be adopted before this. */
export async function beginEvaluating(input: { id: string; canaryReading: unknown }): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_experiments
        SET state = 'EVALUATING', canary_reading = ?, updated_at = ?
      WHERE id = ? AND state = 'CANARY_RUNNING'`,
    [toJson(input.canaryReading), capacityNow(), input.id],
  );
  return result.changes > 0;
}

/**
 * Settle it: adopted, rolled back, or abandoned.
 *
 * The guard names every state a settlement may legitimately come from, and they
 * differ per outcome:
 *
 *   * `ADOPTED` from `EVALUATING` **or `NEEDS_USER`**, and never from
 *     `CANARY_RUNNING`. Adopting straight out of a running canary would be
 *     adopting before the window closed, which is the one thing the window is
 *     for. `NEEDS_USER` is the other way a hypothesis is confirmed: its evidence
 *     is rows rather than a canary, so there is no window to wait for — the
 *     Routine is registered or it is not.
 *
 *     **It was `EVALUATING` alone, and that made the answering transition
 *     unreachable.** A definition staircase settling from `NEEDS_USER` matched
 *     nothing, so it would have parked for ever with its action re-reported on
 *     every tick — §24's escalation with no answering transition, in the one
 *     place this file writes about avoiding it. A test found it; the guard was
 *     the mechanism nothing could call.
 *   * `ROLLED_BACK` from `CANARY_RUNNING` **or** `EVALUATING`, because a stop
 *     condition tripping mid-window is exactly when a rollback is most needed.
 *     Never from `NEEDS_USER`, which has applied nothing to roll back.
 *   * `ABANDONED` from any live state, including `NEEDS_USER`: an experiment whose
 *     question something else has since answered should stop rather than wait.
 */
export async function settleExperiment(input: {
  id: string;
  to: 'ADOPTED' | 'ROLLED_BACK' | 'ABANDONED';
  verdict: CapacityExperimentVerdict;
  reason: string;
}): Promise<boolean> {
  const from =
    input.to === 'ADOPTED'
      ? "('EVALUATING','NEEDS_USER')"
      : input.to === 'ROLLED_BACK'
        ? "('CANARY_RUNNING','EVALUATING')"
        : LIVE_STATES;
  const now = capacityNow();
  const result = await getDb().run(
    `UPDATE capacity_experiments
        SET state = ?, verdict = ?, verdict_reason = ?, settled_at = ?, updated_at = ?
      WHERE id = ? AND state IN ${from}`,
    [input.to, input.verdict, input.reason, now, now, input.id],
  );
  return result.changes > 0;
}

/**
 * How many capacity-changing experiments are running right now.
 *
 * Only the two states in which something has actually been applied. `PROPOSED`
 * and `NEEDS_USER` own their dimension but have changed nothing, so counting them
 * as "in flight" would report the fleet as under experiment when it is not.
 */
export async function runningCanaryCount(): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM capacity_experiments
      WHERE state IN ('CANARY_RUNNING','EVALUATING')`,
    [],
  );
  return Number(row?.n ?? 0);
}
