/**
 * The quantitative inference engine (§79), against the cases the brief names
 * A–N, each in a different industry so a rule that secretly needed one subject
 * fails on the others. Every case asserts the property, not the picture: which
 * rung answered, what was refused and why, what the numbers are within the
 * tolerance the arithmetic allows.
 */
import { describe, expect, it } from 'vitest';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import { collapseLineage, classify, onScale, pool } from '../server/services/quant/pool.ts';
import { composeArrangement } from '../server/services/quant/mechanism.ts';
import { optimizePortfolio, type Activity } from '../server/services/quant/portfolio.ts';
import { informationValue } from '../server/services/quant/value.ts';
import { decideResearch, quantifyRouteMoney, routeInputsFromEntries, scoreRoutes, CASH_IDENTITIES } from '../server/services/quant/deadline.ts';
import { toScenarioInput } from '../server/services/quant/export.ts';
import { solveProblem, type QuantProblem } from '../server/services/quant/problem.ts';
import { runScenarioModel } from '../server/services/scenario/run.ts';
import type { Observation, QuantityNode } from '../server/domain/quant.ts';
import type { CashMoneyEntry } from '../server/domain/types.ts';

const now = new Date('2026-10-31T00:00:00Z');
const src = (ref: string) => ({ kind: 'URL' as const, ref });
const point = (id: string, value: number, context: Record<string, string>, lineage = [id], extra: Partial<Observation> = {}): Observation => ({ id, value: { kind: 'POINT', value }, context, lineage, source: src(`https://example.test/${id}`), ...extra });
const count = (id: string, successes: number, trials: number, context: Record<string, string>, lineage = [id], extra: Partial<Observation> = {}): Observation => ({ id, value: { kind: 'COUNT', successes, trials }, context, lineage, source: src(`https://example.test/${id}`), ...extra });

describe('A. exact evidence exists: no reconstruction is done', () => {
  it('stops at DIRECT and never resolves the parts it declared (freight factoring payment terms)', () => {
    const target = { lane: 'freight-factoring', region: 'US' };
    const node: QuantityNode = {
      key: 'days_to_cash', label: 'Days to usable cash', unit: 'days', kind: 'POSITIVE', context: target, material: ['lane'],
      observations: [point('factor_a', 2, target), point('factor_b', 2.2, target)],
      formula: 'invoice_days + transfer_days',
    };
    const parts: QuantityNode[] = [
      { key: 'invoice_days', label: 'Invoice', unit: 'days', kind: 'POSITIVE', min: 0, max: 90 },
      { key: 'transfer_days', label: 'Transfer', unit: 'days', kind: 'POSITIVE', min: 0, max: 10 },
    ];
    const r = reconstruct({ nodes: [node, ...parts] }, 'days_to_cash', now);
    const est = r.estimates.days_to_cash!;
    expect(est.tier).toBe('DIRECT');
    expect(est.p50).toBeGreaterThan(1.8);
    expect(est.p50).toBeLessThan(2.4);
    expect(r.notNeeded.sort()).toEqual(['invoice_days', 'transfer_days']);
    expect(est.trace[0]).toMatch(/nothing further was reconstructed/);
  });
});

describe('B. no exact evidence, comparables suffice (commercial window cleaning)', () => {
  it('pools comparable populations, discounted for immaterial differences, and stays a distribution', () => {
    const target = { service: 'window-cleaning', segment: 'office', city: 'detroit' };
    const node: QuantityNode = {
      key: 'repeat_rate', label: 'Share of clients who rebook', unit: 'share', kind: 'RATE', context: target, material: ['service', 'segment'], sufficientWidth: 0.25,
      observations: [
        count('cleveland', 120, 200, { ...target, city: 'cleveland' }),
        count('columbus', 66, 110, { ...target, city: 'columbus' }),
        count('toledo', 90, 150, { ...target, city: 'toledo' }),
      ],
    };
    const est = reconstruct({ nodes: [node] }, 'repeat_rate', now).estimates.repeat_rate!;
    expect(est.tier).toBe('COMPARABLE');
    expect(est.distributionJustified).toBe(true);
    expect(est.p50).toBeGreaterThan(0.5);
    expect(est.p50).toBeLessThan(0.7);
    // A new city is not the average city: the spread floor widens it.
    expect(est.heterogeneity).toBeGreaterThanOrEqual(0.3);
  });
});

