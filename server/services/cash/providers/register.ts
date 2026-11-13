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
import { createInstantlyAdapter } from './instantly.ts';
import { createStripeInvoiceAdapter, readStripeInvoice } from './stripe.ts';
import { registerProbe } from '../../factory/program/probes.ts';
import { PROVIDER_COUNTERPARTY_PROBE, providerCounterpartyProbe } from './counterparty.ts';

export interface ProviderRegistration {
  messaging: string | null;
  billing: string | null;
}

export function registerCommercialProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const out: ProviderRegistration = { messaging: null, billing: null };
  if (messagingConfig(env).provider === 'resend') {
    registerAdapter(createResendAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }));
    out.messaging = 'resend';
  } else if (messagingConfig(env).provider === 'instantly') {
    // The owner's Instantly workspace (§94): a lead in Brain's campaign, activated only inside the granted effect.
    registerAdapter(createInstantlyAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }));
    out.messaging = 'instantly';
  }
  if (billingConfig(env).provider === 'stripe') {
    registerAdapter(createStripeInvoiceAdapter({ namespace: ISSUE_INVOICE_NAMESPACE.name }));
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
