/**
 * RES-15-4 (S-0148, S-0149, S-0150) in construction: an arrangement that needs supply is
 * expanded into its alternative positions, each with its own decomposed research question
 * asking only what is missing there, plus the position's contracts, rights, liabilities,
 * restrictions and counterparty expectations. An asking-price-only or market-size-only
 * figure gets separate buyer-access and conversion questions.
 */
import { describe, expect, it } from 'vitest';
import {
  arrangementPositionFacts,
  composeConstruction,
  positionResearchQuestions,
  STRUCTURES,
  type ConstructionJob,
  type Primitive,
} from '../server/services/cash/construct.ts';
import { targetProperties, type GoalLimits } from '../server/services/cash/properties.ts';
import { EVIDENCE_FIELD_KEYS, POSITION_KEYS, POSITIONS, resolvePosition } from '../server/services/cash/intermediationPositions.ts';
import type { Estimate } from '../server/domain/quant.ts';

function job(): ConstructionJob {
  const limits: GoalLimits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: 50_000, capitalBeforeProofCents: null, bestReachCents: null };
  const now = new Date('2026-11-14T00:00:00Z');
  const p = (name: string): Primitive => ({ name, claimId: null, from: 'INDUSTRY_MAP', ref: `ref:${name}` });
  return {
    sectors: [{ name: 'facilities', demand: [p('property managers')], needs: [p('recurring floor cleaning')], supply: [p('commercial cleaning crews')] }],
    opportunities: [],
    precedent: [],
    capability: { name: 'documents', claimId: null, from: 'CAPABILITY', ref: 'deliverables' },
    priced: [],
    tiedUp: [],
    input: { projectId: 'p', currency: 'USD', delivers: ['documents'], capitalCeilingCents: 50_000, daysLeft: 30, limits, now },
    limits,
    targets: targetProperties(limits).map((one) => one.property),
    exclusions: [],
    now,
  };
}

const justified = (p10: number, p90: number) => ({ distributionJustified: true, p10, p50: (p10 + p90) / 2, p90 }) as unknown as Estimate;
const demand: Primitive = { name: 'property managers', claimId: 'clm_payer', from: 'INDUSTRY_MAP', ref: 'n1' };
const supply: Primitive = { name: 'commercial cleaning crews', claimId: null, from: 'INDUSTRY_MAP', ref: 'n2' };

describe('a supply-needing arrangement expands into its positions', () => {
  it('yields one named research question per alternative position for every supply-needing arrangement', async () => {
    const out = await composeConstruction(job());
    const intermediated = out.filter((one) => STRUCTURES[one.structure].needsSupply);
    expect(intermediated.length).toBeGreaterThan(0);
    for (const one of intermediated) {
      const positions = (one.positionQuestions ?? []).filter((q) => q.kind === 'POSITION');
      expect(positions.map((q) => q.catalogued)).toEqual(POSITION_KEYS);
      for (const q of positions) {
        expect(q.question).toContain(`the ${q.position} position`);
        expect(q.question).toMatch(/commercially usable evidence for this exact position, never industry facts/);
      }
    }
  });

  it('leaves arrangements Brain fulfils itself as they were', async () => {
    const out = await composeConstruction(job());
    const own = out.filter((one) => !STRUCTURES[one.structure].needsSupply);
    expect(own.length).toBeGreaterThan(0);
    for (const one of own) {
      expect(one.positionQuestions).toBeUndefined();
      expect('positionQuestions' in one).toBe(false);
      expect(one.question).not.toMatch(/position/);
    }
  });
});

