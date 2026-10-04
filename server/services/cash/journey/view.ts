/**
 * The journey as a person reads it: where each deal is, what its money did,
 * and what happens next — and who does it.
 *
 * Derived on the read path from `dealPosition` and the execution record, and
 * stored nowhere. Every "next" names its owner: `BRAIN` only when the
 * capability reads PRESENT and the standing grant covers the action — the same
 * two questions `perform.ts` asks before it sends — and `PERSON` otherwise,
 * with the reason, so the screen never promises Brain will do something the
 * send path would refuse.
 */
import { dealPosition, type DealPosition } from './position.ts';
import type { CashLesson } from './learning.ts';
import type { ExecutionRecord } from '../record.ts';
import type { CashOpportunity } from '../../../domain/types.ts';

export interface JourneyNext {
  step: string;
  owner: 'BRAIN' | 'PERSON' | 'BUYER';
  why: string;
}

export interface DealView extends Omit<DealPosition, 'observations'> {
  title: string;
  observations: DealPosition['observations'];
  next: JourneyNext[];
}

export interface JourneyView {
  deals: DealView[];
  totals: {
    agreedRevenueCents: number;
    invoicedCents: number;
    customerPaymentsCents: number;
    settledCashCents: number;
    unsettledCents: number;
    owedByBuyersCents: number;
    incrementalCostsCents: number;
    unpaidCommitmentsCents: number;
    contributionCents: number;
  };
  lessons: CashLesson[];
}

function performable(record: ExecutionRecord | undefined, action: string): { brain: boolean; why: string } {
  const one = record?.performable.find((p) => p.action === action);
  if (!one) return { brain: false, why: 'Brain cannot perform this from where the piece stands.' };
  return one.available
    ? { brain: true, why: `Brain does this itself: ${one.capability} is connected and the grant covers it.` }
    : { brain: false, why: one.reason ?? 'Brain cannot perform this itself.' };
}

export function nextFor(position: DealPosition, record: ExecutionRecord | undefined, state: string): JourneyNext[] {
  const out: JourneyNext[] = [];
  const p = position.pnl;
  if (state === 'COLLECTED' || state === 'DECLINED' || state === 'ARCHIVED') return out;
  if (!position.contacted) {
    const c = performable(record, 'CONTACT_BUYER');
    out.push({ step: 'Reach the buyer with the offer on the card.', owner: c.brain ? 'BRAIN' : 'PERSON', why: c.why });
    return out;
  }
  if (p.agreedRevenueCents <= 0) {
    const silent = position.observations.some((one) => one.kind === 'BUYER_SILENT');
    const accepted = position.observations.find((one) => one.kind === 'BUYER_ACCEPTED' || one.kind === 'BUYER_COUNTERED');
    if (accepted) {
      out.push({
        step: 'Record the agreement: the amount, what is delivered, what counts as acceptance, and the evidence.',
        owner: 'PERSON',
        why: 'An agreement binds the buyer; Brain records one only from evidence somebody can point at.',
      });
    } else {
      out.push({
        step: silent ? 'The buyer has not answered. Decide whether to follow up or let this go.' : 'Wait for the buyer to answer.',
        owner: silent ? 'PERSON' : 'BUYER',
        why: silent
          ? 'Silence is recorded; a second contact is a new action under the grant.'
          : 'Brain records silence by itself if nothing arrives inside the response window.',
      });
    }
    return out;
  }
  if (p.invoiceableCents > 0) {
    const i = performable(record, 'QUOTE_AND_INVOICE');
    out.push({ step: `Invoice the ${p.invoiceableCents} cents agreed and not yet billed.`, owner: i.brain ? 'BRAIN' : 'PERSON', why: i.why });
  }
  if (p.owedByBuyerCents > 0 && !position.paymentInFlight) {
    const t = performable(record, 'ACCEPT_PAYMENT');
    out.push({ step: `Collect the ${p.owedByBuyerCents} cents billed and unpaid.`, owner: t.brain ? 'BRAIN' : 'BUYER', why: t.brain ? t.why : 'The buyer pays the invoice; the payment is recorded with its reference.' });
  }
  if (position.paymentInFlight) {
    out.push({ step: 'A payment attempt is in flight or its outcome is unknown.', owner: 'PERSON', why: 'An unknown outcome is settled by checking the provider, never by sending again.' });
  }
  const live = position.fulfilments.filter((one) => one.state !== 'FAILED' && one.state !== 'CANCELLED');
  if (live.length === 0) {
    out.push({ step: 'Create the fulfilment: the work, in the machinery that does it.', owner: 'PERSON', why: 'Which path delivers this is a decision about who does the work.' });
  } else if (live.some((one) => one.state === 'CREATED')) {
    const brainWork = live.some((one) => one.state === 'CREATED' && (one.workKind === 'RUSSELL_CANDIDATE' || one.workKind === 'FACTORY_CHANGE_REQUEST'));
    out.push({
      step: 'The work is being performed.',
      owner: brainWork ? 'BRAIN' : 'PERSON',
      why: brainWork ? 'Brain reads the work as performed from its own rows when it finishes.' : 'Record what was performed, with evidence, once it is.',
    });
  } else if (live.some((one) => one.state === 'PERFORMED')) {
    out.push({ step: 'The buyer accepts the work against the acceptance condition.', owner: 'BUYER', why: 'Delivery is complete only on acceptance evidence.' });
  }
  if (p.unsettledCents > 0) {
    out.push({ step: `${p.unsettledCents} cents paid has not settled yet.`, owner: 'PERSON', why: 'A settlement is recorded with the bank or provider payout reference; until then it is not cash.' });
  }
  if (out.length === 0) {
    out.push({ step: 'Brain marks this collected on its next pass.', owner: 'BRAIN', why: 'Paid, settled and accepted.' });
  }
  return out;
}

export async function journeyView(input: {
  opportunities: CashOpportunity[];
  records: Record<string, ExecutionRecord>;
  currency: string;
  lessons: CashLesson[];
}): Promise<JourneyView> {
  const deals: DealView[] = [];
  for (const opportunity of input.opportunities) {
    if (!['READY', 'EXECUTING', 'DELIVERING', 'COLLECTED'].includes(opportunity.state)) continue;
    const position = await dealPosition({ opportunity, currency: input.currency });
    if (opportunity.state === 'READY' && !position.contacted) continue;
    deals.push({
      ...position,
      title: opportunity.title,
      next: nextFor(position, input.records[opportunity.id], opportunity.state),
    });
  }
  const sum = (key: keyof DealPosition['pnl']) =>
    deals.reduce((total, one) => total + Number(one.pnl[key] ?? 0), 0);
  return {
    deals,
    totals: {
      agreedRevenueCents: sum('agreedRevenueCents'),
      invoicedCents: sum('invoicedCents'),
      customerPaymentsCents: sum('customerPaymentsCents'),
      settledCashCents: sum('settledCashCents'),
      unsettledCents: sum('unsettledCents'),
      owedByBuyersCents: sum('owedByBuyerCents'),
      incrementalCostsCents: sum('incrementalCostsCents'),
      unpaidCommitmentsCents: sum('unpaidCommitmentsCents'),
      contributionCents: sum('contributionCents'),
    },
    lessons: input.lessons,
  };
}
