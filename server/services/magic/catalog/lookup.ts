/**
 * What the rest of Brain asks the catalog, with its freshness attached. A
 * result from a cache that could not be refreshed says so — `stale: true` and
 * the reason — so no screen shows old data as current.
 */
import { countCards, findCardsByName, getCatalogSource, searchCardsByPrefix, type CatalogCard } from '../../../repos/magicCatalog.ts';
import { DEFAULT_SOURCE_KEY, STALE_AFTER_MS, refreshInFlight } from './ingest.ts';

export interface CatalogStatus {
  state: 'EMPTY' | 'LOADING' | 'FRESH' | 'STALE';
  stale: boolean;
  cards: number;
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  lastError: string | null;
  reason: string | null;
}

export async function catalogStatus(now = new Date(), sourceKey = DEFAULT_SOURCE_KEY): Promise<CatalogStatus> {
  const [source, cards] = await Promise.all([getCatalogSource(sourceKey), countCards()]);
  const base = {
    cards,
    fetchedAt: source?.fetchedAt ?? null,
    sourceUpdatedAt: source?.sourceUpdatedAt ?? null,
    lastError: source?.lastError ?? null,
  };
  if (cards === 0) {
    return { ...base, state: refreshInFlight() || source?.status === 'LOADING' ? 'LOADING' : 'EMPTY', stale: false,
      reason: source?.status === 'FAILED' ? `The catalog could not be loaded: ${source.lastError ?? 'unknown error'}.` : 'No catalog has been loaded yet.' };
  }
  if (source?.status === 'FAILED') {
    return { ...base, state: 'STALE', stale: true, reason: `The last refresh failed (${source.lastError ?? 'unknown error'}); serving the cached catalog.` };
  }
  const age = source?.fetchedAt ? now.getTime() - Date.parse(source.fetchedAt) : Infinity;
  if (age > STALE_AFTER_MS) {
    return { ...base, state: 'STALE', stale: true, reason: 'The catalog was last refreshed more than 48 hours ago.' };
  }
  return { ...base, state: source?.status === 'LOADING' ? 'LOADING' : 'FRESH', stale: false, reason: null };
}

export type LookupResult =
  | { kind: 'FOUND'; card: CatalogCard; status: CatalogStatus }
  | { kind: 'AMBIGUOUS'; candidates: CatalogCard[]; status: CatalogStatus }
  | { kind: 'UNKNOWN'; status: CatalogStatus };

export async function lookupCard(name: string): Promise<LookupResult> {
  const [matches, status] = await Promise.all([findCardsByName(name), catalogStatus()]);
  if (matches.length === 0) return { kind: 'UNKNOWN', status };
  if (matches.length > 1) return { kind: 'AMBIGUOUS', candidates: matches, status };
  return { kind: 'FOUND', card: matches[0]!, status };
}

export async function searchCatalog(prefix: string, limit = 20): Promise<{ cards: CatalogCard[]; status: CatalogStatus }> {
  const [cards, status] = await Promise.all([searchCardsByPrefix(prefix, limit), catalogStatus()]);
  return { cards, status };
}
