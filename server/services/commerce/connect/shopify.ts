/**
 * The owner's Shopify store (§74): one listing per qualified product, the paid
 * orders that contain it, and a fulfilment with the supplier's tracking.
 *
 * Admin GraphQL, authenticated with the store's Admin API access token in
 * `X-Shopify-Access-Token`. The token needs `write_products`,
 * `write_publications`, `read_orders` and
 * `write_merchant_managed_fulfillment_orders`.
 *
 * A listing is created with `productSet` keyed on the product's handle, which
 * Brain derives from its own product id. That makes it reconcilable: after an
 * unknown outcome Brain asks the store for the handle instead of creating a
 * second product.
 */
import type {
  AdapterHealth,
  EffectAdapter,
  EffectRequest,
  ReconcileOutcome,
  SendOutcome,
} from '../../effects/adapter.ts';
import { SHOPIFY_DOMAIN_ENV, SHOPIFY_TOKEN_ENV, secret, storeConfig } from './config.ts';
import { request, type ProviderAnswer } from './http.ts';

export const SHOPIFY_API_VERSION = '2025-10';
export const SHOPIFY_LISTING_ADAPTER = 'shopify.list_product';

type GqlResult =
  | { ok: true; data: Record<string, any> }
  | { ok: false; answer: Exclude<ProviderAnswer, { kind: 'OK' }> | { kind: 'REFUSED'; status: number; category: 'INVALID_INPUT' | 'PROVIDER_REJECTED'; retryable: boolean; detail: string } };

