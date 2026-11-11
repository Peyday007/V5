/**
 * Stripe stage of the launch runner: the mailer's 8 payment links.
 *
 * Once the owner's Stripe account can take charges, this creates one product,
 * one price and one Payment Link per ad space (4 sizes × 2 zones), and reads
 * the owner's public business details (name, phone, email, address) that
 * Stripe's activation already collected, so the mailer's materials can be
 * filled in without asking him again.
 *
 * Idempotent by construction: every object carries
 * `metadata[brain_launch]=<key>`, prices carry a `lookup_key`, and a run first
 * lists what exists. Each create also sends an `Idempotency-Key` derived from
 * the key, so a retry after a timeout replays instead of duplicating.
 *
 *   npx tsx scripts/launch/stripe.ts dry-run | run
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types.ts';

export const STRIPE_API = 'https://api.stripe.com/v1';
const VERSION = '2024-06-20';

export interface Space { key: string; name: string; amountCents: number }

// Prices and names follow fast-cash/launch-2026-11-11/mailer/RATE-CARD.md.
const SIZES: Array<[string, string, number, number]> = [
  ['standard', 'Standard spot', 295, 495],
  ['double', 'Double spot', 525, 895],
  ['back-premium', 'Back Premium spot', 575, 975],
  ['front-feature', 'Front Feature spot', 625, 1050],
];
export const SPACES: Space[] = SIZES.flatMap(([k, n, z1, both]) => [
  { key: `neighbor-card-2027-01-${k}-zone1`, name: `The Neighbor Card (Jan 2027) · ${n} · Zone 1, 4,944 homes`, amountCents: z1 * 100 },
  { key: `neighbor-card-2027-01-${k}-both`, name: `The Neighbor Card (Jan 2027) · ${n} · Both zones, 9,894 homes`, amountCents: both * 100 },
]);

const CONFIRMATION =
  'Thanks! Your category is locked. Reply to my email with your ad content. ' +
  'The card prints only if 10 of its 22 ad cells are paid by Wed Dec 9, 2026, 5 pm ET; otherwise you get a full refund by Fri Dec 11.';

export interface OwnerContact { name?: string; email?: string; phone?: string; address?: string; town?: string; zip?: string; url?: string }

type Json = Record<string, any>;

function form(params: Record<string, string | number | boolean>): string {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export async function call(ctx: StageContext, key: string, method: 'GET' | 'POST', p: string, body?: Record<string, string | number | boolean>, idem?: string): Promise<Json> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Stripe-Version': VERSION };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await ctx.fetch(`${STRIPE_API}${p}`, { method, headers, body: body ? form(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(`Stripe ${method} ${p.split('?')[0]} → ${res.status}: ${json?.error?.message ?? 'no message'}`);
  return json;
}

export async function listAll(ctx: StageContext, key: string, p: string): Promise<Json[]> {
  const out: Json[] = [];
  let after = '';
  for (let i = 0; i < 20; i++) {
    const page = await call(ctx, key, 'GET', `${p}${p.includes('?') ? '&' : '?'}limit=100${after ? `&starting_after=${after}` : ''}`);
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

export function contactFromAccount(account: Json): OwnerContact {
  const bp = account.business_profile ?? {};
  const a = bp.support_address ?? account.individual?.address ?? account.company?.address ?? {};
  const ind = account.individual ?? {};
  const legal = [ind.first_name, ind.last_name].filter(Boolean).join(' ');
  return {
    name: legal || bp.name || account.settings?.dashboard?.display_name || undefined,
    email: bp.support_email || account.email || undefined,
    phone: bp.support_phone || ind.phone || undefined,
    address: [a.line1, a.line2].filter(Boolean).join(', ') || undefined,
    town: a.city || undefined,
    zip: a.postal_code || undefined,
    url: bp.url || undefined,
  };
}

export async function runStripe(ctx: StageContext): Promise<StageResult> {
  const stage = 'stripe';
  const key = ctx.env.STRIPE_SECRET_KEY;
  if (ctx.dryRun) {
    return {
      stage, status: 'DONE', detail: `dry run: ${SPACES.length} payment links validated (no network)`,
      items: SPACES.map((s) => ({ key: s.key, state: 'WOULD_CREATE' as const, note: `$${(s.amountCents / 100).toFixed(2)} · ${s.name}` })),
    };
  }
  if (!key) {
    return {
      stage, status: 'NEEDS_OWNER', items: [],
      detail: 'No Stripe key yet.',
      ownerAction: 'Create the Stripe account and finish its identity + bank verification, then save its secret key (Developers → API keys → Secret key, sk_live_…) as the GitHub secret STRIPE_SECRET_KEY.',
    };
  }
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) ctx.log('stripe: TEST key — links will be test-mode links');
  const account = await call(ctx, key, 'GET', '/account');
  if (!account.charges_enabled && !key.includes('_test_')) {
    const due: string[] = account.requirements?.currently_due ?? [];
    return {
      stage, status: 'NEEDS_OWNER', items: [],
      detail: `Stripe account cannot take charges yet${due.length ? ` (Stripe still needs: ${due.join(', ')})` : ''}.`,
      ownerAction: 'Finish Stripe activation (identity, bank account, public business details incl. support phone and address).',
    };
  }

  const products = await listAll(ctx, key, '/products?active=true');
  const links = await listAll(ctx, key, '/payment_links?active=true');
  const items: StageResult['items'] = [];
  const out: Array<{ key: string; name: string; amount: number; url: string }> = [];
  for (const s of SPACES) {
    try {
      let product = products.find((p) => p.metadata?.brain_launch === s.key);
      if (!product) {
        product = await call(ctx, key, 'POST', '/products', { name: s.name, 'metadata[brain_launch]': s.key, tax_code: 'txcd_99999999' }, `${s.key}:product`);
      }
      const prices = await call(ctx, key, 'GET', `/prices?lookup_keys[]=${encodeURIComponent(s.key)}&active=true`);
      let price = (prices.data ?? []).find((p: Json) => p.unit_amount === s.amountCents && p.currency === 'usd');
      if (!price) {
        price = await call(ctx, key, 'POST', '/prices', {
          product: product.id, currency: 'usd', unit_amount: s.amountCents, lookup_key: s.key, transfer_lookup_key: true, 'metadata[brain_launch]': s.key,
        }, `${s.key}:price:${s.amountCents}`);
      }
      const existing = links.find((l) => l.metadata?.brain_launch === s.key);
      if (existing) {
        items.push({ key: s.key, state: 'EXISTS', url: existing.url });
        out.push({ key: s.key, name: s.name, amount: s.amountCents / 100, url: existing.url });
        continue;
      }
      const link = await call(ctx, key, 'POST', '/payment_links', {
        'line_items[0][price]': price.id,
        'line_items[0][quantity]': 1,
        'metadata[brain_launch]': s.key,
        'after_completion[type]': 'hosted_confirmation',
        'after_completion[hosted_confirmation][custom_message]': CONFIRMATION,
        'phone_number_collection[enabled]': true,
        'custom_fields[0][key]': 'business',
        'custom_fields[0][label][type]': 'custom',
        'custom_fields[0][label][custom]': 'Business name (as on the ad)',
        'custom_fields[0][type]': 'text',
        'custom_fields[1][key]': 'category',
        'custom_fields[1][label][type]': 'custom',
        'custom_fields[1][label][custom]': 'Business category',
        'custom_fields[1][type]': 'text',
      }, `${s.key}:link`);
      items.push({ key: s.key, state: 'CREATED', url: link.url });
      out.push({ key: s.key, name: s.name, amount: s.amountCents / 100, url: link.url });
    } catch (e) {
      items.push({ key: s.key, state: 'FAILED', note: (e as Error).message });
    }
  }

  const contact = contactFromAccount(account);
  const dir = path.join(ctx.root, '.launch-out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stripe-links.json'), JSON.stringify({ links: out, contact }, null, 2));
  const failed = items.filter((i) => i.state === 'FAILED').length;
  return {
    stage,
    status: failed === 0 ? 'DONE' : failed === SPACES.length ? 'FAILED' : 'PARTIAL',
    detail: `${out.length}/${SPACES.length} payment links live${failed ? `, ${failed} failed` : ''}.`,
    items,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  runStripe({ env: process.env, dryRun: mode !== 'run', fetch, log: console.log, root })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'FAILED' ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
