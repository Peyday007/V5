/**
 * One plan read, one set of figures (§77). An independent audit of one
 * production read of goal wst_7b4fcbb5f2384f31b6c3 (2026-11-24) found about a
 * dozen figures in a single `goals plan` output that contradicted each other:
 * "outcome none" and "candidate settled p50 — · reach not computed" beside
 * "best reaches the target in 5.3% · settled p10 334 p50 2341 p90 8361"; the
 * leading line's bounds said to be the simulation's percentiles; a $111
 * simulated price for the leg every other line priced at $75; "evidence
 * supports $13 of $10,000" beside hundreds and thousands; and a header naming
 * one leg while every step was written for another.
 *
 * Each case builds the reading the audit read and holds its printed figures to
 * one another (`figureContradictions`), and to the lines that print them.
 */
import { describe, expect, it } from 'vitest';
import { bestLabel, candidateLine, figureContradictions, outcomeLines, planHeaderLines, reconcileFigures } from '../server/services/goals/figures.ts';
import { judgeAcceptance, stepsLegOf, type PlanAcceptance, type PlanReading } from '../server/services/goals/plan.ts';
import { heldCentreOf, sampler, type GoalPortfolio, type PortfolioCombination } from '../server/services/goals/portfolio.ts';
import { renderPathways, type PathFact, type PathwayReading } from '../server/services/goals/pathways.ts';
import { reviewRole, type CommitteeInput, type CommitteeLeg } from '../server/services/goals/committee.ts';
import type { ModelInput } from '../server/services/cash/goalScenario.ts';

const combo = (ids: string[], d: { reach: number; p10: number; p50: number; p90: number }): PortfolioCombination => ({
  members: ids.map((id) => ({ opportunityId: id, title: `Opening ${id}`, share: 0.5 })), reach: d.reach, settledP10: d.p10, settledP50: d.p50, settledP90: d.p90, capitalShort: 0, overSpend: 0,
}) as unknown as PortfolioCombination;

const fact = (value: number | string | null, status: PathFact['status'] = 'ESTIMATED'): PathFact => ({ value, low: typeof value === 'number' ? value : null, high: typeof value === 'number' ? value : null, status, basis: 'the reconstruction' });

/** The audited read: the engine's best counts the unpriced GitHub leg; the plan held is the pathways' leading pair of domain legs. */
const BEST = combo(['arr_github', 'arr_domain2'], { reach: 0.053, p10: 334, p50: 2341, p90: 8361 });
const leading = { members: ['arr_domain', 'arr_domain2'], net: { p10: 3.67, p50: 606, p90: 10_000 }, gross: { p10: 4, p50: 640, p90: 10_000 }, coverage: 0.06, ifLeadGroupFails: 0, groups: ['domain'], capital: 0 };
const demand = (id: string, price: number, unestablished: string[]) => ({ opportunityId: id, title: `Constructed: ${id === 'arr_github' ? 'GitHub Inc' : 'domain buyer or seller'}`, unestablished, price: { p10: price, p50: price, p90: price }, deals: { p10: 0, p50: 1, p90: 4 }, revenue: { p10: 0, p50: price, p90: 4 * price }, refused: null, capitalAtStart: 0, repeatable: true });
const pathway = (id: string, price: number) => ({ opportunityId: id, title: `Constructed: ${id === 'arr_github' ? 'GitHub Inc' : 'domain buyer or seller'}`, revenuePerDeal: fact(price), gaps: ['NO_CHANNEL'], permissionsMissing: [] });

function portfolio(over: Partial<GoalPortfolio> = {}, simulatedSimPrice = 75): GoalPortfolio {
  return {
    basis: 'COVERAGE', worlds: 2_000, best: BEST, alternatives: [], pricedBest: null,
    demand: [demand('arr_github', 10_000, ['price']), demand('arr_domain', simulatedSimPrice, ['price']), demand('arr_domain2', simulatedSimPrice, ['price'])],
    limits: { target: 10_000, deadlineDays: 16, startingCapital: 375, perArrangement: 375, spendCeiling: 3_000, contactsPerDay: { value: null, low: 10, high: 930, source: 'test' }, correlation: 0.5 },
    missing: [], searched: 1, ...over,
  } as unknown as GoalPortfolio;
}

