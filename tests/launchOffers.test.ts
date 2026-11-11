import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOffers, runOffers } from '../scripts/launch/offers.ts';

function fakeStripe(account: Record<string, unknown>) {
  const db = { products: [] as any[], prices: [] as any[], links: [] as any[] };
  const idem = new Map<string, unknown>();
  let n = 0;
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    const key = (init.headers as Record<string, string>)['Idempotency-Key'];
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (key && idem.has(key)) return ok(idem.get(key));
    const meta = (b: Record<string, string>) => ({ brain_launch: b['metadata[brain_launch]'] });
    let made: any;
    switch (`${method} ${u.pathname}`) {
      case 'GET /v1/account': return ok(account);
      case 'GET /v1/products': return ok({ data: db.products, has_more: false });
      case 'GET /v1/payment_links': return ok({ data: db.links, has_more: false });
      case 'GET /v1/prices': {
        const keys = u.searchParams.getAll('lookup_keys[]');
        return ok({ data: db.prices.filter((p) => keys.includes(p.lookup_key)) });
      }
      case 'POST /v1/products': made = { id: `prod_${++n}`, name: body.name, metadata: meta(body) }; db.products.push(made); break;
      case 'POST /v1/prices': made = { id: `price_${++n}`, unit_amount: Number(body.unit_amount), currency: body.currency, lookup_key: body.lookup_key, recurring: body['recurring[interval]'] ?? null }; db.prices.push(made); break;
      case 'POST /v1/payment_links': made = { id: `plink_${++n}`, url: `https://buy.stripe.com/test_${n}`, metadata: meta(body) }; db.links.push(made); break;
      default: return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 });
    }
    if (key) idem.set(key, made);
    return ok(made);
  }) as unknown as typeof fetch;
  return { db, calls, fetchImpl };
}

function rootWithOffers(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offers-'));
  const dir = path.join(root, 'businesses', 'example-biz');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'offer.json'), JSON.stringify([
    { key: 'report', name: 'Example Report', price_usd: 149, description: 'one report', recurring: null },
    { key: 'monthly', name: 'Example Monthly', price_usd: 49, description: 'monthly update', recurring: 'month' },
  ]));
  return root;
}

describe('launch: expansion offers', () => {
  it('reads every business offer, and refuses one without a price', () => {
    const root = rootWithOffers();
    expect(readOffers(root).map((o) => `${o.business}:${o.key}:${o.recurring}`)).toEqual(['example-biz:report:null', 'example-biz:monthly:month']);
    fs.writeFileSync(path.join(root, 'businesses', 'example-biz', 'offer.json'), JSON.stringify([{ key: 'x', name: 'X' }]));
    expect(() => readOffers(root)).toThrow(/positive price_usd/);
  });

  it('waits for the owner\'s key and calls nothing', async () => {
    const s = fakeStripe({ charges_enabled: true });
    const r = await runOffers({ env: {}, dryRun: false, fetch: s.fetchImpl, log: () => {}, root: rootWithOffers() });
    expect(r.status).toBe('NEEDS_OWNER');
    expect(s.calls).toHaveLength(0);
  });

  it('creates one link per offer, a monthly price for a subscription, and nothing twice', async () => {
    const s = fakeStripe({ charges_enabled: true });
    const root = rootWithOffers();
    const ctx = { env: { STRIPE_SECRET_KEY: 'sk_live_x' }, dryRun: false, fetch: s.fetchImpl, log: () => {}, root };
    const first = await runOffers(ctx);
    expect(first.status).toBe('DONE');
    expect(first.items.map((i) => i.state)).toEqual(['CREATED', 'CREATED']);
    expect(s.db.prices.map((p) => [p.unit_amount, p.recurring])).toEqual([[14900, null], [4900, 'month']]);
    const second = await runOffers(ctx);
    expect(second.items.map((i) => i.state)).toEqual(['EXISTS', 'EXISTS']);
    expect(s.db.links).toHaveLength(2);
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.launch-out', 'offer-links.json'), 'utf8'));
    expect(saved.links).toHaveLength(2);
  });
});