describe('C and D. comparables inadequate, so the quantity is rebuilt from parts, recursively (equipment rental)', () => {
  it('refuses the mismatched comparable, rebuilds from components, and climbs a level deeper for one of them', () => {
    const target = { asset: 'skid-steer', market: 'rural' };
    const graph = {
      nodes: [
        {
          key: 'monthly_revenue', label: 'Monthly rental revenue', unit: 'USD', kind: 'POSITIVE', context: target, material: ['asset'],
          // A figure about excavators: a different asset, no adjustment — refused.
          observations: [point('excavator_rev', 9000, { asset: 'excavator', market: 'rural' })],
          formula: 'rented_days * day_rate',
        },
        { key: 'rented_days', label: 'Days rented per month', unit: 'days', kind: 'POSITIVE', min: 0, max: 31, formula: 'available_days * utilisation' },
        { key: 'available_days', label: 'Days available', unit: 'days', kind: 'POSITIVE', observations: [point('calendar', 26, {})] },
        { key: 'utilisation', label: 'Utilisation', unit: 'share', kind: 'RATE', context: target, material: ['asset'], observations: [count('dealer_survey', 55, 100, target), count('coop_report', 140, 250, target)] },
        { key: 'day_rate', label: 'Day rate', unit: 'USD', kind: 'POSITIVE', context: target, material: ['asset'], observations: [point('rate_card_1', 280, target), point('rate_card_2', 310, target)] },
      ] as QuantityNode[],
    };
    const r = reconstruct(graph, 'monthly_revenue', now);
    const top = r.estimates.monthly_revenue!;
    expect(top.excluded[0]!.reason).toMatch(/different asset.*no adjustment/);
    expect(top.tier).toBe('COMPONENT');
    expect(top.children.sort()).toEqual(['day_rate', 'rented_days']);
    // D: rented_days itself was rebuilt from its own parts.
    expect(r.estimates.rented_days!.tier).toBe('COMPONENT');
    expect(r.estimates.available_days!.tier).toBe('DIRECT');
    // 26 × ~0.56 × ~295 ≈ 4,300
    expect(top.p50).toBeGreaterThan(3500);
    expect(top.p50).toBeLessThan(5200);
    expect(top.distributionJustified).toBe(true);
  });

  it('refuses a self-referencing graph rather than looping', () => {
    const nodes: QuantityNode[] = [
      { key: 'a', label: 'a', unit: 'x', kind: 'POSITIVE', formula: 'b * 2' },
      { key: 'b', label: 'b', unit: 'x', kind: 'POSITIVE', formula: 'a / 2' },
    ];
    expect(() => reconstruct({ nodes }, 'a', now)).toThrow(/defined in terms of itself/);
  });
});

describe('E. two studies that share data are counted once (SaaS churn)', () => {
  it('collapses observations with intersecting lineage and does not narrow on the duplicate', () => {
    const ctx = { product: 'smb-accounting' };
    const survey = count('survey_2025', 30, 400, ctx, ['industry-panel-2025']);
    const article = count('trade_article', 31, 410, ctx, ['industry-panel-2025', 'press']);
    const independent = count('vendor_filing', 25, 300, ctx, ['10-K']);
    const scaled = classify({ key: 'churn', label: 'c', unit: 's', kind: 'RATE', context: ctx, observations: [survey, article, independent] }, now).direct;
    const { kept, collapsed } = collapseLineage(scaled);
    expect(kept).toHaveLength(2);
    expect(collapsed).toEqual([['survey_2025', 'trade_article']]);
    const honest = pool(kept, 0)!;
    const doubleCounted = pool(scaled, 0)!;
    expect(honest.se).toBeGreaterThan(doubleCounted.se);
  });
});

describe('F. similar conversion figures from materially different buyers (B2B bookkeeping vs consumers)', () => {
  const target = { offer: 'bookkeeping', buyer: 'small-business' };
  const consumerFigure = count('consumer_tax_prep', 40, 200, { offer: 'bookkeeping', buyer: 'consumer' });
  it('refuses the transfer when nothing bridges the population difference', () => {
    const est = reconstruct({ nodes: [{ key: 'conv', label: 'conv', unit: 'share', kind: 'RATE', context: target, material: ['buyer'], observations: [consumerFigure] }] }, 'conv', now).estimates.conv!;
    expect(est.excluded[0]!.reason).toMatch(/different buyer \(consumer, target small-business\)/);
    expect(est.tier).toBe('UNKNOWN');
  });
  it('uses it only through a sourced adjustment, and the adjustment widens it', () => {
    const est = reconstruct({ nodes: [{
      key: 'conv', label: 'conv', unit: 'share', kind: 'RATE', context: target, material: ['buyer'], observations: [consumerFigure],
      adjustments: [{ dimension: 'buyer', from: 'consumer', to: 'small-business', factorLow: 0.3, factorHigh: 0.6, source: src('https://example.test/b2b-vs-b2c') }],
    }] }, 'conv', now).estimates.conv!;
    expect(est.tier).toBe('COMPARABLE');
    // ~20% × 0.3–0.6 → around 9%, never the raw 20%.
    expect(est.p50).toBeGreaterThan(0.05);
    expect(est.p50).toBeLessThan(0.13);
  });
});

const fixed = (n: number, cash: number, days: number) => ({ cash: new Array<number>(n).fill(cash), days: new Array<number>(n).fill(days) });

describe('G. plausible economics, but the money arrives after the deadline (municipal snow-removal contract)', () => {
  it('contributes nothing to a 30-day target even though the cash exceeds it', () => {
    const r = optimizePortfolio({ target: 10_000, deadlineDays: 30, activities: [{ key: 'city_contract', label: 'net-45 city contract', justified: true, ...fixed(500, 15_000, 45) }] });
    expect(r.best!.reach).toBe(0);
    expect(r.best!.settledP90).toBe(0);
  });
});