const pathwayReading = (): PathwayReading => ({ portfolio: { leading, fallback: null, unfunded: [], gaps: [], permissions: [], note: 'provisional' }, pathways: [pathway('arr_github', 10_000), pathway('arr_domain', 75), pathway('arr_domain2', 75)] }) as unknown as PathwayReading;

const candidate = (over: Partial<NonNullable<PlanAcceptance['candidate']>> = {}): PlanAcceptance =>
  ({ status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, shortfalls: [], sentence: '', candidate: { label: 'the leading pair', opportunityIds: ['arr_domain', 'arr_domain2'], source: 'PATHWAYS', settledP50: null, reach: null, reachBasis: null, ...over } }) as unknown as PlanAcceptance;

function reading(over: Partial<PlanReading> = {}): PlanReading {
  return {
    acceptance: candidate(),
    portfolio: portfolio(),
    pathways: pathwayReading(),
    objective: { outcome: null, basis: 'the plan held was not simulated as a combination, so no outcome is read', tradeOffs: [], goal: null as never, support: null },
    adoption: { source: 'BASELINE', hypothetical: true, reason: "the reconstruction's strongest plan counts money from Constructed: Small and mid-size firms sending year-end client and employee gifts, whose price nobody has established" },
    steps: [{ order: 1, label: 'Reach domain buyers', detail: '', startDay: { low: 0, high: 0 }, cost: null, basis: 'ESTIMATE', owner: 'BRAIN', ownerReason: null, dependsOn: null, kill: '', execution: [], arrangement: { key: 'domain', stage: 'REACH', costSource: 'NONE_HELD' } }],
    lead: { arrangementKey: 'domain', buyers: 'domain buyer or seller — what this buyer pays per unit of work', population: 'pop', price: { basis: 'COMPARABLE', spread: null }, inScope: true },
    reconstruction: null,
    ...over,
  } as unknown as PlanReading;
}

describe('the plan held and the quant engine\'s best are kept apart', () => {
  it('reconciles the audited read: no figure is printed for the held plan that its own run did not produce', () => {
    const r = reading();
    expect(figureContradictions(r)).toEqual([]);
    const f = reconcileFigures(r);
    expect(f.best).toMatchObject({ isPlan: false });
    expect(f.best!.why).toMatch(/counts money from "Constructed: GitHub Inc".*whose price nobody has established/);
    expect(f.leading).toMatchObject({ isPlan: true, simulated: null });
    // The candidate says why it has no median or reach, and that the "best" line is another set of legs.
    expect(candidateLine(r, f)).toMatch(/settled p50 — · reach — \(the simulation did not run exactly these legs together; the quant line's "best" is another set of legs\)/);
    expect(candidateLine(r, f)).not.toMatch(/reach not computed/);
    // The outcome line names the best combination as not the plan, so its 5.3% is never read as the plan's.
    const outcome = outcomeLines(r, f).join('\n');
    expect(outcome).toMatch(/outcome {5}none/);
    expect(outcome).toMatch(/not plan {2}the quant line's "best" \(2 leg\(s\)\) is not the plan held/);
    expect(bestLabel(f)).toMatch(/^\(NOT the plan held: it counts money from/);
  });

  it('refuses a candidate that quotes another combination\'s figures as its own', () => {
    // Before: the committee and the outcome read portfolio.best's median for a candidate the engine never ran.
    const borrowed = reading({ acceptance: candidate({ settledP50: BEST.settledP50, reach: null }) });
    expect(figureContradictions(borrowed)).toContain('the candidate states a simulated figure for legs the simulation never ran together');
    const outcomeWithoutRun = reading({ objective: { outcome: { expected: 2341, upper: 8361, adverse: 334, adverseQuantile: 0.1 }, basis: 'x', tradeOffs: [], goal: null as never, support: null } as never });
    expect(figureContradictions(outcomeWithoutRun)).toContain('an outcome is stated for a plan the simulation never ran');
  });

  it('takes a pathways candidate\'s reach from the same run as its median, never a median beside "not computed"', () => {
    const ran = combo(['arr_domain', 'arr_domain2'], { reach: 0.031, p10: 12, p50: 606, p90: 4200 });
    const pathways = pathwayReading();
    const simulated = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ alternatives: [ran] }), measuredChance: null, considered: [], pathways });
    expect(simulated.candidate).toMatchObject({ source: 'PATHWAYS', settledP50: 606, reach: 0.031, reachBasis: 'COVERAGE' });
    expect(figureContradictions(reading({ acceptance: simulated, portfolio: portfolio({ alternatives: [ran] }), objective: null }))).toEqual([]);
    const unsimulated = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio(), measuredChance: null, considered: [], pathways });
    expect(unsimulated.candidate).toMatchObject({ source: 'PATHWAYS', settledP50: null, reach: null, reachBasis: null });
  });

  it('labels the leading line\'s bounds with the run of exactly its legs, or says none exists', () => {
    const none = renderPathways({ ...pathwayReading(), structures: { remaining: 10_000, currency: 'USD', daysLeft: 16, outreachPerDay: { low: 10, high: 930, stated: false }, minimumNetForOutreach: null, structures: [] }, measures: { pathways: 3, found: 0, constructed: 3, executable: 0, proceedWithoutEngineering: 0, withReachableBuyer: 0, withFulfiller: 0, producedByBrain: 0, withRightsGranted: 0, withCapacity: 0, acquisition: {}, facts: { proven: 0, estimated: 0, unknown: 0 }, constructionMoves: 0, variants: 0 }, pathways: [], informationValue: [], failures: [], nextActions: [] } as unknown as PathwayReading, 12, null).join('\n');
    expect(none).toMatch(/net bounds low\/mid\/high 3\.67\/606\/10000, capped at the gap/);
    expect(none).toMatch(/the simulation did not run exactly these legs, so no p10\/p50\/p90 exists for them/);
    expect(none).not.toMatch(/the plan's p10\/p50\/p90 are the simulation's/);
    const ran = renderPathways({ ...pathwayReading(), structures: { remaining: 10_000, currency: 'USD', daysLeft: 16, outreachPerDay: { low: 10, high: 930, stated: false }, minimumNetForOutreach: null, structures: [] }, measures: { pathways: 3, found: 0, constructed: 3, executable: 0, proceedWithoutEngineering: 0, withReachableBuyer: 0, withFulfiller: 0, producedByBrain: 0, withRightsGranted: 0, withCapacity: 0, acquisition: {}, facts: { proven: 0, estimated: 0, unknown: 0 }, constructionMoves: 0, variants: 0 }, pathways: [], informationValue: [], failures: [], nextActions: [] } as unknown as PathwayReading, 12, { reach: 0.031, settledP10: 12, settledP50: 606, settledP90: 4200 }).join('\n');
    expect(ran).toMatch(/the simulation of exactly these legs settles p10\/p50\/p90 12\/606\/4200 and reaches the target in 3\.1% of worlds/);
  });
});

