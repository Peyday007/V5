/**
 * GOAL-13-6: compressed timelines are searched backward from the goal, settlement is confirmed
 * per horizon, and no horizon claims a probability or acceptance it was not given.
 */
import { describe, expect, it } from 'vitest';
import { pathwayOf, type TransactionPathway } from '../server/services/goals/pathways.ts';
import { readTimelines, timelineHorizons, STANDARD_HORIZONS } from '../server/services/goals/timelines.ts';
import type { PlanAcceptance } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const now = new Date();
const ctx = { remaining: 10_000, daysLeft: 45, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now, capabilities: null };
const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });

function opening(id: string, over: Record<string, unknown> = {}, card: Record<string, unknown> = {}): ModelledOpportunity {
  const o = {
    id, projectId: 'prj_1', title: `Opening ${id}`, mechanism: 'PRODUCTIZED_SERVICE', industry: null,
    payer: `Payer ${id}`, reachableChannel: 'published business email', buyingSignal: 'posted asking for it', signalObservedAt: null,
    offerScope: 'one report', priceCents: 90_000, currency: 'USD', fulfillmentOwner: 'Brain', economicsNote: null, expiresAt: null,
    requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD', ...card,
  } as unknown as CashOpportunity;
  return {
    opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(900), capital: evidence(0), hours: unknown(1, 2), daysToCash: evidence(9),
    close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(90), volume: unknown(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
    fulfilledBy: { value: 'Brain produces it', provenance: 'EVIDENCE', source: null }, competitiveAward: false, ...over,
  } as unknown as ModelledOpportunity;
}

const target = { remainingCents: 1_000_000, daysLeft: 45, currency: 'USD', capitalCeilingCents: null, capitalBeforeProofCents: null };
const fast = pathwayOf(opening('fast'), null, ctx);
const slow = pathwayOf(opening('slow', { daysToCash: evidence(40) }), null, ctx);
const unsettled = pathwayOf(opening('unsettled', { daysToCash: unknown(1, 90), }), null, ctx);
const withSettlement = (p: TransactionPathway, status: 'UNKNOWN'): TransactionPathway => ({ ...p, daysToCash: { value: null, low: null, high: null, status, basis: 'nobody said' } });
const pathways = [fast, slow, withSettlement(unsettled, 'UNKNOWN')];

describe('timelineHorizons (pure)', () => {
  it('reads 30/60/90, the goal deadline and derived horizons — never only a fixed list', () => {
    const h = timelineHorizons({ deadlineDays: 45, pathways });
    const days = h.map((x) => x.days);
    for (const d of STANDARD_HORIZONS) expect(days).toContain(d);
    expect(h.find((x) => x.days === 45)?.origins).toContain('DEADLINE');
    expect(h.some((x) => x.origins.includes('DERIVED') && !(STANDARD_HORIZONS as readonly number[]).includes(x.days))).toBe(true);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(new Set(days).size).toBe(days.length);
  });
});

describe('readTimelines (pure)', () => {
  const reading = readTimelines({ target, pathways, portfolio: null });
  const at = (d: number) => reading.horizons.find((h) => h.days === d)!;

  it('solves backward per horizon for net per deal, deals and prospects a day', () => {
    for (const d of [30, 60, 90, 45]) {
      const h = at(d);
      expect(h).toBeDefined();
      expect(h.economics.structures.length).toBeGreaterThan(0);
      const one = h.economics.structures.find((s) => s.deals === 10)!;
      expect(one.netPerDeal).toBeCloseTo(1000);
      expect(one.perDay.middle).toBeGreaterThan(0);
      expect(h.economics.easiest).not.toBeNull();
    }
    // A shorter horizon needs more prospects a day for the same deals.
    const ten = (d: number) => at(d).economics.structures.find((s) => s.deals === 10 && s.kind === 'MID_TICKET')!.perDay.middle;
    expect(ten(30)).toBeGreaterThan(ten(90));
  });

  it('excludes a pathway whose settlement exceeds the horizon, and names why', () => {
    const h30 = at(30);
    expect(h30.eligible).toContain('fast');
    expect(h30.eligible).not.toContain('slow');
    expect(h30.excluded.find((e) => e.opportunityId === 'slow')).toMatchObject({ reason: 'SETTLES_TOO_LATE', daysToCash: 40 });
    expect(at(60).eligible).toContain('slow');
    // Unknown settlement is never counted: it is confirmed or excluded.
    for (const h of reading.horizons) expect(h.excluded.find((e) => e.opportunityId === 'unsettled')?.reason).toBe('SETTLEMENT_UNCONFIRMED');
    for (const h of reading.horizons) for (const c of [h.combinations.leading, h.combinations.independent]) for (const m of c?.members ?? []) expect(h.eligible).toContain(m);
  });

  it('never invents a probability: reach is coverage and status stays CANDIDATE', () => {
    for (const h of reading.horizons) {
      expect(h.probability).toBeNull();
      expect(h.status).toBe('CANDIDATE');
      if (h.reach.value !== null) expect(h.reach.basis).toBe('COVERAGE');
    }
  });

  it('a horizon beyond the deadline is never extrapolated upward', () => {
    const h90 = at(90);
    expect(h90.beyondDeadline).toBe(true);
    const fast45 = at(45).combinations.leading!;
    expect(at(90).combinations.independent!.net.p50).toBeLessThanOrEqual(at(60).combinations.independent!.net.p50 + 1e-9);
    expect(fast45.net.p50).toBeGreaterThan(0);
  });

  it('accepts only what the plan\'s own acceptance accepts, at its horizon, and keeps candidate apart', () => {
    const accepted: PlanAcceptance = {
      status: 'ACCEPTED', required: 0.9,
      probability: { value: 0.95, lowerBound: 0.91, basis: 'EVIDENCED_PORTFOLIO', sample: 40, note: 'a calibrated sample' },
      accepted: { label: 'fast', opportunityIds: ['fast'] }, candidate: null, shortfalls: [], sentence: 'Accepted',
    };
    const r = readTimelines({ target, pathways, portfolio: null, acceptance: accepted });
    const h45 = r.horizons.find((h) => h.days === 45)!;
    expect(h45.status).toBe('ACCEPTED');
    expect(h45.reach.basis).toBe('PROBABILITY');
    for (const h of r.horizons.filter((x) => x.days !== 45)) expect(h.status).toBe('CANDIDATE');
    // An acceptance resting on a pathway that does not settle in time is not acceptance there.
    const onSlow: PlanAcceptance = { ...accepted, accepted: { label: 'slow', opportunityIds: ['slow'] } };
    const r2 = readTimelines({ target, pathways, portfolio: null, acceptanceByHorizon: new Map([[30, onSlow]]) });
    expect(r2.horizons.find((h) => h.days === 30)!.status).toBe('CANDIDATE');
    // A CANDIDATE_ONLY judgment never becomes ACCEPTED.
    const r3 = readTimelines({ target, pathways, portfolio: null, acceptance: { ...accepted, status: 'CANDIDATE_ONLY', accepted: null, probability: null } });
    expect(r3.horizons.every((h) => h.status === 'CANDIDATE' && h.probability === null)).toBe(true);
  });

  it('compares independent combinations: one member per correlation group', () => {
    const twin = { ...fast, opportunityId: 'twin', title: 'twin' };
    const r = readTimelines({ target, pathways: [fast, twin, slow], portfolio: null });
    const h60 = r.horizons.find((h) => h.days === 60)!;
    const groups = [fast, twin, slow].filter((p) => h60.combinations.independent!.members.includes(p.opportunityId)).map((p) => p.correlationGroup);
    expect(new Set(groups).size).toBe(groups.length);
    expect(h60.economics.wedgesAvailable).toBe(new Set([fast, slow].map((p) => p.correlationGroup)).size);
  });

  it('applies no industry or category filter', () => {
    const odd = pathwayOf(opening('odd', {}, { industry: 'anything at all', mechanism: 'RESALE' }), null, ctx);
    const r = readTimelines({ target, pathways: [odd], portfolio: null });
    expect(r.horizons.find((h) => h.days === 30)!.eligible).toContain('odd');
  });
});
