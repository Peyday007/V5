import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

/**
 * A Scryfall client that keeps to Scryfall's published rules
 * (https://scryfall.com/docs/api/rate-limits, checked 2026-10-14):
 *   /cards/search, /cards/named, /cards/random, /cards/collection — 2 per second;
 *   /cards/manifest — 10 per minute; everything else — 10 per second;
 *   a 429 locks the client out for 30 seconds and must be respected;
 *   every request carries an accurate User-Agent and an Accept header;
 *   rapid name lookups must use the bulk data files, which live on *.scryfall.io (no limit).
 */
export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  layout: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  color_identity: string[];
  keywords?: string[];
  legalities: Record<string, string>;
  set?: string;
  set_name?: string;
  collector_number?: string;
  released_at?: string;
  image_uris?: Record<string, string>;
  card_faces?: Array<{
    name: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    loyalty?: string;
    image_uris?: Record<string, string>;
  }>;
  scryfall_uri?: string;
  rulings_uri?: string;
  game_changer?: boolean;
}

export interface Ruling { source: string; published_at: string; comment: string }

const LIMITED = ['/cards/search', '/cards/named', '/cards/random', '/cards/collection'];

export class ScryfallClient {
  private chains = new Map<string, Promise<unknown>>();
  private last = new Map<string, number>();
  private lockedUntil = 0;

  constructor(private api: string, private userAgent: string, private fetchImpl: typeof fetch = fetch) {}

  private bucket(path: string): { key: string; gapMs: number } {
    if (path.startsWith('/cards/manifest')) return { key: 'manifest', gapMs: 6000 };
    for (const p of LIMITED) if (path.startsWith(p)) return { key: 'slow', gapMs: 500 };
    return { key: 'fast', gapMs: 100 };
  }

  /** GETs or POSTs an API path, queued so each bucket keeps its spacing. Returns null on 404. */
  async request<T>(path: string, body?: unknown): Promise<T | null> {
    const { key, gapMs } = this.bucket(path);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const wait = Math.max(this.lockedUntil, (this.last.get(key) ?? 0) + gapMs) - Date.now();
        if (wait > 0) await sleep(wait);
        this.last.set(key, Date.now());
        const res = await this.fetchImpl(this.api + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 429) {
          // Scryfall's lockout is 30 seconds; wait it out once, then give up rather than hammer.
          this.lockedUntil = Date.now() + 30_000;
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Scryfall ${path} answered ${res.status}`);
        return (await res.json()) as T;
      }
      throw new Error(`Scryfall rate-limited ${path} twice; try again in a minute.`);
    });
    this.chains.set(key, run);
    return run as Promise<T | null>;
  }

  printing(set: string, number: string): Promise<ScryfallCard | null> {
    return this.request<ScryfallCard>(`/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number)}`);
  }

  /** Up to 75 printings per request (Scryfall's /cards/collection limit). */
  async collection(ids: Array<{ set: string; collector_number: string }>): Promise<{ data: ScryfallCard[]; not_found: Array<{ set: string; collector_number: string }> }> {
    const out = { data: [] as ScryfallCard[], not_found: [] as Array<{ set: string; collector_number: string }> };
    for (let i = 0; i < ids.length; i += 75) {
      const r = await this.request<{ data: ScryfallCard[]; not_found: Array<{ set: string; collector_number: string }> }>('/cards/collection', { identifiers: ids.slice(i, i + 75) });
      if (r) { out.data.push(...r.data); out.not_found.push(...r.not_found); }
    }
    return out;
  }

  async bulkUri(type: 'oracle_cards' | 'rulings'): Promise<{ uri: string; updatedAt: string }> {
    // The bulk object has carried download_uri (JSON) and, since the JSONL change, jsonl_download_uri.
    const meta = await this.request<{ download_uri?: string; jsonl_download_uri?: string; updated_at: string }>(`/bulk-data/${type}`);
    const uri = meta?.jsonl_download_uri ?? meta?.download_uri;
    if (!meta || !uri) throw new Error(`Scryfall has no bulk file ${type}`);
    return { uri, updatedAt: meta.updated_at };
  }

  /** Streams a bulk file (gzipped JSONL, or a plain JSON array for older files) one object at a time. */
  async *streamBulk<T>(uri: string): AsyncGenerator<T> {
    const res = await this.fetchImpl(uri, { headers: { 'User-Agent': this.userAgent, Accept: '*/*' } });
    if (!res.ok || !res.body) throw new Error(`bulk download ${uri} answered ${res.status}`);
    let stream: Readable = Readable.fromWeb(res.body as never);
    if (uri.endsWith('.gz')) stream = stream.pipe(createGunzip());
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const raw of rl) {
      let line = raw.trim();
      if (!line || line === '[' || line === ']') continue;
      if (line.endsWith(',')) line = line.slice(0, -1);
      yield JSON.parse(line) as T;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