describe('H. individually viable activities that compete for one resource (event staffing)', () => {
  it('refuses the combination that needs more hours than exist, and names why', () => {
    const activities: Activity[] = [
      { key: 'wedding_staffing', label: 'w', justified: true, uses: { owner_hours: 40 }, ...fixed(200, 11_000, 10) },
      { key: 'conference_staffing', label: 'c', justified: true, uses: { owner_hours: 40 }, ...fixed(200, 12_000, 12) },
    ];
    const r = optimizePortfolio({ target: 10_000, deadlineDays: 30, capacity: { owner_hours: 50 }, activities });
    expect(r.refused[0]!.reason).toMatch(/needs 80 owner_hours and only 50/);
    expect(r.best!.keys).toHaveLength(1);
  });
});

describe('I. complementary activities reach a target none reaches alone (B2B lead lists + map digitisation)', () => {
  it('finds the combination, and counts capital recycled from early cash', () => {
    const activities: Activity[] = [
      { key: 'lead_lists', label: 'l', justified: true, capital: 300, startDay: 0, ...fixed(300, 6_000, 6) },
      { key: 'map_digitising', label: 'm', justified: true, capital: 900, startDay: 8, ...fixed(300, 5_000, 10) },
    ];
    const r = optimizePortfolio({ target: 10_000, deadlineDays: 30, startingCapital: 500, activities });
    for (const single of r.singles) expect(single.reach).toBe(0);
    expect(r.best!.keys.sort()).toEqual(['lead_lists', 'map_digitising']);
    // 500 starting capital funds only the first; the second runs on the first's returned cash.
    expect(r.best!.reach).toBe(1);
    expect(r.best!.capitalShort).toBe(0);
  });

  it('does not sum chances: correlated activities fail together', () => {
    const worlds = 1_000;
    const noisy = (key: string): Activity => ({ key, label: key, justified: true, riskGroup: 'local-economy', cash: Array.from({ length: worlds }, (_, i) => (i % 2 === 0 ? 0 : 6_000)), days: new Array(worlds).fill(5) });
    const together = optimizePortfolio({ target: 12_000, deadlineDays: 30, riskCorrelation: { 'local-economy': 0.95 }, activities: [noisy('a'), noisy('b')], worlds: 4_000 }).best!;
    const apart = optimizePortfolio({ target: 12_000, deadlineDays: 30, riskCorrelation: { 'local-economy': 0 }, activities: [noisy('a'), noisy('b')], worlds: 4_000 }).best!;
    expect(together.reach).toBeGreaterThan(apart.reach + 0.15);
    expect(apart.reach).toBeGreaterThan(0.2);
    expect(apart.reach).toBeLessThan(0.3);
  });
});

describe('J. new evidence changes the ranking and everything downstream recomputes', () => {
  const problem = (extra: Observation[]): QuantProblem => ({
    title: 'two plays',
    currency: 'USD',
    graphs: [
      { key: 'gutter', graph: { nodes: [{ key: 'cash', label: 'cash', unit: 'USD', kind: 'POSITIVE', observations: [point('g1', 7_000, {}), point('g2', 7_600, {})] }] } },
      { key: 'sealing', graph: { nodes: [{ key: 'cash', label: 'cash', unit: 'USD', kind: 'POSITIVE', context: { job: 'driveway' }, observations: [point('s1', 3_000, { job: 'driveway' }), ...extra] }] } },
    ],
    portfolio: { target: 10_000, deadlineDays: 30, capacity: { crew: 1 }, activities: [
      { key: 'gutter', graph: 'gutter', cashNode: 'cash', days: 5, uses: { crew: 1 } },
      { key: 'sealing', graph: 'sealing', cashNode: 'cash', days: 5, uses: { crew: 1 } },
    ] },
  });
  it('picks one play, then the other once a new observation lands', () => {
    const before = solveProblem(problem([]), now);
    expect(before.portfolio!.best!.keys).toEqual(['gutter']);
    const after = solveProblem(problem([point('s2', 14_000, { job: 'driveway' }), point('s3', 15_000, { job: 'driveway' })]), now);
    expect(after.portfolio!.best!.keys).toEqual(['sealing']);
  });
});

describe('K. an arrangement with no business-model statistics (idle box trucks matched to furniture stores)', () => {
  it('is composed from independently evidenced parts and yields a contribution estimate', () => {
    const composed = composeArrangement({
      key: 'truckmatch', label: 'Idle box trucks for furniture deliveries', period: 'month', currency: 'USD',
      demand: {
        buyers: { observations: [point('store_count', 60, {})] },
        needRate: { observations: [point('deliveries_per_store', 4, {}), point('deliveries_per_store_2', 5, {})] },
        reach: { observations: [count('stores_reachable', 35, 60, {})] },
        conversion: { observations: [count('pilot_replies', 6, 40, {})] },
      },
      supply: { units: { observations: [point('idle_truck_days', 120, {})] }, acceptance: { observations: [count('owner_survey', 18, 30, {})] } },
      value: { observations: [point('delivery_price', 140, {}), point('delivery_price_2', 160, {})] },
      capture: { kind: 'COMMISSION', rate: { observations: [count('broker_take', 20, 100, {})] } },
      cost: { observations: [point('dispatch_cost', 6, {})] },
    });
    const r = reconstruct(composed.graph, composed.contribution, now);
    const est = r.estimates[composed.contribution]!;
    expect(est.tier).toBe('COMPONENT');
    expect(est.distributionJustified).toBe(true);
    // 60 × 4.5 × 0.58 × 0.15 ≈ 24 transactions (demand-limited) × (150 × 0.2 − 6) ≈ 570
    expect(est.p50).toBeGreaterThan(250);
    expect(est.p50).toBeLessThan(1_200);
    expect(r.estimates.truckmatch_transactions!.p50).toBeLessThan(r.estimates.truckmatch_supply!.p50);
  });
});

