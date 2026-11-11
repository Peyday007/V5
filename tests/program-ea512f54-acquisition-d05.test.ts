import { describe, expect, it } from 'vitest';
import {
  ACCESS_HANDOFF_EVENT,
  bulkShaped,
  discoverExistingSources,
  discoveryFromRows,
  judgeAcquisitionNeed,
  openHandoffsFromRows,
  readOpenHandoffs,
  recordAcquisitionJudgment,
  recordOperatePermission,
  resolveAccessHandoff,
  SOURCE_DISCOVERY_EVENT,
} from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory } from '../server/services/sources/access.ts';
import { runOperatePermissionCommand } from '../server/services/sources/operatePermissionCli.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

/**
 * F-JUDGMENT-NO-CONSUMER: an ACQUISITION_JUDGMENT that says SEARCH_FIRST, a
 * HUMAN_HANDOFF naming a route, and bespokeCrawlerMayBeProposed were written and
 * never read. These tests hold each one to a consumer that acts on it.
 */

type Event = { eventType: string; outcome?: string | null; provider?: string | null; reason?: string; measures?: Record<string, unknown> };
const recorder = () => {
  const events: Event[] = [];
  return { events, record: async (e: Event) => void events.push(e) };
};
/** Turn recorded events into the rows a reader sees. */
const rowsOf = (events: Event[], type: string, at = new Date().toISOString()) =>
  events.filter((e) => e.eventType === type).map((e) => ({ outcome: e.outcome ?? null, measures: JSON.stringify(e.measures ?? {}), at }));

describe('SEARCH_FIRST starts source discovery, and the next judgment reads its answer', () => {
  it('a SEARCH_FIRST judgment runs the search and records what exists on the host', async () => {
    const r = recorder();
    const queries: string[] = [];
    const search = async (q: string) => {
      queries.push(q);
      return { searched: true, urls: ['https://data.example.org/datasets/permits.csv', 'https://data.example.org/about', 'https://elsewhere.example/feed.xml'] };
    };
    const j = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'permit records', host: 'data.example.org' },
      { stableHttpDocuments: true, repeatedUses: 0 },
      { record: r.record as never, discovery: async () => null, discover: (h, p) => discoverExistingSources(h, p, { search, record: r.record as never }) },
    );
    expect(j.outcome).toBe('SEARCH_FIRST');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('site:data.example.org');
    const judged = r.events.find((e) => e.eventType === 'ACQUISITION_JUDGMENT')!;
    expect(judged.measures!['discovery']).toBe('STARTED');
    const found = r.events.find((e) => e.eventType === SOURCE_DISCOVERY_EVENT)!;
    expect(found.outcome).toBe('FOUND');
    // Off-site results are not the host's sources; an about page is not a corpus.
    expect(found.measures!['candidates']).toEqual(['https://data.example.org/datasets/permits.csv', 'https://data.example.org/about']);
    expect(found.measures!['bulk']).toEqual(['https://data.example.org/datasets/permits.csv']);

    // The next judgment for the host is answered by that row: BULK, and no crawler.
    const discovery = discoveryFromRows(rowsOf(r.events, SOURCE_DISCOVERY_EVENT), 'data.example.org');
    const r2 = recorder();
    const next = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'permit records', host: 'data.example.org' },
      { stableHttpDocuments: true, repeatedUses: 0 },
      { record: r2.record as never, discovery: async () => discovery, discover: async () => { throw new Error('must not search again'); } },
    );
    expect(next.outcome).toBe('ROUTE_SELECTED');
    expect(next.route).toBe('BULK');
    expect(next.bespokeCrawlerMayBeProposed).toBe(false);
    expect(r2.events[0]!.measures!['discovery']).toBe('ON_RECORD');
  });

  it('a search that found nothing is what lets a bespoke crawler be proposed', async () => {
    const r = recorder();
    await discoverExistingSources('plain.example', 'filings', { search: async () => ({ searched: true, urls: ['https://plain.example/news/1'] }), record: r.record as never });
    expect(r.events[0]!.outcome).toBe('NONE_FOUND');
    const discovery = discoveryFromRows(rowsOf(r.events, SOURCE_DISCOVERY_EVENT), 'plain.example');
    const r2 = recorder();
    const j = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'filings', host: 'plain.example' },
      { stableHttpDocuments: true, repeatedUses: 3, repeatedUsesNeedingFallback: 3 },
      { record: r2.record as never, discovery: async () => discovery, proposalOnRecord: async () => false },
    );
    expect(j.route).toBe('HTTP');
    expect(j.bespokeCrawlerMayBeProposed).toBe(true);
    const proposal = r2.events.find((e) => e.eventType === 'CONNECTOR_PROPOSED')!;
    expect(proposal.measures!['bespokeCrawler']).toBe(true);
  });

  it('a search nobody made records nothing, and the host stays SEARCH_FIRST', async () => {
    const r = recorder();
    const out = await discoverExistingSources('busy.example', 'x', { search: async () => ({ searched: false, urls: [] }), record: r.record as never });
    expect(out).toBeNull();
    expect(r.events).toEqual([]);
    expect(discoveryFromRows([], 'busy.example')).toBeNull();
  });

  it('a bespoke route is not proposed as a crawler before the search ran', async () => {
    // Reached by a caller that states HTTP without any search: still SEARCH_FIRST, so no proposal.
    const r = recorder();
    const j = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'p', host: 'nosearch.example' },
      { stableHttpDocuments: true, repeatedUses: 5, repeatedUsesNeedingFallback: 5 },
      { record: r.record as never, discovery: async () => null, discover: async () => null, proposalOnRecord: async () => false },
    );
    expect(j.outcome).toBe('SEARCH_FIRST');
    expect(r.events.some((e) => e.eventType === 'CONNECTOR_PROPOSED')).toBe(false);
    // And a bulk source already found never makes HTTP a crawler.
    expect(judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { bulkSearchDone: true, existingBulkSources: ['x'], stableHttpDocuments: true, reliability: undefined } as never).bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('bulk shape is read from the address alone, with no host or category listed', () => {
    expect(bulkShaped('https://a.example/sitemap.xml')).toBe(true);
    expect(bulkShaped('https://a.example/open-data/catalog')).toBe(true);
    expect(bulkShaped('https://a.example/api/v1/records')).toBe(true);
    expect(bulkShaped('https://a.example/about-us')).toBe(false);
    expect(bulkShaped('not a url')).toBe(false);
  });
});