describe('each position question asks exactly what is missing there', () => {
  it('asks every missing S-0150 field plus the position’s contracts, rights, liabilities, restrictions and expectations', () => {
    const questions = positionResearchQuestions({ demand, need: null, supply, estimates: {}, exclusions: [] });
    const broker = questions.find((q) => q.kind === 'POSITION' && q.catalogued === 'BROKER')!;
    // The payer rests on a gated claim; nothing else is established.
    expect(broker.established).toEqual(['payer']);
    expect(broker.asks).toEqual(EVIDENCE_FIELD_KEYS.filter((f) => f !== 'payer'));
    expect(broker.question).not.toMatch(/\bpayer: who exactly pays/);
    for (const field of broker.asks) expect(broker.question).toContain(`${field}: `);
    const inv = POSITIONS.BROKER.investigate;
    for (const text of [...inv.contracts, ...inv.rights, ...inv.liabilities, ...inv.restrictions, ...inv.counterpartyExpectations]) expect(broker.question).toContain(text);
    expect(broker.question).toMatch(/Already established, so do not research again: payer/);
  });

  it('omits fields a justified reconstruction already establishes', () => {
    const questions = positionResearchQuestions({
      demand,
      need: null,
      supply: { ...supply, claimId: 'clm_supply' },
      estimates: { a_value: justified(100, 300), a_commission: justified(0, 1), a_conversion: justified(0, 1) },
      exclusions: [],
    });
    const one = questions.find((q) => q.kind === 'POSITION')!;
    expect(one.established).toEqual(['payer', 'supply', 'price', 'spread']);
    for (const f of one.established) expect(one.asks).not.toContain(f);
    // Conversion is established, so the price is not the only evidence: no separate questions.
    expect(questions.some((q) => q.kind !== 'POSITION')).toBe(false);
  });

  it('carries a position Brain discovered verbatim, never refusing it', () => {
    const questions = positionResearchQuestions({ demand, need: null, supply, estimates: {}, exclusions: [], positions: [resolvePosition('capacity aggregator')] });
    expect(questions).toHaveLength(1);
    expect(questions[0]!.catalogued).toBeNull();
    expect(questions[0]!.question).toContain('the capacity aggregator position');
    expect(questions[0]!.question).toMatch(/contracts, rights, liabilities, restrictions and counterparty expectations/);
  });
});

describe('an asking price or a market size alone is not access or conversion', () => {
  it('an asking-price-only figure produces separate buyer-access and conversion questions per position', () => {
    const questions = positionResearchQuestions({ demand, need: null, supply, estimates: { a_value: justified(100, 300) }, exclusions: [] });
    expect(arrangementPositionFacts({ demand, need: null, supply, estimates: { a_value: justified(100, 300) } }).bases).toEqual(['PUBLIC_ASKING_PRICE']);
    for (const key of POSITION_KEYS) {
      const forPosition = questions.filter((q) => q.catalogued === key);
      expect(forPosition.map((q) => q.kind)).toEqual(['POSITION', 'BUYER_ACCESS', 'CONVERSION']);
      expect(forPosition[1]!.question).toMatch(/only a public asking price/);
      expect(forPosition[1]!.question).toMatch(/reachable channel to a named payer/);
      expect(forPosition[2]!.question).toMatch(/observed conversion/);
    }
  });

  it('a market-size-only figure does the same', () => {
    const questions = positionResearchQuestions({ demand, need: null, supply, estimates: { a_buyers: justified(1000, 5000) }, exclusions: [] });
    const lead = questions.filter((q) => q.catalogued === 'LEAD_SUPPLIER');
    expect(lead.map((q) => q.kind)).toEqual(['POSITION', 'BUYER_ACCESS', 'CONVERSION']);
    expect(lead[1]!.question).toMatch(/only a total market size/);
  });

  it('no evidence at all asks the fields, not separate gap questions', () => {
    const questions = positionResearchQuestions({ demand, need: null, supply, estimates: {}, exclusions: [] });
    expect(questions.every((q) => q.kind === 'POSITION')).toBe(true);
    expect(questions).toHaveLength(POSITION_KEYS.length);
  });
});

describe('the search is broad, and nothing is a whitelist', () => {
  it('names buyer-first and supply-first entry points and the defaults research must not fall back on', () => {
    const [one] = positionResearchQuestions({ demand, need: null, supply, estimates: {}, exclusions: [] });
    expect(one!.question).toMatch(/buyer-first \(explicit purchase requests/);
    expect(one!.question).toMatch(/supply-first \(unused supplier capacity/);
    expect(one!.question).toMatch(/examples of where to look, not limits/);
    expect(one!.question).toMatch(/Do not default to the owner’s city, physical presence/);
  });
});
