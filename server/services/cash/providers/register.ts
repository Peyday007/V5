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
import { createStripeInvoiceAdapter, readStripeInvoice } from './stripe.ts';

export interface ProviderRegistration {
  messaging: string | null;
  billing: string | null;
}

export function registerCommercialProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const out: ProviderRegistration = { messaging: null, billing: null };
  if (messagingConfig(env).provider === 'resend') {
    registerAdapter(createResendAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }));
    out.messaging = 'resend';
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
  return out;
}