describe('L. a question whose answer would not change the decision is abandoned', () => {
  it('measures zero value and decides to ignore it', () => {
    const n = 1_000;
    const irrelevant = Array.from({ length: n }, (_, i) => i);
    const decisive = Array.from({ length: n }, (_, i) => (i * 7919) % n);
    const iv = informationValue({
      inputs: [{ key: 'colour_of_van', values: irrelevant }, { key: 'reply_rate', values: decisive }],
      actions: [
        { key: 'mailer', scores: decisive.map((x) => (x > 500 ? 1 : 0)) },
        { key: 'cold_call', scores: decisive.map((x) => (x <= 500 ? 0.8 : 0.2)) },
      ],
    });
    const byKey = Object.fromEntries(iv.inputs.map((one) => [one.key, one]));
    expect(byKey.colour_of_van!.value).toBe(0);
    expect(byKey.colour_of_van!.changesDecision).toBe(false);
    expect(byKey.reply_rate!.changesDecision).toBe(true);
    expect(decideResearch({ key: 'colour_of_van', informationValue: 0, changesDecision: false, researchDays: 1, learnableInExecution: false }, { daysLeft: 30, executionDaysP90: 10 }).decision).toBe('IGNORE');
  });

  it('does not wait for research that would cost the deadline', () => {
    const calendar = { daysLeft: 12, executionDaysP90: 10 };
    expect(decideResearch({ key: 'reply_rate', informationValue: 0.3, changesDecision: true, researchDays: 7, learnableInExecution: true }, calendar).decision).toBe('LEARN_WHILE_EXECUTING');
    expect(decideResearch({ key: 'permit_fee', informationValue: 0.3, changesDecision: true, researchDays: 7, learnableInExecution: false }, calendar).decision).toBe('ACT_ON_RECONSTRUCTION');
    expect(decideResearch({ key: 'permit_fee', informationValue: 0.3, changesDecision: true, researchDays: 1, learnableInExecution: false }, calendar).decision).toBe('RESEARCH_FIRST');
  });
});

describe('M. broad evidence is too weak for a probability (specialty food co-packing)', () => {
  it('yields bounds only, exports a range, and a run over it is a sweep', () => {
    const node: QuantityNode = {
      key: 'margin', label: 'Gross margin', unit: 'share', kind: 'RATE', context: { sector: 'co-packing' }, material: ['sector'],
      observations: [point('all_manufacturing', 0.3, {}, ['bea'], { broad: true }), point('all_food', 0.25, {}, ['usda'], { broad: true })],
    };
    const est = reconstruct({ nodes: [node] }, 'margin', now).estimates.margin!;
    expect(est.tier).toBe('MECHANISM');
    expect(est.distributionJustified).toBe(false);
    const exported = toScenarioInput(est);
    expect(exported.spec.kind).toBe('RANGE');
    expect(exported.provenance).toBe('UNKNOWN');
    const result = runScenarioModel(
      {
        title: 'co-packing', currency: 'USD', horizon: 'a month',
        variables: [
          { key: 'margin', label: 'm', unit: 'share', provenance: exported.provenance, controllable: false, spec: exported.spec },
          { key: 'sales', label: 's', unit: 'USD', provenance: 'EVIDENCE', controllable: false, spec: { kind: 'FIXED', value: 20_000 } },
        ],
        lines: [{ key: 'gross', label: 'gross', kind: 'REVENUE', expr: 'sales * margin' }],
        strategies: [{ key: 'run', label: 'run', set: {} }],
      },
      { seed: 1, evaluations: 2_000 },
    );
    expect(result.basis).toBe('SWEEP');
    expect(result.probabilistic).toBe(false);
  });
});

describe('N. a numerically consistent model that rests on invalid transfers', () => {
  it('does not treat a source that omits a material dimension as matching it', () => {
    const node: QuantityNode = {
      key: 'reply', label: 'Reply rate', unit: 'share', kind: 'RATE', context: { channel: 'cold-email', buyer: 'property-manager' }, material: ['channel', 'buyer'],
      // Arithmetic would happily use these; neither says who the buyers were.
      observations: [count('blog_benchmark', 30, 1000, { channel: 'cold-email' }), count('vendor_claim', 80, 1000, { channel: 'cold-email' })],
    };
    const est = reconstruct({ nodes: [node] }, 'reply', now).estimates.reply!;
    expect(est.excluded).toHaveLength(2);
    for (const one of est.excluded) expect(one.reason).toMatch(/does not state its buyer/);
    expect(est.tier).toBe('UNKNOWN');
    expect(est.distributionJustified).toBe(false);
  });

  it('marks stale evidence and does not use it', () => {
    const node: QuantityNode = { key: 'price', label: 'p', unit: 'USD', kind: 'POSITIVE', freshDays: 365, observations: [point('old_quote', 100, {}, ['q'], { observedAt: '2021-01-01T00:00:00Z' })] };
    const est = reconstruct({ nodes: [node] }, 'price', now).estimates.price!;
    expect(est.excluded[0]!.reason).toMatch(/stale/);
    expect(est.tier).toBe('UNKNOWN');
  });
});

