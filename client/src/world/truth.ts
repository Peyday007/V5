/**
 * The truth contract for visible numbers (UI-27-1, UI-27-6; S-0406, S-0430).
 *
 * "Spectacle sits on top of truth. Never imply that a worker is actively
 * executing when the real job is queued, blocked, idle, errored or unverified.
 * Never depict simulated cash as received cash, an offer as a sale, a deal
 * estimate as a contract, or a model scenario as measured success probability.
 * Make timestamps, provenance, stale data and missing values accessible."
 *
 * Every renderer — the world, a table, a chart, the conversation — turns a
 * `WorldFact` or a `WorldMoney` line from `GET /api/projects/:id/world` into a
 * `DisplayValue` here, and nowhere else. A display value always carries its
 * unit, time range, owner, source reference, confidence and freshness, so no
 * surface can show a number stripped of what it means.
 *
 * Nothing in this file reads or writes state: it is a pure function of what
 * the world route returned (invariants 37, 39, 45). A value the route did not
 * report is MISSING with a reason, never zero and never the favourable answer.
 */
import type { MoneyClass, World, WorldFact, WorldMoney, WorldMoneyLine, WorldState } from '../../../server/routes/world.ts';

export const TRUTH_CONTRACT_VERSION = 1 as const;

/** How old a world snapshot may be before every value read from it is shown as stale. */
export const SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Amount basis: what kind of money a figure is. The label is chosen by the
// basis and nothing else, so a projected figure cannot borrow "collected".
// ---------------------------------------------------------------------------

export const AMOUNT_BASES = [
  'COLLECTED',
  'SIGNED_UNSETTLED',
  'INVOICED',
  'RELEASED',
  'SPENT',
  'RESERVED',
  'INVESTED',
  'TRANSFERRED',
  'PROJECTED',
  'SIMULATED',
  'OFFERED',
  'SOLD',
  'ESTIMATED',
  'CONTRACTED',
  'MODELLED',
  'MEASURED',
] as const;
export type AmountBasis = (typeof AMOUNT_BASES)[number];

/** Measured: a real event recorded it. Modelled: a pipeline, offer, estimate or scenario said it might be. */
export type Confidence = 'MEASURED' | 'MODELLED' | 'UNKNOWN';

interface BasisSpec {
  label: string;
  confidence: Exclude<Confidence, 'UNKNOWN'>;
  /** The realised claim this basis must never be shown as, when it is not itself realised. */
  notA: AmountBasis | null;
}

/**
 * The only labels a figure may carry. The realised labels (collected, sale,
 * contract, measured) belong to measured bases alone; each modelled basis
 * states in its own label what it is not.
 */
export const BASIS: Readonly<Record<AmountBasis, BasisSpec>> = {
  COLLECTED: { label: 'Cash collected', confidence: 'MEASURED', notA: null },
  SIGNED_UNSETTLED: { label: 'Signed obligation, unsettled', confidence: 'MEASURED', notA: 'COLLECTED' },
  INVOICED: { label: 'Invoiced, unpaid', confidence: 'MEASURED', notA: 'COLLECTED' },
  RELEASED: { label: 'Commitment released', confidence: 'MEASURED', notA: null },
  SPENT: { label: 'Spent', confidence: 'MEASURED', notA: null },
  RESERVED: { label: 'Reserved', confidence: 'MEASURED', notA: null },
  INVESTED: { label: 'Capital invested', confidence: 'MEASURED', notA: null },
  TRANSFERRED: { label: 'Transferred', confidence: 'MEASURED', notA: null },
  PROJECTED: { label: 'Projected — not cash', confidence: 'MODELLED', notA: 'COLLECTED' },
  SIMULATED: { label: 'Simulated — not cash', confidence: 'MODELLED', notA: 'COLLECTED' },
  OFFERED: { label: 'Offer — not yet sold', confidence: 'MODELLED', notA: 'SOLD' },
  SOLD: { label: 'Sale closed', confidence: 'MEASURED', notA: null },
  ESTIMATED: { label: 'Estimate — not agreed', confidence: 'MODELLED', notA: 'CONTRACTED' },
  CONTRACTED: { label: 'Signed contract', confidence: 'MEASURED', notA: null },
  MODELLED: { label: 'Modelled — not observed', confidence: 'MODELLED', notA: 'MEASURED' },
  MEASURED: { label: 'Measured', confidence: 'MEASURED', notA: null },
};

/** The labels that assert something actually happened. A modelled basis never renders one. */
export const REALISED_LABELS: readonly string[] = (['COLLECTED', 'SOLD', 'CONTRACTED', 'MEASURED'] as const).map((b) => BASIS[b].label);

