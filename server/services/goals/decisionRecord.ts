/**
 * Each goal plan reading as one immutable decision record (MEM-32, S-0470/S-0471).
 *
 * "Store not only the answer Brain reached, but the decision it faced, the
 * alternatives available, evidence used, conditions assumed, predicted
 * outcomes, authority, timestamp, and the reason for its choice. Preserve a
 * direct link between source evidence, derived variables, economic mechanisms,
 * decisions, actions and eventual results."
 *
 * Nothing new is stored beside the existing owners. `goal_plan_readings` is the
 * plan's history and `workstream_events` is the goal's append-only register;
 * a decision record is one `GOAL_DECISION_RECORDED` event per reading, whose id
 * is derived from the reading's id, so a second write of the same reading is
 * refused by the primary key in the same statement that would make it — once
 * per reading, whoever races. The record is never edited afterwards.
 *
 * Historical record and current operational truth are kept apart. The record
 * says what was decided, under which owner policy version, and whether that
 * version still governed when it was written. `activeDecisions` derives what is
 * in force *now* by reading: the newest record, produced under the policy that
 * governs today. A later reading replaces an earlier one, and a later owner
 * decision supersedes every reading produced before it (`ownerPolicy.ts`) — an
 * older report never silently overrides a newer authorized instruction, and an
 * obsolete decision does not stay active because it was once recorded.
 *
 * Results link to a decision by id: `goal_outcomes.reading_id` is the reading
 * the outcome was measured against, so the chain's last link is read, never
 * written into the record.
 *
 * An unknown is never favourable (invariant 39): a reading whose policy cannot
 * be placed is recorded POLICY_UNKNOWN and is not in force.
 */
import { getDb } from '../../db/database.ts';
import { listLinks, listWorkstreamEvents } from '../../repos/register.ts';
import { canonicalJson, sha256 } from '../scenario/model.ts';
import { governingPolicy, POLICY_EVENT_READ_LIMIT, staleAgainstPolicy, type GoverningPolicy, type PolicyVerdict } from './ownerPolicy.ts';
import type { WorkstreamEvent } from '../../domain/register.ts';

export const DECISION_EVENT_KIND = 'GOAL_DECISION_RECORDED';
/** The record's event id is the reading's, so the primary key enforces once-per-reading. */
export const DECISION_EVENT_PREFIX = 'wse_gdr_';
export const DECISION_RECORD_SCHEMA = 1;
/** Readings recorded per production pass; the rest wait for the next one. */
export const DECISIONS_PER_PASS = 50;

export const decisionEventId = (readingId: string): string => `${DECISION_EVENT_PREFIX}${readingId}`;

/** A `goal_plan_readings` row, as stored. */
export interface PlanReadingRow {
  id: string;
  workstream_id: string;
  digest: string;
  scenario_model_id: string | null;
  scenario_run_id: string | null;
  verdict: string;
  chosen_strategy: string | null;
  strategies: string;
  next_test: string | null;
  forecast: string | null;
  created_at: string;
}

interface StoredStrategy {
  key?: string;
  label?: string;
  verdict?: string;
  opportunityIds?: string[];
  links?: Array<{ link?: string; ok?: boolean; basis?: string }>;
  constraintsFailed?: string[];
  chainComplete?: boolean;
  conservativeSettled?: number | null;
  sweep?: Record<string, unknown>;
}

/** One fact a decision rested on: where it came from, and a fingerprint of the value it had. */
export interface EvidenceRef {
  kind: 'OPPORTUNITY_PRICE' | 'OPPORTUNITY_DEADLINE' | 'CASH_NEED_COST' | 'SCENARIO_MODEL' | 'SCENARIO_RUN';
  /** The row the value was read from. */
  sourceRowId: string;
  /** The value as it was read. */
  value: unknown;
  /** sha256 of the canonical value: a later change to the fact is visible as a different fingerprint. */
  fingerprint: string;
}

export interface FactRows {
  opportunities: Array<{ id: string; price_cents: number | null; currency: string | null; deadline: string | null }>;
  cashNeeds: Array<{ id: string; opportunity_id: string | null; expected_cost_cents: number | null; state: string }>;
}

export type DecisionStatus = 'IN_FORCE' | 'SUPERSEDED_BY_POLICY' | 'POLICY_UNKNOWN';

