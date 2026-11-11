/**
 * Whether Brain is getting better, counted from production rows (§87).
 *
 * Every metric has a definition, a numerator and a denominator
 * (`domain/improvement.ts` METRICS), and says INSUFFICIENT_DATA below its
 * minimum sample rather than a number. Nothing here is estimated, and nothing
 * here writes: the loop records what it reads as an `improvement_events` row.
 */
import { getDb } from '../../db/database.ts';
import {
  classifyClaimRejection,
  classifyFreeLaneFailure,
  compare,
  type Comparison,
  METRIC_KEYS,
  METRICS,
  reading,
  type FailureCount,
  type MetricKey,
  type MetricReading,
} from '../../domain/improvement.ts';

const n = (value: number | string | null | undefined): number => Number(value ?? 0);

async function freeLane(from: string, to: string, fragmentsOnly: boolean): Promise<{ ok: number; failed: number; provider: number }> {
  const rows = await getDb().all<{ outcome: string; n: number | string }>(
    `SELECT outcome, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ? ${fragmentsOnly ? "AND workload_class = 'RESEARCH_FRAGMENT'" : ''}
      GROUP BY outcome`,
    [from, to],
  );
  const get = (outcome: string): number => n(rows.find((r) => r.outcome === outcome)?.n);
  return { ok: get('SUBMITTED'), failed: get('FAILED_RETRYABLE'), provider: get('RELEASED_TRANSIENT') };
}

