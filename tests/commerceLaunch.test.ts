/**
 * Selling a qualified product (§74), walked against fake Shopify, CJ and Meta
 * providers at the network boundary.
 *
 * What is real: the effects engine, the commercial authority and its ceilings,
 * the commitments, the ledger, the launch rows and every guard. What is fake:
 * the three providers' HTTP answers, so the walk can run without accounts.
 *
 * The properties pinned are the ones that cost money if wrong:
 *
 *   - nothing reaches outside without the connection AND the grant, and the
 *     blocker names exactly what to set or grant;
 *   - a retry, a second pass or a lost answer never lists twice, starts a
 *     second campaign, or buys a unit twice;
 *   - an ad test is committed against the grant before anything is created,
 *     and is paused once it has spent its stop amount with no order;
 *   - a paid order is bought and shipped even when the programme is paused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createAuthority, listCommitments } from '../server/repos/cashAuthority.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { createCommerceProduct, recordCommerceFact } from '../server/repos/commerce.ts';
import { listAdTests, listLaunches, listOrders } from '../server/repos/commerceLaunch.ts';
import { moveCommerceProgramme, startCommerceProgramme } from '../server/services/commerce/programme.ts';
import { runCommerceLaunch, CONNECT_STORE, CONNECT_SUPPLIER } from '../server/services/commerce/launch.ts';
import { commerceView } from '../server/services/commerce/view.ts';
import { registerCommerceProviders } from '../server/services/commerce/connect/register.ts';
import { setCommerceFetch } from '../server/services/commerce/connect/http.ts';
import { resetCjToken, setCjSpacing } from '../server/services/commerce/connect/cj.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CommerceFinding } from '../server/domain/types.ts';

const ENV: Record<string, string> = {
  BRAIN_STORE_PROVIDER: 'shopify',
  SHOPIFY_STORE_DOMAIN: 'brain-test.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_test_token',
  BRAIN_SUPPLIER_PROVIDER: 'cj',
  CJ_API_KEY: 'cj-test-key',
  BRAIN_ADS_PROVIDER: 'meta',
  META_ACCESS_TOKEN: 'meta-test-token',
  META_AD_ACCOUNT_ID: '1234567',
  META_PAGE_ID: '7654321',
  BRAIN_ADS_DAILY_BUDGET_CENTS: '1000',
};

let projectId = '';
let userId = '';

/* --------------------------------------------------------------------------
 * The fake providers
 * ------------------------------------------------------------------------ */

interface Fake {
  shopify: {
    products: Map<string, { id: string; variantId: string }>;
    productSetCalls: number;
    published: Set<string>;
    orders: { id: string; name: string; totalCents: number; variantId: string; quantity: number }[];
    fulfilled: Set<string>;
  };
  cj: { orders: Map<string, { orderId: string; tracking: string | null }>; createCalls: number; failNextCreate: 'UNKNOWN' | null };
  meta: {
    objects: { id: string; edge: string; name: string; status: string }[];
    createCalls: number;
    spendCents: number;
  };
}

let fake: Fake;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function install(): void {
  fake = {
    shopify: { products: new Map(), productSetCalls: 0, published: new Set(), orders: [], fulfilled: new Set() },
    cj: { orders: new Map(), createCalls: 0, failNextCreate: null },
    meta: { objects: [], createCalls: 0, spendCents: 0 },
  };
  setCommerceFetch(async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    if (url.includes('myshopify.com')) return shopify(JSON.parse(body));
    if (url.includes('cjdropshipping.com')) return cj(url, body ? JSON.parse(body) : {});
    if (url.includes('graph.facebook.com')) return meta(url, init.method ?? 'GET', body);
    return json({}, 404);
  });
}

