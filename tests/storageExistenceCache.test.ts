/**
 * The cloud store answers "is it there" once per key for a short while, and
 * never has more than a few such questions on the wire.
 *
 * Production, 2026-11-14: existence checks outside a recompute (every layer
 * derivation, every plan read) had no shared answer and no bound, and opened
 * 64-73 TLS connections a minute to the storage host. Only PRESENT is reused —
 * an ABSENT answer is asked again, so an upload from elsewhere is never read
 * as missing — and this process's own delete forgets the answer at once.
 */
import { describe, expect, it } from 'vitest';
import { STORE_EXISTENCE_CONCURRENCY, SupabaseStorageProvider } from '../server/services/storage/supabase.ts';

function bucket(present: Set<string>) {
  const seen = { asked: new Map<string, number>(), inFlight: 0, maxInFlight: 0 };
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { prefix?: string; search?: string };
    const key = body.search ? `${body.prefix}/${body.search}` : String(body.prefix);
    seen.asked.set(key, (seen.asked.get(key) ?? 0) + 1);
    seen.inFlight += 1;
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.inFlight -= 1;
    const entries = body.search && present.has(key) ? [{ name: body.search, id: body.search }] : [];
    return new Response(JSON.stringify(entries), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const store = new SupabaseStorageProvider({ url: 'https://example.supabase.co', serviceRoleKey: 'k', bucket: 'b', fetchImpl });
  return { store, seen };
}

describe('the cloud store\'s existence answers', () => {
  it('reuses PRESENT, asks ABSENT again, and shares one request between simultaneous askers', async () => {
    const { store, seen } = bucket(new Set(['p/a.md']));
    const [one, two] = await Promise.all([store.exists('p/a.md'), store.exists('p/a.md')]);
    expect([one, two]).toEqual([true, true]);
    expect(await store.exists('p/a.md')).toBe(true);
    expect(seen.asked.get('p/a.md')).toBe(1);

    expect(await store.exists('p/gone.md')).toBe(false);
    expect(await store.exists('p/gone.md')).toBe(false);
    expect(seen.asked.get('p/gone.md')).toBe(2);
  });

  it('forgets a PRESENT answer when this process deletes the object', async () => {
    const present = new Set(['p/a.md']);
    const { store, seen } = bucket(present);
    expect(await store.exists('p/a.md')).toBe(true);
    present.delete('p/a.md');
    await store.remove('p/a.md');
    expect(await store.exists('p/a.md')).toBe(false);
    expect(seen.asked.get('p/a.md')).toBe(2);
  });

  it('keeps a bounded number of existence questions on the wire', async () => {
    const keys = [...Array(30)].map((_, i) => `p/doc-${i}.md`);
    const { store, seen } = bucket(new Set(keys));
    await Promise.all(keys.map((key) => store.exists(key)));
    expect(seen.maxInFlight).toBeLessThanOrEqual(STORE_EXISTENCE_CONCURRENCY);
    expect(seen.maxInFlight).toBeGreaterThan(1);
  });
});
