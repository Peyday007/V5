/**
 * The source registry runs the feeds: the hardcoded sources are rows with the
 * behaviour they always had, a new source of an existing kind is an insert, and
 * a private project's sources and records are its own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { getDb } from '../server/db/database.ts';
import { addCollectSource, listCollectSources, setRobotsStatus } from '../server/repos/collectSources.ts';
import { FEED_SOURCES, SITE_SWEEP_SLUG, seedRows } from '../server/services/feeds/sources.ts';
import {
  ensureSeededSources,
  failureCauseOf,
  feedItemsVisibleTo,
  pullDueFeeds,
  robotsAllows,
  shortlistFunnel,
  type TextFetcher,
} from '../server/services/feeds/run.ts';
import { classifyFailure } from '../server/services/collect/runtime/index.ts';

const now = new Date();
let projectA = '';
let projectB = '';

beforeEach(async () => {
  projectA = (await freshProject()).project.id;
  projectB = (await createProject({ name: 'Other', slug: 'other-registry' })).id;
});

const html = (body: string, extra: Partial<Awaited<ReturnType<TextFetcher>>> = {}) => async () => ({ status: 200, body, ...extra });
const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Acme needs a pricing sheet</title><link>https://example.test/a</link><guid>a-1</guid><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item>
  <item><title>Beta wants a data cleanup</title><link>https://example.test/b</link><guid>b-1</guid></item>
</channel></rss>`;

describe('the hardcoded sources are rows', () => {
  it('seeds every definition and the site sweep once, with the same URL and interval', async () => {
    await ensureSeededSources();
    await ensureSeededSources();
    const rows = await listCollectSources(null);
    expect(rows.map((r) => r.slug).sort()).toEqual([...FEED_SOURCES.map((s) => s.id), SITE_SWEEP_SLUG].sort());
    for (const source of FEED_SOURCES) {
      const row = rows.find((r) => r.slug === source.id)!;
      expect(row.urlTemplate).toBe(source.url);
      expect(row.intervalMs).toBe(source.intervalMs);
      expect(row.robotsStatus).toBe('ALLOWED');
    }
    expect(seedRows().find((r) => r.slug === 'news-shutdown')?.hostRatePerMin).toBe(5);
  });

  it('pulls the three bulk sources from their rows to the same items as the definitions', async () => {
    const bodies: Record<string, unknown> = {
      'https://remoteok.com/api': [{ legal: true }, { id: 7, position: 'Data analyst', company: 'Acme', url: 'https://remoteok.com/remote-jobs/7' }],
      'https://remotive.com/api/remote-jobs?limit=300': { jobs: [{ id: 9, title: 'Writer', url: 'https://remotive.com/j/9', company_name: 'Beta' }] },
    };
    const fetcher = async (url: string) => bodies[url] ?? (url.includes('federalregister') ? { results: [{ document_number: 'R-1', title: 'A rule', html_url: 'https://www.federalregister.gov/r/1', agencies: [{ name: 'EPA' }] }] } : { articles: [] });
    const pulled = await pullDueFeeds({ now, fetcher });
    const by = Object.fromEntries(pulled.map((p) => [p.source, p]));
    expect(by['remoteok']).toMatchObject({ inserted: 1, error: null });
    expect(by['remotive']).toMatchObject({ inserted: 1, error: null });
    expect(by['federal-register-rules']).toMatchObject({ inserted: 1, error: null });
    const held = await feedItemsVisibleTo(null);
    expect(held.find((i) => i.externalId === '7')).toMatchObject({ title: 'Data analyst', organization: 'Acme', source: 'remoteok' });
    // Nothing is due again until the interval passes.
    expect(await pullDueFeeds({ now, fetcher })).toEqual([]);
  });

  it('records the method, duplicates and a different cause for no records and for unreachable', async () => {
    await pullDueFeeds({ now, fetcher: async (url) => { if (url.includes('remoteok')) throw new Error('fetch failed (ENOTFOUND)'); return url.includes('remotive') ? { jobs: [] } : { results: [] }; } });
    const pulls = await getDb().all<{ source: string; ok: number; failure_cause: string | null; method: string | null }>(
      `SELECT source, ok, failure_cause, method FROM feed_pulls WHERE source IN ('remoteok','remotive')`);
    const ok = pulls.find((p) => p.source === 'remotive')!;
    const bad = pulls.find((p) => p.source === 'remoteok')!;
    expect(ok).toMatchObject({ ok: 1, failure_cause: 'NO_MATCHING_RECORDS', method: 'JSON_API' });
    expect(bad).toMatchObject({ ok: 0, failure_cause: 'SOURCE_UNREACHABLE' });
    expect(failureCauseOf(classifyFailure(new Error('HTTP 403')))).toBe('REFUSED');
    expect(failureCauseOf(classifyFailure(new Error('HTTP 503')))).toBe('SERVER_ERROR');
  });
});

describe('a new source is an insert', () => {
  it('pulls an RSS row added with no code change, and sends validators on the next conditional request', async () => {
    await ensureSeededSources();
    await addCollectSource({ slug: 'industry-rss', label: 'Industry RSS', kind: 'RSS_ATOM', urlTemplate: 'https://example.test/feed.xml', parserId: 'collector', intervalMs: 3_600_000 });
    const seen: Record<string, string>[] = [];
    const text: TextFetcher = async (url, headers) => {
      if (url.endsWith('/robots.txt')) return { status: 200, body: 'User-agent: *\nDisallow: /private/' };
      seen.push(headers);
      return { status: 200, body: rss, etag: '"v1"' };
    };
    const first = await pullDueFeeds({ now, fetcher: async () => ({ jobs: [], results: [], articles: [] }), textFetcher: text });
    expect(first.find((p) => p.source === 'industry-rss')).toMatchObject({ inserted: 2, error: null });
    const row = (await listCollectSources(null)).find((r) => r.slug === 'industry-rss')!;
    expect(row.robotsStatus).toBe('ALLOWED');
    const later = new Date(now.getTime() + 2 * 3_600_000);
    const second = await pullDueFeeds({ now: later, fetcher: async () => ({ jobs: [], results: [], articles: [] }), textFetcher: async (u, h) => { seen.push(h); return u.endsWith('robots.txt') ? { status: 404, body: '' } : { status: 304, body: '' }; } });
    expect(second.find((p) => p.source === 'industry-rss')).toMatchObject({ inserted: 0, error: null });
    expect(seen.at(-1)?.['if-none-match']).toBe('"v1"');
  });

  it('never pulls a source its robots.txt disallows, and records why', async () => {
    await addCollectSource({ slug: 'walled', label: 'Walled', kind: 'HTML_LIST', urlTemplate: 'https://example.test/private/list', parserId: 'collector', intervalMs: 3_600_000 });
    let hit = 0;
    const text: TextFetcher = async (url) => {
      if (url.endsWith('/robots.txt')) return { status: 200, body: 'User-agent: *\nDisallow: /private/' };
      hit += 1;
      return { status: 200, body: '<ul></ul>' };
    };
    const out = await pullDueFeeds({ now, fetcher: async () => ({}), textFetcher: text });
    expect(out.find((p) => p.source === 'walled')).toBeUndefined();
    expect(hit).toBe(0);
    const row = (await listCollectSources(null)).find((r) => r.slug === 'walled')!;
    expect(row.robotsStatus).toBe('DISALLOWED');
  });

  it('records a refusal and does not work around it', async () => {
    const row = await addCollectSource({ slug: 'forbidden', label: 'F', kind: 'RSS_ATOM', urlTemplate: 'https://example.test/f.xml', parserId: 'collector', intervalMs: 3_600_000 });
    await setRobotsStatus(row.id, 'ALLOWED', 'checked');
    const out = await pullDueFeeds({ now, fetcher: async () => ({}), textFetcher: html('no', { status: 403 }) });
    expect(out.find((p) => p.source === 'forbidden')?.error).toMatch(/HTTP 403/);
    const pull = await getDb().get<{ failure_cause: string }>(`SELECT failure_cause FROM feed_pulls WHERE source = 'forbidden'`);
    expect(pull?.failure_cause).toBe('REFUSED');
  });

  it('isolates a failing source: the others still pull', async () => {
    const out = await pullDueFeeds({ now, fetcher: async (url) => { if (url.includes('remoteok')) throw new Error('HTTP 500'); return url.includes('remotive') ? { jobs: [{ id: 1, title: 'T', url: 'https://remotive.com/1' }] } : { results: [] }; } });
    expect(out.find((p) => p.source === 'remoteok')?.error).toBe('HTTP 500');
    expect(out.find((p) => p.source === 'remotive')?.inserted).toBe(1);
  });
});

describe('a private project owns its sources and records', () => {
  it('shows a source and its items to the owning project only, and keeps them out of another shortlist', async () => {
    const row = await addCollectSource({ projectId: projectA, slug: 'a-private', label: 'A private feed', kind: 'RSS_ATOM', urlTemplate: 'https://example.test/private.xml', parserId: 'collector', intervalMs: 3_600_000 });
    await setRobotsStatus(row.id, 'ALLOWED', 'checked');
    await pullDueFeeds({ now, fetcher: async () => ({ jobs: [], results: [], articles: [] }), textFetcher: html(rss) });
    expect((await listCollectSources(projectA)).some((r) => r.slug === 'a-private')).toBe(true);
    expect((await listCollectSources(projectB)).some((r) => r.slug === 'a-private')).toBe(false);
    expect((await listCollectSources(null)).some((r) => r.slug === 'a-private')).toBe(false);
    expect((await feedItemsVisibleTo(projectA)).filter((i) => i.source === 'a-private')).toHaveLength(2);
    expect((await feedItemsVisibleTo(projectB)).filter((i) => i.source === 'a-private')).toHaveLength(0);
    expect((await feedItemsVisibleTo(null)).filter((i) => i.source === 'a-private')).toHaveLength(0);
    // Another project's shortlist pool does not contain it, while the owner's does.
    expect((await shortlistFunnel(projectB, now)).pool).toBe(0);
    expect((await shortlistFunnel(projectA, now)).pool).toBe(2);
  });
});

describe('robots.txt', () => {
  it('the longest rule wins, Allow beats Disallow on a tie, and no rule allows', () => {
    const txt = 'User-agent: *\nDisallow: /a\nAllow: /a/open\nDisallow: /x$';
    expect(robotsAllows(txt, '/a/closed')).toBe(false);
    expect(robotsAllows(txt, '/a/open/1')).toBe(true);
    expect(robotsAllows(txt, '/x')).toBe(false);
    expect(robotsAllows(txt, '/xy')).toBe(true);
    expect(robotsAllows('', '/anything')).toBe(true);
    expect(robotsAllows('User-agent: brain-feed\nDisallow: /\n\nUser-agent: *\nAllow: /', '/p')).toBe(false);
  });
});
