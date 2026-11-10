/**
 * The reconstruction loop (§99): when a goal's plan falls short of its
 * required probability, find out why, and build substantially different plans
 * instead of re-reading the same one.
 *
 * Production, 2026-11-09 (Goals plan 42692716368): the $10K plan read 2.6%
 * coverage and Brain's only response was "find more openings". Nothing asked
 * which assumption held the plan down — fixed sending capacity, cold email as
 * the only way in, unit prices as listed, cash as slow as listed — and nothing
 * weighed spending the $3,000 the owner had set aside on what was binding.
 *
 * The loop is pure and reuses the one engine every plan already uses
 * (`evaluateGoalPortfolio`, over the same openings, limits and correlation):
 *
 *   1. Diagnose. Move each kind of input to the favourable end of what is
 *      known about it, one at a time, and measure what the plan gains. The
 *      factor that gains most is binding; if moving every factor at once
 *      still cannot reach the requirement, the limitation is structural — the
 *      openings, channel or model must change, not the estimates.
 *   2. Challenge. Each implicit assumption of the plan is named with its
 *      evidence status, and the dimension that tests it.
 *   3. Construct. Generic operators change one dimension each: buy sending
 *      capacity, buy inbound demand, sell through a marketplace or partner,
 *      reshape the transaction (bundle, retainer, implementation fee), ask for
 *      a deposit. Operators come from the cost evidence (`acquisitionLevers.ts`)
 *      and the plan's own openings — never from a list of businesses.
 *   4. Evaluate and combine. Every variant goes through the same engine.
 *      Variants that improve the plan materially are combined greedily, across
 *      dimensions, while the combination still improves materially and still
 *      fits the money limits. Each combination is evaluated once.
 *   5. Conclude. The strongest plan, what binds it still, what is measured,
 *      what is assumed, and whether its reach is a probability or coverage.
 *      What the world must supply for the next step becomes the search brief
 *      the goal's next discovery round is asked (§89).
 *
 * The loop stops when no change improves the plan materially, not after a
 * fixed number of rounds: the operators are finite and each combination is
 * evaluated once. It never relabels coverage as probability, and an assumed
 * input stays assumed however good the number it produces.
 */
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';
import { evaluateGoalPortfolio, type GoalPortfolio } from './portfolio.ts';
import { ACQUISITION_LEVERS, DAYS_TO_FIRST_PROOF, PARTNER_TERMS, budgetsAllowed, purchaseCapacity, buyInbound, dailyVolumePlan, type AcquisitionLever, type VolumePlan } from './acquisitionLevers.ts';
import { MATERIAL_SHARE, SHAPE_MULTIPLES } from './pathways.ts';

/** A change smaller than this, in reach and in median settled cash, is not an improvement. */
export const MATERIAL_REACH = 0.02;
export const MATERIAL_P50 = 0.1;
/**
 * Worlds per screened variant; the strongest is read again at the plan's own
 * count. An evaluation's cost grows with worlds × openings, so screening holds
 * that product near SCREEN_WORK: a plan of a dozen openings screens at about
 * 600 worlds, one of forty at about 200 (never fewer than SCREEN_MIN_WORLDS).
 */
export const SCREEN_WORLDS = 600;
export const SCREEN_WORK = 7_200;
export const SCREEN_MIN_WORLDS = 150;

export type Dimension = 'EVIDENCE' | 'CAPACITY' | 'ACQUISITION' | 'PARTNER' | 'TRANSACTION' | 'CASH_TIMING' | 'CAPITAL' | 'MARKET';
export type Basis = 'MEASURED' | 'ESTIMATE' | 'ASSUMPTION';

export interface StrategyChange {
  dimension: Dimension;
  label: string;
  detail: string;
  /** Money it commits before any opening pays (major units). */
  cost: number;
  basis: Basis;
  /** The day it takes effect: the order in which a reconstructed plan is executed. */
  startDay?: { low: number; high: number };
}

export interface VariantReading {
  key: string;
  changes: StrategyChange[];
  reach: number;
  settledP10: number;
  settledP50: number;
  settledP90: number;
  basis: 'PROBABILITY' | 'COVERAGE';
  committed: number;
  feasible: boolean;
  why: string | null;
  members: string[];
}

export type Factor = 'VOLUME' | 'REPLY' | 'CLOSE' | 'PRICE' | 'CASH_TIMING' | 'MARKET_SIZE' | 'CAPITAL';

export interface FactorTest {
  factor: Factor;
  /** What was moved, in words. */
  moved: string;
  reach: number;
  settledP50: number;
  liftReach: number;
  liftP50: number;
}

export interface AssumptionChallenge {
  assumption: string;
  status: Basis | 'UNTESTED';
  testedBy: Dimension;
  finding: string;
}

