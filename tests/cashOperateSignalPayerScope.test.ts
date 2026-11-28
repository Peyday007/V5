/**
 * ORIGINATED:UNMET_NEED:payer-for-v — a signal is not asked for a payer its own
 * fact rules out.
 *
 * Production held five open "Payer for …" needs, grouped by the self-model as
 * one missing resource. Four were unanswerable: a stock-image subscription
 * price and a broker's registration fee are what a supplier charges its own
 * customers, and a TCGPlayer or StubHub quote is a resale market's price.
 * None names anybody who would approve paying Brain. The fifth — a bug bounty
 * whose source names GitHub as the payer — is a real question and is still
 * asked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { questionKey } from '../server/services/cash/conditions.ts';
import { parseBlockerKey } from '../server/domain/types.ts';
import { payerQuestionUnanswerable, reconcileDiscoverableGaps } from '../server/services/cash/operate.ts';
import { QUESTION_SKIPPED_EVENT } from '../server/services/cash/screenMetrics.ts';

const ADOBE =
  'Adobe Stock publishes a standard-license image subscription price of $29.99/month for 10 Stock credits (images, vectors, music, templates use one credit each)';
const TCG =
  'As of the most recent tracked sale on September 17, 2026 (via TCGPlayer), the Prismatic Evolutions Elite Trainer Box traded at $145 (current market)';
const COPART =
  "Preferred Auto Brokers (PAB), whose registration terms are published on Copart's own site, charges buyers who register through it a $195.00 annual registration fee";
const STUBHUB =
  'As of April 9, 2026 at 4pm PT, StubHub listed Coachella 2026 Weekend 1 resale tickets at $2,905 for general admission and $5,061 for VIP — a specific listing';
// Review round 1 (F1): buyer-side spend facts that merely carry a billing cadence.
const BUYER_SPEND_FACTS = [
  'Acme Dental pays $4,000 per month to an outside agency for appointment-reminder calls',
  'Shopify merchants spend $500/month on product photography retouching',
  'The City of Austin budgets $12,000 per month for translation services',
  'Regional law firms outsource document review at $3,000/mo per matter',
];
const GITHUB =
  "GitHub is the payer; its bug bounty is run through HackerOne (hackerone.com/github). The program's own site says 'If you have found a vulnerability, submit it'";

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `payer-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect(
    (await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok,
  ).toBe(true);
});

async function signal(title: string) {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value;
}

describe('payerQuestionUnanswerable', () => {
  it('rules out the four recorded supplier-price and resale-quote facts, and keeps a named payer', () => {
    for (const title of [ADOBE, TCG, COPART, STUBHUB]) {
      expect(payerQuestionUnanswerable({ title, payer: null })).not.toBeNull();
    }
    expect(payerQuestionUnanswerable({ title: GITHUB, payer: null })).toBeNull();
    expect(payerQuestionUnanswerable({ title: 'A bare opening', payer: null })).toBeNull();
    expect(payerQuestionUnanswerable({ title: ADOBE, payer: 'Somebody' })).toBeNull();
  });

  it('keeps the payer question on a buyer-side spend fact, however it is billed', () => {
    for (const title of BUYER_SPEND_FACTS) {
      expect(payerQuestionUnanswerable({ title, payer: null }), title).toBeNull();
    }
  });
});

describe('payerQuestionUnanswerable at its boundary, beyond the recorded titles', () => {
  it('rules out supplier prices and resale quotes it was not fitted to', () => {
    for (const title of [
      'Canva Pro publishes a subscription price of $15/month for one seat',
      'Costco charges members a $65 annual membership fee',
      'A StubHub resale listing for the Eras Tour floor seats was $1,200',
      'On eBay, a PSA 10 Charizard last sold for $420',
    ]) {
      expect(payerQuestionUnanswerable({ title, payer: null }), title).not.toBeNull();
    }
  });

  it("keeps the payer question when a supplier's terms or a resale quote sit beside a buyer spending on work", () => {
    // BUYER_SPEND_FACTS above guard only a billing cadence. Each sentence here
    // carries one of the markers that actually rules a fact out — a seller's
    // subscription, membership or registration terms, "charges subscribers",
    // or a resale market's name with a resale quote — and also names somebody
    // spending on work, which is exactly the party a payer question looks for.
    for (const title of [
      'Dental practices pay $400 a month for review replies on a subscription plan',
      'Gyms budget $2,000 a year to manage their membership fee collections',
      'Contractors who renew an annual registration retain a permit expediter at $300 per filing',
      'A SaaS firm that charges subscribers monthly buys onboarding videos at $800 each',
      'Ticket brokers who resell on StubHub spend $300/month on resale price data',
      'eBay sellers outsource listing photography to keep items at current market price',
      'Card shops spending on TCGPlayer market price tracking tools',
    ]) {
      expect(payerQuestionUnanswerable({ title, payer: null }), title).toBeNull();
    }
  });
});

describe('the signal gap pass', () => {
  it('asks the GitHub bounty its payer and does not ask the supplier and resale facts', async () => {
    const ids = {
      adobe: (await signal(ADOBE)).id,
      tcg: (await signal(TCG)).id,
      copart: (await signal(COPART)).id,
      stubhub: (await signal(STUBHUB)).id,
      github: (await signal(GITHUB)).id,
    };
    const gaps = await reconcileDiscoverableGaps(projectId);
    const payerAsked = gaps.filter((one) => one.field === 'payer').map((one) => one.opportunityId);
    expect(payerAsked).toEqual([ids.github]);

    // The other capture questions are still asked of every one of them.
    for (const id of Object.values(ids)) {
      expect(gaps.filter((one) => one.opportunityId === id).map((one) => one.field)).toEqual(
        expect.arrayContaining(['access', 'buyingEvidence']),
      );
    }

    // Each payer question not asked is recorded once, with why.
    const skipped = await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT);
    for (const id of [ids.adobe, ids.tcg, ids.copart, ids.stubhub]) {
      const mine = skipped.filter((event) => event.opportunityId === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.summary).toContain('No payer to look up');
    }
    expect(skipped.filter((event) => event.opportunityId === ids.github)).toEqual([]);

    await reconcileDiscoverableGaps(projectId);
    expect(await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)).toHaveLength(4);
  });

  it('withdraws a payer question already open on a supplier-price signal, and resolves nothing', async () => {
    const adobe = await signal(ADOBE);
    const key = questionKey(adobe.id, 'payer');
    const raised = await raiseNeed({
      projectId,
      opportunityId: adobe.id,
      actorRef: 'BRAIN',
      blockedAction: `Payer for "${adobe.title}"`,
      whyItMatters: 'Raised before the change.',
      recommendedPath: 'Name the person or role who can approve payment.',
      setupEffort: 'One bounded look.',
      nextStep: 'Name the person or role who can approve payment.',
      completionCondition: 'The payer is recorded on this card.',
      blocksState: 'EXECUTING',
      requestKey: key,
      blockerKey: parseBlockerKey('FIELD:payer'),
    });
    expect(raised.ok).toBe(true);

    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.filter((one) => one.field === 'payer')).toEqual([]);

    const withdrawn = await listNeeds({ projectId, states: ['WITHDRAWN'] });
    expect(withdrawn.map((one) => one.requestKey)).toEqual([key]);
    expect(withdrawn[0]!.resolution).toContain('Nothing was established');
    expect(await listNeeds({ projectId, states: ['RESOLVED'] })).toEqual([]);
    expect((await listNeeds({ projectId, states: ['OPEN'] })).some((one) => one.requestKey === key)).toBe(false);
  });

  it('asks a buyer-spend signal its payer and leaves its open payer question open', async () => {
    const spend = await signal(BUYER_SPEND_FACTS[0]!);
    const key = questionKey(spend.id, 'payer');
    const fresh = await reconcileDiscoverableGaps(projectId);
    expect(fresh.filter((one) => one.field === 'payer').map((one) => one.opportunityId)).toEqual([spend.id]);

    await reconcileDiscoverableGaps(projectId);
    expect((await listNeeds({ projectId, states: ['OPEN'] })).some((one) => one.requestKey === key)).toBe(true);
    expect(await listNeeds({ projectId, states: ['WITHDRAWN'] })).toEqual([]);
    const skipped = await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT);
    expect(skipped.filter((event) => event.opportunityId === spend.id)).toEqual([]);
  });
});