/** One metric over [from, to). */
export async function readMetric(key: MetricKey, from: string, to: string): Promise<MetricReading> {
  const db = getDb();
  switch (key) {
    case 'FREE_LANE_PASS_RATE':
    case 'FREE_LANE_FRAGMENT_PASS_RATE': {
      const lane = await freeLane(from, to, key === 'FREE_LANE_FRAGMENT_PASS_RATE');
      const all = lane.ok + lane.failed + lane.provider;
      return reading(key, from, to, lane.ok, lane.ok + lane.failed, undefined, {
        providerErrorShare: all > 0 ? Number((lane.provider / all).toFixed(3)) : 0,
      });
    }
    case 'ACCEPTED_CLAIM_RATE': {
      const row = await db.get<{ total: number | string; accepted: number | string | null }>(
        'SELECT COUNT(*) AS total, SUM(accepted) AS accepted FROM research_claims WHERE created_at >= ? AND created_at < ?',
        [from, to],
      );
      return reading(key, from, to, n(row?.accepted), n(row?.total));
    }
    case 'RESEARCH_JOB_SUCCESS_RATE': {
      const rows = await db.all<{ status: string; n: number | string }>(
        `SELECT status, COUNT(*) AS n FROM research_orchestrations
          WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')
            AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) >= ?
            AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) < ?
          GROUP BY status`,
        [from, to],
      );
      const ok = rows.filter((r) => r.status === 'COMPLETE' || r.status === 'COMPLETE_WITH_GAPS').reduce((a, r) => a + n(r.n), 0);
      // A packet Brain cancelled (superseded, retired) was not a job that failed; it is reported beside the rate.
      const cancelled = n(rows.find((r) => r.status === 'CANCELLED')?.n);
      const all = rows.reduce((a, r) => a + n(r.n), 0) - cancelled;
      return reading(key, from, to, ok, all, undefined, { cancelled });
    }
    case 'CONSTRUCTED_ROUND_YIELD': {
      const row = await db.get<{ total: number | string; yielded: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN found > 0 THEN 1 ELSE 0 END) AS yielded FROM cash_discovery_rounds
          WHERE bucket_id LIKE ? AND state IN ('HARVESTED', 'ABANDONED') AND updated_at >= ? AND updated_at < ?`,
        ['%-mx-%', from, to],
      );
      return reading(key, from, to, n(row?.yielded), n(row?.total));
    }
    case 'READY_OPPORTUNITIES_PER_DAY': {
      const row = await db.get<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM cash_events WHERE kind = 'CASH_OPPORTUNITY_READY' AND created_at >= ? AND created_at < ?",
        [from, to],
      );
      return reading(key, from, to, n(row?.n), 0);
    }
    case 'OBJECTIVE_HOURS_MEDIAN': {
      const rows = await db.all<{ created_at: string; completed_at: string }>(
        `SELECT created_at, completed_at FROM research_orchestrations
          WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND completed_at >= ? AND completed_at < ?`,
        [from, to],
      );
      const hours = rows
        .map((r) => (Date.parse(r.completed_at) - Date.parse(r.created_at)) / 3_600_000)
        .filter((h) => Number.isFinite(h) && h >= 0)
        .sort((a, b) => a - b);
      const mid = hours.length === 0 ? null : hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
      return reading(key, from, to, hours.length, hours.length, mid);
    }
    case 'OWNER_INTERVENTIONS_PER_DAY': {
      const asks = await db.get<{ n: number | string }>(
        'SELECT COUNT(*) AS n FROM russell_human_requests WHERE created_at >= ? AND created_at < ?',
        [from, to],
      );
      const parked = await db.get<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM research_orchestrations WHERE status = 'NEEDS_HUMAN' AND updated_at >= ? AND updated_at < ?",
        [from, to],
      );
      return reading(key, from, to, n(asks?.n) + n(parked?.n), 0);
    }
    case 'AUTO_RECOVERY_RATE': {
      const rows = await db.all<{ state: string; n: number | string }>(
        `SELECT state, COUNT(*) AS n FROM work_items
          WHERE attempt_count > 1 AND state IN ('SUCCEEDED', 'FAILED') AND updated_at >= ? AND updated_at < ?
          GROUP BY state`,
        [from, to],
      );
      const ok = n(rows.find((r) => r.state === 'SUCCEEDED')?.n);
      return reading(key, from, to, ok, rows.reduce((a, r) => a + n(r.n), 0));
    }
  }
}

export interface Scoreboard {
  from: string;
  to: string;
  metrics: MetricReading[];
  /**
   * Gaps Brain identified and closed by itself over the same window (AUTO-20-4).
   * Part of the scoreboard rather than a separate report, so every reader of the
   * scoreboard — the improvement reading, `admin improvement show` — carries it.
   */
  gaps: GapMeasures;
}

/** Every metric over one window, and the gaps identified and closed in it. */
export async function readScoreboard(from: string, to: string): Promise<Scoreboard> {
  const metrics: MetricReading[] = [];
  for (const key of METRIC_KEYS) metrics.push(await readMetric(key, from, to));
  return { from, to, metrics, gaps: await readGapMeasures(from, to) };
}

/** Free-lane failures by class over [from, to), with up to five verbatim reasons each. */
export async function freeLaneFailures(from: string, to: string): Promise<{ attempts: number; failures: FailureCount[] }> {
  const rows = await getDb().all<{ outcome: string; reason: string | null }>(
    `SELECT outcome, reason FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ? AND at < ?
        AND outcome IN ('SUBMITTED', 'FAILED_RETRYABLE')`,
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    if (row.outcome !== 'FAILED_RETRYABLE') continue;
    const cls = classifyFreeLaneFailure(row.reason);
    const entry = byClass.get(cls) ?? { cls, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.reason) entry.samples.push(row.reason.slice(0, 300));
    byClass.set(cls, entry);
  }
  return { attempts: rows.length, failures: [...byClass.values()].sort((a, b) => b.n - a.n) };
}

/** Rejected claims by class over [from, to). */
export async function claimRejections(from: string, to: string): Promise<{ claims: number; rejections: FailureCount[] }> {
  const total = await getDb().get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?',
    [from, to],
  );
  // Judged claims only. A claim whose fragment has no gate verdict yet carries accepted = 0 and no
  // reason because nothing has judged it; counting it as "NO_REASON_RECORDED" (373 in a week,
  // 2026-11-04) reported unjudged work as unexplained rejections.
  const rows = await getDb().all<{ rejection_reason: string | null }>(
    `SELECT c.rejection_reason FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
      WHERE c.accepted = 0 AND f.status IN ('ACCEPTED', 'BLOCKED') AND c.created_at >= ? AND c.created_at < ? LIMIT 5000`,
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    const cls = classifyClaimRejection(row.rejection_reason);
    const entry = byClass.get(cls) ?? { cls, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.rejection_reason) entry.samples.push(row.rejection_reason.slice(0, 300));
    byClass.set(cls, entry);
  }
  return { claims: n(total?.n), rejections: [...byClass.values()].sort((a, b) => b.n - a.n) };
}

/** How packets that settled over [from, to) ended, by status and block cause. */
export async function packetOutcomes(from: string, to: string): Promise<{ settled: number; causes: FailureCount[] }> {
  const rows = await getDb().all<{ status: string; failure_reason: string | null }>(
    `SELECT status, failure_reason FROM research_orchestrations
      WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')
        AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) >= ?
        AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) < ?`,
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    if (row.status === 'CANCELLED') continue;
    if (row.status !== 'NEEDS_HUMAN' && row.status !== 'FAILED') continue;
    const entry = byClass.get(row.status) ?? { cls: row.status, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.failure_reason) entry.samples.push(row.failure_reason.slice(0, 300));
    byClass.set(row.status, entry);
  }
  return { settled: rows.filter((r) => r.status !== 'CANCELLED').length, causes: [...byClass.values()] };
}

/** Needs-You requests opened over [from, to), by the authority each asked for. */
export async function ownerInterventions(from: string, to: string): Promise<{ total: number; causes: FailureCount[] }> {
  const rows = await getDb().all<{ authority_needed: string; why_not_russell: string | null }>(
    'SELECT authority_needed, why_not_russell FROM russell_human_requests WHERE created_at >= ? AND created_at < ? LIMIT 5000',
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    const cls = row.authority_needed.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60).toUpperCase().replace(/\s+/g, '_') || 'UNSTATED';
    const entry = byClass.get(cls) ?? { cls, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.why_not_russell) entry.samples.push(row.why_not_russell.slice(0, 300));
    byClass.set(cls, entry);
  }
  return { total: rows.length, causes: [...byClass.values()].sort((a, b) => b.n - a.n) };
}

/* ------------------------------------------------------------------------- */
/* Gaps Brain found and closed by itself (AUTO-20-4)                          */
/* ------------------------------------------------------------------------- */

/** A figure Brain has no row for is said to be unmeasured; it is never a zero. */
export interface Unmeasured {
  status: 'NOT_MEASURED';
  reason: string;
}

export interface GapMeasures {
  from: string;
  to: string;
  /** Candidates opened in the window: weaknesses Brain detected, not recommendations anyone wrote. */
  identified: number;
  /**
   * Closed = decided KEPT, which `decideAfterMeasurement` reaches only when the
   * measured metric moved in production. A delivered or merged change is not
   * closed, and KEPT_NO_EFFECT is not a success.
   */
  closed: number;
  /**
   * Closed gaps whose rows show they reached production without a person:
   * released by Brain's own automatic release, under the standing improvement
   * grant, with no Factory stop that waited on a person and no OWNER_* event.
   * Only gaps measured as such are counted; a gap whose rows cannot say is in
   * `ownerInput.unmeasured`, never here (invariant 33).
   */
  closedWithoutOwnerInput: number;
  /** How each closed gap's owner input was read, and which ones the rows cannot answer. */
  ownerInput: OwnerInputMeasure;
  /** Delivered (merged) but not shown to have worked: reported beside, never counted as success. */
  deliveredNotProven: number;
  /** Median hours from detection to a measured KEPT decision, or unmeasured. */
  hoursToUseMedian: number | null;
  regressions: { reverted: number; keptNoEffect: number };
  /** The constructed-round yield, this window against the one before it, through the existing comparison. */
  goalQuality: Comparison;
  productiveWorkResumed: ProductiveWorkResumed;
  cost: GapCost;
}

/**
 * Whether a person had to act for a closed gap to reach production, read per
 * gap from the rows that would show it:
 *
 *  - an improvement event of an OWNER_* kind on the candidate;
 *  - a FACTORY_BLOCKED event whose outcome said it waited on a person
 *    (`needsPerson`, recorded by the loop from the release outcome);
 *  - how the merge happened: a LIVE `factory_release_runs` row for the
 *    candidate's campaign, at the merge the candidate records, under a grant the
 *    improvement loop itself executed, is Brain releasing alone. A delivery with
 *    no such run was merged outside Brain's release — by hand — and a run under
 *    a grant a person gave for that change is that person's decision.
 *
 * A gap with no campaign, or with a Factory stop recorded before the loop
 * carried `needsPerson`, cannot be answered from rows and is UNMEASURED.
 */
export interface OwnerInputMeasure {
  status: 'MEASURED';
  /** Gaps kept in the window. */
  gaps: number;
  withoutOwnerInput: number;
  withOwnerInput: number;
  unmeasured: number;
  perGap: { weaknessKey: string; finding: 'NONE' | 'OWNER_INPUT' | 'UNMEASURED'; reason: string }[];
}

/** The `executed_by_ref` the improvement loop writes on the release grant it gives under the standing order. */
const LOOP_GRANT_REF = 'improvement-loop';

async function readOwnerInput(kept: DecidedGap[]): Promise<OwnerInputMeasure> {
  const db = getDb();
  const perGap: OwnerInputMeasure['perGap'] = [];
  if (kept.length === 0) return { status: 'MEASURED', gaps: 0, withoutOwnerInput: 0, withOwnerInput: 0, unmeasured: 0, perGap };
  const ids = kept.map((g) => g.id);
  const events = await db.all<{ candidate_id: string; kind: string; detail: string }>(
    `SELECT candidate_id, kind, detail FROM improvement_events
      WHERE candidate_id IN (${ids.map(() => '?').join(', ')}) AND (kind LIKE 'OWNER_%' OR kind = 'FACTORY_BLOCKED')`,
    ids,
  );
  const campaigns = [...new Set(kept.map((g) => g.campaignId).filter((c): c is string => Boolean(c)))];
  const runs = campaigns.length
    ? await db.all<{ campaign_id: string; merge_sha: string | null; executed_by_ref: string | null }>(
        `SELECT r.campaign_id, r.merge_sha, g.executed_by_ref FROM factory_release_runs r
           JOIN factory_release_grants g ON g.id = r.grant_id
          WHERE r.state = 'LIVE' AND r.campaign_id IN (${campaigns.map(() => '?').join(', ')})`,
        campaigns,
      )
    : [];
  for (const gap of kept) {
    const owner: string[] = [];
    const unknown: string[] = [];
    for (const event of events.filter((e) => e.candidate_id === gap.id)) {
      if (event.kind !== 'FACTORY_BLOCKED') {
        owner.push(`recorded ${event.kind}`);
        continue;
      }
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(event.detail) as Record<string, unknown>;
      } catch {
        /* unreadable: treated as unrecorded below */
      }
      if (detail['needsPerson'] === true) owner.push(`Factory stopped for a person: ${String(detail['personAction'] ?? detail['detail'] ?? '')}`.trim());
      else if (typeof detail['needsPerson'] !== 'boolean') unknown.push('a Factory stop recorded without saying whether it waited on a person');
    }
    if (!gap.campaignId) {
      unknown.push('no Factory campaign links the delivery, so how it was merged is not on record');
    } else {
      // The loop records the change request id as the ref when the outcome named no merge; then any LIVE run of the campaign is its delivery.
      const atMerge = gap.deliveredRef !== null && /^[0-9a-f]{7,40}$/i.test(gap.deliveredRef);
      const live = runs.filter((r) => r.campaign_id === gap.campaignId && (!atMerge || r.merge_sha === gap.deliveredRef));
      if (live.length === 0) owner.push(`merged outside Brain's automatic release (${gap.deliveredRef ?? 'no merge recorded'}): a hand merge`);
      else if (!live.some((r) => r.executed_by_ref === LOOP_GRANT_REF)) owner.push('released under a grant a person gave for this change');
    }
    const finding = owner.length ? 'OWNER_INPUT' : unknown.length ? 'UNMEASURED' : 'NONE';
    const reason = owner.length ? owner.join('; ') : unknown.length ? unknown.join('; ') : "released by Brain's own automatic release under the standing improvement grant, with no stop for a person";
    perGap.push({ weaknessKey: gap.weaknessKey, finding, reason });
  }
  return {
    status: 'MEASURED',
    gaps: kept.length,
    withoutOwnerInput: perGap.filter((g) => g.finding === 'NONE').length,
    withOwnerInput: perGap.filter((g) => g.finding === 'OWNER_INPUT').length,
    unmeasured: perGap.filter((g) => g.finding === 'UNMEASURED').length,
    perGap,
  };
}

