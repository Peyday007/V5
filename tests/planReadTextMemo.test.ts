/**
 * W15 (2026-11-17): production stalled 10–20 s of every 120 s. The stall
 * profiles put `canonical` (planSet.ts) at 2.8–4.9 s and `payerNamedIn`
 * (industry.ts) at 2.1 s of every 60 s. `buildPlanSet` canonicalised both
 * candidates' five dimensions and every member's customers for every pair, and
 * `comparablePricesFor` re-read who pays on every held price for every
 * arrangement: candidates² and arrangements × prices regex readings. Each
 * reader is pure in its one string, so it now reads each string once, and the
 * answers are the same.
 */
import { describe, expect, it } from 'vitest';
import { memoStats, memoText } from '../server/domain/textMemo.ts';
import { buildPlanSet, candidateFromArrangement, canonical, rebuildAfter, type AcceptanceCondition } from '../server/services/goals/planSet.ts';
import { comparablePricesFor, type ComparablePrice } from '../server/services/cash/goalScenario.ts';
import { buyerPopulationName, payerNamedIn } from '../server/domain/industry.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';

const kinds = ['landlords', 'dental practices', 'dog groomers', 'law firms', 'restaurants', 'gyms', 'plumbers', 'accountants', 'school districts', 'county governments'];
const structures = ['BROKER', 'PRODUCE', 'SUBCONTRACT', 'POOL'] as const;
// A fixed population of names, however many arrangements read them: what a plan read sees.
function arrangements(n: number): ConstructedArrangement[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `k${i}`, structure: structures[i % 4],
    design: { base: structures[i % 4], funding: ['ON_DELIVERY', 'DEPOSIT', 'THRESHOLD_PRESALE'][i % 3], aggregation: ['SINGLE_BUYER', 'POOLED_BUYERS'][i % 2], repeat: ['ONE_OFF', 'SUBSCRIPTION', 'RECURRING_COHORT'][i % 3] },
    origin: 'FORWARD', precedent: null, sector: `Sector ${i % 23}`,
    demand: { name: `${kinds[i % kinds.length]} in region ${i % 41}`, claimId: null, from: 'INDUSTRY_MAP', ref: `ind_${i}` }, need: null,
    supply: i % 3 ? { name: `Supplier ${i % 17} Services, Inc.`, from: 'MAP', claimId: null } : null, label: `Arrangement ${i}`,
    properties: [], targetsMet: [], emergent: [], stress: { exposure: 'BOUNDED', worstCaseCents: i % 2 ? null : 30_000, failures: [] }, evidenced: 0,
    value: { tier: 'COMPARABLE', p10: 300, p50: 800 + i, p90: 2_000, observations: 3 }, unknownParts: ['buyers'], relatedOpenings: [], question: 'q',
  })) as unknown as ConstructedArrangement[];
}
const condition: AcceptanceCondition = { amount: 10_000, daysLeft: 30, confidence: 0.9, capitalCeiling: null, breadth: null, objective: { expected: 1, upside: 0.25, downside: 0.25, velocity: 0.25, independence: 0.25 } };
const payers = ['The payer is the City of Harrisburg, Pennsylvania 17110', 'Homeowners pay $2,500 per project', 'PA PUC Bureau of Technical Utility Services issued RFP 2026-01', 'owner of a small bakery in Austin', 'Dental practices, Mechanicsburg, PA'];
const prices: ComparablePrice[] = Array.from({ length: 300 }, (_, i) => ({ value: 100 + (i % 97) * 10, industry: `Industry ${i % 31}`, mechanism: 'PRODUCTIZED_SERVICE', payer: `${payers[i % payers.length]} ${i % 29}` }));

describe('a plan read reads each name once (W15)', () => {
  it('remembers a pure reader per string, and starts over past its bound', () => {
    let reads = 0;
    const read = memoText('test:upper', (s: string) => {
      reads += 1;
      return s.toUpperCase();
    }, 3);
    expect([read('a'), read('a'), read('b'), read('a')]).toEqual(['A', 'A', 'B', 'A']);
    expect(reads).toBe(2);
    read('c');
    read('d'); // past the bound: the table starts over
    expect(read('d')).toBe('D');
    expect(memoStats('test:upper')).toMatchObject({ calls: 7 });
  });

  it('builds the plan set with canonical work bounded by the distinct names, not by candidate pairs', () => {
    const small = arrangements(40).map((a) => candidateFromArrangement(a));
    const large = arrangements(400).map((a) => candidateFromArrangement(a));
    buildPlanSet(small, condition);
    const before = memoStats('canonical');
    const set = buildPlanSet(large, condition);
    rebuildAfter(large, { kind: 'SUPPLIER_FAILED', supplier: 'Supplier 3 Services, Inc.' }, condition);
    const after = memoStats('canonical');
    // Hundreds of groups compared pairwise ...
    expect(set.distinct).toBeGreaterThan(100);
    // ... and the regex reading ran once per distinct name: at most a few per candidate, never per pair.
    expect(after.computed - before.computed).toBeLessThanOrEqual(large.length * 8);
    // A canonical form is the same answer however often it is asked.
    expect(canonical('Dental Practices, the Services')).toBe(canonical('practice dental'));
  });

  it('reads who pays once per payer however many arrangements compare with it', () => {
    const before = memoStats('buyerPopulationName');
    for (const a of arrangements(50)) comparablePricesFor(a, prices, 'USD');
    const mid = memoStats('buyerPopulationName');
    for (const a of arrangements(400)) comparablePricesFor(a, prices, 'USD');
    const after = memoStats('buyerPopulationName');
    const distinct = new Set(prices.map((p) => p.payer)).size;
    expect(mid.computed - before.computed).toBeLessThanOrEqual(distinct);
    // Eight times the arrangements reads no new payer.
    expect(after.computed - mid.computed).toBe(0);
    // Same answers as ever.
    expect(payerNamedIn('Homeowners pay $2,500 per project')).toBe('Homeowners');
    expect(buyerPopulationName('owner of a small bakery in Austin')).toBe('small bakery owners');
    expect(payerNamedIn(null)).toBeNull();
    expect(buyerPopulationName(undefined)).toBeNull();
  });
});
