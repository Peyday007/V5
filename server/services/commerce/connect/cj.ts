/**
 * CJ Dropshipping (§74): find the exact item to sell, quote shipping to the
 * customer, buy the unit a customer has already paid for, and read its
 * tracking.
 *
 * API 2.0. An API key from the CJ account is exchanged for an access token
 * (`authentication/getAccessToken`), sent as `CJ-Access-Token`. CJ allows one
 * call per second, so every call here goes through one queue.
 *
 * A supplier order is created with `createOrderV2` and `payType: 2`, which
 * pays from the CJ wallet balance in the same call. Its `orderNumber` is
 * Brain's own id, and `getOrderDetail` accepts that id, so the order is
 * reconcilable: after an unknown outcome Brain asks CJ instead of buying the
 * unit twice.
 */
import type {
  AdapterHealth,
  EffectAdapter,
  EffectRequest,
  ReconcileOutcome,
  SendOutcome,
} from '../../effects/adapter.ts';
import { CJ_KEY_ENV, cjSandbox, secret, supplierConfig } from './config.ts';
import { request, type ProviderAnswer } from './http.ts';

export const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
export const CJ_ORDER_ADAPTER = 'cj.place_order';
/** Where CJ ships most catalogue items from; a quote from elsewhere is asked for explicitly. */
export const CJ_FROM_COUNTRY = 'CN';

let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;
let spacingMs = 1100;

/** Tests only. */
export function setCjSpacing(ms: number): void {
  spacingMs = ms;
}

function throttled<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const wait = lastCall + spacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    return await work();
  });
  queue = next.catch(() => undefined);
  return next;
}

let token: { value: string; expiresAt: number; forKey: string } | null = null;

/** Tests only: forget the cached token. */
export function resetCjToken(): void {
  token = null;
}

async function accessToken(): Promise<string | null> {
  const key = secret(CJ_KEY_ENV);
  if (!key) return null;
  if (token && token.forKey === key && token.expiresAt > Date.now() + 60_000) return token.value;
  const answer = await throttled(() =>
    request({
      url: `${CJ_API}/authentication/getAccessToken`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    }),
  );
  if (answer.kind !== 'OK' || answer.body.result === false) return null;
  const data = (answer.body.data ?? {}) as Record<string, unknown>;
  const value = typeof data.accessToken === 'string' ? data.accessToken : null;
  if (!value) return null;
  const parsed = Date.parse(String(data.accessTokenExpiryDate ?? ''));
  token = {
    value,
    forKey: key,
    expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + 24 * 60 * 60 * 1000,
  };
  return value;
}

type CjResult =
  | { ok: true; data: any }
  | { ok: false; unknown: boolean; detail: string };

