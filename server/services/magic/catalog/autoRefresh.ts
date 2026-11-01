/**
 * The catalog fills itself. Nothing else in the product ever starts a refresh,
 * so without this a new Brain answers every card name "unknown" until somebody
 * finds the refresh route by hand.
 *
 * Asked whenever somebody reads the catalog's status. It starts a refresh off
 * the request path when the catalog is empty or older than the stale window,
 * and holds off after a failure so an unreachable Scryfall is not asked again
 * on every page load. A refresh another process recorded as LOADING recently
 * is left alone.
 */
import { countCards, getCatalogSource } from '../../../repos/magicCatalog.ts';
import { DEFAULT_SOURCE_KEY, STALE_AFTER_MS, refreshInFlight, startCatalogRefresh } from './ingest.ts';

export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
export const LOADING_ELSEWHERE_MS = 30 * 60 * 1000;

export type AutoRefreshDecision =
  | 'STARTED'
  | 'IN_FLIGHT'
  | 'FRESH'
  | 'RECENT_FAILURE'
  | 'LOADING_ELSEWHERE'
  | 'DISABLED';

export interface AutoRefreshOptions {
  now?: Date;
  start?: () => void;
  enabled?: boolean;
}

function enabledByDefault(): boolean {
  // Tests run against a committed fixture and must never reach the network.
  if (process.env.VITEST) return false;
  return process.env.BRAIN_MAGIC_CATALOG_AUTOREFRESH !== 'off';
}

export async function ensureCatalogFresh(options: AutoRefreshOptions = {}): Promise<AutoRefreshDecision> {
  if (!(options.enabled ?? enabledByDefault())) return 'DISABLED';
  if (refreshInFlight()) return 'IN_FLIGHT';
  const now = (options.now ?? new Date()).getTime();
  const [source, cards] = await Promise.all([getCatalogSource(DEFAULT_SOURCE_KEY), countCards()]);
  const touched = source ? Date.parse(source.updatedAt) : 0;
  if (source?.status === 'FAILED' && now - touched < RETRY_AFTER_FAILURE_MS) return 'RECENT_FAILURE';
  if (source?.status === 'LOADING' && now - touched < LOADING_ELSEWHERE_MS) return 'LOADING_ELSEWHERE';
  const age = source?.fetchedAt ? now - Date.parse(source.fetchedAt) : Infinity;
  if (cards > 0 && age <= STALE_AFTER_MS) return 'FRESH';
  (options.start ?? (() => { startCatalogRefresh().promise.catch(() => undefined); }))();
  return 'STARTED';
}
