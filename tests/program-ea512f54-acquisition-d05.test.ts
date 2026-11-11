/**
 * ACQ-21-1 / ACQ-21-2 repair: the ACQUISITION_JUDGMENT row is acted on.
 *
 * Finding: SEARCH_FIRST, HUMAN_HANDOFF and bespokeCrawlerMayBeProposed were
 * written and nothing read them. These tests hold each consumer to account:
 * SEARCH_FIRST runs source discovery and the next judgment reads its result,
 * HUMAN_HANDOFF raises a person-facing row a terminal lists until a later row
 * resolves it, and a bespoke ACQUIRE connector is proposed only after the search.
 */
import { describe, expect, it } from 'vitest';
import {
  discoverExistingSources,
  discoveryFromRows,
  isBulkCandidate,
  openHandoffsFromRows,
  recordAcquisitionJudgment,
  type SourceDiscovery,
} from '../server/services/sources/acquisition.ts';
import { describeHandoffs, runOperatePermissionCommand } from '../server/services/sources/operatePermissionCli.ts';

type Ev = { eventType: string; outcome?: string | null; provider?: string | null; measures?: Record<string, unknown> };

/** A bin_events table in memory: what one judgment writes, the next one reads. */
const store = () => {
  const events: (Ev & { at: string })[] = [];
  let tick = Date.parse('2026-11-10T00:00:00Z');
  const record = (async (e: Ev) => void events.push({ ...e, at: new Date((tick += 1000)).toISOString() })) as never;
  const discoveryOnRecord = async (host: string): Promise<SourceDiscovery | null> =>
    discoveryFromRows(
      events.filter((e) => e.eventType === 'SOURCE_DISCOVERY').map((e) => ({ measures: JSON.stringify(e.measures), at: e.at })),
      host,
    );
  return { events, record, discoveryOnRecord };
};

describe('SEARCH_FIRST runs source discovery, and the next judgment reads it', () => {
  it('a SEARCH_FIRST judgment triggers discovery and records SOURCE_DISCOVERY', async () => {
    const s = store();
    const asked: string[] = [];
    const j = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'company filings', host: 'Records.Example' },
      { stableHttpDocuments: true, repeatedUses: 0 },
      {
        record: s.record,
        discoveryOnRecord: s.discoveryOnRecord,
        discover: async (need) => {
          asked.push(need.host!);
          return { host: 'records.example', candidates: ['https://records.example/bulk/filings.csv'], queries: ['q'], at: null };
        },
      },
    );
    expect(j.outcome).toBe('SEARCH_FIRST');
    expect(asked).toEqual(['Records.Example']);
    expect(s.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'SOURCE_DISCOVERY']);
    expect(s.events[1]).toMatchObject({ outcome: 'FOUND', measures: { host: 'records.example', candidates: ['https://records.example/bulk/filings.csv'] } });

    // The next read of the same host: the search is done, and what it found is chosen over a crawler.
    const next = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'company filings', host: 'records.example' },
      { stableHttpDocuments: true, repeatedUses: 0 },
      { record: s.record, discoveryOnRecord: s.discoveryOnRecord, discover: async () => { throw new Error('must not search again'); } },
    );
    expect(next.outcome).toBe('ROUTE_SELECTED');
    expect(next.route).toBe('BULK');
    expect(next.bespokeCrawlerMayBeProposed).toBe(false);
    expect(s.events.at(-1)!.measures).toMatchObject({ bulkSearchDone: true, existingBulkSources: 1 });
  });

  it('when discovery finds nothing, a bespoke connector may be proposed — and only then', async () => {
    const s = store();
    const deps = {
      record: s.record,
      discoveryOnRecord: s.discoveryOnRecord,
      proposalOnRecord: async () => false,
      discover: async () => ({ host: 'portal.example', candidates: [], queries: ['q'], at: null }),
    };
    const ev = { stableHttpDocuments: true, repeatedUses: 5, repeatedUsesNeedingFallback: 5 };
    const first = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'portal.example' }, ev, deps);
    expect(first.outcome).toBe('SEARCH_FIRST');
    // Repetition alone never proposed a crawler before the search ran.
    expect(s.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'SOURCE_DISCOVERY']);
    expect(s.events[1]!.outcome).toBe('NONE_FOUND');

    const second = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', host: 'portal.example' }, ev, deps);
    expect(second.route).toBe('HTTP');
    expect(second.bespokeCrawlerMayBeProposed).toBe(true);
    const proposal = s.events.find((e) => e.eventType === 'CONNECTOR_PROPOSED');
    expect(proposal).toMatchObject({ provider: 'HTTP', measures: { host: 'portal.example', bespokeCrawler: true } });
  });

  it('an answered empty search is a result; a search that could not be made records nothing', async () => {
    expect(await discoverExistingSources({ kind: 'ACQUIRE', purpose: 'p', host: 'x.example' }, async () => [])).toEqual({
      host: 'x.example',
      candidates: [],
      queries: expect.any(Array),
      at: null,
    });
    const s = store();
    await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'p', host: 'x.example' },
      { repeatedUses: 0 },
      { record: s.record, discoveryOnRecord: s.discoveryOnRecord, discover: async () => null },
    );
    expect(s.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT']);
  });

  it('discovery keeps bulk-shaped candidates, by URL shape and never by site or industry', async () => {
    expect(isBulkCandidate('https://data.example.gov/dataset/permits')).toBe(true);
    expect(isBulkCandidate('https://example.org/downloads/all.zip')).toBe(true);
    expect(isBulkCandidate('https://example.org/feed.xml')).toBe(true);
    expect(isBulkCandidate('https://example.org/about-us')).toBe(false);
    const found = await discoverExistingSources({ kind: 'ACQUIRE', purpose: 'p', host: 'www.Example.org' }, async (q) =>
      q.startsWith('site:') ? ['https://example.org/api/v1', 'https://example.org/team'] : ['https://catalog.example.net/dataset/example-org'],
    );
    expect(found!.host).toBe('www.example.org');
    expect(found!.candidates.sort()).toEqual(['https://catalog.example.net/dataset/example-org', 'https://example.org/api/v1']);
  });
});

