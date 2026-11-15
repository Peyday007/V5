/**
 * Surge B, lens Q (Q2-1 … Q2-12) and evaluation finding L-1: reconstruction
 * from defensible evidence can satisfy a plan's evidence requirements, and
 * certification at 90% still needs the evidence to support it.
 *
 *   (1) three independent sized comparables (40/200, 46/200, 36/200) establish
 *       the conversion link, and a tight target yields a QUANTITATIVELY
 *       CONSTRUCTED plan with an honest reach interval;
 *   (2) evidence strong enough for the margin reaches CONFIDENCE_VERIFIED;
 *   (3) unsized-only, single-comparable, assumed or contested inputs never do;
 *   (4) more simulated worlds never raise confidence.
 */
import { describe, expect, it } from 'vitest';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import { inputSample, toScenarioInput } from '../server/services/quant/export.ts';
import { readRate } from '../server/services/quant/knowledge.ts';
import { evaluateGoalPortfolio, inputEvidence, measuredRateInput, sampleSizeOf } from '../server/services/goals/portfolio.ts';
import { assuranceSample, conversionState, judgeAcceptance } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { Observation, QuantityNode } from '../server/domain/quant.ts';

const now = new Date('2026-11-14T00:00:00Z');
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

/** An inferred input exactly as `goalScenario.inferOr` builds one. */
function inferred(key: string, kind: QuantityNode['kind'], values: Observation['value'][], opts: { sameOpportunity?: boolean } = {}): ModelInput {
  const node: QuantityNode = {
    key,
    label: key,
    unit: kind === 'RATE' ? 'share' : 'usd',
    kind,
    min: 0,
    ...(kind === 'RATE' ? { max: 1 } : {}),
    context: { opportunity: 'target', mechanism: 'SERVICE_FEE', industry: 'dental' },
    material: ['mechanism'],
    freshDays: 1095,
    observations: values.map((value, i) => ({
      id: `${key}-src${i}`,
      value,
      // Same mechanism, another opening and industry: immaterial differences, discounted.
      context: opts.sameOpportunity ? { opportunity: 'target', mechanism: 'SERVICE_FEE', industry: 'dental' } : { opportunity: `other${i}`, mechanism: 'SERVICE_FEE', industry: `industry${i}` },
      lineage: [`url:publisher${i}.example/study`],
      source: { kind: 'CLAIM' as const, ref: `claim-${key}-${i}` },
      observedAt: '2026-06-01T00:00:00Z',
    })),
  };
  const est = reconstruct({ nodes: [node] }, key, now).estimates[key]!;
  const exported = toScenarioInput(est);
  return {
    value: null,
    low: est.p05,
    high: est.p95,
    provenance: exported.provenance,
    source: exported.sources[0] ?? null,
    note: `inferred: ${exported.note}`,
    distribution: exported.spec,
    inferred: { tier: est.tier, justified: exported.provenance === 'EVIDENCE', p10: est.p10, p50: est.p50, p90: est.p90, observations: est.used.length, ...inputSample(est) },
  };
}
const counts = (key: string, pairs: Array<[number, number]>) => inferred(key, 'RATE', pairs.map(([successes, trials]) => ({ kind: 'COUNT' as const, successes, trials })));

