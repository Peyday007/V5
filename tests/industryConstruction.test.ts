/**
 * Industry construction (§92): from an operator's ambition to a decision.
 *
 * The owner's acceptance test (2026-11-07) is the Metro Detroit last-mile
 * request, item by item A–H. The same engine is then run over two industries
 * with nothing in common with logistics — a labour-only service and an
 * equipment-heavy rental trade — to show the businesses are constructed from
 * positions and evidence, not from a menu about delivery.
 */
import { describe, expect, it } from 'vitest';
import { constructIndustry, renderConstruction, type Construction } from '../server/services/industry/construction/construction.ts';
import { interpretIntent } from '../server/services/industry/construction/intent.ts';
import { lastMileDelivery } from '../server/services/industry/construction/references.ts';
import { constructBusinesses } from '../server/services/industry/construction/businesses.ts';
import { solveEconomics } from '../server/services/industry/construction/economics.ts';
import { MODEL_DIMENSIONS, type Fact, type IndustryEvidence } from '../server/domain/construction.ts';

const DETROIT =
  'I want to enter last-mile logistics in Metro Detroit. I have $10,000-$30,000 available. I want to start generating revenue quickly, ' +
  'without personally making deliveries. Eventually I want a significant logistics company with control over valuable parts of the market. ' +
  'Figure out how I should enter and build toward that.';

const NOW = new Date('2026-11-07T12:00:00Z');
let detroitCache: Construction | null = null;
function detroit(): Construction {
  detroitCache ??= constructIndustry({ intentText: DETROIT, evidence: lastMileDelivery(), now: NOW });
  return detroitCache;
}

describe('1. operator intent', () => {
  it('reads objectives, constraints, horizon and control, and tells hard limits from preferences', () => {
    const i = interpretIntent(DETROIT);
    expect(i.industry).toMatch(/last-mile logistics/);
    expect(i.geography).toBe('Metro Detroit');
    expect(i.capital).toEqual({ low: 10_000, high: 30_000 });
    expect(i.urgency).toBe('IMMEDIATE');
    expect(i.durable).toBe(true);
    expect(i.control).toContain('CHOKEPOINTS');
    expect(i.statedNoPhysicalWork).toBe(true);
    expect(i.requirements.find((r) => r.id === 'capital')?.kind).toBe('HARD');
    expect(i.requirements.find((r) => r.id === 'no_physical_work')?.kind).toBe('HARD');
    expect(i.requirements.find((r) => r.id === 'urgency')?.kind).toBe('PREFERENCE');
    expect(i.requirements.find((r) => r.id === 'durable')?.kind).toBe('PREFERENCE');
    // Quick cash against a durable controlling company is a named conflict, reconciled by sequence.
    expect(i.conflicts.some((c) => c.reconcile === 'SEQUENCE')).toBe(true);
  });

  it('understands the other phrasings the owner gave', () => {
    const heavy = interpretIntent('I want to enter capital-heavy and own the valuable bottlenecks.');
    expect(heavy.capitalAppetite).toBe('HEAVY');
    expect(heavy.control).toEqual(expect.arrayContaining(['CHOKEPOINTS', 'ASSETS']));

    const seq = interpretIntent('I want to begin with brokerage, then gradually control fulfillment.');
    expect(seq.sequence).toEqual(['BROKER', 'FULFILMENT']);
    expect(seq.control).toContain('FULFILMENT');

    const cash = interpretIntent('I have $20,000, want immediate cash flow, and ultimately want a durable enterprise.');
    expect(cash.capital).toEqual({ low: 20_000, high: 20_000 });
    expect(cash.urgency).toBe('IMMEDIATE');
    expect(cash.durable).toBe(true);
    expect(cash.conflicts.length).toBeGreaterThan(0);

    expect(interpretIntent('budget of 10k-30k').capital).toEqual({ low: 10_000, high: 30_000 });
    expect(interpretIntent('I have 10,000 to 30,000 dollars available').capital).toEqual({ low: 10_000, high: 30_000 });
  });

  it('a person’s override replaces what the words said', () => {
    const i = interpretIntent(DETROIT, { capital: { low: 150_000, high: 250_000 }, urgency: 'PATIENT', riskTolerance: 'LOW', control: ['ASSETS'] });
    expect(i.capital).toEqual({ low: 150_000, high: 250_000 });
    expect(i.urgency).toBe('PATIENT');
    expect(i.control).toEqual(['ASSETS']);
    expect(i.requirements.find((r) => r.id === 'capital')?.from).toBe('OVERRIDE');
  });
});

