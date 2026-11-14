/**
 * The goal's portfolio read as streams (PORT-05, S-0063).
 *
 * `evaluateGoalPortfolio` chooses the combination most likely to reach the
 * target. The specification asks for more than one answer: a portfolio holds a
 * leading combination, alternates, contingency options, the operations already
 * working and the future bets, and it models how they interact — correlation,
 * cash-flow timing, delivery obligations, workforce capacity, quality
 * assurance, outreach limits, market crowding and the constraints they share.
 *
 * This module is a pure reading of what the portfolio already computed: the
 * same openings, the same demand worlds, the same limits. It searches nothing
 * and stores nothing (the optimizer stays `quant/portfolio.ts`), and it never
 * drops an opening — a refused or unevidenced one is a FUTURE_BET, kept (§47).
 * No role depends on a category, an industry or a title: only on the
 * combination, the evidence and the shared resources.
 *
 * Every figure says whether it is ESTABLISHED (each input it rests on is
 * evidence or Brain's own measurement) or ASSUMED (a swept range or a declared
 * assumption, such as the correlation of lines sharing one mailbox).
 *
 * Correlation is measured where the ledger can measure it. Two streams that
 * have each taken buyer money over enough of the same weeks have a measured
 * co-movement: the Pearson correlation of their weekly net buyer money
 * (`measureCoMovement`), with its 90% interval and the weeks it rests on, and
 * that reading replaces the structural assumption for the pair. A risk group
 * with measured pairs carries their mean to its unmeasured pairs and to the
 * optimizer (`measuredGroupCorrelations`), still marked ASSUMED for the pair
 * itself. Only where nothing was measured does the declared coefficient stand,
 * and it says so.
 */
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';

export type StreamRole = 'LEADING' | 'ALTERNATE' | 'CONTINGENCY' | 'WORKING_OPERATION' | 'FUTURE_BET';
export type FigureBasis = 'ESTABLISHED' | 'ASSUMED';

export interface StreamSpread {
  p10: number;
  p50: number;
  p90: number;
}

/** The slice of the portfolio's own reading this module needs. Structural, so it cannot drift from it. */
export interface StreamsDemand {
  opportunityId: string;
  title: string;
  repeatable: boolean;
  contacted: StreamSpread;
  deals: StreamSpread;
  revenue: StreamSpread;
  spend: StreamSpread;
  days: StreamSpread;
  capitalAtStart: number;
  justified: boolean;
  unestablished: string[];
  refused: string | null;
}

export interface StreamsCombination {
  members: Array<{ opportunityId: string; title: string; share: number | null }>;
}

/** One member's cash, world by world, at the share it holds: what the combined curve is summed from. */
export interface StreamWorlds {
  cash: number[];
  days: number[];
  /**
   * Deals are won across the selling window (a repeatable line), so its cash
   * settles from `days` after the start until the deadline rather than at one
   * moment. The pacing is uniform — a declared assumption.
   */
  paced: boolean;
}

export type CorrelationKind =
  /** Read from the ledger: both streams' weekly buyer money, over the weeks both were selling. */
  | 'MEASURED_CO_MOVEMENT'
  /** Both fail through one modelled factor (a mailbox, a channel); the coefficient is declared or carried from the group's measured pairs. */
  | 'SHARED_RISK_GROUP'
  /** No shared factor is modelled and nothing was measured, so independence is assumed. */
  | 'NONE_KNOWN';

/** Where a coefficient came from. */
export type CorrelationSource =
  | 'MEASURED'
  /** The mean of the measured pairs inside the same risk group. */
  | 'GROUP_MEASUREMENT'
  /** A coefficient a caller declared for the group (e.g. the shared mailbox). */
  | 'DECLARED'
  /** The optimizer's own default for a group nobody named. */
  | 'DEFAULT'
  | 'NONE';

export interface CoMovement {
  coefficient: number;
  /** Weeks both series cover, zero weeks included: the sample the coefficient rests on. */
  periods: number;
  /** 90% interval (Fisher z). */
  interval: { low: number; high: number };
}

export interface StreamCorrelation {
  with: string;
  coefficient: number;
  kind: CorrelationKind;
  riskGroup: string | null;
  basis: FigureBasis;
  source: CorrelationSource;
  /** Present when kind is MEASURED_CO_MOVEMENT. */
  measured?: CoMovement;
  /** What the structural model alone would say, kept beside a measurement so the two can be compared. */
  structural?: { coefficient: number; kind: Exclude<CorrelationKind, 'MEASURED_CO_MOVEMENT'>; source: CorrelationSource };
}

