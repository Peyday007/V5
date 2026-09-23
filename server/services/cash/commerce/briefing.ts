/**
 * "What are we doing to make money, what has actually happened, what is
 * blocked, and what should happen next?" — answered from rows.
 *
 * One derivation with three readers: the Cash page, the operator report, and
 * the Russell turn a person asks the question in. A reader that composed its
 * own answer would eventually disagree with the other two, so none of them
 * does. It writes nothing.
 *
 * Every money figure comes from the append-only ledger, and the five that are
 * easiest to confuse are reported apart: pipeline (agreed, unpaid), invoiced
 * and owed to us, paid by customers, settled into the account, and costs. A
 * sent offer is not in any of them; an agreement is pipeline only; a payment
 * promise is a note.
 *
 * The decisions are the few things only the owner's authority can unblock,
 * each prepared: the action, who receives it, the amount, the scope, and the
 * consequence of saying yes. Nothing Brain can research or do itself is on
 * that list.
 */
import { getCashMode, listCashEvents } from '../../../repos/cashMode.ts';
import { getMoneyEntry } from '../../../repos/cashLedger.ts';
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import {
  contactsFor,
  listDemandTests,
  listInvoices,
  listObligations,
  obligationEvents,
  responsesFor,
} from '../../../repos/cashCommerce.ts';
import { checkCommercialAuthority } from '../authority.ts';
import { cashPosition } from '../money.ts';
import { readTest } from './demand.ts';
import { selectOpening, trim } from './select.ts';
import {
  AGREED_OBLIGATION_STATES,
  LIVE_OBLIGATION_STATES,
  OPEN_INVOICE_STATES,
  type CashDemandTest,
  type CashInvoice,
  type CashObligation,
  type NextStepOwner,
} from '../../../domain/commerce.ts';

export interface BriefingItem {
  subject: string;
  opportunityId: string | null;
  text: string;
}

export interface NextAction {
  subject: string;
  opportunityId: string | null;
  action: string;
  owner: NextStepOwner;
  due: string | null;
  overdue: boolean;
}

export interface OwnerDecision {
  key: string;
  /** The commercial action the grant would have to cover. */
  authorityAction: string;
  action: string;
  recipient: string;
  amountCents: number;
  currency: string;
  scope: string;
  consequence: string;
  /** What is already prepared, so saying yes starts the work rather than a form. */
  prepared: string;
  /** Where the grant is given. */
  where: string;
}

export interface CommercialMoney {
  currency: string;
  /** Agreed by a buyer and not yet paid. Never cash, never added to cash. */
  pipelineCents: number;
  /** Invoiced and not yet paid by the customer. */
  invoicedUnpaidCents: number;
  /** Verified customer payments, net of refunds. */
  customerPaymentsCents: number;
  /** Paid by customers and not yet in the account. */
  paidNotSettledCents: number;
  /** Usable money in the account, from settlements and capital. */
  availableFundsCents: number;
  costsCents: number;
  /** Customer payments less refunds and every incremental cost. */
  contributionCents: number;
  unpaidCommitmentsCents: number;
}

export interface CommercialBriefing {
  projectId: string;
  readAt: string;
  sprint: { state: string; currency: string } | null;
  grant: { present: boolean; covers: Record<string, boolean>; summary: string };
  doing: BriefingItem[];
  happened: BriefingItem[];
  blocked: BriefingItem[];
  next: NextAction[];
  decisions: OwnerDecision[];
  money: CommercialMoney | null;
  /** Obligations and invoices that outlive a sprint winding down. */
  continuing: BriefingItem[];
  selection: {
    selectedId: string | null;
    because: string;
    decisiveGap: string | null;
    closestId: string | null;
    closestTitle: string | null;
  };
  /** What finished work taught, for the next choice. Counted, never scored. */
  learned: string[];
  text: string;
}

const GRANT_ACTIONS = ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT', 'ENGAGE_CONTRACTOR'] as const;