/**
 * The work closing a gap released, read from rows. For each gap kept in the
 * window, the candidate's own metric was measured in the window after delivery
 * and the window before (`result.after`, `result.before`, written by
 * `measureAndDecide`). When that metric counts successful work (higher is
 * better, and its numerator is a count of units: a RATE or PER_DAY shape), the
 * difference in successful units per day is the productive work the change
 * released. A metric whose numerator is not successful work (hours, failures)
 * cannot say how much work resumed and is counted as such, never guessed.
 * `continued` counts the closed gaps whose capability-gap loop recorded its
 * CONTINUE step: the loop resumed other work rather than stopping at the gap.
 */
export interface ProductiveWorkResumed {
  status: 'MEASURED';
  /** Gaps kept in the window. */
  gaps: number;
  /** Of those, the ones whose gap loop recorded CONTINUE (resumed other work). */
  continued: number;
  /** Of those, the ones whose metric counts successful units and was read before and after delivery. */
  attributed: number;
  /** Successful units per day after delivery minus before, summed over the attributed gaps. */
  unitsPerDayGained: number;
  perGap: { weaknessKey: string; metric: string; beforePerDay: number; afterPerDay: number; continued: boolean }[];
}

/**
 * What closing gaps cost, read from the append-only `bin_events` rows of the
 * Factory work each gap was handed to (`bins.factory_campaign_id` = the
 * candidate's campaign). Every measured attempt counts — kept, kept without
 * effect and reverted alike — because a failed attempt was paid for too. Worker
 * time is the sum of `duration_ms` the lease recorded when it ended; a lease
 * that ended without a duration (released, expired) is counted in
 * `leasesUntimed` rather than timed from a guess. A gap worked by research
 * rather than a campaign has no bin link and is counted as unattributed. Brain
 * workers run on subscription capacity; paid model spend is not attributed to a
 * bin by any row, so it is not reported here.
 */