/** One dated amount of buyer money on one stream, net (a refund is negative). */
export interface ObservedOutcome {
  opportunityId: string;
  occurredAt: string;
  amount: number;
}

/** Fewer shared weeks than this locate nothing: one large payment decides the sign. */
export const MIN_CO_MOVEMENT_PERIODS = 8;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const Z90 = 1.6449;

function weeklySeries(outcomes: readonly ObservedOutcome[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const o of outcomes) {
    const t = Date.parse(o.occurredAt);
    if (!Number.isFinite(t) || !Number.isFinite(o.amount)) continue;
    const week = Math.floor(t / WEEK_MS);
    out.set(week, (out.get(week) ?? 0) + o.amount);
  }
  return out;
}

/**
 * The measured co-movement of two streams: the Pearson correlation of their
 * weekly net buyer money over the weeks from the later of their first entries
 * to the later of their last ones (a week with no money is a zero, not a gap —
 * both were selling). Null when the window is shorter than
 * MIN_CO_MOVEMENT_PERIODS or either series never varies: then nothing was
 * measured and the caller keeps its structural reading.
 */
export function measureCoMovement(a: readonly ObservedOutcome[], b: readonly ObservedOutcome[], minPeriods = MIN_CO_MOVEMENT_PERIODS): CoMovement | null {
  const sa = weeklySeries(a);
  const sb = weeklySeries(b);
  if (sa.size === 0 || sb.size === 0) return null;
  const from = Math.max(Math.min(...sa.keys()), Math.min(...sb.keys()));
  const to = Math.max(Math.max(...sa.keys()), Math.max(...sb.keys()));
  const periods = to - from + 1;
  if (periods < Math.max(3, minPeriods)) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let w = from; w <= to; w++) {
    xs.push(sa.get(w) ?? 0);
    ys.push(sb.get(w) ?? 0);
  }
  const mx = xs.reduce((n, x) => n + x, 0) / periods;
  const my = ys.reduce((n, y) => n + y, 0) / periods;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < periods; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const se = 1 / Math.sqrt(Math.max(1, periods - 3));
  return { coefficient: r, periods, interval: { low: Math.tanh(z - Z90 * se), high: Math.tanh(z + Z90 * se) } };
}

/** A measured coefficient counts as co-movement only when its interval lies above zero. */
export function measuredTogether(m: CoMovement): boolean {
  return m.interval.low > 0;
}

/**
 * Each risk group's measured coefficient: the mean of the measured pairs whose
 * two streams both sit in it. A group with no measured pair is absent, and its
 * declared or default coefficient stands.
 */
export function measuredGroupCorrelations(groupOf: ReadonlyMap<string, string | null>, observed: readonly ObservedOutcome[]): Map<string, { coefficient: number; pairs: number }> {
  const byId = new Map<string, ObservedOutcome[]>();
  for (const o of observed) byId.set(o.opportunityId, [...(byId.get(o.opportunityId) ?? []), o]);
  const sums = new Map<string, { total: number; pairs: number }>();
  const ids = [...groupOf.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const g = groupOf.get(ids[i]!);
      if (!g || g !== groupOf.get(ids[j]!)) continue;
      const m = measureCoMovement(byId.get(ids[i]!) ?? [], byId.get(ids[j]!) ?? []);
      if (!m) continue;
      const cur = sums.get(g) ?? { total: 0, pairs: 0 };
      sums.set(g, { total: cur.total + m.coefficient, pairs: cur.pairs + 1 });
    }
  }
  return new Map([...sums].map(([g, { total, pairs }]) => [g, { coefficient: total / pairs, pairs }]));
}

/** Whether a correlation makes two streams fail together. */
export function correlatedTogether(c: Pick<StreamCorrelation, 'kind' | 'coefficient' | 'measured'>): boolean {
  if (c.kind === 'MEASURED_CO_MOVEMENT') return c.measured ? measuredTogether(c.measured) : c.coefficient > 0;
  return c.kind === 'SHARED_RISK_GROUP' && c.coefficient > 0;
}

