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
import { getWorkstream, listLinks, listWorkstreamEvents } from '../../repos/register.ts';
import { cashOutcomeLessons } from '../cash/journey/learning.ts';
import { canonicalJson, sha256 } from '../scenario/model.ts';
import { governingPolicy, POLICY_EVENT_READ_LIMIT, staleAgainstPolicy, type GoverningPolicy, type PolicyVerdict } from './ownerPolicy.ts';
import type { GoalTarget, WorkstreamEvent } from '../../domain/register.ts';

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

/**
 * The kinds of fact a decision can rest on. Every kind but the two scenario ids
 * is a fact of the world, read back from the row it came from by `factValue`,
 * so a reconsideration pass compares every one of them — S-0471's examples (a
 * source changing, a conversion rate, a supplier price, an account being
 * disconnected, a fulfilled contract, a changed capital constraint) are each
 * one of these kinds, not a list the pass stops at.
 */
export type EvidenceKind =
  | 'OPPORTUNITY_PRICE'
  | 'OPPORTUNITY_DEADLINE'
  | 'CASH_NEED_COST'
  /** The goal's own target: figure, amount, currency, ledger, window. */
  | 'GOAL_TARGET'
  /** What the plan may use: capital ceilings, hours, the owner's stated resources. */
  | 'CAPITAL_CONSTRAINT'
  /** This Brain's measured conversion for an opportunity's mechanism (`cash_outcomes`). */
  | 'CONVERSION_RATE'
  /** Every agreement on an opportunity, with where its fulfilment has got to. */
  | 'CONTRACT_STATE'
  /** A connected account's last health reading (`integration_events`). */
  | 'ACCOUNT_STATE'
  | 'SCENARIO_MODEL'
  | 'SCENARIO_RUN';

/** Facts of the world: read back from rows and compared. A scenario id is the decision's own computation. */
export const WORLD_FACT_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'OPPORTUNITY_PRICE',
  'OPPORTUNITY_DEADLINE',
  'CASH_NEED_COST',
  'GOAL_TARGET',
  'CAPITAL_CONSTRAINT',
  'CONVERSION_RATE',
  'CONTRACT_STATE',
  'ACCOUNT_STATE',
]);

/** Facts that bear on every strategy of the goal rather than on one opportunity. */
export const GOAL_WIDE_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['GOAL_TARGET', 'CAPITAL_CONSTRAINT', 'ACCOUNT_STATE']);

/** One fact a decision rested on: where it came from, and a fingerprint of the value it had. */
export interface EvidenceRef {
  kind: EvidenceKind;
  /** The row the value was read from. */
  sourceRowId: string;
  /** The value as it was read. */
  value: unknown;
  /** sha256 of the canonical value: a later change to the fact is visible as a different fingerprint. */
  fingerprint: string;
}

export interface ConversionLesson {
  channel: string | null;
  contacts: number;
  answered: number;
  agreements: number;
}

export interface ContractFact {
  id: string;
  amountCents: number;
  currency: string;
  state: string;
  /** The newest fulfilment event on this agreement's obligation, or null when none is recorded. */
  fulfilment: string | null;
}

/**
 * The rows a record is built from and read back against. The fields beyond
 * opportunities and cash needs are optional so a caller that does not hold
 * them records nothing about them, rather than recording a guess.
 */
export interface FactRows {
  opportunities: Array<{ id: string; price_cents: number | null; currency: string | null; deadline: string | null; project_id?: string | null; mechanism?: string | null }>;
  cashNeeds: Array<{ id: string; opportunity_id: string | null; expected_cost_cents: number | null; state: string }>;
  /** The goal row; null when it is gone. */
  goal?: { id: string; target: GoalTarget | null; dueAt: string | null } | null;
  /** Measured conversion per project and mechanism. */
  conversions?: Array<{ projectId: string; mechanism: string; lessons: ConversionLesson[] }>;
  /** Agreements per opportunity. */
  contracts?: Array<{ opportunityId: string; agreements: ContractFact[] }>;
  /** Each connected account's last health reading. */
  accounts?: Array<{ integrationId: string; state: string }>;
}

/** The source id of a conversion fact: one project's measurement of one mechanism. */
export const conversionSourceId = (projectId: string, mechanism: string): string => `${projectId}:${mechanism}`;

const num = (value: unknown): number | null => (value === null || value === undefined || value === '' ? null : Number(value));

/**
 * The value a fact has in these rows, in the one shape it is fingerprinted in;
 * undefined when the row it came from is gone (or was never read). Pure. The
 * record is built with this function and the reconsideration pass reads back
 * with it, so the two cannot disagree on the shape of a value.
 */