export interface GapCost {
  status: 'MEASURED';
  /** Measured decisions (KEPT, KEPT_NO_EFFECT, REVERTED) in the window. */
  gaps: number;
  /** Of those, the ones whose Factory campaign links them to bins. */
  attributed: number;
  bins: number;
  leases: number;
  leasesUntimed: number;
  workerMs: number;
}

const MEASURED_DECISIONS = new Set(['KEPT', 'KEPT_NO_EFFECT', 'REVERTED']);

interface DecidedGap {
  id: string;
  weaknessKey: string;
  campaignId: string | null;
  /** The merge the loop recorded at delivery (`delivered_ref`). */
  deliveredRef: string | null;
  metric: string;
  result: string | null;
  decision: string;
  createdAt: string;
  /** When the measured decision was made: the append-only DECIDED event, never the row's updated_at. */
  decidedAt: string;
}

/**
 * Candidates whose measured decision (KEPT, KEPT_NO_EFFECT, REVERTED) was made in
 * [from, to). The time of a decision is read from the first `DECIDED` event that
 * records the candidate's current decision: `improvement_events` is append-only,
 * whereas `updated_at` moves on every re-detection (`upsertCandidate`) and on any
 * later patch, so it says when the row was last touched, not when the gap closed.
 * A decided row with no such event has no known decision time and is not counted
 * rather than being timed from whatever touched it last.
 */