function independenceOf(stream: Pick<PortfolioStream, 'correlations' | 'sharedConstraints'>, othersCount: number): { independent: boolean; independence: string } {
  const correlated = stream.correlations.filter(correlatedTogether);
  const binding = stream.sharedConstraints.filter((c) => c.binding);
  const independent = binding.length === 0 && correlated.length === 0;
  if (independent) {
    if (othersCount === 0) return { independent, independence: 'no other leading line to depend on' };
    const measured = stream.correlations.filter((c) => c.kind === 'MEASURED_CO_MOVEMENT');
    const unmeasured = stream.correlations.length - measured.length;
    const parts = [
      ...measured.map((c) => `measured with ${c.with} over ${c.measured!.periods} weeks: ${c.coefficient.toFixed(2)} (90% ${c.measured!.interval.low.toFixed(2)} to ${c.measured!.interval.high.toFixed(2)}), not shown to move together`),
      ...(unmeasured > 0 ? [`no shared factor is modelled with ${unmeasured === stream.correlations.length ? 'the leading combination' : 'the rest'} and nothing was measured (assumed)`] : []),
    ];
    return { independent, independence: `shares no binding constraint and no correlated risk with the leading combination: ${parts.join('; ')}` };
  }
  return {
    independent,
    independence: [
      ...correlated.map((c) =>
        c.kind === 'MEASURED_CO_MOVEMENT'
          ? `moves with ${c.with}: measured ${c.coefficient.toFixed(2)} over ${c.measured!.periods} weeks (90% ${c.measured!.interval.low.toFixed(2)} to ${c.measured!.interval.high.toFixed(2)})`
          : `moves with ${c.with} through ${c.riskGroup} (${c.coefficient.toFixed(2)}, ${c.source === 'GROUP_MEASUREMENT' ? 'carried from the group\'s measured pairs' : 'assumed'})`,
      ),
      ...binding.map((c) => `shares the ${c.constraint} with the leading combination`),
    ].join('; '),
  };
}

/**
 * The same reading with every pair the ledger can measure replaced by its
 * measured co-movement, every unmeasured pair in a measured risk group given
 * the group's measured mean, and independence re-derived from the result.
 * Pure. The plan applies it when it builds the streams; the PORT-05 reader
 * applies it again to the held reading with the ledger as it stands now.
 */
export function withMeasuredCoMovement(reading: StreamsReading, observed: readonly ObservedOutcome[]): StreamsReading {
  if (observed.length === 0) return reading;
  const byId = new Map<string, ObservedOutcome[]>();
  for (const o of observed) byId.set(o.opportunityId, [...(byId.get(o.opportunityId) ?? []), o]);
  const groupOf = new Map(reading.streams.map((s) => [s.opportunityId, s.riskGroup] as const));
  const groups = measuredGroupCorrelations(groupOf, observed);
  const cache = new Map<string, CoMovement | null>();
  const measure = (a: string, b: string): CoMovement | null => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!cache.has(key)) cache.set(key, measureCoMovement(byId.get(a) ?? [], byId.get(b) ?? []));
    return cache.get(key)!;
  };
  const resolve = (self: string, c: StreamCorrelation): StreamCorrelation => {
    const structural = c.structural ?? (c.kind === 'MEASURED_CO_MOVEMENT' ? undefined : { coefficient: c.coefficient, kind: c.kind, source: c.source });
    const m = measure(self, c.with);
    if (m) return { ...c, coefficient: m.coefficient, kind: 'MEASURED_CO_MOVEMENT', basis: 'ESTABLISHED', source: 'MEASURED', measured: m, ...(structural ? { structural } : {}) };
    const g = c.riskGroup ? groups.get(c.riskGroup) : undefined;
    if (structural?.kind === 'SHARED_RISK_GROUP' && g) {
      const { measured: _m, ...rest } = c;
      return { ...rest, kind: 'SHARED_RISK_GROUP', coefficient: Math.min(0.95, Math.max(0, g.coefficient)), basis: 'ASSUMED', source: 'GROUP_MEASUREMENT', structural };
    }
    return c;
  };
  const leadingCount = reading.streams.filter((s) => s.roles.includes('LEADING')).length;
  const streams = reading.streams.map((s) => {
    const correlations = s.correlations.map((c) => resolve(s.opportunityId, c));
    const others = s.roles.includes('LEADING') ? leadingCount - 1 : leadingCount;
    return { ...s, correlations, ...independenceOf({ correlations, sharedConstraints: s.sharedConstraints }, others) };
  });
  const correlations = reading.across.correlations.map((p) => {
    const c = resolve(p.a, { with: p.b, coefficient: p.coefficient, kind: p.kind, riskGroup: p.riskGroup ?? null, basis: p.basis, source: p.source ?? 'NONE', ...(p.measured ? { measured: p.measured } : {}), ...(p.structural ? { structural: p.structural } : {}) });
    return { a: p.a, b: p.b, coefficient: c.coefficient, kind: c.kind, basis: c.basis, riskGroup: c.riskGroup, source: c.source, ...(c.measured ? { measured: c.measured } : {}), ...(c.structural ? { structural: c.structural } : {}) };
  });
  return {
    streams,
    across: {
      ...reading.across,
      correlations,
      measuredPairs: correlations.filter((p) => p.kind === 'MEASURED_CO_MOVEMENT').length,
      independentStreams: streams.filter((s) => s.independent).length,
    },
  };
}

