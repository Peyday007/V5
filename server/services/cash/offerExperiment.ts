/**
 * The first-transaction experiment: one offer Brain can fulfil itself, sold
 * through one payment link to a bounded list, with its kill and pass rules and
 * its exposure ceiling enforced here rather than remembered.
 *
 * The audit of 2026-11-23 (Parts 7–8) named it as the cheapest real-world test
 * of whether any low-ticket offer converts from compliant cold email: a $49–75
 * spreadsheet deliverable, a Stripe Payment Link, ~500 licensed contacts sent
 * through the owner's Instantly workspace with a CAN-SPAM footer, killed at
 * fewer than one paid sale per 500 sends or more than 0.3% complaints, passed
 * at one sale with an accepted delivery (then extended to 2,000), and capped
 * at about $150 of exposure. The owner's order the same day: build the
 * infrastructure, **do not authorize live transactions yet**.
 *
 * ---------------------------------------------------------------------------
 * How no live effect can happen without the grants
 * ---------------------------------------------------------------------------
 *
 * Nothing here is a second way to act. Each external effect goes through the
 * machinery every commercial effect already uses:
 *
 *   payment link   `checkCommercialAuthority(ACCEPT_PAYMENT)` → the effects
 *                  engine (`runExternalEffect`) with the Stripe payment-link
 *                  adapter (`providers/stripe.ts`), keyed by the offer so one
 *                  offer has one link whatever retries happen;
 *   each send      `checkCommercialAuthority(CONTACT_BUYER)` →
 *                  `sendCommercialEffect` → the registered messaging adapter
 *                  (Instantly), keyed by the lead so one lead is mailed once;
 *   each payment   read from Stripe and written by `recordMoneyEvent`, backed by
 *                  the link's own SUCCEEDED operation, keyed by the provider's
 *                  payment reference.
 *
 * Every perform function takes `live`, and it is `false` unless a caller says
 * otherwise. A dry run — or a live request missing its grant, its connected
 * provider, a valid definition, a CAN-SPAM-compliant message or room under the
 * rules — sends nothing: it records a PROPOSED decision on the authority ledger
 * naming exactly what would have been sent, and returns that request and every
 * reason it was not performed. `previewExperiment` is the same reading for the
 * whole experiment, effect by effect, and writes nothing at all.
 *
 * ---------------------------------------------------------------------------
 * What is a precondition, not a preference
 * ---------------------------------------------------------------------------
 *
 * CAN-SPAM (15 U.S.C. 7704): a message names its sender, carries a valid
 * physical postal address and a working way to opt out, and has a subject
 * line that does not mislead. `canSpamProblems` refuses a message lacking any
 * of them, before the grant is even asked. An unknown is never favourable
 * (invariant 39): an unmeasured complaint rate holds the experiment rather
 * than letting it send on, and a lead source with no licence on record is not
 * a list Brain may mail.
 */
import { createHash } from 'node:crypto';
import { BRAIN_PRINCIPAL, actionContext, checkCommercialAuthority, recordEffectReceipt, type CommercialAction } from './authority.ts';
import {
  CONTACT_BUYER_NAMESPACE,
  PAYMENT_LINK_NAMESPACE,
  adapterStatus,
  commercialOperationsFor,
  receiptOf,
  sendCommercialEffect,
  usableAdapter,
} from './effects.ts';
import { DELIVERABLE_CAPABILITIES } from './capabilities.ts';
import { recordMoneyEvent } from './opportunities.ts';
import { paymentLinkRequests, readStripePaymentLinkPayments, type LinkPayment, type PaymentLinkRequest } from './providers/stripe.ts';
import { ADDRESS } from './providers/config.ts';
import { PUBLISHER, PUBLISHER_ADDRESS } from './neighborCard.ts';
import { findExternalOperation, runExternalEffect } from '../effects/external.ts';
import { listMoneyEntries, moneyEntryByKey } from '../../repos/cashLedger.ts';
import { listAttempts } from '../../repos/idempotency.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import type { IdempotencyOperation } from '../../domain/types.ts';

/* ------------------------------------------------------------------ */
/* The definition                                                       */
/* ------------------------------------------------------------------ */

export interface ExperimentOffer {
  /** What the buyer is offered, in one line. Null until a niche is chosen. */
  title: string | null;
  /** What it is and who it is for, in the words the buyer reads. */
  description: string | null;
  /** The deliverable capability that produces it (`capabilities.ts`). */
  deliverableCapability: string;
  priceCents: number;
  currency: string;
  /** What the buyer accepts as delivered. */
  acceptanceCondition: string | null;
}

/** Where the contacts come from, and the terms under which they may be mailed. */
export interface LeadSource {
  name: string;
  /** The licence or terms of use permitting commercial email to these contacts. */
  licence: string;
  contacts: number;
}

/** Who the messages are from: CAN-SPAM's sender identification and postal address. */
export interface SenderIdentity {
  name: string;
  business: string;
  /** A valid physical postal address (a street address or a registered PO box). */
  postalAddress: string;
  /** The plain way to opt out, as the message states it. */
  optOutLine: string;
}

export interface ExperimentCost {
  label: string;
  cents: number;
}

export interface ExperimentRules {
  /** Killed when fewer than `paid` sales per `perSends` sends have been taken. */
  killBelow: { paid: number; perSends: number };
  /** Killed when complaints exceed this share of sends (0.003 = 0.3%). */
  killComplaintRate: number;
  /** Passed at this many paid sales … */
  passMinPaid: number;
  /** … with this many deliveries the buyer accepted. */
  passMinAccepted: number;
  /** The send cap once passed. */
  extendTo: number;
}