export async function shopifyGraphql(query: string, variables: Record<string, unknown>): Promise<GqlResult> {
  const domain = secret(SHOPIFY_DOMAIN_ENV);
  const token = secret(SHOPIFY_TOKEN_ENV);
  if (!domain || !token) {
    return {
      ok: false,
      answer: { kind: 'REFUSED', status: 0, category: 'PROVIDER_REJECTED', retryable: false, detail: 'the store is not connected' },
    };
  }
  const answer = await request({
    url: `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (answer.kind !== 'OK') return { ok: false, answer };
  const errors = answer.body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const throttled = errors.some((one: any) => one?.extensions?.code === 'THROTTLED');
    return {
      ok: false,
      answer: {
        kind: 'REFUSED',
        status: 200,
        category: throttled ? 'PROVIDER_REJECTED' : 'INVALID_INPUT',
        retryable: throttled,
        detail: throttled ? 'Shopify throttled the request; nothing was processed' : 'Shopify refused the query',
      },
    };
  }
  return { ok: true, data: (answer.body.data ?? {}) as Record<string, any> };
}

/** The handle Brain gives a product's listing: derived from its id, so it is stable. */
export function listingHandle(productId: string): string {
  return `brain-${productId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export interface ListingPayload {
  handle: string;
  title: string;
  descriptionHtml: string;
  priceCents: number;
  imageUrl: string | null;
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

const PRODUCT_SET = `
mutation brainListing($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
  productSet(synchronous: true, input: $input, identifier: $identifier) {
    product { id handle variants(first: 1) { nodes { id } } }
    userErrors { field message code }
  }
}`;

const BY_HANDLE = `
query brainListingByHandle($identifier: ProductIdentifierInput!) {
  productByIdentifier(identifier: $identifier) { id handle variants(first: 1) { nodes { id } } }
}`;

function refusalOutcome(answer: Exclude<GqlResult, { ok: true }>['answer']): SendOutcome {
  if (answer.kind === 'UNKNOWN') return { kind: 'UNCERTAIN', reason: answer.reason };
  return { kind: 'REJECTED', category: answer.category, retryable: answer.retryable, detail: answer.detail };
}

export function createShopifyListingAdapter(input: { namespace: string }): EffectAdapter {
  return {
    name: SHOPIFY_LISTING_ADAPTER,
    effectClass: 'EXTERNAL_RECONCILABLE',
    namespace: input.namespace,
    validate(payload: unknown): Record<string, unknown> {
      const p = (payload ?? {}) as Partial<ListingPayload>;
      if (typeof p.handle !== 'string' || !/^brain-[a-z0-9-]+$/.test(p.handle)) throw new Error('a listing needs Brain’s handle');
      if (typeof p.title !== 'string' || p.title.trim().length < 3) throw new Error('a listing needs a title');
      if (!Number.isSafeInteger(p.priceCents) || (p.priceCents as number) <= 0) throw new Error('a listing needs a price in cents');
      if (typeof p.descriptionHtml !== 'string') throw new Error('a listing needs a description');
      if (p.imageUrl !== null && p.imageUrl !== undefined && !/^https:\/\//.test(p.imageUrl)) {
        throw new Error('an image must be an https URL');
      }
      return { ...p, imageUrl: p.imageUrl ?? null } as Record<string, unknown>;
    },
    fingerprintInputs(payload) {
      return { handle: payload.handle };
    },
    async send(req: EffectRequest): Promise<SendOutcome> {
      const p = req.payload as unknown as ListingPayload;
      const variables = {
        identifier: { handle: p.handle },
        input: {
          handle: p.handle,
          title: p.title,
          descriptionHtml: p.descriptionHtml,
          status: 'ACTIVE',
          productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
          variants: [
            { optionValues: [{ optionName: 'Title', name: 'Default Title' }], price: money(p.priceCents) },
          ],
          ...(p.imageUrl ? { files: [{ originalSource: p.imageUrl, contentType: 'IMAGE', alt: p.title }] } : {}),
        },
      };
      const result = await shopifyGraphql(PRODUCT_SET, variables);
      if (!result.ok) return refusalOutcome(result.answer);
      const payload = result.data.productSet ?? {};
      const userErrors = Array.isArray(payload.userErrors) ? payload.userErrors : [];
      if (userErrors.length > 0 || !payload.product?.id) {
        const codes = userErrors.map((one: any) => String(one?.code ?? 'ERROR')).filter((code: string) => /^[A-Z_]{1,64}$/.test(code));
        return {
          kind: 'REJECTED',
          category: 'INVALID_INPUT',
          retryable: false,
          detail: `Shopify refused the listing (${codes.join(', ') || 'no product returned'})`,
        };
      }
      return {
        kind: 'CONFIRMED',
        receiptRef: String(payload.product.id),
        receiptMeta: { variantId: payload.product.variants?.nodes?.[0]?.id ?? null, handle: payload.product.handle },
      };
    },
    async reconcile(businessId: string): Promise<ReconcileOutcome> {
      const found = await findListing(businessId);
      if (found === 'UNKNOWN') return { kind: 'INCONCLUSIVE', reason: 'the store did not answer' };
      if (!found) return { kind: 'ABSENT' };
      return { kind: 'FOUND', receiptRef: found.productId, receiptMeta: { variantId: found.variantId, handle: businessId } };
    },
    health(): AdapterHealth {
      const reading = storeConfig();
      return reading.configured
        ? { usable: true, reason: 'Shopify is configured.' }
        : { usable: false, reason: `Shopify is not usable: missing or malformed ${reading.problems.join(', ')}.` };
    },
  };
}

export async function findListing(
  handle: string,
): Promise<{ productId: string; variantId: string | null } | null | 'UNKNOWN'> {
  const result = await shopifyGraphql(BY_HANDLE, { identifier: { handle } });
  if (!result.ok) return 'UNKNOWN';
  const product = result.data.productByIdentifier;
  if (!product?.id) return null;
  return { productId: String(product.id), variantId: product.variants?.nodes?.[0]?.id ?? null };
}

/**
 * Make the listing visible on the Online Store channel. Publishing the same
 * product twice is a no-op at Shopify, so this is safe to ask on every pass
 * until it reports true.
 */
export async function ensurePublished(productId: string): Promise<{ ok: boolean; reason: string }> {
  const publications = await shopifyGraphql(
    'query { publications(first: 20) { nodes { id name } } }',
    {},
  );
  if (!publications.ok) return { ok: false, reason: 'the store did not list its sales channels' };
  const store = (publications.data.publications?.nodes ?? []).find((one: any) => /online store/i.test(String(one?.name ?? '')));
  if (!store) return { ok: false, reason: 'the store has no Online Store sales channel' };
  const published = await shopifyGraphql(
    `mutation brainPublish($id: ID!, $input: [PublicationInput!]!) {
       publishablePublish(id: $id, input: $input) { userErrors { field message } }
     }`,
    { id: productId, input: [{ publicationId: store.id }] },
  );
  if (!published.ok) return { ok: false, reason: 'the store did not confirm publishing' };
  const errors = published.data.publishablePublish?.userErrors ?? [];
  return errors.length === 0
    ? { ok: true, reason: 'published on the Online Store' }
    : { ok: false, reason: 'the store refused to publish the product' };
}

export interface StoreOrder {
  id: string;
  name: string;
  createdAt: string;
  totalCents: number;
  currency: string;
  /** Quantity per variant id. */
  lines: { variantId: string; quantity: number }[];
}

/** Paid, unfulfilled orders created at or after `since`. */
export async function paidUnfulfilledOrders(since: string): Promise<StoreOrder[] | 'UNKNOWN'> {
  const day = since.slice(0, 10);
  const result = await shopifyGraphql(
    `query brainOrders($q: String!) {
       orders(first: 50, sortKey: CREATED_AT, query: $q) {
         nodes {
           id name createdAt
           currentTotalPriceSet { shopMoney { amount currencyCode } }
           lineItems(first: 20) { nodes { quantity variant { id } } }
         }
       }
     }`,
    { q: `financial_status:paid fulfillment_status:unfulfilled created_at:>=${day}` },
  );
  if (!result.ok) return 'UNKNOWN';
  const out: StoreOrder[] = [];
  for (const node of result.data.orders?.nodes ?? []) {
    const money = node?.currentTotalPriceSet?.shopMoney;
    const cents = Math.round(Number(money?.amount) * 100);
    if (!node?.id || !Number.isFinite(cents) || !money?.currencyCode) continue;
    out.push({
      id: String(node.id),
      name: String(node.name ?? node.id),
      createdAt: String(node.createdAt ?? ''),
      totalCents: cents,
      currency: String(money.currencyCode),
      lines: (node.lineItems?.nodes ?? [])
        .filter((line: any) => line?.variant?.id)
        .map((line: any) => ({ variantId: String(line.variant.id), quantity: Number(line.quantity) || 0 })),
    });
  }
  return out;
}

export interface ShippingAddress {
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
}

/**
 * Where an order ships, read at the moment it is needed and never stored.
 * Brain keeps the order's id; the address stays in the store.
 */
export async function orderShippingAddress(orderId: string): Promise<ShippingAddress | null | 'UNKNOWN'> {
  const result = await shopifyGraphql(
    `query brainOrderAddress($id: ID!) {
       order(id: $id) {
         email
         shippingAddress { name address1 address2 city province provinceCode country countryCodeV2 zip phone }
       }
     }`,
    { id: orderId },
  );
  if (!result.ok) return 'UNKNOWN';
  const order = result.data.order;
  const address = order?.shippingAddress;
  if (!address?.address1 || !address?.city || !address?.countryCodeV2) return null;
  return {
    name: String(address.name ?? ''),
    address1: String(address.address1),
    address2: address.address2 ? String(address.address2) : null,
    city: String(address.city),
    province: String(address.province ?? address.provinceCode ?? ''),
    countryCode: String(address.countryCodeV2),
    country: String(address.country ?? address.countryCodeV2),
    zip: address.zip ? String(address.zip) : null,
    phone: address.phone ? String(address.phone) : null,
    email: order.email ? String(order.email) : null,
  };
}

/**
 * Mark an order shipped with the supplier's tracking. Idempotent by reading:
 * an order with no open fulfilment order is already done.
 */
export async function fulfilWithTracking(input: {
  orderId: string;
  trackingNumber: string;
  trackingUrl: string | null;
  carrier: string | null;
}): Promise<{ ok: boolean; reason: string }> {
  const orders = await shopifyGraphql(
    `query brainFulfilmentOrders($id: ID!) {
       order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } }
     }`,
    { id: input.orderId },
  );
  if (!orders.ok) return { ok: false, reason: 'the store did not answer' };
  const open = (orders.data.order?.fulfillmentOrders?.nodes ?? []).filter((one: any) =>
    ['OPEN', 'IN_PROGRESS'].includes(String(one?.status)),
  );
  if (open.length === 0) return { ok: true, reason: 'already fulfilled' };
  const created = await shopifyGraphql(
    `mutation brainFulfil($fulfillment: FulfillmentInput!) {
       fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } }
     }`,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: open.map((one: any) => ({ fulfillmentOrderId: one.id })),
        notifyCustomer: true,
        trackingInfo: {
          number: input.trackingNumber,
          ...(input.trackingUrl ? { url: input.trackingUrl } : {}),
          ...(input.carrier ? { company: input.carrier } : {}),
        },
      },
    },
  );
  if (!created.ok) return { ok: false, reason: 'the store did not confirm the fulfilment' };
  const errors = created.data.fulfillmentCreate?.userErrors ?? [];
  return errors.length === 0 ? { ok: true, reason: 'fulfilled' } : { ok: false, reason: 'the store refused the fulfilment' };
}

/** Is the token accepted? Reads the shop's name; sends nothing. */
export async function probeShopify(): Promise<{ verdict: 'OK' | 'REFUSED' | 'UNKNOWN'; detail: string; currency: string | null }> {
  if (!storeConfig().configured) return { verdict: 'REFUSED', detail: 'not configured', currency: null };
  const result = await shopifyGraphql('query { shop { name currencyCode } }', {});
  if (!result.ok) {
    return result.answer.kind === 'UNKNOWN'
      ? { verdict: 'UNKNOWN', detail: result.answer.reason, currency: null }
      : { verdict: 'REFUSED', detail: result.answer.detail, currency: null };
  }
  return { verdict: 'OK', detail: 'the store accepts the token', currency: result.data.shop?.currencyCode ?? null };
}