describe('a simulated price never above the price every other line prints', () => {
  // The audited leg: its pathway prints the reconstruction's p50, $75; the sweep was widened for an unbridged transfer.
  const widened: ModelInput = { value: null, low: 29, high: 193, provenance: 'ASSUMPTION', source: null, note: 'reconstructed, transfer not bridged', inferred: { tier: 'ASSUMED', justified: false, p10: 75, p50: 75, p90: 75, observations: 3 } };

  it('holds an unestablished price at or below the top of its evidenced range, not the widened range\'s centre', () => {
    // Before: the centre of 29–193 is 111, the price the simulation sold at.
    expect(heldCentreOf(widened, 'LOW')).toBe(75);
    let i = 0;
    const rng = () => ((i++ + 0.5) * 0.6180339887) % 1;
    const draw = sampler(widened, rng, 'LOW');
    const draws = Array.from({ length: 2_000 }, draw);
    expect(Math.max(...draws)).toBe(75);
    expect(draws.filter((x) => x === 75).length).toBeGreaterThan(0);
    // A cost or a delay is held at or above it the same way.
    expect(heldCentreOf({ ...widened, inferred: { ...widened.inferred!, p10: 150 } }, 'HIGH')).toBe(150);
    // An evidenced range whose top is above the centre leaves the centre: the sweep stays inside what was evidenced.
    expect(heldCentreOf({ ...widened, inferred: { ...widened.inferred!, p90: 180 } }, 'LOW')).toBe(111);
    // An evidenced end outside the swept range describes another unit: the range's centre stands.
    expect(heldCentreOf({ ...widened, inferred: { ...widened.inferred!, p90: 500 } }, 'LOW')).toBe(111);
    // No reconstruction: the range's centre, as before.
    expect(heldCentreOf({ ...widened, inferred: undefined }, 'LOW')).toBe(111);
  });

  it('flags a demand row priced above its pathway on a price nobody established', () => {
    expect(figureContradictions(reading({ portfolio: portfolio({}, 111) }))).toContain('arr_domain: the simulation sells at 111 a deal, above the 75 at the top of the range its pathway prints, on a price nobody established');
    expect(figureContradictions(reading({ portfolio: portfolio({}, 75) }))).toEqual([]);
  });
});

