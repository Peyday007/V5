/**
 * One source for a plan's outcome figures, and no reliability read from legs
 * nobody can execute (audit 2026-11-23 of goal wst_7b4fcbb5f2384f31b6c3,
 * docs/ARCHITECTURE-RECORD.md §95).
 *
 * The production reading carried two incompatible 10th percentiles: the
 * pathways' leading combination read "net p10 $368" (`contributionOf`: every
 * input at its unfavourable end at once, summed and capped at the gap — a
 * bound, not a percentile) while `objective.outcome` read an adverse case of
 * $32,266 from `portfolio.best` — a different combination from the one the
 * acceptance held. And its 98% reach and $55,772 expected came almost wholly
 * from legs with no channel, no offer and nobody named to fulfil them.
 */
import { describe, expect, it } from 'vitest';
import { candidateSentence, composeGoalReadings, judgeAcceptance, planOutcomeOf, type PlanAcceptance } from '../server/services/goals/plan.ts';
import { legFeasibility, pathwayOf, type PathwayReading, type TransactionPathway } from '../server/services/goals/pathways.ts';
import type { GoalPortfolio, PortfolioCombination } from '../server/services/goals/portfolio.ts';
import type { TargetReading } from '../server/services/goals/target.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';
import { goalObjective } from '../server/services/goals/objective.ts';

const NOW = new Date('2026-11-23T00:00:00Z');
const goalWords = { title: 'Cash goal', intent: 'Collect $10K in 16 days', outcome: null, dueAt: '2026-12-09T00:00:00Z', target: { amountCents: 1_000_000 } };
const ctx = { remaining: 10_000, daysLeft: 16, currency: 'USD', perArrangement: 375, outreachPerDay: 930, permissionsMissing: [] as string[], now: NOW, capabilities: null };
const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });

