/**
 * The world's read model (UI-27-2): a typed, versioned presentation adapter.
 *
 * `GET /api/projects/:projectId/world` answers one question — what is true in
 * this project right now — as a flat list of facts a renderer may draw however
 * it likes (a district, a building, a character, a row in a table). It is a
 * *renderer's input*, not a second store and not a second business engine:
 *
 *   * Every fact is read through a repository another route already serves.
 *     There is no table, no write, no scheduler and no authority path here, so
 *     nothing in this file can make the world disagree with the records.
 *   * The authorization is the project routes' own: `requirePerson` refuses a
 *     machine by type, and `requireProject` is `decideProjectAccess`, so another
 *     project and a missing one are the same 404 with the same body
 *     (invariants 21, 23, 30).
 *   * A state comes from a closed set, and WORKING is earned only by a live
 *     lease with a heartbeat. A queued, held, expired-lease or errored job is
 *     never drawn as busy, and an expired lease nobody reclaimed is UNKNOWN —
 *     the honest reading of "a worker may or may not still be on it" (S-0406).
 *   * Money is reported per class, each line with its ledger kind, currency and
 *     source, and never added across classes or currencies (invariant 37). A
 *     projected or simulated figure is never in `received` (S-0406, §77).
 *   * A value that is not recorded is reported as missing, never as zero or as
 *     the favourable answer (invariant 39).
 *
 * Themes are a client concern: `district` is a suggestion from a data-driven
 * table (`DISTRICT_OF`), and a renderer may place a fact anywhere, several
 * times, or nowhere. The meaning of a fact does not change with its theme.
 */
import { Router } from 'express';
import { handler, pathId, requirePerson, requireProject } from './helpers.ts';
import { listWorkItems } from '../repos/workQueue.ts';
import { listBins } from '../repos/bins.ts';
import { listOrchestrationsByProject } from '../repos/research.ts';
import { listCampaigns } from '../repos/factory.ts';
import { listOpportunities } from '../repos/cashPortfolio.ts';
import { listInvoices } from '../repos/cashInvoices.ts';
import { currenciesInLedger, listMoneyEntries, totalsByKind } from '../repos/cashLedger.ts';
import { getMigrationReport } from '../db/database.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { assembleGoals, type GoalView } from '../services/goals/model.ts';
import type { Bin, CashMoneyKind, Principal, WorkItem } from '../domain/types.ts';

export const worldRouter = Router();

/** Bumped whenever a field's meaning changes. A reader states which version it understands. */
export const WORLD_CONTRACT_VERSION = 1 as const;

export const WORLD_STATES = ['WORKING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'SUCCEEDED', 'FAILED', 'IDLE', 'UNKNOWN'] as const;
export type WorldState = (typeof WORLD_STATES)[number];

export const WORLD_ENTITY_KINDS = [
  'GOAL',
  'WORK_UNIT',
  'BIN',
  'WORKER',
  'RESEARCH_JOB',
  'CAMPAIGN',
  'OPPORTUNITY',
  'INVOICE',
  'PERMISSION',
  'INFRASTRUCTURE',
] as const;
export type WorldEntityKind = (typeof WORLD_ENTITY_KINDS)[number];

export type WorldDistrictKey = 'CITADEL' | 'LIBRARY' | 'FORGE' | 'MARKET' | 'TREASURY' | 'ROADS' | 'LABORATORY';

export interface WorldDistrict {
  key: WorldDistrictKey;
  /** What the district stands for in Brain, independent of any art direction. */
  meaning: string;
  kinds: WorldEntityKind[];
}

/** A non-terminal fact unchanged for longer than this is marked stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface WorldFact {
  kind: WorldEntityKind;
  recordId: string;
  /**
   * The existing API address that resolves to the record, or null when no route serves it alone.
   * It is the record's source data (JSON), not a page: a client sends a person to the record's
   * view (`recordViewHref` in `client/src/world/lens.ts`) and shows this address as provenance.
   */
  href: string | null;
  title: string;
  owner: string | null;
  state: WorldState;
  /** The record's own status word, verbatim, so the mapping can be audited. */
  recordState: string | null;
  startedAt: string | null;
  lastChangedAt: string | null;
  blocker: string | null;
  nextAction: string | null;
  /**
   * Where the record has got to, in the words of the model that derives it
   * (for a goal: the goal model's lifecycle, register state and its evidence).
   * Absent or null when the record kind has no progress reading.
   */
  progress?: string | null;
  /** Which table and row this was read from. */
  source: { table: string; id: string };
  /** FRESH, STALE (a live record unchanged for a day), or MISSING (no change time recorded). */
  freshness: 'FRESH' | 'STALE' | 'MISSING';
  /** Fields the record does not carry, named rather than defaulted. */
  missing: string[];
  district: WorldDistrictKey | null;
}

