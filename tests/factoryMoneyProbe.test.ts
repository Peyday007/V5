/**
 * r01.money-13-4 (release01/moneyProbe.ts): money velocity and deal structure
 * judged from the ledger the released reader quantifies. UNKNOWN on nothing,
 * FAIL on an impossible reading, PASS only on a measured split and timing leg.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { routeMoneyDemonstrates, routeMoneyProblem } from '../server/services/factory/program/release01/moneyProbe.ts';
import { quantifyRouteMoney } from '../server/services/quant/deadline.ts';

beforeEach(async () => {
  await freshProject();
});
afterEach(async () => {
  await teardown();
});

const blank = () => quantifyRouteMoney({ routeKey: 'route-a', events: [] }) as unknown as Record<string, unknown> & { routeKey: string };

describe('r01.money-13-4', () => {
  it('is UNKNOWN, not a pass, with no ledger row on production', async () => {
    const r = await getProbe('r01.money-13-4')!({});
    expect(r.ok).toBeNull();
    expect(r.detail).toMatch(/no money ledger row/);
  });

  it('accepts an unmeasured route that says why, and does not count it as a demonstration', () => {
    const route = blank();
    expect(routeMoneyProblem(route)).toBeNull();
    expect(routeMoneyDemonstrates(route)).toBe(false);
  });

  it('fails an impossible figure, missing identities, or an unexplained unknown', () => {
    expect(routeMoneyProblem({ ...blank(), receivables: -5 })).toMatch(/receivables is negative/);
    expect(routeMoneyProblem({ ...blank(), peakWorkingCapital: Number.NaN })).toMatch(/not a number/);
    expect(routeMoneyProblem({ ...blank(), identities: { GROSS_BILLINGS: 1 } })).toMatch(/not the nine/);
    expect(routeMoneyProblem({ ...blank(), unknowns: [] })).toMatch(/without saying why/);
  });

  it('counts a route that measures a funding split and a timing leg', () => {
    expect(routeMoneyDemonstrates({ ...blank(), customerFundedSpend: 1200, daysLeadToCommitment: 3 })).toBe(true);
    expect(routeMoneyDemonstrates({ ...blank(), customerFundedSpend: 1200 })).toBe(false);
  });
});
