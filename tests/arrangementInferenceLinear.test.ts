/**
 * W2c (2026-11-17), review of #1038: every arrangement re-keyed every opening
 * by who pays and re-parsed every card fact for each of its inputs, so a plan
 * pass cost arrangements × openings (≈19.6 s for 400 arrangements over 1,000
 * openings and 3,000 facts), and the plan read converted untaken arrangements
 * a second time. The payer index and the parsed facts are built once per
 * knowledge, a known answer is reused without building observations, and the
 * plan candidate reuses selection's conversion. Nothing it answers changes.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { payerKey } from '../server/services/cash/construct.ts';
import { openingsByPayer, selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { arrangementModels } from '../server/services/goals/plan.ts';
import { buyerPopulationName } from '../server/domain/industry.ts';
import type { CashKnowledge } from '../server/services/quant/knowledge.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

const payers = ['Landlords', 'Dental practices', 'Dog groomers', 'Law firms', 'Restaurants', 'Gyms', 'Plumbers', 'Accountants'];
const mechanisms = ['SUPPLY_DEMAND_MISMATCH', 'INFORMATION_ASYMMETRY', 'PRODUCTIZED_SERVICE', 'CAPABILITY_ARBITRAGE', 'SUBCONTRACTED_FULFILMENT'];
const fields = ['conversionRates', 'directCosts', 'timeToFirstCash', 'requiredCapital', 'hours', 'buyerVolume'];
const texts = ['Closed 40 of 200 leads.', 'The contractor is paid $200 for the job.', 'Paid within 14 days.', 'Required capital: $300.', 'Takes 3 hours.', 'About 20 jobs a month.'];

/** A map that counts how often it is walked whole: the cost the index removes. */
class CountingMap<K, V> extends Map<K, V> {
  walks = 0;
  override values(): MapIterator<V> {
    this.walks += 1;
    return super.values();
  }
}

function fixture(openings: number) {
  const opportunities = new CountingMap<string, CashOpportunity>();
  for (let i = 0; i < openings; i++) {
    opportunities.set(`o${i}`, {
      id: `o${i}`, title: `Opening ${i}`, mechanism: mechanisms[i % mechanisms.length], opportunitySignal: 'ACTIVE_BUYER_DEMAND', industry: 'x',
      payer: i % 7 === 0 ? payers[i % payers.length] : `${payers[i % payers.length]} group ${i % 13}`, priceCents: 50_000 + i, currency: 'USD', duplicateOfId: null,
    } as unknown as CashOpportunity);
  }
  const raw = Array.from({ length: openings * 3 }, (_, i) => ({
    id: `f${i}`, projectId: 'p', opportunityId: `o${i % openings}`, field: fields[i % fields.length], kind: 'EVIDENCE', value: texts[i % texts.length], claimId: `c${i}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  })) as unknown as CashCardFact[];
  // Counts every walk of the card facts.
  const factWalks = { n: 0 };
  const facts = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) factWalks.n += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const knowledge = { projectId: 'p', opportunities, facts, lessons: [], sources: new Map(), watermark: '', routeMoney: new Map(), routeScores: new Map(), routeMoneyError: null, estimates: new Map(), learning: null } as unknown as CashKnowledge;
  return { knowledge, opportunities, factWalks };
}

function arrangements(n: number, openings: number): ConstructedArrangement[] {
  const structures = ['BROKER', 'PRODUCE', 'SUBCONTRACT', 'POOL'] as const;
  return Array.from({ length: n }, (_, i) => ({
    key: `k${i}`, structure: structures[i % 4], design: { base: structures[i % 4], funding: 'ON_DELIVERY', aggregation: 'SINGLE_BUYER', repeat: i % 2 ? 'SUBSCRIPTION' : 'ONE_OFF' }, origin: 'FORWARD', precedent: null, sector: 'x',
    demand: { name: payers[i % payers.length], claimId: null, from: 'INDUSTRY_MAP', ref: `ind_${i % 60}` }, need: null, supply: null, label: `Arrangement ${i}`, properties: [], targetsMet: [], emergent: [],
    stress: { exposure: 'BOUNDED', worstCaseCents: null, failures: [] }, evidenced: 0, value: { tier: 'COMPARABLE', p10: 300, p50: 800 + i, p90: 2_000, observations: 3 }, unknownParts: [], relatedOpenings: [`o${i % openings}`], question: 'q',
  })) as unknown as ConstructedArrangement[];
}

const now = new Date('2026-11-17T00:00:00Z');
function pass(n: number, openings: number) {
  const f = fixture(openings);
  const list = arrangements(n, openings);
  const got = selectEstimatedArrangements(list, { projectId: 'p', currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], daysLeft: 30, knowledge: f.knowledge, now });
  return { ...f, list, got };
}

describe('one plan pass over constructed arrangements is linear (W2c)', () => {
  it('walks the openings and the card facts a fixed number of times, however many arrangements read them', () => {
    const small = pass(20, 300);
    const large = pass(200, 300);
    // Ten times the arrangements, the same walks: the index and the parse are per knowledge, not per arrangement.
    expect(large.opportunities.walks).toBe(small.opportunities.walks);
    expect(large.factWalks.n).toBe(small.factWalks.n);
    expect(large.opportunities.walks).toBeLessThanOrEqual(1);
    // One parse per quantity at most.
    expect(large.factWalks.n).toBeLessThanOrEqual(7);
  });

  it('indexes who pays exactly as the per-arrangement scan read it', () => {
    const { knowledge } = fixture(300);
    const index = openingsByPayer(knowledge.opportunities);
    for (const name of [...payers, 'Landlord', 'dental practice', 'Nobody at all']) {
      const buyer = payerKey(name);
      const scanned = [...knowledge.opportunities.values()].filter((o) => !o.duplicateOfId && o.payer && (payerKey(o.payer) === buyer || payerKey(buyerPopulationName(o.payer)) === buyer)).map((o) => o.id);
      expect(index.get(buyer) ?? [], name).toEqual(scanned);
    }
    // Built once: the same index object on every later read.
    expect(openingsByPayer(knowledge.opportunities)).toBe(index);
  });

  it('the plan candidate reuses selection’s conversion of every arrangement instead of converting it again', () => {
    const { list, got } = pass(60, 300);
    expect(got.conversions.size).toBe(60);
    const models = arrangementModels(list, got.openings, { projectId: 'p', currency: 'USD', daysLeft: 30, capitalBeforeProofCents: null }, now, got.conversions);
    for (const a of list) {
      const seen = got.conversions.get(a.key);
      const entered = got.openings.find((o) => o.estimated?.arrangementKey === a.key);
      // The same object, never a second conversion.
      if (entered) expect(models.get(a.key)).toBe(entered);
      else if (seen) expect(models.get(a.key)).toBe(seen);
    }
  });
});