export interface SharedConstraint {
  /** capital, spend ceiling, or a resource the streams draw on (the shared outreach, a channel). */
  constraint: string;
  /** Shared with at least one other member of the leading combination. */
  sharedWithLeading: boolean;
  /** The leading combination with this stream would exceed it, or does already. */
  binding: boolean;
  detail: string;
  basis: FigureBasis;
}

export interface PortfolioStream {
  opportunityId: string;
  title: string;
  /** The primary role, by precedence LEADING, ALTERNATE, WORKING_OPERATION, CONTINGENCY, FUTURE_BET. */
  role: StreamRole;
  /** Every role that applies: a working operation may also lead. */
  roles: StreamRole[];
  reason: string;
  share: number | null;
  riskGroup: string | null;
  /** Best members whose failure this stream covers through a different risk group or resource (CONTINGENCY). */
  covers: string[];
  correlations: StreamCorrelation[];
  cashTiming: { settlementDays: StreamSpread; revenue: StreamSpread; settlesBeforeDeadline: boolean; basis: FigureBasis };
  deliveryObligations: { agreedDeals: number; expectedDeals: StreamSpread; basis: FigureBasis };
  workforce: { hoursPerDeal: number; hours: StreamSpread; fulfilledBy: string | null; basis: FigureBasis };
  qualityAssurance: { deliveriesToCheck: StreamSpread; checkedBy: 'BRAIN' | 'ACCEPTANCE_OF_PROVIDER' | 'UNSTATED'; basis: FigureBasis };
  outreach: { resource: string | null; share: number | null; perDay: { low: number; high: number }; contacted: StreamSpread; basis: FigureBasis } | null;
  crowding: { segment: string | null; sharedWith: string[]; basis: FigureBasis };
  sharedConstraints: SharedConstraint[];
  /** True only when it shares no binding constraint and no correlated risk group with the leading combination. */
  independent: boolean;
  independence: string;
}

export interface StreamsReading {
  streams: PortfolioStream[];
  across: {
    /** Pairwise, over the leading combination and its alternates. */
    correlations: Array<{ a: string; b: string; coefficient: number; kind: CorrelationKind; basis: FigureBasis; riskGroup?: string | null; source?: CorrelationSource; measured?: CoMovement; structural?: StreamCorrelation['structural'] }>;
    /** Pairs whose coefficient was read from the ledger rather than assumed. */
    measuredPairs?: number;
    /** Cash the leading combination has settled by the end of each week, against the deadline. Members are summed world by world, without the shared-risk factor, and a repeatable line's deals are paced uniformly, so it is ASSUMED whenever either applies. */
    cashCurve: Array<{ week: number; dayEnd: number; p10: number; p50: number; p90: number }>;
    cashCurveBasis: FigureBasis;
    deliveryObligations: { agreedDeals: number; expectedDeals: number; basis: FigureBasis };
    workforceHours: { p50: number; p90: number; basis: FigureBasis };
    qualityAssurance: { deliveriesToCheck: number; basis: FigureBasis };
    outreach: Array<{ resource: string; shareUsed: number; perDay: { low: number; high: number }; basis: FigureBasis }>;
    crowding: Array<{ segment: string; members: string[] }>;
    sharedConstraints: Array<{ constraint: string; limit: number | null; used: number; binding: boolean; basis: FigureBasis }>;
    independentStreams: number;
  };
}

export interface StreamsInput {
  openings: ModelledOpportunity[];
  demand: StreamsDemand[];
  best: StreamsCombination | null;
  alternatives: StreamsCombination[];
  /** Cash worlds of each leading member at its own share, by opportunity id. */
  memberWorlds: Map<string, StreamWorlds>;
  deadlineDays: number;
  startingCapital: number | null;
  spendCeiling: number | null;
  contactsPerDay: ModelInput;
  /** Correlation inside a named risk group; a group not named takes `defaultCorrelation` (the optimizer's own default). */
  riskCorrelation: Record<string, number>;
  defaultCorrelation: number;
  /** Buyer money each stream has actually taken, from the ledger: where it covers enough shared weeks, a pair's correlation is measured, not assumed. */
  observed?: readonly ObservedOutcome[];
}