describe('scale conversions are honest about sample size', () => {
  it('weights a counted rate by its trials, and an unsized one as four events whatever its size', () => {
    const sized = onScale(count('a', 50, 1000, {}), 'RATE')!;
    const unsized = onScale(point('b', 0.05, {}), 'RATE')!;
    const rare = onScale(point('c', 0.0045, {}), 'RATE')!;
    expect(sized.v).toBeLessThan(unsized.v);
    expect(rare.v).toBeCloseTo(unsized.v, 10);
    expect(unsized.v).toBeCloseTo(0.25, 10);
    expect(unsized.unsized).toBe(true);
    expect(sized.unsized).toBeFalsy();
    // A ratio of two published amounts about one case is not a sampled rate.
    expect(onScale({ ...point('d', 0.3, {}), value: { kind: 'POINT', value: 0.3, exact: true } }, 'RATE')!.unsized).toBeFalsy();
  });
});

describe('information value inside the scenario engine', () => {
  it('reports which sampled input could change the choice of strategy, and none for a fixed one', () => {
    const result = runScenarioModel(
      {
        title: 'two offers', currency: 'USD', horizon: 'a month',
        variables: [
          { key: 'rate_a', label: 'a', unit: 'share', provenance: 'UNKNOWN', controllable: false, spec: { kind: 'RANGE', min: 0, max: 0.4 } },
          { key: 'noise', label: 'n', unit: 'share', provenance: 'UNKNOWN', controllable: false, spec: { kind: 'RANGE', min: 0, max: 1 } },
          { key: 'pick', label: 'pick', unit: 'flag', provenance: 'ASSUMPTION', controllable: true, spec: { kind: 'FIXED', value: 0 } },
        ],
        lines: [{ key: 'cash', label: 'cash', kind: 'REVENUE', expr: 'if(pick, rate_a * 1000, 200) + noise * 0' }],
        strategies: [{ key: 'a', label: 'a', set: { pick: 1 } }, { key: 'safe', label: 's', set: { pick: 0 } }],
      },
      { seed: 7, evaluations: 4_000, informationValue: { metric: 'contribution' } },
    );
    const iv = result.informationValue!;
    const byKey = Object.fromEntries(iv.inputs.map((one) => [one.key, one]));
    expect(byKey.rate_a!.changesDecision).toBe(true);
    expect(byKey.rate_a!.value).toBeGreaterThan(0);
    expect(byKey.noise!.value).toBe(0);
    expect(iv.basis).toBe('SWEEP');
  });
});

describe('the demonstration file: two unrelated mechanisms, one engine, no special case', () => {
  it('reconstructs both from cited parts, refuses the transfers it should, and finds the late payer', async () => {
    const { readFileSync } = await import('node:fs');
    const problem = JSON.parse(readFileSync('plans/quant/two-mechanisms-2026-10-31.json', 'utf8')) as QuantProblem;
    const s = solveProblem(problem, now);
    const by = (graph: string, key: string) => s.estimates.find((one) => one.graph === graph && one.key === key)!;
    // Platform averages of mixed lists do not transfer to net-new contacts without an adjustment.
    expect(by('books', 'reply_rate').excluded.map((one) => one.id).sort()).toEqual(['digitalbloom_range', 'instantly_2026', 'scrapine_median']);
    expect(by('books', 'reply_rate').tier).toBe('DIRECT');
    // Only broad, undated surveys say how many offices hold a party: bounds only.
    expect(by('trucks', 'trucks_need_rate').tier).toBe('MECHANISM');
    expect(by('books', 'books_value').tier).toBe('COMPONENT');
    expect(by('books', 'books_contribution').justified).toBe(false);
    // December lunches pay after a 27-day deadline whatever else is true.
    const trucksAlone = s.portfolio!.singles.find((one) => one.keys[0] === 'trucks')!;
    expect(trucksAlone.reach).toBe(0);
    expect(trucksAlone.basis).toBe('COVERAGE');
    expect(by('trucks', 'trucks_days').p10).toBeGreaterThan(27);
  });
});

