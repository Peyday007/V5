/**
 * Registering the commercial providers a deployment selected, once, at boot.
 *
 * A provider is registered only when the deployment names it
 * (`BRAIN_MESSAGING_PROVIDER`, `BRAIN_BILLING_PROVIDER`). Registration is the
 * choice of provider; whether it can be used is asked again on every capability
 * reading through `health()`, so a key removed or malformed after boot reads as
 * MISSING without a restart, and a provider nobody chose is never registered at
 * all. Alternates (`BRAIN_MESSAGING_ALTERNATES`, `BRAIN_BILLING_ALTERNATES`)
 * are named the same way and registered behind the primary, each only when its
 * own settings read configured: they are the alternative fulfillers a refused
 * commitment is transferred to (CP-31). Nothing here sends anything or reaches
 * the network.
 */
import { registerAdapter } from '../../effects/adapter.ts';
import { CONTACT_BUYER_NAMESPACE, ISSUE_INVOICE_NAMESPACE } from '../effects.ts';
import { alternateProviders, billingConfig, messagingConfig } from './config.ts';
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

/** Register one messaging provider by name, recorded as a counterparty. Returns false for a name this version does not implement. */
function registerMessaging(provider: string, env: NodeJS.ProcessEnv): boolean {
  if (provider === 'resend') {
    registerAdapter(recordingCounterparty(createResendAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }), {
      area: 'MESSAGING', provider: 'resend', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: unreported,
    }));
    return true;
  }
  if (provider === 'instantly') {
    // The owner's Instantly workspace (§94): a lead in Brain's campaign, activated only inside the granted effect.
    // Every send is also recorded as a counterparty commitment (CP-31, `counterpartyRecord.ts`).
    registerAdapter(recordingCounterparty(createInstantlyAdapter({ namespace: CONTACT_BUYER_NAMESPACE.name }), {
      area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: () => instantlyPerDay(env),
    }));
    return true;
  }
  return false;
}

/** Register one billing provider's invoice adapter by name, recorded as a counterparty. */
function registerBilling(provider: string): boolean {
  if (provider !== 'stripe') return false;
  registerAdapter(recordingCounterparty(createStripeInvoiceAdapter({ namespace: ISSUE_INVOICE_NAMESPACE.name }), {
    area: 'INVOICES', provider: 'stripe', capability: 'ISSUE_AN_INVOICE', action: 'QUOTE_AND_INVOICE', capacityPerDay: unreported,
  }));
  return true;
}

export function registerCommercialProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const out: ProviderRegistration = { messaging: null, billing: null };
  // The primary first: the effect path serves an operation with the first adapter registered for its
  // namespace (`effects.ts` `adapterFor`), so an alternate never takes a send the primary was chosen for.
  const messaging = messagingConfig(env).provider;
  if (messaging && registerMessaging(messaging, env)) out.messaging = messaging;
  const billing = billingConfig(env).provider;
  if (billing === 'stripe') {
    registerBilling('stripe');
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
  // Alternative fulfillers (CP-31): every further provider the deployment named for an area, registered
  // behind the primary and only when its own settings read configured, so a refused commitment has a
  // second counterparty to be transferred to (`counterpartyRecord.ts`). Only with a primary: an
  // alternate is never the area's only provider by accident of a missing primary.
  if (out.messaging) {
    for (const alternate of alternateProviders('MESSAGING', env)) {
      if (alternate.configured && alternate.provider) registerMessaging(alternate.provider, env);
    }
  }
  if (out.billing) {
    for (const alternate of alternateProviders('BILLING', env)) {
      if (alternate.configured && alternate.provider) registerBilling(alternate.provider);
    }
  }
  // The chosen providers are counterparties too (CP-31): their commitments are read through the
  // counterparty ladder on the same live status reading, so production verification consults the
  // model rather than a parallel check. Read-only; it sends nothing and reserves nothing.
  registerProbe(PROVIDER_COUNTERPARTY_PROBE, () => providerCounterpartyProbe(env));
  return out;
}