describe('acceptance: last-mile logistics in Metro Detroit', () => {
  it('A. reconstructs the value chain: participants, money, work, capacity, risk and authority', () => {
    const c = detroit();
    expect(c.model.coverage.map((d) => d.dimension)).toEqual([...MODEL_DIMENSIONS]);
    expect(c.model.coverage.every((d) => d.reading !== 'UNKNOWN')).toBe(true);
    const kinds = c.model.valueChain.filter((v) => v.lines.length > 0).map((v) => v.kind);
    expect(kinds).toEqual(expect.arrayContaining(['DEMAND', 'MONEY', 'WORK', 'CAPACITY', 'RISK', 'AUTHORITY']));
    // Facts, estimates and assumptions are told apart; nothing is called verified that a source did not verify.
    expect(c.model.factStatus.ESTIMATE).toBeGreaterThan(0);
    expect(c.model.factStatus.ASSUMPTION).toBeGreaterThan(0);
    expect(c.model.factStatus.VERIFIED).toBe(0);
  });

  it('B. constructs and compares driver recruitment, capacity coordination, subcontracting and direct operation', () => {
    const c = detroit();
    expect(c.businessesConstructed).toBeGreaterThan(20);
    const fam = new Map(c.families.map((f) => [f.family, f]));
    for (const k of ['RECRUIT', 'COORDINATE', 'SUBCONTRACT', 'OPERATE', 'INTRODUCE']) {
      expect(fam.get(k), k).toBeDefined();
      expect(fam.get(k)!.verdict.length).toBeGreaterThan(10);
    }
    // The operator delivering in person is constructed, and refused by the standing rule.
    expect(fam.get('SELF')!.verdict).toMatch(/physical work/);
  });

  it('C. calculates economics and names every unverified contract rate', () => {
    const c = detroit();
    const sub = c.entries.find((e) => e.key.startsWith('PRIME/NETWORK/CONTRACTOR/SINGLE/NONE@local_merchants'))!;
    expect(sub.economics!.mid!.contribution).toBeGreaterThan(0);
    expect(sub.economics!.worst!.contribution).toBeLessThan(sub.economics!.best!.contribution);
    expect(sub.economics!.mid!.firstCashDays).toBeGreaterThan(0);
    expect(sub.economics!.mid!.workingCapital).toBeGreaterThan(0);
    expect(sub.economics!.breakEvenAccounts).not.toBeNull();
    expect(sub.economics!.reconstructed.contribution?.tier).toBeDefined();
    // The merchant rate rests on an assumption, and says so.
    expect(sub.economics!.inputs.find((f) => f.key === 'price_per_unit')!.status).toBe('ASSUMPTION');
    // Amazon's route rate is not public: the entry is unpriced, and the rate it needs is solved for.
    const amazon = c.entries.find((e) => e.key.startsWith('PRIME/EMPLOY/LEASED/SINGLE/NONE@amazon_dsp'))!;
    expect(amazon.viability).toBe('UNPRICED');
    expect(amazon.economics!.unpriced).toEqual(['price_per_unit']);
    const t = amazon.economics!.thresholds.find((x) => x.key === 'price_per_unit')!;
    expect(t.breakEven).toBeGreaterThan(1);
    expect(t.reading).toBe('UNKNOWN_RANGE');
    expect(c.decision.reasoning.some((r) => /Amazon/.test(r) && /breaks even only if/.test(r))).toBe(true);
  });

  it('D. picks the best entry under the capital, time and no-physical-work constraints', () => {
    const c = detroit();
    expect(c.decision.verdict).not.toBe('NO_DEFENSIBLE_STRUCTURE');
    const entry = c.recommended!.stages[0]!;
    expect(entry.business.position.supply).not.toBe('SELF');
    expect(entry.business.excluded).toBeNull();
    expect(entry.economics.worst!.upfront).toBeLessThanOrEqual(30_000);
    // A whole fleet for one account is not the entry: it is shown not viable.
    const fleet = c.entries.find((e) => e.key.startsWith('PRIME/EMPLOY/LEASED/SINGLE/NONE@local_merchants'))!;
    expect(fleet.viability).toBe('NOT_VIABLE');
  });

  it('E. builds a multi-stage strategy whose stages accumulate assets and name their triggers', () => {
    const c = detroit();
    const s = c.recommended!;
    expect(s.stages.length).toBeGreaterThanOrEqual(3);
    expect(s.stages[0]!.accumulated).toEqual(expect.arrayContaining(['CUSTOMER_CONTRACTS', 'SUPPLY_NETWORK']));
    for (const stage of s.stages) expect(stage.advanceWhen.length).toBeGreaterThan(0);
    expect(s.stages.some((st) => st.changeIf.length > 0)).toBe(true);
    // A quick-cash engine keeps running beside a later business.
    expect(s.stages.some((st) => st.alsoRunning.length > 0)).toBe(true);
    // It ends holding valuable control.
    expect(s.control.filter((x) => x.held).length).toBeGreaterThanOrEqual(2);
  });

  it('F. names the first buyer and the first commercial transaction, in the cash journey’s own vocabulary', () => {
    const c = detroit();
    const x = c.execution!;
    expect(x.buyer).toMatch(/merchants/);
    expect(x.firstTransaction).toMatch(/delivery run/);
    expect(x.cashMechanism).toBe('SUBCONTRACTED_FULFILMENT');
    expect(x.structure).toBe('SUBCONTRACT');
    expect(x.priceFloor).toMatch(/never quote below/);
    expect(x.authorizations.join(' ')).toMatch(/approval/);
  });

  it('G. replans when capital, urgency, risk tolerance, control or ambition change', () => {
    const base = detroit();
    const entryOf = (c: Construction) => c.recommended?.stages[0]!.business.key ?? null;
    const rich = constructIndustry({ intentText: DETROIT, evidence: lastMileDelivery(), overrides: { capital: { low: 150_000, high: 250_000 }, control: ['ASSETS', 'FULFILMENT'], urgency: 'PATIENT' }, now: NOW });
    expect(rich.recommended!.stages.some((s) => s.business.position.supply === 'EMPLOY')).toBe(true);
    const careful = constructIndustry({ intentText: DETROIT, evidence: lastMileDelivery(), overrides: { riskTolerance: 'LOW' }, now: NOW });
    expect(careful.recommended!.entryExposure!).toBeLessThanOrEqual(base.recommended!.entryExposure!);
    const broke = constructIndustry({ intentText: DETROIT, evidence: lastMileDelivery(), overrides: { capital: { low: 500, high: 900 } }, now: NOW });
    expect(entryOf(broke)).not.toBe(entryOf(base));
    // A preferred sequence is evaluated beside the best one.
    const seq = constructIndustry({ intentText: `${DETROIT} I want to begin with brokerage, then gradually control fulfillment.`, evidence: lastMileDelivery(), now: NOW });
    expect(seq.preferredSequence).not.toBeNull();
    expect(seq.preferredSequence!.verdict.length).toBeGreaterThan(10);
  });

  it('H. decides, with the economic reason each alternative lost, and challenges the assumptions', () => {
    const c = detroit();
    expect(c.decision.headline).toMatch(/^Enter as: /);
    expect(c.decision.reasoning.filter((r) => r.startsWith('Not ')).length).toBeGreaterThanOrEqual(2);
    expect(c.challenges.length).toBeGreaterThanOrEqual(2);
    expect(c.challenges.some((ch) => ch.verdict !== 'HOLDS')).toBe(true);
    // Research is asked only where its answer can change the decision.
    expect(c.research.some((q) => q.decisive)).toBe(true);
    expect(c.research.some((q) => !q.decisive && /not worth researching/.test(q.because))).toBe(true);
    // Without a goal deadline the demand side still runs beside the sale, never ahead of it.
    expect(c.research.filter((q) => q.besideSale).map((q) => q.key)).toEqual(expect.arrayContaining(['price_per_unit', 'account_units_per_month', 'account_win_rate', 'accounts_reachable']));
    expect(c.research.some((q) => q.besideSale && /not worth researching/.test(q.because))).toBe(false);
    expect(c.execution!.mode).toBe('RESEARCH_BESIDE_SELLING');
  });
});

