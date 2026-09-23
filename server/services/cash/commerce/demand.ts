/**
 * A demand test: who is asked, how, with what offer, how many at most, and the
 * counts at which the answer is "continue", "change" or "stop".
 *
 * Three rules shape it.
 *
 * **Brain may prepare a test and may never pretend to have run one.** Forming a
 * test is a write about our own intentions and spends nothing, so the tick does
 * it for the opening `select.ts` chooses. Asking a person is a
 * `CONTACT_BUYER` action under the standing commercial grant, recorded as a
 * `cash_actions` row naming who performed it. Brain holds no messaging
 * capability today (`SEND_A_MESSAGE` reads MISSING), so every contact is
 * performed and confirmed by a person, and the record says so.
 *
 * **What somebody said is stored verbatim, with where it can be read.** A
 * response without a reference is a recollection. `INTEREST` and
 * `AGREED_TO_BUY` are two kinds, and nothing here ever counts one as the other.
 *
 * **The verdict is arithmetic over those rows.** The test declares its own
 * thresholds before anybody is asked, so the conclusion cannot be fitted to the
 * result afterwards.
 */
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { recordAction } from '../../../repos/cashActions.ts';
import { liveJobFor } from '../../../repos/cashJobs.ts';
import {
  commerceNow,
  contactsFor,
  createDemandTest,
  getDemandTest,
  listObligations,
  liveTestFor,
  recordContact,
  recordResponse as writeResponse,
  responsesFor,
  transitionDemandTest,
} from '../../../repos/cashCommerce.ts';
import { checkCommercialAuthority } from '../authority.ts';
import { discoveryAllowed } from '../lifecycle.ts';
import {
  INTERESTED_KINDS,
  LIVE_OBLIGATION_STATES,
  RESPONSE_KINDS,
  isOneOf,
  type CashDemandTest,
  type CashResponse,
  type DemandVerdict,
  type ResponseKind,
} from '../../../domain/commerce.ts';
import type { CashOpportunity } from '../../../domain/types.ts';
import type { OpeningReading } from './select.ts';

export type Refusal = { ok: false; reason: string };
export type Outcome<T> = { ok: true; value: T; message: string } | Refusal;

export function refuse(reason: string): Refusal {
  return { ok: false, reason };
}

function required(value: unknown, name: string): string | Refusal {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : refuse(`${name} is required, and it cannot be blank.`);
}

/** Days from an instant, as an ISO string. */
export function addDays(at: string, days: number): string {
  return new Date(Date.parse(at) + days * 86_400_000).toISOString();
}

/**
 * Whether this person may work this opening without competing with somebody.
 *
 * One opening, one person running it. A live job, a live test or a live
 * obligation held by somebody else is a refusal naming nothing but the fact,
 * because who holds it is that person's private working.
 */
export async function competitionFor(
  opportunity: CashOpportunity,
  userId: string,
): Promise<string | null> {
  const job = await liveJobFor(opportunity.id);
  if (job && job.ownerUserId && job.ownerUserId !== userId) {
    return 'Somebody else is already working this opening. Two people selling one opening to the same buyer is the competition this refuses.';
  }
  const test = await liveTestFor(opportunity.id);
  if (test && test.ownerUserId !== userId) {
    return 'Another member is already testing demand for this opening.';
  }
  const live = await listObligations({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    states: LIVE_OBLIGATION_STATES,
  });
  if (live.some((one) => one.ownerUserId !== userId)) {
    return 'Another member already has an offer or an obligation open on this opening.';
  }
  return null;
}

/**
 * The outreach text for a test, composed from recorded facts only.
 *
 * It names the offer and asks one question the answer to which is countable.
 * It does not mention a price that is not recorded, a credential nobody holds,
 * or a claim about us nobody has verified.
 */
export function draftMessage(input: {
  audience: string;
  offer: string;
  priceCents: number | null;
  currency: string;
}): string {
  const price =
    input.priceCents === null
      ? ''
      : ` The price is ${input.currency} ${(input.priceCents / 100).toFixed(2)}.`;
  return (
    `Hello — this is about your published need. We can deliver: ${input.offer}.${price} ` +
    'Would you like us to do this for you? A yes, a no, or a question about the scope all help.'
  );
}

export interface PrepareInput {
  projectId: string;
  opportunityId: string;
  ownerUserId: string;
  preparedBy: 'BRAIN' | 'PERSON';
  actorRef: string;
  audience?: string;
  channel?: string;
  offer?: string;
  priceCents?: number | null;
  maxContacts?: number;
  maxSpendCents?: number;
  windowDays?: number;
  continueIfAgreed?: number;
  changeIfInterested?: number;
  stopAfterContacts?: number;
  /** Where the audience, channel and offer came from. Required of a person's own. */
  basis?: string;
}