export interface WorldWorker {
  workerId: string;
  /** WORKING only with a live lease and a heartbeat; UNKNOWN when the lease ran out unreclaimed. */
  state: 'WORKING' | 'UNKNOWN';
  holding: Array<{ kind: 'BIN' | 'WORK_UNIT'; recordId: string; href: string | null; heartbeatAt: string | null; leaseExpiresAt: string | null }>;
}

export const MONEY_CLASSES = ['received', 'due', 'spent', 'reserved', 'invested', 'transferred', 'projected', 'released', 'simulated'] as const;
export type MoneyClass = (typeof MONEY_CLASSES)[number];

export interface WorldMoneyLine {
  /** The ledger kind (or invoice state) this line is, verbatim. */
  kind: string;
  /** Which way the money moves: owed to this project, or by it. */
  direction: 'IN' | 'OUT' | 'HELD';
  currency: string;
  amountCents: number;
  source: { table: string; filter: string };
  lastChangedAt: string | null;
}

export interface WorldMoney {
  class: MoneyClass;
  meaning: string;
  /** One line per kind and currency. Lines are never summed into one figure. */
  lines: WorldMoneyLine[];
  /** Why the class is empty, when it is, so empty never reads as zero. */
  missing: string | null;
}

export interface WorldExplanation {
  kind: 'BLOCK' | 'DECISION' | 'FAILURE' | 'APPROVAL';
  text: string;
  recordKind: WorldEntityKind;
  recordId: string;
  href: string | null;
  lastChangedAt: string | null;
}

export interface World {
  version: typeof WORLD_CONTRACT_VERSION;
  generatedAt: string;
  projectId: string;
  districts: WorldDistrict[];
  facts: WorldFact[];
  workers: WorldWorker[];
  /** Workers actually holding a live lease right now — never a count of drawn characters. */
  workingCount: number;
  money: WorldMoney[];
  explanations: WorldExplanation[];
  viewer: { principalId: string; canRead: true; canWrite: boolean };
  /** Reads that were cut at a page limit, so a reader knows the list is not everything. */
  truncated: string[];
}

export const DISTRICTS: WorldDistrict[] = [
  { key: 'CITADEL', meaning: 'Brain itself: goals, permissions and the conversation', kinds: ['GOAL', 'PERMISSION'] },
  { key: 'LIBRARY', meaning: 'Research acquisition, reasoning and evidence', kinds: ['RESEARCH_JOB'] },
  { key: 'FORGE', meaning: 'Factory campaigns, coding workers, integration and repair', kinds: ['CAMPAIGN'] },
  { key: 'MARKET', meaning: 'Commercial discovery, offers, sales and fulfilment', kinds: ['OPPORTUNITY'] },
  { key: 'TREASURY', meaning: 'Money received, due, spent, reserved, invested and transferred', kinds: ['INVOICE'] },
  { key: 'ROADS', meaning: 'Work moving through the queue and the workers carrying it', kinds: ['WORK_UNIT', 'BIN', 'WORKER'] },
  { key: 'LABORATORY', meaning: 'Infrastructure, models and scenarios', kinds: ['INFRASTRUCTURE'] },
];

const DISTRICT_OF = new Map<WorldEntityKind, WorldDistrictKey>(DISTRICTS.flatMap((d) => d.kinds.map((k) => [k, d.key] as const)));

const PAGE = 200;

/** A lease is live when it has a heartbeat and has not expired. Nothing else makes a job WORKING. */
export function leaseIsLive(row: { leaseId: string | null; heartbeatAt: string | null; leaseExpiresAt: string | null }, now: number): boolean {
  if (!row.leaseId || !row.heartbeatAt || !row.leaseExpiresAt) return false;
  const expires = Date.parse(row.leaseExpiresAt);
  return Number.isFinite(expires) && expires > now;
}