describe('HUMAN_HANDOFF is raised to a person', () => {
  it('a boundary writes one ACCESS_HANDOFF naming the route to seek, deduplicated while open', async () => {
    const s = store();
    let open = false;
    const deps = { record: s.record, handoffOnRecord: async () => open, repeatedUse: async () => ({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 }) };
    const j = await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'licensed tables', host: 'paywalled.example' }, { requiresLicence: true }, deps);
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.handoff).toBeTruthy();
    const handoff = s.events.find((e) => e.eventType === 'ACCESS_HANDOFF')!;
    expect(handoff).toMatchObject({ outcome: 'OPEN', measures: { host: 'paywalled.example', capability: 'ACQUIRE', boundaries: ['TERMS_OR_LICENSE'], seek: j.handoff } });
    open = true;
    await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'licensed tables', host: 'paywalled.example' }, { requiresLicence: true }, deps);
    expect(s.events.filter((e) => e.eventType === 'ACCESS_HANDOFF')).toHaveLength(1);
  });

  it('a later grant closes an OPERATE handoff; a later readable access closes an ACQUIRE one', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const h = (host: string, capability: string, at: string) => ({
      at,
      measures: JSON.stringify({ host, key: `${capability}:X`, capability, boundaries: ['X'], seek: 'an official export', purpose: 'p' }),
    });
    const handoffs = [h('a.example', 'OPERATE', '2026-11-10T01:00:00Z'), h('b.example', 'ACQUIRE', '2026-11-10T01:00:00Z'), h('c.example', 'ACQUIRE', '2026-11-10T01:00:00Z')];
    const grants = [{ outcome: 'GRANTED', at: '2026-11-10T02:00:00Z', measures: JSON.stringify({ host: 'a.example' }) }];
    const reads = [
      { outcome: 'READ', at: '2026-11-10T03:00:00Z', measures: JSON.stringify({ host: 'b.example' }) },
      { outcome: 'READ', at: '2026-11-09T03:00:00Z', measures: JSON.stringify({ host: 'c.example' }) },
    ];
    const open = openHandoffsFromRows(handoffs, grants, reads, now);
    expect(open.map((o) => o.host)).toEqual(['c.example']);
    expect(openHandoffsFromRows(handoffs, [], [], now)).toHaveLength(3);
  });

  it('the terminal lists open handoffs for a person', async () => {
    const one = { host: 'c.example', key: 'ACQUIRE:X', capability: 'ACQUIRE', boundaries: ['ACCESS_BARRIER'], seek: 'an official export', purpose: 'filings', at: '2026-11-10T01:00:00Z' };
    const out = await runOperatePermissionCommand(['handoffs'], { handoffs: async () => [one] });
    expect(out.code).toBe(0);
    expect(out.out).toContain('c.example');
    expect(out.out).toContain('seek an official export');
    expect(describeHandoffs([])).toMatch(/No open access handoffs/);
  });
});
