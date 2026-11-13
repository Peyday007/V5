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
import { billingAlternates, billingConfig, messagingAlternates, messagingConfig } from './config.ts';
import { registerPaymentReader } from './payments.ts';
import { createResendAdapter } from './resend.ts';
import { createInstantlyAdapter, instantlyCapacity } from './instantly.ts';
import { createStripeInvoiceAdapter, readStripeInvoice } from './stripe.ts';
import { registerProbe } from '../../factory/program/probes.ts';
import { PROVIDER_COUNTERPARTY_PROBE, providerCounterpartyProbe } from './counterparty.ts';
import { fulfillingCounterparties, type ProviderFulfiller } from './counterpartyRecord.ts';

/** Instantly's measured daily capacity, shared by every business on the workspace; none reported is null. */
const instantlyPerDay = async (env: NodeJS.ProcessEnv): Promise<number | null> => (await instantlyCapacity({ env }))?.perDay ?? null;
/** Resend and Stripe report no capacity, and Brain invents none (§39): a hold on them is refused as unknown capacity. */
const unreported = async (): Promise<number | null> => null;

export interface ProviderRegistration {
  messaging: string | null;
  billing: string | null;
}

/** The seat and adapter of one implemented messaging provider, wrapped in nothing yet. */
function messagingFulfiller(provider: string, env: NodeJS.ProcessEnv): ProviderFulfiller | null {
  const namespace = CONTACT_BUYER_NAMESPACE.name;
  if (provider === 'resend') {
    return {
      adapter: createResendAdapter({ namespace }),
      seat: { area: 'MESSAGING', provider: 'resend', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: unreported },
    };
  }
  if (provider === 'instantly') {
    // The owner's Instantly workspace (§94): a lead in Brain's campaign, activated only inside the granted effect.
    return {
      adapter: createInstantlyAdapter({ namespace }),
      seat: { area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: () => instantlyPerDay(env) },
    };
  }
  return null;
}

function billingFulfiller(provider: string): ProviderFulfiller | null {
  if (provider === 'stripe') {
    return {
      adapter: createStripeInvoiceAdapter({ namespace: ISSUE_INVOICE_NAMESPACE.name }),
      seat: { area: 'INVOICES', provider: 'stripe', capability: 'ISSUE_AN_INVOICE', action: 'QUOTE_AND_INVOICE', capacityPerDay: unreported },
    };
  }
  return null;
}

/**
 * The chosen provider first, then each configured alternate (CP-31): every one
 * is a fulfiller of the same commitment, so a refusal by the first can be
 * transferred by the counterparty model to another rather than only back to
 * itself. Every send through any of them is recorded as a counterparty
 * commitment (`counterpartyRecord.ts`).
 */
function fulfillers(chosen: string | null, alternateNames: readonly string[], make: (provider: string) => ProviderFulfiller | null): ProviderFulfiller[] {
  if (!chosen) return [];
  return [chosen, ...alternateNames].map(make).filter((f): f is ProviderFulfiller => f !== null);
}

export interface ProviderRegistration {
  messaging: string | null;
  billing: string | null;
  /** The alternates registered behind each chosen provider, in the order they are offered. */
  alternates?: { messaging: string[]; billing: string[] };
}

export function registerCommercialProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const out: ProviderRegistration = { messaging: null, billing: null };
  const messaging = fulfillers(messagingConfig(env).provider, messagingAlternates(env), (p) => messagingFulfiller(p, env));
  if (messaging.length > 0) {
    registerAdapter(fulfillingCounterparties(messaging));
    out.messaging = messaging[0]!.seat.provider;
  }
  const billing = fulfillers(billingConfig(env).provider, billingAlternates(env), billingFulfiller);
  if (billing.length > 0) {
    registerAdapter(fulfillingCounterparties(billing));
    out.billing = billing[0]!.seat.provider;
  }
  if (billingConfig(env).provider === 'stripe') {
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
  }
  const messagingAlts = messaging.slice(1).map((f) => f.seat.provider);
  const billingAlts = billing.slice(1).map((f) => f.seat.provider);
  if (messagingAlts.length > 0 || billingAlts.length > 0) out.alternates = { messaging: messagingAlts, billing: billingAlts };
  // The chosen providers are counterparties too (CP-31): their commitments are read through the
  // counterparty ladder on the same live status reading, so production verification consults the
  // model rather than a parallel check. Read-only; it sends nothing and reserves nothing.
  registerProbe(PROVIDER_COUNTERPARTY_PROBE, () => providerCounterpartyProbe(env));
  return out;
}
