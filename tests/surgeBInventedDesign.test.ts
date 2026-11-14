/**
 * Lens S, S-11 (Surge B, 2026-11-14): a design Brain's reasoning model invents
 * — a new buyer, a new way of being paid — reaches the plan's candidate set.
 *
 * Before, an "invented" method could only re-parameterise the four operations
 * on openings already held; a new buyer population or mechanism became an
 * `ask` in the search brief and never a candidate. Now a method may carry a
 * transaction design tuple and a buyer population; it is composed by the one
 * construction path (`composeInvented` → `compose`), converted into an
 * estimated arrangement whose every input is unestablished, and brought into
 * the plan by the existing INCLUDE move. It is never given a number the model
 * said, and a plan resting on it can never be certified.
 */
import { describe, expect, it } from 'vitest';
import { composeInvented, type InventionContext, type InventedDesign } from '../server/services/cash/construct.ts';
import { inventedFromArrangement } from '../server/services/cash/goalScenario.ts';
import { targetProperties, type GoalLimits } from '../server/services/cash/properties.ts';
import { evaluateGoalPortfolio, inputEvidence, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { exploreDirections, parseDesign, parseInvented, type ExploreContext } from '../server/services/goals/reasoning/directions.ts';
import { inventDirections } from '../server/services/goals/reasoning/invent.ts';
import type { StrategyState, VariantReading } from '../server/services/goals/reconstruction.ts';
import type { Observation } from '../server/domain/quant.ts';
import type { LaneConfig } from '../server/services/cheap/lane.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS } from './fixtures/goal10k.ts';

const limits: GoalLimits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, bestReachCents: null };
const price = (id: string, payer: string, value: number): Observation => ({
  id: `opp:${id}`,
  value: { kind: 'POINT', value },
  context: { payer, industry: 'services', arrangement: 'held' },
  lineage: [`opp:${id}`],
  source: { kind: 'CASH_OPPORTUNITY', ref: id },
  measures: `the price on ${id}`,
});
/** What construction reads, held by hand: published prices from two other buyers, no proved deliverable. */
const context: InventionContext = {
  opportunities: [],
  priced: [price('o1', 'regional law firms', 400), price('o2', 'property managers', 1200)],
  tiedUp: [],
  capability: null,
  input: { projectId: 'prj_invent', currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 30, limits },
  limits,
  targets: targetProperties(limits).map((one) => one.property),
  exclusions: [],
  now: new Date('2026-11-14T00:00:00Z'),
};
const otherPrices = [400, 1200];
const designer = (spec: InventedDesign): PlannedOpening | { refused: string } => {
  const made = composeInvented(spec, context);
  return 'refused' in made ? made : inventedFromArrangement(made, { projectId: 'prj_invent', currency: 'USD', beforeProofCents: 37_500, otherPrices });
};
const newBuyers: InventedDesign = { design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' }, population: 'independent veterinary clinics', need: 'after-hours phone coverage' };

describe('S-11: an invented design is composed by construction, on honest inputs', () => {
  it('composes a new buyer population into an estimated arrangement whose inputs are unknown, never certified', () => {
    const made = composeInvented(newBuyers, context);
    expect('refused' in made).toBe(false);
    const arrangement = made as Exclude<typeof made, { refused: string }>;
    // The population is a part the world is asked for: nothing about it is evidenced, and its own value is unknown.
    expect(arrangement.demand).toMatchObject({ from: 'REVERSE', claimId: null });
    expect(arrangement.evidenced).toBe(0);
    expect(arrangement.value.tier).toBe('UNKNOWN');
    expect(arrangement.unknownParts).toEqual(expect.arrayContaining(['buyers', 'value', 'conversion']));
    const opening = designer(newBuyers) as PlannedOpening;
    expect('refused' in opening).toBe(false);
    expect(opening.estimated).toMatchObject({ invented: true, tier: 'MECHANISM' });
    expect(opening.opportunity.title).toMatch(/^Invented: independent veterinary clinics/);
    // Its price is other buyers' published prices, swept as bounds: provenance UNKNOWN, no distribution.
    expect(opening.price).toMatchObject({ value: null, low: 400, high: 1200, provenance: 'UNKNOWN' });
    expect(opening.price.distribution).toBeUndefined();
    for (const field of ['price', 'close', 'respond', 'volume', 'daysToCash', 'directCost', 'capital'] as const) {
      const ev = inputEvidence(opening[field], field);
      expect(ev.establishes, field).toBe(false);
      expect(['MECHANISM', 'ASSUMED', 'UNKNOWN']).toContain(ev.tier);
    }
    // A portfolio holding it is coverage of assumptions, never a probability.
    const p = evaluateGoalPortfolio({ ...GOAL_10K_LIMITS, openings: [GOAL_10K_OPENINGS[4]!, opening], worlds: 120, seed: 5 });
    expect(p.basis).toBe('COVERAGE');
  });

  it('refuses a malformed or inadmissible design with its reason', () => {
    expect(parseDesign({ structure: 'REFERRAL', funding: 'PREPAID', population: 'dentists' })).toEqual({ refused: expect.stringMatching(/incoherent/) });
    expect(parseDesign({ structure: 'TELEPORT', population: 'dentists' })).toEqual({ refused: expect.stringMatching(/no structure/) });
    expect(parseDesign({ structure: 'BROKER', repeat: 'FOREVER', population: 'dentists' })).toEqual({ refused: expect.stringMatching(/outside the vocabulary/) });
    expect(parseDesign({ structure: 'BROKER' })).toEqual({ refused: expect.stringMatching(/no buyer population/) });
    // Shape-valid, but construction refuses: a deliverable Brain has not proved, a design incoherent at the tuple, nothing to price it by.
    expect(designer({ ...newBuyers, design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' } })).toEqual({ refused: expect.stringMatching(/deliverable/) });
    expect(designer({ ...newBuyers, design: { base: 'POOL', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' } })).toEqual({ refused: expect.stringMatching(/coherent/) });
    const made = composeInvented(newBuyers, context);
    expect(inventedFromArrangement(made as Exclude<typeof made, { refused: string }>, { projectId: 'p', currency: 'USD', beforeProofCents: null, otherPrices: [] })).toEqual({ refused: expect.stringMatching(/nothing bounds/) });
    // A method whose design is malformed is refused whole, with the reason recorded.
    const parsed = parseInvented(JSON.stringify({ methods: [{ name: 'Bad', stance: 'NEW_BUYER', thinking: 't', program: [], design: { structure: 'REFERRAL', funding: 'PREPAID', population: 'dentists' } }] }), { operators: [], openings: [], designs: { structures: [], funding: [], aggregation: [], repeat: [] } });
    expect(parsed.directions).toHaveLength(0);
    expect(parsed.refused).toBe(1);
    expect(parsed.rejections[0]).toMatch(/"Bad": .*incoherent/);
    // Without the vocabulary offered, a design is not accepted.
    expect(parseInvented(JSON.stringify({ methods: [{ name: 'X', stance: 'S', thinking: 't', design: newBuyers }] }), { operators: [], openings: [] }).refused).toBe(1);
  });
});

describe('S-11: the invented design reaches the plan’s candidate set through INCLUDE', async () => {
  const openings = GOAL_10K_OPENINGS.slice(3, 6) as PlannedOpening[];
  const base: StrategyState = { openings, committed: 0, changes: [] };
  const read = (state: StrategyState): VariantReading => {
    const p = evaluateGoalPortfolio({ ...GOAL_10K_LIMITS, openings: state.openings, worlds: 100, seed: 7, causal: false });
    const b = p.best;
    return { key: state.changes.map((c) => c.label).join('|'), changes: state.changes, reach: b?.reach ?? 0, settledP10: b?.settledP10 ?? 0, settledP50: b?.settledP50 ?? 0, settledP90: b?.settledP90 ?? 0, basis: p.basis, committed: state.committed, feasible: !!b, why: null, members: b?.members.map((m) => m.opportunityId) ?? [] };
  };
  const baseline = read(base);
  const lane: LaneConfig = { url: 'http://lane.invalid', key: null, models: ['a'], dailyBudget: 100, timeoutMs: 1000 };
  let prompt = '';
  const completer = async (_c: LaneConfig, _m: string, _s: string, p: string) => {
    prompt = p;
    return JSON.stringify({
      methods: [
        { name: 'Vet clinics as a new buyer', stance: 'NEW_BUYER', thinking: 'A population nobody holds, brokered to answering services.', from: 'BASELINE', program: [], design: { structure: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT', population: 'independent veterinary clinics', need: 'after-hours phone coverage', price: 999999 } },
        { name: 'Incoherent referral', stance: 'BROKEN_DESIGN', thinking: 'a referral the buyer prepays', program: [], design: { structure: 'REFERRAL', funding: 'PREPAID', population: 'dentists' } },
        { name: 'Unproved production', stance: 'MAKE_IT', thinking: 'Brain produces what it never proved', program: [], design: { structure: 'PRODUCE', population: 'independent bookshops' } },
      ],
    });
  };
  const ctx: ExploreContext = {
    base,
    greedy: base,
    greedyReading: baseline,
    baselineReading: baseline,
    operators: [],
    operatorsFor: () => [],
    evaluate: async (state) => read(state),
    required: 0.9,
    remaining: GOAL_10K_LIMITS.remaining,
    daysLeft: 30,
    binding: [],
    structural: false,
    threads: 1,
    maxMs: 60_000,
    invent: (brief) => inventDirections(brief, { config: lane, completer, calls: 1, env: {} }),
    design: designer,
  };
  const x = await exploreDirections(ctx);

  it('offers the design vocabulary, and composes the invented design into the evaluated candidates as an assumption', () => {
    expect(prompt).toMatch(/NEW arrangement nobody holds/);
    expect(prompt).toMatch(/structure: PRODUCE/);
    const row = x.all.find((r) => r.direction.name === 'Vet clinics as a new buyer');
    expect(row).toBeDefined();
    expect(row!.direction.origin).toBe('MODEL');
    expect(row!.direction.program.at(-1)).toMatchObject({ op: 'INCLUDE' });
    const invented = row!.state!.openings.find((o) => o.estimated?.invented);
    expect(invented).toBeDefined();
    // The figure the model put on its design is ignored: the price is bounds from published prices only.
    expect(invented!.price).toMatchObject({ low: 400, high: 1200, provenance: 'UNKNOWN' });
    expect(invented!.marketKey).toMatch(/^arr_market:invented:/);
    // Brought in as an assumption: the plan without it is what holds on no assumption, and its reading is coverage.
    expect(row!.state!.changes.at(-1)).toMatchObject({ basis: 'ASSUMPTION' });
    expect(row!.reading.basis).toBe('COVERAGE');
  });

  it('records why each malformed or inadmissible invention was refused', () => {
    expect(x.model.rejections).toEqual(expect.arrayContaining([expect.stringMatching(/"Incoherent referral": .*incoherent/), expect.stringMatching(/"Unproved production": .*deliverable/)]));
    expect(x.model.refused).toBeGreaterThanOrEqual(2);
    expect(x.all.some((r) => r.direction.name === 'Incoherent referral' || r.direction.name === 'Unproved production')).toBe(false);
  });
});