async function readDecisions(from: string, to: string): Promise<DecidedGap[]> {
  const db = getDb();
  const events = await db.all<{ candidate_id: string; detail: string; at: string }>(
    "SELECT candidate_id, detail, at FROM improvement_events WHERE kind = 'DECIDED' AND candidate_id IS NOT NULL AND at < ? ORDER BY at ASC",
    [to],
  );
  const first = new Map<string, { decision: string; at: string }[]>();
  for (const event of events) {
    let decision: unknown;
    try {
      decision = (JSON.parse(event.detail) as Record<string, unknown>)['decision'];
    } catch {
      continue;
    }
    if (typeof decision !== 'string' || !MEASURED_DECISIONS.has(decision)) continue;
    const list = first.get(event.candidate_id) ?? [];
    list.push({ decision, at: event.at });
    first.set(event.candidate_id, list);
  }
  if (first.size === 0) return [];
  const rows = await db.all<{ id: string; weakness_key: string; campaign_id: string | null; delivered_ref: string | null; metric_key: string; result: string | null; decision: string; created_at: string }>(
    `SELECT id, weakness_key, campaign_id, delivered_ref, metric_key, result, decision, created_at FROM improvement_candidates WHERE decision IN ('KEPT', 'KEPT_NO_EFFECT', 'REVERTED')`,
    [],
  );
  const out: DecidedGap[] = [];
  for (const row of rows) {
    const decidedAt = first.get(row.id)?.find((e) => e.decision === row.decision)?.at;
    if (!decidedAt || decidedAt < from || decidedAt >= to) continue;
    out.push({
      id: row.id,
      weaknessKey: row.weakness_key,
      campaignId: row.campaign_id,
      deliveredRef: row.delivered_ref,
      metric: row.metric_key,
      result: row.result,
      decision: row.decision,
      createdAt: row.created_at,
      decidedAt,
    });
  }
  return out;
}

