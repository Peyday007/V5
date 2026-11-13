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
/** Instantly (API v2): the owner's existing cold-outreach workspace. The key is a workspace API key. */
export const INSTANTLY_KEY_ENV = 'INSTANTLY_API_KEY';
/** Optional: an existing Instantly campaign Brain adds its leads to, instead of the one it creates. */
export const INSTANTLY_CAMPAIGN_ENV = 'BRAIN_INSTANTLY_CAMPAIGN_ID';

export const BILLING_PROVIDER_ENV = 'BRAIN_BILLING_PROVIDER';
/**
 * Optional, comma-separated: further providers the deployment chooses as
 * alternative fulfillers for the same area (CP-31). Each is registered only when
 * its own settings read configured, and only behind the primary — the primary
 * named by `BRAIN_*_PROVIDER` still serves every send; an alternate is the
 * counterparty a failed commitment can be transferred to. Naming one is a
 * choice like naming the primary: a provider nobody named is never registered.
 */
export const MESSAGING_ALTERNATES_ENV = 'BRAIN_MESSAGING_ALTERNATES';
export const BILLING_ALTERNATES_ENV = 'BRAIN_BILLING_ALTERNATES';
export const STRIPE_KEY_ENV = 'STRIPE_SECRET_KEY';

/** The providers this version implements. Anything else is refused by name. */
export const MESSAGING_PROVIDERS = ['resend', 'instantly'] as const;
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
  return messagingProviderConfig(provider, env, MESSAGING_PROVIDER_ENV);
}

/** One named messaging provider's settings, whether it is the primary or an alternate. */
export function messagingProviderConfig(provider: string, env: NodeJS.ProcessEnv = process.env, chosenBy: string = MESSAGING_PROVIDER_ENV): ProviderConfigReading {
  if (!(MESSAGING_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      provider,
      configured: false,
      problems: [`${chosenBy} (only ${MESSAGING_PROVIDERS.join(', ')} is implemented)`],
    };
  }
  const problems: string[] = [];
  if (provider === 'instantly') {
    // Instantly sends from the workspace's own sending accounts, so no sender address is configured here.
    const key = read(INSTANTLY_KEY_ENV, env);
    if (!key) problems.push(INSTANTLY_KEY_ENV);
    else if (key.length < 20 || /\s/.test(key)) problems.push(`${INSTANTLY_KEY_ENV} (not an Instantly API key)`);
    const campaign = read(INSTANTLY_CAMPAIGN_ENV, env);
    if (campaign && !/^[0-9a-f-]{36}$/i.test(campaign)) problems.push(`${INSTANTLY_CAMPAIGN_ENV} (not a campaign id)`);
    return { provider, configured: problems.length === 0, problems };
  }
  const key = read(RESEND_KEY_ENV, env);
  if (!key) problems.push(RESEND_KEY_ENV);
  else if (!key.startsWith('re_')) problems.push(`${RESEND_KEY_ENV} (not a Resend key)`);
  const from = read(MESSAGING_FROM_ENV, env);
  if (!from) problems.push(MESSAGING_FROM_ENV);
  else if (!senderAddress(from)) problems.push(`${MESSAGING_FROM_ENV} (not one email address)`);
  return { provider, configured: problems.length === 0, problems };
}

/**
 * The alternates a deployment named for an area (`BRAIN_*_ALTERNATES`), each
 * read with its own settings, in the order named. The primary and repeats are
 * dropped: an alternate is a second counterparty, never the first one twice.
 */
export function alternateProviders(area: 'MESSAGING' | 'BILLING', env: NodeJS.ProcessEnv = process.env): ProviderConfigReading[] {
  const listName = area === 'MESSAGING' ? MESSAGING_ALTERNATES_ENV : BILLING_ALTERNATES_ENV;
  const primary = read(area === 'MESSAGING' ? MESSAGING_PROVIDER_ENV : BILLING_PROVIDER_ENV, env);
  const names = (read(listName, env) ?? '').split(',').map((one) => one.trim()).filter((one) => one !== '');
  const out: ProviderConfigReading[] = [];
  for (const name of [...new Set(names)]) {
    if (name === primary) continue;
    out.push(area === 'MESSAGING' ? messagingProviderConfig(name, env, listName) : billingProviderConfig(name, env, listName));
  }
  return out;
}

export function billingConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfigReading {
  const provider = read(BILLING_PROVIDER_ENV, env);
  if (!provider) {
    return { provider: null, configured: false, problems: [BILLING_PROVIDER_ENV], mode: null };
  }
  return billingProviderConfig(provider, env, BILLING_PROVIDER_ENV);
}

/** One named billing provider's settings, whether it is the primary or an alternate. */
export function billingProviderConfig(provider: string, env: NodeJS.ProcessEnv = process.env, chosenBy: string = BILLING_PROVIDER_ENV): ProviderConfigReading {
  if (!(BILLING_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      provider,
      configured: false,
      problems: [`${chosenBy} (only ${BILLING_PROVIDERS.join(', ')} is implemented)`],
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
