import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPACES, contactFromAccount, runStripe } from '../scripts/launch/stripe.ts';
import { fill, runMailer } from '../scripts/launch/mailer.ts';

/** A small in-memory Stripe: products, prices (lookup keys), payment links, idempotency. */
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
      case 'POST /v1/prices': made = { id: `price_${++n}`, product: body.product, unit_amount: Number(body.unit_amount), currency: body.currency, lookup_key: body.lookup_key }; db.prices.push(made); break;
      case 'POST /v1/payment_links': made = { id: `plink_${++n}`, url: `https://buy.stripe.com/test_${n}`, metadata: meta(body), body }; db.links.push(made); break;
      default: return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 });
    }
    if (key) idem.set(key, made);
    return ok(made);
  }) as unknown as typeof fetch;
  return { db, calls, fetchImpl };
}

const ACCOUNT = {
  charges_enabled: true,
  email: 'owner@example.com',
  business_profile: { name: 'Pat Example', support_phone: '+17175550100', support_email: 'pat@example.com', support_address: { line1: '1 Main St', city: 'Camp Hill', postal_code: '17011' } },
};

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  return root;
}

describe('launch: Stripe payment links', () => {
  it('asks the owner for the key when there is none, and calls nothing', async () => {
    const s = fakeStripe(ACCOUNT);
    const r = await runStripe({ env: {}, dryRun: false, fetch: s.fetchImpl, log: () => {}, root: tmpRoot() });
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toMatch(/STRIPE_SECRET_KEY/);
    expect(s.calls).toHaveLength(0);
  });

  it('waits for activation when the account cannot take charges', async () => {
    const s = fakeStripe({ charges_enabled: false, requirements: { currently_due: ['individual.id_number'] } });
    const r = await runStripe({ env: { STRIPE_SECRET_KEY: 'sk_live_x' }, dryRun: false, fetch: s.fetchImpl, log: () => {}, root: tmpRoot() });
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.detail).toMatch(/individual.id_number/);
    expect(s.db.links).toHaveLength(0);
  });

  it('creates 8 links once, then finds them on every later run', async () => {
    const s = fakeStripe(ACCOUNT);
    const root = tmpRoot();
    const ctx = { env: { STRIPE_SECRET_KEY: 'sk_live_x' }, dryRun: false, fetch: s.fetchImpl, log: () => {}, root };
    const first = await runStripe(ctx);
    expect(first.status).toBe('DONE');
    expect(first.items.filter((i) => i.state === 'CREATED')).toHaveLength(8);
    expect(s.db.prices.map((p) => p.unit_amount).sort((a, b) => a - b)).toEqual(SPACES.map((x) => x.amountCents).sort((a, b) => a - b));
    expect(s.db.links[0].body['phone_number_collection[enabled]']).toBe('true');

    const second = await runStripe(ctx);
    expect(second.items.every((i) => i.state === 'EXISTS')).toBe(true);
    expect(s.db.products).toHaveLength(8);
    expect(s.db.links).toHaveLength(8);

    const saved = JSON.parse(fs.readFileSync(path.join(root, '.launch-out', 'stripe-links.json'), 'utf8'));
    expect(saved.links).toHaveLength(8);
    expect(saved.contact).toMatchObject({ name: 'Pat Example', phone: '+17175550100', town: 'Camp Hill', zip: '17011' });
  });
});

describe('launch: mailer materials', () => {
  it('fills every placeholder spelling from the Stripe contact', () => {
    const c = contactFromAccount(ACCOUNT);
    const r = fill("[Owner's full legal name], of [mailing address], [Town], PA [ZIP] · [phone] · [owner email] · [first name]", c);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe('Pat Example, of 1 Main St, Camp Hill, PA 17011 · +17175550100 · pat@example.com · [first name]');
  });

  it('reports the placeholders Stripe cannot fill instead of guessing them', () => {
    const r = fill('[phone] and [Town]', { name: 'Pat' });
    expect(r.missing.sort()).toEqual(['[Town]', '[phone]']);
  });

  it('dry run covers every placeholder in the real kit', async () => {
    const r = await runMailer({ env: {}, dryRun: true, fetch, log: () => {}, root: path.resolve(__dirname, '..') });
    expect(r.status).toBe('DONE');
  });
});
