/**
 * Inbound buyer validation for the $10K plan class
 * (OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42).
 *
 * The operator asked (run opr_99026b0ef4c04df9b03d): which inbound mechanism can
 * move a $10K PA Farm Vitality / home-improvement opening to D_BUYER_VALIDATED
 * without direct outreach, paid spend, automated research or Factory engineering,
 * and what is the minimal implementation on Brain's existing capabilities?
 *
 * The answer this file records and pins, each claim with its source:
 *
 *  1. Only a money-committed inbound signal can count as conversion. The
 *     landing-page (smoke) test is one plain page for the offer — headline, 2-3
 *     benefits, one call to action — whose CTA commitment level is chosen before
 *     launch (email signup/waitlist lowest, a simulated "buy now" medium, a real
 *     pre-order highest), with a success threshold fixed before launch and
 *     conversion = CTA completions / unique visitors, at least ~200 unique visitors
 *     for a directional read.
 *     https://kromatic.com/real-startup-book/landing-page-smoke-test
 *  2. A click, signup or fake-door "buy now" does not establish purchase: no
 *     published study measures how well smoke-test signals predict later purchase,
 *     and the practitioner guides themselves say a signup overstates willingness to
 *     pay. So those are recorded as interest, never fed in as a close rate.
 *     https://kromatic.com/real-startup-book/landing-page-smoke-test
 *  3. All-or-nothing reward crowdfunding needs no up-front spend (the platform
 *     takes 5% only of successfully raised funds), and money-committed pledges
 *     separate offers sharply: funded projects median pledge ratio 1.13 and ~202
 *     backers, unfunded 0.04 and ~22 (Kickstarter 2009-2014).
 *     https://conference.iza.org/conference_files/EntreRes2015/xu_t22362.pdf
 *  4. A pledge count partly measures the founder's own network (log Facebook
 *     friends predicts success in 48,526 projects), so with no outreach and no paid
 *     promotion the read depends on organic reach and is a caveat on the count,
 *     not a reason to discount it silently.
 *     https://leeds-faculty.colorado.edu/bhagat/Dynamics-of-Crowdfunding.pdf
 *  5. The concierge test is excluded: as canonically described it recruits its
 *     3-5 early adopters by direct outreach.
 *     https://kromatic.com/real-startup-book/concierge-test
 *
 * Minimal implementation on what Brain already has: a real pre-order / deposit
 * CTA (or an all-or-nothing pledge page) whose paid commitments are counted
 * against unique visitors and recorded through `measuredRateInput`, the same
 * shape the reply record uses. That reaches `conversionState` HISTORICAL, the
 * CONVERSION link holds, and `validationStage` reads D_BUYER_VALIDATED. No new
 * mechanism is needed, and the gate is unchanged: an assumed rate, an unsized
 * rate, or an interest-only signal stays NONE.
 *
 * The failure class: a causeless MISSING_CAPABILITY finding for this question is
 * offered by `inventoryDeficiencies` by its id, and is not re-offered while its
 * repair is in flight or after the repair was rejected — so it does not loop
 * back to the Factory as engineering work. Nothing here lowers a bar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { getInventoryItem, upsertInventory } from '../server/services/operator/inventory.ts';
import { inventoryDeficiencies, readingId } from '../server/services/operator/director.ts';
import { inputEvidence, measuredRateInput } from '../server/services/goals/portfolio.ts';
import { conversionState, validationStage } from '../server/services/goals/plan.ts';
import type { LinkCheck } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const uid = () => Math.random().toString(36).slice(2, 8);
const ctx = { runId: 'opr_99026b0ef4c04df9b03d', actor: 'test' };
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function opening(close: ModelInput): ModelledOpportunity {
  return {
    opportunity: { id: 'cop_inbound', title: 'PA Farm Vitality home-improvement plan', projectId: 'p', offerScope: 'plan', payer: 'homeowner', requiredCapabilities: [] } as unknown as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close,
    respond: fixed(1),
    directCost: fixed(10),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
  };
}

/** The CONVERSION link exactly as the plan reads it when buyers would be offered (deals > 0). */
const conversionCheck = (one: ModelledOpportunity): LinkCheck => ({ link: 'CONVERSION', ok: conversionState(one).state !== 'NONE', basis: one.close.note });
const target = { capitalBeforeProofCents: 37_500, currency: 'USD' } as unknown as Parameters<typeof validationStage>[2];
const stage = (one: ModelledOpportunity) => validationStage(one, [conversionCheck(one)], target, false);

