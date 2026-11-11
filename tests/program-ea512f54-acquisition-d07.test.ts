import { describe, expect, it } from 'vitest';
import {
  bulkCandidatesOf,
  discoverExistingSources,
  discoveryFromRows,
  discoveryQuery,
  judgeAcquisitionNeed,
  openHandoffsFromRows,
  readOpenHandoffs,
  recordAcquisitionJudgment,
  recordOperatePermission,
  type SourceDiscovery,
} from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory } from '../server/services/sources/access.ts';
import { runAcquisitionCommand } from '../server/services/sources/acquisitionCli.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

/*
 * F-JUDGMENT-NO-CONSUMER: SEARCH_FIRST, HUMAN_HANDOFF and bespokeCrawlerMayBeProposed
 * were written and never read. Each is now acted on: SEARCH_FIRST runs source
 * discovery and the need is judged again on its result; a handoff opens a row a
 * person reads at the terminal; a bespoke ACQUIRE connector is proposed only once
 * the search for existing corpora found nothing.
 */

type Ev = { eventType: string; outcome?: string | null; provider?: string | null; measures?: Record<string, unknown> };
const harness = (opts: { discovery?: SourceDiscovery | null; found?: SourceDiscovery } = {}) => {
  const events: Ev[] = [];
  let searches = 0;
  return {
    events,
    searches: () => searches,
    deps: {
      record: (async (e: Ev) => void events.push(e)) as never,
      proposalOnRecord: async () => false,
      handoffOnRecord: async () => false,
      discoveryOnRecord: async () => opts.discovery ?? null,
      discover: async () => {
        searches += 1;
        return opts.found ?? { query: 'q', candidates: [], bulkCandidates: [] };
      },
      repeatedUse: async () => ({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 }),
    },
  };
};

describe('SEARCH_FIRST runs source discovery and is judged again on what it found', () => {
  it('a found catalog becomes the BULK route, and no crawler is proposable', async () => {
    const h = harness({ found: { query: 'q', candidates: ['https://x.example/a', 'https://data.x.example/catalog/'], bulkCandidates: ['https://data.x.example/catalog/'] } });
    const j = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'company filings', host: 'x.example' }, { stableHttpDocuments: true }, h.deps);
    expect(h.searches()).toBe(1);
    expect(h.events.map((e) => [e.eventType, e.outcome])).toEqual([
      ['ACQUISITION_JUDGMENT', 'SEARCH_FIRST'],
      ['SOURCE_DISCOVERY', 'FOUND'],
      ['ACQUISITION_JUDGMENT', 'ROUTE_SELECTED'],
    ]);
    expect(j.route).toBe('BULK');
    expect(j.bespokeCrawlerMayBeProposed).toBe(false);
    expect(h.events[2]!.measures).toMatchObject({ followsDiscovery: true, bulkSearchDone: true, existingBulkSources: 1 });
  });

  it('a search that found nothing makes the bespoke route proposable', async () => {
    const h = harness();
    const j = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'y.example' }, { stableHttpDocuments: true }, h.deps);
    expect(h.events.map((e) => e.outcome)).toEqual(['SEARCH_FIRST', 'NONE_FOUND', 'ROUTE_SELECTED']);
    expect(j.route).toBe('HTTP');
    expect(j.bespokeCrawlerMayBeProposed).toBe(true);
  });

  it('a discovery already on record answers the question: no second search, no SEARCH_FIRST', async () => {
    const h = harness({ discovery: { query: 'q', candidates: [], bulkCandidates: ['https://z.example/data/all.csv'] } });
    const j = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'z.example' }, { stableHttpDocuments: true }, h.deps);
    expect(h.searches()).toBe(0);
    expect(j.outcome).toBe('ROUTE_SELECTED');
    expect(j.route).toBe('BULK');
    expect(h.events[0]!.measures).toMatchObject({ discoveryOnRecord: true });
  });

  it('a found bulk source that measurement outranks still never licenses a bespoke crawler proposal', async () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { existingBulkSources: ['c'], stableHttpDocuments: true });
    expect(j.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('repetition on a bespoke ACQUIRE route is not proposed as a connector before discovery says nothing else serves', async () => {
    const h = harness({ discovery: { query: 'q', candidates: [], bulkCandidates: ['https://w.example/feed.xml'] } });
    await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'p', host: 'w.example' },
      { interactiveInterfaceOnly: true, repeatedUses: 5, repeatedUsesNeedingFallback: 5 },
      h.deps,
    );
    expect(h.events.some((e) => e.eventType === 'CONNECTOR_PROPOSED' && e.provider !== 'BULK')).toBe(false);
  });
});