interface Window {
  from?: string;
  to?: string;
  numerator?: number;
}

const DAY_MS = 86_400_000;

/** Successful units per day in one reading, or null when the reading has no usable window. */
function perDay(w: Window | undefined): number | null {
  if (!w || typeof w.numerator !== 'number' || !w.from || !w.to) return null;
  const days = (Date.parse(w.to) - Date.parse(w.from)) / DAY_MS;
  return Number.isFinite(days) && days > 0 ? w.numerator / days : null;
}

/** True when a metric's numerator counts successful work, so its change is work released. */
function countsSuccessfulUnits(metric: string): boolean {
  const def = (METRICS as Record<string, { shape: string; higherIsBetter: boolean } | undefined>)[metric];
  return Boolean(def && def.higherIsBetter && (def.shape === 'RATE' || def.shape === 'PER_DAY'));
}

/** The productive work the gaps kept in the window released. Reads each gap's CONTINUE step from its loop rows. */
async function readProductiveWorkResumed(kept: readonly DecidedGap[]): Promise<ProductiveWorkResumed> {
  const continuedKeys = new Set<string>();
  if (kept.length > 0) {
    const rows = await getDb().all<{ workload_class: string }>(
      `SELECT DISTINCT workload_class FROM bin_events WHERE event_type = 'CAPABILITY_GAP_STEP' AND provider = 'CONTINUE'
          AND workload_class IN (${kept.map(() => '?').join(', ')})`,
      kept.map((g) => g.weaknessKey),
    );
    for (const row of rows) continuedKeys.add(row.workload_class);
  }
  const perGap: ProductiveWorkResumed['perGap'] = [];
  for (const gap of kept) {
    if (!countsSuccessfulUnits(gap.metric)) continue;
    let result: { before?: Window; after?: Window } | null = null;
    try {
      result = gap.result ? (JSON.parse(gap.result) as { before?: Window; after?: Window }) : null;
    } catch {
      result = null;
    }
    const before = perDay(result?.before);
    const after = perDay(result?.after);
    if (before === null || after === null) continue;
    perGap.push({
      weaknessKey: gap.weaknessKey,
      metric: gap.metric,
      beforePerDay: Number(before.toFixed(3)),
      afterPerDay: Number(after.toFixed(3)),
      continued: continuedKeys.has(gap.weaknessKey),
    });
  }
  const gained = perGap.reduce((sum, g) => sum + (g.afterPerDay - g.beforePerDay), 0);
  return {
    status: 'MEASURED',
    gaps: kept.length,
    continued: kept.filter((g) => continuedKeys.has(g.weaknessKey)).length,
    attributed: perGap.length,
    unitsPerDayGained: Number(gained.toFixed(3)),
    perGap,
  };
}

