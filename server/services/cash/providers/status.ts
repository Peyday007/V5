/**
 * Messaging, invoices and payments: CONNECTED or MISSING, and the exact next
 * action — the whole of the operator setup for commercial providers.
 *
 * Composed from the same readings the capability check takes (`readCapability`)
 * so this answer and the one that decides whether Brain acts cannot disagree.
 * Every sentence names settings and never their values; a live probe of the
 * key is a separate, explicit call (`probeProviders`) because it reaches the
 * network and a status read should not.
 */
import { readCapability } from '../capabilities.ts';
import {
  BILLING_PROVIDER_ENV,
  MESSAGING_FROM_ENV,
  MESSAGING_PROVIDER_ENV,
  RESEND_KEY_ENV,
  STRIPE_KEY_ENV,
  billingConfig,
  messagingConfig,
} from './config.ts';
import { probeResend } from './resend.ts';
import { probeStripe } from './stripe.ts';

export interface ProviderLine {
  area: 'MESSAGING' | 'INVOICES' | 'PAYMENTS';
  capability: string;
  state: 'CONNECTED' | 'MISSING';
  provider: string | null;
  /** TEST or LIVE for billing — whether pressing anything moves real money. */
  mode: 'TEST' | 'LIVE' | null;
  detail: string;
  nextAction: string;
}

const MESSAGING_SETUP =
  `Set ${MESSAGING_PROVIDER_ENV}=resend, ${RESEND_KEY_ENV} (a Resend API key) and ` +
  `${MESSAGING_FROM_ENV} (an address on a domain verified in Resend) as deployment secrets, ` +
  'then restart.';
const BILLING_SETUP =
  `Set ${BILLING_PROVIDER_ENV}=stripe and ${STRIPE_KEY_ENV} (an sk_test_ key first, an sk_live_ ` +
  'key once a test invoice has been paid) as deployment secrets, then restart.';

export async function commercialProviderStatus(env: NodeJS.ProcessEnv = process.env): Promise<ProviderLine[]> {
  const messaging = messagingConfig(env);
  const billing = billingConfig(env);
  const send = await readCapability('SEND_A_MESSAGE');
  const invoice = await readCapability('ISSUE_AN_INVOICE');
  const pay = await readCapability('TAKE_A_PAYMENT');

  const line = (
    area: ProviderLine['area'],
    capability: string,
    present: boolean,
    provider: string | null,
    problems: string[],
    setup: string,
    mode: ProviderLine['mode'],
  ): ProviderLine => ({
    area,
    capability,
    state: present ? 'CONNECTED' : 'MISSING',
    provider,
    mode,
    detail: present
      ? `${provider} is registered and configured${mode ? ` (${mode} mode)` : ''}.`
      : problems.length > 0
        ? `Missing or malformed: ${problems.join(', ')}.`
        : 'Configured, and not registered: the deployment has not restarted since it was set.',
    nextAction: present ? 'Nothing. Run `npm run report:cash -- --probe` to check the key against the provider.' : setup,
  });

  return [
    line('MESSAGING', 'SEND_A_MESSAGE', send.state === 'PRESENT', messaging.provider, messaging.problems, MESSAGING_SETUP, null),
    line('INVOICES', 'ISSUE_AN_INVOICE', invoice.state === 'PRESENT', billing.provider, billing.problems, BILLING_SETUP, billing.mode ?? null),
    line('PAYMENTS', 'TAKE_A_PAYMENT', pay.state === 'PRESENT', billing.provider, billing.problems, BILLING_SETUP, billing.mode ?? null),
  ];
}

/** Ask each configured provider whether it accepts the key. Sends nothing. */
export async function probeProviders(): Promise<{ messaging: string; billing: string }> {
  const [resend, stripe] = await Promise.all([probeResend(), probeStripe()]);
  return {
    messaging: `${resend.verdict}: ${resend.detail}`,
    billing: `${stripe.verdict}: ${stripe.detail}`,
  };
}