/** A ledger kind's basis, by the class the world route put it in. Unknown kinds are UNKNOWN, never COLLECTED. */
export function basisOfMoneyLine(cls: MoneyClass, line: Pick<WorldMoneyLine, 'kind'>): AmountBasis | null {
  switch (cls) {
    case 'received':
      return line.kind === 'CUSTOMER_PAYMENT' ? 'COLLECTED' : null;
    case 'due':
      if (line.kind.startsWith('INVOICE_')) return 'INVOICED';
      if (line.kind === 'UNPAID_COMMITMENT') return 'SIGNED_UNSETTLED';
      if (line.kind === 'COMMITMENT_RELEASED') return 'RELEASED';
      return null;
    case 'spent':
      return 'SPENT';
    case 'reserved':
      return 'RESERVED';
    case 'invested':
      return 'INVESTED';
    case 'transferred':
      return 'TRANSFERRED';
    case 'projected':
      return 'PROJECTED';
    case 'simulated':
      return 'SIMULATED';
  }
}

// ---------------------------------------------------------------------------
// Display values
// ---------------------------------------------------------------------------

export type Freshness = 'CURRENT' | 'STALE' | 'MISSING';

export interface TimeRange {
  from: string | null;
  to: string | null;
  /** Readable without parsing the timestamps. */
  label: string;
}

export interface DisplayValue {
  /** What to print. A missing value says so; it is never "0". */
  text: string;
  /** The raw number, or null when it is not recorded. */
  value: number | null;
  unit: string;
  basis: AmountBasis | null;
  /** The basis' own label, or a plain "Unclassified" for a kind no basis covers. */
  basisLabel: string;
  confidence: Confidence;
  freshness: Freshness;
  /** When the value last changed, or null when the record does not say. */
  asOf: string | null;
  timeRange: TimeRange;
  owner: string;
  source: string;
  /** Why the value is missing or stale, in words — never only a colour. */
  note: string | null;
  /** Fields the record does not carry, named rather than defaulted. */
  missing: string[];
}

export interface TruthContext {
  /** The world snapshot the value came from. */
  world: Pick<World, 'generatedAt' | 'projectId'>;
  /** The reader's clock, for snapshot staleness. */
  nowMs: number;
}

export function snapshotIsStale(ctx: TruthContext): boolean {
  const generated = Date.parse(ctx.world.generatedAt);
  if (!Number.isFinite(generated)) return true;
  return ctx.nowMs - generated > SNAPSHOT_STALE_AFTER_MS;
}

