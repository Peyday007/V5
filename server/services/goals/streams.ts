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

export interface StreamCorrelation {
  with: string;
  coefficient: number;
  /** SHARED_RISK_GROUP: both fail through one factor; NONE_KNOWN: no shared factor is modelled, so independence is assumed. */
  kind: 'SHARED_RISK_GROUP' | 'NONE_KNOWN';
  riskGroup: string | null;
  basis: FigureBasis;
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
    correlations: Array<{ a: string; b: string; coefficient: number; kind: StreamCorrelation['kind']; basis: FigureBasis }>;
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
  const pairCorrelation = (a: ModelledOpportunity, b: ModelledOpportunity): StreamCorrelation => {
    const ga = drawsOn(a).riskGroup;
    const gb = drawsOn(b).riskGroup;
    if (ga !== null && ga === gb) return { with: b.opportunity.id, coefficient: corr(ga), kind: 'SHARED_RISK_GROUP', riskGroup: ga, basis: 'ASSUMED' };
    return { with: b.opportunity.id, coefficient: 0, kind: 'NONE_KNOWN', riskGroup: null, basis: 'ASSUMED' };
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
    const correlated = correlations.filter((c) => c.kind === 'SHARED_RISK_GROUP' && c.coefficient > 0);

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
    const binding = sharedConstraints.filter((c) => c.binding);
    const independent = binding.length === 0 && correlated.length === 0;
    const independence = independent
      ? others.length === 0 ? 'no other leading line to depend on' : 'shares no binding constraint and no correlated risk with the leading combination (no shared factor is modelled; assumed)'
      : [...correlated.map((c) => `moves with ${c.with} through ${c.riskGroup} (${c.coefficient}, assumed)`), ...binding.map((c) => `shares the ${c.constraint} with the leading combination`)].join('; ');

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
      pairs.push({ a: a.opportunity.id, b: b.opportunity.id, coefficient: c.coefficient, kind: c.kind, basis: c.basis });
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

  return {
    streams,
    across: {
      correlations: pairs,
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
}
