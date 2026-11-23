import { describe, expect, it } from 'vitest';
import { isNonPurchasePayment, paymentNatureOf } from '../server/domain/paymentNature.ts';
import { namesABuyerPopulation, subjectOf } from '../server/domain/industry.ts';

/** Audit of goal wst_7b4fcbb5f2384f31b6c3 (docs/audits/2026-11-23-10k-plan-audit.md). */
describe('payment nature: a price is what a buyer pays for a deliverable', () => {
  it('reads the bug-bounty reward that carried the $10K plan as a contingent reward, not a price', () => {
    // clm_5e038810b7a945728e2f, verbatim.
    expect(paymentNatureOf('GitHub Inc pays $10,000 per slot for a critical finding in its public bug bounty program.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf("As of July 27, 2026, GitHub's public bug bounty program pays fixed amounts: $250 for low-severity findings, $2,000 for medium, $5,000 high, and $10,000 for critical.").nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('The company rewards researchers up to $30,000 for a valid critical vulnerability.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('The hackathon awards $5,000 to the top team.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('Prize money of $50,000 goes to the winner of the design competition.').nature).toBe('CONTINGENT_REWARD');
  });

  it('reads grants, rebates, reimbursements, settlements and wages as non-purchase payments', () => {
    expect(paymentNatureOf('The Farm Vitality Planning Grant reimburses up to $15,000 of planning costs.').nature).not.toBe('PURCHASE');
    expect(paymentNatureOf('The foundation provides a $25,000 grant to each selected nonprofit.').nature).toBe('GRANT');
    expect(paymentNatureOf('Homeowners receive a rebate of up to $1,500 for a heat pump.').nature).toBe('TRANSFER');
    expect(paymentNatureOf('The class action settlement of $2,000 per claimant was approved.').nature).toBe('TRANSFER');
    expect(paymentNatureOf('Warehouse associates earn an hourly wage of $19.').nature).toBe('EMPLOYMENT');
  });

  it('keeps real purchases as purchases, including those that mention a grant or a prize', () => {
    // clm_cbc36da6673c4b7581fc (NameExperts).
    expect(paymentNatureOf("flat-fee-plus-commission brokers charge 10-20% plus a service fee 'often $75-$500'").nature).toBe('PURCHASE');
    expect(paymentNatureOf('Grant writers charge $2,000 per application.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('The Puzzle Society pays $500 for each accepted puzzle.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('Dental practices pay $299 per month for the scheduling software subscription.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('Agencies charge $1,200 to design a prize-draw landing page.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('The state awarded a $480,000 contract for road resurfacing after a bid.').nature).toBe('PURCHASE');
    expect(isNonPurchasePayment(null)).toBe(false);
  });
});

describe('buyer population: a sentence about one company is one company', () => {
  it('reads the subject of the payer sentence that reached the industry map', () => {
    const node = 'GitHub Inc is the payer — its bug bounty page publishes rewards of $10,000 or more in its public program';
    expect(subjectOf(node)).toBe('GitHub Inc');
    expect(namesABuyerPopulation(node)).toBe(false);
    expect(namesABuyerPopulation('GitHub Inc is the payer its bug bounty page publishes rewards of $10 000 or more in its pu')).toBe(false);
  });

  it('keeps kinds of buyer that carry a description after them', () => {
    expect(namesABuyerPopulation('domain buyer or seller — what this buyer pays per unit of work')).toBe(true);
    expect(namesABuyerPopulation('small business operators — what this buyer pays per unit of work')).toBe(true);
    expect(namesABuyerPopulation('Dental practices')).toBe(true);
    expect(namesABuyerPopulation('Companies running bug bounty programs')).toBe(true);
  });
});