describe('a HUMAN_HANDOFF at a genuine boundary is put in front of a person', () => {
  it('a bot restriction opens one handoff naming the permitted route for that boundary, not a login', async () => {
    const r = recorder();
    const j = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'market records', host: 'guarded.example' },
      { blockedAtBoundary: true, boundary: 'BOT_RESTRICTION', repeatedUses: 0 },
      { record: r.record as never, handoffOnRecord: async () => false, discovery: async () => null },
    );
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.handoff).toMatch(/permission from the site|official export|licence/);
    const open = r.events.filter((e) => e.eventType === ACCESS_HANDOFF_EVENT);
    expect(open).toHaveLength(1);
    expect(open[0]!.outcome).toBe('OPEN');
    expect(open[0]!.measures).toMatchObject({ host: 'guarded.example', boundary: 'BOT_RESTRICTION', handoff: j.handoff });
    expect(r.events.find((e) => e.eventType === 'ACQUISITION_JUDGMENT')!.measures!['handoff']).toBe(j.handoff);

    // Already open: the next read asks nobody again.
    const r2 = recorder();
    await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'market records', host: 'guarded.example' },
      { blockedAtBoundary: true, boundary: 'BOT_RESTRICTION', repeatedUses: 0 },
      { record: r2.record as never, handoffOnRecord: async () => true, discovery: async () => null },
    );
    expect(r2.events.some((e) => e.eventType === ACCESS_HANDOFF_EVENT)).toBe(false);
  });

  it('a public page operated without an account asks nobody for anything', async () => {
    const r = recorder();
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p', host: 'public.example' },
      { interactiveInterfaceOnly: true, authorizedAccountOnRecord: false, repeatedUses: 0 },
      { record: r.record as never, operatePermission: async () => ({ permitted: false, accountRef: null, grantedBy: null, at: null }), handoffOnRecord: async () => false },
    );
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
    expect(j.handoff).toMatch(/grant an account/);
    expect(r.events.some((e) => e.eventType === ACCESS_HANDOFF_EVENT)).toBe(false);
  });

  it('a resolution or a later grant closes a handoff; history stays', () => {
    const h = (host: string, boundary: string, handoff: string, at: string) => ({ outcome: 'OPEN', at, measures: JSON.stringify({ host, boundary, handoff, capability: 'ACQUIRE' }) });
    const rows = [
      h('a.example', 'BOT_RESTRICTION', 'permission from the site', '2026-11-01T00:00:00Z'),
      h('b.example', 'AUTHENTICATION', 'an authorized account', '2026-11-01T00:00:00Z'),
      h('c.example', 'CAPTCHA', 'an official export', '2026-11-01T00:00:00Z'),
      { outcome: 'RESOLVED', at: '2026-11-02T00:00:00Z', measures: JSON.stringify({ host: 'a.example', resolvedBy: 'owner' }) },
    ];
    const grant = [{ outcome: 'GRANTED', at: '2026-11-03T00:00:00Z', measures: JSON.stringify({ host: 'b.example', accountRef: 'owner login', grantedBy: 'owner' }) }];
    expect(openHandoffsFromRows(rows).map((x) => x.host).sort()).toEqual(['b.example', 'c.example']);
    expect(openHandoffsFromRows(rows, grant).map((x) => x.host)).toEqual(['c.example']);
  });
});

