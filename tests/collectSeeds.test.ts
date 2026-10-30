import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { SEED_MAPPINGS, SEED_SOURCES, seedSources } from '../server/services/collect/seeds/index.ts';
import { judgeRobots, recordRobotsChecks, robotsAllows } from '../server/services/collect/seeds/robots.ts';
import { buildReport, renderReport } from '../server/services/collect/report/index.ts';
import { listCollectSources } from '../server/repos/collectSources.ts';
import { recordPullMetrics } from '../server/repos/collectMetrics.ts';
import { SOURCE_ROWS } from '../server/services/feeds/sources.ts';
import { collect } from '../server/services/collect/collectors/index.ts';

beforeEach(async () => { await freshProject(); });

describe('seed sources', () => {
  it('has at least five keyless sources across at least three kinds, none with a key in its URL', () => {
    expect(SEED_SOURCES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SEED_SOURCES.map((s) => s.kind)).size).toBeGreaterThanOrEqual(3);
    for (const s of SEED_SOURCES) {
      expect(s.urlTemplate).toMatch(/^https:\/\//);
      expect(s.urlTemplate).not.toMatch(/api[_-]?key|token|secret/i);
      expect(SEED_MAPPINGS[s.parserId]).toBeDefined();
    }
  });
  it('has one definition: every shared in-code source is seeded, and nothing is seeded that is not in code', () => {
    const shared = SOURCE_ROWS.filter((r) => r.ownerProjectId === null).map((r) => r.id).sort();
    expect(SEED_SOURCES.map((s) => s.slug).sort()).toEqual(shared);
  });
  it('seeds idempotently and leaves robots unchecked, so nothing is due before it is read', async () => {
    const first = await seedSources();
    const second = await seedSources();
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    expect((await listCollectSources(null)).filter((s) => SEED_SOURCES.some((x) => x.slug === s.slug))).toHaveLength(SEED_SOURCES.length);
    expect(first.every((s) => s.robotsStatus === 'UNCHECKED')).toBe(true);
  });
  it('the federal-register mapping reads a real-shaped body through the shared JSON collector', () => {
    const body = JSON.stringify({ results: [{ document_number: '2026-1', title: 'A rule', html_url: 'https://www.federalregister.gov/d/2026-1', publication_date: '2026-10-29', abstract: 'Text' }] });
    const out = collect('JSON_API', { status: 200, body }, { url: 'https://www.federalregister.gov/api', mapping: SEED_MAPPINGS['json:federal-register'] });
    expect(out.kind).toBe('RECORDS');
  });
});

describe('robots', () => {
  const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: brain-feed\nDisallow: /blocked\n';
  it('applies the most specific group and the longest rule', () => {
    expect(robotsAllows(robots, '/blocked/x', 'brain-feed')).toBe(false);
    expect(robotsAllows(robots, '/private', 'brain-feed')).toBe(true);
    expect(robotsAllows(robots, '/private', 'other')).toBe(false);
    expect(robotsAllows(robots, '/private/open/a', 'other')).toBe(true);
  });
  it('never turns an unreadable answer into permission', () => {
    expect(judgeRobots({ status: 503, body: '', path: '/', agent: 'brain-feed' }).status).toBe('UNCHECKED');
    expect(judgeRobots({ status: null, body: '', path: '/', agent: 'brain-feed', error: 'ENOTFOUND' }).status).toBe('UNCHECKED');
    expect(judgeRobots({ status: 404, body: '', path: '/', agent: 'brain-feed' }).status).toBe('ALLOWED');
    expect(judgeRobots({ status: 200, body: 'User-agent: *\nDisallow: /', path: '/x', agent: 'brain-feed' }).status).toBe('DISALLOWED');
  });
  it('records what each publisher said, with the time', async () => {
    await seedSources();
    const out = await recordRobotsChecks(async (url) => (url.includes('fda.gov') ? { status: 200, body: 'User-agent: *\nDisallow: /' } : { status: 404, body: '' }));
    expect(out.find((c) => c.slug === 'fda-recalls-rss')?.status).toBe('DISALLOWED');
    const rows = await listCollectSources(null);
    expect(rows.find((s) => s.slug === 'cisa-advisories-rss')).toMatchObject({ robotsStatus: 'ALLOWED' });
    expect(rows.find((s) => s.slug === 'cisa-advisories-rss')?.robotsCheckedAt).not.toBeNull();
  });
});

describe('report', () => {
  it('reads rows only: unmeasured stays unmeasured and measured pulls are summed', async () => {
    await seedSources();
    const empty = await buildReport();
    expect(empty.totals.pulls).toBe(0);
    expect(empty.totals.wallMs).toBeNull();
    expect(empty.bottleneck).toBeNull();
    expect(renderReport(empty)).toContain('not measured');
    await recordPullMetrics('cisa-advisories-rss', true, { method: 'RSS_ATOM', fetched: 20, inserted: 15, duplicates: 5, relevant: null, signals: null, failureCause: null, wallMs: 400, bytes: 9000, memoryBytes: null, cheapCalls: 0, claudeJobs: 0 });
    await recordPullMetrics('fr-notices', false, { method: 'JSON_API', fetched: 0, inserted: 0, duplicates: null, relevant: null, signals: null, failureCause: 'SOURCE_UNREACHABLE', wallMs: null, bytes: null, memoryBytes: null, cheapCalls: null, claudeJobs: null }, 'timed out');
    const r = await buildReport();
    expect(r.totals).toMatchObject({ pulls: 2, failedPulls: 1, fetched: 20, inserted: 15, duplicates: 5, claudeJobs: 0 });
    expect(r.sources.find((s) => s.source === 'fr-notices')?.failuresByCause).toEqual({ SOURCE_UNREACHABLE: 1 });
    expect(r.bottleneck).toContain('cisa-advisories-rss');
    expect(r.totals.recordsPerMinute).toBe(3000);
  });
});