/** A found opening with every link (`ready`), or one with no channel, no offer and nobody to fulfil it. */
function opening(id: string, ready: boolean, price = 900): ModelledOpportunity {
  const o = {
    id, projectId: 'prj_1', title: `Opening ${id}`, mechanism: 'PRODUCTIZED_SERVICE', industry: null,
    payer: `Payer ${id}`, reachableChannel: ready ? 'published business email' : null, buyingSignal: 'posted asking for it', signalObservedAt: null,
    offerScope: ready ? 'one report' : null, priceCents: price * 100, currency: 'USD', fulfillmentOwner: ready ? 'Brain' : null, economicsNote: null, expiresAt: null,
    requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
  } as unknown as CashOpportunity;
  return {
    opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(price), capital: evidence(0), hours: unknown(1, 2), daysToCash: evidence(4),
    close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(90), volume: unknown(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
    fulfilledBy: ready ? { value: 'Brain produces it', provenance: 'EVIDENCE', source: null } : null, competitiveAward: false,
  } as unknown as ModelledOpportunity;
}

const combo = (ids: string[], d: { reach: number; p10: number; p50: number; p90: number }): PortfolioCombination => ({
  members: ids.map((id) => ({ opportunityId: id, title: `Opening ${id}`, share: 0.5 })), reach: d.reach, settledP10: d.p10, settledP50: d.p50, settledP90: d.p90, capitalShort: 0, overSpend: 0,
});

function portfolio(best: PortfolioCombination, alternatives: PortfolioCombination[] = [], over: Partial<GoalPortfolio> = {}): GoalPortfolio {
  return {
    basis: 'COVERAGE', worlds: 2_000, best, alternatives, demand: [],
    limits: { target: 10_000, deadlineDays: 16, startingCapital: 375, perArrangement: 375, spendCeiling: 3_000, contactsPerDay: { value: null, low: 10, high: 930, source: 'test' }, correlation: 0.5 },
    missing: [], searched: 1, ...over,
  } as unknown as GoalPortfolio;
}

const target = {
  metric: 'SETTLED_CASH', metricLabel: 'settled', currency: 'USD', projectId: 'prj_1', targetCents: 1_000_000, achievedCents: 0, remainingCents: 1_000_000,
  achieved: false, daysLeft: 16, counted: [], notCounted: [], since: NOW.toISOString(), capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500,
} as unknown as TargetReading;

const candidateOnly = (candidate: PlanAcceptance['candidate']): PlanAcceptance =>
  ({ status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate, shortfalls: [], sentence: '' }) as unknown as PlanAcceptance;

function read(input: { portfolio: GoalPortfolio | null; pathways: TransactionPathway[]; acceptance: PlanAcceptance; supported?: PortfolioCombination | null }) {
  return composeGoalReadings({
    objective: goalObjective(goalWords, NOW),
    target,
    portfolio: input.portfolio,
    pathways: { pathways: input.pathways } as unknown as PathwayReading,
    arrangements: [],
    reconstruction: null,
    acceptance: input.acceptance,
    supported: input.supported ?? null,
  }).objective;
}

const ready = pathwayOf(opening('ready', true), null, ctx);
const bare = pathwayOf(opening('bare', false, 10_000), null, ctx);
const bare2 = pathwayOf(opening('bare2', false, 75), null, ctx);

describe('one source for the plan\'s outcome figures', () => {
  it('reads the outcome from the combination the acceptance holds, never from portfolio.best when that is another plan', () => {
    // The engine's best counts other members (production: the GitHub leg + one domain leg); the held plan is the leading pair.
    const best = combo(['bare', 'other'], { reach: 0.98, p10: 32_266, p50: 57_262, p90: 77_450 });
    const held = combo(['bare', 'bare2'], { reach: 0.4, p10: 0, p50: 6_000, p90: 14_000 });
    const objective = read({
      portfolio: portfolio(best, [held]),
      pathways: [bare, bare2],
      acceptance: candidateOnly({ label: 'the leading pair', opportunityIds: ['bare', 'bare2'], source: 'PATHWAYS', settledP50: null, reach: null, reachBasis: null }),
    });
    // Before: adverse read best's p10 (32,266) beside a held plan whose own figures disagreed.
    expect(objective.outcome).not.toBeNull();
    // Its own p10 (0) at the adverse quantile, read off the evenly spaced worlds.
    expect(objective.outcome!.adverse).toBeLessThan(100);
    expect(objective.outcome!.upper).toBe(14_000);
    expect(objective.outcome!.adverse).not.toBe(32_266);
  });

  it('states no outcome for a held plan the engine never simulated, rather than another combination\'s', () => {
    const best = combo(['bare', 'other'], { reach: 0.98, p10: 32_266, p50: 57_262, p90: 77_450 });
    const objective = read({
      portfolio: portfolio(best),
      pathways: [bare, bare2],
      acceptance: candidateOnly({ label: 'the leading pair', opportunityIds: ['bare', 'bare2'], source: 'PATHWAYS', settledP50: null, reach: null, reachBasis: null }),
    });
    expect(objective.outcome).toBeNull();
    expect(objective.basis).toMatch(/not simulated as a combination/);
  });

  it('gives a pathways candidate the engine\'s median for its exact members, and none from the contribution bounds', () => {
    const leading = { members: ['bare', 'bare2'], net: { p10: 368, p50: 10_000, p90: 10_000 }, gross: { p10: 0, p50: 10_000, p90: 10_000 }, coverage: 1, ifLeadGroupFails: 0, groups: [], capital: 0 };
    const pathways = { portfolio: { leading }, pathways: [bare, bare2] } as unknown as PathwayReading;
    // No priced combination and no strategy: the candidate is the pathways' leading combination.
    const unsimulated = judgeAcceptance({ achieved: false, chosen: null, portfolio: null, measuredChance: null, considered: [], pathways });
    expect(unsimulated.candidate?.source).toBe('PATHWAYS');
    // Before: 10,000 — the leading combination's capped middle bound, read as a settled median.
    expect(unsimulated.candidate?.settledP50).toBeNull();
  });
});

describe('a leg nobody can execute does not count toward the figure presented as the plan\'s outcome', () => {
  it('judges each leg on a channel, an offer at an established price, a fulfiller and settled cash', () => {
    expect(legFeasibility('ready', ready)).toMatchObject({ supported: true, lacks: [] });
    expect(legFeasibility('bare', bare).lacks).toEqual(['ACQUISITION', 'OFFER', 'FULFILMENT']);
    // A price the quant engine holds unestablished is not a price, whatever the pathway estimated.
    expect(legFeasibility('ready', ready, false).lacks).toEqual(['OFFER']);
    // No pathway: nothing showed the leg has anything.
    expect(legFeasibility('missing', null).lacks).toEqual(['ACQUISITION', 'OFFER', 'FULFILMENT', 'PAYMENT']);
  });

  it('presents a plan resting only on unsupported legs as assumption-only coverage, beside a supported figure of zero', () => {
    const held = combo(['bare', 'bare2'], { reach: 0.98, p10: 32_266, p50: 57_262, p90: 77_450 });
    const objective = read({
      portfolio: portfolio(held),
      pathways: [bare, bare2],
      acceptance: candidateOnly({ label: 'the pair', opportunityIds: ['bare', 'bare2'], source: 'QUANT_PORTFOLIO', settledP50: 57_262, reach: 0.98, reachBasis: 'COVERAGE', unsupported: ['bare', 'bare2'] }),
    });
    expect(objective.support?.basis).toBe('ASSUMPTION_ONLY');
    expect(objective.support?.assumptionReach).toBe(0.98);
    expect(objective.support?.reach).toBe(0);
    expect(objective.support?.outcome?.expected).toBe(0);
    expect(objective.support?.sentence).toMatch(/assumption-only coverage/);
    expect(objective.support?.sentence).toMatch(/lacks a reachable channel/);
    // The outcome a reading presents as the plan's is the supported one.
    expect(planOutcomeOf(objective)?.expected).toBe(0);
    expect(planOutcomeOf(objective)?.surplusForSuccessors).toBe(0);
    expect(candidateSentence({ label: 'the pair', opportunityIds: ['bare', 'bare2'], source: 'QUANT_PORTFOLIO', settledP50: 57_262, reach: 0.98, reachBasis: 'COVERAGE', unsupported: ['bare', 'bare2'] }, 0.9)).toMatch(/assumption-only coverage: it reaches the target in 98% of worlds only by counting 2 of 2 leg/);
  });

  it('reads the supported legs alone from the engine when some legs are supported, and states none when that was not simulated', () => {
    const held = combo(['ready', 'bare'], { reach: 0.98, p10: 32_266, p50: 57_262, p90: 77_450 });
    const acceptance = candidateOnly({ label: 'mixed', opportunityIds: ['ready', 'bare'], source: 'QUANT_PORTFOLIO', settledP50: 57_262, reach: 0.98, reachBasis: 'COVERAGE' });
    const withRun = read({ portfolio: portfolio(held), pathways: [ready, bare], acceptance, supported: combo(['ready'], { reach: 0.05, p10: 0, p50: 1_800, p90: 4_500 }) });
    expect(withRun.support).toMatchObject({ basis: 'ASSUMPTION_ONLY', reach: 0.05, assumptionReach: 0.98 });
    expect(withRun.support?.outcome?.upper).toBe(4_500);
    const without = read({ portfolio: portfolio(held), pathways: [ready, bare], acceptance });
    expect(without.support).toMatchObject({ basis: 'ASSUMPTION_ONLY', reach: null, outcome: null });
    expect(without.support?.sentence).toMatch(/not simulated on their own/);
  });

  it('calls the outcome the plan\'s own only when every counted leg is supported', () => {
    const held = combo(['ready'], { reach: 0.7, p10: 4_000, p50: 11_000, p90: 16_000 });
    const objective = read({ portfolio: portfolio(held), pathways: [ready], acceptance: candidateOnly({ label: 'ready', opportunityIds: ['ready'], source: 'QUANT_PORTFOLIO', settledP50: 11_000, reach: 0.7, reachBasis: 'COVERAGE' }) });
    expect(objective.support?.basis).toBe('SUPPORTED');
    expect(planOutcomeOf(objective)).toBe(objective.outcome);
  });
});

describe('complete feasibility before acceptance', () => {
  const assured = { assurance: { status: 'CLAIMS_AT_LEAST_90', claimsAtLeast90: true, range: { low: 0.91, high: 0.99 }, coverage: 0.97, validationProblems: [], tailSettledP10: null, sample: { events: 200, from: 'STATED' }, reason: 'calibrated' } };
  const evidenced = (ids: string[]) => portfolio(combo(ids, { reach: 0.97, p10: 10_500, p50: 14_000, p90: 18_000 }), [], { basis: 'PROBABILITY', ...assured } as Partial<GoalPortfolio>);
  const leading = { portfolio: { leading: null } };

  it('does not accept an evidenced combination counting a leg with no channel, offer or fulfiller, and names what it lacks', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: evidenced(['ready', 'bare']), measuredChance: null, considered: [{ opportunityId: 'ready', missing: [] }, { opportunityId: 'bare', missing: [] }], pathways: { ...leading, pathways: [ready, bare] } as unknown as PathwayReading });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.shortfalls.join(' ')).toMatch(/cannot be executed yet: "Opening bare" lacks a reachable channel to a named buyer, a specific offer at an established price, a named fulfiller/);
    expect(a.legs?.find((l) => l.opportunityId === 'bare')?.lacks).toEqual(['ACQUISITION', 'OFFER', 'FULFILMENT']);
    expect(a.candidate?.unsupported).toEqual(['bare']);
  });

  it('accepts a complete one whose only gap is a permission, and names that permission as its one blocker', () => {
    const blocked = pathwayOf(opening('ready', true), null, { ...ctx, permissionsMissing: ['CONTACT_BUYER', 'a billing provider'] });
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: evidenced(['ready']), measuredChance: null, considered: [{ opportunityId: 'ready', missing: [] }], pathways: { ...leading, pathways: [blocked] } as unknown as PathwayReading });
    expect(a.status).toBe('ACCEPTED');
    expect(a.blocker).toMatch(/CONTACT_BUYER, a billing provider/);
    expect(a.sentence).toMatch(/Its one blocker/);
  });

  it('does not accept on this Brain\'s record a complete chain whose leg nobody can fulfil', () => {
    const chosen = { key: 's', label: 'Bare plan', verdict: 'NEEDS_EVIDENCE', opportunityIds: ['bare'], links: [], constraintsFailed: [], sweep: { goalMetShare: 1, settledP50: 12_000, settledP90: 12_000, infeasibleShare: 0, probabilistic: false }, conservativeSettled: 12_000, chainComplete: true, nextTest: null } as never;
    const strong = { estimate: 1, lowerBound: 0.91, upperBound: 1, sampleSize: 40, cohort: 'accepted plans' };
    const a = judgeAcceptance({ achieved: false, chosen, portfolio: null, measuredChance: strong, considered: [{ opportunityId: 'bare', missing: [] }], pathways: { ...leading, pathways: [bare] } as unknown as PathwayReading });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.shortfalls.join(' ')).toMatch(/every chain link established, but counts money from legs that cannot be executed yet/);
    const ok = judgeAcceptance({ achieved: false, chosen: { ...(chosen as object), opportunityIds: ['ready'] } as never, portfolio: null, measuredChance: strong, considered: [{ opportunityId: 'ready', missing: [] }], pathways: { ...leading, pathways: [ready] } as unknown as PathwayReading });
    expect(ok.status).toBe('ACCEPTED');
    expect(ok.blocker).toBeNull();
  });
});