export interface OfferExperiment {
  /** Lowercase letters, digits and hyphens: it names the link and every send. */
  id: string;
  /** The opportunity the experiment's sends and payments are recorded against. Required to send. */
  opportunityId: string | null;
  offer: ExperimentOffer;
  leadSource: LeadSource | null;
  sender: SenderIdentity | null;
  /** The first phase's send cap. */
  plannedSends: number;
  /** The most the experiment may commit, in cents, across every cost. */
  exposureCeilingCents: number;
  /** The costs the experiment commits before any sale (domain, inboxes, tooling, leads). */
  costs: ExperimentCost[];
  rules: ExperimentRules;
}

export const EXPERIMENT_ID = /^[a-z0-9][a-z0-9-]{2,47}$/;

/**
 * The audit's experiment, as far as the record can state it. The niche, the
 * offer's words and the lead source are not chosen yet, so they are null and
 * the definition reads invalid until they are (invariant 39): a preview names
 * them as what is missing rather than inventing them. The sender is the
 * owner-supplied publisher identity Brain's own buyer outreach already uses
 * (`sales/businesses.ts`).
 */
export function firstTransactionExperiment(): OfferExperiment {
  return {
    id: 'first-transaction-1',
    opportunityId: null,
    offer: {
      title: null,
      description: null,
      deliverableCapability: 'PRODUCE_SPREADSHEET',
      priceCents: 4_900,
      currency: 'USD',
      acceptanceCondition: null,
    },
    leadSource: null,
    sender: {
      name: PUBLISHER,
      business: PUBLISHER,
      postalAddress: PUBLISHER_ADDRESS,
      optOutLine: 'If you would rather not hear from us, reply "no thanks" and we will not write again.',
    },
    plannedSends: 500,
    exposureCeilingCents: 15_000,
    costs: [
      { label: 'sending domain', cents: 1_200 },
      { label: 'two to three sending inboxes', cents: 2_500 },
      { label: 'Instantly plan', cents: 4_700 },
      { label: 'licensed lead list', cents: 4_700 },
    ],
    rules: {
      killBelow: { paid: 1, perSends: 500 },
      killComplaintRate: 0.003,
      passMinPaid: 1,
      passMinAccepted: 1,
      extendTo: 2_000,
    },
  };
}

export interface DefinitionProblem {
  field: string;
  problem: string;
}

const blank = (value: string | null | undefined): boolean => !value || value.trim() === '';

/**
 * Whether a postal address is one a message could carry: a number and a word,
 * at least a street line's length. Not proof it is deliverable — that is the
 * owner's statement — but an empty or placeholder value can never pass.
 */
export function looksLikePostalAddress(value: string | null | undefined): boolean {
  if (blank(value)) return false;
  const text = value!.trim();
  return text.length >= 10 && /\d/.test(text) && /[A-Za-z]{2,}/.test(text) && !/[<>{}]/.test(text);
}

function senderProblems(sender: SenderIdentity | null): DefinitionProblem[] {
  if (!sender) return [{ field: 'sender', problem: 'no sender identity is recorded; CAN-SPAM requires the sender to be named' }];
  const out: DefinitionProblem[] = [];
  if (blank(sender.name)) out.push({ field: 'sender.name', problem: 'the sender is not named' });
  if (blank(sender.business)) out.push({ field: 'sender.business', problem: 'the sending business is not named' });
  if (!looksLikePostalAddress(sender.postalAddress)) {
    out.push({ field: 'sender.postalAddress', problem: 'no valid physical postal address is recorded; CAN-SPAM requires one in every message' });
  }
  if (blank(sender.optOutLine)) out.push({ field: 'sender.optOutLine', problem: 'no way to opt out is stated; CAN-SPAM requires one in every message' });
  return out;
}