export function workItemState(item: WorkItem, now: number): WorldState {
  switch (item.state) {
    case 'QUEUED':
      return 'WAITING';
    case 'LEASED':
      return leaseIsLive(item, now) ? 'WORKING' : 'UNKNOWN';
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'IDLE';
    default:
      return 'UNKNOWN';
  }
}

export function binState(bin: Bin, now: number): WorldState {
  switch (bin.state) {
    case 'DRAFT':
      return 'IDLE';
    case 'READY':
      return bin.heldByWorkstreamId ? 'BLOCKED' : 'WAITING';
    case 'LEASED':
      return leaseIsLive(bin, now) ? 'WORKING' : 'UNKNOWN';
    case 'COMPLETE':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'NEEDS_HUMAN':
      return 'NEEDS_APPROVAL';
    case 'CANCELLED':
      return 'IDLE';
    default:
      return 'UNKNOWN';
  }
}

const RESEARCH_ACTIVE = new Set(['PLANNING', 'RESEARCHING', 'SYNTHESIZING', 'AUDITING']);

/** Active research is WORKING only when one of its work items holds a live lease; otherwise it is waiting for one. */
export function researchState(status: string, hasLiveLease: boolean): WorldState {
  if (RESEARCH_ACTIVE.has(status)) return hasLiveLease ? 'WORKING' : 'WAITING';
  switch (status) {
    case 'QUEUED':
    case 'AWAITING_REPAIR':
      return 'WAITING';
    case 'AWAITING_APPROVAL':
    case 'NEEDS_HUMAN':
      return 'NEEDS_APPROVAL';
    case 'COMPLETE':
      return 'SUCCEEDED';
    case 'COMPLETE_WITH_GAPS':
    case 'PAUSED_QUOTA':
      return 'BLOCKED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'IDLE';
    default:
      return 'UNKNOWN';
  }
}

const CAMPAIGN_ACTIVE = new Set(['PLANNING', 'EXECUTING', 'INTEGRATING', 'REVIEWING', 'REPAIRING', 'VERIFYING', 'ASSEMBLING']);

export function campaignState(state: string, hasLiveLease: boolean): WorldState {
  if (CAMPAIGN_ACTIVE.has(state)) return hasLiveLease ? 'WORKING' : 'WAITING';
  switch (state) {
    case 'AWAITING_RELEASE':
      return 'WAITING';
    case 'COMPLETE':
      return 'SUCCEEDED';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'CANCELLED':
      return 'IDLE';
    default:
      return 'UNKNOWN';
  }
}

/** An opportunity is a record, not a job: nothing proves a worker is on it, so it is never WORKING. */
export function opportunityState(state: string): WorldState {
  switch (state) {
    case 'DISCOVERED':
    case 'EVIDENCE_CARD':
    case 'READY':
    case 'EXECUTING':
    case 'DELIVERING':
      return 'WAITING';
    case 'COLLECTED':
      return 'SUCCEEDED';
    case 'DECLINED':
    case 'ARCHIVED':
      return 'IDLE';
    default:
      return 'UNKNOWN';
  }
}