describe('end to end on the database: the read path drives both consumers', () => {
  const base = {
    resolve: async () => ['93.184.216.34'],
    robotsAllow: async () => true,
    learned: async () => null,
    archive: async () => null,
    sitemap: async () => null,
    search: null,
    connector: async () => null,
    browser: null,
  };

  it('a 403 opens a handoff the terminal lists, and resolve closes it', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const refused = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 403, retrievedAt: 'now', reason: 'HTTP_ERROR' as never, detail: 'forbidden' });
    await readSource('https://walled.example/records', { ...base, direct: async (u) => refused(u), caller: 'e2e-handoff' });
    const open = await readOpenHandoffs();
    expect(open.map((x) => [x.host, x.boundary])).toEqual([['walled.example', 'BOT_RESTRICTION']]);
    const listed = await runOperatePermissionCommand(['handoffs']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('walled.example');
    expect(listed.out).toContain('BOT_RESTRICTION');

    // A second read of the same host does not open a second handoff.
    await readSource('https://walled.example/records', { ...base, direct: async (u) => refused(u), caller: 'e2e-handoff-2' });
    const rows = await getDb().all<{ n: number | string }>(`SELECT COUNT(*) AS n FROM bin_events WHERE event_type = ? AND outcome = 'OPEN'`, [ACCESS_HANDOFF_EVENT]);
    expect(Number(rows[0]!.n)).toBe(1);

    const closed = await runOperatePermissionCommand(['resolve', '--host', 'walled.example', '--by', 'owner', '--note', 'licence bought']);
    expect(closed.code).toBe(0);
    expect(await readOpenHandoffs()).toEqual([]);
    // Append-only: the OPEN row is still there beside the RESOLVED one.
    const all = await getDb().all<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = ? ORDER BY at`, [ACCESS_HANDOFF_EVENT]);
    expect(all.map((x) => x.outcome)).toEqual(['OPEN', 'RESOLVED']);
  });

  it('a SEARCH_FIRST read starts discovery, and the next read of the host is judged from its row', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const PAGE = 'The register lists 41,000 permits issued in 2025 across the county. '.repeat(10);
    const ok = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
    const searched: string[] = [];
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (release = resolve));
    const discover = async (host: string, purpose: string) => {
      searched.push(host);
      const out = await discoverExistingSources(host, purpose, { search: async () => ({ searched: true, urls: [`https://${host}/sitemap.xml`] }) });
      release();
      return out;
    };
    await readSource('https://county.example/permits', { ...base, direct: async (u) => ok(u), discover, caller: 'e2e-discover-1' });
    await done;
    expect(searched).toEqual(['county.example']);
    const first = await getDb().all<{ outcome: string; measures: string }>(`SELECT outcome, measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`, ['e2e-discover-1']);
    expect(first.map((x) => x.outcome)).toEqual(['SEARCH_FIRST']);
    const disc = await getDb().all<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = ?`, [SOURCE_DISCOVERY_EVENT]);
    expect(disc.map((x) => x.outcome)).toEqual(['FOUND']);

    await readSource('https://county.example/permits', { ...base, direct: async (u) => ok(u), discover, caller: 'e2e-discover-2' });
    const second = await getDb().all<{ outcome: string; provider: string | null; measures: string }>(`SELECT outcome, provider, measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`, ['e2e-discover-2']);
    expect(second.map((x) => [x.outcome, x.provider])).toEqual([['ROUTE_SELECTED', 'BULK']]);
    expect((JSON.parse(second[0]!.measures) as { discovery: string }).discovery).toBe('ON_RECORD');
    expect(searched).toEqual(['county.example']);
  });

  it('a grant made after an authentication handoff closes it', async () => {
    await freshProject();
    await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'orders', host: 'login.example' },
      { interactiveInterfaceOnly: true, blockedAtBoundary: true, boundary: 'AUTHENTICATION', repeatedUses: 0 },
      { operatePermission: async () => ({ permitted: false, accountRef: null, grantedBy: null, at: null }) },
    );
    expect((await readOpenHandoffs()).map((x) => x.host)).toEqual(['login.example']);
    await new Promise((r) => setTimeout(r, 5));
    await recordOperatePermission({ host: 'login.example', granted: true, accountRef: 'owner login', grantedBy: 'owner' });
    expect(await readOpenHandoffs()).toEqual([]);
    await resolveAccessHandoff({ host: 'login.example', resolvedBy: 'owner' });
  });
});