/** Everything that keeps this definition from being run. Empty means valid. Pure. */
export function experimentProblems(def: OfferExperiment): DefinitionProblem[] {
  const out: DefinitionProblem[] = [];
  if (!EXPERIMENT_ID.test(def.id)) out.push({ field: 'id', problem: 'the id is 3–48 lowercase letters, digits and hyphens' });
  const o = def.offer;
  if (blank(o.title)) out.push({ field: 'offer.title', problem: 'no offer is written yet: choose the niche and name the deliverable' });
  if (blank(o.description)) out.push({ field: 'offer.description', problem: 'the offer does not say what the buyer gets' });
  if (blank(o.acceptanceCondition)) out.push({ field: 'offer.acceptanceCondition', problem: 'the offer does not say what counts as delivered' });
  if (!DELIVERABLE_CAPABILITIES.some((one) => one.id === o.deliverableCapability)) {
    out.push({ field: 'offer.deliverableCapability', problem: `${o.deliverableCapability} is not a deliverable Brain produces itself` });
  }
  if (!Number.isInteger(o.priceCents) || o.priceCents <= 0) out.push({ field: 'offer.priceCents', problem: 'the price is a positive whole number of cents' });
  if (!/^[A-Z]{3}$/.test(o.currency)) out.push({ field: 'offer.currency', problem: 'the currency is a three-letter code' });
  if (!def.leadSource) {
    out.push({ field: 'leadSource', problem: 'no lead source is recorded: name the licensed list, its contact count and its licence terms' });
  } else {
    if (blank(def.leadSource.name)) out.push({ field: 'leadSource.name', problem: 'the lead source is not named' });
    if (blank(def.leadSource.licence)) out.push({ field: 'leadSource.licence', problem: 'no licence permitting commercial email to these contacts is recorded' });
    if (!Number.isInteger(def.leadSource.contacts) || def.leadSource.contacts < def.plannedSends) {
      out.push({ field: 'leadSource.contacts', problem: `the list holds fewer contacts than the ${def.plannedSends} sends planned` });
    }
  }
  out.push(...senderProblems(def.sender));
  if (!Number.isInteger(def.plannedSends) || def.plannedSends <= 0) out.push({ field: 'plannedSends', problem: 'the send cap is a positive whole number' });
  if (!Number.isInteger(def.exposureCeilingCents) || def.exposureCeilingCents <= 0) {
    out.push({ field: 'exposureCeilingCents', problem: 'the exposure ceiling is a positive whole number of cents' });
  }
  for (const cost of def.costs) {
    if (!Number.isInteger(cost.cents) || cost.cents < 0) out.push({ field: `costs.${cost.label}`, problem: 'a cost is a whole, non-negative number of cents' });
  }
  const planned = plannedCostCents(def);
  if (planned > def.exposureCeilingCents) {
    out.push({ field: 'costs', problem: `the planned costs (${planned} cents) exceed the exposure ceiling (${def.exposureCeilingCents} cents)` });
  }
  const r = def.rules;
  if (!(r.killComplaintRate > 0 && r.killComplaintRate < 1)) out.push({ field: 'rules.killComplaintRate', problem: 'the complaint kill rate is a share between 0 and 1' });
  if (!(Number.isInteger(r.killBelow.perSends) && r.killBelow.perSends > 0 && r.killBelow.paid > 0)) {
    out.push({ field: 'rules.killBelow', problem: 'the paid-sale kill rule needs a positive count per a positive number of sends' });
  }
  if (!(r.passMinPaid >= 1 && r.passMinAccepted >= 1)) out.push({ field: 'rules.pass', problem: 'passing needs at least one paid sale and one accepted delivery' });
  if (!(Number.isInteger(r.extendTo) && r.extendTo > def.plannedSends)) out.push({ field: 'rules.extendTo', problem: 'the extension is larger than the first phase' });
  return out;
}

export function plannedCostCents(def: OfferExperiment): number {
  return def.costs.reduce((sum, one) => sum + Math.max(0, one.cents), 0);
}

/* ------------------------------------------------------------------ */
/* CAN-SPAM and the message                                             */
/* ------------------------------------------------------------------ */

export interface ExperimentLead {
  email: string;
  name?: string | null;
  company?: string | null;
}

export interface ComposedMessage {
  to: string;
  subject: string;
  text: string;
}

const MISLEADING_SUBJECT = /^\s*(re|fwd?|fw)\s*:/i;

/**
 * Why a message may not be sent under CAN-SPAM, or nothing. A hard
 * precondition on every outreach effect this module performs. Pure.
 */