const OUTREACH = 'outreach';
const SHARED_OUTREACH = 'shared-outreach';

function isEstablished(input: ModelInput | undefined): boolean {
  if (!input) return false;
  if (input.provenance !== 'EVIDENCE' && input.provenance !== 'HISTORICAL') return false;
  return input.value !== null || (input.distribution !== undefined && input.distribution.kind !== 'RANGE');
}

const basisOf = (ok: boolean): FigureBasis => (ok ? 'ESTABLISHED' : 'ASSUMED');

function pointOf(input: ModelInput): number {
  return input.value ?? input.inferred?.p50 ?? ((input.low ?? 0) + (input.high ?? input.low ?? 0)) / 2;
}

/** The risk group and resource an opening draws on, as `evaluateGoalPortfolio` declares them to the optimizer. */
function drawsOn(one: ModelledOpportunity): { riskGroup: string | null; resource: string | null } {
  if (one.channel) return { riskGroup: one.channel.riskGroup, resource: one.channel.resource };
  if (one.repeatable && one.agreedValue === 0) return { riskGroup: SHARED_OUTREACH, resource: OUTREACH };
  return { riskGroup: null, resource: null };
}

function quantiles(values: number[]): StreamSpread {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

const scale = (s: StreamSpread, k: number): StreamSpread => ({ p10: s.p10 * k, p50: s.p50 * k, p90: s.p90 * k });

/** Who buys, normalised: the payer a source named, else the channel that reaches them. Unknown is an answer (invariant 34). */
function segmentOf(one: ModelledOpportunity): string | null {
  const raw = one.opportunity.payer ?? one.opportunity.reachableChannel ?? null;
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return s.length > 0 ? s : null;
}

export function buildStreams(input: StreamsInput): StreamsReading {
  const byId = new Map(input.openings.map((one) => [one.opportunity.id, one]));
  const demandById = new Map(input.demand.map((d) => [d.opportunityId, d]));
  const leading = new Map((input.best?.members ?? []).map((m) => [m.opportunityId, m]));
  const alternateShare = new Map<string, number | null>();
  for (const combo of input.alternatives) for (const m of combo.members) if (!leading.has(m.opportunityId) && !alternateShare.has(m.opportunityId)) alternateShare.set(m.opportunityId, m.share);
  const perDay = { low: input.contactsPerDay.value ?? input.contactsPerDay.low ?? 0, high: input.contactsPerDay.value ?? input.contactsPerDay.high ?? 0 };
  const perDayEstablished = isEstablished(input.contactsPerDay);

  const corr = (g: string) => Math.min(0.95, Math.max(0, input.riskCorrelation[g] ?? input.defaultCorrelation));
  // The structural reading; `withMeasuredCoMovement` below replaces every pair the ledger measures.
  const pairCorrelation = (a: ModelledOpportunity, b: ModelledOpportunity): StreamCorrelation => {
    const ga = drawsOn(a).riskGroup;
    const gb = drawsOn(b).riskGroup;
    if (ga !== null && ga === gb) return { with: b.opportunity.id, coefficient: corr(ga), kind: 'SHARED_RISK_GROUP', riskGroup: ga, basis: 'ASSUMED', source: input.riskCorrelation[ga] !== undefined ? 'DECLARED' : 'DEFAULT' };
    return { with: b.opportunity.id, coefficient: 0, kind: 'NONE_KNOWN', riskGroup: null, basis: 'ASSUMED', source: 'NONE' };
  };

  // What the leading combination already uses of each shared constraint.
  const leadingOps = [...leading.keys()].map((id) => byId.get(id)).filter((x): x is ModelledOpportunity => Boolean(x));
  const leadingCapital = leadingOps.reduce((sum, one) => sum + (demandById.get(one.opportunity.id)?.capitalAtStart ?? 0), 0);
  const shareOf = (id: string): number | null => leading.get(id)?.share ?? alternateShare.get(id) ?? null;
  const spendOf = (id: string, share: number | null): number => {
    const d = demandById.get(id);
    return d ? d.spend.p90 * (share ?? 1) : 0;
  };
  const leadingSpend = leadingOps.reduce((sum, one) => sum + spendOf(one.opportunity.id, shareOf(one.opportunity.id)), 0);
  const resourceUse = new Map<string, number>();
  for (const one of leadingOps) {
    const r = drawsOn(one).resource;
    if (r) resourceUse.set(r, (resourceUse.get(r) ?? 0) + (r === OUTREACH ? (leading.get(one.opportunity.id)?.share ?? 0) : 1));
  }

  // Segments: openings selling to the same buyer population crowd each other.
  const segments = new Map<string, string[]>();
  for (const one of input.openings) {
    const s = segmentOf(one);
    if (s) segments.set(s, [...(segments.get(s) ?? []), one.opportunity.id]);
  }

  const streams: PortfolioStream[] = [];
  for (const one of input.openings) {
    const id = one.opportunity.id;
    const d = demandById.get(id);
    if (!d) continue;
    const { riskGroup, resource } = drawsOn(one);
    const isLeading = leading.has(id);
    const share = isLeading ? (leading.get(id)?.share ?? null) : alternateShare.has(id) ? (alternateShare.get(id) ?? null) : resource === OUTREACH ? 1 : null;
    const fraction = share ?? 1;
    const others = leadingOps.filter((o) => o.opportunity.id !== id);

    // Roles.
    const roles: StreamRole[] = [];
    if (isLeading) roles.push('LEADING');
    if (!isLeading && alternateShare.has(id)) roles.push('ALTERNATE');
    if (one.agreedValue > 0 || one.agreed) roles.push('WORKING_OPERATION');
    const capitalFits = input.startingCapital === null || d.capitalAtStart <= input.startingCapital + 1e-9;
    const covers = !isLeading && !d.refused && d.justified && capitalFits
      ? leadingOps.filter((o) => {
          const theirs = drawsOn(o);
          return riskGroup === null || theirs.riskGroup !== riskGroup || theirs.resource !== resource;
        }).map((o) => o.opportunity.id)
      : [];
    if (!isLeading && covers.length > 0) roles.push('CONTINGENCY');
    if (roles.length === 0 || (!isLeading && (d.refused || !d.justified))) if (!roles.includes('FUTURE_BET')) roles.push('FUTURE_BET');
    const role: StreamRole = (['LEADING', 'ALTERNATE', 'WORKING_OPERATION', 'CONTINGENCY', 'FUTURE_BET'] as const).find((r) => roles.includes(r))!;
    const reason =
      role === 'LEADING' ? 'a member of the combination most likely to reach the target'
      : role === 'ALTERNATE' ? 'a member of a feasible alternative combination'
      : role === 'WORKING_OPERATION' ? 'money a buyer has already agreed to'
      : role === 'CONTINGENCY' ? `fails through a different risk or resource than ${covers.join(', ')}`
      : d.refused ? `kept for later: ${d.refused}`
      : !d.justified ? `kept for later: ${d.unestablished.join(', ')} not established`
      : 'kept for later: covers no leading member\'s failure through a different risk';

    // Correlation with every leading member (and, for a leading member, the others).
    const correlations = others.map((o) => pairCorrelation(one, o));

    // Cash timing, obligations, workforce, QA.
    const settlementBasis = basisOf(isEstablished(one.daysToCash) && isEstablished(one.price));
    const dealsBasis = basisOf(d.justified);
    const expectedDeals = d.repeatable && one.agreedValue === 0 ? scale(d.deals, fraction) : d.deals;
    const hoursPerDeal = Math.max(0, pointOf(one.hours));
    const dealsWithAgreed = (x: number) => x + one.agreedDeals;
    const hours = { p10: dealsWithAgreed(expectedDeals.p10) * hoursPerDeal, p50: dealsWithAgreed(expectedDeals.p50) * hoursPerDeal, p90: dealsWithAgreed(expectedDeals.p90) * hoursPerDeal };
    const fulfilledBy = one.fulfilledBy?.value ?? one.opportunity.fulfillmentOwner ?? null;
    const checkedBy: PortfolioStream['qualityAssurance']['checkedBy'] = fulfilledBy === null ? 'UNSTATED' : /\bbrain\b/i.test(fulfilledBy) ? 'BRAIN' : 'ACCEPTANCE_OF_PROVIDER';
    const deliveries = { p10: dealsWithAgreed(expectedDeals.p10), p50: dealsWithAgreed(expectedDeals.p50), p90: dealsWithAgreed(expectedDeals.p90) };

    // Outreach.
    const channelPerDay = one.channel ? { low: one.channel.perDay.value ?? one.channel.perDay.low ?? 0, high: one.channel.perDay.value ?? one.channel.perDay.high ?? 0 } : perDay;
    const outreach = resource
      ? { resource, share, perDay: { low: channelPerDay.low * fraction, high: channelPerDay.high * fraction }, contacted: scale(d.contacted, fraction), basis: basisOf(one.channel ? isEstablished(one.channel.perDay) : perDayEstablished) }
      : null;

    // Crowding.
    const segment = segmentOf(one);
    const crowdedWith = segment ? (segments.get(segment) ?? []).filter((x) => x !== id) : [];

    // Shared constraints, against the leading combination without this stream.
    const sharedConstraints: SharedConstraint[] = [];
    const capitalWithout = isLeading ? leadingCapital - d.capitalAtStart : leadingCapital;
    if (input.startingCapital !== null) {
      const total = capitalWithout + d.capitalAtStart;
      sharedConstraints.push({
        constraint: 'capital',
        sharedWithLeading: others.length > 0 && d.capitalAtStart > 0,
        binding: others.length > 0 && d.capitalAtStart > 0 && total > input.startingCapital + 1e-9,
        detail: `${Math.round(total)} tied up at the start with the leading combination, against ${Math.round(input.startingCapital)}`,
        basis: basisOf(!d.unestablished.includes('money tied up')),
      });
    }
    if (input.spendCeiling !== null) {
      const own = spendOf(id, share);
      const total = (isLeading ? leadingSpend - own : leadingSpend) + own;
      sharedConstraints.push({
        constraint: 'spend ceiling',
        sharedWithLeading: others.length > 0 && own > 0,
        binding: others.length > 0 && own > 0 && total > input.spendCeiling + 1e-9,
        detail: `${Math.round(total)} spent at the 90th percentile with the leading combination, against ${Math.round(input.spendCeiling)}`,
        basis: basisOf(isEstablished(one.directCost) && d.justified),
      });
    }
    if (resource) {
      const othersUse = others.filter((o) => drawsOn(o).resource === resource);
      const used = othersUse.reduce((sum, o) => sum + (resource === OUTREACH ? (leading.get(o.opportunity.id)?.share ?? 0) : 1), 0);
      const mine = resource === OUTREACH ? fraction : 1;
      sharedConstraints.push({
        constraint: resource,
        sharedWithLeading: othersUse.length > 0,
        // Any share of one capacity another leading line also draws on is a constraint they compete for.
        binding: othersUse.length > 0,
        detail: othersUse.length > 0 ? `${(used + mine).toFixed(2)} of its capacity with ${othersUse.map((o) => o.opportunity.id).join(', ')}` : 'no leading line draws on it',
        basis: outreach?.basis ?? 'ASSUMED',
      });
    }
    const { independent, independence } = independenceOf({ correlations, sharedConstraints }, others.length);

    streams.push({
      opportunityId: id,
      title: d.title,
      role,
      roles,
      reason,
      share,
      riskGroup,
      covers: roles.includes('CONTINGENCY') ? covers : [],
      correlations,
      cashTiming: { settlementDays: d.days, revenue: d.repeatable && one.agreedValue === 0 ? scale(d.revenue, fraction) : d.revenue, settlesBeforeDeadline: d.days.p50 <= input.deadlineDays, basis: settlementBasis },
      deliveryObligations: { agreedDeals: one.agreedDeals, expectedDeals, basis: dealsBasis },
      workforce: { hoursPerDeal, hours, fulfilledBy, basis: basisOf(isEstablished(one.hours) && d.justified) },
      qualityAssurance: { deliveriesToCheck: deliveries, checkedBy, basis: basisOf(d.justified && checkedBy !== 'UNSTATED') },
      outreach,
      crowding: { segment, sharedWith: crowdedWith, basis: segment ? 'ESTABLISHED' : 'ASSUMED' },
      sharedConstraints,
      independent,
      independence,
    });
  }

  // Across the portfolio.
  const pairIds = [...leading.keys(), ...alternateShare.keys()];
  const pairs: StreamsReading['across']['correlations'] = [];
  for (let i = 0; i < pairIds.length; i++) {
    for (let j = i + 1; j < pairIds.length; j++) {
      const a = byId.get(pairIds[i]!);
      const b = byId.get(pairIds[j]!);
      if (!a || !b) continue;
      const c = pairCorrelation(a, b);
      pairs.push({ a: a.opportunity.id, b: b.opportunity.id, coefficient: c.coefficient, kind: c.kind, basis: c.basis, riskGroup: c.riskGroup, source: c.source });
    }
  }
  const weeks = Math.max(1, Math.ceil(input.deadlineDays / 7));
  const memberWorlds = [...leading.keys()].map((id) => input.memberWorlds.get(id)).filter((w): w is StreamWorlds => Boolean(w));
  const worldCount = memberWorlds.reduce((n, w) => Math.min(n, w.cash.length), memberWorlds.length > 0 ? Number.POSITIVE_INFINITY : 0);
  const cashCurve: StreamsReading['across']['cashCurve'] = [];
  for (let w = 1; w <= weeks; w++) {
    const dayEnd = Math.min(w * 7, input.deadlineDays);
    const settled: number[] = [];
    for (let i = 0; i < worldCount; i++) {
      let sum = 0;
      for (const m of memberWorlds) {
        const days = m.days[i] ?? Infinity;
        const cash = m.cash[i] ?? 0;
        if (!m.paced) {
          if (days <= dayEnd) sum += cash;
          continue;
        }
        // Deals closed uniformly over the days left to sell, each settling `days` later.
        const sellingDays = input.deadlineDays - days;
        if (sellingDays <= 0) continue;
        sum += cash * Math.min(1, Math.max(0, (dayEnd - days) / sellingDays));
      }
      settled.push(sum);
    }
    cashCurve.push({ week: w, dayEnd, ...quantiles(settled) });
  }
  const leadingStreams = streams.filter((s) => s.roles.includes('LEADING'));
  const allBasis = (pick: (s: PortfolioStream) => FigureBasis) => basisOf(leadingStreams.length > 0 && leadingStreams.every((s) => pick(s) === 'ESTABLISHED'));
  const outreachAcross: StreamsReading['across']['outreach'] = [];
  for (const [r, used] of resourceUse) {
    const sample = leadingStreams.find((s) => s.outreach?.resource === r);
    const base = r === OUTREACH ? perDay : (() => {
      const o = leadingOps.find((x) => x.channel?.resource === r)!.channel!.perDay;
      return { low: o.value ?? o.low ?? 0, high: o.value ?? o.high ?? 0 };
    })();
    outreachAcross.push({ resource: r, shareUsed: used, perDay: { low: base.low * Math.min(1, used), high: base.high * Math.min(1, used) }, basis: sample?.outreach?.basis ?? 'ASSUMED' });
  }
  const sharedAcross: StreamsReading['across']['sharedConstraints'] = [];
  if (input.startingCapital !== null) sharedAcross.push({ constraint: 'capital', limit: input.startingCapital, used: leadingCapital, binding: leadingCapital > input.startingCapital + 1e-9, basis: allBasis((s) => s.sharedConstraints.find((c) => c.constraint === 'capital')?.basis ?? 'ASSUMED') });
  if (input.spendCeiling !== null) sharedAcross.push({ constraint: 'spend ceiling', limit: input.spendCeiling, used: leadingSpend, binding: leadingSpend > input.spendCeiling + 1e-9, basis: allBasis((s) => s.sharedConstraints.find((c) => c.constraint === 'spend ceiling')?.basis ?? 'ASSUMED') });
  for (const [r, used] of resourceUse) sharedAcross.push({ constraint: r, limit: 1, used, binding: used >= 1 - 1e-9, basis: outreachAcross.find((o) => o.resource === r)?.basis ?? 'ASSUMED' });

  const reading: StreamsReading = {
    streams,
    across: {
      correlations: pairs,
      measuredPairs: 0,
      cashCurve,
      cashCurveBasis: basisOf(!memberWorlds.some((m) => m.paced) && leadingStreams.every((s) => s.cashTiming.basis === 'ESTABLISHED' && s.deliveryObligations.basis === 'ESTABLISHED') && !pairs.some((p) => p.kind === 'SHARED_RISK_GROUP' && leading.has(p.a) && leading.has(p.b))),
      deliveryObligations: { agreedDeals: leadingStreams.reduce((n, s) => n + s.deliveryObligations.agreedDeals, 0), expectedDeals: leadingStreams.reduce((n, s) => n + s.deliveryObligations.expectedDeals.p50, 0), basis: allBasis((s) => s.deliveryObligations.basis) },
      workforceHours: { p50: leadingStreams.reduce((n, s) => n + s.workforce.hours.p50, 0), p90: leadingStreams.reduce((n, s) => n + s.workforce.hours.p90, 0), basis: allBasis((s) => s.workforce.basis) },
      qualityAssurance: { deliveriesToCheck: leadingStreams.reduce((n, s) => n + s.qualityAssurance.deliveriesToCheck.p50, 0), basis: allBasis((s) => s.qualityAssurance.basis) },
      outreach: outreachAcross,
      crowding: [...segments].filter(([, members]) => members.length > 1).map(([segment, members]) => ({ segment, members })),
      sharedConstraints: sharedAcross,
      independentStreams: streams.filter((s) => s.independent).length,
    },
  };
  return input.observed && input.observed.length > 0 ? withMeasuredCoMovement(reading, input.observed) : reading;
}
