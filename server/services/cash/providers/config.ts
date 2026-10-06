/**
 * Which commercial providers this Brain is configured for, read from the
 * deployment's environment — and never anything more than whether a setting is
 * present and well-formed.
 *
 * ---------------------------------------------------------------------------
 * Why the environment, and nothing new
 * ---------------------------------------------------------------------------
 *
 * Brain already holds every credential it uses this way: a Routine's bearer is
 * `process.env[secretName]` (`dispatch/fire.ts`), the database URL and the
 * service-role key are deployment secrets (§18), and nothing in this
 * repository can write one. A provider key belongs in the same place for the
 * same reasons — it is set by a person on the deployment, never stored in a
 * row, never sent to a browser, and rotating it is a `flyctl secrets set`.
 * A table holding provider keys would be a second credential framework with
 * the weaker half winning (invariant 22).
 *
 * ---------------------------------------------------------------------------
 * Read on every call
 * ---------------------------------------------------------------------------
 *
 * Nothing here is cached. A key removed from the deployment must read as
 * MISSING on the next capability reading, not at the next restart — the same
 * rule `capabilities.ts` states for every reading it takes.
 *
 * Every string this module returns names a setting and never its value. The
 * one fact derived from a value is a Stripe key's *mode* (test or live), read
 * from its documented prefix, because "this would move real money" is the one
 * thing an operator must be able to see before approving anything.
 */

export const MESSAGING_PROVIDER_ENV = 'BRAIN_MESSAGING_PROVIDER';
export const RESEND_KEY_ENV = 'RESEND_API_KEY';
export const MESSAGING_FROM_ENV = 'BRAIN_MESSAGING_FROM';

export const BILLING_PROVIDER_ENV = 'BRAIN_BILLING_PROVIDER';
export const STRIPE_KEY_ENV = 'STRIPE_SECRET_KEY';

/** The providers this version implements. Anything else is refused by name. */
export const MESSAGING_PROVIDERS = ['resend'] as const;
export const BILLING_PROVIDERS = ['stripe'] as const;

function read(name: string, env: NodeJS.ProcessEnv): string | null {
  const value = (env[name] ?? '').trim();
  return value === '' ? null : value;
}

export interface ProviderConfigReading {
  /** Which provider was selected, or null when none was. */
  provider: string | null;
  /** True when every setting it needs is present and well-formed. */
  configured: boolean;
  /** Setting names that are absent or malformed. Never values. */
  problems: string[];
  /** For billing only: TEST or LIVE, from the key's documented prefix. */
  mode?: 'TEST' | 'LIVE' | null;
}

/** A single address, optionally with a display name: `Name <a@b.c>` or `a@b.c`. */
export const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function senderAddress(from: string): string | null {
  const bracketed = /^[^<>]*<([^<>\s]+)>\s*$/.exec(from);
  const address = bracketed ? bracketed[1]! : from.trim();
  return ADDRESS.test(address) ? address : null;
}

export function messagingConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfigReading {
  const provider = read(MESSAGING_PROVIDER_ENV, env);
  if (!provider) {
    return { provider: null, configured: false, problems: [MESSAGING_PROVIDER_ENV] };
  }
  if (!(MESSAGING_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      provider,
      configured: false,
      problems: [`${MESSAGING_PROVIDER_ENV} (only ${MESSAGING_PROVIDERS.join(', ')} is implemented)`],
    };
  }
  const problems: string[] = [];
  const key = read(RESEND_KEY_ENV, env);
  if (!key) problems.push(RESEND_KEY_ENV);
  else if (!key.startsWith('re_')) problems.push(`${RESEND_KEY_ENV} (not a Resend key)`);
  const from = read(MESSAGING_FROM_ENV, env);
  if (!from) problems.push(MESSAGING_FROM_ENV);
  else if (!senderAddress(from)) problems.push(`${MESSAGING_FROM_ENV} (not one email address)`);
  return { provider, configured: problems.length === 0, problems };
}

export function billingConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfigReading {
  const provider = read(BILLING_PROVIDER_ENV, env);
  if (!provider) {
    return { provider: null, configured: false, problems: [BILLING_PROVIDER_ENV], mode: null };
  }
  if (!(BILLING_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      provider,
      configured: false,
      problems: [`${BILLING_PROVIDER_ENV} (only ${BILLING_PROVIDERS.join(', ')} is implemented)`],
      mode: null,
    };
  }
  const key = read(STRIPE_KEY_ENV, env);
  if (!key) return { provider, configured: false, problems: [STRIPE_KEY_ENV], mode: null };
  const mode = /^(sk|rk)_live_/.test(key) ? 'LIVE' : /^(sk|rk)_test_/.test(key) ? 'TEST' : null;
  if (!mode) {
    return {
      provider,
      configured: false,
      problems: [`${STRIPE_KEY_ENV} (not a Stripe secret or restricted key)`],
      mode: null,
    };
  }
  return { provider, configured: true, problems: [], mode };
}

/** The value itself, for the one module that sends it in an Authorization header. */
export function secretValue(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return read(name, env);
}
