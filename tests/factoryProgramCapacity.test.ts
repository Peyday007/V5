/**
 * The Factory's capacity reading and a program's production checks (§96).
 *
 * Capacity is judged from the shapes production writes: bin timelines, idle
 * events, release runs. The checks are the release verifier's own, run in
 * process; a probe nobody registered answers UNKNOWN, never PASS.
 */
import { describe, expect, it } from 'vitest';
import { computeCapacity, overlap, type BinTimeline } from '../server/services/factory/program/capacity.ts';
import { runRequirementChecks } from '../server/services/factory/program/ports.ts';
import { registerProbe } from '../server/services/factory/program/probes.ts';

const at = (minutes: number): string => new Date(Date.parse('2026-11-09T00:00:00.000Z') + minutes * 60_000).toISOString();

function bin(kind: string, ready: number, assigned: number, done: number, outcome = 'COMPLETE', extra: Partial<BinTimeline> = {}): BinTimeline {
  return { binId: `${kind}-${ready}`, kind, campaignId: 'c', readyAt: at(ready), assignedAt: [at(assigned)], terminalAt: at(done), terminalOutcome: outcome, leaseExpiries: 0, noShows: 0, ...extra };
}

const base = {
  since: at(0),
  until: at(600),
  repairUnits: [],
  releaseRuns: [{ createdAt: at(300), finishedAt: at(340), state: 'LIVE' }],
  campaignsCompleted: 2,
  unitsIntegrated: 6,
  requirementsVerified: 9,
  dedupedSubmissions: 1,
  supersededUnits: 0,
  idleEvents: [] as Array<{ kind: string; at: string }>,
  fleet: { registered: 3, usable: 2, inFlight: 1, admissionLimit: 3 },
  readyBinsNow: 0,
};

describe('capacity', () => {
  it('measures overlap as a peak and a time average', () => {
    expect(overlap([[0, 10], [5, 15], [20, 30]], 30)).toEqual({ peak: 2, average: 1 });
  });

  it('reads stage times, throughput and failures from bin timelines', () => {
    const reading = computeCapacity({
      ...base,
      bins: [
        bin('FACTORY_PLAN', 0, 2, 12),
        bin('FACTORY_UNITS', 12, 13, 73),
        bin('FACTORY_UNITS', 12, 14, 64),
        bin('FACTORY_INTEGRATE', 74, 75, 90),
        bin('FACTORY_REVIEW', 90, 92, 110),
        bin('FACTORY_UNITS', 120, 125, 130, 'FAILED', { noShows: 1 }),
      ],
    });
    expect(reading.planningMs.medianMs).toBe(10 * 60_000);
    expect(reading.codingMs.samples).toBe(2);
    expect(reading.integrationAndReviewMs.samples).toBe(2);
    expect(reading.releaseMs.medianMs).toBe(40 * 60_000);
    expect(reading.concurrency.peak).toBe(2);
    expect(reading.completed.perHour).toBe(0.6);
    expect(reading.requirements.perHour).toBe(0.9);
    expect(reading.failures).toMatchObject({ binsFailed: 1, noShows: 1, dedupedSubmissions: 1 });
    expect(reading.bottleneck).toBe('WORK_ITSELF');
    expect(reading.recommendation.join(' ')).toMatch(/larger server is not indicated/);
  });

  it('calls idle capacity beside ready work a scheduling defect before anything else', () => {
    const reading = computeCapacity({
      ...base,
      bins: [bin('FACTORY_UNITS', 0, 100, 160)],
      idleEvents: [{ kind: 'FACTORY_IDLE_STARTED', at: at(0) }, { kind: 'FACTORY_IDLE_ENDED', at: at(100) }],
    });
    expect(reading.bottleneck).toBe('SCHEDULING');
  });

  it('calls long queues with every usable surface busy a worker shortage', () => {
    const reading = computeCapacity({
      ...base,
      bins: [bin('FACTORY_UNITS', 0, 90, 120), bin('FACTORY_UNITS', 0, 95, 125), bin('FACTORY_UNITS', 0, 100, 130)],
    });
    expect(reading.bottleneck).toBe('WORKERS');
  });

  it('names the release pipeline when it dwarfs building, and unusable surfaces', () => {
    const reading = computeCapacity({
      ...base,
      releaseRuns: [{ createdAt: at(100), finishedAt: at(212), state: 'LIVE' }],
      fleet: { registered: 7, usable: 1, inFlight: 0, admissionLimit: 15 },
      bins: [bin('FACTORY_PLAN', 0, 0, 1), bin('FACTORY_UNITS', 1, 1, 4), bin('FACTORY_REVIEW', 4, 4, 6)],
    });
    expect(reading.bottleneck).toBe('RELEASE');
    expect(reading.recommendation.join(' ')).toMatch(/Only 1 of 7 registered factory surfaces/);
  });

  it('says there is no data rather than inventing a bottleneck', () => {
    expect(computeCapacity({ ...base, bins: [] }).bottleneck).toBe('NO_DATA');
  });
});

describe('production checks', () => {
  const page = '<html><script src="/assets/app-1.js"></script></html>';
  const fakeFetch = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    if (path === '/healthz') return new Response('ok', { status: 200 });
    if (path === '/') return new Response(page, { status: 200 });
    if (path === '/assets/app-1.js') return new Response('const x = "Program verdict";', { status: 200 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;

  it('runs HTTP and bundle checks through the release verifier and probes in process', async () => {
    registerProbe('test.always-true', async () => ({ ok: true, detail: 'yes' }));
    const results = await runRequirementChecks(
      [
        { kind: 'HTTP', path: '/healthz', expectStatus: 200, expectText: 'ok' },
        { kind: 'BUNDLE_TEXT', text: 'Program verdict' },
        { kind: 'BUNDLE_TEXT', text: 'not shipped yet' },
        { kind: 'PROBE', probe: 'test.always-true' },
        { kind: 'PROBE', probe: 'nobody.registered.this' },
      ],
      { baseUrl: 'http://127.0.0.1:9', fetch: fakeFetch },
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true, null]);
    expect(results[4]!.detail).toMatch(/no such probe/);
  });
});

describe('a probe whose source did not answer', () => {
  it('reads a forge that did not answer as unknown, and only its 404 as an absence', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    process.env.BRAIN_REVISION = 'a'.repeat(40);
    try {
      const { getProbe } = await import('../server/services/factory/program/probes.ts');
      const probe = getProbe('repo.file-at-revision')!;
      const respond = (status: number, body = '') =>
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'x-ratelimit-remaining': '0' } })));
      respond(403, '{"message":"API rate limit exceeded"}');
      expect((await probe({ path: 'docs/a.md', contains: 'x' })).ok).toBeNull();
      respond(404);
      expect((await probe({ path: 'docs/b.md' })).ok).toBe(false);
      respond(200, JSON.stringify({ content: Buffer.from('hello program-submit').toString('base64'), encoding: 'base64' }));
      expect((await probe({ path: 'docs/c.md', contains: 'program-submit' })).ok).toBe(true);
      // Cached per revision: a second read of the same file costs no request.
      respond(500);
      expect((await probe({ path: 'docs/c.md', contains: 'program-submit' })).ok).toBe(true);
    } finally {
      delete process.env.BRAIN_REVISION;
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
