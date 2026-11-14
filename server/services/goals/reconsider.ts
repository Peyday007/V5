/**
 * A changed fact reconsiders the decisions that rested on it (MEM-32, S-0471).
 *
 * "Distinguish immutable historical record from the current operational truth.
 * A source changing, an unexpected conversion rate, a new supplier price, an
 * account being disconnected, a fulfilled contract, or a changed capital
 * constraint should trigger reconsideration of affected decisions and
 * strategies. Avoid repeatedly researching questions answered by still-valid
 * evidence; do not leave obsolete decisions active simply because they were
 * once approved."
 *
 * Each decision record (`decisionRecord.ts`) carries a fingerprint of every
 * fact it was decided on. This pass reads those facts again from the rows they
 * came from and compares the fingerprint now against the one recorded. Those
 * examples are illustrations, not a list: any fact the record holds a
 * fingerprint of is read the same way. A fact that changed:
 *
 *   - names its dependents from the record's own chain: the forecast the
 *     decision made, the opportunities whose strategies used the fact, the
 *     approvals it stood on (the owner policy version it was made under, and
 *     the cash needs raised for those opportunities), and the actions it
 *     produced (the next test, and every opportunity link the goal pursues);
 *   - is reconsidered exactly once per fact version. The event id is derived
 *     from the reading, the fact and the fingerprint it changed to, so a second
 *     pass, a retry or a racing tick is refused by the primary key in the same
 *     statement that would write it again;
 *   - leaves the earlier decision and its evidence untouched — the record is
 *     never edited — and takes the decision out of current operational truth
 *     (`activeTruth`), so an obsolete decision is not active because it was
 *     once recorded;
 *   - asks the plan's own owner to read the goal again (`requestGoalPlanPass`),
 *     so the next justified step is the plan's to change. Nothing here
 *     writes a plan, an opportunity or an approval.
 *
 * A fact whose fingerprint did not move causes no event and no plan pass:
 * evidence that is still valid triggers no re-research.
 *
 * An unknown is never favourable (invariant 39): a fact whose row has gone is
 * a change to "nothing is recorded", not a fact kept at its old value.
 *
 * No store, no scheduler: the records are `workstream_events`, the facts are
 * the rows the record read, and the pass runs from the goals tick.
 */
import { getDb } from '../../db/database.ts';
import { listWorkstreamEvents } from '../../repos/register.ts';
import { canonicalJson, sha256 } from '../scenario/model.ts';
import { POLICY_EVENT_READ_LIMIT } from './ownerPolicy.ts';
import { DECISION_EVENT_KIND, decisionHistory, type DecisionRecord, type DecisionState, type EvidenceRef, type FactRows } from './decisionRecord.ts';
import type { WorkstreamEvent } from '../../domain/register.ts';

export const RECONSIDER_EVENT_KIND = 'GOAL_DECISION_RECONSIDERED';
/** The event id is derived from the reading, the fact and its new fingerprint: once per fact version. */
export const RECONSIDER_EVENT_PREFIX = 'wse_gdx_';
/** Goals examined per pass; the rest wait for the next one. */
export const RECONSIDER_GOALS_PER_PASS = 50;
/** How often the goals tick runs the reconsideration pass. */
export const RECONSIDER_PASS_EVERY_MS = 5 * 60_000;

/** The fact kinds read back from rows. A scenario id is the decision's own computation, not a fact of the world. */
const READ_BACK: ReadonlySet<EvidenceRef['kind']> = new Set(['OPPORTUNITY_PRICE', 'OPPORTUNITY_DEADLINE', 'CASH_NEED_COST']);

const fingerprint = (value: unknown): string => sha256(canonicalJson(value));

export interface FactChange {
  kind: EvidenceRef['kind'];
  sourceRowId: string;
  before: unknown;
  after: unknown;
  beforeFingerprint: string;
  afterFingerprint: string;
  /** The row the fact was read from no longer exists. */
  gone: boolean;
}

