/**
 * GOAL-13-6 — compressed timelines, searched without inventing probabilities.
 *
 * A pure reading over what the plan already composes: the goal's target, the
 * transaction pathways `readPathways` built, and the quant portfolio's limits.
 * For 30, 60 and 90 days, the goal's own deadline and the shorter horizons the
 * goal's own figures make meaningful, it solves backward — with the same
 * `requiredStructures` the plan uses — for the deal economics and distribution
 * each horizon needs, confirms each pathway's settlement fits inside the
 * horizon, and compares the combinations of independent pathways that remain.
 *
 * What it never does:
 *  - assume a conventional annual growth period: a horizon beyond the goal's
 *    deadline is not extrapolated upward, and a shorter one only scales a
 *    pathway's window-bound contribution down by its own selling window;
 *  - state a probability nobody calibrated: reach is coverage of the gap at the
 *    pathways' own middles unless a calibrated source is supplied, and the
 *    horizon's status stays CANDIDATE;
 *  - merge a candidate into an accepted plan: ACCEPTED only when the plan's own
 *    acceptance (`judgeAcceptance`) accepts it for that horizon;
 *  - filter by industry, category or example — horizons and pathways are read
 *    from the goal's figures alone.
 */
import {
  MIN_SALES_CYCLE_DAYS,
  combine,
  requiredStructures,
  type PathwayCombination,
  type PathwayReading,
  type StructureRequirement,
  type TransactionPathway,
} from './pathways.ts';
import type { PlanAcceptance } from './plan.ts';
import type { GoalPortfolio } from './portfolio.ts';
import type { TargetReading } from './target.ts';

/** The horizons every goal is searched over, whatever its own deadline says. Not the only ones. */
export const STANDARD_HORIZONS = [30, 60, 90] as const;

export type HorizonOrigin = 'STANDARD' | 'DEADLINE' | 'DERIVED';

/** A probability for one horizon from a source that calibrated it — never from coverage. */
export interface CalibratedProbability {
  value: number;
  lowerBound: number;
  basis: NonNullable<PlanAcceptance['probability']>['basis'];
  sample: number;
  note: string;
}

export interface HorizonExclusion {
  opportunityId: string;
  title: string;
  /** SETTLES_TOO_LATE — its money arrives after the horizon; SETTLEMENT_UNCONFIRMED — nobody knows when it pays. */
  reason: 'SETTLES_TOO_LATE' | 'SETTLEMENT_UNCONFIRMED';
  daysToCash: number | null;
  sentence: string;
}

export interface HorizonEconomics {
  /** Backward-solved structures at this horizon, in the plan's own vocabulary. */
  structures: Pick<StructureRequirement, 'kind' | 'label' | 'deals' | 'netPerDeal' | 'paymentsPerBuyer' | 'prospects' | 'perDay' | 'sellingDays' | 'verdict' | 'reason'>[];
  /** The structure needing the fewest prospects a day that outreach could carry at all, or null. */
  easiest: { label: string; deals: number; netPerDeal: number; prospectsPerDay: { best: number; middle: number }; verdict: StructureRequirement['verdict'] } | null;
  /** The smallest net per deal outreach alone carries at the middle of the conversion bounds. */
  minimumNetForOutreach: number | null;
  /**
   * Concurrent independent wedges the gap needs at the eligible pathways' own
   * middles: the fewest distinct correlation groups whose strongest members
   * together reach the gap, or null when every group together falls short.
   */
  wedgesNeeded: number | null;
  /** Distinct correlation groups eligible at this horizon. */
  wedgesAvailable: number;
}

export interface HorizonReading {
  days: number;
  origins: HorizonOrigin[];
  /** Beyond the goal's own deadline: read for the search, never extrapolated upward. */
  beyondDeadline: boolean;
  remaining: number;
  currency: string;
  economics: HorizonEconomics;
  /** Pathways whose settlement fits inside the horizon. */
  eligible: string[];
  /** Pathways excluded from this horizon, each named with why. */
  excluded: HorizonExclusion[];
  combinations: {
    /** The strongest combination of eligible pathways (`combine`). */
    leading: PathwayCombination | null;
    /** One member per correlation group: alternatives that fail apart. */
    independent: PathwayCombination | null;
    /** What remains if the leading combination's largest group fails. */
    withoutLeadGroup: PathwayCombination | null;
  };
  reach: { value: number | null; basis: 'COVERAGE' | 'PROBABILITY' | null; note: string };
  probability: CalibratedProbability | null;
  status: 'CANDIDATE' | 'ACCEPTED';
  sentence: string;
}

