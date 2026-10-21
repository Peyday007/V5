/**
 * Which store, supplier and ad account this Brain is connected to (§74), read
 * from the deployment's environment on every call.
 *
 * The same rule as `cash/providers/config.ts`: a credential is a deployment
 * secret a person sets, never a row, never sent to a browser, and every string
 * this module returns names a setting and never its value. Nothing is cached,
 * so a removed secret reads as not connected on the next pass.
 */

export const STORE_PROVIDER_ENV = 'BRAIN_STORE_PROVIDER';
export const SHOPIFY_DOMAIN_ENV = 'SHOPIFY_STORE_DOMAIN';
export const SHOPIFY_TOKEN_ENV = 'SHOPIFY_ADMIN_TOKEN';

export const SUPPLIER_PROVIDER_ENV = 'BRAIN_SUPPLIER_PROVIDER';
export const CJ_KEY_ENV = 'CJ_API_KEY';
/** `true` makes every CJ order a sandbox order that charges nothing. */
export const CJ_SANDBOX_ENV = 'CJ_SANDBOX';

export const ADS_PROVIDER_ENV = 'BRAIN_ADS_PROVIDER';
export const META_TOKEN_ENV = 'META_ACCESS_TOKEN';
export const META_AD_ACCOUNT_ENV = 'META_AD_ACCOUNT_ID';
export const META_PAGE_ENV = 'META_PAGE_ID';
/** The owner's daily budget for one ad test, in the ad account's minor units. */
export const ADS_DAILY_BUDGET_ENV = 'BRAIN_ADS_DAILY_BUDGET_CENTS';
/** Two-letter country codes to show ads in. Defaults to US. */
export const ADS_COUNTRIES_ENV = 'BRAIN_ADS_COUNTRIES';

export const STORE_PROVIDERS = ['shopify'] as const;
export const SUPPLIER_PROVIDERS = ['cj'] as const;
export const ADS_PROVIDERS = ['meta'] as const;

/** The smallest daily test budget Brain will run; below it a test learns nothing. */
export const MIN_DAILY_BUDGET_CENTS = 500;

export interface ConnectionReading {
  provider: string | null;
  configured: boolean;
  /** Setting names that are absent or malformed. Never values. */
  problems: string[];
}

function read(name: string, env: NodeJS.ProcessEnv): string | null {
  const value = (env[name] ?? '').trim();
  return value === '' ? null : value;
}

function chosen(
  envName: string,
  allowed: readonly string[],
  env: NodeJS.ProcessEnv,
): { provider: string | null; problem: string | null } {
  const provider = read(envName, env);
  if (!provider) return { provider: null, problem: envName };
  if (!allowed.includes(provider)) {
    return { provider, problem: `${envName} (only ${allowed.join(', ')} is implemented)` };
  }
  return { provider, problem: null };
}

export function storeConfig(env: NodeJS.ProcessEnv = process.env): ConnectionReading {
  const { provider, problem } = chosen(STORE_PROVIDER_ENV, STORE_PROVIDERS, env);
  if (problem) return { provider, configured: false, problems: [problem] };
  const problems: string[] = [];
  const domain = read(SHOPIFY_DOMAIN_ENV, env);
  if (!domain) problems.push(SHOPIFY_DOMAIN_ENV);
  else if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) {
    problems.push(`${SHOPIFY_DOMAIN_ENV} (must be the store's .myshopify.com domain)`);
  }
  const token = read(SHOPIFY_TOKEN_ENV, env);
  if (!token) problems.push(SHOPIFY_TOKEN_ENV);
  else if (!/^shpat_/.test(token)) problems.push(`${SHOPIFY_TOKEN_ENV} (not an Admin API access token)`);
  return { provider, configured: problems.length === 0, problems };
}

export function supplierConfig(env: NodeJS.ProcessEnv = process.env): ConnectionReading {
  const { provider, problem } = chosen(SUPPLIER_PROVIDER_ENV, SUPPLIER_PROVIDERS, env);
  if (problem) return { provider, configured: false, problems: [problem] };
  const problems: string[] = [];
  if (!read(CJ_KEY_ENV, env)) problems.push(CJ_KEY_ENV);
  return { provider, configured: problems.length === 0, problems };
}

export function cjSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return (read(CJ_SANDBOX_ENV, env) ?? '').toLowerCase() === 'true';
}

export function adsConfig(env: NodeJS.ProcessEnv = process.env): ConnectionReading {
  const { provider, problem } = chosen(ADS_PROVIDER_ENV, ADS_PROVIDERS, env);
  if (problem) return { provider, configured: false, problems: [problem] };
  const problems: string[] = [];
  if (!read(META_TOKEN_ENV, env)) problems.push(META_TOKEN_ENV);
  const account = read(META_AD_ACCOUNT_ENV, env);
  if (!account) problems.push(META_AD_ACCOUNT_ENV);
  else if (!/^(act_)?\d+$/.test(account)) problems.push(`${META_AD_ACCOUNT_ENV} (an ad account id, digits)`);
  const page = read(META_PAGE_ENV, env);
  if (!page) problems.push(META_PAGE_ENV);
  else if (!/^\d+$/.test(page)) problems.push(`${META_PAGE_ENV} (a Facebook Page id, digits)`);
  const budget = dailyBudgetCents(env);
  if (budget === null) {
    problems.push(`${ADS_DAILY_BUDGET_ENV} (a whole number of cents, at least ${MIN_DAILY_BUDGET_CENTS})`);
  }
  for (const country of adCountries(env)) {
    if (!/^[A-Z]{2}$/.test(country)) problems.push(`${ADS_COUNTRIES_ENV} (two-letter codes, comma separated)`);
  }
  return { provider, configured: problems.length === 0, problems };
}

export function dailyBudgetCents(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = read(ADS_DAILY_BUDGET_ENV, env);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= MIN_DAILY_BUDGET_CENTS ? value : null;
}

export function adCountries(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = read(ADS_COUNTRIES_ENV, env);
  if (!raw) return ['US'];
  return [...new Set(raw.split(',').map((one) => one.trim().toUpperCase()).filter(Boolean))];
}

export function adAccountId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = read(META_AD_ACCOUNT_ENV, env);
  if (!raw) return null;
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

/** The value itself, for the one module that sends it in a header. */
export function secret(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return read(name, env);
}