/**
 * Prepare a test. Spends nothing and contacts nobody.
 *
 * New tests are new discovery, so they stop when the sprint winds down; the
 * tests already running do not.
 */
export async function prepareDemandTest(
  input: PrepareInput,
  reading?: OpeningReading,
): Promise<Outcome<CashDemandTest>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) {
    return refuse('No opportunity with that id.');
  }
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed) return refuse(gate.reason);
  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');

  const competing = await competitionFor(opportunity, input.ownerUserId);
  if (competing) return refuse(competing);

  const audience = (input.audience ?? reading?.inputs.payer ?? opportunity.payer ?? '').trim();
  const channel = (input.channel ?? reading?.inputs.access ?? opportunity.reachableChannel ?? '').trim();
  const offer = (input.offer ?? reading?.inputs.offer ?? opportunity.offerScope ?? '').trim();
  const missing = [
    audience ? null : 'who would buy it',
    channel ? null : 'how to reach them',
    offer ? null : 'what is offered',
  ].filter(Boolean);
  if (missing.length > 0) {
    return refuse(
      `A demand test needs ${missing.join(', ')}, and none of them may be invented. Record ` +
        'them on the opportunity from evidence first.',
    );
  }
  const maxContacts = input.maxContacts ?? 10;
  const stopAfter = input.stopAfterContacts ?? maxContacts;
  if (!Number.isInteger(maxContacts) || maxContacts < 1 || maxContacts > 200) {
    return refuse('The number of people asked must be a whole number from 1 to 200.');
  }
  if (!Number.isInteger(stopAfter) || stopAfter < 1 || stopAfter > maxContacts) {
    return refuse('The stop rule must trigger at or before the contact limit, or it never fires.');
  }
  const continueIfAgreed = input.continueIfAgreed ?? 1;
  const changeIfInterested = input.changeIfInterested ?? 2;
  if (continueIfAgreed < 1 || changeIfInterested < 1) {
    return refuse('The continue and change thresholds are counts of at least one.');
  }
  const maxSpendCents = input.maxSpendCents ?? 0;
  if (!Number.isInteger(maxSpendCents) || maxSpendCents < 0) {
    return refuse('The spend limit is a whole number of cents, zero or more.');
  }
  const priceCents = input.priceCents === undefined ? opportunity.priceCents : input.priceCents;
  const at = commerceNow();
  const basis =
    input.basis?.trim() ||
    (input.preparedBy === 'BRAIN'
      ? `Audience, channel and offer are the values recorded on ${opportunity.id}` +
        (opportunity.sourceClaimId ? `, whose evidence is claim ${opportunity.sourceClaimId}` : '') +
        '. Nothing was composed that is not on the record.'
      : '');
  if (!basis) return refuse('Say where the audience, channel and offer came from.');

  const { test, created } = await createDemandTest({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    ownerUserId: input.ownerUserId,
    preparedBy: input.preparedBy,
    audience,
    channel,
    offer,
    priceCents,
    currency: mode.currency,
    maxContacts,
    maxSpendCents,
    windowEndsAt: addDays(at, input.windowDays ?? 14),
    continueIfAgreed,
    changeIfInterested,
    stopAfterContacts: stopAfter,
    draftMessage: draftMessage({ audience, offer, priceCents, currency: mode.currency }),
    basis,
  });
  if (created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_DEMAND_TEST_PREPARED',
      actorRef: input.actorRef,
      summary: `A demand test was prepared: ask up to ${maxContacts} of "${audience}" via ${channel}.`,
      detail: { testId: test.id, preparedBy: input.preparedBy },
    });
  }
  return {
    ok: true,
    value: test,
    message: created ? 'Prepared. Nobody has been contacted.' : 'This opening already has a live test.',
  };
}

/**
 * Somebody was asked. The one external effect a test has, so it is authorized.
 *
 * Refused without a live grant covering `CONTACT_BUYER`, beyond the declared
 * contact limit, after the window, or for a test that has concluded. The first
 * contact moves the test to RUNNING.
 */
