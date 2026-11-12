/**
 * Offers stage of the launch runner: a Stripe Payment Link for every product
 * the expansion businesses sell (`businesses/<name>/offer.json`).
 *
 * Same contract as the mailer's links (`stripe.ts`): nothing happens until the
 * owner's Stripe account can take charges; every object carries
 * `metadata[brain_launch]=<business>:<key>`, prices carry a lookup key, and each
 * create sends an Idempotency-Key, so the hourly run creates each link once.
 * A product with `recurring: "month"` gets a monthly price (a subscription link).
 *
 *   npx tsx scripts/launch/offers.ts dry-run | run
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types.ts';
import { call, listAll } from './stripe.ts';

export interface Offer { business: string; key: string; name: string; priceUsd: number; description: string; recurring: 'month' | null }

export function readOffers(root: string): Offer[] {
  const dir = path.join(root, 'businesses');
  if (!fs.existsSync(dir)) return [];
  const out: Offer[] = [];
  for (const business of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, business, 'offer.json');
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const list = (Array.isArray(raw) ? raw : (raw as { products?: unknown[] }).products ?? []) as Array<Record<string, unknown>>;
    for (const p of list) {
      const price = Number(p.price_usd);
      if (!p.key || !p.name || !Number.isFinite(price) || price < 0) throw new Error(`${business}/offer.json: product needs key, name and a price_usd of 0 or more`);
      if (price === 0) continue; // a free sample is sent, not sold: it needs no payment link
      out.push({
        business, key: String(p.key), name: String(p.name), priceUsd: price,
        description: String(p.description ?? ''), recurring: p.recurring === 'month' ? 'month' : null,
      });
    }
  }
  return out;
}

const lookupKey = (o: Offer) => `${o.business}:${o.key}`.replace(/[^a-zA-Z0-9:_-]/g, '-');

export async function runOffers(ctx: StageContext): Promise<StageResult> {
  const stage = 'offers';
  const offers = readOffers(ctx.root);
  if (ctx.dryRun) {
    return {
      stage, status: 'DONE', detail: `dry run: ${offers.length} offer links validated (no network)`,
      items: offers.map((o) => ({ key: lookupKey(o), state: 'WOULD_CREATE' as const, note: `$${o.priceUsd.toFixed(2)}${o.recurring ? '/mo' : ''} · ${o.name}` })),
    };
  }
  const key = ctx.env.STRIPE_SECRET_KEY;
  if (!key) {
    return {
      stage, status: 'NEEDS_OWNER', items: [], detail: `No Stripe key yet; ${offers.length} offer links wait for it.`,
      ownerAction: 'The same Stripe secret key as the mailer (GitHub secret STRIPE_SECRET_KEY) also opens the expansion businesses\' payment links.',
    };
  }
  const account = await call(ctx, key, 'GET', '/account');
  if (!account.charges_enabled && !key.includes('_test_')) {
    return { stage, status: 'NEEDS_OWNER', items: [], detail: 'Stripe account cannot take charges yet.', ownerAction: 'Finish Stripe activation.' };
  }
  const products = await listAll(ctx, key, '/products?active=true');
  const links = await listAll(ctx, key, '/payment_links?active=true');
  const items: StageResult['items'] = [];
  const out: Array<{ business: string; key: string; name: string; amount: number; recurring: string | null; url: string }> = [];
  for (const o of offers) {
    const k = lookupKey(o);
    const cents = Math.round(o.priceUsd * 100);
    try {
      let product = products.find((p) => p.metadata?.brain_launch === k);
      if (!product) {
        product = await call(ctx, key, 'POST', '/products', {
          name: o.name, ...(o.description ? { description: o.description.slice(0, 500) } : {}), 'metadata[brain_launch]': k, tax_code: 'txcd_10000000',
        }, `${k}:product`);
      }
      const prices = await call(ctx, key, 'GET', `/prices?lookup_keys[]=${encodeURIComponent(k)}&active=true`);
      let price = (prices.data ?? []).find((p: Record<string, any>) => p.unit_amount === cents && p.currency === 'usd');
      if (!price) {
        price = await call(ctx, key, 'POST', '/prices', {
          product: product.id, currency: 'usd', unit_amount: cents, lookup_key: k, transfer_lookup_key: true, 'metadata[brain_launch]': k,
          ...(o.recurring ? { 'recurring[interval]': o.recurring } : {}),
        }, `${k}:price:${cents}:${o.recurring ?? 'once'}`);
      }
      const existing = links.find((l) => l.metadata?.brain_launch === k);
      if (existing) {
        items.push({ key: k, state: 'EXISTS', url: existing.url });
        out.push({ business: o.business, key: o.key, name: o.name, amount: o.priceUsd, recurring: o.recurring, url: existing.url });
        continue;
      }
      const link = await call(ctx, key, 'POST', '/payment_links', {
        'line_items[0][price]': price.id,
        'line_items[0][quantity]': 1,
        'metadata[brain_launch]': k,
        'after_completion[type]': 'hosted_confirmation',
        'after_completion[hosted_confirmation][custom_message]': 'Thank you. Your order is in, and it will arrive by email at the address you gave.',
        'custom_fields[0][key]': 'organization',
        'custom_fields[0][label][type]': 'custom',
        'custom_fields[0][label][custom]': 'Business or organization name',
        'custom_fields[0][type]': 'text',
      }, `${k}:link`);
      items.push({ key: k, state: 'CREATED', url: link.url });
      out.push({ business: o.business, key: o.key, name: o.name, amount: o.priceUsd, recurring: o.recurring, url: link.url });
    } catch (e) {
      items.push({ key: k, state: 'FAILED', note: (e as Error).message });
    }
  }
  const dir = path.join(ctx.root, '.launch-out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'offer-links.json'), JSON.stringify({ links: out }, null, 2));
  const failed = items.filter((i) => i.state === 'FAILED').length;
  return {
    stage, status: failed === 0 ? 'DONE' : failed === offers.length ? 'FAILED' : 'PARTIAL',
    detail: `${out.length}/${offers.length} offer payment links live${failed ? `, ${failed} failed` : ''}.`, items,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  runOffers({ env: process.env, dryRun: mode !== 'run', fetch, log: console.log, root })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'FAILED' ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