export function canSpamProblems(message: ComposedMessage, sender: SenderIdentity | null): string[] {
  const out: string[] = [];
  if (!sender) return ['no sender identity is recorded'];
  if (blank(message.subject)) out.push('the subject line is empty');
  else if (MISLEADING_SUBJECT.test(message.subject)) out.push('the subject line presents a first message as a reply or a forward');
  if (!looksLikePostalAddress(sender.postalAddress) || !message.text.includes(sender.postalAddress.trim())) {
    out.push('the message does not carry a valid physical postal address');
  }
  if (blank(sender.optOutLine) || !message.text.includes(sender.optOutLine.trim())) out.push('the message does not state how to opt out');
  if (blank(sender.name) || !message.text.includes(sender.name.trim())) out.push('the message does not name its sender');
  if (!ADDRESS.test(message.to)) out.push('the recipient is not one email address');
  return out;
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/** What the preview shows in place of a link that does not exist yet. */
export const LINK_NOT_CREATED = '[the payment link, once it is created]';

/**
 * The one message every lead is sent: the offer in a fixed template, the
 * payment link, the opt-out and the sender's identity and postal address. No
 * model writes it. Pure.
 */
export function composeExperimentMessage(
  def: OfferExperiment,
  lead: ExperimentLead,
  paymentLinkUrl: string | null,
): { ok: true; message: ComposedMessage } | { ok: false; problems: string[] } {
  const problems = experimentProblems(def).filter((one) => one.field.startsWith('offer') || one.field.startsWith('sender')).map((one) => one.problem);
  if (problems.length > 0 || !def.sender) return { ok: false, problems };
  const to = lead.email.trim().toLowerCase();
  const o = def.offer;
  const sender = def.sender;
  const text = [
    lead.name && lead.name.trim() ? `Hello ${lead.name.trim()},` : 'Hello,',
    '',
    o.description!.trim(),
    '',
    `Price: ${money(o.priceCents, o.currency)}, paid once.`,
    `It is done when: ${o.acceptanceCondition!.trim()}`,
    `To buy it: ${paymentLinkUrl ?? LINK_NOT_CREATED}`,
    '',
    sender.optOutLine.trim(),
    '',
    `${sender.name.trim()}, ${sender.business.trim()}`,
    sender.postalAddress.trim(),
  ].join('\n');
  const message = { to, subject: o.title!.trim().slice(0, 200), text };
  const compliance = canSpamProblems(message, sender);
  return compliance.length > 0 ? { ok: false, problems: compliance } : { ok: true, message };
}

/* ------------------------------------------------------------------ */
/* The rules                                                            */
/* ------------------------------------------------------------------ */

export interface ExperimentObservation {
  /** Sends that may have reached a recipient: performed, or of unknown outcome. */
  sends: number;
  /** Spam complaints reported for those sends. Null when not measured. */
  complaints: number | null;
  paidSales: number;
  acceptedDeliveries: number;
  /** Money committed so far against the experiment, in cents. */
  committedCostCents: number;
}

export type ExperimentVerdict = 'RUNNING' | 'HELD' | 'KILLED' | 'PASSED';

export interface ExperimentJudgment {
  verdict: ExperimentVerdict;
  reasons: string[];
  /** The send cap in force: the first phase's, or the extension's once passed. */
  sendCap: number;
  /** How many more sends the rules allow now. Zero unless RUNNING. */
  sendsRemaining: number;
}

/**
 * Where the experiment stands under its own rules. Kill outranks everything;
 * an unmeasured complaint rate holds it; passing extends the cap. Pure.
 */
export function judgeExperiment(def: OfferExperiment, obs: ExperimentObservation): ExperimentJudgment {
  const r = def.rules;
  const passed = obs.paidSales >= r.passMinPaid && obs.acceptedDeliveries >= r.passMinAccepted;
  const sendCap = passed ? r.extendTo : def.plannedSends;
  const stop = (verdict: ExperimentVerdict, reasons: string[]): ExperimentJudgment => ({ verdict, reasons, sendCap, sendsRemaining: 0 });

  const kills: string[] = [];
  if (obs.committedCostCents > def.exposureCeilingCents) {
    kills.push(`committed costs (${obs.committedCostCents} cents) exceed the exposure ceiling (${def.exposureCeilingCents} cents)`);
  }
  if (obs.complaints !== null && obs.sends > 0 && obs.complaints / obs.sends > r.killComplaintRate) {
    kills.push(`${obs.complaints} complaints in ${obs.sends} sends is above the ${(r.killComplaintRate * 100).toFixed(1)}% kill rate`);
  }
  const required = Math.floor(obs.sends / r.killBelow.perSends) * r.killBelow.paid;
  if (obs.paidSales < required) {
    kills.push(`${obs.paidSales} paid sales in ${obs.sends} sends is below ${r.killBelow.paid} per ${r.killBelow.perSends}`);
  }
  if (kills.length > 0) return stop('KILLED', kills);

  if (obs.sends > 0 && obs.complaints === null) {
    return stop('HELD', ['the complaint rate of the sends so far is not measured, and an unknown is never read as below the kill rate']);
  }
  if (obs.sends >= sendCap) {
    return passed
      ? stop('PASSED', [`${obs.paidSales} paid and ${obs.acceptedDeliveries} accepted, and the ${sendCap}-send extension is used`])
      : stop('HELD', [`the ${sendCap} sends are used, ${obs.paidSales} paid and ${obs.acceptedDeliveries} delivery accepted: passing needs ${r.passMinAccepted} accepted`]);
  }
  return {
    verdict: 'RUNNING',
    reasons: passed ? [`passed (${obs.paidSales} paid, ${obs.acceptedDeliveries} accepted): extended to ${r.extendTo} sends`] : [],
    sendCap,
    sendsRemaining: sendCap - obs.sends,
  };
}

/** Whether one more cost fits under the exposure ceiling. Pure. */
export function admitCost(def: OfferExperiment, obs: Pick<ExperimentObservation, 'committedCostCents'>, cents: number): { ok: boolean; reason: string } {
  const after = obs.committedCostCents + Math.max(0, cents);
  return after <= def.exposureCeilingCents
    ? { ok: true, reason: `${after} of ${def.exposureCeilingCents} cents committed` }
    : { ok: false, reason: `committing ${cents} cents would take the experiment to ${after} cents, past its ${def.exposureCeilingCents}-cent ceiling` };
}

/* ------------------------------------------------------------------ */
/* Identities the engine keys on                                        */
/* ------------------------------------------------------------------ */

const PAYMENT_LINK_PRINCIPAL = 'cash-payment-link';

export function paymentLinkKey(experimentId: string): string {
  return `payment-link.${experimentId}`;
}

export function paymentLinkBusinessId(experimentId: string): string {
  return `paylink-${experimentId}`;
}

/** One lead is one occurrence: the same lead is never mailed twice by a retry. */
export function leadOccurrence(experimentId: string, email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
  return `exp-${experimentId}-${digest}`;
}

export function paymentLinkPayload(def: OfferExperiment): Record<string, unknown> {
  return {
    amountCents: def.offer.priceCents,
    currency: def.offer.currency,
    productName: def.offer.title ?? '',
    confirmationMessage: `Thank you. ${def.offer.acceptanceCondition ?? ''}`.trim(),
  };
}

/** The link this experiment created, when the engine holds one. */
export async function paymentLinkOperation(projectId: string, experimentId: string): Promise<IdempotencyOperation | null> {
  return await findExternalOperation({
    namespace: PAYMENT_LINK_NAMESPACE,
    projectId,
    principalType: 'SYSTEM',
    principalId: PAYMENT_LINK_PRINCIPAL,
    key: paymentLinkKey(experimentId),
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 32)}`;
}

/* ------------------------------------------------------------------ */
/* Observation                                                          */
/* ------------------------------------------------------------------ */

export const EXPERIMENT_PAYMENT_KEY_PREFIX = 'experiment-payment:';

/**
 * What the rows say so far: sends from the engine's own operations (anything
 * not FAILED may have reached somebody, invariant 26), paid sales from the
 * ledger. Complaints and accepted deliveries are the caller's measured
 * readings, and unmeasured complaints stay null.
 */
export async function observeExperiment(input: {
  projectId: string;
  experiment: OfferExperiment;
  complaints: number | null;
  acceptedDeliveries: number;
  committedCostCents: number;
}): Promise<ExperimentObservation> {
  const def = input.experiment;
  const prefix = `exp-${def.id}-`;
  const sends = def.opportunityId
    ? (await commercialOperationsFor(input.projectId, def.opportunityId)).filter(
        (one) => one.action === 'CONTACT_BUYER' && one.occurrence.startsWith(prefix) && one.operation.state !== 'FAILED',
      ).length
    : 0;
  const keyPrefix = `${EXPERIMENT_PAYMENT_KEY_PREFIX}${def.id}:`;
  const paidSales = (await listMoneyEntries({ projectId: input.projectId, limit: 2000 })).filter(
    (one) => one.kind === 'CUSTOMER_PAYMENT' && (one.idempotencyKey ?? '').startsWith(keyPrefix),
  ).length;
  return { sends, complaints: input.complaints, paidSales, acceptedDeliveries: input.acceptedDeliveries, committedCostCents: input.committedCostCents };
}

/* ------------------------------------------------------------------ */
/* The preview: every effect, its grant, its provider and its cost       */
/* ------------------------------------------------------------------ */

export type PreviewDisposition = 'WOULD_PERFORM' | 'BLOCKED';

export interface PreviewEffect {
  order: number;
  step: 'COMMIT_COST' | 'CREATE_PAYMENT_LINK' | 'SEND_OFFER' | 'OBSERVE_PAYMENTS' | 'PRODUCE_DELIVERABLE' | 'DELIVER' | 'RECORD_LEDGER';
  does: string;
  /** Who performs it. */
  performer: 'BRAIN' | 'OWNER';
  /** The commercial grant it is performed under, when it is an external effect Brain performs. */
  grant: { action: CommercialAction; ok: boolean; reason: string } | null;
  /** The provider adapter that would perform it, when one is needed. */
  provider: { name: string | null; usable: boolean; reason: string } | null;
  costCents: number;
  /** How many times it would be performed. */
  count: number;
  /** Exactly what would be sent, when it is a request. Never a credential. */
  request: unknown;
  disposition: PreviewDisposition;
  blockedBy: string[];
}

export interface ExperimentPreview {
  experimentId: string;
  /** Always false: a preview performs nothing. */
  live: false;
  problems: DefinitionProblem[];
  exposure: { plannedCents: number; ceilingCents: number; ok: boolean };
  judgment: ExperimentJudgment;
  effects: PreviewEffect[];
  /** True only when every effect would perform. */
  ready: boolean;
}

const SAMPLE_LEAD: ExperimentLead = { email: 'recipient@example.invalid', name: null };

async function grantReading(projectId: string, action: CommercialAction, amountCents: number | null): Promise<{ action: CommercialAction; ok: boolean; reason: string }> {
  const decision = await checkCommercialAuthority(
    { projectId, action, ...actionContext({ principal: BRAIN_PRINCIPAL, amountCents }) },
    { record: false },
  );
  return { action, ok: decision.ok, reason: decision.reason };
}

function providerReading(namespace: typeof PAYMENT_LINK_NAMESPACE): { name: string | null; usable: boolean; reason: string } {
  const status = adapterStatus(namespace);
  return { name: status.adapter, usable: status.usable, reason: status.reason };
}

/**
 * Everything the experiment would do, in order, with the grant each external
 * effect needs and whether it holds, the provider and whether it is
 * connected, its cost and the exact request. Writes nothing and sends nothing.
 */
export async function previewExperiment(input: {
  projectId: string;
  experiment: OfferExperiment;
  observation?: ExperimentObservation;
}): Promise<ExperimentPreview> {
  const def = input.experiment;
  const problems = experimentProblems(def);
  const obs: ExperimentObservation = input.observation ?? { sends: 0, complaints: 0, paidSales: 0, acceptedDeliveries: 0, committedCostCents: 0 };
  const judgment = judgeExperiment(def, obs);
  const planned = plannedCostCents(def);
  const effects: PreviewEffect[] = [];
  const invalid = problems.map((one) => `${one.field}: ${one.problem}`);
  let order = 0;
  const effect = (e: Omit<PreviewEffect, 'order' | 'disposition'>): void => {
    effects.push({ ...e, order: ++order, disposition: e.blockedBy.length === 0 ? 'WOULD_PERFORM' : 'BLOCKED' });
  };

  // 1. The costs: committed by the owner before any sale, each judged against the ceiling.
  let running = obs.committedCostCents;
  for (const cost of def.costs) {
    const admitted = admitCost(def, { committedCostCents: running }, cost.cents);
    running += cost.cents;
    effect({
      step: 'COMMIT_COST',
      does: `buy ${cost.label}`,
      performer: 'OWNER',
      grant: null,
      provider: null,
      costCents: cost.cents,
      count: 1,
      request: null,
      blockedBy: admitted.ok ? [] : [admitted.reason],
    });
  }

  // 2. The payment link, under ACCEPT_PAYMENT, through the Stripe payment-link adapter.
  const linkGrant = await grantReading(input.projectId, 'ACCEPT_PAYMENT', null);
  const linkProvider = providerReading(PAYMENT_LINK_NAMESPACE);
  let linkRequest: PaymentLinkRequest[] | null = null;
  try {
    linkRequest = paymentLinkRequests(paymentLinkPayload(def), paymentLinkBusinessId(def.id));
  } catch {
    linkRequest = null;
  }
  const existingLink = await paymentLinkOperation(input.projectId, def.id);
  effect({
    step: 'CREATE_PAYMENT_LINK',
    does: `create one Stripe Payment Link for ${def.offer.title ?? 'the offer'} at ${money(def.offer.priceCents, def.offer.currency)}`,
    performer: 'BRAIN',
    grant: linkGrant,
    provider: linkProvider,
    costCents: 0,
    count: existingLink?.state === 'SUCCEEDED' ? 0 : 1,
    request: linkRequest,
    blockedBy: [
      ...invalid,
      ...(linkGrant.ok ? [] : [`ACCEPT_PAYMENT is not granted: ${linkGrant.reason}`]),
      ...(linkProvider.usable ? [] : [`no connected billing provider: ${linkProvider.reason}`]),
      ...(linkRequest ? [] : ['the payment link request cannot be built from this offer']),
    ],
  });

  // 3. The sends, under CONTACT_BUYER, through the messaging adapter, each CAN-SPAM-checked.
  const sendGrant = await grantReading(input.projectId, 'CONTACT_BUYER', null);
  const sendProvider = providerReading(CONTACT_BUYER_NAMESPACE);
  const linkUrl = existingLink ? await linkUrlOf(existingLink) : null;
  const sample = composeExperimentMessage(def, SAMPLE_LEAD, linkUrl);
  effect({
    step: 'SEND_OFFER',
    does: `send the offer to up to ${judgment.sendsRemaining} licensed contacts through the owner's Instantly workspace`,
    performer: 'BRAIN',
    grant: sendGrant,
    provider: sendProvider,
    costCents: 0,
    count: judgment.sendsRemaining,
    request: sample.ok ? { sample: sample.message } : null,
    blockedBy: [
      ...invalid,
      ...(sample.ok ? [] : sample.problems.map((one) => `CAN-SPAM: ${one}`)),
      ...(sendGrant.ok ? [] : [`CONTACT_BUYER is not granted: ${sendGrant.reason}`]),
      ...(sendProvider.usable ? [] : [`no connected messaging provider: ${sendProvider.reason}`]),
      ...(def.opportunityId ? [] : ['no opportunity is named to record the sends and payments against']),
      ...(judgment.verdict === 'RUNNING' ? [] : [`the experiment is ${judgment.verdict}: ${judgment.reasons.join('; ')}`]),
    ],
  });

  // 4. Payments, read from the provider and written to the ledger once each.
  const mode = await getCashMode(input.projectId);
  effect({
    step: 'OBSERVE_PAYMENTS',
    does: "read the link's paid checkouts from Stripe and record each as one CUSTOMER_PAYMENT",
    performer: 'BRAIN',
    grant: null,
    provider: linkProvider,
    costCents: 0,
    count: 0,
    request: null,
    blockedBy: [
      ...(linkProvider.usable ? [] : [`no connected billing provider: ${linkProvider.reason}`]),
      ...(mode ? (mode.currency === def.offer.currency ? [] : [`Cash Mode keeps ${mode.currency}, and the offer is priced in ${def.offer.currency}`]) : ['Cash Mode is not active, so no money entry can be written']),
    ],
  });

  // 5–6. Producing the deliverable (Brain's own renderer) and delivering it.
  effect({
    step: 'PRODUCE_DELIVERABLE',
    does: `produce and verify the deliverable for each paid buyer (${def.offer.deliverableCapability})`,
    performer: 'BRAIN',
    grant: null,
    provider: null,
    costCents: 0,
    count: 0,
    request: null,
    blockedBy: DELIVERABLE_CAPABILITIES.some((one) => one.id === def.offer.deliverableCapability) ? [] : [`${def.offer.deliverableCapability} is not a renderer Brain has`],
  });
  effect({
    step: 'DELIVER',
    does: "send each paid buyer their file, at the email Stripe recorded for the payment",
    performer: 'BRAIN',
    grant: sendGrant,
    provider: sendProvider,
    costCents: 0,
    count: 0,
    request: null,
    blockedBy: [
      'no adapter sends a file to a buyer: the messaging adapters carry text only, so delivery of the produced file is not yet automated',
      ...(sendGrant.ok ? [] : [`CONTACT_BUYER is not granted: ${sendGrant.reason}`]),
    ],
  });

  return {
    experimentId: def.id,
    live: false,
    problems,
    exposure: { plannedCents: planned, ceilingCents: def.exposureCeilingCents, ok: planned <= def.exposureCeilingCents },
    judgment,
    effects,
    ready: effects.every((one) => one.disposition === 'WOULD_PERFORM'),
  };
}