export interface DecisionRecord {
  schema: number;
  readingId: string;
  goalId: string;
  /** The decision faced. */
  decision: string;
  chosen: string | null;
  verdict: string;
  alternatives: Array<{ key: string; label: string; verdict: string | null; opportunityIds: string[]; missing: string[]; constraintsFailed: string[]; chosen: boolean }>;
  evidence: EvidenceRef[];
  /** What was taken as given without being established: each unestablished link of the chosen strategy, and the window. */
  conditions: string[];
  /** The predicted outcome, as the reading forecast it. */
  predicted: Record<string, unknown> | null;
  authority: { actor: 'BRAIN'; policyVersion: number | null; policyEventId: string | null; verdict: PolicyVerdict['verdict']; reason: string };
  /** When the reading was made. */
  decidedAt: string;
  reason: string;
  /** evidence -> derived variable -> economic mechanism -> decision -> action -> result. */
  chain: {
    evidence: string[];
    variables: Array<{ link: string; ok: boolean; basis: string }>;
    mechanism: { strategy: string | null; opportunityIds: string[] };
    decision: string;
    actions: Array<{ kind: 'NEXT_TEST'; link: string | null; test: string; by: string | null } | { kind: 'PURSUES'; linkId: string; opportunityId: string }>;
    /** Read by id from `goal_outcomes.reading_id`; never written into the record. */
    results: { by: 'goal_outcomes.reading_id'; readingId: string };
  };
  status: DecisionStatus;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const fingerprint = (value: unknown): string => sha256(canonicalJson(value));

/** Opportunity ids every strategy of a reading rests on. */
export function readingOpportunityIds(row: Pick<PlanReadingRow, 'strategies'>): string[] {
  const strategies = parse<StoredStrategy[]>(row.strategies) ?? [];
  return [...new Set(strategies.flatMap((one) => one.opportunityIds ?? []))].sort();
}

/**
 * The decision record for one reading. Pure: every row it reads is passed in,
 * so the same inputs always give the same record.
 */
export function buildDecisionRecord(input: {
  reading: PlanReadingRow;
  facts: FactRows;
  policy: GoverningPolicy;
  pursued: Array<{ id: string; ref: string }>;
}): DecisionRecord {
  const { reading, facts, policy } = input;
  const strategies = parse<StoredStrategy[]>(reading.strategies) ?? [];
  const chosen = strategies.find((one) => one.key === reading.chosen_strategy) ?? null;
  const nextTest = parse<{ link?: string; test?: string; by?: string }>(reading.next_test);
  const forecast = parse<Record<string, unknown>>(reading.forecast);
  const ids = new Set(readingOpportunityIds(reading));

  const evidence: EvidenceRef[] = [];
  for (const one of [...facts.opportunities].filter((o) => ids.has(o.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    const price = { priceCents: one.price_cents, currency: one.currency };
    evidence.push({ kind: 'OPPORTUNITY_PRICE', sourceRowId: one.id, value: price, fingerprint: fingerprint(price) });
    evidence.push({ kind: 'OPPORTUNITY_DEADLINE', sourceRowId: one.id, value: one.deadline, fingerprint: fingerprint(one.deadline) });
  }
  for (const one of [...facts.cashNeeds].filter((n) => n.opportunity_id && ids.has(n.opportunity_id)).sort((a, b) => a.id.localeCompare(b.id))) {
    const cost = { expectedCostCents: one.expected_cost_cents, state: one.state };
    evidence.push({ kind: 'CASH_NEED_COST', sourceRowId: one.id, value: cost, fingerprint: fingerprint(cost) });
  }
  if (reading.scenario_model_id) evidence.push({ kind: 'SCENARIO_MODEL', sourceRowId: reading.scenario_model_id, value: reading.scenario_model_id, fingerprint: fingerprint(reading.scenario_model_id) });
  if (reading.scenario_run_id) evidence.push({ kind: 'SCENARIO_RUN', sourceRowId: reading.scenario_run_id, value: reading.scenario_run_id, fingerprint: fingerprint(reading.scenario_run_id) });

  const variables = (chosen?.links ?? []).map((one) => ({ link: String(one.link ?? ''), ok: Boolean(one.ok), basis: String(one.basis ?? '') }));
  const conditions = variables.filter((one) => !one.ok).map((one) => `assumed, not established: ${one.link}${one.basis ? ` (${one.basis})` : ''}`);
  if (forecast && typeof forecast.daysLeft === 'number') conditions.push(`${forecast.daysLeft} days left to the deadline`);
  if (forecast && typeof forecast.remainingCents === 'number') conditions.push(`${forecast.remainingCents} cents still to collect`);

  const verdict = staleAgainstPolicy(reading.created_at, policy);
  const status: DecisionStatus = verdict.verdict === 'CURRENT' ? 'IN_FORCE' : verdict.verdict === 'STALE' ? 'SUPERSEDED_BY_POLICY' : 'POLICY_UNKNOWN';
  const mechanismIds = chosen?.opportunityIds ?? [];
  const pursued = input.pursued.filter((one) => mechanismIds.includes(one.ref) || ids.has(one.ref)).sort((a, b) => a.id.localeCompare(b.id));
  const actions: DecisionRecord['chain']['actions'] = [
    ...(nextTest?.test ? [{ kind: 'NEXT_TEST' as const, link: nextTest.link ?? null, test: nextTest.test, by: nextTest.by ?? null }] : []),
    ...pursued.map((one) => ({ kind: 'PURSUES' as const, linkId: one.id, opportunityId: one.ref })),
  ];
  const reason = chosen
    ? `${chosen.label ?? chosen.key} was chosen: ${chosen.verdict ?? reading.verdict}${chosen.chainComplete ? ', every link established' : `, ${conditions.filter((c) => c.startsWith('assumed')).length} link(s) not yet established`}${(chosen.constraintsFailed ?? []).length > 0 ? `; constraints failed: ${(chosen.constraintsFailed ?? []).join(', ')}` : ''}`
    : `no strategy was chosen; the reading's verdict is ${reading.verdict}`;

  return {
    schema: DECISION_RECORD_SCHEMA,
    readingId: reading.id,
    goalId: reading.workstream_id,
    decision: `Which plan should goal ${reading.workstream_id} pursue to reach its target?`,
    chosen: reading.chosen_strategy,
    verdict: reading.verdict,
    alternatives: strategies.map((one) => ({
      key: String(one.key ?? ''),
      label: String(one.label ?? one.key ?? ''),
      verdict: one.verdict ?? null,
      opportunityIds: one.opportunityIds ?? [],
      missing: (one.links ?? []).filter((l) => !l.ok).map((l) => String(l.link ?? '')),
      constraintsFailed: one.constraintsFailed ?? [],
      chosen: one.key === reading.chosen_strategy,
    })),
    evidence,
    conditions,
    predicted: forecast,
    authority: {
      actor: 'BRAIN',
      policyVersion: policy.known ? policy.version : null,
      policyEventId: policy.known ? policy.eventId : null,
      verdict: verdict.verdict,
      reason: verdict.reason,
    },
    decidedAt: reading.created_at,
    reason,
    chain: {
      evidence: evidence.map((one) => `${one.kind}:${one.sourceRowId}`),
      variables,
      mechanism: { strategy: reading.chosen_strategy, opportunityIds: mechanismIds },
      decision: reading.id,
      actions,
      results: { by: 'goal_outcomes.reading_id', readingId: reading.id },
    },
    status,
  };
}

async function readFacts(opportunityIds: string[]): Promise<FactRows> {
  if (opportunityIds.length === 0) return { opportunities: [], cashNeeds: [] };
  const marks = opportunityIds.map(() => '?').join(', ');
  const db = getDb();
  const opportunities = await db.all<FactRows['opportunities'][number]>(`SELECT id, price_cents, currency, deadline FROM cash_opportunities WHERE id IN (${marks})`, opportunityIds);
  const cashNeeds = await db.all<FactRows['cashNeeds'][number]>(`SELECT id, opportunity_id, expected_cost_cents, state FROM cash_needs WHERE opportunity_id IN (${marks})`, opportunityIds);
  return { opportunities, cashNeeds };
}

/**
 * Write the record for one reading, once. The id is derived from the reading's,
 * so a second write — a retry, a racing pass — changes nothing. Returns whether
 * this call wrote it.
 */
export async function recordDecision(reading: PlanReadingRow, deps: { policy?: GoverningPolicy; now?: Date } = {}): Promise<boolean> {
  const policy = deps.policy ?? (await governingPolicy(reading.workstream_id));
  const facts = await readFacts(readingOpportunityIds(reading));
  const pursued = (await listLinks(reading.workstream_id)).filter((one) => one.kind === 'OPPORTUNITY' && one.relation === 'PURSUES').map((one) => ({ id: one.id, ref: one.ref }));
  const record = buildDecisionRecord({ reading, facts, policy, pursued });
  const summary = `${record.status === 'IN_FORCE' ? 'Decided' : record.status === 'SUPERSEDED_BY_POLICY' ? 'Recorded, superseded by a newer owner policy' : 'Recorded, policy unknown'}: ${record.reason}`.slice(0, 400);
  const result = await getDb().run(
    `INSERT INTO workstream_events (id, workstream_id, kind, summary, detail, actor_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    [decisionEventId(reading.id), reading.workstream_id, DECISION_EVENT_KIND, summary, JSON.stringify(record), 'BRAIN', (deps.now ?? new Date()).toISOString()],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * The production pass: every plan reading without its decision record gets
 * one, oldest first, at most `limit` a pass.
 */
export async function recordDecisionsIfDue(options: { goalId?: string; limit?: number; now?: Date } = {}): Promise<{ recorded: number; pending: number }> {
  const limit = options.limit ?? DECISIONS_PER_PASS;
  const where = options.goalId ? 'AND r.workstream_id = ?' : '';
  const params: Array<string | number> = options.goalId ? [options.goalId] : [];
  const due = await getDb().all<PlanReadingRow>(
    `SELECT r.* FROM goal_plan_readings r
      WHERE NOT EXISTS (SELECT 1 FROM workstream_events e WHERE e.id = '${DECISION_EVENT_PREFIX}' || r.id) ${where}
      ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
    [...params, limit + 1],
  );
  const policies = new Map<string, GoverningPolicy>();
  let recorded = 0;
  for (const reading of due.slice(0, limit)) {
    let policy = policies.get(reading.workstream_id);
    if (!policy) {
      policy = await governingPolicy(reading.workstream_id);
      policies.set(reading.workstream_id, policy);
    }
    if (await recordDecision(reading, { policy, ...(options.now ? { now: options.now } : {}) })) recorded += 1;
  }
  return { recorded, pending: Math.max(0, due.length - limit) };
}

export interface DecisionState {
  eventId: string;
  record: DecisionRecord;
  /** What the record says it was when written; never changed. */
  recordedStatus: DecisionStatus;
  /** What it is now, derived. */
  current: 'IN_FORCE' | 'REPLACED' | 'SUPERSEDED_BY_POLICY' | 'POLICY_UNKNOWN';
  why: string;
  /** Outcomes measured against this decision, linked by its reading id. */
  results: Array<{ id: string; kind: string; achievedCents: number; targetCents: number; observedAt: string }>;
}

/** The goal's decision records, oldest first. Pure. */
export function decisionRecordsFrom(events: readonly Pick<WorkstreamEvent, 'id' | 'kind' | 'detail'>[]): Array<{ eventId: string; record: DecisionRecord }> {
  return events
    .filter((one) => one.kind === DECISION_EVENT_KIND && one.id.startsWith(DECISION_EVENT_PREFIX))
    .map((one) => ({ eventId: one.id, record: one.detail as unknown as DecisionRecord }))
    .filter((one) => typeof one.record?.readingId === 'string')
    .sort((a, b) => (a.record.decidedAt < b.record.decidedAt ? -1 : a.record.decidedAt > b.record.decidedAt ? 1 : a.record.readingId.localeCompare(b.record.readingId)));
}

/**
 * Current operational truth, derived from the immutable records. Pure. Only the
 * newest record can be in force, and only if it was produced under the policy
 * that governs now: a newer owner decision supersedes it, and an earlier record
 * was replaced by a later reading.
 */
export function deriveDecisionStates(records: Array<{ eventId: string; record: DecisionRecord }>, policy: GoverningPolicy, outcomes: Array<{ id: string; reading_id: string; kind: string; achieved_cents: number; target_cents: number; observed_at: string }> = []): DecisionState[] {
  const newest = records.at(-1)?.record.readingId ?? null;
  return records.map(({ eventId, record }) => {
    const now = staleAgainstPolicy(record.decidedAt, policy);
    let current: DecisionState['current'];
    let why: string;
    if (now.verdict === 'UNKNOWN') {
      current = 'POLICY_UNKNOWN';
      why = now.reason;
    } else if (now.verdict === 'STALE') {
      current = 'SUPERSEDED_BY_POLICY';
      why = now.reason;
    } else if (record.readingId !== newest) {
      current = 'REPLACED';
      why = `a later plan reading (${newest}) replaced it`;
    } else {
      current = 'IN_FORCE';
      why = now.reason;
    }
    return {
      eventId,
      record,
      recordedStatus: record.status,
      current,
      why,
      results: outcomes
        .filter((one) => one.reading_id === record.readingId)
        .map((one) => ({ id: one.id, kind: one.kind, achievedCents: Number(one.achieved_cents), targetCents: Number(one.target_cents), observedAt: one.observed_at })),
    };
  });
}

/** Every decision record of a goal with its derived current state and linked results. Reads; writes nothing. */
export async function decisionHistory(goalId: string): Promise<DecisionState[]> {
  const events = await listWorkstreamEvents(goalId, POLICY_EVENT_READ_LIMIT);
  const policy = await governingPolicy(goalId, { listEvents: async () => events });
  const outcomes = await getDb().all<{ id: string; reading_id: string; kind: string; achieved_cents: number; target_cents: number; observed_at: string }>(
    'SELECT id, reading_id, kind, achieved_cents, target_cents, observed_at FROM goal_outcomes WHERE workstream_id = ?',
    [goalId],
  );
  return deriveDecisionStates(decisionRecordsFrom(events), policy, outcomes);
}

/** The decisions of a goal still in force now. Reads; never mutates a record. */
export async function activeDecisions(goalId: string): Promise<DecisionState[]> {
  return (await decisionHistory(goalId)).filter((one) => one.current === 'IN_FORCE');
}
