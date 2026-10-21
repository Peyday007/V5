/**
 * Registering the store, supplier and ad adapters a deployment selected, once,
 * at boot (§74). Whether each is usable is asked again on every pass through
 * `health()`, so a removed key stops the work without a restart.
 */
import { getAdapter, listAdapters, registerAdapter, type EffectAdapter } from '../../effects/adapter.ts';
import type { OperationNamespace } from '../../effects/engine.ts';
import { adsConfig, storeConfig, supplierConfig } from './config.ts';
import { createCjOrderAdapter } from './cj.ts';
import { createMetaAdTestAdapter } from './meta.ts';
import { createShopifyListingAdapter } from './shopify.ts';

const ns = (name: string): OperationNamespace => ({
  name,
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
});

export const LISTING_NAMESPACE = ns('commerce.list_product');
export const AD_TEST_NAMESPACE = ns('commerce.ad_test');
export const SUPPLIER_ORDER_NAMESPACE = ns('commerce.supplier_order');

export function registerCommerceProviders(env: NodeJS.ProcessEnv = process.env): {
  store: string | null;
  supplier: string | null;
  ads: string | null;
} {
  const out = { store: null as string | null, supplier: null as string | null, ads: null as string | null };
  if (storeConfig(env).provider === 'shopify') {
    registerAdapter(createShopifyListingAdapter({ namespace: LISTING_NAMESPACE.name }));
    out.store = 'shopify';
  }
  if (supplierConfig(env).provider === 'cj') {
    registerAdapter(createCjOrderAdapter({ namespace: SUPPLIER_ORDER_NAMESPACE.name }));
    out.supplier = 'cj';
  }
  if (adsConfig(env).provider === 'meta') {
    registerAdapter(createMetaAdTestAdapter({ namespace: AD_TEST_NAMESPACE.name }));
    out.ads = 'meta';
  }
  return out;
}

/** The adapter for a namespace that is registered and healthy now, or none. */
export function usableCommerceAdapter(namespace: OperationNamespace): EffectAdapter | null {
  for (const adapter of listAdapters()) {
    if (adapter.namespace !== namespace.name) continue;
    if (adapter.health && !adapter.health().usable) continue;
    return getAdapter(adapter.name);
  }
  return null;
}
