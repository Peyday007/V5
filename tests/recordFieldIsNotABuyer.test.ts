/**
 * A record field or a sentence's verb phrase is not a buyer population, and no
 * price question is spent on one (production, 2026-11-20: goal A's price
 * questions named "owner id is null and owner info is empty" and "GitHub Bug
 * Bounty Program Overhaul does not specify" as the buyers to price, taking
 * price-research slots from real populations).
 * General rule: a name is a name — not a data field, a placeholder or a clause.
 */
import { describe, expect, it } from 'vitest';
import { namesABuyerPopulation } from '../server/domain/industry.ts';
import { sendPortfolioNeeds } from '../server/services/goals/portfolioNeeds.ts';

describe('a record field or a clause names no buyers', () => {
  it('refuses the production names', () => {
    expect(namesABuyerPopulation('owner id is null and owner info is empty')).toBe(false);
    expect(namesABuyerPopulation('GitHub Bug Bounty Program Overhaul does not specify')).toBe(false);
  });

  it('refuses placeholders, empty-value predicates and field-shaped tokens', () => {
    for (const name of ['buyer is missing', 'payer not specified', 'null', 'N/A', 'owner_id', 'ownerId holders', 'the listing did not say', 'customers are empty']) {
      expect(namesABuyerPopulation(name), name).toBe(false);
    }
  });

  it('keeps real populations, including words that only look like a field', () => {
    for (const name of ['Medicaid beneficiaries', 'Independent dental practices', 'Homeowners in Mechanicsburg, PA', 'Small landlords who are renovating', 'ID card printing shops', 'Plaid integrators', 'SMB owners']) {
      expect(namesABuyerPopulation(name), name).toBe(true);
    }
  });

  it('spends no price question on a population that names nobody', async () => {
    const sent: string[] = [];
    const out = await sendPortfolioNeeds(
      {
        goalId: 'wst_test',
        projectId: 'prj_test',
        portfolio: null,
        unpriced: [
          { population: 'pop_junk', buyer: 'owner id is null and owner info is empty', designs: 4, arrangementKey: 'a1', question: 'What do they pay?' },
          { population: 'pop_real', buyer: 'Independent dental practices', designs: 3, arrangementKey: 'a2', question: 'What do they pay?' },
        ] as never,
      } as never,
      {
        sendNeeds: async (input: { graphScope: string; needs: ReadonlyArray<{ subject: string }> }) => {
          sent.push(input.graphScope);
          return input.needs.map((n) => ({ subject: n.subject, sent: true, created: true, reason: null }));
        },
      } as never,
    );
    expect(sent).toEqual(['price:pop_real']);
    expect(out.refused.some((r) => r.includes('owner id is null'))).toBe(true);
  });
});