function money(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${currency} ${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function titleOf(opportunityId: string): Promise<string> {
  const one = await getOpportunity(opportunityId);
  return one ? trim(one.title, 70) : opportunityId;
}

export async function commercialBriefing(input: {
  projectId: string;
  now: string;
}): Promise<CommercialBriefing> {
  const { projectId, now } = input;
  const mode = await getCashMode(projectId);
  const covers: Record<string, boolean> = {};
  for (const action of GRANT_ACTIONS) {
    covers[action] = (await checkCommercialAuthority({ projectId, action, at: now })).ok;
  }
  const present = (await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', at: now })).authority !== null;
  const grant = {
    present,
    covers,
    summary: present
      ? `A standing commercial authority is in force; it covers ${
          GRANT_ACTIONS.filter((one) => covers[one]).join(', ') || 'none of the journey’s actions'
        }.`
      : 'No standing commercial authority exists, so nothing may contact a buyer, invoice, or accept a payment.',
  };

  const empty: CommercialBriefing = {
    projectId,
    readAt: now,
    sprint: null,
    grant,
    doing: [],
    happened: [],
    blocked: [],
    next: [],
    decisions: [],
    money: null,
    continuing: [],
    selection: { selectedId: null, because: '', decisiveGap: null, closestId: null, closestTitle: null },
    learned: [],
    text: '',
  };
  if (!mode) {
    empty.text = 'Cash Mode is not running on this project, so nothing here is trying to make money.';
    return empty;
  }

  const doing: BriefingItem[] = [];
  const happened: BriefingItem[] = [];
  const blocked: BriefingItem[] = [];
  const next: NextAction[] = [];
  const decisions: OwnerDecision[] = [];
  const continuing: BriefingItem[] = [];
  const learned: string[] = [];

  /* ---- demand tests ---- */
  const tests = await listDemandTests(projectId);
  for (const test of tests) {
    const read = await readTest(test);
    const subject = `Demand test on "${await titleOf(test.opportunityId)}"`;
    const counts = `${read.counts.contacts} of ${test.maxContacts} asked, ${read.counts.interested} interested, ${read.counts.agreed} agreed to buy`;
    if (test.state === 'PREPARED') {
      doing.push({ subject, opportunityId: test.opportunityId, text: `Prepared by ${test.preparedBy === 'BRAIN' ? 'Brain' : 'a person'}: ask up to ${test.maxContacts} of ${test.audience} via ${test.channel}. Nobody has been asked yet.` });
      if (!covers['CONTACT_BUYER']) {
        blocked.push({ subject, opportunityId: test.opportunityId, text: 'Waiting on your authority to contact buyers. Everything else about the test is ready.' });
        decisions.push({
          key: `contact:${test.id}`,
          authorityAction: 'CONTACT_BUYER',
          action: `Contact up to ${test.maxContacts} of "${test.audience}" via ${test.channel} with the prepared offer, and record every reply.`,
          recipient: `${test.audience} (via ${test.channel})`,
          amountCents: test.maxSpendCents,
          currency: test.currency,
          scope: test.offer,
          consequence:
            `A person sends the drafted message to at most ${test.maxContacts} recipients before ${test.windowEndsAt.slice(0, 10)}. ` +
            `No money moves (spend limit ${money(test.maxSpendCents, test.currency)}). The test continues at ${test.continueIfAgreed} agreement(s), changes at ${test.changeIfInterested} interested with none agreeing, and stops after ${test.stopAfterContacts} asked with nobody interested.`,
          prepared: `Demand test ${test.id}; draft message: "${trim(test.draftMessage, 200)}"`,
          where: `Cash → What Brain may do: grant CONTACT_BUYER (POST /api/projects/${projectId}/cash/authority)`,
        });
      } else {
        next.push({ subject, opportunityId: test.opportunityId, action: `Send the drafted message to the first of ${test.audience} via ${test.channel}, and record the reference.`, owner: 'PERSON', due: null, overdue: false });
      }
    } else if (test.state === 'RUNNING') {
      doing.push({ subject, opportunityId: test.opportunityId, text: `Running: ${counts}. Window closes ${test.windowEndsAt.slice(0, 10)}.` });
      if (read.counts.contacts < test.maxContacts && now <= test.windowEndsAt) {
        next.push({ subject, opportunityId: test.opportunityId, action: `Ask the next of ${test.audience} (${read.counts.contacts}/${test.maxContacts} asked) and record replies as they arrive.`, owner: 'PERSON', due: test.windowEndsAt, overdue: false });
      }
    } else if (test.state === 'CONCLUDED') {
      happened.push({ subject, opportunityId: test.opportunityId, text: `Concluded ${test.verdict}: ${test.verdictReason} (${counts}).` });
      learned.push(`"${await titleOf(test.opportunityId)}" via ${test.channel}: ${test.verdict} — ${counts}.`);
    }
    for (const response of read.responses) {
      happened.push({ subject, opportunityId: test.opportunityId, text: `${response.receivedAt.slice(0, 10)} ${response.respondent}: ${response.kind} — "${trim(response.excerpt, 120)}" (${response.reference})` });
    }
    if (test.state === 'RUNNING' || test.state === 'CONCLUDED') {
      const contacts = await contactsFor(test.id);
      if (contacts.length > 0) {
        happened.push({ subject, opportunityId: test.opportunityId, text: `Asked ${contacts.length}: ${contacts.map((one) => one.recipient).join(', ')}.` });
      }
    }
  }

  /* ---- obligations and invoices ---- */
  const obligations = await listObligations({ projectId });
  const invoices = await listInvoices({ projectId });
  let pipeline = 0;
  let invoicedUnpaid = 0;
  let paidNotSettled = 0;
  for (const obligation of obligations) {
    const own = invoices.filter((one) => one.obligationId === obligation.id);
    const paid = await paidCents(own);
    const subject = `${obligation.buyer} — ${trim(obligation.scope, 60)}`;
    const price = money(obligation.priceCents, obligation.currency);
    if (AGREED_OBLIGATION_STATES.includes(obligation.state) && obligation.state !== 'CLOSED') {
      pipeline += Math.max(0, obligation.priceCents - paid);
    }
    for (const invoice of own) {
      if (invoice.state === 'ISSUED' || invoice.state === 'PAYMENT_PENDING' || invoice.state === 'FAILED') {
        invoicedUnpaid += invoice.amountCents;
      }
      if (invoice.state === 'PAID') paidNotSettled += invoice.amountCents;
    }
    if (LIVE_OBLIGATION_STATES.includes(obligation.state)) {
      doing.push({ subject, opportunityId: obligation.opportunityId, text: `${describeState(obligation)} at ${price}.` });
      const overdue = obligation.nextStepDue !== null && obligation.nextStepDue < now;
      next.push({ subject, opportunityId: obligation.opportunityId, action: obligation.nextStep, owner: obligation.nextStepOwner, due: obligation.nextStepDue, overdue });
      if (overdue && obligation.nextStepOwner === 'BUYER') {
        blocked.push({ subject, opportunityId: obligation.opportunityId, text: `Waiting on the buyer since ${obligation.nextStepDue!.slice(0, 10)}: follow up.` });
      }
      if (AGREED_OBLIGATION_STATES.includes(obligation.state) || obligation.state === 'ACCEPTED') {
        continuing.push({ subject, opportunityId: obligation.opportunityId, text: `Owed to the buyer or by them: ${describeState(obligation)}. This continues if the sprint winds down.` });
      }
      addObligationDecisions({ obligation, invoices: own, covers, decisions, blocked, projectId, subject });
    } else {
      happened.push({ subject, opportunityId: obligation.opportunityId, text: `${describeState(obligation)}${obligation.closeReason ? ` — ${obligation.closeReason}` : ''}.` });
      if (obligation.state === 'CLOSED') {
        const events = await obligationEvents(obligation.id);
        const settled = await settledCents(own);
        learned.push(
          `${obligation.buyer}: agreed ${price}, ${obligation.revisionCount} revision(s), settled ${money(settled, obligation.currency)}` +
            ` over ${events.length} recorded steps via ${obligation.deliveryRoute}.`,
        );
      }
      if (obligation.state === 'LOST') learned.push(`${obligation.buyer} declined: ${obligation.closeReason ?? ''}`);
    }
    for (const invoice of own) {
      if (OPEN_INVOICE_STATES.includes(invoice.state) || invoice.state === 'FAILED') {
        continuing.push({ subject, opportunityId: obligation.opportunityId, text: `Invoice ${invoice.provider} ${invoice.providerReference}: ${invoice.state} for ${money(invoice.amountCents, invoice.currency)}${invoice.dueAt ? `, due ${invoice.dueAt.slice(0, 10)}` : ''}.` });
        if (invoice.dueAt && invoice.dueAt < now && invoice.state !== 'PAID') {
          blocked.push({ subject, opportunityId: obligation.opportunityId, text: `Invoice ${invoice.providerReference} is overdue since ${invoice.dueAt.slice(0, 10)}.` });
        }
      }
    }
  }
  const responses = await responsesFor({ projectId });
  const promised = responses.filter((one) => one.kind === 'PAYMENT_PROMISED');
  for (const one of promised) {
    happened.push({ subject: one.respondent, opportunityId: one.opportunityId, text: `Promised to pay (${one.receivedAt.slice(0, 10)}): a promise, not money.` });
  }

  /* ---- selection, when nothing is under way ---- */
  const selection = await selectOpening({ projectId, now });
  if (doing.length === 0) {
    if (selection.decisiveGap) {
      blocked.push({ subject: 'Choosing what to sell', opportunityId: selection.closest?.opportunityId ?? null, text: selection.decisiveGap });
      next.push({ subject: 'Choosing what to sell', opportunityId: selection.closest?.opportunityId ?? null, action: selection.closest?.missing[0]?.task ?? 'Continue discovery.', owner: 'BRAIN', due: null, overdue: false });
    }
  }

  /* ---- money, from the ledger ---- */
  const position = await cashPosition({ projectId, currency: mode.currency });
  const costs = await costsCents(projectId, mode.currency);
  const moneyReading: CommercialMoney = {
    currency: mode.currency,
    pipelineCents: pipeline,
    invoicedUnpaidCents: invoicedUnpaid,
    customerPaymentsCents: position.customerPaymentsCents,
    paidNotSettledCents: paidNotSettled,
    availableFundsCents: position.availableFundsCents,
    costsCents: costs,
    contributionCents: position.completedContributionCents,
    unpaidCommitmentsCents: position.unpaidCommitmentsCents,
  };

  for (const event of (await listCashEvents(projectId, 200)).filter((one) => COMMERCIAL_EVENTS.has(one.kind)).slice(0, 12)) {
    happened.push({ subject: event.kind.replace(/^CASH_/, '').toLowerCase().replace(/_/g, ' '), opportunityId: event.opportunityId, text: `${event.createdAt.slice(0, 16).replace('T', ' ')} — ${event.summary}` });
  }

  next.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due ?? '9') .localeCompare(b.due ?? '9'));

  const briefing: CommercialBriefing = {
    projectId,
    readAt: now,
    sprint: { state: mode.state, currency: mode.currency },
    grant,
    doing,
    happened,
    blocked,
    next,
    decisions,
    money: moneyReading,
    continuing,
    selection: {
      selectedId: selection.selected?.opportunityId ?? null,
      because: selection.because,
      decisiveGap: selection.decisiveGap,
      closestId: selection.closest?.opportunityId ?? null,
      closestTitle: selection.closest ? trim(selection.closest.title, 90) : null,
    },
    learned,
    text: '',
  };
  briefing.text = renderBriefing(briefing);
  return briefing;
}

const COMMERCIAL_EVENTS = new Set([
  'CASH_DEMAND_TEST_PREPARED',
  'CASH_DEMAND_TEST_CONCLUDED',
  'CASH_OFFER_PREPARED',
  'CASH_OBLIGATION_AGREED',
  'CASH_INVOICE_ISSUED',
  'CASH_INVOICE_PAID',
  'CASH_INVOICE_SETTLED',
  'CASH_OBLIGATION_CLOSED',
  'CASH_COLLECTED',
]);

function describeState(obligation: CashObligation): string {
  switch (obligation.state) {
    case 'OFFER_PREPARED':
      return 'Offer prepared, not sent';
    case 'OFFER_SENT':
      return `Offer sent ${obligation.sentAt?.slice(0, 10) ?? ''} — not a sale until they agree`;
    case 'AGREED':
      return `Agreed ${obligation.agreedAt?.slice(0, 10) ?? ''}, production not started`;
    case 'IN_PRODUCTION':
      return `In production (${obligation.deliveryRoute}: ${obligation.productionReference ?? '—'})`;
    case 'DELIVERED':
      return `Delivered ${obligation.deliveredAt?.slice(0, 10) ?? ''} — not accepted until the buyer says so`;
    case 'REVISION_REQUESTED':
      return `Revision ${obligation.revisionCount} requested by the buyer`;
    case 'ACCEPTED':
      return `Accepted by the buyer ${obligation.acceptedAt?.slice(0, 10) ?? ''}`;
    case 'CLOSED':
      return 'Closed: accepted and settled';
    case 'LOST':
      return 'Lost: the buyer declined';
    case 'CANCELLED':
      return 'Cancelled';
  }
}

function addObligationDecisions(input: {
  obligation: CashObligation;
  invoices: CashInvoice[];
  covers: Record<string, boolean>;
  decisions: OwnerDecision[];
  blocked: BriefingItem[];
  projectId: string;
  subject: string;
}): void {
  const { obligation, covers, decisions, blocked, subject } = input;
  const where = `Cash → What Brain may do (POST /api/projects/${input.projectId}/cash/authority)`;
  if (obligation.state === 'OFFER_PREPARED' && !covers['CONTACT_BUYER']) {
    blocked.push({ subject, opportunityId: obligation.opportunityId, text: 'The offer is prepared and waiting on your authority to contact the buyer.' });
    decisions.push({
      key: `offer:${obligation.id}`,
      authorityAction: 'CONTACT_BUYER',
      action: `Send the prepared offer to ${obligation.buyer}.`,
      recipient: obligation.buyer,
      amountCents: obligation.priceCents,
      currency: obligation.currency,
      scope: obligation.scope,
      consequence: `The buyer receives an offer at ${money(obligation.priceCents, obligation.currency)}. Nothing is committed until they agree; nothing is charged.`,
      prepared: `Obligation ${obligation.id}, acceptance: ${obligation.acceptanceConditions.join('; ')}`,
      where,
    });
  }
  const invoiced = input.invoices.filter((one) => one.state !== 'VOID' && one.state !== 'FAILED').reduce((sum, one) => sum + one.amountCents, 0);
  if (obligation.state === 'ACCEPTED' && invoiced < obligation.priceCents && !covers['QUOTE_AND_INVOICE']) {
    blocked.push({ subject, opportunityId: obligation.opportunityId, text: 'Accepted, and the invoice waits on your authority to issue it.' });
    decisions.push({
      key: `invoice:${obligation.id}`,
      authorityAction: 'QUOTE_AND_INVOICE',
      action: `Invoice ${obligation.buyer} for the accepted work.`,
      recipient: obligation.buyer,
      amountCents: obligation.priceCents - invoiced,
      currency: obligation.currency,
      scope: obligation.scope,
      consequence: 'The buyer is asked to pay the agreed amount through the payment provider. Nothing is collected until it settles.',
      prepared: `Obligation ${obligation.id} accepted ${obligation.acceptedAt ?? ''}`,
      where,
    });
  }
  if (input.invoices.some((one) => one.state === 'ISSUED' || one.state === 'PAYMENT_PENDING') && !covers['ACCEPT_PAYMENT']) {
    decisions.push({
      key: `accept:${obligation.id}`,
      authorityAction: 'ACCEPT_PAYMENT',
      action: `Accept ${obligation.buyer}'s payment when the provider reports it.`,
      recipient: obligation.buyer,
      amountCents: invoiced,
      currency: obligation.currency,
      scope: obligation.scope,
      consequence: 'A verified customer payment can be recorded against the agreed scope.',
      prepared: `Invoice(s) on obligation ${obligation.id}`,
      where,
    });
  }
  if (obligation.deliveryRoute === 'VENDOR' && obligation.state === 'AGREED' && !covers['ENGAGE_CONTRACTOR']) {
    decisions.push({
      key: `vendor:${obligation.id}`,
      authorityAction: 'ENGAGE_CONTRACTOR',
      action: 'Engage the named vendor to produce the agreed work.',
      recipient: obligation.requiredResources.join(', ') || 'the vendor named in the delivery plan',
      amountCents: 0,
      currency: obligation.currency,
      scope: obligation.deliveryPlan,
      consequence: 'Vendor capacity is committed against this obligation; any cost is a separate commitment inside your ceilings.',
      prepared: `Obligation ${obligation.id}`,
      where,
    });
  }
}

async function paidCents(invoices: CashInvoice[]): Promise<number> {
  let total = 0;
  for (const invoice of invoices) {
    if (!invoice.paymentEntryId || invoice.state === 'REFUNDED') continue;
    const entry = await getMoneyEntry(invoice.paymentEntryId);
    if (entry) total += entry.amountCents;
  }
  return total;
}

async function settledCents(invoices: CashInvoice[]): Promise<number> {
  let total = 0;
  for (const invoice of invoices) {
    if (!invoice.settlementEntryId) continue;
    const entry = await getMoneyEntry(invoice.settlementEntryId);
    if (entry) total += entry.amountCents;
  }
  return total;
}

async function costsCents(projectId: string, currency: string): Promise<number> {
  const { totalsByKind } = await import('../../../repos/cashLedger.ts');
  const totals = await totalsByKind({ projectId, currency });
  return Number(totals['COST'] ?? 0);
}

/** The plain-words answer, in the order the owner asked the question. */
export function renderBriefing(b: CommercialBriefing): string {
  const lines: string[] = [];
  lines.push(`COMMERCIAL STATE (read ${b.readAt}, from live records)`);
  if (!b.sprint) {
    lines.push('Cash Mode is not running here.');
    return lines.join('\n');
  }
  lines.push(`Sprint: ${b.sprint.state}. ${b.grant.summary}`);
  lines.push('');
  lines.push('WHAT WE ARE DOING TO MAKE MONEY');
  if (b.doing.length === 0) lines.push('- Nothing is being sold yet: no demand test and no offer is live.');
  for (const one of b.doing) lines.push(`- ${one.subject}: ${one.text}`);
  lines.push('');
  lines.push('WHAT HAS ACTUALLY HAPPENED');
  if (b.happened.length === 0) lines.push('- No buyer has been contacted, no reply recorded, nothing invoiced, nothing collected.');
  for (const one of b.happened.slice(0, 15)) lines.push(`- ${one.subject}: ${one.text}`);
  if (b.money) {
    const m = b.money;
    lines.push(
      `- Money: pipeline ${money(m.pipelineCents, m.currency)} (agreed, unpaid); invoiced unpaid ${money(m.invoicedUnpaidCents, m.currency)}; ` +
        `customer payments ${money(m.customerPaymentsCents, m.currency)} (of which not yet settled ${money(m.paidNotSettledCents, m.currency)}); ` +
        `available funds ${money(m.availableFundsCents, m.currency)}; costs ${money(m.costsCents, m.currency)}; contribution ${money(m.contributionCents, m.currency)}; ` +
        `unpaid commitments ${money(m.unpaidCommitmentsCents, m.currency)}.`,
    );
  }
  lines.push('');
  lines.push('WHAT IS BLOCKED');
  if (b.blocked.length === 0) lines.push('- Nothing.');
  for (const one of b.blocked) lines.push(`- ${one.subject}: ${one.text}`);
  lines.push('');
  lines.push('WHAT SHOULD HAPPEN NEXT');
  if (b.next.length === 0) lines.push('- Nothing is scheduled.');
  for (const one of b.next.slice(0, 8)) {
    lines.push(`- [${one.owner}${one.due ? `, due ${one.due.slice(0, 10)}` : ''}${one.overdue ? ', OVERDUE' : ''}] ${one.subject}: ${one.action}`);
  }
  lines.push('');
  lines.push('DECISIONS THAT NEED YOUR AUTHORITY');
  if (b.decisions.length === 0) lines.push('- None right now.');
  for (const one of b.decisions) {
    lines.push(
      `- ${one.action} Recipient: ${one.recipient}. Amount: ${money(one.amountCents, one.currency)}. Scope: ${trim(one.scope, 120)}. ` +
        `Consequence: ${one.consequence} Needs: ${one.authorityAction}. Where: ${one.where}.`,
    );
  }
  if (b.continuing.length > 0) {
    lines.push('');
    lines.push('OBLIGATIONS THAT CONTINUE IF THE SPRINT WINDS DOWN');
    for (const one of b.continuing) lines.push(`- ${one.subject}: ${one.text}`);
  }
  if (b.learned.length > 0) {
    lines.push('');
    lines.push('WHAT FINISHED WORK TAUGHT');
    for (const one of b.learned) lines.push(`- ${one}`);
  }
  return lines.join('\n');
}

export type { CashDemandTest };