describe('one comparable population is an anecdote', () => {
  it('bounds the answer and never exports a distribution', () => {
    const node: QuantityNode = { key: 'cost_share', label: 'c', unit: 'share', kind: 'RATE', context: { opportunity: 'o2', mechanism: 'service' }, material: ['mechanism'], observations: [point('other_opening', 0.4, { opportunity: 'o1', mechanism: 'service' })] };
    const est = reconstruct({ nodes: [node] }, 'cost_share', now).estimates.cost_share!;
    expect(est.tier).toBe('COMPARABLE');
    expect(est.distributionJustified).toBe(false);
    expect(toScenarioInput(est).spec.kind).toBe('RANGE');
    // Two unsized published rates locate it, but nobody measured their precision.
    const two = reconstruct({ nodes: [{ ...node, observations: [...node.observations!, point('third', 0.5, { opportunity: 'o3', mechanism: 'service' })] }] }, 'cost_share', now).estimates.cost_share!;
    expect(two.distributionJustified).toBe(false);
    expect(two.trace.join(' ')).toMatch(/no stated sample/);
    // Two measured ones are a pattern.
    const measured = (id: string, s: number, opp: string) => ({ ...point(id, s / 50, { opportunity: opp, mechanism: 'service' }), value: { kind: 'COUNT' as const, successes: s, trials: 50 } });
    const counted = reconstruct({ nodes: [{ ...node, observations: [measured('a', 20, 'o1'), measured('b', 25, 'o3')] }] }, 'cost_share', now).estimates.cost_share!;
    expect(counted.distributionJustified).toBe(true);
  });
});

describe('Q. one quantity feeding two formulas is one quantity (seasonal home services, 2026-11-02)', () => {
  const nodes: QuantityNode[] = [
    { key: 'orders', label: 'Orders', unit: 'orders', kind: 'POSITIVE', min: 5, max: 50 },
    { key: 'price', label: 'Price', unit: 'USD', kind: 'POSITIVE', min: 100, max: 300 },
    { key: 'revenue', label: 'Revenue', unit: 'USD', kind: 'POSITIVE', min: 0, formula: 'orders * price' },
    { key: 'cost', label: 'Cost', unit: 'USD', kind: 'POSITIVE', min: 0, formula: 'orders * 40' },
    { key: 'lights', label: 'Lights', unit: 'USD', kind: 'POSITIVE', min: 0, formula: 'orders * 100' },
    { key: 'trees', label: 'Trees', unit: 'USD', kind: 'POSITIVE', min: 0, formula: 'orders * 60' },
    { key: 'both', label: 'Both lines', unit: 'USD', kind: 'POSITIVE', min: 0, formula: 'lights + trees' },
  ];

  it('gives a shared input one value per world across separate formula nodes and separate calls', () => {
    const revenue = reconstruct({ nodes }, 'revenue', now).estimates.revenue!;
    const cost = reconstruct({ nodes }, 'cost', now).estimates.cost!;
    const orders = reconstruct({ nodes }, 'orders', now).estimates.orders!;
    for (let i = 0; i < 200; i++) expect(cost.samples[i]!).toBeCloseTo(orders.samples[i]! * 40, 6);
    // Revenue per order is the price, so it can never fall below 100 if orders and cost are paired.
    for (let i = 0; i < 200; i++) expect(revenue.samples[i]! / (cost.samples[i]! / 40)).toBeGreaterThanOrEqual(100 - 1e-6);
  });

  it('does not diversify two lines driven by the same demand', () => {
    const both = reconstruct({ nodes }, 'both', now).estimates.both!;
    // Fully dependent: both = orders × 160, so its spread is the whole orders spread (p90/p10 ≈ 45.5/9.5).
    expect(both.p90 / both.p10).toBeGreaterThan(4);
  });
});

describe('R. a spending ceiling binds on the world, not the average (prepaid local lines)', () => {
  it('counts a world over the ceiling as missing the target, and says how often it happened', () => {
    const n = 1_000;
    const cash = Array.from({ length: n }, (_, i) => 5_000 + 10 * i); // 5,000 … 14,990
    const spend = cash.map((c) => c * 0.4); // outflows scale with sales
    const act: Activity = { key: 'home', label: 'home', justified: true, cash, days: new Array(n).fill(10), spend };
    const free = optimizePortfolio({ target: 10_000, deadlineDays: 30, activities: [act], worlds: 4_000 }).best!;
    const capped = optimizePortfolio({ target: 10_000, deadlineDays: 30, spendCeiling: 3_000, activities: [act], worlds: 4_000 }).best!;
    expect(free.reach).toBeGreaterThan(0.45);
    // Reaching 10,000 needs 4,000 of outflows, so no world under a 3,000 ceiling reaches it.
    expect(capped.reach).toBe(0);
    // Outflows pass 3,000 once cash passes 7,500: three worlds in four.
    expect(capped.overSpend).toBeGreaterThan(0.7);
    expect(capped.overSpend).toBeLessThan(0.8);
  });

  it('refuses spend samples that are not paired with the cash', () => {
    const act: Activity = { key: 'x', label: 'x', justified: true, cash: [1, 2, 3], days: [1, 1, 1], spend: [1] };
    expect(() => optimizePortfolio({ target: 1, deadlineDays: 30, activities: [act] })).toThrow(/paired/);
  });
});