/** The public URL of a created link, from the confirmed attempt's redacted receipt. */
export async function linkUrlOf(operation: IdempotencyOperation): Promise<string | null> {
  if (operation.state !== 'SUCCEEDED') return null;
  for (const attempt of await listAttempts(operation.id)) {
    const url = attempt.receiptMeta.url;
    if (typeof url === 'string' && /^https:\/\/buy\.stripe\.com\//.test(url)) return url;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Performing — dry run unless every gate is open                        */
/* ------------------------------------------------------------------ */

export type PerformOutcome =
  | {
      performed: false;
      /** What would have been sent. */
      wouldSend: unknown;
      blockedBy: string[];
      /** The PROPOSED authority-ledger row this dry run wrote, when it wrote one. */
      proposalId: string | null;
    }
  | { performed: true; status: string; receiptRef: string | null; operationId: string };

async function propose(projectId: string, action: CommercialAction, opportunityId: string | null, wouldSend: unknown): Promise<string | null> {
  const decision = await checkCommercialAuthority({
    projectId,
    action,
    mode: 'PROPOSE',
    opportunityId,
    subjectRef: digest(wouldSend),
    ...actionContext({ principal: BRAIN_PRINCIPAL }),
  });
  return decision.decisionId ?? null;
}

/**
 * Create the experiment's payment link — only when `live`, the definition is
 * valid, ACCEPT_PAYMENT is granted and Stripe is connected. Anything less
 * records a proposal and sends nothing.
 */
export async function createExperimentPaymentLink(input: {
  projectId: string;
  experiment: OfferExperiment;
  live?: boolean;
}): Promise<PerformOutcome> {
  const def = input.experiment;
  const problems = experimentProblems(def).map((one) => `${one.field}: ${one.problem}`);
  const payload = paymentLinkPayload(def);
  let wouldSend: unknown = payload;
  if (problems.length === 0) wouldSend = paymentLinkRequests(payload, paymentLinkBusinessId(def.id));
  const blockedBy = [...problems];
  if (input.live !== true) blockedBy.push('dry run: live was not requested');
  const adapter = usableAdapter(PAYMENT_LINK_NAMESPACE);
  if (!adapter) blockedBy.push(`no connected billing provider: ${adapterStatus(PAYMENT_LINK_NAMESPACE).reason}`);
  const grant = await grantReading(input.projectId, 'ACCEPT_PAYMENT', null);
  if (!grant.ok) blockedBy.push(`ACCEPT_PAYMENT is not granted: ${grant.reason}`);
  if (blockedBy.length > 0 || !adapter) {
    return { performed: false, wouldSend, blockedBy, proposalId: await propose(input.projectId, 'ACCEPT_PAYMENT', def.opportunityId, wouldSend) };
  }
  // The recorded judgment immediately before the effect, as every commercial effect has.
  const decision = await checkCommercialAuthority({
    projectId: input.projectId,
    action: 'ACCEPT_PAYMENT',
    opportunityId: def.opportunityId,
    ...actionContext({ principal: BRAIN_PRINCIPAL }),
  });
  if (!decision.ok) {
    return { performed: false, wouldSend, blockedBy: [`ACCEPT_PAYMENT is not granted: ${decision.reason}`], proposalId: null };
  }
  const outcome = await runExternalEffect({
    adapter,
    namespace: PAYMENT_LINK_NAMESPACE,
    projectId: input.projectId,
    key: paymentLinkKey(def.id),
    businessId: paymentLinkBusinessId(def.id),
    payload,
    principalType: 'SYSTEM',
    principalId: PAYMENT_LINK_PRINCIPAL,
    correlationId: `experiment:${def.id}:payment_link`,
  });
  const receiptRef = receiptOf(outcome);
  await recordEffectReceipt({
    projectId: input.projectId,
    opportunityId: def.opportunityId,
    action: 'ACCEPT_PAYMENT',
    decisionId: decision.decisionId,
    disposition: outcome.status === 'CONFIRMED' || outcome.status === 'RECONCILED' ? 'PERFORMED' : outcome.status === 'REPLAYED' ? 'REPLAYED' : outcome.status === 'UNCERTAIN' ? 'UNKNOWN' : 'FAILED',
    receiptRef,
    operationId: outcome.operation.id,
    actorRef: BRAIN_PRINCIPAL,
  });
  return { performed: true, status: outcome.status, receiptRef, operationId: outcome.operation.id };
}

export interface SendBatchOutcome {
  /** Leads the batch performed a send for, with the engine's status. */
  sent: { email: string; status: string; receiptRef: string | null }[];
  /** Leads it would have sent to, when nothing was performed. */
  wouldSend: ComposedMessage[];
  /** Leads it refused one by one (a malformed address, a duplicate). */
  refused: { email: string; reason: string }[];
  blockedBy: string[];
  proposalId: string | null;
  judgment: ExperimentJudgment;
}

/**
 * Send the offer to a batch of leads — only when `live`, the definition is
 * valid, the experiment is RUNNING with room under its cap, the payment link
 * exists, every message passes CAN-SPAM, CONTACT_BUYER is granted and a
 * messaging provider is connected. Anything less records one proposal for the
 * batch and sends nothing. Each lead is its own keyed effect, so a retried
 * batch never mails a lead twice.
 */
export async function sendExperimentOffers(input: {
  projectId: string;
  experiment: OfferExperiment;
  leads: ExperimentLead[];
  observation: ExperimentObservation;
  live?: boolean;
}): Promise<SendBatchOutcome> {
  const def = input.experiment;
  const judgment = judgeExperiment(def, input.observation);
  const blockedBy = experimentProblems(def).map((one) => `${one.field}: ${one.problem}`);
  if (judgment.verdict !== 'RUNNING') blockedBy.push(`the experiment is ${judgment.verdict}: ${judgment.reasons.join('; ')}`);
  const link = await paymentLinkOperation(input.projectId, def.id);
  const linkUrl = link ? await linkUrlOf(link) : null;
  if (!linkUrl) blockedBy.push('the payment link has not been created, so there is nothing for a buyer to pay through');

  const refused: SendBatchOutcome['refused'] = [];
  const messages: ComposedMessage[] = [];
  const seen = new Set<string>();
  for (const lead of input.leads) {
    if (messages.length >= judgment.sendsRemaining && judgment.verdict === 'RUNNING') break;
    const email = lead.email.trim().toLowerCase();
    if (!ADDRESS.test(email)) { refused.push({ email, reason: 'not one email address' }); continue; }
    if (seen.has(email)) { refused.push({ email, reason: 'already in this batch' }); continue; }
    seen.add(email);
    const composed = composeExperimentMessage(def, lead, linkUrl ?? LINK_NOT_CREATED);
    if (!composed.ok) {
      for (const problem of composed.problems) if (!blockedBy.includes(`CAN-SPAM: ${problem}`)) blockedBy.push(`CAN-SPAM: ${problem}`);
      continue;
    }
    messages.push(composed.message);
  }
  if (input.live !== true) blockedBy.push('dry run: live was not requested');
  if (!def.opportunityId) blockedBy.push('no opportunity is named to record the sends against');
  const adapter = usableAdapter(CONTACT_BUYER_NAMESPACE);
  if (!adapter) blockedBy.push(`no connected messaging provider: ${adapterStatus(CONTACT_BUYER_NAMESPACE).reason}`);
  const grant = await grantReading(input.projectId, 'CONTACT_BUYER', null);
  if (!grant.ok) blockedBy.push(`CONTACT_BUYER is not granted: ${grant.reason}`);

  if (blockedBy.length > 0 || !def.opportunityId) {
    const template = messages[0] ? { subject: messages[0].subject, text: messages[0].text, recipients: messages.length } : null;
    return {
      sent: [],
      wouldSend: messages,
      refused,
      blockedBy,
      proposalId: await propose(input.projectId, 'CONTACT_BUYER', def.opportunityId, template),
      judgment,
    };
  }

  const sent: SendBatchOutcome['sent'] = [];
  for (const message of messages) {
    // Judged and recorded per send: a grant revoked mid-batch stops the rest.
    const decision = await checkCommercialAuthority({
      projectId: input.projectId,
      action: 'CONTACT_BUYER',
      opportunityId: def.opportunityId,
      ...actionContext({ principal: BRAIN_PRINCIPAL }),
    });
    if (!decision.ok || !decision.authority) {
      blockedBy.push(`CONTACT_BUYER refused mid-batch: ${decision.reason}`);
      break;
    }
    const outcome = await sendCommercialEffect({
      action: 'CONTACT_BUYER',
      projectId: input.projectId,
      opportunityId: def.opportunityId,
      occurrence: leadOccurrence(def.id, message.to),
      payload: { payer: message.to, channel: def.leadSource?.name ?? 'licensed list', ...message },
      authorityId: decision.authority.id,
      amountCents: null,
      stateAtSend: `EXPERIMENT:${def.id}`,
    });
    sent.push({ email: message.to, status: outcome.status, receiptRef: receiptOf(outcome) });
    await recordEffectReceipt({
      projectId: input.projectId,
      opportunityId: def.opportunityId,
      action: 'CONTACT_BUYER',
      decisionId: decision.decisionId,
      disposition: outcome.status === 'CONFIRMED' || outcome.status === 'RECONCILED' ? 'PERFORMED' : outcome.status === 'REPLAYED' ? 'REPLAYED' : outcome.status === 'UNCERTAIN' ? 'UNKNOWN' : 'FAILED',
      receiptRef: receiptOf(outcome),
      operationId: outcome.operation.id,
      actorRef: BRAIN_PRINCIPAL,
    });
    // An unknown outcome stops the batch for a person: it is never read as "did not send".
    if (outcome.status === 'UNCERTAIN') {
      blockedBy.push(`the send to ${message.to} has an unknown outcome; the batch stops until it is settled`);
      break;
    }
  }
  return { sent, wouldSend: [], refused, blockedBy, proposalId: null, judgment };
}

export type LinkPaymentReader = (linkId: string) => Promise<{ kind: 'READ'; payments: LinkPayment[]; complete: boolean } | { kind: 'UNREADABLE'; reason: string }>;

/**
 * Payment observed → ledger: every paid checkout the link took, recorded once
 * as a CUSTOMER_PAYMENT backed by the link's own operation and carrying the
 * provider's payment reference. A read and a write of rows; it sends nothing.
 */
export async function recordExperimentPayments(input: {
  projectId: string;
  experiment: OfferExperiment;
  read?: LinkPaymentReader;
}): Promise<{ recorded: number; replayed: number; refused: { reference: string; reason: string }[]; reason: string | null; buyers: { reference: string; email: string | null }[] }> {
  const def = input.experiment;
  const link = await paymentLinkOperation(input.projectId, def.id);
  if (!link || link.state !== 'SUCCEEDED' || !link.resultRef) {
    return { recorded: 0, replayed: 0, refused: [], reason: 'no payment link has been created for this experiment', buyers: [] };
  }
  const reading = await (input.read ?? ((id: string) => readStripePaymentLinkPayments(id)))(link.resultRef);
  if (reading.kind !== 'READ') return { recorded: 0, replayed: 0, refused: [], reason: reading.reason, buyers: [] };
  let recorded = 0;
  let replayed = 0;
  const refused: { reference: string; reason: string }[] = [];
  const buyers: { reference: string; email: string | null }[] = [];
  for (const payment of reading.payments) {
    const key = `${EXPERIMENT_PAYMENT_KEY_PREFIX}${def.id}:${payment.reference}`;
    const existed = (await moneyEntryByKey(input.projectId, key)) !== null;
    const written = await recordMoneyEvent({
      projectId: input.projectId,
      opportunityId: def.opportunityId,
      kind: 'CUSTOMER_PAYMENT',
      amountCents: payment.amountCents,
      currency: payment.currency,
      verifiedReference: payment.reference,
      occurredAt: payment.paidAt ?? undefined,
      note: `Paid through the payment link of experiment ${def.id}.`,
      idempotencyKey: key,
      actorRef: BRAIN_PRINCIPAL,
      paidThroughLinkOperationId: link.id,
    });
    if (!written.ok) { refused.push({ reference: payment.reference, reason: written.reason }); continue; }
    buyers.push({ reference: payment.reference, email: payment.buyerEmail });
    if (existed) replayed += 1;
    else recorded += 1;
  }
  return { recorded, replayed, refused, reason: reading.complete ? null : 'Stripe has more paid checkouts than one page; the rest are read next pass', buyers };
}
