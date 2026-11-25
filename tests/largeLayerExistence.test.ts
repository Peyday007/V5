/**
 * A layer of more than a thousand documents is still asked about by folder.
 *
 * Production, 2026-11-25 (Deploy runs 45679446224 and 45683484132): the release
 * gate's own layer held 1,375 documents. The cloud store's folder listing
 * returned one full page of 1,000 and answered "possibly cut short", so every
 * plan read fell back to ~375 keyed listings through the four-slot existence
 * gate, and every layer derivation outside a memo (an audit brief's) queued a
 * keyed listing per document at once. With two such audit briefs retrying,
 * `GET /api/projects/:id` waited behind them and never answered inside 240 s,
 * before and after the restart. These pin both halves: a folder past one page
 * is read page by page, and a layer derivation asks by folder before by key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { SupabaseStorageProvider } from '../server/services/storage/supabase.ts';
import { getStorage } from '../server/services/storage/index.ts';
import { storageKeyOf } from '../server/services/storage.ts';
import { computeLayerState } from '../server/services/stateEngine.ts';
import { listDocumentsByLayer } from '../server/repos/documents.ts';

describe('a folder larger than one listing page', () => {
  it('is read page by page, so 1,375 objects are two requests and every one is known present', async () => {
    const all = [...Array(1375)].map((_, i) => `doc-${String(i).padStart(5, '0')}.md`);
    const requests: Array<{ offset: number; search?: string }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { limit: number; offset: number; search?: string };
      requests.push({ offset: body.offset, ...(body.search ? { search: body.search } : {}) });
      const page = body.search ? all.filter((name) => name === body.search) : all.slice(body.offset, body.offset + body.limit);
      return new Response(JSON.stringify(page.map((name) => ({ name, id: name }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const store = new SupabaseStorageProvider({ url: 'https://example.supabase.co', serviceRoleKey: 'k', bucket: 'b', fetchImpl });

    const names = await store.namesIn('p/layer');
    expect(names).toHaveLength(1375);
    expect(requests.map((one) => one.offset)).toEqual([0, 1000]);

    // Every listed name is answered without another request.
    expect(await store.exists('p/layer/doc-01374.md')).toBe(true);
    expect(requests).toHaveLength(2);
  });
});

describe('a layer derivation outside a memo', () => {
  let fixture: TestProject;

  beforeEach(async () => {
    fixture = await freshProject();
  });

  afterEach(async () => {
    await teardown();
  });

  it('asks the store by folder, never one keyed question per document', async () => {
    const layer = fixture.layers[0]!;
    for (let i = 1; i <= 30; i += 1) await addDocument(fixture, layer.name, `v${i}`);
    const keys = (await listDocumentsByLayer(layer.id)).map((document) => storageKeyOf(document)).filter((key): key is string => Boolean(key));
    expect(keys.length).toBe(30);

    const store = getStorage();
    let keyed = 0;
    let folders = 0;
    const original = store.exists.bind(store);
    Object.defineProperty(store, 'exists', {
      configurable: true,
      value: async (key: string): Promise<boolean> => {
        keyed += 1;
        return await original(key);
      },
    });
    Object.defineProperty(store, 'namesIn', {
      configurable: true,
      value: async (prefix: string): Promise<string[]> => {
        folders += 1;
        return keys.filter((key) => key.startsWith(`${prefix}/`)).map((key) => key.slice(prefix.length + 1));
      },
    });

    try {
      const snapshot = await computeLayerState(layer.id);
      expect(snapshot.layerId).toBe(layer.id);
    } finally {
      delete (store as unknown as Record<string, unknown>)['exists'];
      delete (store as unknown as Record<string, unknown>)['namesIn'];
    }

    expect(keyed).toBe(0);
    expect(folders).toBeGreaterThan(0);
    expect(folders).toBeLessThanOrEqual(2);
  });
});