describe('7–8. execution and learning', () => {
  it('a SQUEEZE goal sells now, with no market-testing phase, and leaves other money goals alone', () => {
    const c = constructIndustry({
      intentText: DETROIT,
      evidence: lastMileDelivery(),
      goal: { id: 'wst_x', title: 'Detroit', daysLeft: 20, remainingCents: 1_000_000, capitalCeiling: 15_000, resources: null },
      otherMoneyGoals: [{ id: 'wst_other', title: 'Collect $10K', policy: 'SQUEEZE' }],
      now: NOW,
    });
    expect(c.execution!.mode).toBe('RESEARCH_BESIDE_SELLING');
    expect(c.execution!.steps[0]).toMatch(/no market-testing phase/);
    // Buyer volume, market size, price, conversion and payment timing are researched while the sale runs.
    const beside = c.research.filter((q) => q.besideSale);
    expect(beside.map((q) => q.key)).toEqual(expect.arrayContaining(['accounts_reachable', 'account_units_per_month', 'price_per_unit', 'account_win_rate', 'buyer_payment_days']));
    expect(beside.every((q) => q.blocksEntry && !/not worth researching/.test(q.because))).toBe(true);
    expect(c.execution!.researchBesideSale).toHaveLength(beside.length);
    expect(c.execution!.steps.at(-1)).toMatch(/^Research beside the sale, never ahead of it: /);
    // None of it is asked first: the offer goes out now.
    expect(c.execution!.steps.some((st) => /^Establish first/.test(st))).toBe(false);
    expect(renderConstruction(c)).toMatch(/RESEARCH BESIDE SALE/);
    expect(c.execution!.otherGoals).toMatch(/unchanged/);
    // The goal's own money ceiling caps the words' capital.
    expect(c.intent.capital!.high).toBe(15_000);
    expect(c.recommended!.stages[0]!.economics.worst!.upfront).toBeLessThanOrEqual(15_000);
  });

  it('reports gross and operating profit, direct and indirect cost, acquisition payback, workers and scaling', () => {
    const sub = detroit().entries.find((e) => e.key.startsWith('PRIME/NETWORK/CONTRACTOR/SINGLE/NONE@local_merchants'))!;
    const m = sub.economics!.mid!;
    expect(m.billings).toBeGreaterThan(m.revenue);
    expect(m.directCost + m.revenue).toBeCloseTo(m.billings, 6);
    expect(m.revenue - m.indirectCost).toBeCloseTo(m.contribution, 6);
    expect(m.acquisitionPerAccount).toBeGreaterThan(0);
    expect(m.acquisitionPaybackMonths).not.toBeNull();
    expect(m.workers).toBeGreaterThanOrEqual(1);
    expect(sub.scaling.map((x) => x.accounts)).toEqual([1, 3, 8, 20]);
    expect(sub.scaling[3]!.worstUpfront!).toBeGreaterThan(sub.scaling[0]!.worstUpfront!);
    expect(sub.economics!.sensitivity[0]!.key).toBe('price_per_unit');
  });

  it('hands the existing qualification every answer a SQUEEZE sale needs', () => {
    const q = detroit().execution!.qualification;
    for (const [k, v] of Object.entries(q)) expect(v, k).toBeTruthy();
    expect(q.requiredCapital).toMatch(/at most \$/);
  });

  it('operational reliability is priced only once it is measured, and then it costs', () => {
    const ev = lastMileDelivery();
    ev.facts.push({ key: 'failure_rate', segment: null, low: 0.08, high: 0.12, status: 'OBSERVED', source: { title: 'first month of runs', url: null, kind: 'OUTCOME' }, measures: 'stops redone at our cost' });
    const b = constructBusinesses(ev).find((x) => x.key.startsWith('PRIME/NETWORK/CONTRACTOR/SINGLE/NONE@local_merchants'))!;
    const withFailures = solveEconomics(b, ev, { accounts: 1 });
    const without = solveEconomics(b, lastMileDelivery(), { accounts: 1 });
    expect(withFailures.inputs.some((f) => f.key === 'failure_rate')).toBe(true);
    expect(without.inputs.some((f) => f.key === 'failure_rate')).toBe(false);
    expect(withFailures.mid!.contribution).toBeLessThan(without.mid!.contribution);
  });

  it('an observed result replaces the estimate, re-derives the decision, and is not researched again', () => {
    const observed: Fact = { key: 'contractor_rate_per_unit', segment: 'local_merchants', low: 13, high: 14, status: 'OBSERVED', source: { title: 'three operators quoted', url: null, kind: 'OUTCOME' }, measures: 'what Metro Detroit owner-operators actually quoted per B2B stop' };
    const ev = lastMileDelivery();
    ev.facts.push(observed);
    const c = constructIndustry({ intentText: DETROIT, evidence: ev, now: NOW });
    const sub = c.entries.find((e) => e.key.startsWith('PRIME/NETWORK/CONTRACTOR/SINGLE/NONE@local_merchants'))!;
    const rate = sub.economics!.inputs.find((f) => f.key === 'contractor_rate_per_unit')!;
    expect(rate.status).toBe('OBSERVED');
    expect(rate.superseded.length).toBe(1);
    expect(sub.economics!.mid!.contribution).toBeLessThan(detroit().entries.find((e) => e.key === sub.key)!.economics!.mid!.contribution);
    expect(c.learning.observed).toHaveLength(1);
    expect(c.learning.superseded).toBe(1);
    expect(c.research.some((q) => q.key === 'contractor_rate_per_unit' && q.segment === 'local_merchants')).toBe(false);
    expect(c.recommended!.stages[0]!.business.key).not.toBe('PRIME/NETWORK/CONTRACTOR/SINGLE/NONE@local_merchants');
  });
});

