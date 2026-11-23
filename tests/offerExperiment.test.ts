/**
 * The first-transaction experiment (`cash/offerExperiment.ts`): no live effect
 * without the grants, CAN-SPAM as a hard precondition, the kill/pass rules and
 * exposure ceiling enforced in code, and a payment read from the provider
 * written to the ledger exactly once.
 *
 *   X01 — the rules: kill, hold on an unknown complaint rate, pass and extend,
 *         the exposure ceiling.
 *   X02 — CAN-SPAM: a message without a postal address or an opt-out is refused.
 *   X03 — no grant: with real-shaped adapters registered and `live: true`,
 *         nothing is sent, and a PROPOSED authority row records what would be.
 *   X04 — granted but not live: still nothing sent.
 *   X05 — granted and live: the link is created once, a retry replays, each
 *         lead is mailed once, and the batch respects the send cap.
 *   X06 — a paid checkout becomes one CUSTOMER_PAYMENT, and reading it again
 *         records nothing more.
 *   X07 — the preview names every effect, its grant, provider and cost, and
 *         writes nothing.
 *   X08 — the Stripe payment-link adapter: the exact requests, idempotency
 *         keys, and an unusable health without a key.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, AUTHORITY_DECISION_KIND, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { CONTACT_BUYER_NAMESPACE, PAYMENT_LINK_NAMESPACE } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import {
  canSpamProblems,
  composeExperimentMessage,
  createExperimentPaymentLink,
  experimentProblems,
  firstTransactionExperiment,
  judgeExperiment,
  admitCost,
  observeExperiment,
  previewExperiment,
  recordExperimentPayments,
  sendExperimentOffers,
  type OfferExperiment,
} from '../server/services/cash/offerExperiment.ts';
import { createStripePaymentLinkAdapter, paymentLinkRequests } from '../server/services/cash/providers/stripe.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `offer-experiment-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'A first real transaction.' })).ok).toBe(true);
});

async function grantAll(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Experiment grant',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

async function opportunity(): Promise<string> {
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Offer experiment', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value.id;
}

function complete(opportunityId: string | null = null): OfferExperiment {
  const def = firstTransactionExperiment();
  return {
    ...def,
    opportunityId,
    offer: {
      ...def.offer,
      title: 'A job-costing spreadsheet for HVAC contractors',
      description: 'A ready-to-use spreadsheet that prices each HVAC job from parts, labour hours and margin.',
      acceptanceCondition: 'the spreadsheet opens, its formulas calculate, and it prices a sample job you send',
    },
    leadSource: { name: 'Licensed list (test)', licence: 'Licensed for B2B commercial email, opt-out honoured', contacts: 600 },
  };
}

const counter = { link: 0, mail: 0 };

function linkAdapter(): EffectAdapter {
  return {
    name: 'test.payment_link',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: PAYMENT_LINK_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (): Promise<SendOutcome> => {
      counter.link += 1;
      return { kind: 'CONFIRMED', receiptRef: 'plink_TEST1', receiptMeta: { url: 'https://buy.stripe.com/test_abc' } };
    },
  };
}

function mailAdapter(): EffectAdapter {
  return {
    name: 'test.mail',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: CONTACT_BUYER_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (request): Promise<SendOutcome> => {
      counter.mail += 1;
      return { kind: 'CONFIRMED', receiptRef: `lead_${request.businessId.slice(-8)}` };
    },
  };
}

const clean = { sends: 0, complaints: 0, paidSales: 0, acceptedDeliveries: 0, committedCostCents: 13_100 };

describe('X01: the rules', () => {
  const def = complete();
  it('runs with room under the first phase cap', () => {
    const j = judgeExperiment(def, { ...clean, sends: 100 });
    expect(j.verdict).toBe('RUNNING');
    expect(j.sendsRemaining).toBe(400);
  });
  it('kills at fewer than one paid sale per 500 sends', () => {
    expect(judgeExperiment(def, { ...clean, sends: 500 }).verdict).toBe('KILLED');
  });
  it('kills above 0.3% complaints', () => {
    const j = judgeExperiment(def, { ...clean, sends: 300, complaints: 1 });
    expect(j.verdict).toBe('KILLED');
    expect(j.sendsRemaining).toBe(0);
  });
  it('holds on an unmeasured complaint rate rather than sending on', () => {
    const j = judgeExperiment(def, { ...clean, sends: 10, complaints: null });
    expect(j.verdict).toBe('HELD');
    expect(j.sendsRemaining).toBe(0);
  });
  it('passes at one sale with an accepted delivery and extends to 2,000', () => {
    const j = judgeExperiment(def, { ...clean, sends: 500, paidSales: 1, acceptedDeliveries: 1 });
    expect(j.verdict).toBe('RUNNING');
    expect(j.sendCap).toBe(2_000);
    expect(j.sendsRemaining).toBe(1_500);
  });
  it('holds a sale without an accepted delivery at the cap', () => {
    expect(judgeExperiment(def, { ...clean, sends: 500, paidSales: 1 }).verdict).toBe('HELD');
  });
  it('kills past the exposure ceiling and refuses a cost that would cross it', () => {
    expect(judgeExperiment(def, { ...clean, committedCostCents: 15_001 }).verdict).toBe('KILLED');
    expect(admitCost(def, { committedCostCents: 13_100 }, 1_900).ok).toBe(true);
    expect(admitCost(def, { committedCostCents: 13_100 }, 1_901).ok).toBe(false);
  });
  it('reads the audit draft as invalid until the offer and lead source exist', () => {
    const fields = experimentProblems(firstTransactionExperiment()).map((one) => one.field);
    expect(fields).toEqual(expect.arrayContaining(['offer.title', 'offer.description', 'leadSource']));
    expect(experimentProblems(complete())).toEqual([]);
  });
  it('refuses a plan whose costs exceed the ceiling', () => {
    const over = { ...complete(), costs: [{ label: 'leads', cents: 20_000 }] };
    expect(experimentProblems(over).map((one) => one.field)).toContain('costs');
  });
});

describe('X02: CAN-SPAM', () => {
  it('composes a message with sender, postal address and opt-out', () => {
    const composed = composeExperimentMessage(complete(), { email: 'Owner@Example.com', name: 'Dana' }, 'https://buy.stripe.com/x');
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.message.to).toBe('owner@example.com');
    expect(composed.message.text).toContain(complete().sender!.postalAddress);
    expect(composed.message.text).toContain('no thanks');
    expect(composed.message.text).toContain('https://buy.stripe.com/x');
  });
  it('refuses a message without a postal address, an opt-out or with a reply subject', () => {
    const def = complete();
    expect(composeExperimentMessage({ ...def, sender: { ...def.sender!, postalAddress: '' } }, { email: 'a@b.co' }, null).ok).toBe(false);
    expect(composeExperimentMessage({ ...def, sender: { ...def.sender!, optOutLine: ' ' } }, { email: 'a@b.co' }, null).ok).toBe(false);
    const problems = canSpamProblems({ to: 'a@b.co', subject: 'Re: your request', text: `x ${def.sender!.postalAddress} ${def.sender!.optOutLine} ${def.sender!.name}` }, def.sender);
    expect(problems.join(' ')).toMatch(/reply or a forward/);
  });
});

describe('X03: no grant means no live effect', () => {
  it('creates no link and sends no mail even when live is requested, and records a proposal', async () => {
    counter.link = 0;
    counter.mail = 0;
    registerAdapter(linkAdapter());
    registerAdapter(mailAdapter());
    const def = complete(await opportunity());
    const link = await createExperimentPaymentLink({ projectId, experiment: def, live: true });
    expect(link.performed).toBe(false);
    if (link.performed) return;
    expect(link.blockedBy.join(' ')).toMatch(/ACCEPT_PAYMENT is not granted/);
    expect(link.proposalId).not.toBeNull();

    const batch = await sendExperimentOffers({ projectId, experiment: def, leads: [{ email: 'a@example.com' }], observation: clean, live: true });
    expect(batch.sent).toEqual([]);
    expect(batch.blockedBy.join(' ')).toMatch(/CONTACT_BUYER is not granted/);
    expect(batch.wouldSend).toHaveLength(1);

    expect(counter.link).toBe(0);
    expect(counter.mail).toBe(0);
    const rows = await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND);
    expect(rows.some((row) => JSON.stringify(row.detail).includes('PROPOSED'))).toBe(true);
  });
});

describe('X04: granted but not live', () => {
  it('still sends nothing', async () => {
    counter.link = 0;
    await grantAll();
    registerAdapter(linkAdapter());
    const def = complete(await opportunity());
    const link = await createExperimentPaymentLink({ projectId, experiment: def });
    expect(link.performed).toBe(false);
    if (!link.performed) expect(link.blockedBy).toContain('dry run: live was not requested');
    expect(counter.link).toBe(0);
  });
  it('refuses live when no billing provider is connected', async () => {
    await grantAll();
    const def = complete(await opportunity());
    const link = await createExperimentPaymentLink({ projectId, experiment: def, live: true });
    expect(link.performed).toBe(false);
    if (!link.performed) expect(link.blockedBy.join(' ')).toMatch(/no connected billing provider/);
  });
  it('refuses live sends whose message fails CAN-SPAM, even when granted', async () => {
    counter.mail = 0;
    await grantAll();
    registerAdapter(linkAdapter());
    registerAdapter(mailAdapter());
    const base = complete(await opportunity());
    await createExperimentPaymentLink({ projectId, experiment: base, live: true });
    const def = { ...base, sender: { ...base.sender!, postalAddress: 'n/a' } };
    const batch = await sendExperimentOffers({ projectId, experiment: def, leads: [{ email: 'a@example.com' }], observation: clean, live: true });
    expect(batch.sent).toEqual([]);
    expect(batch.blockedBy.join(' ')).toMatch(/postal address/);
    expect(counter.mail).toBe(0);
  });
});

describe('X05: granted and live', () => {
  it('creates the link once, mails each lead once and stops at the cap', async () => {
    counter.link = 0;
    counter.mail = 0;
    await grantAll();
    registerAdapter(linkAdapter());
    registerAdapter(mailAdapter());
    const def = { ...complete(await opportunity()), plannedSends: 2, leadSource: { name: 'L', licence: 'licensed', contacts: 10 }, rules: { ...complete().rules, killBelow: { paid: 1, perSends: 500 }, extendTo: 2_000 } };

    const first = await createExperimentPaymentLink({ projectId, experiment: def, live: true });
    expect(first.performed && first.status).toBe('CONFIRMED');
    const again = await createExperimentPaymentLink({ projectId, experiment: def, live: true });
    expect(again.performed && again.status).toBe('REPLAYED');
    expect(counter.link).toBe(1);

    const leads = [{ email: 'a@example.com' }, { email: 'A@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }];
    const batch = await sendExperimentOffers({ projectId, experiment: def, leads, observation: clean, live: true });
    expect(batch.blockedBy).toEqual([]);
    expect(batch.sent.map((one) => one.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(counter.mail).toBe(2);

    const observed = await observeExperiment({ projectId, experiment: def, complaints: 0, acceptedDeliveries: 0, committedCostCents: 0 });
    expect(observed.sends).toBe(2);
    const full = await sendExperimentOffers({ projectId, experiment: def, leads, observation: observed, live: true });
    expect(full.sent).toEqual([]);
    expect(full.blockedBy.join(' ')).toMatch(/HELD/);
    expect(counter.mail).toBe(2);
  });
});

describe('X06: payment observed becomes one ledger entry', () => {
  it('records each paid checkout once', async () => {
    await grantAll();
    registerAdapter(linkAdapter());
    const def = complete(await opportunity());
    const none = await recordExperimentPayments({ projectId, experiment: def, read: async () => ({ kind: 'READ', payments: [], complete: true }) });
    expect(none.reason).toMatch(/no payment link/);

    await createExperimentPaymentLink({ projectId, experiment: def, live: true });
    let askedFor = '';
    const read = async (linkId: string) => {
      askedFor = linkId;
      return { kind: 'READ' as const, complete: true, payments: [{ reference: 'pi_TEST1', sessionId: 'cs_1', amountCents: 4_900, currency: 'USD', paidAt: '2026-11-23T12:00:00.000Z', buyerEmail: 'buyer@example.com' }] };
    };
    const first = await recordExperimentPayments({ projectId, experiment: def, read });
    expect(askedFor).toBe('plink_TEST1');
    expect(first.recorded).toBe(1);
    expect(first.buyers[0]!.email).toBe('buyer@example.com');
    const second = await recordExperimentPayments({ projectId, experiment: def, read });
    expect(second.recorded).toBe(0);
    expect(second.replayed).toBe(1);
    const payments = (await listMoneyEntries({ projectId })).filter((one) => one.kind === 'CUSTOMER_PAYMENT');
    expect(payments).toHaveLength(1);
    expect(payments[0]!.verifiedReference).toBe('pi_TEST1');
    const observed = await observeExperiment({ projectId, experiment: def, complaints: 0, acceptedDeliveries: 0, committedCostCents: 0 });
    expect(observed.paidSales).toBe(1);
  });
});

describe('X07: the preview', () => {
  it('lists each effect with its grant, provider and cost, and writes nothing', async () => {
    const before = (await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).length;
    const preview = await previewExperiment({ projectId, experiment: firstTransactionExperiment() });
    expect(preview.live).toBe(false);
    expect(preview.ready).toBe(false);
    expect(preview.exposure).toEqual({ plannedCents: 13_100, ceilingCents: 15_000, ok: true });
    const steps = preview.effects.map((one) => one.step);
    expect(steps).toEqual(['COMMIT_COST', 'COMMIT_COST', 'COMMIT_COST', 'COMMIT_COST', 'CREATE_PAYMENT_LINK', 'SEND_OFFER', 'OBSERVE_PAYMENTS', 'PRODUCE_DELIVERABLE', 'DELIVER']);
    const link = preview.effects.find((one) => one.step === 'CREATE_PAYMENT_LINK')!;
    expect(link.grant).toMatchObject({ action: 'ACCEPT_PAYMENT', ok: false });
    expect(link.provider!.usable).toBe(false);
    const send = preview.effects.find((one) => one.step === 'SEND_OFFER')!;
    expect(send.grant).toMatchObject({ action: 'CONTACT_BUYER', ok: false });
    expect(send.blockedBy.join(' ')).toMatch(/offer.title/);
    expect((await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).length).toBe(before);
  });
  it('shows the exact payment-link request a complete offer would send', async () => {
    const preview = await previewExperiment({ projectId, experiment: complete() });
    const link = preview.effects.find((one) => one.step === 'CREATE_PAYMENT_LINK')!;
    expect(link.request).toEqual(paymentLinkRequests({ amountCents: 4_900, currency: 'USD', productName: complete().offer.title, confirmationMessage: `Thank you. ${complete().offer.acceptanceCondition}` }, 'paylink-first-transaction-1'));
  });
});

describe('X08: the Stripe payment-link adapter', () => {
  it('is unusable without a key and sends nothing', async () => {
    let calls = 0;
    const adapter = createStripePaymentLinkAdapter({ namespace: PAYMENT_LINK_NAMESPACE.name, env: {}, fetch: async () => { calls += 1; return new Response('{}'); } });
    expect(adapter.health!().usable).toBe(false);
    const outcome = await adapter.send({ providerKey: null, businessId: 'paylink-x', payload: { amountCents: 4900, currency: 'USD', productName: 'P', confirmationMessage: 'Thanks' } });
    expect(outcome.kind).toBe('REJECTED');
    expect(calls).toBe(0);
  });
  it('creates a price then a link, each with its own idempotency key', async () => {
    const seen: { url: string; key: string | null; body: string }[] = [];
    const adapter = createStripePaymentLinkAdapter({
      namespace: PAYMENT_LINK_NAMESPACE.name,
      env: { BRAIN_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24) },
      fetch: async (url, init) => {
        const headers = init.headers as Record<string, string>;
        seen.push({ url, key: headers['Idempotency-Key'] ?? null, body: String(init.body) });
        const body = url.endsWith('/v1/prices') ? { id: 'price_1' } : { id: 'plink_1', url: 'https://buy.stripe.com/test_1' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(adapter.health!().usable).toBe(true);
    const outcome = await adapter.send({ providerKey: null, businessId: 'paylink-x', payload: { amountCents: 4900, currency: 'USD', productName: 'P', confirmationMessage: 'Thanks' } });
    expect(outcome).toMatchObject({ kind: 'CONFIRMED', receiptRef: 'plink_1' });
    expect(seen.map((one) => one.key)).toEqual(['brain-paylink-x-price', 'brain-paylink-x-link']);
    expect(new URLSearchParams(seen[1]!.body).get('line_items[0][price]')).toBe('price_1');
    expect(new URLSearchParams(seen[1]!.body).get('metadata[brain_payment_link]')).toBe('paylink-x');
  });
});
