import { describe, expect, it } from 'vitest';
import {
  HostLimiter, TokenBucket, classifyFailure, fakeClock, memoryCheckpoints, outcomeOf, runCheckpointed, runSources, withRetry,
} from '../server/services/collect/runtime/index.ts';

describe('token bucket', () => {
  it('never exceeds the host rate under parallel callers', async () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket(clock, 1, 2); // 2/s
    const times: number[] = [];
    await Promise.all(Array.from({ length: 10 }, async () => { await bucket.acquire(); times.push(clock.now()); }));
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(499);
  });
  it('keeps hosts independent', async () => {
    const clock = fakeClock(0);
    const l = new HostLimiter(clock);
    await l.acquire('a.example'); await l.acquire('b.example');
    expect(clock.now()).toBe(0);
  });
});

describe('failures', () => {
  it('classifies', () => {
    expect(classifyFailure(new Error('HTTP 503')).retryable).toBe(true);
    expect(classifyFailure(new Error('HTTP 429')).cause).toBe('RATE_LIMITED');
    expect(classifyFailure(new Error('timed out after 20000ms')).retryable).toBe(true);
    for (const s of [401, 403, 410]) expect(classifyFailure(new Error(`HTTP ${s}`)).retryable).toBe(false);
    expect(classifyFailure(new Error('blocked by robots.txt')).retryable).toBe(false);
  });
  it('retries temporary failures with backoff, not permanent ones', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const r = await withRetry(clock, async () => { if (++calls < 3) throw new Error('HTTP 500'); return 'ok'; });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(clock.now()).toBe(1000 + 2000);
    let c2 = 0;
    const p = await withRetry(clock, async () => { c2++; throw new Error('HTTP 403'); });
    expect(c2).toBe(1);
    expect(p.failure?.cause).toBe('FORBIDDEN');
  });
});

describe('isolation and outcomes', () => {
  it('one failing source leaves the others unaffected', async () => {
    const clock = fakeClock(0);
    const out = await runSources({
      clock, limiter: new HostLimiter(clock), hasInternet: true,
      tasks: [
        { id: 'bad', url: 'https://bad.example/x', run: async () => { throw new Error('HTTP 403'); } },
        { id: 'good', url: 'https://good.example/x', run: async () => ({ records: 3 }) },
        { id: 'empty', url: 'https://empty.example/x', run: async () => ({ records: 0 }) },
        { id: 'down', url: 'https://down.example/x', run: async () => { throw new Error('fetch failed (ENOTFOUND)'); } },
      ],
    });
    const by = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(by.good!.outcome).toBe('RECORDS');
    expect(by.bad!.outcome).toBe('SOURCE_UNREACHABLE');
    expect(by.bad!.attempts).toBe(1);
    expect(by.empty!.outcome).toBe('NO_MATCHING_RECORDS');
    expect(by.down!.outcome).toBe('SOURCE_UNREACHABLE');
    expect(by.down!.attempts).toBe(4);
  });
  it('refuses internet work on a surface without internet', async () => {
    const clock = fakeClock(0);
    const out = await runSources({ clock, limiter: new HostLimiter(clock), hasInternet: false,
      tasks: [{ id: 'a', url: 'https://a.example', run: async () => ({ records: 1 }) }] });
    expect(out[0]!.outcome).toBe('REFUSED_NO_INTERNET');
  });
  it('outcomeOf separates unreachable from empty', () => {
    expect(outcomeOf({ ok: false }, 0)).toBe('SOURCE_UNREACHABLE');
    expect(outcomeOf({ ok: true }, 0)).toBe('NO_MATCHING_RECORDS');
  });
});

describe('checkpoints', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ k: `k${i}` }));
  it('resumes after an interruption with no duplicate or missing item', async () => {
    const store = memoryCheckpoints();
    const committed: string[] = [];
    const base = { jobKey: 'j', items, keyOf: (i: { k: string }) => i.k, commit: async (b: { k: string }[]) => { committed.push(...b.map((x) => x.k)); }, store, batchSize: 10 };
    const first = await runCheckpointed({ ...base, stopAfterBatches: 1 });
    expect(first.done).toBe(false);
    const second = await runCheckpointed(base);
    expect(second).toMatchObject({ done: true, resumedFrom: 10 });
    expect(committed).toHaveLength(25);
    expect(new Set(committed).size).toBe(25);
  });
  it('a redelivered batch is idempotent even if the checkpoint was lost', async () => {
    const store = memoryCheckpoints();
    const committed: string[] = [];
    const base = { jobKey: 'j2', items, keyOf: (i: { k: string }) => i.k, commit: async (b: { k: string }[]) => { committed.push(...b.map((x) => x.k)); }, store, batchSize: 10 };
    await runCheckpointed(base);
    store.data.set('j2', { next: 0, seen: store.data.get('j2')!.seen });
    const again = await runCheckpointed(base);
    expect(again.committed).toBe(0);
    expect(committed).toHaveLength(25);
  });
});