export function formatCents(amountCents: number, currency: string): string {
  const major = amountCents / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

function sourceRef(source: { table: string; filter?: string; id?: string }): string {
  if (source.id !== undefined) return `${source.table}#${source.id}`;
  if (source.filter !== undefined) return `${source.table} where ${source.filter}`;
  return source.table;
}

/**
 * One money line as a display value. The ledger totals are cumulative, so the
 * time range runs from the project's start to the snapshot; the snapshot's age
 * decides staleness, and a line with no recorded change time is flagged.
 */
export function displayMoneyLine(money: Pick<WorldMoney, 'class'>, line: WorldMoneyLine, ctx: TruthContext): DisplayValue {
  const basis = basisOfMoneyLine(money.class, line);
  const stale = snapshotIsStale(ctx);
  const missing: string[] = [];
  if (!line.lastChangedAt) missing.push('lastChangedAt');
  const notes: string[] = [];
  if (stale) notes.push(`Snapshot from ${ctx.world.generatedAt} is out of date`);
  if (!line.lastChangedAt) notes.push('No change time recorded for this line');
  if (basis === null) notes.push(`Ledger kind ${line.kind} has no recognised basis`);
  return {
    text: formatCents(line.amountCents, line.currency),
    value: line.amountCents,
    unit: `${line.currency} (cents)`,
    basis,
    basisLabel: basis ? BASIS[basis].label : 'Unclassified',
    confidence: basis ? BASIS[basis].confidence : 'UNKNOWN',
    freshness: stale ? 'STALE' : 'CURRENT',
    asOf: line.lastChangedAt,
    timeRange: { from: null, to: ctx.world.generatedAt, label: `All recorded entries up to ${ctx.world.generatedAt}` },
    owner: `project ${ctx.world.projectId}`,
    source: sourceRef(line.source),
    note: notes.length > 0 ? notes.join('; ') : null,
    missing,
  };
}

/** A class with no lines is one MISSING value carrying the route's reason — never a zero. */
export function displayMoneyClass(money: WorldMoney, ctx: TruthContext): DisplayValue[] {
  if (money.lines.length > 0) return money.lines.map((line) => displayMoneyLine(money, line, ctx));
  const basis = basisOfMoneyLine(money.class, { kind: '' });
  return [
    {
      text: 'Not recorded',
      value: null,
      unit: 'money',
      basis,
      basisLabel: basis ? BASIS[basis].label : 'Unclassified',
      confidence: 'UNKNOWN',
      freshness: 'MISSING',
      asOf: null,
      timeRange: { from: null, to: ctx.world.generatedAt, label: `All recorded entries up to ${ctx.world.generatedAt}` },
      owner: `project ${ctx.world.projectId}`,
      source: `world.money.${money.class}`,
      note: money.missing ?? 'No entry of this class is recorded.',
      missing: ['amount'],
    },
  ];
}

/**
 * A figure from outside the ledger — an offer, an estimate, a scenario result.
 * The caller names its basis; a modelled basis can never print a realised label,
 * because the label is BASIS[basis].label and nothing the caller passes.
 */
export function displayAmount(input: {
  basis: AmountBasis;
  amountCents: number | null;
  currency: string;
  asOf: string | null;
  owner: string | null;
  source: string | null;
  timeRange?: TimeRange;
  ctx: TruthContext;
}): DisplayValue {
  const spec = BASIS[input.basis];
  const missing: string[] = [];
  if (input.amountCents === null) missing.push('amount');
  if (!input.asOf) missing.push('asOf');
  if (!input.owner) missing.push('owner');
  if (!input.source) missing.push('source');
  const stale = snapshotIsStale(input.ctx);
  const freshness: Freshness = input.amountCents === null ? 'MISSING' : stale ? 'STALE' : 'CURRENT';
  return {
    text: input.amountCents === null ? 'Not recorded' : formatCents(input.amountCents, input.currency),
    value: input.amountCents,
    unit: `${input.currency} (cents)`,
    basis: input.basis,
    basisLabel: spec.label,
    confidence: input.amountCents === null ? 'UNKNOWN' : spec.confidence,
    freshness,
    asOf: input.asOf,
    timeRange: input.timeRange ?? { from: null, to: input.asOf, label: input.asOf ? `As of ${input.asOf}` : 'Time not recorded' },
    owner: input.owner ?? 'Owner not recorded',
    source: input.source ?? 'Source not recorded',
    note: freshness === 'MISSING' ? 'No amount is recorded' : freshness === 'STALE' ? `Snapshot from ${input.ctx.world.generatedAt} is out of date` : null,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Work state: only a live lease is "working".
// ---------------------------------------------------------------------------

export interface StateDisplay {
  state: WorldState;
  /** A word, so the state never depends on colour or motion alone. */
  label: string;
  /** Whether a renderer may draw the entity as actively executing. True only for WORKING. */
  active: boolean;
  /** Whether a person is needed. */
  needsAttention: boolean;
}

export const STATE_DISPLAY: Readonly<Record<WorldState, Omit<StateDisplay, 'state'>>> = {
  WORKING: { label: 'Working (live lease)', active: true, needsAttention: false },
  WAITING: { label: 'Waiting', active: false, needsAttention: false },
  BLOCKED: { label: 'Blocked', active: false, needsAttention: true },
  NEEDS_APPROVAL: { label: 'Needs approval', active: false, needsAttention: true },
  SUCCEEDED: { label: 'Succeeded', active: false, needsAttention: false },
  FAILED: { label: 'Failed', active: false, needsAttention: true },
  IDLE: { label: 'Idle', active: false, needsAttention: false },
  UNKNOWN: { label: 'Unknown — not verified', active: false, needsAttention: false },
};

export function displayState(state: WorldState | string): StateDisplay {
  const known = (STATE_DISPLAY as Record<string, Omit<StateDisplay, 'state'> | undefined>)[state];
  if (!known) return { state: 'UNKNOWN', ...STATE_DISPLAY.UNKNOWN };
  return { state: state as WorldState, ...known };
}

export interface FactDisplay {
  recordId: string;
  href: string | null;
  title: string;
  state: StateDisplay;
  /** The record's own status word, so the mapping can be checked. */
  recordState: string;
  freshness: Freshness;
  startedAt: string;
  lastChangedAt: string;
  owner: string;
  source: string;
  blocker: string | null;
  nextAction: string | null;
  note: string | null;
  missing: string[];
}

/** A fact as every surface shows it: timestamps, provenance and staleness are always present, in words. */
export function displayFact(fact: WorldFact, ctx: TruthContext): FactDisplay {
  const freshness: Freshness = fact.freshness === 'MISSING' ? 'MISSING' : fact.freshness === 'STALE' || snapshotIsStale(ctx) ? 'STALE' : 'CURRENT';
  const notes: string[] = [];
  if (fact.freshness === 'STALE') notes.push(`Unchanged since ${fact.lastChangedAt ?? 'an unrecorded time'}`);
  if (fact.freshness === 'MISSING') notes.push('No change time recorded');
  if (snapshotIsStale(ctx)) notes.push(`Snapshot from ${ctx.world.generatedAt} is out of date`);
  return {
    recordId: fact.recordId,
    href: fact.href,
    title: fact.title,
    state: displayState(fact.state),
    recordState: fact.recordState ?? 'Not recorded',
    freshness,
    startedAt: fact.startedAt ?? 'Not recorded',
    lastChangedAt: fact.lastChangedAt ?? 'Not recorded',
    owner: fact.owner ?? 'Owner not recorded',
    source: sourceRef(fact.source),
    blocker: fact.blocker,
    nextAction: fact.nextAction,
    note: notes.length > 0 ? notes.join('; ') : null,
    missing: [...fact.missing],
  };
}

/** The worker count a surface may print: the route's live-lease count, never a count of drawn characters. */
export function workingCountDisplay(world: Pick<World, 'workingCount' | 'workers'>): { text: string; value: number } {
  const value = world.workingCount;
  return { text: `${value} worker${value === 1 ? '' : 's'} holding a live lease`, value };
}