export interface Reconstruction {
  required: number;
  baseline: VariantReading;
  diagnosis: FactorTest[];
  /** Every factor at its favourable end at once: the most the openings held can do. */
  headroom: { reach: number; settledP50: number };
  structural: boolean;
  challenges: AssumptionChallenge[];
  /** Every variant evaluated, in the order it was evaluated, round by round. */
  rounds: Array<{ round: number; tried: VariantReading[]; kept: string | null }>;
  best: VariantReading;
  /** The strongest plan if the new implementation performs no better than the measured record (§99 as-is floor). */
  floor: VariantReading | null;
  /** The reply rate every outreach opening must reach for the strongest plan to meet the requirement; null if none does. */
  requiredReply: number | null;
  /** The question the user asked of capacity: what a daily volume would cost and whether it could run. */
  volumePlans: VolumePlan[];
  /** What still binds the strongest plan, and what would have to be true to reach the requirement. */
  limitation: string | null;
  /** Separates what is measured from what is assumed, and says what the reach is. */
  confidence: { basis: 'PROBABILITY' | 'COVERAGE'; measured: string[]; assumed: string[]; statement: string };
  /** What the next discovery round is asked for, from the binding constraint. */
  searchBrief: string;
  evaluations: number;
}

export interface ReconstructionInput {
  openings: ModelledOpportunity[];
  portfolio: Omit<Parameters<typeof evaluateGoalPortfolio>[0], 'openings'>;
  baseline: GoalPortfolio;
  required: number;
  levers?: readonly AcquisitionLever[];
  /** Daily volumes to cost explicitly (the owner asked about 10,000 a day). */
  volumeQuestions?: number[];
  worlds?: number;
}