describe('the inbound answer: money-committed inbound counts are buyer validation, interest signals are not', () => {
  it('paid pre-orders (or pledges) counted against unique landing-page visitors reach D_BUYER_VALIDATED through the existing path', () => {
    // 6 paid deposits from 240 unique visitors — above the ~200-visitor directional floor.
    const close = measuredRateInput({ trials: 240, low: 6, high: 6 });
    expect(inputEvidence(close, 'close')).toMatchObject({ tier: 'HISTORICAL', establishes: true });
    const one = opening(close);
    expect(conversionState(one).state).toBe('HISTORICAL');
    expect(conversionCheck(one).ok).toBe(true);
    expect(stage(one)).toBe('D_BUYER_VALIDATED');
  });

  const interest: Array<[string, ModelInput]> = [
    ['a signup-to-purchase rate somebody assumed', { value: null, low: 0.02, high: 0.1, provenance: 'ASSUMPTION', source: null, note: 'waitlist signups, purchase rate assumed' }],
    ['a fake-door click rate stated with no sample', fixed(0.05)],
  ];
  for (const [label, close] of interest) {
    it(`reproduces the failure class — ${label}: conversion is not established and the opening stays below D`, () => {
      expect(inputEvidence(close, 'close').establishes).toBe(false);
      const one = opening(close);
      expect(conversionState(one).state).toBe('NONE');
      expect(conversionCheck(one).ok).toBe(false);
      expect(stage(one)).not.toBe('D_BUYER_VALIDATED');
    });
  }

  it('a measured zero is a measurement, not a favourable assumption: 0 paid of 240 is a low measured rate', () => {
    const close = measuredRateInput({ trials: 240, low: 0, high: 0 });
    expect(close.provenance).toBe('HISTORICAL');
    expect(close.high!).toBeLessThan(0.03);
    expect(close.high!).toBeLessThan(measuredRateInput({ trials: 240, low: 6, high: 6 }).high!);
  });
});

describe('the failure class OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42 does not loop back to the Factory', () => {
  beforeEach(async () => {
    await freshProject();
    await createUser({ email: `own-${uid()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
  });

  const finding = (id: string, over: Record<string, unknown> = {}) =>
    upsertInventory(
      {
        id,
        capability: 'inbound buyer validation',
        symptom: 'No inbound mechanism yields a buyer-validated opening for the $10K plan without outreach or paid spend',
        evidence: 'Operator run opr_99026b0ef4c04df9b03d asked; Brain held no answer.',
        severity: 'BLOCKING',
        ...over,
      },
      ctx,
    );
  const offeredRefs = async () => (await inventoryDeficiencies(1000)).map((one) => one.source?.ref);
  const repairRow = async () =>
    (await upsertCandidate({
      weaknessKey: `OPERATOR:MISSING_CAPABILITY:${uid()}`, kind: 'OPERATOR:MISSING_CAPABILITY', title: 'inbound validation', problem: 'p', metric: 'RESEARCH_JOB_SUCCESS_RATE', downstreamMetric: null,
      ownerComponent: `operator:MISSING_CAPABILITY:${uid()}`, frequency: 1, denominator: 1, scope: 'GENERAL', severity: 'MEDIUM', evidence: {},
    })).candidate;

  it('is offered by its id as a goal-blocking MISSING_CAPABILITY, held while its repair is in flight and after a rejected repair, re-offered with a confirmed cause', async () => {
    const id = `INBOUND-10K-${uid()}`;
    expect((await finding(id)).ok).toBe(true);
    expect((await getInventoryItem(id))!.status).toBe('DISCOVERED');

    const offered = (await inventoryDeficiencies()).find((one) => one.source?.ref === id);
    expect(offered).toBeDefined();
    expect(readingId(offered!)).toBe(`dfx_inv_${id}`);
    expect(offered!.diagnosis.deficiency).toBe('MISSING_CAPABILITY');
    expect(offered!.diagnosis.blocksGoal).toBe(true);
    expect(offered!.diagnosis.cause).toBeNull();

    const repair = await repairRow();
    expect((await finding(id, { linkedCandidateId: repair.id })).ok).toBe(true);
    expect(await offeredRefs()).not.toContain(id);

    const control = `INBOUND-10K-${uid()}`;
    expect((await finding(control)).ok).toBe(true);
    expect(await decideCandidate(repair.id, 'REJECTED', 'no accepted claim')).toBe(true);
    const after = await offeredRefs();
    expect(after).toContain(control);
    expect(after).not.toContain(id);

    const cause = 'Answered: count paid pre-orders/pledges against unique visitors via measuredRateInput; signups and clicks never certify conversion.';
    expect((await finding(id, { rootCause: cause, status: 'ROOT_CAUSE_CONFIRMED' })).ok).toBe(true);
    expect((await inventoryDeficiencies()).find((one) => one.source?.ref === id)?.diagnosis.cause).toBe(cause);
  });
});
