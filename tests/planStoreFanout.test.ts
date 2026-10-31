/**
 * A plan asks the document store once per document, a bounded number at a time.
 *
 * `GET /api/projects/:id` is what the release gate's hosted verification calls
 * on its own project — hundreds of documents, more every deploy — and it called
 * `buildPlan` with no existence memo, so every document's bytes were asked
 * about twice, all at once. In cloud mode each question is a Supabase Storage
 * request backed by the same Postgres Brain depends on. On 2026-10-30 the
 * post-restart pass stalled right after that request and the 1 GB production
 * machine was OOM-killed three minutes later. The MCP door already had the
 * bound (`withProjectExistence`); this is the same bound at `buildPlan` itself,
 * so every caller inherits it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { buildPlan } from '../server/services/planner.ts';
import { getStorage } from '../server/services/storage/index.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

afterEach(async () => {
  await teardown();
});

describe('a plan read outside a recompute', () => {
  it('asks about each document at most once, never more than sixteen at a time', async () => {
    const layer = fixture.layers[0]!;
    const documents = 40;
    for (let i = 1; i <= documents; i += 1) {
      await addDocument(fixture, layer.name, `v${i}`);
    }

    const store = getStorage();
    // Force the per-key path, which is what an unlistable folder falls back to
    // and what the unbounded fan-out used.
    Object.defineProperty(store, 'namesIn', { value: undefined, configurable: true });
    const original = store.exists.bind(store);
    let inFlight = 0;
    let peak = 0;
    const asked = new Map<string, number>();
    Object.defineProperty(store, 'exists', {
      configurable: true,
      value: async (key: string): Promise<boolean> => {
        asked.set(key, (asked.get(key) ?? 0) + 1);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await original(key);
        } finally {
          inFlight -= 1;
        }
      },
    });

    try {
      const plan = await buildPlan(fixture.project.id);
      expect(plan.layers.length).toBeGreaterThan(0);
    } finally {
      delete (store as unknown as Record<string, unknown>)['exists'];
      delete (store as unknown as Record<string, unknown>)['namesIn'];
    }

    expect(asked.size).toBeGreaterThanOrEqual(documents);
    expect(Math.max(...asked.values())).toBe(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
