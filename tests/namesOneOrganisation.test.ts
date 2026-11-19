/**
 * Production, 2026-11-19 (goals wst_db2e2e0e5204477692d5 and
 * wst_fa4761773e4441b89e5a): plans led with "Constructed: Artisanal Sudoku"
 * and "Constructed: VA", and their steps built a list of one organisation from
 * a published directory. Artisanal Sudoku (a Substack publication that pays
 * $50 a puzzle) and the VA are real payers, each modelled as that one buyer by
 * the opening that names it; neither is a population an arrangement can be
 * built over.
 */
import { describe, expect, it } from 'vitest';
import { namesABuyerPopulation, namesOneOrganisation } from '../server/domain/industry.ts';

describe('one organisation, or a kind of buyer', () => {
  it('a proper name or an acronym is one organisation, and not a population', () => {
    for (const name of ['Artisanal Sudoku', 'Puzzle Society', 'VA', 'PA DEP', 'St Louis Development Corporation', 'Society of Actuaries', 'The Washington Post', 'Bank of the West']) {
      expect(namesOneOrganisation(name), name).toBe(true);
      expect(namesABuyerPopulation(name), name).toBe(false);
    }
  });

  it('a common noun phrase, a title-cased plural or a kind acronym is a population', () => {
    for (const name of ['Local businesses', 'Dental practices', 'IT departments', 'Senior Living Communities', 'school districts', 'SMB', 'HOA', 'Homeowner', 'state technical utility services bureaus', 'Small and mid-size firms sending year-end client and employee gifts', 'homeowner']) {
      expect(namesOneOrganisation(name), name).toBe(false);
      expect(namesABuyerPopulation(name), name).toBe(true);
    }
  });

  it('a name that is no buyer at all is neither', () => {
    for (const name of ['', 'paying', 'Crucinova itself', 'anonymous members of the public']) {
      expect(namesOneOrganisation(name), name).toBe(false);
      expect(namesABuyerPopulation(name), name).toBe(false);
    }
  });
});