export interface Dependents {
  forecasts: Array<{ readingId: string; predicted: Record<string, unknown> | null }>;
  opportunities: string[];
  approvals: Array<{ kind: 'OWNER_POLICY'; ref: string; version: number | null } | { kind: 'CASH_NEED'; ref: string; state: string }>;
  actions: DecisionRecord['chain']['actions'];
}

/** The value a fact has now, in the shape the record fingerprinted it; undefined when its row is gone. Pure. */
export function currentValue(ref: Pick<EvidenceRef, 'kind' | 'sourceRowId'>, facts: FactRows): unknown {
  if (ref.kind === 'OPPORTUNITY_PRICE' || ref.kind === 'OPPORTUNITY_DEADLINE') {
    const row = facts.opportunities.find((one) => one.id === ref.sourceRowId);
    if (!row) return undefined;
    return ref.kind === 'OPPORTUNITY_PRICE' ? { priceCents: row.price_cents, currency: row.currency } : row.deadline;
  }
  if (ref.kind === 'CASH_NEED_COST') {
    const row = facts.cashNeeds.find((one) => one.id === ref.sourceRowId);
    return row ? { expectedCostCents: row.expected_cost_cents, state: row.state } : undefined;
  }
  return undefined;
}

/** The facts behind a record whose fingerprint now differs from the one recorded. Pure. */
export function changedFacts(record: Pick<DecisionRecord, 'evidence'>, facts: FactRows): FactChange[] {
  const out: FactChange[] = [];
  for (const ref of record.evidence ?? []) {
    if (!READ_BACK.has(ref.kind)) continue;
    const now = currentValue(ref, facts);
    const gone = now === undefined;
    const after = gone ? null : now;
    const afterFingerprint = gone ? fingerprint({ gone: ref.sourceRowId }) : fingerprint(after);
    if (afterFingerprint === ref.fingerprint) continue;
    out.push({ kind: ref.kind, sourceRowId: ref.sourceRowId, before: ref.value, after, beforeFingerprint: ref.fingerprint, afterFingerprint, gone });
  }
  return out;
}

/** The opportunity a fact belongs to: the row itself, or the opportunity a cash need was raised for. Pure. */
function opportunityOf(change: Pick<FactChange, 'kind' | 'sourceRowId'>, facts: FactRows): string | null {
  if (change.kind === 'OPPORTUNITY_PRICE' || change.kind === 'OPPORTUNITY_DEADLINE') return change.sourceRowId;
  if (change.kind === 'CASH_NEED_COST') return facts.cashNeeds.find((one) => one.id === change.sourceRowId)?.opportunity_id ?? null;
  return null;
}

/**
 * What depends on the changed facts, read from the record's own chain. Pure.
 * `knownOpportunity` carries a cash need's opportunity when its row is gone.
 */
export function dependentsOf(record: DecisionRecord, changes: readonly FactChange[], facts: FactRows, knownOpportunity: ReadonlyMap<string, string> = new Map()): Dependents {
  const touched = new Set<string>();
  for (const change of changes) {
    const id = opportunityOf(change, facts) ?? knownOpportunity.get(change.sourceRowId) ?? null;
    if (id) touched.add(id);
  }
  const opportunities = [...new Set(record.alternatives.flatMap((alt) => alt.opportunityIds).filter((id) => touched.has(id)))].sort();
  for (const id of touched) if (!opportunities.includes(id)) opportunities.push(id);
  const approvals: Dependents['approvals'] = [];
  if (record.authority.policyEventId) approvals.push({ kind: 'OWNER_POLICY', ref: record.authority.policyEventId, version: record.authority.policyVersion });
  for (const need of [...facts.cashNeeds].filter((one) => one.opportunity_id && touched.has(one.opportunity_id)).sort((a, b) => a.id.localeCompare(b.id))) {
    approvals.push({ kind: 'CASH_NEED', ref: need.id, state: need.state });
  }
  // The next test belongs to the whole plan; a pursued opportunity only when its fact changed.
  const actions = record.chain.actions.filter((one) => one.kind === 'NEXT_TEST' || touched.has(one.opportunityId));
  return { forecasts: [{ readingId: record.readingId, predicted: record.predicted }], opportunities, approvals, actions };
}