export interface TimelineReading {
  remaining: number;
  currency: string;
  deadlineDays: number | null;
  horizons: HorizonReading[];
  /** The shortest horizon whose independent combination covers the gap at its middles, or null. Coverage, not a probability. */
  shortestCovered: number | null;
  note: string;
}

const lowOf = (p: TransactionPathway): number | null => {
  const f = p.daysToCash;
  if (f.status === 'UNKNOWN') return null;
  if (typeof f.value === 'number' && f.status === 'PROVEN') return f.value;
  return f.low ?? (typeof f.value === 'number' ? f.value : null);
};
const highOf = (p: TransactionPathway): number | null => {
  const f = p.daysToCash;
  if (f.status === 'UNKNOWN') return null;
  if (typeof f.value === 'number' && f.status === 'PROVEN') return f.value;
  return f.high ?? (typeof f.value === 'number' ? f.value : null);
};

/**
 * Every horizon worth reading: 30/60/90, the goal's own deadline, half of it,
 * and the shortest horizon at which any pathway's money could arrive. Positive
 * whole days, deduplicated, ascending. Pure.
 */
export function timelineHorizons(input: { deadlineDays: number | null; pathways: Pick<TransactionPathway, 'daysToCash'>[]; extra?: number[] }): { days: number; origins: HorizonOrigin[] }[] {
  const out = new Map<number, Set<HorizonOrigin>>();
  const add = (d: number, o: HorizonOrigin) => {
    if (!Number.isFinite(d)) return;
    const day = Math.ceil(d);
    if (day < 1) return;
    (out.get(day) ?? out.set(day, new Set()).get(day)!).add(o);
  };
  for (const d of STANDARD_HORIZONS) add(d, 'STANDARD');
  for (const d of input.extra ?? []) add(d, 'DERIVED');
  if (input.deadlineDays !== null && input.deadlineDays > 0) {
    add(input.deadlineDays, 'DEADLINE');
    if (input.deadlineDays >= 2 * (MIN_SALES_CYCLE_DAYS + 1)) add(input.deadlineDays / 2, 'DERIVED');
  }
  const settles = input.pathways.map((p) => lowOf(p as TransactionPathway)).filter((d): d is number => d !== null && d >= 0);
  if (settles.length > 0) add(Math.min(...settles) + MIN_SALES_CYCLE_DAYS + 1, 'DERIVED');
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([days, origins]) => ({ days, origins: [...origins] }));
}

/**
 * A pathway as it stands at a shorter horizon. Its contribution was read over
 * the goal's own window; a shorter window sells over fewer days, so a repeating
 * pathway's contribution scales down by the ratio of selling windows. A longer
 * one is never scaled up — that would be a growth assumption nobody measured.
 */
function atHorizon(p: TransactionPathway, days: number, deadlineDays: number): TransactionPathway {
  if (days >= deadlineDays) return p;
  const settle = highOf(p) ?? 0;
  const full = Math.max(1, deadlineDays - MIN_SALES_CYCLE_DAYS - settle);
  const part = Math.max(0, days - MIN_SALES_CYCLE_DAYS - settle);
  const repeats = p.frequency.value === 'repeats' || (typeof p.volume.high === 'number' && p.volume.high > 1);
  const ratio = repeats ? Math.min(1, part / full) : part > 0 ? 1 : 0;
  if (ratio >= 1) return p;
  const scale = (x: { p10: number; p50: number; p90: number }) => ({ p10: x.p10 * ratio, p50: x.p50 * ratio, p90: x.p90 * ratio });
  return { ...p, contribution: scale(p.contribution), gross: scale(p.gross) };
}