describe('MONEY-13-4. route money velocity and distinct cash identities (equipment rental, wedding catering, SaaS resale)', () => {
  it('walks outflows and receipts in time order for peak working capital, receivables and usable cash', () => {
    const m = quantifyRouteMoney({
      routeKey: 'equipment-rental',
      leadAt: '2026-01-01T00:00:00Z',
      commitmentAt: '2026-01-11T00:00:00Z',
      usableCashAt: '2026-01-16T00:00:00Z',
      events: [
        { at: '2026-01-11T00:00:00Z', kind: 'BILLING', amount: 1_000 },
        { at: '2026-01-12T00:00:00Z', kind: 'SUPPLIER_OUTLAY', amount: 300, fundedBy: 'SELF' },
        { at: '2026-01-13T00:00:00Z', kind: 'SUPPLIER_OUTLAY', amount: 200, fundedBy: 'CUSTOMER' },
        // Receipt dated with an offset: string order would put it after the outlays it precedes in time.
        { at: '2026-01-14T01:00:00+02:00', kind: 'FUNDS_RECEIVED', amount: 600 },
        { at: '2026-01-15T00:00:00Z', kind: 'SUPPLIER_OUTLAY', amount: 400 },
      ],
    });
    expect(m.customerFundedSpend).toBe(200);
    expect(m.selfFundedSpend).toBe(300);
    expect(m.unattributedSpend).toBe(400);
    expect(m.daysLeadToCommitment).toBe(10);
    expect(m.daysCommitmentToFunds).toBeCloseTo(2 + 23 / 24, 9);
    expect(m.daysFundsToUsableCash).toBeCloseTo(2 + 1 / 24, 9);
    expect(m.receivables).toBe(400);
    // -300, -500 (low), +600 → 100, -400 → -300: the deepest overlap is 500.
    expect(m.peakWorkingCapital).toBe(500);
    expect(m.usableCash).toBe(600);
    expect(m.excludedFromUsable).toBe(0);
    expect(m.supplierOutlays.map((o) => o.amount)).toEqual([300, 200, 400]);
    expect(m.unknowns).toContain('some supplier outlays do not say who funded them');
  });

  it('orders same-instant movements drain-first so the peak is never understated', () => {
    const m = quantifyRouteMoney({ routeKey: 'same-day', events: [
      { at: '2026-03-01T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: 100 },
      { at: '2026-03-01T00:00:00Z', kind: 'SUPPLIER_OUTLAY', amount: 250, fundedBy: 'SELF' },
    ] });
    expect(m.peakWorkingCapital).toBe(250);
  });

  it('treats an advance received beyond billings as zero receivables, never negative', () => {
    const m = quantifyRouteMoney({ routeKey: 'catering-deposit', events: [
      { at: '2026-02-01T00:00:00Z', kind: 'BILLING', amount: 500 },
      { at: '2026-02-01T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: 800 },
    ] });
    expect(m.receivables).toBe(0);
  });

  it('leaves an absent side unknown rather than zero', () => {
    const m = quantifyRouteMoney({ routeKey: 'no-receipts', events: [{ at: '2026-02-01T00:00:00Z', kind: 'BILLING', amount: 500 }] });
    expect(m.receivables).toBeNull();
    expect(m.usableCash).toBeNull();
    expect(m.peakWorkingCapital).toBeNull();
    expect(m.customerFundedSpend).toBeNull();
    expect(m.daysLeadToCommitment).toBeNull();
    expect(m.unknowns).toEqual(expect.arrayContaining([
      'no funds-received row, receivables unknown',
      'no funds-received row, usable cash unknown',
      'no outflow rows, peak working capital unknown',
      'lead-to-commitment time not stated',
    ]));
  });

  it('subtracts a refund of encumbered money once, and reports refunds beyond receipts as a liability', () => {
    const m = quantifyRouteMoney({ routeKey: 'refundable-deposit', events: [
      { at: '2026-04-01T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: 1_000 },
      { at: '2026-04-01T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: 400, encumbered: true },
      { at: '2026-04-05T00:00:00Z', kind: 'REFUND', amount: 150 },
      { at: '2026-04-06T00:00:00Z', kind: 'CHARGEBACK', amount: 50 },
    ] });
    expect(m.refundsAndChargebacks).toBe(200);
    // 1400 received; 200 refunded out of the 400 encumbered; 200 still encumbered.
    expect(m.usableCash).toBe(1_000);
    expect(m.excludedFromUsable).toBe(400);
    expect((m.usableCash ?? 0) + m.excludedFromUsable).toBe(1_400);

    const over = quantifyRouteMoney({ routeKey: 'over-refunded', events: [
      { at: '2026-04-01T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: 100 },
      { at: '2026-04-02T00:00:00Z', kind: 'REFUND', amount: 180 },
    ] });
    expect(over.usableCash).toBe(-80);
    expect(over.unknowns.some((u) => u.includes('exceed funds received by 80'))).toBe(true);
  });

  it('flags a stage dated backwards as inconsistent, not absent', () => {
    const m = quantifyRouteMoney({ routeKey: 'bad-dates', leadAt: '2026-05-10T00:00:00Z', commitmentAt: '2026-05-01T00:00:00Z', events: [] });
    expect(m.daysLeadToCommitment).toBeNull();
    expect(m.unknowns).toContain('lead-to-commitment time is inconsistent: the later event is dated before the earlier one');
  });

  it('keeps the nine cash identities distinct: rows override stated figures, nothing derives one from another', () => {
    const m = quantifyRouteMoney({
      routeKey: 'saas-resale',
      events: [
        { at: '2026-06-01T00:00:00Z', kind: 'BILLING', amount: 900 },
        { at: '2026-06-02T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: 700 },
      ],
      identities: { GROSS_BILLINGS: 1_234, NET_PROFIT: -50, BORROWED_PROCEEDS: 5_000, OWNER_DISTRIBUTIONS: -10 },
    });
    expect(Object.keys(m.identities).sort()).toEqual([...CASH_IDENTITIES].sort());
    expect(m.identities.GROSS_BILLINGS).toBe(900);
    expect(m.identities.SETTLED_CASH).toBe(700);
    expect(m.identities.USABLE_CASH).toBe(700);
    expect(m.identities.NET_PROFIT).toBe(-50);
    expect(m.identities.BORROWED_PROCEEDS).toBe(5_000);
    // Borrowed money never becomes retained cash, profit or enterprise value.
    expect(m.identities.RETAINED_CASH).toBeNull();
    expect(m.identities.ENTERPRISE_VALUE).toBeNull();
    expect(m.identities.GROSS_MARGIN).toBeNull();
    expect(m.identities.OWNER_DISTRIBUTIONS).toBeNull();
    expect(m.unknowns).toEqual(expect.arrayContaining([
      'gross_billings stated value disagrees with the rows, rows used',
      'owner_distributions stated value is not a valid amount, ignored',
      'retained_cash not stated',
    ]));
  });

  it('ranks by the objective and sorts an unknown input last, never as zero', () => {
    const base = (key: string, margin: number | null, peak: number) => ({
      ...quantifyRouteMoney({
        routeKey: key, leadAt: '2026-07-01T00:00:00Z', commitmentAt: '2026-07-03T00:00:00Z', usableCashAt: '2026-07-10T00:00:00Z',
        events: [
          { at: '2026-07-04T00:00:00Z', kind: 'SUPPLIER_OUTLAY', amount: peak, fundedBy: 'SELF' },
          { at: '2026-07-05T00:00:00Z', kind: 'FUNDS_RECEIVED', amount: peak * 2 },
        ],
        identities: margin === null ? {} : { GROSS_MARGIN: margin },
      }),
    });
    const fast = base('fast-small', 300, 100);
    const big = base('slow-big', 1_000, 2_000);
    const unknown = base('unknown-margin', null, 50);
    const byTurnover = scoreRoutes([{ money: big, collectionProbability: 0.9 }, { money: unknown, collectionProbability: 1 }, { money: fast, collectionProbability: 0.9 }], 'TURNOVER');
    expect(byTurnover.map((s) => s.routeKey)).toEqual(['fast-small', 'slow-big', 'unknown-margin']);
    expect(byTurnover[2]!.capitalTurnover).toBeNull();
    const byContribution = scoreRoutes([{ money: fast, collectionProbability: 0.9 }, { money: big, collectionProbability: 0.9 }], 'CONTRIBUTION');
    expect(byContribution.map((s) => s.routeKey)).toEqual(['slow-big', 'fast-small']);
    expect(byContribution[0]!.riskAdjustedContribution).toBeCloseTo(900, 9);
    expect(scoreRoutes([{ money: fast }], 'CONTRIBUTION')[0]!.riskAdjustedContribution).toBeNull();
  });

  it('maps ledger rows to routes: settlement dates usable cash and is never a second receipt', () => {
    const entry = (id: string, opportunityId: string | null, kind: CashMoneyEntry['kind'], cents: number, occurredAt: string, fundsAvailableAt: string | null = null): CashMoneyEntry => ({
      id, projectId: 'p', opportunityId, commitmentId: null, idempotencyKey: null, payloadFingerprint: null, kind, amountCents: cents, currency: 'USD',
      verifiedReference: null, fundsAvailableAt, occurredAt, note: null, recordedBy: 'test', createdAt: occurredAt,
    });
    const inputs = routeInputsFromEntries([
      entry('1', 'opp-a', 'PIPELINE_AGREED', 100_000, '2026-08-02T00:00:00Z'),
      entry('2', 'opp-a', 'PIPELINE_AGREED', 50_000, '2026-08-01T00:00:00Z'),
      entry('3', 'opp-a', 'COST', 30_000, '2026-08-03T00:00:00Z'),
      entry('4', 'opp-a', 'CUSTOMER_PAYMENT', 120_000, '2026-08-05T00:00:00Z'),
      entry('5', 'opp-a', 'SETTLEMENT', 120_000, '2026-08-06T00:00:00Z', '2026-08-08T00:00:00Z'),
      entry('6', 'opp-a', 'REFUND', 10_000, '2026-08-09T00:00:00Z'),
      entry('7', null, 'COST', 99_999, '2026-08-03T00:00:00Z'),
    ]);
    expect(inputs).toHaveLength(1);
    const m = quantifyRouteMoney(inputs[0]!);
    expect(m.routeKey).toBe('opp-a');
    expect(m.identities.GROSS_BILLINGS).toBe(1_500);
    expect(m.identities.SETTLED_CASH).toBe(1_200);
    expect(m.receivables).toBe(300);
    expect(m.unattributedSpend).toBe(300);
    expect(m.selfFundedSpend).toBeNull();
    expect(m.daysCommitmentToFunds).toBe(4);
    expect(m.daysFundsToUsableCash).toBe(3);
    expect(m.daysLeadToCommitment).toBeNull();
    expect(m.usableCash).toBe(1_100);
  });
});
