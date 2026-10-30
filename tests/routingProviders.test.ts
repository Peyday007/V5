/**
 * Provider capacity for the cheap lane: a down provider is not called before
 * its retry time, a burst over a stored limit is deferred, and an unsupported
 * answer is never stored as verified.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { screenOpening, type Completer, type LaneConfig } from '../server/services/cheap/lane.ts';
import { ProviderCapacity, ProviderHttpError, parseRetryAfter, storedRateLimit } from '../server/services/routing/providers/capacity.ts';

const input = { title: 'County needs parcel list', mechanism: 'PUBLISHED_REQUEST', source: 'https://example.gov/rfq', payer: 'County', buyingSignal: 'RFQ', deadline: '2026-11-01', price: '1500 USD' };
const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1'], dailyBudget: 100, timeoutMs: 1000 };
const keep = '{"verdict":"KEEP","window":"SHORT","tags":["a"],"reason":"posted"}';
const t0 = new Date('2026-10-30T12:00:00.000Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

beforeEach(async () => { await freshProject(); });

describe('cooldown', () => {
  it('does not call a down provider again until its retry time', async () => {
    const capacity = new ProviderCapacity(() => null);
    let calls = 0;
    const completer: Completer = async () => { calls++; throw new ProviderHttpError(429, 120_000); };
    await screenOpening('s1', input, { config, completer, now: t0, capacity });
    expect(calls).toBe(1);
    await screenOpening('s2', { ...input, title: 'other' }, { config, completer, now: later(60_000), capacity });
    expect(calls).toBe(1); // inside the stated 120s: deferred
    const ok: Completer = async () => { calls++; return keep; };
    const out = await screenOpening('s3', { ...input, title: 'third' }, { config, completer: ok, now: later(121_000), capacity });
    expect(calls).toBe(2);
    expect(out?.verdict).toBe('KEEP');
  });
  it('backs off without a stated time, doubling, and clears on success', () => {
    const c = new ProviderCapacity(() => null);
    const until1 = c.failure('p', new ProviderHttpError(503, null), t0)!;
    const until2 = c.failure('p', new ProviderHttpError(503, null), t0)!;
    expect(until2.getTime() - t0.getTime()).toBe(2 * (until1.getTime() - t0.getTime()));
    c.success('p');
    expect(c.reserve('p', t0).allowed).toBe(true);
  });
  it('treats a bad input answer as not the provider’s fault', () => {
    const c = new ProviderCapacity(() => null);
    expect(c.failure('p', new ProviderHttpError(400, null), t0)).toBeNull();
    expect(c.reserve('p', t0).allowed).toBe(true);
  });
  it('writes nothing for a deferral', async () => {
    const capacity = new ProviderCapacity(() => null);
    capacity.failure('cheap.test|m1', new ProviderHttpError(429, 600_000), t0);
    await screenOpening('s1', input, { config, completer: async () => keep, now: later(1000), capacity });
    const n = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM cheap_results');
    expect(Number(n?.n)).toBe(0);
  });
});

describe('stored rate limit', () => {
  it('defers a burst above the limit to when the oldest call leaves the window', () => {
    const c = new ProviderCapacity(() => 2);
    expect(c.reserve('p', t0).allowed).toBe(true);
    expect(c.reserve('p', later(1000)).allowed).toBe(true);
    const third = c.reserve('p', later(2000));
    expect(third).toMatchObject({ allowed: false, reason: 'RATE_LIMIT_DEFERRED' });
    if (!third.allowed) expect(third.retryAt.getTime()).toBe(t0.getTime() + 60_000);
    expect(c.reserve('p', later(60_001)).allowed).toBe(true);
  });
  it('invents no limit when none is stored', () => {
    expect(storedRateLimit({})).toBeNull();
    expect(storedRateLimit({ BRAIN_CHEAP_LLM_RPM: '30' })).toBe(30);
    const c = new ProviderCapacity(() => null);
    for (let i = 0; i < 500; i++) expect(c.reserve('p', t0).allowed).toBe(true);
  });
  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('Fri, 30 Oct 2026 12:01:00 GMT', t0)).toBe(60_000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('free-model answers stay a sorting signal', () => {
  it('stores an unsupported answer as failed, never as verified', async () => {
    const out = await screenOpening('s1', input, { config, completer: async () => '{"verdict":"KEEP","verified":true}', now: t0, capacity: new ProviderCapacity(() => null) });
    expect(out).toBeNull();
    const rows = await getDb().all<{ ok: number; output: string | null }>('SELECT ok, output FROM cheap_results');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.ok)).toBe(0);
    expect(rows[0]!.output).toBeNull();
  });
  it('a valid answer carries no verified marker', async () => {
    await screenOpening('s1', input, { config, completer: async () => keep, now: t0, capacity: new ProviderCapacity(() => null) });
    const rows = await getDb().all<{ output: string | null }>('SELECT output FROM cheap_results');
    expect(rows[0]!.output).not.toMatch(/verified/i);
  });
});