/** A strategy state the operators transform. */
interface State {
  openings: ModelledOpportunity[];
  contactsPerDay?: ModelInput;
  committed: number;
  changes: StrategyChange[];
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function scale(input: ModelInput, k: number, cap = Infinity): ModelInput {
  const f = (x: number | null) => (x === null ? null : Math.min(cap, x * k));
  return { ...input, value: f(input.value), low: f(input.low), high: f(input.high), distribution: undefined, inferred: undefined };
}
function favourable(input: ModelInput, dir: 'HIGH' | 'LOW', k: number, cap = Infinity): ModelInput {
  // The favourable end of what is known; a fixed figure is multiplied, an assumption at most.
  const top = dir === 'HIGH' ? (input.high ?? input.inferred?.p90 ?? input.value) : (input.low ?? input.inferred?.p10 ?? input.value);
  if (top === null || top === undefined) return input;
  const v = input.value !== null && input.value === top ? (dir === 'HIGH' ? Math.min(cap, top * k) : top / k) : top;
  return { ...input, value: v, low: v, high: v, distribution: undefined, inferred: undefined };
}

function sellsThroughOutreach(one: ModelledOpportunity): boolean {
  return one.repeatable && one.agreedValue === 0 && !one.channel;
}

function knownMid(input: ModelInput): number | null {
  if (input.value !== null) return input.value;
  if (input.inferred) return input.inferred.p50;
  if (input.low !== null && input.high !== null) return (input.low + input.high) / 2;
  return input.low ?? input.high ?? null;
}

/**
 * The openings a reconstruction can move: every member of a combination the
 * engine ranked, and every repeatable opening it did not refuse. A one-off the
 * engine left out of every combination cannot be moved by capacity, reply rate,
 * channel or financing, so re-evaluating it on every variant is cost without
 * information (production test, 2026-11-09: 40 one-offs took a plan read from 5 s to 23 s).
 */
export function movableOpenings(openings: ModelledOpportunity[], baseline: GoalPortfolio): ModelledOpportunity[] {
  const ranked = new Set([...(baseline.best?.members ?? []), ...baseline.alternatives.flatMap((a) => a.members)].map((m) => m.opportunityId));
  const refused = new Set(baseline.demand.filter((d) => d.refused).map((d) => d.opportunityId));
  return openings.filter((o) => ranked.has(o.opportunity.id) || (o.repeatable && o.agreedValue === 0 && !refused.has(o.opportunity.id)));
}

export async function reconstructPlan(input: ReconstructionInput): Promise<Reconstruction> {
  input = { ...input, openings: movableOpenings(input.openings, input.baseline) };
  const levers = input.levers ?? ACQUISITION_LEVERS;
  const worlds = input.worlds ?? Math.max(SCREEN_MIN_WORLDS, Math.min(SCREEN_WORLDS, Math.round(SCREEN_WORK / Math.max(1, input.openings.length))));
  const seen = new Map<string, VariantReading>();
  let evaluations = 0;
  const limits = input.portfolio;
  const daysLeft = limits.daysLeft;

  const evaluate = async (state: State, w = worlds, forceMeasured = false, tag = ''): Promise<VariantReading> => {
    const key = (state.changes.map((c) => `${c.dimension}:${c.label}`).sort().join(' + ') || 'as planned') + tag;
    const cached = seen.get(key);
    if (cached && w === worlds) return cached;
    // Each evaluation is a few hundred milliseconds of CPU: let the server breathe between them (§63).
    await new Promise<void>((resolve) => setImmediate(resolve));
    const allowed = budgetsAllowed(limits);
    const fits = state.committed <= allowed.ceiling + 1e-9;
    let reading: VariantReading;
    if (!fits) {
      reading = { key, changes: state.changes, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, basis: 'COVERAGE', committed: state.committed, feasible: false, why: `commits ${money(state.committed)}, more than the ${money(allowed.ceiling)} the goal allows in all`, members: [] };
    } else {
      evaluations++;
      const p = evaluateGoalPortfolio({
        ...limits,
        openings: state.openings,
        ...(state.contactsPerDay ? { contactsPerDay: state.contactsPerDay } : {}),
        committed: { capital: Math.min(state.committed, allowed.beforeProof), spend: state.committed },
        ...(forceMeasured ? { forceMeasured: true } : {}),
        ...(state.committed < 0 ? { capitalCeiling: (limits.capitalCeiling ?? 0) * 2, perWeek: (limits.perWeek ?? 0) * 2, beforeProof: (limits.beforeProof ?? 0) * 2, committed: null } : {}),
        worlds: w,
      });
      const b = p.best;
      reading = {
        key,
        changes: state.changes,
        reach: b?.reach ?? 0,
        settledP10: b?.settledP10 ?? 0,
        settledP50: b?.settledP50 ?? 0,
        settledP90: b?.settledP90 ?? 0,
        basis: p.basis,
        committed: state.committed,
        feasible: !!b,
        why: b ? null : 'no combination runs inside the limits',
        members: b?.members.map((m) => m.title.slice(0, 50)) ?? [],
      };
    }
    if (w === worlds) seen.set(key, reading);
    return reading;
  };

  const base: State = { openings: input.openings, committed: 0, changes: [] };
  const baseline = await evaluate(base);

  // 1. Diagnose: one factor at a time to its favourable end.
  const outreachOpenings = input.openings.filter(sellsThroughOutreach);
  const factorStates: Array<{ factor: Factor; moved: string; state: State }> = [];
  const allOpen = (f: (o: ModelledOpportunity) => ModelledOpportunity): ModelledOpportunity[] => input.openings.map((o) => (o.agreedValue > 0 ? o : f(o)));
  factorStates.push({ factor: 'VOLUME', moved: 'outreach a day ×3', state: { ...base, contactsPerDay: scale(currentContacts(limits, input.baseline), 3) } });
  factorStates.push({ factor: 'REPLY', moved: 'reply rate at the top of its range (×3 if fixed)', state: { ...base, openings: allOpen((o) => (sellsThroughOutreach(o) ? { ...o, respond: favourable(o.respond, 'HIGH', 3, 1) } : o)) } });
  factorStates.push({ factor: 'CLOSE', moved: 'close rate at the top of its range (×2 if fixed)', state: { ...base, openings: allOpen((o) => ({ ...o, close: favourable(o.close, 'HIGH', 2, 1) })) } });
  factorStates.push({ factor: 'PRICE', moved: 'revenue per deal ×2', state: { ...base, openings: allOpen((o) => ({ ...o, price: scale(o.price, 2) })) } });
  factorStates.push({ factor: 'CASH_TIMING', moved: 'days to cash at the bottom of its range (÷2 if fixed)', state: { ...base, openings: allOpen((o) => ({ ...o, daysToCash: favourable(o.daysToCash, 'LOW', 2) })) } });
  factorStates.push({ factor: 'CAPITAL', moved: 'money limits ×2 (starting capital and spending ceiling)', state: { ...base, committed: -Math.max(allowedFor(limits).ceiling, 0) } });
  factorStates.push({ factor: 'MARKET_SIZE', moved: 'deals the market can take ×3', state: { ...base, openings: allOpen((o) => ({ ...o, volume: scale(o.volume, 3) })) } });
  const diagnosis: FactorTest[] = [];
  for (const { factor, moved, state } of factorStates) {
    const r = await evaluate({ ...state, changes: [{ dimension: 'EVIDENCE', label: `test:${factor}`, detail: moved, cost: 0, basis: 'ASSUMPTION' }] });
    diagnosis.push({ factor, moved, reach: r.reach, settledP50: r.settledP50, liftReach: r.reach - baseline.reach, liftP50: r.settledP50 - baseline.settledP50 });
  }
  diagnosis.sort((a, b) => b.liftReach - a.liftReach || b.liftP50 - a.liftP50);
  const all: State = {
    ...base,
    contactsPerDay: scale(currentContacts(limits, input.baseline), 3),
    openings: allOpen((o) => ({
      ...o,
      respond: sellsThroughOutreach(o) ? favourable(o.respond, 'HIGH', 3, 1) : o.respond,
      close: favourable(o.close, 'HIGH', 2, 1),
      price: scale(o.price, 2),
      daysToCash: favourable(o.daysToCash, 'LOW', 2),
      volume: scale(o.volume, 3),
    })),
    changes: [{ dimension: 'EVIDENCE', label: 'test:ALL', detail: 'every factor at its favourable end at once', cost: 0, basis: 'ASSUMPTION' }],
  };
  const headroomReading = await evaluate(all);
  const headroom = { reach: headroomReading.reach, settledP50: headroomReading.settledP50 };
  const structural = headroom.reach < input.required;

  // 3. Construct: generic operators over the plan's own openings and the cost evidence.
  const operators: Array<{ dimension: Dimension; apply: (s: State) => State | null }> = [];
  const allowed = budgetsAllowed(limits);
  const budgets = [...new Set([allowed.beforeProof, allowed.perWeek, allowed.ceiling].filter((b) => b > 0))];
  for (const lever of levers.filter((l) => l.kind === 'SENDING_CAPACITY')) {
    for (const budget of budgets) {
      operators.push({
        dimension: 'CAPACITY',
        apply: (s) => {
          if (outreachOpenings.length === 0) return null;
          const buy = purchaseCapacity(lever, budget - s.committed, daysLeft, budget > allowed.beforeProof);
          if (!buy || buy.addedPerDay.high <= 0) return null;
          const now = s.contactsPerDay ?? currentContacts(limits, input.baseline);
          const contacts: ModelInput = {
            ...now,
            value: null,
            low: (now.low ?? now.value ?? 0) + buy.effectivePerDay.low,
            high: (now.high ?? now.value ?? 0) + buy.effectivePerDay.high,
            provenance: 'UNKNOWN',
            distribution: undefined,
            inferred: undefined,
            note: `${now.note}; plus ${buy.sentence}`,
          };
          return {
            ...s,
            contactsPerDay: contacts,
            committed: s.committed + buy.cost,
            changes: [...s.changes, { dimension: 'CAPACITY', label: `${lever.key}@${Math.round(budget)}`, detail: buy.sentence, cost: buy.cost, basis: budget > allowed.beforeProof ? 'ASSUMPTION' : 'ESTIMATE', startDay: buy.startDay }],
          };
        },
      });
    }
  }
  const sellable = input.openings.filter((o) => sellsThroughOutreach(o) && knownMid(o.price) !== null && (knownMid(o.price) ?? 0) > 0);
  for (const lever of levers.filter((l) => l.kind === 'PAID_INBOUND' || l.kind === 'MARKETPLACE')) {
    for (const budget of budgets) {
      operators.push({
        dimension: 'ACQUISITION',
        apply: (s) => {
          // The opening the inbound channel sells: the one that settles most per interested buyer.
          const target = [...sellable].sort((a, b) => valuePerInterested(b) - valuePerInterested(a))[0];
          if (!target) return null;
          const buy = buyInbound(lever, budget - s.committed, daysLeft, budget > allowed.beforeProof);
          if (!buy) return null;
          const clone: ModelledOpportunity = {
            ...target,
            index: 900 + s.openings.length,
            opportunity: { ...target.opportunity, id: `${target.opportunity.id}~${lever.key}`, title: `${target.opportunity.title.slice(0, 50)} via ${lever.label}` },
            respond: { value: null, low: buy.qualified.low, high: buy.qualified.high, provenance: 'UNKNOWN', source: { kind: 'OTHER', ref: `lever:${lever.key}` }, note: `share of ${lever.label} leads who are interested buyers` },
            channel: { label: `${lever.label} leads`, perDay: { value: null, low: buy.leadsPerDay.low, high: buy.leadsPerDay.high, provenance: 'UNKNOWN', source: { kind: 'OTHER', ref: `lever:${lever.key}` }, note: buy.sentence }, resource: `channel:${lever.key}`, riskGroup: `channel:${lever.key}` },
          };
          return {
            ...s,
            openings: [...s.openings, clone],
            committed: s.committed + buy.cost,
            changes: [...s.changes, { dimension: 'ACQUISITION', label: `${lever.key}@${Math.round(budget)}`, detail: `${buy.sentence}, selling ${target.opportunity.title.slice(0, 50)}`, cost: buy.cost, basis: budget > allowed.beforeProof ? 'ASSUMPTION' : 'ESTIMATE', startDay: { low: lever.setupDays.low + (budget > allowed.beforeProof ? DAYS_TO_FIRST_PROOF.low : 0), high: lever.setupDays.high + (budget > allowed.beforeProof ? DAYS_TO_FIRST_PROOF.high : 0) } }],
          };
        },
      });
    }
  }
  // Suppliers and partners: sell through someone who already holds the buyers, for a commission.
  operators.push({
    dimension: 'PARTNER',
    apply: (s) => {
      const target = [...sellable].sort((a, b) => valuePerInterested(b) - valuePerInterested(a))[0];
      if (!target) return null;
      const keep = 1 - (PARTNER_TERMS.commission.low + PARTNER_TERMS.commission.high) / 2;
      const clone: ModelledOpportunity = {
        ...target,
        index: 950 + s.openings.length,
        opportunity: { ...target.opportunity, id: `${target.opportunity.id}~partner`, title: `${target.opportunity.title.slice(0, 50)} via a referral partner` },
        price: { ...scale(target.price, keep), note: `after a ${Math.round(PARTNER_TERMS.commission.low * 100)}–${Math.round(PARTNER_TERMS.commission.high * 100)}% partner commission` },
        // A referred buyer has already said they are interested; whether they buy is the opening's own close rate.
        respond: { value: 1, low: 1, high: 1, provenance: 'ASSUMPTION', source: null, note: 'a referral is an interested buyer' },
        channel: { label: 'partner referrals', perDay: { value: null, low: PARTNER_TERMS.referralsPerDay.low, high: PARTNER_TERMS.referralsPerDay.high, provenance: 'ASSUMPTION', source: null, note: PARTNER_TERMS.referralsPerDay.source }, resource: 'channel:partner', riskGroup: 'channel:partner' },
      };
      return {
        ...s,
        openings: [...s.openings, clone],
        changes: [...s.changes, { dimension: 'PARTNER', label: 'referral-partner', detail: `sell ${target.opportunity.title.slice(0, 50)} through a partner who already serves its buyers (a supplier or complementary vendor), paying ${Math.round(PARTNER_TERMS.commission.low * 100)}–${Math.round(PARTNER_TERMS.commission.high * 100)}% (${PARTNER_TERMS.commission.source}); ${PARTNER_TERMS.referralsPerDay.low}–${PARTNER_TERMS.referralsPerDay.high} referrals a day assumed until a partner is signed`, cost: 0, basis: 'ASSUMPTION', startDay: PARTNER_TERMS.setupDays }],
      };
    },
  });
  // Transaction shapes: sell more per buyer, at the cost of a lower and unmeasured close rate.
  for (const [shape, multiple, closeFactor] of [
    ['bundle', SHAPE_MULTIPLES.bundle.units * (1 - SHAPE_MULTIPLES.bundle.discount), 0.5],
    ['retainer', SHAPE_MULTIPLES.retainer.unitsPerMonth * (1 - SHAPE_MULTIPLES.retainer.discount), 0.6],
  ] as const) {
    operators.push({
      dimension: 'TRANSACTION',
      apply: (s) => {
        // Only a ticket too small to carry a material share of the gap is worth reshaping (§95's ONE_TRANSACTION_SHAPE).
        const touched = s.openings.filter((o) => o.repeatable && o.agreedValue === 0 && knownMid(o.price) !== null && (knownMid(o.price) ?? 0) < limits.remaining * MATERIAL_SHARE);
        if (touched.length === 0) return null;
        return {
          ...s,
          openings: s.openings.map((o) =>
            touched.includes(o)
              ? { ...o, price: scale(o.price, multiple), close: { ...scale(o.close, closeFactor, 1), provenance: 'ASSUMPTION' as ModelInput['provenance'], note: `${o.close.note}; ${shape}: close assumed ×${closeFactor}, not measured` }, volume: scale(o.volume, 1 / multiple) }
              : o,
          ),
          changes: [...s.changes, { dimension: 'TRANSACTION', label: shape, detail: `sell a ${shape} worth ×${multiple.toFixed(1)} the unit price; close rate assumed ×${closeFactor} until measured`, cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } }],
        };
      },
    });
  }
  // Financing: the buyer prepays, so a supplier's cost is paid from the buyer's money, not the owner's.
  operators.push({
    dimension: 'CAPITAL',
    apply: (s) => {
      const touched = s.openings.filter((o) => o.agreedValue === 0 && !o.fundedByBuyer && (o.directCost.high ?? o.directCost.value ?? 0) > 0);
      if (touched.length === 0) return null;
      return {
        ...s,
        openings: s.openings.map((o) => (touched.includes(o) ? { ...o, fundedByBuyer: true } : o)),
        changes: [...s.changes, { dimension: 'CAPITAL', label: 'prepaid-fulfilment', detail: `the buyer pays in full before the supplier is paid, so ${touched.length} opening(s)' direct costs come from the buyer's money, not the ${money(allowed.ceiling)} limit`, cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } }],
      };
    },
  });
  // Cash timing: a deposit at signing.
  operators.push({
    dimension: 'CASH_TIMING',
    apply: (s) => {
      const touched = s.openings.filter((o) => o.agreedValue === 0 && (o.daysToCash.high ?? o.daysToCash.value ?? 0) > 3);
      if (touched.length === 0) return null;
      return {
        ...s,
        openings: s.openings.map((o) => (touched.includes(o) ? { ...o, daysToCash: { ...favourable(o.daysToCash, 'LOW', 2), provenance: 'ASSUMPTION' as ModelInput['provenance'], note: 'deposit at signing, assumed accepted' } } : o)),
        changes: [...s.changes, { dimension: 'CASH_TIMING', label: 'deposit', detail: 'ask for a deposit or prepayment at signing, so cash arrives at the fast end of each opening\'s timing', cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } }],
      };
    },
  });

  // 4. Evaluate singles, then combine across dimensions while it improves materially.
  const rounds: Reconstruction['rounds'] = [];
  const improves = (a: VariantReading, b: VariantReading) => a.feasible && (a.reach - b.reach >= MATERIAL_REACH || (a.reach >= b.reach - 1e-9 && a.settledP50 > b.settledP50 * (1 + MATERIAL_P50) + 1e-9));
  const singles: Array<{ op: (typeof operators)[number]; reading: VariantReading }> = [];
  const firstTried: VariantReading[] = [];
  for (const op of operators) {
    const next = op.apply(base);
    if (!next) continue;
    const r = await evaluate(next);
    firstTried.push(r);
    singles.push({ op, reading: r });
  }
  const useful = singles.filter((one) => improves(one.reading, baseline)).sort((a, b) => b.reading.reach - a.reading.reach || b.reading.settledP50 - a.reading.settledP50);
  let current: State = base;
  let currentReading = baseline;
  if (useful[0]) {
    current = useful[0].op.apply(base)!;
    currentReading = useful[0].reading;
  }
  rounds.push({ round: 1, tried: firstTried, kept: useful[0]?.reading.key ?? null });
  let used = new Set<Dimension>(current.changes.map((c) => c.dimension));
  for (let round = 2; ; round++) {
    const tried: VariantReading[] = [];
    let bestNext: { state: State; reading: VariantReading } | null = null;
    for (const one of useful) {
      if (used.has(one.op.dimension)) continue;
      const next = one.op.apply(current);
      if (!next) continue;
      const r = await evaluate(next);
      tried.push(r);
      if (improves(r, currentReading) && (!bestNext || r.reach > bestNext.reading.reach || (r.reach === bestNext.reading.reach && r.settledP50 > bestNext.reading.settledP50))) bestNext = { state: next, reading: r };
    }
    if (tried.length === 0) break;
    rounds.push({ round, tried, kept: bestNext?.reading.key ?? null });
    if (!bestNext) break;
    current = bestNext.state;
    currentReading = bestNext.reading;
    used = new Set(current.changes.map((c) => c.dimension));
  }
  // The strongest plan, read again at the plan's own number of worlds.
  const best = current === base ? baseline : await evaluate(current, Math.max(worlds, Math.min(limits.worlds ?? 2000, Math.round((SCREEN_WORK * 3) / Math.max(1, input.openings.length)))));
  // Robustness: the strongest plan if the new campaign does no better than the old record.
  const floor = limits.measuredRates ? await evaluate(current, worlds, true, ' @as-is-record') : null;
  // The conversion it needs: the lowest reply rate (shared by every outreach opening) at which it reaches the requirement.
  const replyAt = (rate: number) =>
    evaluate({ ...current, openings: current.openings.map((o) => (sellsThroughOutreach(o) ? { ...o, respond: { ...o.respond, value: rate, low: rate, high: rate, distribution: undefined, inferred: undefined } } : o)) }, worlds, false, ` @reply=${rate.toFixed(4)}`);
  let requiredReply: number | null = null;
  if (current.openings.some(sellsThroughOutreach) && (await replyAt(0.15)).reach >= input.required) {
    let lo = 0.0005;
    let hi = 0.15;
    if ((await replyAt(lo)).reach >= input.required) requiredReply = lo;
    else {
      for (let i = 0; i < 9; i++) {
        const mid = Math.sqrt(lo * hi);
        if ((await replyAt(mid)).reach >= input.required) hi = mid;
        else lo = mid;
      }
      requiredReply = hi;
    }
  }

  // 2. Challenge the plan's own assumptions, with what the loop found.
  const lift = (f: Factor) => diagnosis.find((d) => d.factor === f);
  const triedDim = (d: Dimension) => firstTried.filter((r) => r.changes.some((c) => c.dimension === d));
  const bestOf = (d: Dimension) => triedDim(d).sort((a, b) => b.reach - a.reach)[0];
  const measuredRecord = input.baseline.measuredRates;
  const challenges: AssumptionChallenge[] = [
    {
      assumption: 'Historical outreach results describe the campaign this plan would run',
      status: measuredRecord ? (measuredRecord.applied === 'BINDS' ? 'MEASURED' : 'ASSUMPTION') : 'UNTESTED',
      testedBy: 'EVIDENCE',
      finding: measuredRecord
        ? `${measuredRecord.assessment.authority}: ${measuredRecord.assessment.sentence}${measuredRecord.asIs ? ` As-is floor: ${pct(measuredRecord.asIs.reach)} reach, p50 ${money(measuredRecord.asIs.settledP50)}.` : ''}`
        : 'no measured outreach record was read',
    },
    {
      assumption: 'Sending capacity is fixed at what the workspace has today',
      status: 'ESTIMATE',
      testedBy: 'CAPACITY',
      finding: bestOf('CAPACITY') ? `best capacity purchase: ${bestOf('CAPACITY')!.changes.map((c) => c.detail).join('; ')} → ${pct(bestOf('CAPACITY')!.reach)} (from ${pct(baseline.reach)})` : 'no capacity purchase fits the limits',
    },
    {
      assumption: 'Cold outreach is the only way to reach buyers',
      status: 'ASSUMPTION',
      testedBy: 'ACQUISITION',
      finding: bestOf('ACQUISITION') ? `best bought channel: ${bestOf('ACQUISITION')!.changes.map((c) => c.detail).join('; ')} → ${pct(bestOf('ACQUISITION')!.reach)}` : 'no priced opening to sell through another channel',
    },
    {
      assumption: 'Each opening sells one unit at its listed price',
      status: 'ASSUMPTION',
      testedBy: 'TRANSACTION',
      finding: bestOf('TRANSACTION') ? `best reshaping: ${bestOf('TRANSACTION')!.key} → ${pct(bestOf('TRANSACTION')!.reach)}, p50 ${money(bestOf('TRANSACTION')!.settledP50)} (close rate assumed)` : 'no priced repeatable opening',
    },
    {
      assumption: 'Cash arrives at each opening\'s listed timing',
      status: 'ASSUMPTION',
      testedBy: 'CASH_TIMING',
      finding: `deposits at signing: ${pct(bestOf('CASH_TIMING')?.reach ?? baseline.reach)}; cash-timing factor lift ${pct(lift('CASH_TIMING')?.liftReach ?? 0)}`,
    },
    {
      assumption: 'The openings held are the market',
      status: structural ? 'ASSUMPTION' : 'ESTIMATE',
      testedBy: 'MARKET',
      finding: structural
        ? `even with every input at its favourable end the openings held reach ${pct(headroom.reach)}: the pool must change, not the estimates`
        : `with every input at its favourable end the openings held could reach ${pct(headroom.reach)}`,
    },
  ];

  // The cost of daily volumes asked about.
  const capacityLever = levers.find((l) => l.kind === 'SENDING_CAPACITY');
  const volumePlans = capacityLever ? (input.volumeQuestions ?? [10_000]).map((perDay) => dailyVolumePlan(capacityLever, perDay, daysLeft, limits)) : [];

  // 5. Conclude.
  const binding = diagnosis[0];
  const assumed = [...new Set(best.changes.filter((c) => c.basis !== 'MEASURED').map((c) => `${c.label}: ${c.detail}`))];
  const unestablished = [...new Set((input.baseline.missing ?? []).filter((m) => /not established/.test(m)).map((m) => m.split(':').slice(1).join(':').trim()))];
  const measured: string[] = [];
  if (measuredRecord) measured.push(measuredRecord.assessment.answers);
  if (limits.measuredCapacity) measured.push(`sending capacity up to ${limits.measuredCapacity.perDay} a day on ${limits.measuredCapacity.accounts} healthy accounts`);
  const wilsonLow = wilsonLower(Math.round(best.reach * (limits.worlds ?? 2000)), limits.worlds ?? 2000);
  const confidenceStatement = { value: '' };
  const statement0 =
    best.basis === 'PROBABILITY' && assumed.length === 0
      ? `The strongest plan reaches the target in ${pct(best.reach)} of worlds, a probability (Wilson lower bound ${pct(wilsonLow)}) because every input is evidence.`
      : `The strongest plan reaches the target in ${pct(best.reach)} of the worlds tested. That is coverage of stated ranges and assumptions, not a probability: ${[...assumed.slice(0, 3), ...unestablished.slice(0, 3)].join('; ') || 'inputs are not all evidence'}.`;
  const robustness =
    (floor ? ` If the new campaign does no better than the measured record, it reaches ${pct(floor.reach)} (p50 ${money(floor.settledP50)}).` : '') +
    (requiredReply !== null ? ` It needs a reply rate of about ${pct(requiredReply)} to reach ${pct(input.required)}; the first sends measure that.` : ' No reply rate up to 15% reaches the requirement on its own.');
  confidenceStatement.value += robustness;
  const changedDims = [...new Set(best.changes.map((c) => c.dimension.toLowerCase().replace('_', ' ')))];
  const parts: string[] = [];
  if (structural) parts.push(`For the openings as held, even every estimate at its favourable end reaches ${pct(headroom.reach)}: better estimates or more capacity cannot close the gap.`);
  else if (binding) parts.push(`${binding.factor} binds (moving it alone lifts reach by ${pct(binding.liftReach)}).`);
  if (best !== baseline && best.reach > baseline.reach + MATERIAL_REACH) {
    parts.push(`Changing ${changedDims.join(', ')} reaches ${pct(best.reach)} of the worlds tested, resting on ${assumed.length} assumption(s) that only selling can measure.`);
  } else parts.push('No change tried improves the plan materially.');
  if (best.reach < input.required || best.basis !== 'PROBABILITY' || assumed.length > 0) {
    parts.push(structural ? 'A defensible plan needs openings with larger or faster demand, or a channel where buyers already ask, and the assumptions measured by selling.' : 'A defensible plan needs those assumptions measured by selling.');
  }
  const limitation = best.reach >= input.required && best.basis === 'PROBABILITY' && assumed.length === 0 ? null : parts.join(' ');
  const ticket = Math.max(250, Math.round(limits.remaining / 20 / 50) * 50);
  // Coverage that reaches the requirement is still not a plan anybody can rely on: keep asking the world.
  const searchBrief =
    best.reach >= input.required && best.basis === 'PROBABILITY' && assumed.length === 0
      ? ''
      : `Reconstruction (§99): ${binding ? `${binding.factor.toLowerCase().replace('_', ' ')} is what binds this goal` : 'no single factor binds'}${structural ? ', and the openings held cannot reach the target even at their best' : ''}. ` +
        `Look in any industry, including ones not searched before, for buyers who already ask for something that can be delivered within ${Math.max(1, daysLeft - 5)} days for ${money(ticket)} or more, ` +
        `reachable without cold email — a request posted, a marketplace category with open demand, a partner who already sells to them — with one dated example each, and what the buyer pays and when.`;
  return {
    required: input.required,
    baseline,
    diagnosis,
    headroom,
    structural,
    challenges,
    rounds,
    best,
    floor,
    requiredReply,
    volumePlans,
    limitation,
    confidence: { basis: best.basis, measured, assumed: [...assumed, ...unestablished], statement: statement0 + confidenceStatement.value },
    searchBrief,
    evaluations,
  };
}