/* ---------------------------------------------------------------- other industries */

const op = { title: 'operator interview', url: null, kind: 'OPERATOR' } as const;
function fact(key: Fact['key'], low: number, high: number, segment: string | null = null, status: Fact['status'] = 'ESTIMATE'): Fact {
  return { key, segment, low, high, status, source: op, measures: key };
}

/** Commercial cleaning: labour only, no equipment to speak of. */
function cleaning(): IndustryEvidence {
  return {
    industry: 'commercial cleaning',
    geography: 'Columbus',
    workUnit: 'cleaned office-night',
    capacityUnit: 'crew',
    needsEquipment: false,
    provenance: ['test fixture'],
    actors: [
      { id: 'property_managers', name: 'office property managers', role: 'BUYER', description: '', status: 'ESTIMATE', source: op },
      { id: 'cleaning_firms', name: 'cleaning firms short of staff', role: 'BUYER', description: '', status: 'ESTIMATE', source: op },
      { id: 'crews', name: 'independent cleaning crews', role: 'OPERATOR', description: '', status: 'ESTIMATE', source: op },
    ],
    flows: [{ from: 'property_managers', to: 'crews', kind: 'MONEY', terms: 'monthly contract per building', status: 'ESTIMATE', source: op }],
    segments: [
      { actorId: 'property_managers', buys: 'WORK', requires: ['INSURANCE_COVER'], acceptsIntermediary: false, channel: 'property-management associations', firstTransaction: 'one building’s nightly cleaning contract', status: 'ESTIMATE', source: op },
      { actorId: 'cleaning_firms', buys: 'LABOR', requires: [], acceptsIntermediary: true, channel: 'owners of cleaning firms', firstTransaction: 'one placed cleaner', status: 'ESTIMATE', source: op },
    ],
    gates: [{ id: 'bond', name: 'janitorial bond and liability cover', kind: 'INSURANCE', applies: { contract: ['PRIME'] }, upfrontLow: 400, upfrontHigh: 1_200, days: 7, grants: ['INSURANCE_COVER'], status: 'ESTIMATE', source: op }],
    chokepoints: [{ id: 'contracts', name: 'multi-building management contracts', why: 'one contract covers many buildings', controlledBy: ['CUSTOMER_CONTRACTS', 'DELIVERY_RECORD'], status: 'ESTIMATE', source: op }],
    scale: [],
    failures: [],
    adjacencies: [],
    competition: [],
    bargaining: [],
    facts: [
      fact('price_per_unit', 90, 160, 'property_managers'),
      fact('units_per_capacity_day', 2, 3, 'property_managers'),
      fact('contractor_rate_per_unit', 55, 85, 'property_managers'),
      fact('labor_cost_per_day', 160, 220),
      fact('variable_cost_per_day', 10, 20),
      fact('insurance_per_capacity_year', 600, 1_500),
      fact('placement_fee', 250, 600, 'cleaning_firms'),
      fact('placements_per_month', 3, 10),
      fact('recruiting_cost_per_placement', 40, 120),
      fact('buyer_payment_days', 30, 45, 'property_managers'),
      fact('buyer_payment_days', 15, 30, 'cleaning_firms'),
      fact('supplier_payment_days', 7, 14),
      fact('account_units_per_month', 20, 25, 'property_managers'),
      fact('account_win_rate', 0.05, 0.15),
      fact('outreach_cost_per_account', 10, 40),
      fact('sales_cycle_days', 14, 45),
      fact('overhead_per_month', 200, 600),
      fact('manager_cost_per_month', 3_500, 5_000),
      fact('platform_cost_per_month', 100, 400),
      fact('hiring_days', 7, 21),
    ],
  };
}