export async function recordTestContact(input: {
  testId: string;
  projectId: string;
  recipient: string;
  /** Where the sent message can be read: a message id, a URL, a thread. */
  reference: string;
  sentAt?: string;
  actorRef: string;
  performedBy?: 'PERSON' | 'BRAIN';
}): Promise<Outcome<{ test: CashDemandTest; contacts: number }>> {
  const test = await getDemandTest(input.testId);
  if (!test || test.projectId !== input.projectId) return refuse('No demand test with that id.');
  if (test.state !== 'PREPARED' && test.state !== 'RUNNING') {
    return refuse(`This test is ${test.state.toLowerCase()}; nobody more may be asked under it.`);
  }
  const recipient = required(input.recipient, 'recipient');
  if (typeof recipient !== 'string') return recipient;
  const reference = required(input.reference, 'reference');
  if (typeof reference !== 'string') return reference;
  const at = commerceNow();
  if (at > test.windowEndsAt) return refuse('The test window has closed; conclude it instead.');

  const existing = await contactsFor(test.id);
  if (!existing.some((one) => one.recipient === recipient) && existing.length >= test.maxContacts) {
    return refuse(`This test declared at most ${test.maxContacts} contacts, and they are used.`);
  }
  const decision = await checkCommercialAuthority({ projectId: test.projectId, action: 'CONTACT_BUYER' });
  if (!decision.ok || !decision.authority) {
    return refuse(
      `Contacting a buyer needs a standing commercial authority covering CONTACT_BUYER, and ${decision.reason}.`,
    );
  }
  const action = await recordAction({
    projectId: test.projectId,
    opportunityId: test.opportunityId,
    authorityId: decision.authority.id,
    action: 'CONTACT_BUYER',
    performedBy: input.performedBy ?? 'PERSON',
    reference,
    detail: `Demand test ${test.id}: asked ${recipient} via ${test.channel}.`,
    confirmedBy: input.actorRef,
    requestKey: `test-contact:${test.id}:${recipient}`,
  });
  await recordContact({
    testId: test.id,
    projectId: test.projectId,
    opportunityId: test.opportunityId,
    actionId: action.action.id,
    recipient,
    sentAt: input.sentAt ?? at,
  });
  await transitionDemandTest({ id: test.id, from: ['PREPARED'], to: 'RUNNING' });
  const after = (await getDemandTest(test.id))!;
  const contacts = (await contactsFor(test.id)).length;
  if (action.created) {
    await recordCashEvent({
      projectId: test.projectId,
      opportunityId: test.opportunityId,
      kind: 'CASH_DEMAND_CONTACT',
      actorRef: input.actorRef,
      summary: `Asked ${recipient} (${contacts} of ${test.maxContacts}).`,
      detail: { testId: test.id, actionId: action.action.id },
    });
  }
  return { ok: true, value: { test: after, contacts }, message: 'Recorded.' };
}

/**
 * Something a buyer or a prospect said, verbatim, with where it can be read.
 *
 * The key is built from the opening, the respondent, the kind and the
 * reference, so recording the same message twice is one row.
 */
export async function recordBuyerResponse(input: {
  projectId: string;
  opportunityId: string;
  testId?: string | null;
  obligationId?: string | null;
  respondent: string;
  kind: string;
  channel: string;
  reference: string;
  excerpt: string;
  receivedAt?: string;
  actorRef: string;
  performedBy?: 'PERSON' | 'BRAIN';
}): Promise<Outcome<CashResponse>> {
  if (!isOneOf(RESPONSE_KINDS, input.kind)) {
    return refuse(`A response is one of: ${RESPONSE_KINDS.join(', ')}.`);
  }
  for (const [name, value] of [
    ['respondent', input.respondent],
    ['channel', input.channel],
    ['reference', input.reference],
    ['excerpt', input.excerpt],
  ] as const) {
    if (!(value ?? '').trim()) {
      return refuse(
        `A response needs its ${name}. What somebody said, without where it can be read, is a ` +
          'recollection rather than a record.',
      );
    }
  }
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) {
    return refuse('No opportunity with that id.');
  }
  if (input.testId) {
    const test = await getDemandTest(input.testId);
    if (!test || test.opportunityId !== opportunity.id) return refuse('No demand test with that id.');
  }
  const receivedAt = input.receivedAt ?? commerceNow();
  const written = await writeResponse({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    testId: input.testId ?? null,
    obligationId: input.obligationId ?? null,
    respondent: input.respondent.trim(),
    kind: input.kind as ResponseKind,
    channel: input.channel.trim(),
    reference: input.reference.trim(),
    excerpt: input.excerpt.trim(),
    receivedAt,
    performedBy: input.performedBy ?? 'PERSON',
    recordedBy: input.actorRef,
    requestKey: `response:${opportunity.id}:${input.respondent.trim()}:${input.kind}:${input.reference.trim()}`,
  });
  if (written.created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_RESPONSE_RECORDED',
      actorRef: input.actorRef,
      summary: `${input.respondent.trim()}: ${input.kind}.`,
      detail: { responseId: written.response.id, testId: input.testId ?? null },
    });
  }
  return {
    ok: true,
    value: written.response,
    message: written.created ? 'Recorded.' : 'This response was already recorded.',
  };
}

