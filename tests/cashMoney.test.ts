/**
 * The six figures, and the arithmetic mistake that would make all of them lie.
 *
 * §5 of the plan is almost entirely about keeping numbers apart, and two of its
 * sentences are the ones this file exists for:
 *
 *   - "Already-paid expenses are already reflected in that balance; do not
 *     subtract them twice." A cost leaves the account once, and deployable cash
 *     subtracts only what has **not** left yet. Getting this wrong understates
 *     deployable cash by everything the sprint ever spent, and gets worse the
 *     better the sprint goes — which is the shape of error nobody notices,
 *     because it looks like caution.
 *
 *   - "While the payment is pending, it does not increase available funds."
 *     A customer payment and a settlement are two events about the same money.
 *
 * The worked illustration in §5 is reproduced exactly, because a figure that
 * reconciles against a published example is a figure somebody can check.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { cashPosition, checkMoneyEntry } from '../server/services/cash/money.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `money-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

function entry(kind: Parameters<typeof recordMoney>[0]['kind'], cents: number, reference?: string) {
  return recordMoney({
    projectId,
    kind,
    amountCents: cents,
    currency: 'USD',
    verifiedReference: reference ?? null,
    recordedBy: userId,
  });
}

describe('the numbers are kept apart', () => {
  it('does not let an agreed job become cash', async () => {
    await entry('PIPELINE_AGREED', 75_000);
    const position = await cashPosition({ projectId });
    expect(position.pipelineCents).toBe(75_000);
    expect(position.customerPaymentsCents).toBe(0);
    expect(position.availableFundsCents).toBe(0);
    expect(position.deployableCents).toBe(0);
  });

  it('does not let a pending payment become available funds', async () => {
    await entry('CUSTOMER_PAYMENT', 75_000, 'pi_test_1');
    const position = await cashPosition({ projectId });
    // Earned, and not usable. Stripe schedules a first live payout to complete
    // in 7-14 days; treating the payment as cash would put money in a plan a
    // fortnight before it exists.
    expect(position.customerPaymentsCents).toBe(75_000);
    expect(position.availableFundsCents).toBe(0);
    expect(position.completedContributionCents).toBe(75_000);
  });

  it('makes money usable only when it settles', async () => {
    await entry('CUSTOMER_PAYMENT', 75_000, 'pi_test_1');
    await entry('SETTLEMENT', 75_000, 'po_test_1');
    const position = await cashPosition({ projectId });
    expect(position.availableFundsCents).toBe(75_000);
    expect(position.deployableCents).toBe(75_000);
  });
});

describe('a cost is subtracted once', () => {
  it('leaves available funds down by the cost and deployable cash down by no more', async () => {
    await entry('CAPITAL_IN', 100_000);
    await entry('COST', 20_000);

    const position = await cashPosition({ projectId });
    expect(position.availableFundsCents).toBe(80_000);
    /*
     * The whole test. A second subtraction here would read 60,000, and it would
     * look like prudence rather than like a bug — which is exactly why it is
     * pinned rather than left to a reviewer noticing.
     */
    expect(position.deployableCents).toBe(80_000);
  });

  it('subtracts an unpaid bill from deployable cash and not from available funds', async () => {
    await entry('CAPITAL_IN', 100_000);
    await entry('UNPAID_COMMITMENT', 30_000);

    const position = await cashPosition({ projectId });
    expect(position.availableFundsCents).toBe(100_000);
    expect(position.unpaidCommitmentsCents).toBe(30_000);
    expect(position.deployableCents).toBe(70_000);
  });

  it('closes an unpaid bill without double-counting when it is paid', async () => {
    await entry('CAPITAL_IN', 100_000);
    await entry('UNPAID_COMMITMENT', 30_000);
    // Paying it is two facts: the bill is closed, and money left the account.
    await entry('COMMITMENT_PAID', 30_000);
    await entry('COST', 30_000);

    const position = await cashPosition({ projectId });
    expect(position.unpaidCommitmentsCents).toBe(0);
    expect(position.availableFundsCents).toBe(70_000);
    expect(position.deployableCents).toBe(70_000);
  });

  it('protects a reserve from being redeployed, and gives it back when released', async () => {
    await entry('CAPITAL_IN', 100_000);
    await entry('RESERVE', 25_000);
    expect((await cashPosition({ projectId })).deployableCents).toBe(75_000);

    await entry('RESERVE_RELEASE', 25_000);
    expect((await cashPosition({ projectId })).deployableCents).toBe(100_000);
  });

  it('exposes a shortfall rather than smoothing it over', async () => {
    await entry('CAPITAL_IN', 10_000);
    await entry('UNPAID_COMMITMENT', 50_000);
    const position = await cashPosition({ projectId });
    expect(position.deployableCents).toBe(-40_000);
    expect(position.shortfall).toBe(true);
  });
});