function shopify(req: { query: string; variables: any }): Response {
  const q = req.query;
  if (q.includes('productSet')) {
    fake.shopify.productSetCalls += 1;
    const handle = req.variables.input.handle;
    const existing = fake.shopify.products.get(handle);
    const product = existing ?? { id: `gid://shopify/Product/${fake.shopify.products.size + 1}`, variantId: `gid://shopify/ProductVariant/${fake.shopify.products.size + 1}` };
    fake.shopify.products.set(handle, product);
    return json({ data: { productSet: { product: { id: product.id, handle, variants: { nodes: [{ id: product.variantId }] } }, userErrors: [] } } });
  }
  if (q.includes('productByIdentifier')) {
    const product = fake.shopify.products.get(req.variables.identifier.handle);
    return json({ data: { productByIdentifier: product ? { id: product.id, handle: req.variables.identifier.handle, variants: { nodes: [{ id: product.variantId }] } } : null } });
  }
  if (q.includes('publications(')) return json({ data: { publications: { nodes: [{ id: 'gid://shopify/Publication/1', name: 'Online Store' }] } } });
  if (q.includes('publishablePublish')) {
    fake.shopify.published.add(req.variables.id);
    return json({ data: { publishablePublish: { userErrors: [] } } });
  }
  if (q.includes('brainOrders')) {
    return json({
      data: {
        orders: {
          nodes: fake.shopify.orders
            .filter((one) => !fake.shopify.fulfilled.has(one.id))
            .map((one) => ({
              id: one.id,
              name: one.name,
              createdAt: new Date().toISOString(),
              currentTotalPriceSet: { shopMoney: { amount: (one.totalCents / 100).toFixed(2), currencyCode: 'USD' } },
              lineItems: { nodes: [{ quantity: one.quantity, variant: { id: one.variantId } }] },
            })),
        },
      },
    });
  }
  if (q.includes('brainOrderAddress')) {
    return json({
      data: {
        order: {
          email: 'buyer@example.test',
          shippingAddress: {
            name: 'A Buyer', address1: '1 Main St', address2: null, city: 'Detroit', province: 'Michigan',
            provinceCode: 'MI', country: 'United States', countryCodeV2: 'US', zip: '48201', phone: null,
          },
        },
      },
    });
  }
  if (q.includes('brainFulfilmentOrders')) {
    const done = fake.shopify.fulfilled.has(req.variables.id);
    return json({ data: { order: { fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: done ? 'CLOSED' : 'OPEN' }] } } } });
  }
  if (q.includes('brainFulfil')) {
    const order = fake.shopify.orders[0]!;
    fake.shopify.fulfilled.add(order.id);
    return json({ data: { fulfillmentCreate: { fulfillment: { id: 'f1' }, userErrors: [] } } });
  }
  return json({ errors: [{ message: 'unknown query' }] });
}

function cj(url: string, body: any): Response {
  const ok = (data: unknown) => json({ code: 200, result: true, message: 'ok', data });
  if (url.includes('getAccessToken')) return ok({ accessToken: 'cj-token', accessTokenExpiryDate: '2099-01-01T00:00:00Z' });
  if (url.includes('product/listV2')) {
    return ok({ content: [{ productList: [{ id: 'pid-1', nameEn: 'Adjustable Posture Corrector Brace for Women Men', bigImage: 'https://cj.example/img.jpg', sellPrice: '6.50' }] }] });
  }
  if (url.includes('product/query')) {
    return ok({ pid: 'pid-1', productImageSet: ['https://cj.example/img.jpg'], variants: [{ vid: 'vid-1', variantSellPrice: 6.5, variantImage: 'https://cj.example/v.jpg' }] });
  }
  if (url.includes('freightCalculate')) {
    return ok([
      { logisticName: 'CJPacket Ordinary', logisticPrice: 3.2, logisticAging: '7-12' },
      { logisticName: 'Slow Post', logisticPrice: 1.0, logisticAging: '25-40' },
    ]);
  }
  if (url.includes('createOrderV2')) {
    fake.cj.createCalls += 1;
    if (fake.cj.failNextCreate === 'UNKNOWN') {
      fake.cj.failNextCreate = null;
      // The order was taken and the answer was lost.
      fake.cj.orders.set(body.orderNumber, { orderId: `cj-${body.orderNumber}`, tracking: null });
      return json({ message: 'gateway timeout' }, 504);
    }
    fake.cj.orders.set(body.orderNumber, { orderId: `cj-${body.orderNumber}`, tracking: null });
    return ok({ orderId: `cj-${body.orderNumber}`, actualPayment: 9.7 });
  }
  if (url.includes('getOrderDetail')) {
    const number = decodeURIComponent(new URL(url).searchParams.get('orderId') ?? '');
    const order = fake.cj.orders.get(number);
    if (!order) return json({ code: 1600200, result: false, message: 'not found', data: null });
    return ok({ orderId: order.orderId, orderStatus: order.tracking ? 'SHIPPED' : 'UNSHIPPED', trackNumber: order.tracking, logisticName: 'CJPacket Ordinary', orderAmount: 9.7 });
  }
  return json({ code: 1600100, result: false, message: 'Param error' });
}