function opening(over: Partial<ModelledOpportunity>): ModelledOpportunity {
  return {
    opportunity: { id: 'cop_target', title: 'Target opening', projectId: 'p' } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close: fixed(0.2),
    respond: fixed(0.2),
    directCost: fixed(10),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

/** The repro's limits: 100 emails a day, $10,000 kept in 24 days. */
const generous = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '100 emails a day from three warmed mailboxes', worlds: 2000, seed: 7, knowledge: null };
/** The same opening with a tenth of the outreach: the target is reachable, not assured. */
const tight = { ...generous, resources: '10 emails a day' };

function verdict(one: ModelledOpportunity, limits: typeof generous) {
  const portfolio = evaluateGoalPortfolio({ ...limits, openings: [one] });
  // Every other link is established on the fixture; CONVERSION is judged by the same rule the chain uses.
  const missing = conversionState(one).state === 'NONE' ? (['CONVERSION'] as const) : [];
  const acceptance = judgeAcceptance({ achieved: false, chosen: null, portfolio, measuredChance: null, considered: [{ opportunityId: 'cop_target', missing: [...missing] }] });
  return { portfolio, acceptance };
}

const lensClose = counts('close', [[40, 200], [46, 200], [36, 200]]);
const lensRespond = counts('respond', [[40, 200], [44, 200], [38, 200]]);

describe('(1) the lens-Q fixture: sized comparables establish conversion, and a tight plan is constructed, not certified', () => {
  it('three independent sized comparables are TRANSFERRED evidence worth events, not "3 studies"', () => {
    const ev = inputEvidence(lensClose, 'close');
    expect(ev).toMatchObject({ tier: 'COMPARABLE', populations: 3, sizedPopulations: 3, establishes: true, drawable: true });
    expect(ev.events!).toBeGreaterThanOrEqual(20);
    // τ ≥ 0.3 and a t on three studies cap transferred evidence well under the 600 contacts.
    expect(ev.events!).toBeLessThan(100);
    expect(conversionState(opening({ close: lensClose })).state).toBe('TRANSFERRED');
    expect(sampleSizeOf(opening({ close: lensClose, respond: lensRespond }))).toBe(Math.min(ev.events!, inputEvidence(lensRespond, 'respond').events!));
  });

  it('a tight target reads QUANTITATIVELY_CONSTRUCTED with its interval, evidence and the input that limits it', () => {
    const { portfolio, acceptance } = verdict(opening({ close: lensClose, respond: lensRespond }), tight);
    expect(portfolio.basis).toBe('PROBABILITY');
    expect(portfolio.assurance?.status).toBe('RANGE');
    const interval = portfolio.assurance!.parameterInterval!;
    expect(interval.basis).toBe('EVIDENCE');
    expect(interval.low).toBeLessThan(0.9);
    expect(interval.high).toBeGreaterThan(interval.low);
    expect(acceptance.status).toBe('CANDIDATE_ONLY');
    expect(acceptance.verdict).toBe('QUANTITATIVELY_CONSTRUCTED');
    expect(acceptance.probability).toBeNull();
    expect(acceptance.construction?.interval).toEqual(interval);
    expect(acceptance.construction?.evidence.find((e) => e.input === 'close rate')).toMatchObject({ tier: 'COMPARABLE', establishes: true });
    expect(acceptance.sentence).toMatch(/QUANTITATIVELY CONSTRUCTED/);
    // A failed threshold asks for the specific input that limits it, never generic bid/win history (Q2-6).
    const limiting = portfolio.assurance!.limitingInputs!;
    expect(limiting.length).toBeGreaterThan(0);
    expect(['reply rate', 'close rate']).toContain(limiting[0]!.input);
    expect(portfolio.assurance!.researchNeeds!.join(' ')).not.toMatch(/bid\/win/);
    expect(acceptance.construction!.improve[0]).toMatch(/reply rate|close rate/);
  });
});

describe('(2) evidence strong enough for its margin is CONFIDENCE_VERIFIED', () => {
  it("Brain's own measured reply record and five sized close populations at a wide margin", () => {
    const respond = measuredRateInput({ trials: 1200, low: 216, high: 252 });
    const close = counts('close', [[40, 200], [46, 200], [36, 200], [42, 210], [39, 190]]);
    expect(inputEvidence(respond, 'respond')).toMatchObject({ tier: 'HISTORICAL', establishes: true, events: 1200 });
    const { portfolio, acceptance } = verdict(opening({ close, respond }), generous);
    expect(portfolio.assurance?.status).toBe('CLAIMS_AT_LEAST_90');
    expect(acceptance.status).toBe('ACCEPTED');
    expect(acceptance.verdict).toBe('CONFIDENCE_VERIFIED');
    expect(acceptance.probability?.basis).toBe('EVIDENCED_PORTFOLIO');
    expect(acceptance.probability!.lowerBound).toBeGreaterThanOrEqual(0.9);
    // The sample is read from the structured assurance, in events (Q2-12).
    expect(acceptance.probability!.sample).toBe(assuranceSample(portfolio.assurance));
    expect(acceptance.probability!.sample).toBeGreaterThanOrEqual(20);
  });

  it('the lens fixture at the repro limits (2,100 contacts for 7 deals, a 12× margin) is quantitatively constructed, and certifies only once an independent check agrees (CHAL-33)', () => {
    /*
     * One opening carries every dollar, so the plan earns a deep review
     * (CHAL-33, `quant/challenge.ts`): three sized comparables make a strong
     * construction, but a 90% claim resting on one dependency is held until
     * an independent check — another model, held-out evidence or Brain's own
     * history — agrees. Stricter than the margin alone, never weaker: the
     * history-backed case above still certifies.
     */
    const { portfolio, acceptance } = verdict(opening({ close: lensClose, respond: lensRespond }), generous);
    expect(acceptance.verdict).toBe('QUANTITATIVELY_CONSTRUCTED');
    expect(acceptance.status).not.toBe('ACCEPTED');
    expect(JSON.stringify(portfolio)).toMatch(/independent check|deep review/);
  });
});

describe('(3) weak evidence never reaches CONFIDENCE_VERIFIED, however wide the margin', () => {
  const cases: Array<[string, ModelInput]> = [
    ['unsized published rates only', inferred('close', 'RATE', [{ kind: 'POINT', value: 0.2 }, { kind: 'POINT', value: 0.22 }, { kind: 'POINT', value: 0.18 }])],
    ['an unsized published range', inferred('close', 'RATE', [{ kind: 'RANGE', low: 0.1, high: 0.25 }], { sameOpportunity: true })],
    ['a single comparable population', counts('close', [[400, 2000]])],
    ['an assumed range', { value: null, low: 0.1, high: 0.3, provenance: 'ASSUMPTION', source: null, note: 'a person said so' }],
    ['a fixed rate with no stated sample', fixed(0.2)],
    ['contradicting sized sources (L-1)', counts('close', [[40, 200], [180, 200]])],
  ];
  for (const [label, close] of cases) {
    it(label, () => {
      const ev = inputEvidence(close, 'close');
      expect(ev.establishes).toBe(false);
      expect(conversionState(opening({ close })).state).toBe('NONE');
      const { portfolio, acceptance } = verdict(opening({ close, respond: lensRespond }), generous);
      expect(portfolio.assurance?.claimsAtLeast90).toBe(false);
      expect(acceptance.verdict).not.toBe('CONFIDENCE_VERIFIED');
      expect(acceptance.status).not.toBe('ACCEPTED');
      expect(acceptance.verdict).toBe('IMPROVEMENT_REQUIRED');
      // What to improve is named for the input itself.
      expect(ev.need).toMatch(/close rate/);
    });
  }
});

describe('(4) simulated worlds alone never raise confidence', () => {
  it('a fixed behavioural rate states no sample at 2,000 or 16,000 worlds', () => {
    for (const worlds of [2000, 16000]) {
      const { portfolio } = verdict(opening({ close: fixed(0.2), respond: lensRespond }), { ...generous, worlds });
      expect(portfolio.assurance?.claimsAtLeast90).toBe(false);
    }
  });
  it("the lens plan's lower end does not climb with the number of worlds", () => {
    const lows = [500, 4000].map((worlds) => verdict(opening({ close: lensClose, respond: lensRespond }), { ...tight, worlds }).portfolio.assurance!.parameterInterval!.low);
    for (const low of lows) expect(low).toBeLessThan(0.9);
    expect(Math.abs(lows[0]! - lows[1]!)).toBeLessThan(1e-9);
  });
});

describe('L-1: contradicting sources are CONTESTED, widened, and surfaced', () => {
  it('$8K and $45K for one quantity are not pooled into a confident direct distribution', () => {
    const node: QuantityNode = {
      key: 'contract_value',
      label: 'contract value',
      unit: 'usd',
      kind: 'POSITIVE',
      context: { opportunity: 'target' },
      observations: [
        { id: 'a', value: { kind: 'POINT', value: 8000 }, context: { opportunity: 'target' }, lineage: ['url:a.example/x'], source: { kind: 'CLAIM', ref: 'ca' } },
        { id: 'b', value: { kind: 'POINT', value: 45000 }, context: { opportunity: 'target' }, lineage: ['url:b.example/y'], source: { kind: 'CLAIM', ref: 'cb' } },
      ],
    };
    const est = reconstruct({ nodes: [node] }, 'contract_value', now).estimates['contract_value']!;
    expect(est.contested?.ids.sort()).toEqual(['a', 'b']);
    expect(est.distributionJustified).toBe(false);
    // Widened to the disagreement: the interval spans both sources, not a tight pooled centre.
    expect(est.p10).toBeLessThan(12000);
    expect(est.p90).toBeGreaterThan(30000);
    expect(est.trace.join(' ')).toMatch(/CONTESTED/);
    const exported = toScenarioInput(est);
    expect(exported.provenance).not.toBe('EVIDENCE');
    expect(exported.note).toMatch(/CONTESTED/);
  });

  it('a contested close rate is CONTESTED with both sources named, and asks for the contradiction to be resolved', () => {
    const close = counts('close', [[40, 200], [180, 200]]);
    const ev = inputEvidence(close, 'close');
    expect(ev.tier).toBe('CONTESTED');
    expect(ev.unverifiable).toMatch(/close-src0.*close-src1|close-src1.*close-src0/);
    expect(ev.need).toMatch(/resolve the contradiction/);
  });
});

describe('Q2-5: a sized published rate keeps its sample; an unsized range is spread, not precision', () => {
  it('reads "x of N", "n=N" and "N leads … X%"', () => {
    expect(readRate('In a 2025 study of 200 qualified leads, 20% converted (n=200).', 'close')).toEqual({ kind: 'POINT', value: 0.2, sampleSize: 200 });
    expect(readRate('40 of 200 contacts agreed to buy.', 'close')).toEqual({ kind: 'COUNT', successes: 40, trials: 200 });
    expect(readRate('Across 1,200 prospects the close rate was 12%.', 'close')).toEqual({ kind: 'POINT', value: 0.12, sampleSize: 1200 });
    expect(readRate('A 12% close rate is typical.', 'close')).toEqual({ kind: 'POINT', value: 0.12 });
  });
  it('an unsized range alone is bounds only, even on the opening\'s own card', () => {
    const est = inferred('close', 'RATE', [{ kind: 'RANGE', low: 0.1, high: 0.25 }], { sameOpportunity: true });
    expect(est.provenance).not.toBe('EVIDENCE');
    expect(est.distribution?.kind).toBe('RANGE');
  });
});

describe("Q2-4: Brain's own TRANSFERABLE record binds as HISTORICAL with a posterior", () => {
  it('is a drawn distribution with its trials as the sample, never UNKNOWN', () => {
    const r = measuredRateInput({ trials: 500, low: 10, high: 25 });
    expect(r.provenance).toBe('HISTORICAL');
    expect(r.distribution?.kind).toBe('EMPIRICAL');
    expect(r.inferred?.events).toBe(500);
    expect(r.low!).toBeLessThan(0.03);
    expect(r.high!).toBeGreaterThan(0.04);
  });
});