/** One member per correlation group — the strongest by middle contribution — so the combination's members fail apart. */
function independentOf(pathways: TransactionPathway[]): TransactionPathway[] {
  const best = new Map<string, TransactionPathway>();
  for (const p of pathways) {
    const held = best.get(p.correlationGroup);
    if (!held || p.contribution.p50 > held.contribution.p50) best.set(p.correlationGroup, p);
  }
  return [...best.values()];
}

function wedgesFor(pathways: TransactionPathway[], remaining: number): number | null {
  if (remaining <= 0) return 0;
  const sorted = independentOf(pathways).map((p) => p.contribution.p50).filter((x) => x > 0).sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    sum += sorted[i]!;
    if (sum >= remaining) return i + 1;
  }
  return null;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * The compressed-timeline reading. Pure.
 *
 * `acceptance` is the plan's own judgment for the goal's deadline;
 * `acceptanceByHorizon` carries a judgment the plan made for another horizon.
 * `calibrated` carries a probability a calibrated source stated for a horizon.
 * Nothing else may make a horizon ACCEPTED or give it a probability.
 */
export function readTimelines(input: {
  target: Pick<TargetReading, 'remainingCents' | 'daysLeft' | 'currency' | 'capitalCeilingCents' | 'capitalBeforeProofCents'>;
  pathways: Pick<PathwayReading, 'pathways'> | TransactionPathway[];
  portfolio: Pick<GoalPortfolio, 'limits'> | null;
  acceptance?: PlanAcceptance | null;
  acceptanceByHorizon?: ReadonlyMap<number, PlanAcceptance>;
  calibrated?: ReadonlyMap<number, CalibratedProbability>;
  extraHorizons?: number[];
}): TimelineReading {
  const pathways = Array.isArray(input.pathways) ? input.pathways : input.pathways.pathways;
  const remaining = Math.max(0, input.target.remainingCents / 100);
  const currency = input.target.currency;
  const deadlineDays = input.target.daysLeft === null ? null : Math.max(0, input.target.daysLeft);
  const contacts = input.portfolio?.limits.contactsPerDay;
  const outreach = { low: contacts?.low ?? 10, high: contacts?.value ?? contacts?.high ?? 60, stated: contacts?.value !== null && contacts?.value !== undefined };
  const perArrangement = input.portfolio?.limits.perArrangement ?? (input.target.capitalBeforeProofCents === null ? null : input.target.capitalBeforeProofCents / 100);
  const ceiling = input.portfolio?.limits.spendCeiling ?? (input.target.capitalCeilingCents === null ? null : input.target.capitalCeilingCents / 100);

  const horizons: HorizonReading[] = [];
  for (const h of timelineHorizons({ deadlineDays, pathways, extra: input.extraHorizons })) {
    const days = h.days;
    const window = deadlineDays !== null && deadlineDays > 0 ? deadlineDays : days;
    const beyondDeadline = deadlineDays !== null && days > deadlineDays;
    const s = requiredStructures({ remaining, daysLeft: days, currency, perArrangement, spendCeiling: ceiling, outreachPerDay: outreach });
    const latest = days - MIN_SALES_CYCLE_DAYS;
    const eligible: TransactionPathway[] = [];
    const excluded: HorizonExclusion[] = [];
    for (const p of pathways) {
      const settle = highOf(p);
      if (settle === null) {
        excluded.push({ opportunityId: p.opportunityId, title: p.title, reason: 'SETTLEMENT_UNCONFIRMED', daysToCash: null, sentence: `"${p.title.slice(0, 80)}" is not counted at ${days} days: when its money arrives is not established` });
      } else if (settle > latest) {
        excluded.push({ opportunityId: p.opportunityId, title: p.title, reason: 'SETTLES_TOO_LATE', daysToCash: settle, sentence: `"${p.title.slice(0, 80)}" is not counted at ${days} days: its money can take ${settle} days after a sale that itself takes ${MIN_SALES_CYCLE_DAYS}` });
      } else {
        eligible.push(atHorizon(p, days, window));
      }
    }
    const comboInput = { remaining, capitalCeiling: ceiling };
    const leading = combine(eligible, comboInput);
    const independent = combine(independentOf(eligible), comboInput);
    const lead = leading ? eligible.find((p) => p.opportunityId === leading.members[0]) : undefined;
    const withoutLeadGroup = lead ? combine(eligible, { ...comboInput, exclude: new Set([lead.correlationGroup]) }) : null;
    const carriable = s.structures.filter((one) => one.verdict !== 'IMPOSSIBLE' && Number.isFinite(one.perDay.middle)).sort((a, b) => a.perDay.middle - b.perDay.middle);
    const easiest = carriable[0] ?? null;

    // Acceptance is the plan's own, for this horizon, and covers only what is eligible here.
    const judged = input.acceptanceByHorizon?.get(days) ?? (deadlineDays !== null && days === deadlineDays ? input.acceptance ?? null : null);
    const eligibleIds = new Set(eligible.map((p) => p.opportunityId));
    const acceptedHere = judged?.status === 'ACCEPTED' && judged.accepted !== null && judged.accepted.opportunityIds.every((id) => eligibleIds.has(id));
    const calibrated = input.calibrated?.get(days) ?? (acceptedHere && judged?.probability ? { ...judged.probability } : null);
    const coverage = independent?.coverage ?? leading?.coverage ?? null;
    const reach: HorizonReading['reach'] = calibrated
      ? { value: calibrated.value, basis: 'PROBABILITY', note: `calibrated: ${calibrated.note}` }
      : coverage === null
        ? { value: null, basis: null, note: 'no eligible pathway settles inside this horizon' }
        : { value: Math.min(1, coverage), basis: 'COVERAGE', note: 'share of the gap the combination\'s middles reach — coverage of assumed inputs, not a probability' };
    const status: HorizonReading['status'] = acceptedHere ? 'ACCEPTED' : 'CANDIDATE';
    const econ = easiest
      ? `${easiest.deals} deal${easiest.deals === 1 ? '' : 's'} netting ${Math.round(easiest.netPerDeal)} ${currency} each, ${Math.round(easiest.perDay.middle * 10) / 10} prospects a day at middling conversion`
      : 'no transaction structure can settle inside it';
    const sentence =
      `${days} days${beyondDeadline ? ' (beyond the deadline, not extrapolated)' : ''}: ${econ}; ` +
      `${eligible.length} pathway${eligible.length === 1 ? '' : 's'} settle${eligible.length === 1 ? 's' : ''} in time, ${excluded.length} excluded; ` +
      (reach.value === null ? 'nothing reaches the gap' : reach.basis === 'PROBABILITY' ? `${pct(reach.value)} calibrated probability` : `covers ${pct(reach.value)} of the gap (coverage, not a probability)`) +
      `. ${status === 'ACCEPTED' ? 'ACCEPTED by the plan\'s own acceptance.' : 'CANDIDATE — not accepted.'}`;

    horizons.push({
      days,
      origins: h.origins,
      beyondDeadline,
      remaining,
      currency,
      economics: {
        structures: s.structures.map(({ kind, label, deals, netPerDeal, paymentsPerBuyer, prospects, perDay, sellingDays, verdict, reason }) => ({ kind, label, deals, netPerDeal, paymentsPerBuyer, prospects, perDay, sellingDays, verdict, reason })),
        easiest: easiest ? { label: easiest.label, deals: easiest.deals, netPerDeal: easiest.netPerDeal, prospectsPerDay: easiest.perDay, verdict: easiest.verdict } : null,
        minimumNetForOutreach: s.minimumNetForOutreach,
        wedgesNeeded: wedgesFor(eligible, remaining),
        wedgesAvailable: new Set(eligible.map((p) => p.correlationGroup)).size,
      },
      eligible: eligible.map((p) => p.opportunityId),
      excluded,
      combinations: { leading, independent, withoutLeadGroup },
      reach,
      probability: calibrated,
      status,
      sentence,
    });
  }
  const covered = horizons.find((h) => (h.combinations.independent?.coverage ?? 0) >= 1);
  return {
    remaining,
    currency,
    deadlineDays,
    horizons,
    shortestCovered: covered?.days ?? null,
    note: 'A search over compressed timelines, not evidence that any of them will happen: reach is coverage unless a calibrated source states a probability, and a horizon is ACCEPTED only by the plan\'s own acceptance.',
  };
}