export function invoiceState(state: string): WorldState {
  switch (state) {
    case 'DRAFTED':
    case 'VOID':
      return 'IDLE';
    case 'ISSUED':
      return 'WAITING';
    case 'PAID':
    case 'SETTLED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

const TERMINAL: ReadonlySet<WorldState> = new Set(['SUCCEEDED', 'FAILED', 'IDLE']);

function fact(input: Omit<WorldFact, 'freshness' | 'missing' | 'district'> & { missing?: string[] }, now: number): WorldFact {
  const missing = [...(input.missing ?? [])];
  if (!input.lastChangedAt) missing.push('lastChangedAt');
  if (!input.startedAt) missing.push('startedAt');
  if (!input.owner) missing.push('owner');
  const changed = input.lastChangedAt ? Date.parse(input.lastChangedAt) : NaN;
  const freshness: WorldFact['freshness'] = !Number.isFinite(changed)
    ? 'MISSING'
    : !TERMINAL.has(input.state) && now - changed > STALE_AFTER_MS
      ? 'STALE'
      : 'FRESH';
  return { progress: null, ...input, missing: [...new Set(missing)], freshness, district: DISTRICT_OF.get(input.kind) ?? null };
}

/**
 * The money classes and which ledger kinds each holds. A kind belongs to one
 * class, so no amount is counted twice; `simulated` holds nothing the ledger
 * records, because the ledger records only what happened or was agreed.
 */
const MONEY_KINDS: Record<MoneyClass, { meaning: string; kinds: Array<{ kind: CashMoneyKind; direction: WorldMoneyLine['direction'] }> }> = {
  received: { meaning: 'Cash a customer actually paid', kinds: [{ kind: 'CUSTOMER_PAYMENT', direction: 'IN' }] },
  due: {
    meaning: 'Issued and unpaid invoices owed to this project and unpaid supplier commitments owed by it, each on its own line',
    kinds: [{ kind: 'UNPAID_COMMITMENT', direction: 'OUT' }],
  },
  spent: {
    meaning: 'Cash that has left: costs, commitments paid and refunds',
    kinds: [
      { kind: 'COST', direction: 'OUT' },
      { kind: 'COMMITMENT_PAID', direction: 'OUT' },
      { kind: 'REFUND', direction: 'OUT' },
    ],
  },
  reserved: {
    meaning: 'Cash set aside and released again',
    kinds: [
      { kind: 'RESERVE', direction: 'HELD' },
      { kind: 'RESERVE_RELEASE', direction: 'HELD' },
    ],
  },
  invested: { meaning: 'Capital put into the operation', kinds: [{ kind: 'CAPITAL_IN', direction: 'IN' }] },
  transferred: {
    meaning: 'Provider payouts settled to the account and capital taken back out',
    kinds: [
      { kind: 'SETTLEMENT', direction: 'IN' },
      { kind: 'CAPITAL_OUT', direction: 'OUT' },
    ],
  },
  projected: {
    meaning: 'Agreed work not yet invoiced: a pipeline, not cash',
    kinds: [{ kind: 'PIPELINE_AGREED', direction: 'IN' }],
  },
  // What was undone before it settled. A released commitment is owed no
  // longer and a released agreement will not be billed, so neither may sit
  // beside live obligations in `due` or live pipeline in `projected`
  // (S-0430: signed-but-unsettled obligations are distinguished).
  released: {
    meaning: 'Supplier commitments released before payment (no longer owed) and agreements released before billing (no longer expected), each on its own line: neither is owed, due or cash',
    kinds: [
      { kind: 'COMMITMENT_RELEASED', direction: 'OUT' },
      { kind: 'PIPELINE_RELEASED', direction: 'IN' },
    ],
  },
  simulated: { meaning: 'Model and scenario figures; never recorded in the ledger', kinds: [] },
};

async function readMoney(projectId: string, truncated: string[]): Promise<WorldMoney[]> {
  const currencies = await currenciesInLedger(projectId);
  const totals = new Map<string, Record<CashMoneyKind, number>>();
  for (const currency of currencies) totals.set(currency, await totalsByKind({ projectId, currency }));
  const recent = await listMoneyEntries({ projectId, limit: 2000 });
  if (recent.length >= 2000) truncated.push('money.lastChangedAt');
  const lastOf = new Map<string, string>();
  for (const entry of recent) {
    const key = `${entry.kind}|${entry.currency}`;
    const seen = lastOf.get(key);
    if (!seen || entry.createdAt > seen) lastOf.set(key, entry.createdAt);
  }
  const openInvoices = await listInvoices({ projectId, states: ['ISSUED', 'UNCERTAIN'] });

  return MONEY_CLASSES.map((cls) => {
    const spec = MONEY_KINDS[cls];
    const lines: WorldMoneyLine[] = [];
    for (const { kind, direction } of spec.kinds) {
      for (const currency of currencies) {
        const amount = totals.get(currency)?.[kind];
        if (amount === undefined) continue;
        lines.push({
          kind,
          direction,
          currency,
          amountCents: amount,
          source: { table: 'cash_money_entries', filter: `kind = ${kind} AND currency = ${currency}` },
          lastChangedAt: lastOf.get(`${kind}|${currency}`) ?? null,
        });
      }
    }
    if (cls === 'due') {
      const byKey = new Map<string, { amount: number; last: string }>();
      for (const invoice of openInvoices) {
        const key = `${invoice.state}|${invoice.currency}`;
        const one = byKey.get(key) ?? { amount: 0, last: '' };
        one.amount += invoice.amountCents;
        if (invoice.updatedAt > one.last) one.last = invoice.updatedAt;
        byKey.set(key, one);
      }
      for (const [key, one] of byKey) {
        const [state, currency] = key.split('|') as [string, string];
        lines.push({
          kind: `INVOICE_${state}`,
          direction: 'IN',
          currency,
          amountCents: one.amount,
          source: { table: 'cash_invoices', filter: `state = ${state} AND currency = ${currency}` },
          lastChangedAt: one.last || null,
        });
      }
    }
    const missing =
      lines.length > 0
        ? null
        : cls === 'simulated'
          ? 'The ledger records only what happened or was agreed; scenario figures are read from the scenario and goal plan routes.'
          : 'No entry of this class is recorded for this project.';
    return { class: cls, meaning: spec.meaning, lines, missing };
  });
}

type GoalReading = Pick<
  GoalView,
  'lifecycle' | 'lifecycleReason' | 'state' | 'stateEvidence' | 'waiting' | 'work' | 'blockers' | 'decisions' | 'target' | 'pausedReason' | 'cancelledReason'
>;

/**
 * A goal's world state, from the goal model's derivation (UI-27-1: never imply
 * a false state). COMPLETE is the goal model's word — its rows or its ledger
 * target say the outcome was reached. A goal is WORKING only while a worker
 * holds an unexpired lease on its work; queued work is WAITING, never busy.
 * UNKNOWN is kept for an active goal whose rows say nothing about where it
 * has got to.
 */
export function goalWorldState(g: GoalReading): { state: WorldState; blocker: string | null } {
  if (g.lifecycle === 'COMPLETE') return { state: 'SUCCEEDED', blocker: null };
  if (g.lifecycle === 'CANCELLED') return { state: 'IDLE', blocker: `cancelled: ${g.cancelledReason ?? 'no reason recorded'}` };
  if (g.lifecycle === 'ARCHIVED') return { state: 'IDLE', blocker: null };
  if (g.lifecycle === 'PAUSED') return { state: 'BLOCKED', blocker: `paused: ${g.pausedReason ?? 'no reason recorded'}` };
  if (g.decisions.length > 0 || g.waiting.kind === 'PERSON') {
    return { state: 'NEEDS_APPROVAL', blocker: g.decisions[0]?.question ?? g.waiting.detail };
  }
  if (g.blockers.length > 0 || g.state === 'BLOCKED') return { state: 'BLOCKED', blocker: g.blockers[0]?.text ?? g.stateEvidence };
  if (g.work.some((w) => w.workerOnIt)) return { state: 'WORKING', blocker: null };
  if (g.state === 'DONE' || g.state === 'VERIFIED_LIVE') return { state: 'SUCCEEDED', blocker: null };
  if (g.waiting.kind === 'NOTHING_LINKED') return { state: 'IDLE', blocker: null };
  if (g.state !== 'UNKNOWN' || g.work.length > 0 || g.waiting.kind !== 'NOTHING') return { state: 'WAITING', blocker: null };
  return { state: 'UNKNOWN', blocker: null };
}

/** A goal's progress in words, read from the goal model's own derivation. Never a percentage. */
export function goalProgress(g: GoalReading): string {
  const parts = [`${g.lifecycle}: ${g.lifecycleReason}`];
  if (g.state !== 'UNKNOWN') parts.push(`register ${g.state} (${g.stateEvidence})`);
  if (g.target) {
    parts.push(
      `${g.target.metricLabel}: ${g.target.achievedCents} of ${g.target.targetCents} ${g.target.currency} cents on the ledger${g.target.achieved ? ', reached' : ''}`,
    );
  }
  if (g.waiting.kind !== 'NOTHING') parts.push(`waiting (${g.waiting.kind}): ${g.waiting.detail}`);
  return parts.join('; ');
}

export async function composeWorld(projectId: string, principal: Principal, nowMs = Date.now()): Promise<World> {
  const now = nowMs;
  const truncated: string[] = [];
  const facts: WorldFact[] = [];
  const explanations: WorldExplanation[] = [];
  const explain = (f: WorldFact) => {
    const text =
      f.state === 'BLOCKED'
        ? `${f.title} is blocked${f.blocker ? `: ${f.blocker}` : ' (no reason recorded)'}`
        : f.state === 'FAILED'
          ? `${f.title} failed${f.blocker ? `: ${f.blocker}` : ''}`
          : f.state === 'NEEDS_APPROVAL'
            ? `${f.title} needs a person${f.blocker ? `: ${f.blocker}` : ''}`
            : f.nextAction
              ? `${f.title}: next, ${f.nextAction}`
              : null;
    if (!text) return;
    const kind: WorldExplanation['kind'] =
      f.state === 'BLOCKED' ? 'BLOCK' : f.state === 'FAILED' ? 'FAILURE' : f.state === 'NEEDS_APPROVAL' ? 'APPROVAL' : 'DECISION';
    explanations.push({ kind, text, recordKind: f.kind, recordId: f.recordId, href: f.href, lastChangedAt: f.lastChangedAt });
  };

  // Goals. Read through the goal model, which already derives each goal's
  // lifecycle, register state, blockers, decisions and next action from its
  // rows (the same owner /api/goals/:goalId serves); this adapter maps that
  // derivation to a world state and does not re-derive it.
  const goalViews = (await assembleGoals({ projectIds: [projectId], now: new Date(now).toISOString() })).goals.filter(
    (g) => g.projectId === projectId,
  );
  for (const g of goalViews) {
    const mapped = goalWorldState(g);
    const f = fact(
      {
        kind: 'GOAL',
        recordId: g.id,
        href: `/api/goals/${g.id}`,
        title: g.title,
        owner: g.owner?.userId ?? null,
        state: mapped.state,
        recordState: g.state === 'UNKNOWN' ? g.lifecycle : `${g.lifecycle} · ${g.state}`,
        startedAt: g.createdAt,
        lastChangedAt: g.updatedAt,
        blocker: mapped.blocker,
        nextAction: g.next.action || null,
        progress: goalProgress(g),
        source: { table: 'workstreams', id: g.id },
        missing: mapped.state === 'UNKNOWN' ? ['register state (no linked row says where this goal has got to)'] : [],
      },
      now,
    );
    facts.push(f);
    explain(f);
  }

  // Work units and bins, and the workers whose leases on them prove activity.
  const workers = new Map<string, WorldWorker>();
  const holdBy = (workerId: string | null, live: boolean, holding: WorldWorker['holding'][number]) => {
    if (!workerId) return;
    const w = workers.get(workerId) ?? { workerId, state: 'UNKNOWN' as WorldWorker['state'], holding: [] };
    if (live) w.state = 'WORKING';
    w.holding.push(holding);
    workers.set(workerId, w);
  };
  const items = await listWorkItems(projectId, { limit: PAGE });
  const leased = await listWorkItems(projectId, { states: ['LEASED'], limit: 500 });
  if (items.length >= PAGE) truncated.push('work_items');
  const seenItems = new Set<string>();
  const liveByOrchestration = new Set<string>();
  for (const item of [...leased, ...items]) {
    if (seenItems.has(item.id)) continue;
    seenItems.add(item.id);
    const state = workItemState(item, now);
    if (item.state === 'LEASED') {
      const live = state === 'WORKING';
      if (live && item.orchestrationId) liveByOrchestration.add(item.orchestrationId);
      holdBy(item.workerId, live, { kind: 'WORK_UNIT', recordId: item.id, href: `/api/work/${item.id}`, heartbeatAt: item.heartbeatAt, leaseExpiresAt: item.leaseExpiresAt });
    }
    const f = fact(
      {
        kind: 'WORK_UNIT',
        recordId: item.id,
        href: `/api/work/${item.id}`,
        title: item.workType,
        owner: item.workerId,
        state,
        recordState: item.state,
        startedAt: item.leasedAt,
        lastChangedAt: item.heartbeatAt ?? item.leasedAt ?? item.availableAt,
        blocker:
          state === 'UNKNOWN' && item.state === 'LEASED'
            ? 'lease expired without a heartbeat; the outcome is unverified'
            : state === 'FAILED'
              ? item.failureCategory ?? item.resultSummary ?? 'failed (no reason recorded)'
              : null,
        nextAction: state === 'WAITING' ? `claimable from ${item.availableAt}` : null,
        source: { table: 'work_items', id: item.id },
      },
      now,
    );
    facts.push(f);
    explain(f);
  }

  const bins = await listBins({ projectId, limit: PAGE });
  const liveBins = await listBins({ projectId, states: ['LEASED'], limit: 500 });
  if (bins.length >= PAGE) truncated.push('bins');
  const seenBins = new Set<string>();
  const liveBranches = new Set<string>();
  for (const bin of [...liveBins, ...bins]) {
    if (seenBins.has(bin.id)) continue;
    seenBins.add(bin.id);
    const state = binState(bin, now);
    if (bin.state === 'LEASED') {
      const live = state === 'WORKING';
      if (live && bin.manifest?.repository?.integrationBranch) liveBranches.add(bin.manifest.repository.integrationBranch);
      if (live && bin.orchestrationId) liveByOrchestration.add(bin.orchestrationId);
      holdBy(bin.workerId ?? bin.leaseSessionRef, live, { kind: 'BIN', recordId: bin.id, href: null, heartbeatAt: bin.heartbeatAt, leaseExpiresAt: bin.leaseExpiresAt });
    }
    const f = fact(
      {
        kind: 'BIN',
        recordId: bin.id,
        // No route serves a bin alone to a project member; the fleet view lists them.
        href: `/api/russell/projects/${projectId}/fleet`,
        title: bin.title,
        owner: bin.workerId,
        state,
        recordState: bin.state,
        startedAt: bin.leasedAt,
        lastChangedAt: bin.updatedAt,
        blocker:
          state === 'BLOCKED'
            ? `held by goal ${bin.heldByWorkstreamId}: ${bin.heldReason ?? 'no reason recorded'}`
            : state === 'UNKNOWN'
              ? 'lease expired without a heartbeat; the outcome is unverified'
              : state === 'FAILED' || state === 'NEEDS_APPROVAL'
                ? bin.terminalReason ?? 'no reason recorded'
                : null,
        nextAction: state === 'WAITING' ? 'assigned to the next eligible worker that checks in' : null,
        source: { table: 'bins', id: bin.id },
      },
      now,
    );
    facts.push(f);
    explain(f);
  }

  // Research.
  for (const o of await listOrchestrationsByProject(projectId)) {
    const state = researchState(o.status, liveByOrchestration.has(o.id));
    const f = fact(
      {
        kind: 'RESEARCH_JOB',
        recordId: o.id,
        href: `/api/research/${o.id}`,
        title: o.title,
        owner: o.provider,
        state,
        recordState: o.status,
        startedAt: o.createdAt,
        lastChangedAt: o.updatedAt,
        blocker:
          o.status === 'COMPLETE_WITH_GAPS'
            ? 'filed honestly short of the goal; gaps remain'
            : o.status === 'PAUSED_QUOTA'
              ? 'out of allowance until the quota refreshes'
              : state === 'FAILED' || state === 'NEEDS_APPROVAL'
                ? o.status
                : null,
        nextAction: o.status === 'AWAITING_APPROVAL' ? 'a person approves the plan' : null,
        source: { table: 'research_orchestrations', id: o.id },
      },
      now,
    );
    facts.push(f);
    explain(f);
  }

  // Factory campaigns.
  for (const c of await listCampaigns(projectId)) {
    const state = campaignState(c.state, liveBranches.has(c.integrationBranch));
    const f = fact(
      {
        kind: 'CAMPAIGN',
        recordId: c.id,
        href: `/api/factory/campaigns/${c.id}`,
        title: c.stageDetail ? `${c.state}: ${c.stageDetail}` : c.state,
        owner: c.leaseOwner,
        state,
        recordState: c.state,
        startedAt: c.startedAt,
        lastChangedAt: c.updatedAt,
        blocker: c.blockerKind ? `${c.blockerKind}${c.blockerDetail ? `: ${c.blockerDetail}` : ''}` : null,
        nextAction: c.state === 'AWAITING_RELEASE' ? 'release the integrated change' : null,
        source: { table: 'factory_campaigns', id: c.id },
      },
      now,
    );
    facts.push(f);
    explain(f);
  }

  // Opportunities and invoices.
  for (const op of await listOpportunities({ projectId })) {
    const f = fact(
      {
        kind: 'OPPORTUNITY',
        recordId: op.id,
        href: `/api/cash/opportunities/${op.id}`,
        title: op.title,
        owner: op.ownerUserId,
        state: opportunityState(op.state),
        recordState: op.state,
        startedAt: op.createdAt,
        lastChangedAt: op.updatedAt,
        blocker: null,
        nextAction: op.nextAction,
        source: { table: 'cash_opportunities', id: op.id },
      },
      now,
    );
    facts.push(f);
    explain(f);
  }
  for (const inv of await listInvoices({ projectId })) {
    const f = fact(
      {
        kind: 'INVOICE',
        recordId: inv.id,
        href: `/api/cash/opportunities/${inv.opportunityId}`,
        title: `Invoice to ${inv.customerName}`,
        owner: inv.requestedBy,
        state: invoiceState(inv.state),
        recordState: inv.state,
        startedAt: inv.issuedAt,
        lastChangedAt: inv.updatedAt,
        blocker: inv.state === 'UNCERTAIN' || inv.state === 'FAILED' ? inv.stateReason ?? inv.state : null,
        nextAction: inv.state === 'ISSUED' ? `collect by ${inv.dueDate}` : null,
        source: { table: 'cash_invoices', id: inv.id },
      },
      now,
    );
    facts.push(f);
    explain(f);
  }

  // Workers: one fact per worker holding a lease in this project.
  const workerList = [...workers.values()].sort((a, b) => a.workerId.localeCompare(b.workerId));
  for (const w of workerList) {
    const last = w.holding.map((h) => h.heartbeatAt ?? '').sort().pop() || null;
    facts.push(
      fact(
        {
          kind: 'WORKER',
          recordId: w.workerId,
          href: `/api/russell/projects/${projectId}/fleet`,
          title: w.workerId,
          owner: w.workerId,
          state: w.state,
          recordState: w.state === 'WORKING' ? 'LIVE_LEASE' : 'EXPIRED_LEASE',
          startedAt: null,
          lastChangedAt: last,
          blocker: w.state === 'UNKNOWN' ? 'holds only expired leases' : null,
          nextAction: null,
          source: { table: w.holding[0]?.kind === 'BIN' ? 'bins' : 'work_items', id: w.holding[0]?.recordId ?? w.workerId },
        },
        now,
      ),
    );
  }

  // The caller's own permission, and the infrastructure the caller may see.
  const canWrite = decideProjectAccess(principal, projectId, 'WRITE').allowed;
  facts.push(
    fact(
      {
        kind: 'PERMISSION',
        recordId: `${principal.id}:${projectId}`,
        href: `/api/projects/${projectId}`,
        title: canWrite ? 'You may read and act in this project' : 'You may read this project',
        owner: principal.id,
        state: 'SUCCEEDED',
        recordState: canWrite ? 'WRITE' : 'READ',
        startedAt: null,
        lastChangedAt: new Date(now).toISOString(),
        blocker: null,
        nextAction: null,
        source: { table: 'project_memberships', id: `${principal.id}:${projectId}` },
      },
      now,
    ),
  );
  const migrations = getMigrationReport();
  facts.push(
    fact(
      {
        kind: 'INFRASTRUCTURE',
        recordId: 'database',
        href: '/api/health',
        title: 'Database',
        owner: 'brain',
        // It answered every read above, so it is up; the schema version is the evidence.
        state: 'SUCCEEDED',
        recordState: migrations ? `schema ${migrations.schemaVersion}` : null,
        startedAt: null,
        lastChangedAt: new Date(now).toISOString(),
        blocker: null,
        nextAction: null,
        source: { table: 'schema_migrations', id: migrations ? String(migrations.schemaVersion) : 'unknown' },
        missing: migrations ? [] : ['schemaVersion'],
      },
      now,
    ),
  );

  return {
    version: WORLD_CONTRACT_VERSION,
    generatedAt: new Date(now).toISOString(),
    projectId,
    districts: DISTRICTS,
    facts,
    workers: workerList,
    workingCount: workerList.filter((w) => w.state === 'WORKING').length,
    money: await readMoney(projectId, truncated),
    explanations,
    viewer: { principalId: principal.id, canRead: true, canWrite },
    truncated,
  };
}

worldRouter.get(
  '/projects/:projectId/world',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return composeWorld(project.id, principal);
  }),
);
