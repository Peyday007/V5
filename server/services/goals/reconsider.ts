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
 * A newer owner instruction is a changed fact too (S-0470). Whatever made it —
 * a decision in `decide.ts`, an amended intent, a re-set target or capital
 * ceiling (`ownerPolicy.ts` numbers them all) — the goal's newest decision,
 * produced under the older version, is no longer in force. It is examined
 * once more: its facts are read again like any other, and it is reconsidered
 * exactly once against the policy version that replaced it, naming every
 * strategy as dependent and asking the plan to read again. Its id is derived
 * from the reading and that policy event, so it is written once.
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
import { governingPolicy, POLICY_EVENT_READ_LIMIT, type GoverningPolicy } from './ownerPolicy.ts';
import {
  DECISION_EVENT_KIND,
  GOAL_WIDE_KINDS,
  WORLD_FACT_KINDS,
  conversionSourceId,
  decisionHistory,
  factValue,
  readFactRows,
  type DecisionRecord,
  type DecisionState,
  type EvidenceRef,
  type FactRows,
} from './decisionRecord.ts';
import type { WorkstreamEvent } from '../../domain/register.ts';

export const RECONSIDER_EVENT_KIND = 'GOAL_DECISION_RECONSIDERED';
/** The event id is derived from the reading, the fact and its new fingerprint: once per fact version. */
export const RECONSIDER_EVENT_PREFIX = 'wse_gdx_';
/** A decision superseded by a newer owner instruction: once per reading per policy version. */
export const POLICY_SUPERSESSION_EVENT_PREFIX = 'wse_gdp_';
/**
 * Goals examined per pass. The rest are not dropped: a pass resumes after the
 * last goal the previous one examined (`after`) and wraps to the first, so
 * every goal is examined within ceil(goals / limit) passes.
 */
export const RECONSIDER_GOALS_PER_PASS = 50;
/** How often the goals tick runs the reconsideration pass. */
export const RECONSIDER_PASS_EVERY_MS = 5 * 60_000;

/**
 * The fact kinds read back from rows: every world fact a record can hold
 * (`WORLD_FACT_KINDS`). A scenario id is the decision's own computation, not a
 * fact of the world, and is the only kind not read back.
 */
const READ_BACK: ReadonlySet<EvidenceRef['kind']> = WORLD_FACT_KINDS;

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
  return factValue(ref, facts);
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

/**
 * The opportunities a fact belongs to: the row itself, the opportunity a cash
 * need or an agreement was raised for, or every opportunity whose mechanism a
 * conversion rate measures. Empty for a goal-wide fact. Pure.
 */
function opportunitiesOf(change: Pick<FactChange, 'kind' | 'sourceRowId'>, facts: FactRows): string[] {
  if (change.kind === 'OPPORTUNITY_PRICE' || change.kind === 'OPPORTUNITY_DEADLINE' || change.kind === 'CONTRACT_STATE') return [change.sourceRowId];
  if (change.kind === 'CASH_NEED_COST') {
    const id = facts.cashNeeds.find((one) => one.id === change.sourceRowId)?.opportunity_id;
    return id ? [id] : [];
  }
  if (change.kind === 'CONVERSION_RATE') {
    return facts.opportunities.filter((one) => one.project_id && one.mechanism && conversionSourceId(one.project_id, one.mechanism) === change.sourceRowId).map((one) => one.id);
  }
  return [];
}

/**
 * What depends on the changed facts, read from the record's own chain. Pure.
 * `knownOpportunity` carries a cash need's opportunity when its row is gone.
 */
