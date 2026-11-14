/**
 * Registering the commercial providers a deployment selected, once, at boot.
 *
 * A provider is registered only when the deployment names it
 * (`BRAIN_MESSAGING_PROVIDER`, `BRAIN_BILLING_PROVIDER`). Registration is the
 * choice of provider; whether it can be used is asked again on every capability
 * reading through `health()`, so a key removed or malformed after boot reads as
 * MISSING without a restart, and a provider nobody chose is never registered at
 * all. Nothing here sends anything or reaches the network.
 */
import { registerAdapter, type EffectAdapter } from '../../effects/adapter.ts';
import { CONTACT_BUYER_NAMESPACE, ISSUE_INVOICE_NAMESPACE } from '../effects.ts';
import { billingAlternates, billingConfig, messagingAlternates, messagingConfig } from './config.ts';
import { registerPaymentReader } from './payments.ts';
import { createResendAdapter } from './resend.ts';
import { createInstantlyAdapter, instantlyCapacity } from './instantly.ts';
import { createStripeInvoiceAdapter, readStripeInvoice } from './stripe.ts';
import { registerProbe } from '../../factory/program/probes.ts';
import { PROVIDER_COUNTERPARTY_PROBE, providerCounterpartyProbe } from './counterparty.ts';
import { ALTERNATIVE_COUNTERPARTIES as ALTERNATIVES, failoverCounterparty, providerCounterpartyId, type SeatedAdapter } from './counterpartyRecord.ts';
import { OPPORTUNITY_COUNTERPARTY_PROBE, opportunityCounterpartyProbe } from '../../labor/counterparties/operations.ts';

/** Instantly's measured daily capacity, shared by every business on the workspace; none reported is null. */
const instantlyPerDay = async (env: NodeJS.ProcessEnv): Promise<number | null> => (await instantlyCapacity({ env }))?.perDay ?? null;
/** Resend and Stripe report no capacity, and Brain invents none (§39): a hold on them is refused as unknown capacity. */
const unreported = async (): Promise<number | null> => null;

export interface ProviderRegistration {
  messaging: string | null;
  billing: string | null;
  /**
   * The alternative fulfillers seated behind the chosen provider, in the order they are tried
   * (CP-31). Present only when the deployment seated at least one.
   */
  messagingAlternates?: string[];
  billingAlternates?: string[];
}

/** One messaging provider seated as a counterparty, whichever role the deployment gave it. */
function messagingSeat(provider: string, env: NodeJS.ProcessEnv): SeatedAdapter | null {
  if (provider === 'resend') {
    return {
      adapter: createResendAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }),
      seat: { area: 'MESSAGING', provider: 'resend', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: unreported },
    };
  }
  if (provider === 'instantly') {
    // The owner's Instantly workspace (§94): a lead in Brain's campaign, activated only inside the granted effect.
    return {
      adapter: createInstantlyAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }),
      seat: { area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: () => instantlyPerDay(env) },
    };
  }
  return null;
}

/** One billing provider seated as a counterparty, whichever role the deployment gave it. */
function billingSeat(provider: string): SeatedAdapter | null {
  if (provider === 'stripe') {
    return {
      adapter: createStripeInvoiceAdapter({ namespace: ISSUE_INVOICE_NAMESPACE.name }),
      seat: { area: 'INVOICES', provider: 'stripe', capability: 'ISSUE_AN_INVOICE', action: 'QUOTE_AND_INVOICE', capacityPerDay: unreported },
    };
  }
  return null;
}

/**
 * The chosen provider, wrapped once with every alternative the deployment named
 * for the same area: one adapter per operation namespace (the engine's rule),
 * and every send — the primary's, and an alternative's after the primary's
 * definite refusal — recorded as a counterparty commitment (`counterpartyRecord.ts`).
 */
function seatArea(primary: SeatedAdapter, alternates: readonly string[], seatOf: (provider: string) => SeatedAdapter | null): { adapter: EffectAdapter; alternates: string[] } {
  const seated = alternates.map(seatOf).filter((one): one is SeatedAdapter => one !== null);
  const adapter = failoverCounterparty(primary, seated);
  const kept = new Set(adapter[ALTERNATIVES]);
  return { adapter, alternates: seated.filter((one) => kept.has(providerCounterpartyId(one.seat))).map((one) => one.seat.provider) };
}

export function registerCommercialProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const out: ProviderRegistration = { messaging: null, billing: null };
  const messagingChosen = messagingConfig(env).provider;
  const messaging = messagingChosen ? messagingSeat(messagingChosen, env) : null;
  if (messaging) {
    const area = seatArea(messaging, messagingAlternates(env).providers, (provider) => messagingSeat(provider, env));
    registerAdapter(area.adapter);
    out.messaging = messaging.seat.provider;
    if (area.alternates.length > 0) out.messagingAlternates = area.alternates;
  }
  const billingChosen = billingConfig(env).provider;
  const billing = billingChosen ? billingSeat(billingChosen) : null;
  if (billing) {
    const area = seatArea(billing, billingAlternates(env).providers, billingSeat);
    registerAdapter(area.adapter);
    if (area.alternates.length > 0) out.billingAlternates = area.alternates;
  }
  if (billingChosen === 'stripe') {
    registerPaymentReader({
      name: 'stripe.invoice_payments',
      provider: 'stripe',
      health: () => {
        const reading = billingConfig();
        return reading.configured
          ? { usable: true, reason: `Stripe is configured (${reading.mode} mode).` }
          : { usable: false, reason: `Stripe is not usable: missing or malformed ${reading.problems.join(', ')}.` };
      },
      read: (id) => readStripeInvoice(id),
    });
    out.billing = 'stripe';
  }
  // The chosen providers are counterparties too (CP-31): their commitments are read through the
  // counterparty ladder on the same live status reading, so production verification consults the
  // model rather than a parallel check. Read-only; it sends nothing and reserves nothing.
  registerProbe(PROVIDER_COUNTERPARTY_PROBE, () => providerCounterpartyProbe(env));
  // The contractor-delivered side (S-0469): every opportunity whose rows name a fulfiller, read
  // through the same model on production records. Registered whatever providers were chosen,
  // because a supplier or a crew is a counterparty whether or not a messaging provider is.
  registerProbe(OPPORTUNITY_COUNTERPARTY_PROBE, (args) => opportunityCounterpartyProbe(args));
  return out;
}
