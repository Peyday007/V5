/**
 * One recompute asks the store about each document once.
 *
 * The defect this pins, measured on the deployed Brain: the hosted
 * verification's JUDGE submission took 12m26s over a 415-document archive and
 * then more than fifteen minutes over 431, and filing the synthesis took 4m44s
 * and then 9m13s. Both mutations end in `recomputeProject`, and one recompute
 * asked the bucket whether each document's bytes exist several times over — the
 * file-state pass, the dependency refresh and the planner each asked again —
 * one serial round trip at a time, inside the recompute's transaction. The cost
 * grew with the archive, and the verification's own project is an archive that
 * grows on every deploy, so every later deploy would have failed at the same
 * step.
 *
 * So the fake bucket here answers with a delay and counts, per key, how often it
 * was asked and how many requests were in flight at once. The assertions are
 * about the store rather than about timing: each key asked once, concurrently,
 * and a document whose bytes are gone still read as missing — the memo can only
 * save round trips, never change an answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { initStorage, resetStorage } from '../server/services/storage/index.ts';
import { createDocument, getDocument } from '../server/repos/documents.ts';
import { listLayers } from '../server/repos/layers.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';

interface Counting {
  asked: Map<string, number>;
  inFlight: number;
  maxInFlight: number;
}

function countingBucket(present: Set<string>): { counting: Counting; fetchImpl: typeof fetch } {
  const counting: Counting = { asked: new Map(), inFlight: 0, maxInFlight: 0 };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (/\/storage\/v1\/object\/list\/[^/?]+$/.test(href)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prefix?: string; search?: string };
      const prefix = (body.prefix ?? '').replace(/^\/+|\/+$/g, '');
      const key = body.search ? `${prefix}/${body.search}` : prefix;
      counting.asked.set(key, (counting.asked.get(key) ?? 0) + 1);
      counting.inFlight += 1;
      counting.maxInFlight = Math.max(counting.maxInFlight, counting.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      counting.inFlight -= 1;
      const entries = present.has(key) && body.search
        ? [{ name: body.search, id: body.search, metadata: { size: 1 }, updated_at: '2026-01-01T00:00:00.000Z' }]
        : [];
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;
  return { counting, fetchImpl };
}

let projectId = '';
let counting: Counting;
const keys: string[] = [];
let missingKey = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const layer = (await listLayers(projectId))[0]!;
  keys.length = 0;
  for (let index = 0; index < 12; index += 1) {
    keys.push(`projects/${projectId}/documents/doc_${index}/original/report-${index}.md`);
  }
  missingKey = `projects/${projectId}/documents/doc_gone/original/gone.md`;
  const fake = countingBucket(new Set(keys));
  counting = fake.counting;
  resetStorage();
  await initStorage({
    config: {
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      bucket: 'brain',
    },
    fetchImpl: fake.fetchImpl,
    verify: false,
  });
  for (const [index, key] of [...keys, missingKey].entries()) {
    await createDocument({
      projectId,
      layerId: layer.id,
      canonicalName: `Report ${index}`,
      version: `v${index + 1}`,
      versionSort: String(index + 1).padStart(6, '0'),
      documentType: 'FOUNDATION',
      status: 'COMPLETE',
      filename: key.split('/').at(-1)!,
      filesystemPath: key,
      storageKey: key,
    });
  }
  counting.asked.clear();
  counting.maxInFlight = 0;
});

afterEach(async () => {
  resetStorage();
  await teardown();
});

describe('a recompute and the document store', () => {
  it('asks about each document once, concurrently, and still finds the one that is gone', async () => {
    await recomputeProject(projectId);

    for (const key of [...keys, missingKey]) {
      expect(counting.asked.get(key), `${key} was asked ${counting.asked.get(key) ?? 0} time(s)`).toBe(1);
    }
    expect(counting.maxInFlight).toBeGreaterThan(1);

    // The memo saves round trips and never changes an answer.
    const { listDocuments } = await import('../server/repos/documents.ts');
    const documents = await listDocuments(projectId);
    const gone = documents.find((document) => document.storageKey === missingKey)!;
    expect((await getDocument(gone.id))?.fileMissing).toBe(true);
    expect(documents.filter((document) => document.fileMissing)).toHaveLength(1);
  });

  it('asks again on the next recompute, because a memo that outlived one would be a stale cache', async () => {
    await recomputeProject(projectId);
    await recomputeProject(projectId);
    expect(counting.asked.get(keys[0]!)).toBe(2);
  });
});