export function dependentsOf(record: DecisionRecord, changes: readonly FactChange[], facts: FactRows, knownOpportunity: ReadonlyMap<string, string> = new Map()): Dependents {
  const touched = new Set<string>();
  for (const change of changes) {
    // A goal-wide fact — the target, the capital the plan may use, an account it works through — bears on every strategy.
    if (GOAL_WIDE_KINDS.has(change.kind)) {
      for (const id of record.alternatives.flatMap((alt) => alt.opportunityIds)) touched.add(id);
      for (const action of record.chain.actions) if (action.kind === 'PURSUES') touched.add(action.opportunityId);
      continue;
    }
    const ids = opportunitiesOf(change, facts);
    const known = knownOpportunity.get(change.sourceRowId);
    if (ids.length === 0 && known) ids.push(known);
    for (const id of ids) touched.add(id);
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

/** Once per decision per owner policy version that replaced it. */
export function policySupersessionId(readingId: string, policyEventId: string): string {
  return `${POLICY_SUPERSESSION_EVENT_PREFIX}${sha256(`${readingId}|${policyEventId}`).slice(0, 32)}`;
}

/**
 * What depends on a decision a newer owner instruction replaced: the instruction
 * bears on the whole plan, so every strategy, every approval and every action it
 * produced. Pure.
 */
export function policyDependentsOf(record: DecisionRecord, facts: FactRows): Dependents {
  const opportunities = [...new Set([...record.alternatives.flatMap((alt) => alt.opportunityIds), ...record.chain.actions.flatMap((a) => (a.kind === 'PURSUES' ? [a.opportunityId] : []))])].sort();
  const touched = new Set(opportunities);
  const approvals: Dependents['approvals'] = [];
  if (record.authority.policyEventId) approvals.push({ kind: 'OWNER_POLICY', ref: record.authority.policyEventId, version: record.authority.policyVersion });
  for (const need of [...facts.cashNeeds].filter((one) => one.opportunity_id && touched.has(one.opportunity_id)).sort((a, b) => a.id.localeCompare(b.id))) {
    approvals.push({ kind: 'CASH_NEED', ref: need.id, state: need.state });
  }
  return { forecasts: [{ readingId: record.readingId, predicted: record.predicted }], opportunities, approvals, actions: [...record.chain.actions] };
}

/**
 * The goal's newest decision when a newer owner policy version has replaced it
 * and nothing has reconsidered it yet; null otherwise. Pure.
 */
export function supersededNewest(states: readonly DecisionState[], retired: ReadonlySet<string>): DecisionState | null {
  const newest = states.at(-1);
  if (!newest || newest.current !== 'SUPERSEDED_BY_POLICY' || retired.has(newest.record.readingId)) return null;
  return newest;
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
  return (await examinable(goalId)).active;
}

/** The decisions in force, and the newest one a newer owner instruction has replaced and nobody has reconsidered. */
async function examinable(goalId: string): Promise<{ active: DecisionState[]; superseded: DecisionState | null; policy: GoverningPolicy }> {
  const events = await listWorkstreamEvents(goalId, POLICY_EVENT_READ_LIMIT);
  const retired = reconsideredReadings(events);
  const policy = await governingPolicy(goalId, { listEvents: async () => events });
  const states = await decisionHistory(goalId);
  return {
    active: states.filter((one) => one.current === 'IN_FORCE' && !retired.has(one.record.readingId)),
    superseded: supersededNewest(states, retired),
    policy,
  };
}

async function readFacts(record: DecisionRecord): Promise<FactRows> {
  const byOpportunity = new Set<EvidenceRef['kind']>(['OPPORTUNITY_PRICE', 'OPPORTUNITY_DEADLINE', 'CONTRACT_STATE']);
  const opportunityIds = [...new Set([...record.evidence.filter((e) => byOpportunity.has(e.kind)).map((e) => e.sourceRowId), ...record.alternatives.flatMap((a) => a.opportunityIds)])];
  const needIds = [...new Set(record.evidence.filter((e) => e.kind === 'CASH_NEED_COST').map((e) => e.sourceRowId))];
  return readFactRows({ opportunityIds, goalId: record.goalId, needIds });
}

export interface Reconsideration {
  goalId: string;
  readingId: string;
  eventId: string;
  change: FactChange;
  dependents: Dependents;
}

export interface PolicySupersession {
  goalId: string;
  readingId: string;
  eventId: string;
  /** The owner policy version that replaced the decision. */
  policy: { version: number; eventId: string; kind: string; decidedAt: string; actorRef: string };
  dependents: Dependents;
}

export interface ReconsiderPassReport {
  goals: number;
  checked: number;
  unchanged: number;
  reconsidered: Reconsideration[];
  /** Decisions a newer owner instruction replaced, reconsidered once against it. */
  superseded: PolicySupersession[];
  /** Goals whose plan was asked to read again. */
  replanned: string[];
  /** The goals this pass examined, in the order it examined them. */
  goalIds: string[];
  /** Where the next pass resumes: the last goal examined, or null when this pass saw every goal. */
  nextCursor: string | null;
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
const GOAL_WITH_DECISIONS = `w.archived_at IS NULL AND w.cancelled_at IS NULL
              AND EXISTS (SELECT 1 FROM workstream_events e WHERE e.workstream_id = w.id AND e.kind = ?)`;

/**
 * The goals one pass examines: up to `limit` live goals with a decision
 * record, in id order, starting after `after` and wrapping to the first id, so
 * no goal waits behind a fixed first page. Keyset, not offset: a goal added or
 * archived between passes moves no other goal out of its turn.
 */
export async function goalWindow(after: string | null, limit: number): Promise<{ goals: string[]; nextCursor: string | null }> {
  if (limit <= 0) return { goals: [], nextCursor: after };
  const db = getDb();
  const head = after
    ? await db.all<{ id: string }>(`SELECT w.id FROM workstreams w WHERE ${GOAL_WITH_DECISIONS} AND w.id > ? ORDER BY w.id LIMIT ?`, [DECISION_EVENT_KIND, after, limit])
    : await db.all<{ id: string }>(`SELECT w.id FROM workstreams w WHERE ${GOAL_WITH_DECISIONS} ORDER BY w.id LIMIT ?`, [DECISION_EVENT_KIND, limit]);
  const goals = head.map((one) => one.id);
  if (goals.length < limit && after) {
    // Wrap: the goals at or before the cursor, up to the room left.
    const tail = await db.all<{ id: string }>(`SELECT w.id FROM workstreams w WHERE ${GOAL_WITH_DECISIONS} AND w.id <= ? ORDER BY w.id LIMIT ?`, [DECISION_EVENT_KIND, after, limit - goals.length]);
    goals.push(...tail.map((one) => one.id));
  }
  // A window that held every goal needs no cursor; otherwise resume after its last goal.
  const total = goals.length < limit ? goals.length : null;
  const nextCursor = total !== null ? null : (goals[goals.length - 1] ?? null);
  return { goals, nextCursor };
}

/**
 * A process that has just started has no cursor. Seeding it at the first id
 * would let frequent restarts starve the goals past the first page, so the
 * first pass of a process starts at a position derived from the clock: each
 * pass period starts one window further on.
 */
async function seedCursor(now: number, limit: number): Promise<string | null> {
  const count = Number((await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM workstreams w WHERE ${GOAL_WITH_DECISIONS}`, [DECISION_EVENT_KIND]))?.n ?? 0);
  if (count <= limit) return null;
  const offset = (Math.floor(now / RECONSIDER_PASS_EVERY_MS) * limit) % count;
  if (offset === 0) return null;
  const row = await getDb().get<{ id: string }>(`SELECT w.id FROM workstreams w WHERE ${GOAL_WITH_DECISIONS} ORDER BY w.id LIMIT 1 OFFSET ?`, [DECISION_EVENT_KIND, offset - 1]);
  return row?.id ?? null;
}

export async function reconcileFactChanges(options: { goalId?: string; limit?: number; now?: Date; ports?: ReconsiderPorts; after?: string | null } = {}): Promise<ReconsiderPassReport> {
  const limit = options.limit ?? RECONSIDER_GOALS_PER_PASS;
  const now = (options.now ?? new Date()).toISOString();
  const ports = options.ports ?? (await productionPorts());
  let goals: string[];
  let nextCursor: string | null = null;
  if (options.goalId) goals = [options.goalId];
  else {
    const window = await goalWindow(options.after ?? null, limit);
    goals = window.goals;
    nextCursor = window.nextCursor;
  }
  const report: ReconsiderPassReport = { goals: goals.length, checked: 0, unchanged: 0, reconsidered: [], superseded: [], replanned: [], goalIds: [...goals], nextCursor };
  for (const goalId of goals) {
    const reasons: string[] = [];
    const { active, superseded, policy } = await examinable(goalId);
    for (const state of superseded ? [...active, superseded] : active) {
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
    if (superseded && policy.known) {
      const record = superseded.record;
      const eventId = policySupersessionId(record.readingId, policy.eventId);
      const dependents = policyDependentsOf(record, await readFacts(record));
      const replacedBy = { version: policy.version, eventId: policy.eventId, kind: policy.kind, decidedAt: policy.decidedAt, actorRef: policy.actorRef };
      const summary = `Reconsidered decision ${record.readingId}: owner policy version ${policy.version} (${policy.kind}) replaced the instruction it was made under. The earlier decision and its evidence are kept; the plan reads the goal again.`;
      const detail = {
        readingId: record.readingId,
        decisionEventId: superseded.eventId,
        fact: { kind: 'OWNER_POLICY', sourceRowId: policy.eventId, gone: false },
        old: { version: record.authority.policyVersion, eventId: record.authority.policyEventId },
        new: replacedBy,
        why: superseded.why,
        dependents,
        previousNextStep: record.chain.actions.find((a) => a.kind === 'NEXT_TEST') ?? null,
      };
      const written = await getDb().run(
        `INSERT INTO workstream_events (id, workstream_id, kind, summary, detail, actor_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        [eventId, goalId, RECONSIDER_EVENT_KIND, summary.slice(0, 400), JSON.stringify(detail), 'BRAIN', now],
      );
      if ((written.changes ?? 0) > 0) {
        report.superseded.push({ goalId, readingId: record.readingId, eventId, policy: replacedBy, dependents });
        reasons.push(`owner policy version ${policy.version} (${policy.kind})`);
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
/** Where the next pass resumes; undefined until this process has run one. */
let reconsiderCursor: string | null | undefined;

/** At most every five minutes, from the goals tick. A failure is reported, never thrown into the tick. */
export async function reconcileFactChangesIfDue(now = Date.now(), options: { ports?: ReconsiderPorts; limit?: number } = {}): Promise<ReconsiderPassReport | { error: string } | null> {
  if (now - lastReconsiderPass < RECONSIDER_PASS_EVERY_MS) return null;
  lastReconsiderPass = now;
  try {
    const limit = options.limit ?? RECONSIDER_GOALS_PER_PASS;
    const after = reconsiderCursor === undefined ? await seedCursor(now, limit) : reconsiderCursor;
    const report = await reconcileFactChanges({ now: new Date(now), limit, after, ...(options.ports ? { ports: options.ports } : {}) });
    reconsiderCursor = report.nextCursor;
    return report;
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/** Tests: let the next call run regardless of the cadence, from the first goal. */
export function forgetReconsiderPass(): void {
  lastReconsiderPass = 0;
  reconsiderCursor = null;
}

/** Tests: behave as a process that has just started — no cadence, no cursor, so the first pass seeds one. */
export function resetReconsiderProcess(): void {
  lastReconsiderPass = 0;
  reconsiderCursor = undefined;
}
