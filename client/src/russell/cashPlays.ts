/**
 * The plays a person can add to a sprint with one press.
 *
 * A play is an opening the owner names rather than one discovery found. It
 * enters the portfolio through the same `capture` every other opening uses, so
 * the card, the needs, the tier, the deep dive, the standing commercial grant
 * and every send gate apply to it exactly as they would to anything else.
 * Adding one spends nothing and contacts nobody.
 *
 * Each play is written so its next step and its stop rule never involve a
 * phone or video call: buyers are reached in writing, at the business
 * addresses they publish, and closed through a written page or a payment link.
 *
 * The mechanisms are typed against `CASH_MECHANISMS`, so a play naming a
 * mechanism the server does not record fails the typecheck rather than the
 * request.
 */
import type { CashMechanism } from '../../../server/domain/types.ts';

export interface CashPlay {
  /** A stable key for the control; never sent to the server. */
  key: string;
  title: string;
  mechanism: CashMechanism;
  industry: string;
  /** What this play is, in one sentence a person reads before adding it. */
  summary: string;
  nextAction: string;
  stopRule: string;
}

export const PLAY_SOURCE = 'Added by a person as a play';

export const CASH_PLAYS: readonly CashPlay[] = [
  {
    key: 'seasonal-leads',
    title: 'Furnace and snow-removal leads, sold to local contractors per lead',
    mechanism: 'PRODUCTIZED_SERVICE',
    industry: 'Home services',
    summary:
      'Generate furnace-repair and snow-removal requests in one area and sell each one to a local ' +
      'contractor at a fixed price per lead.',
    nextAction:
      'Find contractors in one target area who publish that they buy leads or run paid ads for ' +
      'furnace repair or snow removal, the price per lead they pay, and the business email ' +
      'address they publish. Reach them in writing only.',
    stopRule:
      'Stop if no contractor in the area publishes a business email address or a per-lead price ' +
      'after two rounds of looking.',
  },
  {
    key: 'reactivation-text-back',
    title: 'Past-customer reactivation plus missed-call text-back install',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    industry: 'Local service businesses',
    summary:
      'For a service business with past customers who stopped buying, run one written ' +
      'reactivation campaign and install an automatic text reply to calls it misses, for a fixed fee.',
    nextAction:
      'Find local service businesses that publish a business email address and show they lose ' +
      'callers or have lapsed customers, and what a fixed-fee reactivation and text-back setup ' +
      'sells for. Offer it in writing only; nothing in this play is done on a call.',
    stopRule:
      'Stop if the fixed fee published for this work does not cover the cost of delivering it, or ' +
      'no business in the area publishes an email address.',
  },
  {
    key: 'local-drop',
    title: 'The Local Drop mailer — this season’s issue, sold city by city',
    mechanism: 'PRODUCTIZED_SERVICE',
    industry: 'Local advertising',
    summary:
      'Sell advertising slots in The Local Drop direct-mail piece, one city at a time; the holiday ' +
      'edition is simply this season’s issue.',
    nextAction:
      'Pick one city, find what a slot in a comparable local mailer sells for and what printing and ' +
      'postage cost per piece there, and the local businesses that publish an email address. Sell ' +
      'slots in writing only.',
    stopRule:
      'Stop the city if the slots that can be sold would not cover printing and postage before the ' +
      'issue date.',
  },
  {
    key: 'v2-audit-funnel',
    title: 'AI workshop audit page that closes with a payment link',
    mechanism: 'DIAGNOSTIC_OPPORTUNITY',
    industry: 'Small business operations',
    summary:
      'Invite businesses by email to a free AI workshop audit page; the page shows them what to fix ' +
      'and closes with a payment link for the paid version. No calls at any step.',
    nextAction:
      'Find the kinds of business that publish an email address and pay for operations or AI ' +
      'consulting, and what a fixed-fee version of this work sells for. Send them the workshop ' +
      'link in writing; the page itself takes the payment.',
    stopRule:
      'Stop if the published price for this work cannot be found, or businesses that open the ' +
      'workshop do not reach the payment step.',
  },
];
