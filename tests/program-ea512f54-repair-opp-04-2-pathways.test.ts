/**
 * OPP-04 repair, episode 2: a partial arrangement is kept and marked, never abandoned.
 *
 * Production, 2026-11-26: probe r01.opp-04 read 30 live goals and found no pathway on any. The
 * reading was built only from what the cash model considered or priced, and a refused model
 * (no live opening) passed `pathways: null` outright — so every constructed arrangement the
 * model could not price was silently dropped, which S-0061 forbids ("an unknown is not an
 * automatic favourable assumption or a reason to abandon a partial arrangement").
 *
 *   P01 — the pure builder marks all fourteen commercial facts plus rights and capacity, an
 *         UNKNOWN states no value, an ESTIMATED one carries a range, and the probe rule passes.
 *   P02 — unknowns are never favourable: contribution and gross are zero and the portfolio's
 *         net is unchanged; the pathway is kept, not dropped.
 *   P03 — gaps name the missing component and the cheapest move (research first) with the
 *         threshold the goal needs; a channel is always a CONSTRUCT move, never a cold guess.
 *   P04 — a ranged reconstruction is an ESTIMATED price; with a supplier cost, an ESTIMATED net.
 *   P05 — readPathways: partial arrangements already modelled are not duplicated, and the modelled
 *         pathways' portfolio and next actions are exactly what they were without them.
 *   P06 — readGoalPlan on a live goal whose model is refused still exposes its constructed
 *         arrangements as pathways, and the probe passes on them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { MAX_PARTIAL_PATHWAYS, partialPathwayOf, pathwayOf, publishedFacts, readPathways } from '../server/services/goals/pathways.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const now = new Date();
const ctx = { remaining: 10_000, daysLeft: 30, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[] };
const target = { remainingCents: 1_000_000, daysLeft: 30, currency: 'USD', capitalCeilingCents: null, capitalBeforeProofCents: 37_500 };

function arrangement(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: 'k1',
    structure: 'SUBCONTRACT',
    design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    origin: 'REVERSE',
    precedent: null,
    sector: null,
    demand: { name: 'Independent veterinary clinics', claimId: null, from: 'REVERSE', ref: 'pop:vets' },
    need: null,
    supply: null,
    label: 'Constructed: overflow bookkeeping for independent veterinary clinics',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'WITHIN' },
    evidenced: 0,
    value: { tier: 'MECHANISM', p10: 40, p50: 400, p90: 4_000, observations: 3 },
    ...over,
  } as unknown as ConstructedArrangement;
}

const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });
function opening(id = 'cop_found'): ModelledOpportunity {
  const o = {
    id, projectId: 'prj_1', title: 'A monthly report for property managers', mechanism: 'PRODUCTIZED_SERVICE', industry: null,
    payer: 'Property managers', reachableChannel: 'published business email', buyingSignal: 'posted asking for it', signalObservedAt: null,
    offerScope: 'one report', priceCents: 90_000, currency: 'USD', fulfillmentOwner: 'Brain', economicsNote: null, expiresAt: null,
    requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
  } as unknown as CashOpportunity;
  return {
    opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(900), capital: evidence(0), hours: swept(1, 2), daysToCash: evidence(9),
    close: swept(0.02, 0.5), respond: swept(0.002, 0.15), directCost: evidence(90), volume: swept(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
    fulfilledBy: { value: 'Brain produces it', provenance: 'EVIDENCE', source: null }, competitiveAward: false,
  } as unknown as ModelledOpportunity;
}

describe('P01: every input is marked', () => {
  it('marks all fourteen facts, rights and capacity, and passes the probe rule', () => {
    const p = partialPathwayOf(arrangement(), ctx);
    expect(pathwayProblem(p)).toBeNull();
    expect(p.counts.proven + p.counts.estimated + p.counts.unknown).toBe(14);
    expect(p.origin).toBe('CONSTRUCTED');
    expect(p.opportunityId).toBe('arr_k1');
    for (const fact of publishedFacts(p)) {
      if (fact.status === 'UNKNOWN') {
        expect(fact.value).toBeNull();
        expect(fact.basis.length).toBeGreaterThan(0);
      }
    }
    // A pooled MECHANISM price is not these buyers' price: unknown, and no range is published as one.
    expect(p.revenuePerDeal.status).toBe('UNKNOWN');
    expect(p.revenuePerDeal.low).toBeNull();
    expect(p.revenuePerDeal.basis).toMatch(/other buyers/);
    expect(p.channel.status).toBe('UNKNOWN');
    expect(p.acquisitionCost.status).toBe('UNKNOWN');
    expect(p.buyer.status).toBe('ESTIMATED');
    expect(pathwayProblem(partialPathwayOf(arrangement(), { ...ctx, permissionsMissing: ['CONTACT_BUYER'] }))).toBeNull();
  });

  it('names what is missing when the design names no buyer and needs a supplier', () => {
    const p = partialPathwayOf(arrangement({ demand: { name: '', claimId: null, from: 'REVERSE', ref: 'x' } as never, value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 } as never }), ctx);
    expect(pathwayProblem(p)).toBeNull();
    expect(p.gaps).toEqual(expect.arrayContaining(['NO_BUYER', 'NO_CHANNEL', 'NO_PRICE', 'NO_SUPPLIER', 'SLOW_OR_UNKNOWN_CASH']));
  });
});

describe('P02: an unknown is never favourable, and the arrangement is kept', () => {
  it('contributes nothing and cannot lead the living portfolio', () => {
    const p = partialPathwayOf(arrangement({ value: { tier: 'DIRECT', p10: 500, p50: 900, p90: 1_500, observations: 4 } as never }), ctx);
    expect(p.contribution).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(p.gross).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(p.executable).toBe(false);
    const reading = readPathways({ modelled: [], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now, partial: [arrangement()] });
    expect(reading.pathways).toHaveLength(1);
    expect(reading.portfolio.leading).toBeNull();
    expect(reading.measures.leadingNetP50).toBe(0);
    expect(reading.measures.partial).toBe(1);
  });
});

describe('P03: the cheapest move to learn or supply each missing component', () => {
  it('asks research first with the threshold the goal needs, then constructs a channel', () => {
    const p = partialPathwayOf(arrangement(), ctx);
    const price = p.moves.find((m) => m.field === 'revenueRange');
    expect(price?.action).toBe('RESEARCH');
    expect(price?.mustHit).toMatch(/1,000|1000/);
    const firstConstruct = p.moves.findIndex((m) => m.action === 'CONSTRUCT');
    expect(p.moves.slice(0, firstConstruct).every((m) => m.action === 'RESEARCH')).toBe(true);
    const channel = p.moves.find((m) => m.action === 'CONSTRUCT' && m.field === 'access');
    expect(channel?.construct).toMatch(/marketplace|partner/);
    expect(p.conversion.basis).toMatch(/universal cold-outreach rate is not theirs/);
  });
});

describe('P04: a ranged reconstruction is an estimate with its range', () => {
  it('states the price as ESTIMATED p10–p90, and a net only when a supplier cost is reconstructed too', () => {
    const priced = arrangement({ value: { tier: 'COMPARABLE', p10: 200, p50: 600, p90: 1_200, observations: 5 } as never });
    const a = partialPathwayOf(priced, ctx);
    expect(a.revenuePerDeal).toMatchObject({ status: 'ESTIMATED', value: 600, low: 200, high: 1_200 });
    expect(a.net.status).toBe('UNKNOWN');
    expect(a.net.value).toBeNull();
    const b = partialPathwayOf({ ...priced, supplyCost: { tier: 'COMPARABLE', p10: 50, p50: 100, p90: 300, observations: 2, sources: [] } } as never, ctx);
    expect(b.net).toMatchObject({ status: 'ESTIMATED', value: 500, low: -100, high: 1_150 });
    expect(pathwayProblem(a)).toBeNull();
    expect(pathwayProblem(b)).toBeNull();
    expect(b.contribution.p90).toBe(0);
  });
});

describe('P05: readPathways keeps what was there', () => {
  it('does not duplicate an arrangement the model already priced, and leaves the modelled reading unchanged', () => {
    const found = opening();
    const priced = { ...opening('arr_k2'), estimated: { arrangementKey: 'k2' } } as unknown as ModelledOpportunity;
    const base = { modelled: [found, priced], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now };
    const without = readPathways(base);
    const withPartial = readPathways({ ...base, partial: [arrangement({ key: 'k2' }), arrangement({ key: 'k3' }), arrangement({ key: 'k3' })] });
    expect(withPartial.pathways.map((p) => p.opportunityId)).toEqual([...without.pathways.map((p) => p.opportunityId), 'arr_k3']);
    expect(withPartial.portfolio).toEqual(without.portfolio);
    expect(withPartial.informationValue).toEqual(without.informationValue);
    expect(withPartial.failures).toEqual(without.failures);
    expect(without.nextActions.length).toBeLessThan(12);
    expect(withPartial.nextActions.slice(0, without.nextActions.length)).toEqual(without.nextActions);
    expect(withPartial.pathways[0]).toEqual(pathwayOf(found, null, { ...ctx, permissionsMissing: [], now, capabilities: null, perArrangement: 375, outreachPerDay: 60 }));
  });

  it('bounds the partial arrangements it reads and says how many it cut', () => {
    const many = Array.from({ length: MAX_PARTIAL_PATHWAYS + 3 }, (_, i) => arrangement({ key: `m${i}` }));
    const r = readPathways({ modelled: [], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now, partial: many });
    expect(r.pathways).toHaveLength(MAX_PARTIAL_PATHWAYS);
    expect(r.measures.partialCut).toBe(3);
  });
});

describe('P06: a live goal with a refused model still exposes its pathways', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('reads constructed arrangements as marked pathways, and the probe passes on them', async () => {
    const { project } = await freshProject();
    const userId = (await createUser({ email: `o42-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    const g = await createWorkstream({ projectId: project.id, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId: project.id, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const reading = await readGoalPlan({ goalId: g.id, persist: false });
    expect(reading?.refusal).toBeTruthy();
    expect(reading?.pathways).not.toBeNull();
    const pathways = reading!.pathways!.pathways;
    expect(pathways.length).toBeGreaterThan(0);
    for (const p of pathways) expect(pathwayProblem(p)).toBeNull();
    expect(pathways.every((p) => p.origin === 'CONSTRUCTED' && p.contribution.p90 === 0)).toBe(true);
    expect(reading!.pathways!.portfolio.leading).toBeNull();
    const probe = await getProbe('r01.opp-04')!({});
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/pathway\(s\) across/);
  }, 120_000);
});