/** Heavy equipment rental: capital-heavy, owned assets earn by the day. */
function equipmentRental(): IndustryEvidence {
  return {
    industry: 'construction equipment rental',
    geography: 'Phoenix',
    workUnit: 'rented machine-day',
    capacityUnit: 'excavator',
    needsEquipment: true,
    provenance: ['test fixture'],
    actors: [
      { id: 'contractors', name: 'site-work contractors', role: 'BUYER', description: '', status: 'ESTIMATE', source: op },
      { id: 'owners', name: 'owner-operators with idle machines', role: 'OPERATOR', description: '', status: 'ESTIMATE', source: op },
    ],
    flows: [{ from: 'contractors', to: 'owners', kind: 'MONEY', terms: 'day or week rate with operator', status: 'ESTIMATE', source: op }],
    segments: [{ actorId: 'contractors', buys: 'WORK', requires: [], acceptsIntermediary: true, channel: 'estimators at site-work contractors', firstTransaction: 'one operated machine-week on a site', status: 'ESTIMATE', source: op }],
    gates: [],
    chokepoints: [{ id: 'fleet', name: 'machines available on short notice', why: 'contractors pay a premium for same-week availability', controlledBy: ['FLEET', 'DISPATCH_DATA'], status: 'ESTIMATE', source: op }],
    scale: [],
    failures: [],
    adjacencies: [],
    competition: [],
    bargaining: [],
    facts: [
      fact('price_per_unit', 900, 1_400, 'contractors'),
      fact('units_per_capacity_day', 1, 1, 'contractors'),
      fact('pooled_units_per_capacity_day', 1, 1, 'contractors'),
      fact('contractor_rate_per_unit', 650, 900, 'contractors'),
      fact('contractor_day_rate', 650, 900),
      fact('broker_take_rate', 0.08, 0.15),
      fact('labor_cost_per_day', 350, 500),
      fact('asset_lease_per_day', 250, 400),
      fact('asset_lease_deposit', 5_000, 10_000),
      fact('asset_purchase_cost', 120_000, 220_000),
      fact('asset_ownership_cost_per_day', 60, 120),
      fact('variable_cost_per_day', 80, 150),
      fact('insurance_per_capacity_year', 4_000, 9_000),
      fact('buyer_payment_days', 30, 60, 'contractors'),
      fact('supplier_payment_days', 14, 30),
      fact('account_units_per_month', 10, 20, 'contractors'),
      fact('account_win_rate', 0.1, 0.25),
      fact('outreach_cost_per_account', 20, 80),
      fact('sales_cycle_days', 7, 30),
      fact('overhead_per_month', 300, 900),
      fact('manager_cost_per_month', 5_000, 7_000),
      fact('platform_cost_per_month', 100, 500),
      fact('hiring_days', 14, 30),
    ],
  };
}

