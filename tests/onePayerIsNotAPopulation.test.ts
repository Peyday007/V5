/**
 * Production plan reads, 2026-11-19: arrangement arr_53ae6fed770b named
 * "GitHub" as its buyers and led almost every goal; others were built over
 * "Dutch cleaning company De Po…" and "Production committee investo…". One
 * organisation, one company described by its trade, and one body's members
 * are payers an opening models as that one buyer — never a population a list
 * can be built of, pooled or sold to again. Such an arrangement is refused as
 * a population and cut before the model, so it cannot lead a plan.
 */
import { describe, expect, it } from 'vitest';
import { namesABuyerPopulation, namesOneOrganisation } from '../server/domain/industry.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { leadingArrangement } from '../server/services/goals/plan.ts';

describe('one payer is not a buyer population', () => {
  it('refuses a bare company name, a company described by its trade, and one body or its members', () => {
    for (const name of [
      'GitHub',
      'github',
      'eBay',
      'Freelancer.com',
      'Upwork',
      'Amazon',
      'Dutch cleaning company De Poetsfee',
      'Dutch cleaning company De Po…',
      'the software firm Acme',
      "the production committee's investors",
      "the production committee's investo…",
      'the production committee',
      'the Smith family foundation board',
      "Toei's investors",
      'Toei’s shareholders',
    ]) {
      expect(namesABuyerPopulation(name), name).toBe(false);
      expect(namesOneOrganisation(name), name).toBe(true);
    }
  });

  it('still passes real populations', () => {
    for (const name of [
      'cleaning companies in the Netherlands',
      'puzzle newsletters',
      'homeowners',
      'contractors who buy exclusive homeowner leads',
      'Amazon sellers',
      'GitHub sponsors maintainers',
      'school districts',
      'Homeowner',
      'investors in anime production committees',
      'Production committee investors',
      'Production committee investor companies',
    ]) {
      expect(namesABuyerPopulation(name), name).toBe(true);
      expect(namesOneOrganisation(name), name).toBe(false);
    }
  });

  const arrangement = (key: string, buyers: string): ConstructedArrangement =>
    ({
      key,
      structure: 'PRODUCE',
      design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
      origin: 'FORWARD',
      precedent: null,
      sector: 'Software',
      demand: { name: buyers, claimId: null, from: 'INDUSTRY_MAP', ref: `pop_${key}` },
      need: { name: 'documentation', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_docs' },
      supply: null,
      label: `${buyers}: documentation`,
      properties: [],
      targetsMet: [],
      emergent: [],
      stress: { exposure: 'UNKNOWN', worstCaseCents: null, failures: [] },
      evidenced: 0,
      value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
      unknownParts: ['buyers', 'value', 'conversion'],
      relatedOpenings: [],
      question: 'What do they pay?',
    }) as ConstructedArrangement;

  it('cuts an arrangement over one organisation before the model, with the reason', () => {
    const selected = selectEstimatedArrangements([arrangement('gh', 'GitHub')], {
      projectId: 'prj_one_payer',
      currency: 'USD',
      beforeProofCents: 300_000,
      remaining: 10_000,
      exclusions: [],
      daysLeft: 30,
      otherPrices: [{ value: 500, industry: 'software' }],
    });
    expect(selected.openings).toHaveLength(0);
    expect(selected.selection.cut).toHaveLength(1);
    expect(selected.selection.cut[0]!.reason).toMatch(/one organisation/);
    expect(selected.selection.unpriced).toHaveLength(0);
  });

  it('never leads a plan, even listed first', () => {
    const lead = leadingArrangement([arrangement('gh', 'GitHub'), arrangement('homes', 'homeowners')], {
      portfolio: null,
      candidateIds: [],
    });
    expect(lead?.demand.name).toBe('homeowners');
  });
});