/** What the measured attempts in the window cost, from the bin rows of the Factory campaigns they were handed to. */
async function readGapCost(decided: readonly DecidedGap[]): Promise<GapCost> {
  const campaigns = [...new Set(decided.map((g) => g.campaignId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  let bins = 0;
  let leases = 0;
  let leasesUntimed = 0;
  let workerMs = 0;
  const linked = new Set<string>();
  if (campaigns.length > 0) {
    const marks = campaigns.map(() => '?').join(', ');
    const binRows = await getDb().all<{ id: string; factory_campaign_id: string }>(
      `SELECT id, factory_campaign_id FROM bins WHERE factory_campaign_id IN (${marks})`,
      campaigns,
    );
    bins = binRows.length;
    for (const row of binRows) linked.add(row.factory_campaign_id);
    if (binRows.length > 0) {
      const ended = await getDb().all<{ bin_id: string; lease_generation: number | null; duration_ms: number | null }>(
        `SELECT bin_id, lease_generation, duration_ms FROM bin_events
          WHERE event_type IN ('BIN_TERMINAL', 'BIN_RELEASED', 'BIN_LEASE_EXPIRED') AND lease_id IS NOT NULL
            AND bin_id IN (${binRows.map(() => '?').join(', ')})`,
        binRows.map((r) => r.id),
      );
      const seen = new Set<string>();
      for (const event of ended) {
        const lease = `${event.bin_id}#${event.lease_generation ?? ''}`;
        if (seen.has(lease)) continue;
        seen.add(lease);
        leases += 1;
        if (typeof event.duration_ms === 'number' && event.duration_ms >= 0) workerMs += Number(event.duration_ms);
        else leasesUntimed += 1;
      }
    }
  }
  return {
    status: 'MEASURED',
    gaps: decided.length,
    attributed: decided.filter((g) => g.campaignId && linked.has(g.campaignId)).length,
    bins,
    leases,
    leasesUntimed,
    workerMs,
  };
}

/** Gaps identified and closed over [from, to), counted from improvement rows. */
export async function readGapMeasures(from: string, to: string): Promise<GapMeasures> {
  const db = getDb();
  const [opened, decided, delivered] = await Promise.all([
    db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM improvement_candidates WHERE created_at >= ? AND created_at < ?', [from, to]),
    readDecisions(from, to),
    db.get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM improvement_candidates WHERE delivered_at >= ? AND delivered_at < ? AND (decision IS NULL OR decision <> 'KEPT')",
      [from, to],
    ),
  ]);
  const kept = decided.filter((r) => r.decision === 'KEPT');
  const ownerInput = await readOwnerInput(kept);
  const hours = kept
    .map((r) => (Date.parse(r.decidedAt) - Date.parse(r.createdAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const median = hours.length === 0 ? null : hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
  const span = Date.parse(to) - Date.parse(from);
  const before = new Date(Date.parse(from) - span).toISOString();
  const goalQuality = compare(await readMetric('CONSTRUCTED_ROUND_YIELD', before, from), await readMetric('CONSTRUCTED_ROUND_YIELD', from, to));
  return {
    from,
    to,
    identified: n(opened?.n),
    closed: kept.length,
    closedWithoutOwnerInput: ownerInput.withoutOwnerInput,
    ownerInput,
    deliveredNotProven: n(delivered?.n),
    hoursToUseMedian: median === null ? null : Number(median.toFixed(2)),
    regressions: {
      reverted: decided.filter((r) => r.decision === 'REVERTED').length,
      keptNoEffect: decided.filter((r) => r.decision === 'KEPT_NO_EFFECT').length,
    },
    goalQuality,
    productiveWorkResumed: await readProductiveWorkResumed(kept),
    cost: await readGapCost(decided),
  };
}