describe('discovery is a search for corpora, judged by the shape of the address', () => {
  it('bulk-shaped addresses are recognized for any site, pages are not', () => {
    expect(
      bulkCandidatesOf([
        'https://agency.example/datasets/wages',
        'https://agency.example/files/report.csv',
        'https://api.vendor.example/v1/',
        'https://agency.example/sitemap.xml',
        'https://agency.example/news/2025/wages-rise',
        'not a url',
      ]),
    ).toEqual(['https://agency.example/datasets/wages', 'https://agency.example/files/report.csv', 'https://api.vendor.example/v1/', 'https://agency.example/sitemap.xml']);
  });

  it('the query is built from the need, and the search never throws', async () => {
    expect(discoveryQuery({ purpose: 'read https://site.example/annual-wage-report', host: 'site.example' })).toContain('site.example annual wage report');
    const d = await discoverExistingSources({ purpose: 'p', host: 'h.example' }, { search: async () => Promise.reject(new Error('down')) });
    expect(d).toMatchObject({ candidates: [], bulkCandidates: [] });
  });

  it('the newest discovery for the host inside the window is the one on record', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const row = (at: string, bulk: string[]) => ({ event_type: 'SOURCE_DISCOVERY', outcome: 'FOUND', at, measures: JSON.stringify({ host: 'a.example', query: 'q', candidates: bulk, bulkCandidates: bulk }) });
    expect(discoveryFromRows([row('2026-11-09T00:00:00Z', ['old']), row('2026-11-09T12:00:00Z', ['new'])], 'a.example', { now })?.bulkCandidates).toEqual(['new']);
    expect(discoveryFromRows([row('2026-10-01T00:00:00Z', ['stale'])], 'a.example', { now })).toBeNull();
  });
});

describe('HUMAN_HANDOFF opens a record a person reads, and settles from later rows', () => {
  it('a boundary opens one ACCESS_HANDOFF naming the permitted route and the next step', async () => {
    const h = harness();
    const j = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'walled.example' }, { blockedAtBoundary: true, boundary: 'CAPTCHA' }, h.deps);
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.handoff).toMatch(/official export|licence|partner integration/);
    const handoff = h.events.find((e) => e.eventType === 'ACCESS_HANDOFF')!;
    expect(handoff.outcome).toBe('OPEN');
    expect(handoff.measures).toMatchObject({ host: 'walled.example', capability: 'ACQUIRE', boundary: 'ACCESS_BARRIER', seek: j.handoff });
    expect(String(handoff.measures!.nextStep)).toContain('walled.example');
  });

  it('an OPERATE need with no account names the grant command', async () => {
    const h = harness();
    await recordAcquisitionJudgment({ kind: 'OPERATE', purpose: 'p', host: 'app.example' }, {}, { ...h.deps, operatePermission: async () => ({ permitted: false, accountRef: null, grantedBy: null, at: null }) });
    const handoff = h.events.find((e) => e.eventType === 'ACCESS_HANDOFF')!;
    expect(handoff.measures).toMatchObject({ boundary: 'NO_AUTHORIZED_ACCOUNT' });
    expect(String(handoff.measures!.nextStep)).toContain('operatePermissionCli.ts grant --host app.example');
  });

  it('a handoff already open is not opened again', async () => {
    const h = harness();
    await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'w.example' }, { requiresLicence: true }, { ...h.deps, handoffOnRecord: async () => true });
    expect(h.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT']);
  });

  it('open until a later judgment routes without one, or a person grants the permission', () => {
    const r = (event_type: string, outcome: string, at: string, m: Record<string, unknown>) => ({ event_type, outcome, at, measures: JSON.stringify(m) });
    const opened = [
      r('ACCESS_HANDOFF', 'OPEN', '2026-11-09T01:00:00Z', { host: 'a.example', capability: 'ACQUIRE', boundary: 'ACCESS_BARRIER', seek: 's', nextStep: 'n' }),
      r('ACCESS_HANDOFF', 'OPEN', '2026-11-09T01:00:00Z', { host: 'b.example', capability: 'OPERATE', boundary: 'NO_AUTHORIZED_ACCOUNT', seek: 's', nextStep: 'n' }),
    ];
    expect(openHandoffsFromRows(opened).map((h) => h.host).sort()).toEqual(['a.example', 'b.example']);
    const answered = [
      ...opened,
      r('ACQUISITION_JUDGMENT', 'ROUTE_SELECTED', '2026-11-09T02:00:00Z', { host: 'a.example', capability: 'ACQUIRE', route: 'BULK' }),
      r('OPERATE_PERMISSION', 'GRANTED', '2026-11-09T02:00:00Z', { host: 'b.example', accountRef: 'x' }),
    ];
    expect(openHandoffsFromRows(answered)).toEqual([]);
    // An earlier route does not settle a later stop.
    const earlier = [r('ACQUISITION_JUDGMENT', 'ROUTE_SELECTED', '2026-11-09T00:00:00Z', { host: 'a.example', capability: 'ACQUIRE', route: 'HTTP' }), ...opened];
    expect(openHandoffsFromRows(earlier).map((h) => h.host)).toContain('a.example');
  });
});