describe('the header names the leg the steps are written for', () => {
  it('keeps a hypothetical reconstruction\'s leg apart from the steps\' leg', () => {
    const lines = planHeaderLines(reading());
    expect(lines[0]).toBe('  plan        BASELINE · the steps below are for "domain buyer or seller — what this buyer pays per unit of work"');
    expect(lines[1]).toMatch(/^ {4}hypothetical the reconstruction is not the plan, and its legs are not the steps': the reconstruction's strongest plan counts money from Constructed: Small and mid-size firms/);
    expect(figureContradictions(reading())).toEqual([]);
  });

  it('names the openings a step acts on when no arrangement leads, and nothing when no step names one', () => {
    expect(stepsLegOf([{ openings: ['cop_a'] }], null, new Map([['cop_a', 'Pennsylvania DGS statewide contract']]))).toBe('"Pennsylvania DGS statewide contract"');
    expect(stepsLegOf([{}], null)).toBeNull();
    // A lead whose steps are not the arrangement's is not named as the steps' leg.
    expect(stepsLegOf([{ openings: ['cop_a'] }], { key: 'domain', demand: { name: 'domain buyer' } }, new Map([['cop_a', 'Opening A']]))).toBe('"Opening A"');
    expect(figureContradictions(reading({ lead: null, steps: [{ arrangement: { key: 'domain', stage: 'REACH', costSource: 'NONE_HELD' } }] as never }))).toContain('the steps are written for an arrangement the header does not name');
  });
});

describe('the committee\'s evidence figure says what it counts', () => {
  const leg = (id: string, price: number, status: PathFact['status']): CommitteeLeg => ({
    opportunityId: id,
    scope: 'COUNTED',
    pathway: {
      title: 'Constructed: domain buyer or seller', origin: 'CONSTRUCTED', buyer: fact('domain buyers', 'PROVEN'), channel: fact(null, 'UNKNOWN'), offer: fact(null, 'UNKNOWN'), fulfiller: fact(null, 'UNKNOWN'),
      revenuePerDeal: fact(price, status), fulfilmentCost: fact(3.88, 'PROVEN'), acquisitionCost: fact(null, 'UNKNOWN'), volume: fact(null, 'UNKNOWN'), daysToCash: fact(4), capital: fact(0),
      gaps: [], contribution: { p10: 2, p50: 387, p90: 25_981 }, permissionsMissing: [],
    } as unknown as CommitteeLeg['pathway'],
    demand: { deals: { p10: 4, p50: 25, p90: 91 }, price: { p10: 75, p50: 75, p90: 75 }, unestablished: [], capitalAtStart: 0, repeatable: true } as unknown as CommitteeLeg['demand'],
  });
  const input = (presentedHigh: number): CommitteeInput => ({
    evidence: { goalId: 'wst_x', objective: 'settled cash of $10,000', remaining: 10_000, daysLeft: 16, capitalCeiling: null, currency: 'USD', legs: [leg('arr_domain', 16.88, 'PROVEN')] },
    claims: { reach: 0.053, reachBasis: 'COVERAGE', probability: null, portfolioBasis: 'COVERAGE', settledP50: 2341, presentedHigh, adverse: null, pathwayP10: null, keptP50: null, modelChallenge: null },
    tier: 'ROUTINE',
  });

  it('names the $13 as proven facts alone, and the larger figures as resting on assumed prices and volumes', () => {
    const q = reviewRole('QUANT', input(8361));
    const reach = q.defects.find((d) => d.fact === 'reach')!;
    expect(reach.why).toMatch(/^rebuilt from proven facts alone \(a proven price × a proven deal count − cost, one deal where only the buyer is proven\) the legs bring at most \$13/);
    expect(reach.why).toMatch(/which the simulation's figures assume/);
    const owner = reviewRole('OWNER_PROXY', input(8361));
    expect(owner.defects.find((d) => d.fact === 'reach')!.why).toMatch(/on proven facts alone .* evidence supports \$13 of the \$10,000 the goal needs; the simulation's larger figures rest on assumed prices and volumes/);
  });
});