describe('§5’s worked illustration, reproduced', () => {
  it('reaches $355 of contribution and $280 of redeployable cash', async () => {
    // Earned customer payment 750, fees 25, acquisition 120, labour 200,
    // tools and rework 50 — and the reserve of 75 is an example allocation
    // rather than a tax estimate.
    await entry('CUSTOMER_PAYMENT', 75_000, 'pi_worked');
    await entry('SETTLEMENT', 75_000, 'po_worked');
    await entry('COST', 2_500);
    await entry('COST', 12_000);
    await entry('COST', 20_000);
    await entry('COST', 5_000);
    await entry('RESERVE', 7_500);

    const position = await cashPosition({ projectId });
    expect(position.completedContributionCents).toBe(35_500);
    expect(position.deployableCents).toBe(28_000);
    // And the thing the illustration is written to make obvious: this
    // transaction adds $280 of reusable capital, not $750.
    expect(position.deployableCents).not.toBe(75_000);
  });

  it('counts a test that produced no sale in the contribution', async () => {
    await entry('CUSTOMER_PAYMENT', 75_000, 'pi_worked');
    await entry('COST', 30_000); // an experiment that sold nothing
    const position = await cashPosition({ projectId });
    expect(position.completedContributionCents).toBe(45_000);
  });
});

describe('what may be written at all', () => {
  it('refuses a payment with no verifiable reference', () => {
    const refused = checkMoneyEntry({ kind: 'CUSTOMER_PAYMENT', amountCents: 1000 });
    expect(refused.ok).toBe(false);
    const refusedSettlement = checkMoneyEntry({ kind: 'SETTLEMENT', amountCents: 1000 });
    expect(refusedSettlement.ok).toBe(false);
  });

  it('accepts one that carries it', () => {
    expect(
      checkMoneyEntry({ kind: 'CUSTOMER_PAYMENT', amountCents: 1000, verifiedReference: 'pi_1' })
        .ok,
    ).toBe(true);
  });

  it('refuses zero, a negative and a fractional amount', () => {
    expect(checkMoneyEntry({ kind: 'COST', amountCents: 0 }).ok).toBe(false);
    expect(checkMoneyEntry({ kind: 'COST', amountCents: -5 }).ok).toBe(false);
    expect(checkMoneyEntry({ kind: 'COST', amountCents: 10.5 }).ok).toBe(false);
  });

  it('does not require a reference for a cost, which is the account’s own record', () => {
    expect(checkMoneyEntry({ kind: 'COST', amountCents: 500 }).ok).toBe(true);
  });
});

describe('an opportunity’s own position', () => {
  it('counts only its own entries and no project-level holds', async () => {
    await recordMoney({
      projectId,
      opportunityId: 'cop_one',
      kind: 'CUSTOMER_PAYMENT',
      amountCents: 40_000,
      currency: 'USD',
      verifiedReference: 'pi_one',
      recordedBy: userId,
    });
    await recordMoney({
      projectId,
      opportunityId: 'cop_two',
      kind: 'CUSTOMER_PAYMENT',
      amountCents: 60_000,
      currency: 'USD',
      verifiedReference: 'pi_two',
      recordedBy: userId,
    });

    const one = await cashPosition({ projectId, opportunityId: 'cop_one' });
    expect(one.customerPaymentsCents).toBe(40_000);
    expect(one.heldCommitmentsCents).toBe(0);

    const whole = await cashPosition({ projectId });
    expect(whole.customerPaymentsCents).toBe(100_000);
  });
});