/** Once per decision per fact version. */
export function reconsiderationId(readingId: string, change: Pick<FactChange, 'kind' | 'sourceRowId' | 'afterFingerprint'>): string {
  return `${RECONSIDER_EVENT_PREFIX}${sha256(`${readingId}|${change.kind}|${change.sourceRowId}|${change.afterFingerprint}`).slice(0, 32)}`;
}

/** Readings a reconsideration has taken out of current truth. Pure. */
export function reconsideredReadings(events: readonly Pick<WorkstreamEvent, 'kind' | 'detail'>[]): Set<string> {
  const out = new Set<string>();
  for (const one of events) {
    if (one.kind !== RECONSIDER_EVENT_KIND) continue;
    const id = (one.detail as { readingId?: unknown } | null)?.readingId;
    if (typeof id === 'string') out.add(id);
  }
  return out;
}

/**
 * Current operational truth: the decisions in force (`decisionHistory`), less
 * any a changed fact has reconsidered. The records themselves are not touched.
 */
export async function activeTruth(goalId: string): Promise<DecisionState[]> {
  const events = await listWorkstreamEvents(goalId, POLICY_EVENT_READ_LIMIT);
  const retired = reconsideredReadings(events);
  return (await decisionHistory(goalId)).filter((one) => one.current === 'IN_FORCE' && !retired.has(one.record.readingId));
}

async function readFacts(record: DecisionRecord): Promise<FactRows> {
  const opportunityIds = [...new Set(record.evidence.filter((e) => e.kind === 'OPPORTUNITY_PRICE' || e.kind === 'OPPORTUNITY_DEADLINE').map((e) => e.sourceRowId))];
  const needIds = [...new Set(record.evidence.filter((e) => e.kind === 'CASH_NEED_COST').map((e) => e.sourceRowId))];
  const touchedOpportunities = [...new Set([...opportunityIds, ...record.alternatives.flatMap((a) => a.opportunityIds)])];
  const db = getDb();
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  const opportunities = opportunityIds.length
    ? await db.all<FactRows['opportunities'][number]>(`SELECT id, price_cents, currency, deadline FROM cash_opportunities WHERE id IN (${marks(opportunityIds.length)})`, opportunityIds)
    : [];
  const byNeed = needIds.length ? await db.all<FactRows['cashNeeds'][number]>(`SELECT id, opportunity_id, expected_cost_cents, state FROM cash_needs WHERE id IN (${marks(needIds.length)})`, needIds) : [];
  const byOpportunity = touchedOpportunities.length
    ? await db.all<FactRows['cashNeeds'][number]>(`SELECT id, opportunity_id, expected_cost_cents, state FROM cash_needs WHERE opportunity_id IN (${marks(touchedOpportunities.length)})`, touchedOpportunities)
    : [];
  const cashNeeds = [...new Map([...byNeed, ...byOpportunity].map((one) => [one.id, one])).values()];
  return { opportunities, cashNeeds };
}

export interface Reconsideration {
  goalId: string;
  readingId: string;
  eventId: string;
  change: FactChange;
  dependents: Dependents;
}

export interface ReconsiderPassReport {
  goals: number;
  checked: number;
  unchanged: number;
  reconsidered: Reconsideration[];
  /** Goals whose plan was asked to read again. */
  replanned: string[];
}

export interface ReconsiderPorts {
  /** Asks the plan's owner to read this goal again on its next pass. */
  requestPlanPass(goalId: string, why: string): void | Promise<void>;
}

