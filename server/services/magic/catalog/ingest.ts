/**
 * Catalog refresh. The bulk download address is read from Scryfall's manifest
 * at run time and never written down here; only the manifest endpoint is a
 * constant. The refresh runs off the request path: `startCatalogRefresh`
 * returns a handle at once, at most one runs at a time, and it can be
 * cancelled. A failed or cancelled refresh changes no card — the cache keeps
 * serving, labelled stale by `catalogStatus`.
 */
import { getDb } from '../../../db/database.ts';
import {
  countCards, getCatalogSource, upsertCard, upsertCatalogSource, upsertPrinting,
} from '../../../repos/magicCatalog.ts';
import { jsonArrayElements, StreamLimitError } from './stream.ts';
import { normalizeCard, type ScryfallCard } from './normalize.ts';

export const BULK_MANIFEST_URL = 'https://api.scryfall.com/bulk-data';
export const DEFAULT_SOURCE_KEY = 'oracle_cards';
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const BATCH = 400;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body: AsyncIterable<Uint8Array> | null;
}
export type FetchLike = (url: string, init: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export const realFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>;

export interface RefreshOptions {
  fetchImpl?: FetchLike;
  sourceKey?: string;
  signal?: AbortSignal;
  now?: () => Date;
  maxCards?: number;
  maxTotalBytes?: number;
  maxObjectBytes?: number;
  /** Re-read even when the manifest's updated_at has not moved. */
  force?: boolean;
}

export type RefreshResult =
  | { status: 'UPDATED'; cards: number; skipped: number; downloadUri: string; sourceUpdatedAt: string | null }
  | { status: 'UNCHANGED'; sourceUpdatedAt: string | null }
  | { status: 'FAILED'; error: string; cancelled: boolean; servingCache: boolean };

const HEADERS = { Accept: 'application/json', 'User-Agent': 'BrainMagicDeckLab/1.0' };

export async function refreshCatalog(options: RefreshOptions = {}): Promise<RefreshResult> {
  const fetchImpl = options.fetchImpl ?? realFetch;
  const sourceKey = options.sourceKey ?? DEFAULT_SOURCE_KEY;
  const now = options.now ?? (() => new Date());
  const before = await getCatalogSource(sourceKey);
  const priorCount = before?.cardCount ?? 0;
  let downloadUri: string | null = null;
  let sourceUpdatedAt: string | null = null;
  try {
    const manifestResponse = await fetchImpl(BULK_MANIFEST_URL, { signal: options.signal, headers: HEADERS });
    if (!manifestResponse.ok) throw new Error(`The Scryfall manifest answered ${manifestResponse.status}.`);
    const manifest = (await manifestResponse.json()) as { data?: { type?: string; download_uri?: string; updated_at?: string }[] };
    const entry = manifest.data?.find((d) => d.type === sourceKey);
    if (!entry?.download_uri) throw new Error(`The manifest has no "${sourceKey}" bulk file.`);
    downloadUri = entry.download_uri;
    sourceUpdatedAt = entry.updated_at ?? null;
    if (!options.force && before?.status === 'FRESH' && before.sourceUpdatedAt && before.sourceUpdatedAt === sourceUpdatedAt && (await countCards()) > 0) {
      return { status: 'UNCHANGED', sourceUpdatedAt };
    }
    await upsertCatalogSource({ sourceKey, status: 'LOADING', downloadUri, sourceUpdatedAt, cardCount: priorCount });
    const response = await fetchImpl(downloadUri, { signal: options.signal, headers: HEADERS });
    if (!response.ok || !response.body) throw new Error(`The bulk download answered ${response.status}.`);
    const fetchedAt = now().toISOString();
    let cards = 0;
    let skipped = 0;
    let pending: ReturnType<typeof normalizeCard>[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      await getDb().transaction(async () => {
        for (const item of batch) {
          if (!item) continue;
          await upsertCard(item.card);
          await upsertPrinting(item.printing);
        }
      });
      // Let other work run between batches: this must never starve a request.
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    for await (const text of jsonArrayElements(response.body, {
      signal: options.signal, maxTotalBytes: options.maxTotalBytes, maxObjectBytes: options.maxObjectBytes,
    })) {
      if (options.signal?.aborted) throw new Error('cancelled');
      const normalized = normalizeCard(JSON.parse(text) as ScryfallCard, sourceKey, fetchedAt);
      if (!normalized) {
        skipped++;
        continue;
      }
      pending.push(normalized);
      cards++;
      if (options.maxCards && cards > options.maxCards) throw new StreamLimitError(`More than ${options.maxCards} cards.`);
      if (pending.length >= BATCH) await flush();
    }
    await flush();
    await upsertCatalogSource({ sourceKey, status: 'FRESH', downloadUri, sourceUpdatedAt, fetchedAt, cardCount: cards, lastError: null });
    return { status: 'UPDATED', cards, skipped, downloadUri, sourceUpdatedAt };
  } catch (error) {
    const cancelled = options.signal?.aborted === true || (error as Error).message === 'cancelled';
    const message = cancelled ? 'The refresh was cancelled.' : String((error as Error).message ?? error).slice(0, 500);
    await upsertCatalogSource({ sourceKey, status: 'FAILED', downloadUri, sourceUpdatedAt, cardCount: priorCount, lastError: message }).catch(() => undefined);
    return { status: 'FAILED', error: message, cancelled, servingCache: (await countCards().catch(() => 0)) > 0 };
  }
}

export interface RefreshHandle {
  promise: Promise<RefreshResult>;
  cancel(): void;
}

let inFlight: RefreshHandle | null = null;

/** Begin a refresh without waiting for it. A second call while one runs returns the same handle. */
export function startCatalogRefresh(options: Omit<RefreshOptions, 'signal'> = {}): RefreshHandle {
  if (inFlight) return inFlight;
  const controller = new AbortController();
  const promise = refreshCatalog({ ...options, signal: controller.signal }).finally(() => {
    inFlight = null;
  });
  inFlight = { promise, cancel: () => controller.abort() };
  return inFlight;
}

export function refreshInFlight(): boolean {
  return inFlight !== null;
}