export interface TestTally {
  contacts: number;
  /** Distinct people who showed interest, asked something, or agreed. */
  interested: number;
  /** Distinct people who agreed to buy. The only count that is a sale signal. */
  agreed: number;
  declined: number;
}

export function tally(contacts: number, responses: CashResponse[]): TestTally {
  const who = (kinds: readonly ResponseKind[]) =>
    new Set(responses.filter((one) => kinds.includes(one.kind)).map((one) => one.respondent)).size;
  return {
    contacts,
    interested: who(INTERESTED_KINDS),
    agreed: who(['AGREED_TO_BUY']),
    declined: who(['DECLINED']),
  };
}

/**
 * The verdict the test's own thresholds give, or null while it is still open.
 *
 * Pure over the tally, the thresholds and the clock. Order matters and is
 * deliberate: an agreement settles the question whatever else happened.
 */
export function verdictFor(
  test: CashDemandTest,
  counts: TestTally,
  now: string,
): { verdict: DemandVerdict; reason: string } | null {
  const exhausted = counts.contacts >= test.maxContacts || now > test.windowEndsAt;
  if (counts.agreed >= test.continueIfAgreed) {
    return {
      verdict: 'CONTINUE',
      reason: `${counts.agreed} agreed to buy against a threshold of ${test.continueIfAgreed}.`,
    };
  }
  if (counts.contacts >= test.stopAfterContacts && counts.interested === 0) {
    return {
      verdict: 'STOP',
      reason: `${counts.contacts} were asked and nobody showed interest (the stop rule is ${test.stopAfterContacts}).`,
    };
  }
  if (exhausted && counts.interested >= test.changeIfInterested) {
    return {
      verdict: 'CHANGE',
      reason:
        `${counts.interested} showed interest and none agreed, so the offer or the price is the ` +
        'thing to change rather than the audience.',
    };
  }
  if (exhausted) {
    return {
      verdict: 'STOP',
      reason:
        `The test ended with ${counts.contacts} asked, ${counts.interested} interested and none ` +
        'agreeing — short of every threshold it declared.',
    };
  }
  return null;
}

export async function readTest(test: CashDemandTest): Promise<{
  test: CashDemandTest;
  counts: TestTally;
  responses: CashResponse[];
  pending: { verdict: DemandVerdict; reason: string } | null;
}> {
  const contacts = (await contactsFor(test.id)).length;
  const responses = await responsesFor({ projectId: test.projectId, testId: test.id });
  const counts = tally(contacts, responses);
  return { test, counts, responses, pending: verdictFor(test, counts, commerceNow()) };
}

/** Conclude every running test whose own thresholds now give a verdict. */
export async function concludeReadyTests(projectId: string, tests: CashDemandTest[]): Promise<number> {
  let concluded = 0;
  for (const test of tests) {
    if (test.state !== 'RUNNING') continue;
    const { pending } = await readTest(test);
    if (!pending) continue;
    const moved = await transitionDemandTest({
      id: test.id,
      from: ['RUNNING'],
      to: 'CONCLUDED',
      verdict: pending.verdict,
      verdictReason: pending.reason,
    });
    if (!moved) continue;
    concluded += 1;
    await recordCashEvent({
      projectId,
      opportunityId: test.opportunityId,
      kind: 'CASH_DEMAND_TEST_CONCLUDED',
      actorRef: 'brain:commerce',
      summary: `Demand test concluded ${pending.verdict}: ${pending.reason}`,
      detail: { testId: test.id, verdict: pending.verdict },
    });
  }
  return concluded;
}

export async function withdrawTest(input: {
  testId: string;
  projectId: string;
  reason: string;
  actorRef: string;
}): Promise<Outcome<CashDemandTest>> {
  const test = await getDemandTest(input.testId);
  if (!test || test.projectId !== input.projectId) return refuse('No demand test with that id.');
  const reason = required(input.reason, 'reason');
  if (typeof reason !== 'string') return reason;
  const moved = await transitionDemandTest({
    id: test.id,
    from: ['PREPARED', 'RUNNING'],
    to: 'WITHDRAWN',
    verdictReason: reason,
  });
  if (!moved) return refuse(`This test is ${test.state.toLowerCase()} and cannot be withdrawn.`);
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: test.opportunityId,
    kind: 'CASH_DEMAND_TEST_WITHDRAWN',
    actorRef: input.actorRef,
    summary: `Demand test withdrawn: ${reason}`,
    detail: { testId: test.id },
  });
  return { ok: true, value: (await getDemandTest(test.id))!, message: 'Withdrawn.' };
}