async function productionPorts(): Promise<ReconsiderPorts> {
  const { requestGoalPlanPass } = await import('./plan.ts');
  return { requestPlanPass: requestGoalPlanPass };
}

/**
 * One pass: every live goal's decisions in force, their facts read again, a
 * changed fact reconsidered once and its goal's plan asked to read again.
 */
export async function reconcileFactChanges(options: { goalId?: string; limit?: number; now?: Date; ports?: ReconsiderPorts } = {}): Promise<ReconsiderPassReport> {
  const limit = options.limit ?? RECONSIDER_GOALS_PER_PASS;
  const now = (options.now ?? new Date()).toISOString();
  const ports = options.ports ?? (await productionPorts());
  const goals = options.goalId
    ? [options.goalId]
    : (
        await getDb().all<{ id: string }>(
          `SELECT w.id FROM workstreams w
            WHERE w.archived_at IS NULL AND w.cancelled_at IS NULL
              AND EXISTS (SELECT 1 FROM workstream_events e WHERE e.workstream_id = w.id AND e.kind = ?)
            ORDER BY w.id LIMIT ?`,
          [DECISION_EVENT_KIND, limit],
        )
      ).map((one) => one.id);
  const report: ReconsiderPassReport = { goals: goals.length, checked: 0, unchanged: 0, reconsidered: [], replanned: [] };
  for (const goalId of goals) {
    const reasons: string[] = [];
    for (const state of await activeTruth(goalId)) {
      const record = state.record;
      report.checked += 1;
      const facts = await readFacts(record);
      const changes = changedFacts(record, facts);
      if (changes.length === 0) {
        report.unchanged += 1;
        continue;
      }
      const dependents = dependentsOf(record, changes, facts);
      for (const change of changes) {
        const eventId = reconsiderationId(record.readingId, change);
        const summary = `Reconsidered decision ${record.readingId}: ${change.kind} of ${change.sourceRowId} changed${change.gone ? ' (its row is gone)' : ''}. The earlier decision and its evidence are kept; the plan reads the goal again.`;
        const detail = {
          readingId: record.readingId,
          decisionEventId: state.eventId,
          fact: { kind: change.kind, sourceRowId: change.sourceRowId, gone: change.gone },
          old: { value: change.before, fingerprint: change.beforeFingerprint },
          new: { value: change.after, fingerprint: change.afterFingerprint },
          dependents,
          previousNextStep: record.chain.actions.find((a) => a.kind === 'NEXT_TEST') ?? null,
        };
        const written = await getDb().run(
          `INSERT INTO workstream_events (id, workstream_id, kind, summary, detail, actor_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [eventId, goalId, RECONSIDER_EVENT_KIND, summary.slice(0, 400), JSON.stringify(detail), 'BRAIN', now],
        );
        if ((written.changes ?? 0) === 0) continue;
        report.reconsidered.push({ goalId, readingId: record.readingId, eventId, change, dependents });
        reasons.push(`${change.kind} of ${change.sourceRowId}`);
      }
    }
    if (reasons.length > 0) {
      await ports.requestPlanPass(goalId, `a fact a decision rested on changed: ${reasons.join(', ')}`.slice(0, 300));
      report.replanned.push(goalId);
    }
  }
  return report;
}

let lastReconsiderPass = 0;

/** At most every five minutes, from the goals tick. A failure is reported, never thrown into the tick. */
export async function reconcileFactChangesIfDue(now = Date.now(), options: { ports?: ReconsiderPorts } = {}): Promise<ReconsiderPassReport | { error: string } | null> {
  if (now - lastReconsiderPass < RECONSIDER_PASS_EVERY_MS) return null;
  lastReconsiderPass = now;
  try {
    return await reconcileFactChanges({ now: new Date(now), ...(options.ports ? { ports: options.ports } : {}) });
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/** Tests: let the next call run regardless of the cadence. */
export function forgetReconsiderPass(): void {
  lastReconsiderPass = 0;
}