async function cj(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CjResult> {
  const access = await accessToken();
  if (!access) return { ok: false, unknown: false, detail: 'CJ did not issue an access token for the configured key' };
  const answer: ProviderAnswer = await throttled(() =>
    request({
      url: `${CJ_API}/${path}`,
      method,
      headers: { 'CJ-Access-Token': access, 'Content-Type': 'application/json', platformToken: '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  if (answer.kind === 'UNKNOWN') return { ok: false, unknown: true, detail: answer.reason };
  if (answer.kind === 'REFUSED') return { ok: false, unknown: false, detail: answer.detail };
  if (answer.body.result === false || (answer.body.code !== undefined && Number(answer.body.code) !== 200)) {
    const code = /^\d{1,10}$/.test(String(answer.body.code ?? '')) ? String(answer.body.code) : 'unknown';
    return { ok: false, unknown: false, detail: `CJ refused the request (code ${code})` };
  }
  return { ok: true, data: answer.body.data };
}

export interface SupplierMatch {
  supplierProductId: string;
  supplierVariantId: string;
  name: string;
  unitCents: number;
  shippingCents: number;
  logisticName: string;
  /** The slowest end of CJ's quoted delivery window, in days. */
  maxDays: number | null;
  imageUrl: string | null;
}

function cents(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').split('-')[0]);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** "7-12" -> 12, "15" -> 15, anything else -> null. */
export function slowestDays(aging: unknown): number | null {
  const numbers = String(aging ?? '').match(/\d+/g);
  if (!numbers) return null;
  return Math.max(...numbers.map(Number));
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !['for', 'and', 'the', 'with'].includes(word)),
  );
}

/** How much of the product's own name a catalogue title covers, 0..1. */
export function nameOverlap(product: string, candidate: string): number {
  const want = tokens(product);
  if (want.size === 0) return 0;
  const have = tokens(candidate);
  let hit = 0;
  for (const word of want) if (have.has(word)) hit += 1;
  return hit / want.size;
}

/** The share of a product's name a catalogue item must cover before Brain will sell it. */
export const MIN_NAME_OVERLAP = 0.6;

/**
 * Find the catalogue item to sell for a product, priced and shipped.
 *
 * Refuses rather than guesses: an item whose title does not cover the product's
 * name, one with no variant, or one CJ will not quote shipping for is not a
 * match. Of the matches, the cheapest landed cost wins.
 */
export async function matchSupplierItem(input: {
  productName: string;
  destinationCountry: string;
  maxDeliveryDays: number;
}): Promise<{ ok: true; match: SupplierMatch } | { ok: false; unknown: boolean; reason: string }> {
  const search = await cj('GET', `product/listV2?keyWord=${encodeURIComponent(input.productName)}&page=1&size=10`);
  if (!search.ok) return { ok: false, unknown: search.unknown, reason: search.detail };
  const lists = Array.isArray(search.data?.content) ? search.data.content : [];
  const items: any[] = lists.flatMap((one: any) => (Array.isArray(one?.productList) ? one.productList : []));
  const named = items
    .filter((one) => one?.id && nameOverlap(input.productName, String(one.nameEn ?? '')) >= MIN_NAME_OVERLAP)
    .slice(0, 3);
  if (named.length === 0) {
    return { ok: false, unknown: false, reason: `no CJ catalogue item's title covers "${input.productName}"` };
  }

  const matches: SupplierMatch[] = [];
  for (const item of named) {
    const detail = await cj('GET', `product/query?pid=${encodeURIComponent(String(item.id))}`);
    if (!detail.ok) continue;
    const variant = (Array.isArray(detail.data?.variants) ? detail.data.variants : [])[0];
    const unit = cents(variant?.variantSellPrice ?? detail.data?.sellPrice);
    if (!variant?.vid || unit === null) continue;
    const freight = await cj('POST', 'logistic/freightCalculate', {
      startCountryCode: CJ_FROM_COUNTRY,
      endCountryCode: input.destinationCountry,
      products: [{ quantity: 1, vid: String(variant.vid) }],
    });
    if (!freight.ok || !Array.isArray(freight.data)) continue;
    const options = freight.data
      .map((one: any) => ({
        name: String(one?.logisticName ?? ''),
        cents: cents(one?.logisticPrice),
        days: slowestDays(one?.logisticAging),
      }))
      .filter((one: { name: string; cents: number | null; days: number | null }) =>
        one.name && one.cents !== null && one.days !== null && one.days <= input.maxDeliveryDays,
      )
      .sort((a: any, b: any) => a.cents - b.cents);
    const best = options[0];
    if (!best) continue;
    const images = Array.isArray(detail.data?.productImageSet) ? detail.data.productImageSet : [];
    const image = String(variant.variantImage ?? images[0] ?? detail.data?.bigImage ?? item.bigImage ?? '');
    matches.push({
      supplierProductId: String(item.id),
      supplierVariantId: String(variant.vid),
      name: String(item.nameEn ?? detail.data?.productNameEn ?? input.productName),
      unitCents: unit,
      shippingCents: best.cents!,
      logisticName: best.name,
      maxDays: best.days,
      imageUrl: /^https:\/\//.test(image) ? image : null,
    });
  }
  const chosen = matches.sort((a, b) => a.unitCents + a.shippingCents - (b.unitCents + b.shippingCents))[0];
  if (!chosen) {
    return {
      ok: false,
      unknown: false,
      reason: `no CJ item for "${input.productName}" ships to ${input.destinationCountry} within ${input.maxDeliveryDays} days`,
    };
  }
  return { ok: true, match: chosen };
}

export interface SupplierOrderPayload {
  orderNumber: string;
  supplierVariantId: string;
  quantity: number;
  logisticName: string;
  shipping: {
    name: string;
    address1: string;
    address2: string | null;
    city: string;
    province: string;
    countryCode: string;
    country: string;
    zip: string | null;
    phone: string | null;
    email: string | null;
  };
}

export function createCjOrderAdapter(input: { namespace: string }): EffectAdapter {
  return {
    name: CJ_ORDER_ADAPTER,
    effectClass: 'EXTERNAL_RECONCILABLE',
    namespace: input.namespace,
    validate(payload: unknown): Record<string, unknown> {
      const p = (payload ?? {}) as Partial<SupplierOrderPayload>;
      if (typeof p.orderNumber !== 'string' || !/^[A-Za-z0-9_-]{6,50}$/.test(p.orderNumber)) throw new Error('an order number is required');
      if (typeof p.supplierVariantId !== 'string' || !p.supplierVariantId) throw new Error('a CJ variant id is required');
      if (!Number.isSafeInteger(p.quantity) || (p.quantity as number) < 1) throw new Error('a quantity is required');
      if (typeof p.logisticName !== 'string' || !p.logisticName) throw new Error('a logistic name is required');
      const s = p.shipping;
      if (!s || !s.name || !s.address1 || !s.city || !/^[A-Z]{2}$/.test(s.countryCode ?? '')) {
        throw new Error('a complete shipping address is required');
      }
      return p as Record<string, unknown>;
    },
    // The address is part of the request and never part of its identity, so it
    // is never fingerprinted or stored.
    fingerprintInputs(payload) {
      return { orderNumber: payload.orderNumber, vid: payload.supplierVariantId, quantity: payload.quantity };
    },
    async send(req: EffectRequest): Promise<SendOutcome> {
      const p = req.payload as unknown as SupplierOrderPayload;
      const result = await cj('POST', 'shopping/order/createOrderV2', {
        orderNumber: p.orderNumber,
        shippingCountryCode: p.shipping.countryCode,
        shippingCountry: p.shipping.country,
        shippingProvince: p.shipping.province,
        shippingCity: p.shipping.city,
        shippingAddress: p.shipping.address1,
        ...(p.shipping.address2 ? { shippingAddress2: p.shipping.address2 } : {}),
        shippingCustomerName: p.shipping.name,
        ...(p.shipping.zip ? { shippingZip: p.shipping.zip } : {}),
        ...(p.shipping.phone ? { shippingPhone: p.shipping.phone } : {}),
        ...(p.shipping.email ? { email: p.shipping.email } : {}),
        logisticName: p.logisticName,
        fromCountryCode: CJ_FROM_COUNTRY,
        payType: 2,
        ...(cjSandbox() ? { isSandbox: 1 } : {}),
        products: [{ vid: p.supplierVariantId, quantity: p.quantity }],
      });
      if (!result.ok) {
        return result.unknown
          ? { kind: 'UNCERTAIN', reason: result.detail }
          : { kind: 'REJECTED', category: 'PROVIDER_REJECTED', retryable: false, detail: result.detail };
      }
      const orderId = result.data?.orderId;
      if (!orderId) return { kind: 'UNCERTAIN', reason: 'CJ answered without an order id' };
      return {
        kind: 'CONFIRMED',
        receiptRef: String(orderId),
        receiptMeta: { paidCents: cents(result.data?.actualPayment ?? result.data?.orderAmount) },
      };
    },
    async reconcile(businessId: string): Promise<ReconcileOutcome> {
      const read = await readSupplierOrder(businessId);
      if (read === 'UNKNOWN') return { kind: 'INCONCLUSIVE', reason: 'CJ did not answer' };
      if (!read) return { kind: 'ABSENT' };
      return { kind: 'FOUND', receiptRef: read.orderId, receiptMeta: { paidCents: read.amountCents } };
    },
    health(): AdapterHealth {
      const reading = supplierConfig();
      return reading.configured
        ? { usable: true, reason: `CJ is configured${cjSandbox() ? ' (sandbox: orders charge nothing)' : ''}.` }
        : { usable: false, reason: `CJ is not usable: missing ${reading.problems.join(', ')}.` };
    },
  };
}

export interface SupplierOrderReading {
  orderId: string;
  status: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  amountCents: number | null;
}

/**
 * What CJ says about an order, by Brain's order number or CJ's id. Null when
 * CJ answers that there is no such order; UNKNOWN when it does not answer.
 */
export async function readSupplierOrder(orderNumber: string): Promise<SupplierOrderReading | null | 'UNKNOWN'> {
  const result = await cj('GET', `shopping/order/getOrderDetail?orderId=${encodeURIComponent(orderNumber)}`);
  if (!result.ok) return result.unknown ? 'UNKNOWN' : null;
  const data = result.data;
  if (!data?.orderId) return null;
  return {
    orderId: String(data.orderId),
    status: String(data.orderStatus ?? ''),
    trackingNumber: data.trackNumber ? String(data.trackNumber) : null,
    trackingUrl: typeof data.trackingUrl === 'string' && /^https?:\/\//.test(data.trackingUrl) ? data.trackingUrl : null,
    carrier: data.logisticName ? String(data.logisticName) : null,
    amountCents: cents(data.orderAmount),
  };
}

/** Does CJ issue a token for the key? Sends nothing else. */
export async function probeCj(): Promise<{ verdict: 'OK' | 'REFUSED'; detail: string }> {
  if (!supplierConfig().configured) return { verdict: 'REFUSED', detail: 'not configured' };
  token = null;
  return (await accessToken())
    ? { verdict: 'OK', detail: 'CJ issued an access token' }
    : { verdict: 'REFUSED', detail: 'CJ did not issue an access token for the key' };
}