function allowedFor(limits: ReconstructionInput['portfolio']) {
  return budgetsAllowed(limits);
}

function valuePerInterested(o: ModelledOpportunity): number {
  return (knownMid(o.price) ?? 0) * (knownMid(o.close) ?? 0);
}

function currentContacts(limits: ReconstructionInput['portfolio'], baseline: GoalPortfolio): ModelInput {
  if (limits.contactsPerDay) return limits.contactsPerDay;
  const c = baseline.limits.contactsPerDay;
  return c.value !== null
    ? { value: c.value, low: c.value, high: c.value, provenance: 'EVIDENCE', source: null, note: c.source }
    : { value: null, low: c.low, high: c.high, provenance: 'UNKNOWN', source: null, note: c.source };
}

/** One-sided 95% Wilson lower bound, the test §95 applies. */
export function wilsonLower(k: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}

/** The reconstruction, as lines for `goals plan`. */
export function renderReconstruction(r: Reconstruction, limit = 8): string[] {
  const lines: string[] = [];
  const v = (x: VariantReading) => `reach ${pct(x.reach)} · p10/p50/p90 ${money(x.settledP10)}/${money(x.settledP50)}/${money(x.settledP90)} · ${x.basis.toLowerCase()}${x.committed ? ` · commits ${money(x.committed)}` : ''}`;
  lines.push(`  reconstruct baseline ${v(r.baseline)} · ${r.evaluations} evaluation(s) of ${r.rounds.reduce((n, x) => n + x.tried.length, 0)} variant(s) in ${r.rounds.length} round(s)`);
  for (const d of r.diagnosis) lines.push(`    binding   ${d.factor.padEnd(11)} ${d.moved} → reach ${pct(d.reach)} (${d.liftReach >= 0 ? '+' : ''}${pct(d.liftReach)}), p50 ${money(d.settledP50)}`);
  lines.push(`    headroom  every factor favourable at once → reach ${pct(r.headroom.reach)}, p50 ${money(r.headroom.settledP50)}${r.structural ? ' · STRUCTURAL: the openings held cannot reach the requirement' : ''}`);
  for (const c of r.challenges) lines.push(`    challenge [${c.status}] ${c.assumption} — ${c.finding.slice(0, 300)}`);
  for (const round of r.rounds) {
    const sorted = [...round.tried].sort((a, b) => b.reach - a.reach || b.settledP50 - a.settledP50).slice(0, limit);
    for (const t of sorted) lines.push(`    round ${round.round}   ${t.key === round.kept ? '*' : ' '} ${t.key.slice(0, 70).padEnd(70)} ${t.feasible ? v(t) : `refused: ${t.why}`}`);
  }
  for (const p of r.volumePlans) lines.push(`    volume    ${p.sentence}`);
  lines.push(`    best      ${r.best.key} · ${v(r.best)}`);
  if (r.floor) lines.push(`    as-is     the same plan on the old campaigns' measured rates · ${v(r.floor)}`);
  lines.push(`    needs     ${r.requiredReply !== null ? `a reply rate of ${pct(r.requiredReply)} on every outreach opening for ${pct(r.required)}` : `no reply rate up to 15% reaches ${pct(r.required)}`}`);
  for (const c of [...r.best.changes].sort((a, b) => (a.startDay?.low ?? 0) - (b.startDay?.low ?? 0))) lines.push(`      day ${c.startDay ? `${c.startDay.low}–${c.startDay.high}` : '0'}`.padEnd(16) + `[${c.basis}] ${c.dimension}: ${c.detail}`);
  lines.push(`    confidence ${r.confidence.statement}`);
  if (r.limitation) lines.push(`    limitation ${r.limitation}`);
  if (r.searchBrief) lines.push(`    brief     ${r.searchBrief}`);
  return lines;
}