export function factValue(ref: Pick<EvidenceRef, 'kind' | 'sourceRowId'>, facts: FactRows): unknown {
  switch (ref.kind) {
    case 'OPPORTUNITY_PRICE':
    case 'OPPORTUNITY_DEADLINE': {
      // These three keep the exact shape records already in production fingerprinted.
      const row = facts.opportunities.find((one) => one.id === ref.sourceRowId);
      if (!row) return undefined;
      return ref.kind === 'OPPORTUNITY_PRICE' ? { priceCents: row.price_cents, currency: row.currency } : row.deadline;
    }
    case 'CASH_NEED_COST': {
      const row = facts.cashNeeds.find((one) => one.id === ref.sourceRowId);
      return row ? { expectedCostCents: row.expected_cost_cents, state: row.state } : undefined;
    }
    case 'GOAL_TARGET':
    case 'CAPITAL_CONSTRAINT': {
      if (facts.goal === undefined) return undefined;
      if (facts.goal === null || facts.goal.id !== ref.sourceRowId) return undefined;
      const target = facts.goal.target;
      if (ref.kind === 'GOAL_TARGET') {
        return target
          ? { metric: target.metric, amountCents: num(target.amountCents), currency: target.currency, projectId: target.projectId, setAt: target.setAt, dueAt: facts.goal.dueAt }
          : { metric: null, dueAt: facts.goal.dueAt };
      }
      return target
        ? {
            capitalCeilingCents: num(target.capitalCeilingCents),
            capitalBeforeProofCents: num(target.capitalBeforeProofCents),
            capitalPerWeekCents: num(target.capitalPerWeekCents),
            hoursCeiling: num(target.hoursCeiling),
            resources: target.resources ?? null,
          }
        : null;
    }
    case 'CONVERSION_RATE': {
      if (!facts.conversions) return undefined;
      const found = facts.conversions.find((one) => conversionSourceId(one.projectId, one.mechanism) === ref.sourceRowId);
      // No measurement yet is a value ("nothing measured"), not a gone row.
      return [...(found?.lessons ?? [])]
        .map((one) => ({ channel: one.channel, contacts: one.contacts, answered: one.answered, agreements: one.agreements }))
        .sort((a, b) => String(a.channel ?? '').localeCompare(String(b.channel ?? '')));
    }
    case 'CONTRACT_STATE': {
      if (!facts.contracts) return undefined;
      const found = facts.contracts.find((one) => one.opportunityId === ref.sourceRowId);
      return [...(found?.agreements ?? [])]
        .map((one) => ({ id: one.id, amountCents: num(one.amountCents), currency: one.currency, state: one.state, fulfilment: one.fulfilment }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case 'ACCOUNT_STATE': {
      const row = facts.accounts?.find((one) => one.integrationId === ref.sourceRowId);
      return row ? { state: row.state } : undefined;
    }
    default:
      return undefined;
  }
}

/** Every world fact these rows hold for a reading's opportunities and goal, sorted. Pure. */
export function worldFactRefs(opportunityIds: ReadonlySet<string>, goalId: string, facts: FactRows): Array<Pick<EvidenceRef, 'kind' | 'sourceRowId'>> {
  const refs: Array<Pick<EvidenceRef, 'kind' | 'sourceRowId'>> = [];
  const opportunities = [...facts.opportunities].filter((o) => opportunityIds.has(o.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const one of opportunities) {
    refs.push({ kind: 'OPPORTUNITY_PRICE', sourceRowId: one.id }, { kind: 'OPPORTUNITY_DEADLINE', sourceRowId: one.id });
  }
  for (const one of [...facts.cashNeeds].filter((n) => n.opportunity_id && opportunityIds.has(n.opportunity_id)).sort((a, b) => a.id.localeCompare(b.id))) {
    refs.push({ kind: 'CASH_NEED_COST', sourceRowId: one.id });
  }
  if (facts.goal && facts.goal.id === goalId) {
    refs.push({ kind: 'GOAL_TARGET', sourceRowId: goalId }, { kind: 'CAPITAL_CONSTRAINT', sourceRowId: goalId });
  }
  if (facts.conversions) {
    const sources = new Set<string>();
    for (const one of opportunities) if (one.project_id && one.mechanism) sources.add(conversionSourceId(one.project_id, one.mechanism));
    for (const id of [...sources].sort()) refs.push({ kind: 'CONVERSION_RATE', sourceRowId: id });
  }
  if (facts.contracts) for (const one of opportunities) refs.push({ kind: 'CONTRACT_STATE', sourceRowId: one.id });
  for (const one of [...(facts.accounts ?? [])].sort((a, b) => a.integrationId.localeCompare(b.integrationId))) {
    refs.push({ kind: 'ACCOUNT_STATE', sourceRowId: one.integrationId });
  }
  return refs;
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
  for (const ref of worldFactRefs(ids, reading.workstream_id, facts)) {
    const value = factValue(ref, facts);
    if (value === undefined) continue;
    evidence.push({ kind: ref.kind, sourceRowId: ref.sourceRowId, value, fingerprint: fingerprint(value) });
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

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Read every fact a decision on these opportunities and this goal rests on,
 * from the rows that own them. `needIds` adds cash needs a record named whose
 * opportunity is not among `opportunityIds`.
 */
export async function readFactRows(input: { opportunityIds: readonly string[]; goalId: string; needIds?: readonly string[] }): Promise<FactRows> {
  const db = getDb();
  const opportunityIds = [...new Set(input.opportunityIds)];
  const needIds = [...new Set(input.needIds ?? [])];
  const opportunities = opportunityIds.length
    ? await db.all<FactRows['opportunities'][number]>(`SELECT id, price_cents, currency, deadline, project_id, mechanism FROM cash_opportunities WHERE id IN (${marks(opportunityIds.length)})`, opportunityIds)
    : [];
  const byOpportunity = opportunityIds.length
    ? await db.all<FactRows['cashNeeds'][number]>(`SELECT id, opportunity_id, expected_cost_cents, state FROM cash_needs WHERE opportunity_id IN (${marks(opportunityIds.length)})`, opportunityIds)
    : [];
  const byNeed = needIds.length ? await db.all<FactRows['cashNeeds'][number]>(`SELECT id, opportunity_id, expected_cost_cents, state FROM cash_needs WHERE id IN (${marks(needIds.length)})`, needIds) : [];
  const cashNeeds = [...new Map([...byNeed, ...byOpportunity].map((one) => [one.id, one])).values()];

  const workstream = await getWorkstream(input.goalId);
  const goal = workstream ? { id: workstream.id, target: workstream.target, dueAt: workstream.dueAt } : null;

  const conversions: NonNullable<FactRows['conversions']> = [];
  const projects = new Map<string, Set<string>>();
  for (const one of opportunities) {
    if (!one.project_id || !one.mechanism) continue;
    projects.set(one.project_id, (projects.get(one.project_id) ?? new Set()).add(one.mechanism));
  }
  for (const [projectId, mechanisms] of projects) {
    const lessons = await cashOutcomeLessons(projectId);
    for (const mechanism of mechanisms) {
      conversions.push({
        projectId,
        mechanism,
        lessons: lessons.filter((one) => one.mechanism === mechanism).map((one) => ({ channel: one.channel, contacts: one.contacts, answered: one.answered, agreements: one.agreements })),
      });
    }
  }

  const agreements = opportunityIds.length
    ? await db.all<{ id: string; opportunity_id: string; amount_cents: number; currency: string; state: string }>(
        `SELECT id, opportunity_id, amount_cents, currency, state FROM cash_agreements WHERE opportunity_id IN (${marks(opportunityIds.length)})`,
        opportunityIds,
      )
    : [];
  const fulfilmentEvents = opportunityIds.length
    ? await db.all<{ agreement_id: string; kind: string; created_at: string; id: string }>(
        `SELECT f.agreement_id, e.kind, e.created_at, e.id FROM cash_fulfillments f JOIN cash_fulfillment_events e ON e.fulfillment_id = f.id
          WHERE f.opportunity_id IN (${marks(opportunityIds.length)})`,
        opportunityIds,
      )
    : [];
  const newestFulfilment = new Map<string, { kind: string; at: string; id: string }>();
  for (const one of fulfilmentEvents) {
    const seen = newestFulfilment.get(one.agreement_id);
    if (!seen || one.created_at > seen.at || (one.created_at === seen.at && one.id > seen.id)) newestFulfilment.set(one.agreement_id, { kind: one.kind, at: one.created_at, id: one.id });
  }
  const contracts = opportunityIds.map((opportunityId) => ({
    opportunityId,
    agreements: agreements
      .filter((one) => one.opportunity_id === opportunityId)
      .map((one) => ({ id: one.id, amountCents: Number(one.amount_cents), currency: one.currency, state: one.state, fulfilment: newestFulfilment.get(one.id)?.kind ?? null })),
  }));

  // Each connected account's newest health reading; an account Brain never checked is not a fact.
  const checks = await db.all<{ integration_id: string; state: string; id: string }>(
    `SELECT e.integration_id, e.state, e.id FROM integration_events e
      WHERE e.kind = 'CHECK' AND e.recorded_at = (SELECT MAX(x.recorded_at) FROM integration_events x WHERE x.integration_id = e.integration_id AND x.kind = 'CHECK')`,
  );
  const latest = new Map<string, { state: string; id: string }>();
  for (const one of checks) {
    const seen = latest.get(one.integration_id);
    if (!seen || one.id > seen.id) latest.set(one.integration_id, { state: one.state, id: one.id });
  }
  const accounts = [...latest].map(([integrationId, one]) => ({ integrationId, state: one.state }));

  return { opportunities, cashNeeds, goal, conversions, contracts, accounts };
}

/**
 * Write the record for one reading, once. The id is derived from the reading's,
 * so a second write — a retry, a racing pass — changes nothing. Returns whether
 * this call wrote it.
 */
export async function recordDecision(reading: PlanReadingRow, deps: { policy?: GoverningPolicy; now?: Date } = {}): Promise<boolean> {
  const policy = deps.policy ?? (await governingPolicy(reading.workstream_id));
  const facts = await readFactRows({ opportunityIds: readingOpportunityIds(reading), goalId: reading.workstream_id });
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
