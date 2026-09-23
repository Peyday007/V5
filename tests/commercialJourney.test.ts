/**
 * The commercial journey, walked: an opening chosen from evidence, a demand
 * test formed from recorded facts only, the buyer's replies, an obligation,
 * a checked delivery, the buyer's acceptance, an invoice, the provider's
 * payment and settlement — and the briefing Russell reads, at every stage.
 *
 * What this suite exists to pin are the refusals, because the expensive
 * mistakes here are acceptances: a test formed from an invented buyer, an
 * interested reply counted as a sale, delivered work counted as accepted, a
 * promise counted as cash, and an opening sold by two members at once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshProject } from './helpers.ts';
import { walkToCollected } from './helpers/commerce.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';
import { listDemandTests, listObligations } from '../server/repos/cashCommerce.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { advance, capture, fillCard } from '../server/services/cash/opportunities.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import { selectOpening } from '../server/services/cash/commerce/select.ts';
import { operateCommerce } from '../server/services/cash/commerce/tick.ts';
import {
  prepareDemandTest,
  readTest,
  recordBuyerResponse,
  recordTestContact,
} from '../server/services/cash/commerce/demand.ts';
import {
  deliver,
  prepareOffer,
  recordAgreement,
  recordObligationAnswer,
  startProduction,
} from '../server/services/cash/commerce/obligation.ts';
import { issueInvoice, recordInvoiceState } from '../server/services/cash/commerce/payment.ts';
import { commercialBriefing } from '../server/services/cash/commerce/briefing.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { applyValidationAnswers, startValidations } from '../server/services/cash/validation.ts';
import { ensureDiscoveryAuthority } from '../server/services/cash/discoveryAuthority.ts';
import { proposeCommercialTerms } from '../server/services/cash/operate.ts';

let projectId = '';
let userId = '';
let otherId = '';
const NOW = () => new Date().toISOString();

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  userId = (
    await createUser({ email: `owner-${Math.random().toString(36).slice(2)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
  otherId = (
    await createUser({ email: `other-${Math.random().toString(36).slice(2)}@example.test`, displayName: 'Other', password: 'correct horse battery staple' })
  ).id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
});

async function opening(input: {
  title: string;
  signal: string;
  payer?: string;
  channel?: string;
  offer?: string;
  price?: number;
}): Promise<string> {
  const made = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: input.title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!made.ok) throw new Error(made.reason);
  await getDb().run('UPDATE cash_opportunities SET opportunity_signal = ? WHERE id = ?', [input.signal, made.value.id]);
  if (input.payer || input.channel || input.offer || input.price) {
    const filled = await fillCard({
      opportunityId: made.value.id,
      actorRef: userId,
      patch: {
        ...(input.payer ? { payer: input.payer } : {}),
        ...(input.channel ? { reachableChannel: input.channel } : {}),
        ...(input.offer ? { offerScope: input.offer } : {}),
        ...(input.price ? { priceCents: input.price } : {}),
      },
    });
    if (!filled.ok) throw new Error(filled.reason);
  }
  return made.value.id;
}

async function grant(actions: readonly string[] = COMMERCIAL_ACTIONS): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Commercial authority',
    allowedActions: [...actions],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

describe('choosing what to sell', () => {
  it('selects nothing when no opening has a buyer, a route and an offer, and names the decisive gap', async () => {
    const price = await opening({ title: 'A vendor publishes $1.99 a minute', signal: 'PRICING_OR_INFORMATION_ASYMMETRY' });
    const request = await opening({ title: 'A client posted a paid 5-page site build', signal: 'PAID_TASK_OR_CONTRACT' });
    const selection = await selectOpening({ projectId, now: NOW() });
    expect(selection.selected).toBeNull();
    // A buyer asking outranks somebody else's price list.
    expect(selection.closest?.opportunityId).toBe(request);
    expect(selection.decisiveGap).toContain('who would buy it');
    expect(selection.decisiveGap).toContain(request);
    expect(selection.readings.map((one) => one.opportunityId)).toContain(price);

    const pass = await operateCommerce(projectId);
    expect(pass.prepared).toBeNull();
    expect(await listDemandTests(projectId)).toHaveLength(0);

    const briefing = await commercialBriefing({ projectId, now: NOW() });
    expect(briefing.decisions).toHaveLength(0);
    expect(briefing.text).toContain('Nothing is being sold yet');
    expect(briefing.blocked[0]?.text).toContain('decisive step');
  });

  it('prepares one test from recorded facts, once, and asks for the authority it needs', async () => {
    const id = await opening({
      title: 'Clinic asked for an intake-form repair',
      signal: 'ACTIVE_BUYER_DEMAND',
      payer: 'Clinic practice manager',
      channel: 'The contact form on their own site',
      offer: 'Repair the intake form so enquiries arrive; excludes redesign',
      price: 50_000,
    });
    const first = await operateCommerce(projectId);
    expect(first.prepared).not.toBeNull();
    const again = await operateCommerce(projectId);
    expect(again.prepared).toBeNull();
    const tests = await listDemandTests(projectId);
    expect(tests).toHaveLength(1);
    expect(tests[0]!.preparedBy).toBe('BRAIN');
    expect(tests[0]!.audience).toBe('Clinic practice manager');
    expect(tests[0]!.basis).toContain(id);

    // No grant: nobody may be asked, and the decision is prepared in full.
    const refused = await recordTestContact({ testId: tests[0]!.id, projectId, recipient: 'manager@clinic.test', reference: 'mail:1', actorRef: userId });
    expect(refused.ok).toBe(false);
    const briefing = await commercialBriefing({ projectId, now: NOW() });
    const decision = briefing.decisions.find((one) => one.authorityAction === 'CONTACT_BUYER');
    expect(decision?.recipient).toContain('Clinic practice manager');
    expect(decision?.amountCents).toBe(0);
    expect(decision?.scope).toContain('intake form');
    expect(decision?.consequence).toContain('No money moves');
  });

  it('refuses to invent a missing input rather than testing an assumption', async () => {
    const id = await opening({ title: 'No route', signal: 'ACTIVE_BUYER_DEMAND', payer: 'A buyer', offer: 'A thing' });
    const made = await prepareDemandTest({ projectId, opportunityId: id, ownerUserId: userId, preparedBy: 'PERSON', actorRef: userId, basis: 'x' });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.reason).toContain('how to reach them');
  });
});

describe('testing demand', () => {
  async function running(): Promise<{ id: string; testId: string }> {
    const id = await opening({
      title: 'Clinic intake repair',
      signal: 'ACTIVE_BUYER_DEMAND',
      payer: 'Clinic managers',
      channel: 'Direct email',
      offer: 'Intake form repair',
      price: 50_000,
    });
    await grant();
    const test = await prepareDemandTest({
      projectId, opportunityId: id, ownerUserId: userId, preparedBy: 'PERSON', actorRef: userId,
      maxContacts: 3, stopAfterContacts: 3, continueIfAgreed: 1, changeIfInterested: 2, basis: 'The card.',
    });
    if (!test.ok) throw new Error(test.reason);
    return { id, testId: test.value.id };
  }

  it('records each contact as an authorized action and stops at the declared limit', async () => {
    const { testId } = await running();
    for (const who of ['a@x.test', 'b@x.test', 'c@x.test']) {
      const sent = await recordTestContact({ testId, projectId, recipient: who, reference: `mail:${who}`, actorRef: userId });
      expect(sent.ok).toBe(true);
    }
    const fourth = await recordTestContact({ testId, projectId, recipient: 'd@x.test', reference: 'mail:d', actorRef: userId });
    expect(fourth.ok).toBe(false);
    const actions = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM cash_actions WHERE action = 'CONTACT_BUYER'");
    expect(Number(actions[0]!.n)).toBe(3);
  });

  it('never counts interest as agreement, and concludes on its own thresholds', async () => {
    const { id, testId } = await running();
    for (const who of ['a@x.test', 'b@x.test', 'c@x.test']) {
      await recordTestContact({ testId, projectId, recipient: who, reference: `mail:${who}`, actorRef: userId });
    }
    for (const who of ['a@x.test', 'b@x.test']) {
      const said = await recordBuyerResponse({
        projectId, opportunityId: id, testId, respondent: who, kind: 'INTEREST', channel: 'email', reference: `mail:re-${who}`, excerpt: 'Sounds useful, tell me more.', actorRef: userId,
      });
      expect(said.ok).toBe(true);
    }
    const read = await readTest((await listDemandTests(projectId))[0]!);
    expect(read.counts.interested).toBe(2);
    expect(read.counts.agreed).toBe(0);
    expect(read.pending?.verdict).toBe('CHANGE');
    await operateCommerce(projectId);
    const concluded = (await listDemandTests(projectId))[0]!;
    expect(concluded.state).toBe('CONCLUDED');
    expect(concluded.verdict).toBe('CHANGE');
    expect((await cashPosition({ projectId, currency: 'USD' })).pipelineCents).toBe(0);
  });

  it('refuses a response with no reference, because a recollection is not a record', async () => {
    const { id, testId } = await running();
    const said = await recordBuyerResponse({ projectId, opportunityId: id, testId, respondent: 'a', kind: 'AGREED_TO_BUY', channel: 'phone', reference: ' ', excerpt: 'yes', actorRef: userId });
    expect(said.ok).toBe(false);
  });

  it('turns an agreement into an obligation that is pipeline, not revenue', async () => {
    const { id, testId } = await running();
    await recordTestContact({ testId, projectId, recipient: 'a@x.test', reference: 'mail:a', actorRef: userId });
    const yes = await recordBuyerResponse({ projectId, opportunityId: id, testId, respondent: 'a@x.test', kind: 'AGREED_TO_BUY', channel: 'email', reference: 'mail:yes', excerpt: 'Yes please, do it for $500.', actorRef: userId });
    if (!yes.ok) throw new Error(yes.reason);
    const agreed = await recordAgreement({
      projectId, responseId: yes.value.id, ownerUserId: userId, actorRef: userId,
      terms: { buyer: 'a@x.test', scope: 'Intake form repair', priceCents: 50_000, acceptanceConditions: ['A test enquiry arrives'], deliveryPlan: 'Operator configures it', deliveryRoute: 'HUMAN' },
    });
    expect(agreed.ok).toBe(true);
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.pipelineCents).toBe(50_000);
    expect(position.availableFundsCents).toBe(0);
    expect(position.customerPaymentsCents).toBe(0);
    const briefing = await commercialBriefing({ projectId, now: NOW() });
    expect(briefing.money?.pipelineCents).toBe(50_000);
    expect(briefing.money?.customerPaymentsCents).toBe(0);
    await operateCommerce(projectId);
    expect((await listDemandTests(projectId))[0]!.verdict).toBe('CONTINUE');
  });
});

describe('delivering and collecting', () => {
  async function ready(): Promise<string> {
    await grant();
    return opening({ title: 'Clinic intake repair', signal: 'ACTIVE_BUYER_DEMAND', payer: 'Clinic', channel: 'email', offer: 'Repair', price: 75_000 });
  }

  it('refuses a bare move to delivering or collected', async () => {
    const id = await ready();
    expect((await advance({ opportunityId: id, to: 'COLLECTED', actorRef: userId })).ok).toBe(false);
    expect((await advance({ opportunityId: id, to: 'DELIVERING', actorRef: userId })).ok).toBe(false);
  });

  it('checks delivered work against every acceptance condition, and only the buyer accepts it', async () => {
    const id = await ready();
    const { obligation } = await walkToCollected({ projectId, opportunityId: id, userId, stopAt: 'DELIVERING' });
    const base = { obligationId: obligation.id, projectId, actorRef: userId };
    const unchecked = await deliver({ ...base, deliverableReference: 'mail:h', checks: [] });
    expect(unchecked.ok).toBe(false);
    const unmet = await deliver({ ...base, deliverableReference: 'mail:h', checks: [{ condition: 'Form submits and a test enquiry arrives', met: false, evidence: 'nothing arrived' }] });
    expect(unmet.ok).toBe(false);
    const ok = await deliver({ ...base, deliverableReference: 'mail:h', checks: [{ condition: 'Form submits and a test enquiry arrives', met: true, evidence: 'enquiry #1' }] });
    expect(ok.ok && ok.value.state).toBe('DELIVERED');

    const revise = await recordObligationAnswer({ ...base, kind: 'REVISION_REQUESTED', channel: 'email', reference: 'mail:r', excerpt: 'The button label is wrong.' });
    expect(revise.ok && revise.value.state).toBe('REVISION_REQUESTED');
    expect(revise.ok && revise.value.revisionCount).toBe(1);
    await startProduction({ ...base, productionReference: 'operator: fix label' });
    await deliver({ ...base, deliverableReference: 'mail:h2', checks: [{ condition: 'Form submits and a test enquiry arrives', met: true, evidence: 'enquiry #2' }] });
    const promise = await recordObligationAnswer({ ...base, kind: 'PAYMENT_PROMISED', channel: 'email', reference: 'mail:p', excerpt: 'Will pay Friday.' });
    expect(promise.ok && promise.value.state).toBe('DELIVERED');
    expect((await cashPosition({ projectId, currency: 'USD' })).customerPaymentsCents).toBe(0);
    const accepted = await recordObligationAnswer({ ...base, kind: 'ACCEPTED_DELIVERY', channel: 'email', reference: 'mail:ok', excerpt: 'Works.' });
    expect(accepted.ok && accepted.value.state).toBe('ACCEPTED');
  });

  it('keeps paid apart from settled, records the fee as a cost, and collects only on settlement', async () => {
    const id = await ready();
    const { obligation, invoice } = await walkToCollected({ projectId, opportunityId: id, userId, stopAt: 'PAID' });
    let position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.customerPaymentsCents).toBe(75_000);
    expect(position.availableFundsCents).toBe(0);
    expect((await advance({ opportunityId: id, to: 'COLLECTED', actorRef: userId })).ok).toBe(false);
    expect((await getOpportunity(id))?.state).not.toBe('COLLECTED');

    const settled = await recordInvoiceState({ invoiceId: invoice!.id, projectId, to: 'SETTLED', reference: 'po_9', settledAmountCents: 72_795, actorRef: userId });
    expect(settled.ok).toBe(true);
    position = await cashPosition({ projectId, currency: 'USD' });
    // Exactly what reached the account: gross settlement less the fee, once.
    expect(position.availableFundsCents).toBe(72_795);
    expect(position.completedContributionCents).toBe(75_000 - 2_205);
    expect((await listObligations({ projectId }))[0]!.state).toBe('CLOSED');
    expect((await getOpportunity(id))?.state).toBe('COLLECTED');
    expect(obligation.id).toBeTruthy();

    const briefing = await commercialBriefing({ projectId, now: NOW() });
    expect(briefing.money?.pipelineCents).toBe(0);
    expect(briefing.learned.join(' ')).toContain('settled');
  });

  it('refuses invoicing more than was agreed, and invoicing without the authority to', async () => {
    const id = await ready();
    const { obligation } = await walkToCollected({ projectId, opportunityId: id, userId, stopAt: 'DELIVERING' });
    const over = await issueInvoice({ obligationId: obligation.id, projectId, amountCents: 80_000, provider: 'stripe', providerReference: 'in_x', actorRef: userId });
    expect(over.ok).toBe(false);
  });
});

describe('one opening, one member', () => {
  it('refuses a second member competing for the same opening', async () => {
    await grant();
    const id = await opening({ title: 'Clinic', signal: 'ACTIVE_BUYER_DEMAND', payer: 'Clinic', channel: 'email', offer: 'Repair', price: 10_000 });
    const mine = await prepareDemandTest({ projectId, opportunityId: id, ownerUserId: userId, preparedBy: 'PERSON', actorRef: userId, basis: 'card' });
    expect(mine.ok).toBe(true);
    const theirs = await prepareOffer({
      projectId, opportunityId: id, ownerUserId: otherId, actorRef: otherId,
      terms: { buyer: 'Clinic', scope: 'Repair', priceCents: 10_000, acceptanceConditions: ['works'], deliveryPlan: 'x', deliveryRoute: 'HUMAN' },
    });
    expect(theirs.ok).toBe(false);
  });
});

describe('after the sprint winds down', () => {
  it('stops new tests and keeps every obligation and invoice moving, and says so', async () => {
    await grant();
    const id = await opening({ title: 'Clinic', signal: 'ACTIVE_BUYER_DEMAND', payer: 'Clinic', channel: 'email', offer: 'Repair', price: 75_000 });
    const { invoice } = await walkToCollected({ projectId, opportunityId: id, userId, stopAt: 'PAID' });
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'Sprint over.' });
    const other = await opening({ title: 'Another', signal: 'ACTIVE_BUYER_DEMAND' }).catch(() => null);
    expect(other).toBeNull();
    const briefing = await commercialBriefing({ projectId, now: NOW() });
    expect(briefing.continuing.some((one) => one.text.includes('PAID'))).toBe(true);
    const settled = await recordInvoiceState({ invoiceId: invoice!.id, projectId, to: 'SETTLED', reference: 'po_1', actorRef: userId });
    expect(settled.ok).toBe(true);
    expect((await getOpportunity(id))?.state).toBe('COLLECTED');
  });
});

describe('Russell answers from the records', () => {
  it('puts the live briefing into every Cash turn a worker answers', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../server/services/russell/turn.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/await commercialContextFor\(projectId\)/);
    expect(source).toMatch(/commercialBriefing\(\{ projectId/);
  });

  it('answers the four questions in order, from rows', async () => {
    await grant(['QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT', 'CONTACT_BUYER']);
    const id = await opening({ title: 'Clinic', signal: 'ACTIVE_BUYER_DEMAND', payer: 'Clinic', channel: 'email', offer: 'Repair', price: 75_000 });
    await walkToCollected({ projectId, opportunityId: id, userId, stopAt: 'DELIVERING' });
    const text = (await commercialBriefing({ projectId, now: NOW() })).text;
    const order = ['WHAT WE ARE DOING TO MAKE MONEY', 'WHAT HAS ACTUALLY HAPPENED', 'WHAT IS BLOCKED', 'WHAT SHOULD HAPPEN NEXT', 'DECISIONS THAT NEED YOUR AUTHORITY'];
    let at = -1;
    for (const heading of order) {
      const found = text.indexOf(heading);
      expect(found).toBeGreaterThan(at);
      at = found;
    }
    expect(text).toContain('In production');
    expect(text).toContain('pipeline USD 750.00');
  });
});

describe('Brain finds the buyer and the route itself', () => {
  /**
   * A finished deep dive on one opening, carrying accepted claims in the lanes
   * the validation profile declares — the rows a worker's gated submission
   * leaves, written directly so the assertion is about what reaches the card.
   */
  async function finishedDive(
    opportunityId: string,
    claims: { lane: string; claim: string; negative?: boolean }[],
  ): Promise<void> {
    const layerId = (await getDb().get<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [projectId]))!.id;
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'qualify' });
    const orchestration = await createOrchestration({
      projectId, layerId, runId: run.id, title: 'Qualify', assignment: 'Who pays and how to reach them', provider: 'WORKER', autoApprove: false,
    });
    await createFragments([
      {
        orchestrationId: orchestration.id, projectId, layerId, geography: 'where the request was published',
        requiredEvidence: [{ id: 'payer', description: 'who pays', necessity: 'REQUIRED' }],
        acceptableSourceTypes: ['the request itself'], excludedSourceTypes: ['a forecast'],
        completionCriteria: ['a located passage'], minIndependentSources: 1, maxRepairs: 2,
        fragmentIndex: 0, fragmentKey: 'qualify', question: 'Who pays, and how are they reached?', dependsOn: [], attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(orchestration.id);
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: NOW(), blockedReason: null });
    const inserted = await insertClaims(
      claims.map((one) => ({
        orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
        claim: one.claim, sourceUrl: 'https://example.test/request/42', sourceTitle: 'The request', sourcePublisher: 'The marketplace',
        sourceDate: '2026-09-20', evidenceExcerpt: one.claim, evidenceLocator: 'the request body', evidenceLane: one.lane,
        retrievedAt: '2026-09-21', confidence: 0.9, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
        claimType: one.negative ? ('NEGATIVE_EXISTENCE' as const) : ('SOURCED_FACT' as const), contentHash: `${one.lane}|${one.claim}`,
      })),
    );
    for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
    await getDb().run(
      "UPDATE cash_opportunities SET validation_state = 'COMPLETE', validation_orchestration_id = ? WHERE id = ?",
      [orchestration.id, opportunityId],
    );
  }

  it('records the payer and the published route a deep dive established, and a test follows from them', async () => {
    const id = await opening({ title: 'A clinic posted a paid intake-form repair', signal: 'PAID_TASK_OR_CONTRACT' });
    await getDb().run('UPDATE cash_opportunities SET buying_signal = ? WHERE id = ?', ['Repair our patient intake form; budget stated.', id]);
    expect(await operateCommerce(projectId)).toMatchObject({ prepared: null });

    await finishedDive(id, [
      { lane: 'payer', claim: 'Lakeside Clinic is the named client on the posting.' },
      { lane: 'contact_mode', claim: 'Proposals are submitted through the marketplace message thread on the posting; no phone number is given.' },
    ]);
    await applyValidationAnswers(projectId);
    const card = await getOpportunity(id);
    expect(card?.payer).toContain('Lakeside Clinic');
    // The route the dive read reaches the access field, not only the phone question.
    expect(card?.reachableChannel).toContain('marketplace message thread');
    expect((await cardFact(id, 'access'))?.kind).toBe('EVIDENCE');
    expect((await cardFact(id, 'phoneDependency'))?.value).toContain('no phone number');

    // Brain proposes the offer from the request itself, and then can form a
    // test from its own research with no person having typed a buyer.
    await proposeCommercialTerms(projectId);
    expect((await getOpportunity(id))?.offerScope).toBeTruthy();
    const pass = await operateCommerce(projectId);
    expect(pass.prepared).toBeTruthy();
    const [test] = await listDemandTests(projectId);
    expect(test?.opportunityId).toBe(id);
    expect(test?.maxSpendCents).toBe(0);
    // Prepared is not contacted: nobody has been reached.
    expect(test?.state).toBe('PREPARED');
  });

  it('never records a documented absence as a payer or a route', async () => {
    const id = await opening({ title: 'A price list somebody publishes', signal: 'PAID_TASK_OR_CONTRACT' });
    await finishedDive(id, [
      { lane: 'payer', claim: 'No published source names who would pay for this.', negative: true },
      { lane: 'contact_mode', claim: 'No published route to any buyer was found.', negative: true },
    ]);
    await applyValidationAnswers(projectId);
    const card = await getOpportunity(id);
    expect(card?.payer).toBeNull();
    expect(card?.reachableChannel).toBeNull();
    expect(await cardFact(id, 'payer')).toBeNull();
    expect(await cardFact(id, 'access')).toBeNull();
    expect((await operateCommerce(projectId)).prepared).toBeNull();
  });

  it('dives on the opening somebody asked for before a price list, when neither has answered more', async () => {
    await ensureDiscoveryAuthority(projectId);
    // Created in both orders, so arrival cannot be what decides it.
    const request = await opening({ title: 'A client posted a paid 5-page site build', signal: 'PAID_TASK_OR_CONTRACT' });
    const price = await opening({ title: 'A vendor publishes $1.99 a minute', signal: 'PRICING_OR_INFORMATION_ASYMMETRY' });
    const later = await opening({ title: 'A second client posted a paid logo', signal: 'ACTIVE_BUYER_DEMAND' });
    for (const one of [price, request, later]) {
      await getDb().run('UPDATE cash_opportunities SET buying_signal = ? WHERE id = ?', ['published', one]);
    }
    const started = await startValidations({ projectId, limit: 2 });
    expect(started.map((one) => one.opportunityId).sort()).toEqual([later, request].sort());
    expect(started.map((one) => one.opportunityId)).not.toContain(price);
  });
});
