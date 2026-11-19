/**
 * Production, 2026-11-19 (goal wst_7b4f): the plan's leading candidate was
 * cop_8015, a Pennsylvania opening, while its steps read "Reach GitHub" —
 * taken from a constructed arrangement that was not in the lead at all,
 * because `leadingArrangement` fell back to the largest contributor or to
 * construction's first rank whenever the lead held no arrangement. The steps
 * are now built from the lead the plan names: its arrangement, or none.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { leadingArrangement, planSteps, type NextTest } from '../server/services/goals/plan.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';

const homeowners = {
  key: 'homes',
  structure: 'PRODUCE',
  design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
  origin: 'FORWARD',
  precedent: null,
  sector: null,
  demand: { name: 'homeowners', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_homes' },
  need: { name: 'move-out cleaning checklists', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_need' },
  supply: null,
  label: 'Homeowners: move-out checklists',
  properties: [],
  targetsMet: [],
  emergent: [],
  stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] },
  evidenced: 0,
  value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
  unknownParts: ['buyers', 'value', 'conversion'],
  relatedOpenings: [],
  question: '',
} as unknown as ConstructedArrangement;

const opening: NextTest = { link: 'CONVERSION', test: 'Offer the Pennsylvania opening (cop_8015) to its payer and measure the reply.', by: 'BRAIN', blocker: null };
const baseline = { source: 'BASELINE' as const, hypothetical: true, reason: 'does not beat the plan as held' };
const contributes = { best: null, demand: [{ opportunityId: 'arr_homes', refused: false, revenue: { p50: 9_000 } }] } as unknown as GoalPortfolio;

describe('the plan\'s steps are its lead\'s', () => {
  it('a lead that names only an opening takes no arrangement\'s steps, however much one contributes', () => {
    expect(leadingArrangement([homeowners], { portfolio: contributes, candidateIds: ['cop_8015'] })).toBeNull();
    const best = { best: { members: [{ opportunityId: 'cop_8015' }] }, demand: contributes.demand } as unknown as GoalPortfolio;
    expect(leadingArrangement([homeowners], { portfolio: best, candidateIds: [] })).toBeNull();

    const steps = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: opening, permissionsMissing: [], arrangement: null });
    expect(steps).toHaveLength(1);
    expect(steps.some((one) => /^Reach /.test(one.label))).toBe(false);
    expect(steps[0]!.detail).toContain('cop_8015');
  });

  it('a lead that names an arrangement takes that arrangement\'s steps', () => {
    const lead = leadingArrangement([homeowners], { portfolio: null, candidateIds: ['cop_8015', 'arr_homes'] });
    expect(lead?.key).toBe('homes');
    const steps = planSteps({
      adoption: baseline,
      reconstruction: null,
      sales: [],
      nextTest: opening,
      permissionsMissing: [],
      arrangement: { arrangement: lead!, context: { currency: 'USD', daysLeft: 30, capitalBeforeProof: null } },
    });
    expect(steps.find((one) => one.kind === 'EXECUTE')?.label).toBe('Reach homeowners');
  });

  it('with no lead named, the largest contributor still leads', () => {
    expect(leadingArrangement([homeowners], { portfolio: contributes })?.key).toBe('homes');
  });
});