describe('end to end on the database', () => {
  const PAGE = 'The registry lists 41,000 companies filed in 2025 with annual accounts. '.repeat(10);
  const ok = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
  const refused = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 403, retrievedAt: 'now', reason: 'HTTP_ERROR' as never, detail: 'forbidden' });
  const base = { resolve: async () => ['93.184.216.34'], robotsAllow: async () => true, learned: async () => null, archive: async () => null, sitemap: async () => null, connector: async () => null, browser: null };
  const rows = async (eventType: string, caller: string) =>
    getDb().all<{ outcome: string; measures: string }>(`SELECT outcome, measures FROM bin_events WHERE event_type = ? AND workload_class = ? ORDER BY at, id`, [eventType, caller]);
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('a plain read starts one discovery for its host, and the next read of the host is judged on it', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const caller = 'discovery-e2e';
    let searches = 0;
    const deps = {
      ...base,
      direct: async (u: string) => ok(u),
      discover: async (need: { host?: string | null; purpose: string }) => {
        searches += 1;
        return discoverExistingSources(need, { search: async () => ['https://registry.example/bulk/companies.zip', 'https://registry.example/about'] });
      },
      caller,
    };
    await readSource('https://registry.example/company/123', deps);
    await readSource('https://registry.example/company/456', deps);
    await settle();
    await readSource('https://registry.example/company/789', deps);
    await settle();
    expect(searches).toBe(1);
    const discovery = await rows('SOURCE_DISCOVERY', caller);
    expect(discovery.map((d) => d.outcome)).toEqual(['FOUND']);
    expect(JSON.parse(discovery[0]!.measures).bulkCandidates).toEqual(['https://registry.example/bulk/companies.zip']);
    const judgments = (await rows('ACQUISITION_JUDGMENT', caller)).map((j) => [j.outcome, JSON.parse(j.measures).route]);
    expect(judgments[0]).toEqual(['SEARCH_FIRST', null]);
    expect(judgments).toContainEqual(['ROUTE_SELECTED', 'BULK']);
  });

  it('a refused read opens a handoff that the terminal lists, and a later read that routes settles it', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const caller = 'handoff-e2e';
    await readSource('https://walled-registry.example/x', { ...base, direct: async (u: string) => refused(u), discover: null, caller });
    await readSource('https://walled-registry.example/y', { ...base, direct: async (u: string) => refused(u), discover: null, caller });
    expect((await rows('ACCESS_HANDOFF', caller)).length).toBe(1);
    const open = await readOpenHandoffs();
    expect(open.map((h) => [h.host, h.boundary])).toEqual([['walled-registry.example', 'ACCESS_BARRIER']]);
    const cli = await runAcquisitionCommand(['handoffs']);
    expect(cli.code).toBe(0);
    expect(cli.out).toContain('walled-registry.example');
    expect(cli.out).toContain('seek:');
    await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'walled-registry.example' }, { existingBulkSources: ['https://walled-registry.example/export.csv'] }, { caller, repeatedUse: async () => ({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 }) });
    expect(await readOpenHandoffs()).toEqual([]);
    expect((await runAcquisitionCommand(['handoffs'])).out).toMatch(/No open access handoffs/);
  });

  it('a person granting the operate permission settles an OPERATE handoff', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await recordAcquisitionJudgment({ kind: 'OPERATE', purpose: 'run the monthly export', host: 'portal.example' }, {}, { caller: 'grant-e2e', repeatedUse: async () => ({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 }) });
    expect((await readOpenHandoffs()).map((h) => h.boundary)).toEqual(['NO_AUTHORIZED_ACCOUNT']);
    await new Promise((r) => setTimeout(r, 5));
    await recordOperatePermission({ host: 'portal.example', granted: true, accountRef: 'portal owner login', grantedBy: 'owner' });
    expect(await readOpenHandoffs()).toEqual([]);
  });
});
