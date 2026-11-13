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
import { registerAdapter } from '../../effects/adapter.ts';
import { CONTACT_BUYER_NAMESPACE, ISSUE_INVOICE_NAMESPACE } from '../effects.ts';
import { billingConfig, messagingConfig } from './config.ts';
import { registerPaymentReader } from './payments.ts';
import { createResendAdapter } from './resend.ts';
import { createInstantlyAdapter, instantlyCapacity } from './instantly.ts';
import { createStripeInvoiceAdapter, readStripeInvoice } from './stripe.ts';
import { registerProbe } from '../../factory/program/probes.ts';
import { PROVIDER_COUNTERPARTY_PROBE, providerCounterpartyProbe } from './counterparty.ts';
import { recordingCounterparty } from './counterpartyRecord.ts';

/** Instantly's measured daily capacity, shared by every business on the workspace; none reported is null. */
const instantlyPerDay = async (env: NodeJS.ProcessEnv): Promise<number | null> => (await instantlyCapacity({ env }))?.perDay ?? null;
/** Resend and Stripe report no capacity, and Brain invents none (§39): a hold on them is refused as unknown capacity. */
const unreported = async (): Promise<number | null> => null;

export interface ProviderRegistration {
  messaging: string | null;
  billing: string | null;
}

export function registerCommercialProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const out: ProviderRegistration = { messaging: null, billing: null };
  if (messagingConfig(env).provider === 'resend') {
    registerAdapter(recordingCounterparty(createResendAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }), {
      area: 'MESSAGING', provider: 'resend', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: unreported,
    }));
    out.messaging = 'resend';
  } else if (messagingConfig(env).provider === 'instantly') {
    // The owner's Instantly workspace (§94): a lead in Brain's campaign, activated only inside the granted effect.
    // Every send is also recorded as a counterparty commitment (CP-31, `counterpartyRecord.ts`).
    registerAdapter(recordingCounterparty(createInstantlyAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }), {
      area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: () => instantlyPerDay(env),
    }));
    out.messaging = 'instantly';
  }
  if (billingConfig(env).provider === 'stripe') {
    registerAdapter(recordingCounterparty(createStripeInvoiceAdapter({ namespace: ISSUE_INVOICE_NAMESPACE.name }), {
      area: 'INVOICES', provider: 'stripe', capability: 'ISSUE_AN_INVOICE', action: 'QUOTE_AND_INVOICE', capacityPerDay: unreported,
    }));
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
  return out;
}