function meta(url: string, method: string, body: string): Response {
  const path = new URL(url).pathname.replace(/^\/v24\.0\//, '');
  const params = new URLSearchParams(method === 'GET' ? new URL(url).search : body);
  const [first, edge] = path.split('/');
  if (first?.startsWith('act_') && method === 'GET' && edge) {
    const filter = JSON.parse(params.get('filtering') ?? '[]')[0];
    return json({ data: fake.meta.objects.filter((one) => one.edge === edge && (!filter || one.name === filter.value)).map((one) => ({ id: one.id, name: one.name })) });
  }
  if (first?.startsWith('act_') && method === 'POST' && edge) {
    fake.meta.createCalls += 1;
    const id = `${edge}-${fake.meta.objects.length + 1}`;
    fake.meta.objects.push({ id, edge, name: params.get('name') ?? '', status: params.get('status') ?? 'PAUSED' });
    return json({ id });
  }
  if (edge === 'insights') return json({ data: [{ spend: (fake.meta.spendCents / 100).toFixed(2) }] });
  const object = fake.meta.objects.find((one) => one.id === first);
  if (!object) return json({ error: { type: 'OAuthException', code: 100 } }, 400);
  if (method === 'POST') {
    object.status = params.get('status') ?? object.status;
    return json({ success: true });
  }
  return json({ id: object.id, status: object.status });
}

/* --------------------------------------------------------------------------
 * Setup
 * ------------------------------------------------------------------------ */

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `launch-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
  clearAdapters();
  registerCommerceProviders();
  setCjSpacing(0);
  resetCjToken();
  install();

  await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  const started = await startCommerceProgramme({
    projectId,
    actorUserId: userId,
    objective: 'Find generic products selling now that one order can pay to advertise.',
  });
  expect(started.ok).toBe(true);
  await qualifiedProduct();
});

afterEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  clearAdapters();
  setCommerceFetch(null);
  setCjSpacing(1100);
});

async function qualifiedProduct(): Promise<void> {
  const { product } = await createCommerceProduct({ projectId, name: 'Posture corrector brace', note: 'test', origin: 'SEED' });
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  const fact = async (finding: CommerceFinding, subject: string, extra: Record<string, unknown> = {}) => {
    n += 1;
    await recordCommerceFact({
      projectId,
      productId: product.id,
      finding,
      subject,
      value: null,
      amountCents: null,
      rateBps: null,
      currency: null,
      days: null,
      statement: 'published',
      publisher: subject,
      observedOn: today,
      sourceClaimId: `clm_launch_${n}`,
      ...extra,
    } as Parameters<typeof recordCommerceFact>[0]);
  };
  await fact('PRODUCT_DEMAND', 'Amazon', { value: 'BESTSELLER_RANK' });
  await fact('PRODUCT_DEMAND', 'TikTok', { value: 'ORDER_COUNT' });
  await fact('SUPPLIER_OFFER', 'CJ Dropshipping', { amountCents: 800, currency: 'USD', days: 9 });
  await fact('RETAIL_PRICE', 'A storefront', { amountCents: 3999, currency: 'USD' });
  await fact('COST_LINE', 'Stripe', { value: 'PAYMENT_PROCESSING', rateBps: 290 });
  await fact('COST_LINE', 'CJ', { value: 'SHIPPING_TO_CUSTOMER', amountCents: 400, currency: 'USD' });
}

async function grant(actions: string[]): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Selling',
    allowedActions: actions,
    prohibitions: [],
    maxCommittedCents: 20_000,
    maxPerActionCents: 5_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/* --------------------------------------------------------------------------
 * The walk
 * ------------------------------------------------------------------------ */

describe('nothing reaches outside without the connection and the grant', () => {
  it('names the grant it is missing, and lists nothing', async () => {
    const pass = await runCommerceLaunch(projectId);
    expect(pass.lines[0]!.blocker).toContain('LIST_PRODUCT');
    expect(fake.shopify.productSetCalls).toBe(0);
    // The supplier match is a read, and it happened.
    expect((await listLaunches(projectId))[0]!.supplierVariantId).toBe('vid-1');
  });

  it('names the setting that is missing when the store is not connected', async () => {
    delete process.env.SHOPIFY_ADMIN_TOKEN;
    await grant(['LIST_PRODUCT', 'RUN_ADS', 'FULFIL_ORDER']);
    const pass = await runCommerceLaunch(projectId);
    expect(pass.lines[0]!.blocker).toBe(CONNECT_STORE);
    const view = await commerceView(projectId);
    expect(view.connections.find((one) => one.capability === 'A storefront')!.needs).toContain('SHOPIFY_ADMIN_TOKEN');
  });

  it('names the supplier when nothing can be matched without it', async () => {
    delete process.env.CJ_API_KEY;
    const pass = await runCommerceLaunch(projectId);
    expect(pass.lines[0]!.blocker).toBe(CONNECT_SUPPLIER);
  });
});

describe('a qualified product is listed, advertised, sold and shipped', () => {
  it('walks the whole way, once, and every figure lands in the ledger', async () => {
    await grant(['LIST_PRODUCT', 'RUN_ADS', 'FULFIL_ORDER']);

    // Pass 1: match, list, publish, start the ad test.
    await runCommerceLaunch(projectId);
    await runCommerceLaunch(projectId);
    const [launch] = await listLaunches(projectId);
    expect(launch!.storeProductId).toBe('gid://shopify/Product/1');
    expect(launch!.publishedAt).not.toBe(null);
    expect(launch!.priceCents).toBe(3999);
    const [test] = await listAdTests(projectId);
    expect(test!.state).toBe('RUNNING');
    expect(test!.commitmentId).not.toBe(null);
    // Built paused and switched on last: every object is ACTIVE now.
    expect(fake.meta.objects.filter((one) => one.edge !== 'adcreatives').every((one) => one.status === 'ACTIVE')).toBe(true);

    // More passes create nothing twice.
    await runCommerceLaunch(projectId);
    expect(fake.shopify.productSetCalls).toBe(1);
    expect(fake.meta.createCalls).toBe(4);

    // A customer pays.
    fake.shopify.orders.push({ id: 'gid://shopify/Order/1', name: '#1001', totalCents: 3999, variantId: launch!.storeVariantId!, quantity: 1 });
    const sold = await runCommerceLaunch(projectId);
    expect(sold.ordersSeen).toBe(1);
    expect(sold.ordersPlaced).toBe(1);
    expect(fake.cj.createCalls).toBe(1);

    // CJ ships; the store is told.
    for (const order of fake.cj.orders.values()) order.tracking = 'TRACK123';
    const shipped = await runCommerceLaunch(projectId);
    expect(shipped.ordersShipped).toBe(1);
    const [order] = await listOrders(projectId);
    expect(order!.state).toBe('FULFILLED');
    expect(order!.trackingNumber).toBe('TRACK123');

    // Nothing is bought twice however many passes run.
    await runCommerceLaunch(projectId);
    expect(fake.cj.createCalls).toBe(1);

    const entries = await listMoneyEntries({ projectId });
    expect(entries.filter((one) => one.kind === 'CUSTOMER_PAYMENT').map((one) => one.amountCents)).toEqual([3999]);
    expect(entries.filter((one) => one.kind === 'COST').map((one) => one.amountCents)).toEqual([970]);
  });

  it('pauses an ad test that spent its stop amount with no order, and records the spend', async () => {
    await grant(['LIST_PRODUCT', 'RUN_ADS', 'FULFIL_ORDER']);
    await runCommerceLaunch(projectId);
    await runCommerceLaunch(projectId);
    // Two acquisition budgets with nothing sold.
    fake.meta.spendCents = 6000;
    await runCommerceLaunch(projectId);
    const [test] = await listAdTests(projectId);
    expect(test!.state).toBe('STOPPED');
    expect(test!.outcome).toBe('LOST');
    expect(fake.meta.objects.find((one) => one.edge === 'campaigns')!.status).toBe('PAUSED');
    const entries = await listMoneyEntries({ projectId });
    expect(entries.filter((one) => one.kind === 'COST').map((one) => one.amountCents)).toEqual([6000]);
    const commitments = await listCommitments(projectId);
    expect(commitments.every((one) => one.state !== 'HELD')).toBe(true);
    // A lost test stops the launch, so no second test starts.
    await runCommerceLaunch(projectId);
    expect((await listAdTests(projectId)).length).toBe(1);
  });

  it('refuses an ad test the grant’s ceilings do not cover, and creates nothing', async () => {
    process.env.BRAIN_ADS_DAILY_BUDGET_CENTS = '5000';
    await grant(['LIST_PRODUCT', 'RUN_ADS', 'FULFIL_ORDER']);
    await runCommerceLaunch(projectId);
    const pass = await runCommerceLaunch(projectId);
    expect(pass.lines[0]!.blocker).toContain('does not fit the standing authority');
    expect(fake.meta.createCalls).toBe(0);
  });

  it('asks the supplier after a lost answer instead of buying the unit twice', async () => {
    await grant(['LIST_PRODUCT', 'FULFIL_ORDER']);
    await runCommerceLaunch(projectId);
    await runCommerceLaunch(projectId);
    const [launch] = await listLaunches(projectId);
    fake.shopify.orders.push({ id: 'gid://shopify/Order/2', name: '#1002', totalCents: 3999, variantId: launch!.storeVariantId!, quantity: 1 });
    fake.cj.failNextCreate = 'UNKNOWN';
    // The engine asks CJ about the lost answer and finds the order it took.
    await runCommerceLaunch(projectId);
    await runCommerceLaunch(projectId);
    expect(fake.cj.createCalls).toBe(1);
    expect((await listOrders(projectId))[0]!.state).toBe('ORDERED');
    expect((await listOrders(projectId))[0]!.supplierOrderId).toMatch(/^cj-BRN/);
  });

  it('still buys and ships a paid order while the programme is paused', async () => {
    await grant(['LIST_PRODUCT', 'FULFIL_ORDER']);
    await runCommerceLaunch(projectId);
    await runCommerceLaunch(projectId);
    const [launch] = await listLaunches(projectId);
    await moveCommerceProgramme({ projectId, actorUserId: userId, to: 'PAUSED' });
    fake.shopify.orders.push({ id: 'gid://shopify/Order/3', name: '#1003', totalCents: 3999, variantId: launch!.storeVariantId!, quantity: 1 });
    const pass = await runCommerceLaunch(projectId);
    expect(pass.ordersPlaced).toBe(1);
  });
});