describe('the same engine, other industries', () => {
  it('commercial cleaning: labour-only positions, a buyer that refuses intermediaries, and a decision', () => {
    const ev = cleaning();
    const businesses = constructBusinesses(ev);
    // No equipment: no leased or owned positions are constructed at all.
    expect(businesses.some((b) => b.position.assets === 'LEASED' || b.position.assets === 'OWNED')).toBe(false);
    expect(businesses.find((b) => b.position.contract === 'INTRODUCE' && b.segment.actorId === 'property_managers')!.excluded).toMatch(/does not pay an intermediary/);
    const c = constructIndustry({ intentText: 'I want to start a commercial cleaning business in Columbus with $8,000, make money soon, and grow it into a large company.', evidence: ev, now: NOW });
    expect(c.decision.verdict).not.toBe('NO_DEFENSIBLE_STRUCTURE');
    expect(c.recommended!.stages[0]!.business.label).not.toMatch(/delivery|van/i);
    expect(c.execution!.buyer).toMatch(/property managers|cleaning firms/);
  });

  it('equipment rental: owned machines are constructed, and refused at entry by the money and the missing record', () => {
    const ev = equipmentRental();
    const c = constructIndustry({ intentText: 'I want to enter construction equipment rental in Phoenix, capital-heavy, owning the machines. I have $40,000.', evidence: ev, now: NOW });
    const owned = c.entries.filter((e) => e.key.includes('/OWNED/'));
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.every((e) => e.viability === 'CANNOT_START')).toBe(true);
    // The capital-heavy preference is challenged rather than obeyed.
    expect(c.challenges.find((ch) => /heavy assets/.test(ch.assumption))?.verdict).not.toBe('HOLDS');
    expect(c.recommended!.stages[0]!.business.position.assets).not.toBe('OWNED');
  });

  it('with no defensible structure, names the decisive obstacle and the nearest better alternative', () => {
    const ev = equipmentRental();
    ev.segments[0]!.acceptsIntermediary = false;
    const c = constructIndustry({ intentText: 'I want to enter construction equipment rental. I have $1,000.', evidence: ev, now: NOW });
    expect(c.decision.verdict).toBe('NO_DEFENSIBLE_STRUCTURE');
    expect(c.decision.decisiveObstacle).toMatch(/\$/);
    expect(c.decision.nearestAlternative).toMatch(/needs/);
  });

  it('an industry nobody has evidenced constructs nothing, invents nothing, and asks the structural questions', () => {
    const empty: IndustryEvidence = { ...cleaning(), industry: 'aquaculture', segments: [], actors: [], flows: [], facts: [], gates: [], chokepoints: [] };
    const c = constructIndustry({ intentText: 'I want to enter aquaculture with $50,000.', evidence: empty, now: NOW });
    expect(c.businessesConstructed).toBe(0);
    expect(c.decision.verdict).toBe('NO_DEFENSIBLE_STRUCTURE');
    expect(c.research.filter((q) => q.decisive).map((q) => q.dimension)).toEqual(expect.arrayContaining(['PARTICIPANTS', 'PRICING']));
  });

  it('an unknown input is never filled in: it is solved for', () => {
    const ev = cleaning();
    ev.facts = ev.facts.filter((f) => !(f.key === 'price_per_unit'));
    const b = constructBusinesses(ev).find((x) => x.key.startsWith('PRIME/NETWORK/NONE/SINGLE/NONE@property_managers'))!;
    const e = solveEconomics(b, ev, { accounts: 1 });
    expect(e.viability).toBe('UNPRICED');
    expect(e.mid).toBeNull();
    const t = e.thresholds.find((x) => x.key === 'price_per_unit')!;
    // Break-even: contractor rate plus the fixed costs spread over the account's volume.
    expect(t.breakEven!).toBeGreaterThan(70);
    expect(t.breakEven!).toBeLessThan(120);
  });
});
