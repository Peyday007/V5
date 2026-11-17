/**
 * ACQ-21-3 / ACQ-21-4 — the production pull pass wires the acquisition owners
 * in order: corpus evaluation, access, a conditional and checkpointed ingest,
 * a provenance row, connector health and yield ranking. End to end over a fake
 * transport and the real database rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { RecordBinEventInput } from '../server/repos/bins.ts';
import { evaluateCorpora, type CorpusNeed } from '../server/services/feeds/corpora.ts';
import type { Transport, TransportResponse } from '../server/services/feeds/access.ts';
import { superviseConnector, readPullHistory } from '../server/services/feeds/health.ts';
import type { IngestStore, ShardCheckpoint } from '../server/services/feeds/ingest.ts';
import { FEED_SOURCES, type FeedSource, type SourceAcquisition } from '../server/services/feeds/sources.ts';
import {
  FEED_ACQUISITION_EVENT,
  FEED_SOURCE_YIELD_EVENT,
  NOT_MODIFIED_MARK,
  latestSourceYields,
  orderByYield,
  pullDueFeeds,
  readSourceYields,
  recordSourceYields,
  sourceYieldValue,
  type AcquisitionDeps,
} from '../server/services/feeds/run.ts';

const HOUR = 3_600_000;
let tag = '';

beforeEach(async () => {
  await freshProject();
  tag = Math.random().toString(36).slice(2, 8);
});

const acquisition = (over: Partial<SourceAcquisition> = {}): SourceAcquisition => ({
  corpus: 'domain:permitted-marketplaces',
  factKinds: ['listing'],
  access: { format: 'JSON', updateMechanism: 'CONDITIONAL_FETCH', authentication: 'NONE', usage: 'test terms' },
  provenance: { publisher: 'Test publisher', license: 'CC0', parserVersion: 'test/1' },
  ...over,
});

function source(id: string, over: Partial<FeedSource> = {}): FeedSource {
  return {
    id,
    label: id,
    url: `https://feed.test/${id}`,
    intervalMs: HOUR,
    parse: (body) =>
      ((body as { rows?: { n: number }[] }).rows ?? []).map((one) => ({
        externalId: `${id}-${one.n}`,
        url: `https://feed.test/${id}/${one.n}`,
        title: `Listing ${one.n} from ${id}`,
        body: `Record ${one.n}`,
        organization: 'A shop',
        publishedAt: new Date().toISOString(),
      })),
    acquisition: acquisition(),
    ...over,
  };
}

const json = (rows: number[], headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  headers,
  body: JSON.stringify({ rows: rows.map((n) => ({ n })) }),
});

/** Dependencies that record every stage into `log`, with real evaluation, real health and real rows. */
function harness(transport: Transport, extra: Partial<AcquisitionDeps> = {}) {
  const log: string[] = [];
  const events: RecordBinEventInput[] = [];
  const routed: string[] = [];
  const record = async (event: RecordBinEventInput) => {
    events.push(event);
    log.push(`record:${event.eventType}:${event.outcome}`);
  };
  const deps: AcquisitionDeps = {
    transport: async (url, headers, timeoutMs) => {
      log.push(`fetch:${url}`);
      return transport(url, headers, timeoutMs);
    },
    evaluate: async (need: CorpusNeed) => {
      log.push(`evaluate:${need.purpose}`);
      return evaluateCorpora(need);
    },
    validators: async (id) => {
      const last = [...events].reverse().find((e) => e.eventType === FEED_ACQUISITION_EVENT && e.provider === id && (e.outcome === 'INGESTED' || e.outcome === 'NOT_MODIFIED'));
      return ((last?.measures as { validators?: never } | undefined)?.validators ?? null) as never;
    },
    supervise: async (id, intervalMs) => {
      log.push(`health:${id}`);
      return superviseConnector(id, intervalMs, {
        history: async (s) => (await readPullHistory(s)).filter((p) => !(p.ok && (p.error ?? '').startsWith(NOT_MODIFIED_MARK))),
        routedUnverified: async () => false,
        register: async (weakness) => {
          routed.push(weakness.key);
          return { candidate: { weaknessKey: weakness.key } };
        },
        record,
      });
    },
    record,
    yields: async () => new Map(),
    recordYields: async () => {
      log.push('yield');
    },
    sleep: async () => undefined,
    ...extra,
  };
  return { deps, log, events, routed };
}

describe('every production source declares what the pipeline reads', () => {
  it('names a catalog corpus, the facts it is pulled for, its access and its provenance, and the evaluation applies it', () => {
    for (const s of FEED_SOURCES) {
      expect(s.acquisition, s.id).toBeTruthy();
      const decision = evaluateCorpora({ purpose: s.label, factKinds: s.acquisition!.factKinds, maxAgeDays: s.acquisition!.maxAgeDays }).decisions.find(
        (d) => d.corpusId === s.acquisition!.corpus,
      );
      expect(decision?.outcome, `${s.id}: ${decision?.reason}`).toBe('APPLIED');
      expect(s.acquisition!.provenance.license.length).toBeGreaterThan(0);
    }
  });
});

describe('the pull pass, end to end', () => {
  it('runs evaluation before access, then ingest, provenance and health, and a 304 skips ingestion', async () => {
    const id = `cond-${tag}`;
    const seen: Record<string, string>[] = [];
    let call = 0;
    const { deps, log, events } = harness(async (_url, headers) => {
      seen.push(headers);
      call += 1;
      return call === 1 ? json([1, 2], { etag: '"v1"', 'last-modified': 'Mon, 16 Nov 2026 00:00:00 GMT' }) : { status: 304, headers: {}, body: '' };
    });
    const t0 = new Date();
    const first = await pullDueFeeds({ now: t0, sources: [source(id)], acquisition: deps });
    expect(first[0]).toMatchObject({ source: id, fetched: 2, inserted: 2, error: null, health: 'NONE' });
    expect(log.slice(0, 4)).toEqual([`evaluate:${id} (${id})`, `fetch:https://feed.test/${id}`, `record:${FEED_ACQUISITION_EVENT}:INGESTED`, `health:${id}`]);
    const provenance = events.find((e) => e.eventType === FEED_ACQUISITION_EVENT)!.measures as Record<string, unknown>;
    expect(provenance).toMatchObject({ corpus: 'domain:permitted-marketplaces', location: `https://feed.test/${id}`, format: 'JSON', license: 'CC0', parserVersion: 'test/1' });
    expect((provenance.validators as { etag: string }).etag).toBe('"v1"');

    const second = await pullDueFeeds({ now: new Date(t0.getTime() + 2 * HOUR), sources: [source(id)], acquisition: deps });
    expect(seen[1]).toMatchObject({ 'If-None-Match': '"v1"', 'If-Modified-Since': 'Mon, 16 Nov 2026 00:00:00 GMT' });
    expect(second[0]).toMatchObject({ notModified: true, fetched: 0, inserted: 0, error: null });
    const stored = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM feed_items WHERE source = ?', [id]);
    expect(Number(stored?.n)).toBe(2);
    // The 304 is a success for scheduling, and never an empty parse for health.
    expect(second[0]!.health).toBe('NONE');
  });

  it('a source whose corpus the evaluation skips is never asked', async () => {
    const id = `skip-${tag}`;
    const { deps, log } = harness(async () => json([1]));
    // GDELT is not evidence of a buyer request: the evaluation skips it for this need.
    const out = await pullDueFeeds({ sources: [source(id, { acquisition: acquisition({ corpus: 'gdelt', factKinds: ['buyer-request'] }) })], acquisition: deps });
    expect(out[0]!.skipped).toMatch(/not evidence of buyer-request/);
    expect(log.some((l) => l.startsWith('fetch:'))).toBe(false);
  });

  it('a sharded read interrupted part way resumes at the shard that failed', async () => {
    const id = `shard-${tag}`;
    const saved: ShardCheckpoint[] = [];
    const store: IngestStore = {
      checkpoints: async (s) => saved.filter((c) => c.source === s),
      saveCheckpoint: async (c) => {
        saved.push(c);
      },
      store: async (s, items) => (await import('../server/repos/feeds.ts')).insertFeedItems(s, items),
    };
    let failB = true;
    const fetched: string[] = [];
    const { deps } = harness(
      async (url) => {
        fetched.push(url);
        if (url.endsWith('/b') && failB) return { status: 503, headers: {}, body: '' };
        return json([url.endsWith('/a') ? 1 : url.endsWith('/b') ? 2 : 3]);
      },
      { ingestStore: store },
    );
    const sharded = source(id, { shards: () => ({ snapshot: 'crawl-1', keys: ['a', 'b', 'c'], url: (k) => `https://feed.test/${id}/${k}` }) });
    const t0 = new Date();
    const first = await pullDueFeeds({ now: t0, sources: [sharded], acquisition: deps });
    expect(first[0]).toMatchObject({ error: 'HTTP 503', inserted: 1, health: 'BACKOFF' });
    expect(saved.map((c) => c.shard)).toEqual(['a']);

    failB = false;
    fetched.length = 0;
    const second = await pullDueFeeds({ now: new Date(t0.getTime() + HOUR), sources: [sharded], acquisition: deps });
    expect(second[0]).toMatchObject({ error: null, resumedPast: ['a'], inserted: 2 });
    expect(fetched).toEqual([`https://feed.test/${id}/b`, `https://feed.test/${id}/c`]);
  });

  it('a body the parser cannot read is a broken parser routed to Factory, not an outage', async () => {
    const id = `broken-${tag}`;
    const { deps, routed } = harness(async () => ({ status: 200, headers: {}, body: '<html>maintenance</html>' }));
    const out = await pullDueFeeds({ sources: [source(id)], acquisition: deps });
    expect(out[0]!.error).toMatch(/SyntaxError/);
    expect(out[0]!.health).toBe('ROUTED_TO_FACTORY');
    expect(routed).toEqual([`FEED_CONNECTOR_REPAIR:${id}`]);
  });

  it('a revoked permission is a permission need, never routed as a repair', async () => {
    const id = `denied-${tag}`;
    const { deps, routed } = harness(async () => ({ status: 403, headers: {}, body: '' }));
    const out = await pullDueFeeds({ sources: [source(id)], acquisition: deps });
    expect(out[0]!.health).toBe('PERMISSION_NEED');
    expect(routed).toEqual([]);
  });
});

describe('yield ranking', () => {
  it('orders by marginal decision value, never volume, and an unread source ranks last', () => {
    expect(sourceYieldValue({ acquired: 1000, accepted: 10, usable: 0 })).toBe(0.01);
    expect(sourceYieldValue({ acquired: 10, accepted: 2, usable: 1 })).toBe(0.4);
    expect(sourceYieldValue({ acquired: 0, accepted: 0, usable: 0 })).toBeNull();
    const ordered = orderByYield([{ id: 'big' }, { id: 'unknown' }, { id: 'small' }], new Map([['big', 0.01], ['small', 0.4]]));
    expect(ordered.map((s) => s.id)).toEqual(['small', 'big', 'unknown']);
  });

  it('records each window from real rows, and the recorded reading changes the next pass order', async () => {
    const volume = `volume-${tag}`;
    const useful = `useful-${tag}`;
    const transport: Transport = async (url) => (url.endsWith(volume) ? json([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) : json([1, 2]));
    const { deps, log } = harness(transport, { yields: async () => (await latestSourceYields()).values });
    const t0 = new Date();
    await pullDueFeeds({ now: t0, sources: [source(volume), source(useful)], acquisition: deps });
    expect(log.filter((l) => l.startsWith('fetch:'))).toEqual([`fetch:https://feed.test/${volume}`, `fetch:https://feed.test/${useful}`]);

    // One of the useful source's items reached a shortlist; nothing from the volume source did.
    await getDb().run(`UPDATE feed_items SET shortlisted_round_id = 'round-test' WHERE source = ? AND external_id = ?`, [useful, `${useful}-1`]);
    const until = new Date(Date.now() + 1000);
    const yields = await readSourceYields(new Date(t0.getTime() - 1000).toISOString(), until.toISOString());
    expect(yields.find((y) => y.source === useful)).toMatchObject({ acquired: 2, accepted: 1, usable: 1, acceptedShare: 0.5, usableShare: 0.5 });
    expect(yields.find((y) => y.source === volume)).toMatchObject({ acquired: 10, accepted: 0, usable: 0, value: 0 });

    // Recorded once per window: a second reading inside the window writes nothing.
    const recorded = await recordSourceYields(until);
    expect(recorded?.find((y) => y.source === useful)?.value).toBe(1.5);
    expect(await recordSourceYields(new Date(until.getTime() + HOUR))).toBeNull();
    const rows = await getDb().all<{ id: string }>('SELECT id FROM bin_events WHERE event_type = ?', [FEED_SOURCE_YIELD_EVENT]);
    expect(rows.length).toBeGreaterThan(0);

    log.length = 0;
    await pullDueFeeds({ now: new Date(t0.getTime() + 2 * HOUR), sources: [source(volume), source(useful)], acquisition: deps });
    expect(log.filter((l) => l.startsWith('fetch:'))).toEqual([`fetch:https://feed.test/${useful}`, `fetch:https://feed.test/${volume}`]);
  });
});

/**
 * Review finding R1-2: per-shard checkpoints, resume and "a catalog listing is
 * not the underlying dataset" existed only in tests, because no production
 * source declared `shards` or `acquisition.listingUrl`. These tests drive the
 * production entries themselves, so removing either one fails here.
 */
describe('production sources exercise sharded ingestion and listing resolution', () => {
  const edgar = () => FEED_SOURCES.find((s) => s.id === 'sec-edgar-8k')!;
  const cfpb = () => FEED_SOURCES.find((s) => s.id === 'data-gov-cfpb-complaints')!;

  it('the production catalog declares a sharded corpus and a listing-backed source', () => {
    expect(FEED_SOURCES.some((s) => typeof s.shards === 'function')).toBe(true);
    expect(FEED_SOURCES.some((s) => !!s.acquisition?.listingUrl)).toBe(true);
    expect(edgar().acquisition?.corpus).toBe('sec-edgar');
    expect(cfpb().acquisition?.corpus).toBe('data-gov');
    expect(cfpb().acquisition?.listingUrl).toMatch(/^https:\/\/catalog\.data\.gov\/api\/3\/action\/package_show\?id=/);
  });

  it('the EDGAR corpus shards by completed filing day, never today, and declares a User-Agent', () => {
    const plan = edgar().shards!(new Date('2026-11-17T09:00:00Z'));
    expect(plan.keys).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(plan.url('2026-11-15')).toContain('startdt=2026-11-15');
    expect(plan.url('2026-11-15')).toContain('enddt=2026-11-15');
    expect(plan.url('2026-11-15')).toContain('forms=8-K');
    expect(edgar().headers?.['user-agent']).toBeTruthy();
    expect(edgar().spacingMs).toBeGreaterThanOrEqual(100);
  });

  const edgarBody = (day: string, n: number) =>
    JSON.stringify({
      hits: {
        hits: [
          {
            _id: `0000000000-26-00000${n}:form8k-${day}.htm`,
            _source: {
              adsh: `0000000000-26-00000${n}`,
              ciks: ['0000123456'],
              display_names: [`ACME ${n} CORP  (ACM)  (CIK 0000123456)`],
              form: '8-K',
              file_date: day,
              file_description: 'Current report',
              items: ['2.01', '8.01'],
              biz_locations: ['Austin, TX'],
            },
          },
        ],
      },
    });

  it('the EDGAR source is checkpointed per day, resumes after an interruption and never re-asks a finished day', async () => {
    const saved: ShardCheckpoint[] = [];
    const store: IngestStore = {
      checkpoints: async () => [...saved],
      saveCheckpoint: async (c) => {
        saved.push(c);
      },
      store: async (s, items) => (await import('../server/repos/feeds.ts')).insertFeedItems(s, items),
    };
    let failDay: string | null = '2026-11-15';
    const fetched: string[] = [];
    const { deps } = harness(
      async (url, headers) => {
        expect(headers['user-agent']).toBeTruthy();
        fetched.push(url);
        const day = /startdt=(\d{4}-\d{2}-\d{2})/.exec(url)![1]!;
        if (day === failDay) return { status: 503, headers: {}, body: '' };
        return { status: 200, headers: {}, body: edgarBody(day, Number(day.slice(-1))) };
      },
      { ingestStore: store },
    );
    const t0 = new Date('2026-11-17T09:00:00Z');
    const first = await pullDueFeeds({ now: t0, sources: [edgar()], acquisition: deps });
    expect(first[0]).toMatchObject({ source: 'sec-edgar-8k', error: 'HTTP 503', inserted: 1 });
    expect(saved.map((c) => c.shard)).toEqual(['2026-11-14']);
    expect(saved[0]!.snapshot).toBe('efts/8-K/v1');
    expect(Object.values(saved[0]!.hashes)[0]).toMatch(/^[0-9a-f]{64}$/);

    failDay = null;
    fetched.length = 0;
    const second = await pullDueFeeds({ now: new Date(t0.getTime() + 13 * HOUR), sources: [edgar()], acquisition: deps });
    expect(second[0]).toMatchObject({ error: null, resumedPast: ['2026-11-14'], inserted: 2 });
    expect(fetched.map((u) => /startdt=([\d-]+)/.exec(u)![1])).toEqual(['2026-11-15', '2026-11-16']);

    // The next day only the new day is read; the three finished days are never asked again.
    fetched.length = 0;
    const third = await pullDueFeeds({ now: new Date(t0.getTime() + 26 * HOUR), sources: [edgar()], acquisition: deps });
    expect(third[0]).toMatchObject({ error: null, resumedPast: ['2026-11-15', '2026-11-16'], inserted: 1 });
    expect(fetched.map((u) => /startdt=([\d-]+)/.exec(u)![1])).toEqual(['2026-11-17']);

    const rows = await getDb().all<{ title: string; organization: string; url: string }>(`SELECT title, organization, url FROM feed_items WHERE source = 'sec-edgar-8k' ORDER BY external_id`);
    expect(rows.length).toBe(4);
    expect(rows[0]).toMatchObject({ organization: 'ACME 4 CORP', title: '8-K (Current report): ACME 4 CORP' });
    expect(rows[0]!.url).toBe('https://www.sec.gov/Archives/edgar/data/123456/000000000026000004/form8k-2026-11-14.htm');
  });

  const listing = {
    success: true,
    result: {
      title: 'Consumer Complaint Database',
      license_title: 'Public Domain',
      resources: [
        { url: 'https://catalog.data.gov/dataset/consumer-complaint-database', format: 'HTML', name: 'catalog page' },
        { url: 'https://files.consumerfinance.gov/ccdb/complaints.json.zip', format: 'JSON', name: 'Complete dataset (JSON, zipped)' },
        { url: 'https://files.consumerfinance.gov/ccdb/complaints.csv.zip', format: 'CSV', name: 'Complete dataset (CSV, zipped)' },
        { url: 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/', format: 'API', name: 'Consumer complaint API' },
      ],
    },
  };
  const complaints = JSON.stringify({
    hits: {
      hits: [
        { _source: { complaint_id: 9001, company: 'Example Lending LLC', product: 'Mortgage', issue: 'Trouble during payment process', date_received: '2026-11-16T00:00:00-05:00', state: 'TX', company_response: 'In progress' } },
        { _source: { complaint_id: 9002, company: '', product: 'Mortgage', issue: 'no company: dropped' } },
      ],
    },
  });

  it('the Data.gov source reads the provider resource the listing names, never the listing, page or zipped archive', async () => {
    const fetched: string[] = [];
    const { deps, events } = harness(async (url) => {
      fetched.push(url);
      if (url === cfpb().acquisition!.listingUrl) return { status: 200, headers: {}, body: JSON.stringify(listing) };
      if (url.startsWith('https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/')) return { status: 200, headers: { etag: '"c1"' }, body: complaints };
      return { status: 500, headers: {}, body: 'should not be read' };
    });
    const out = await pullDueFeeds({ sources: [cfpb()], acquisition: deps });
    expect(out[0]).toMatchObject({ source: 'data-gov-cfpb-complaints', error: null, fetched: 1, inserted: 1 });
    expect(fetched).toEqual([
      cfpb().acquisition!.listingUrl,
      'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/?size=100&sort=created_date_desc&no_aggs=true',
    ]);
    const provenance = events.find((e) => e.eventType === FEED_ACQUISITION_EVENT && e.provider === 'data-gov-cfpb-complaints' && e.outcome === 'INGESTED');
    expect(provenance?.measures).toMatchObject({ corpus: 'data-gov', resolvedFrom: cfpb().acquisition!.listingUrl, location: fetched[1] });
    const row = await getDb().get<{ organization: string; title: string }>(`SELECT organization, title FROM feed_items WHERE source = 'data-gov-cfpb-complaints'`);
    expect(row).toMatchObject({ organization: 'Example Lending LLC', title: 'Mortgage: Trouble during payment process' });
  });

  it('a listing that names only archives is recorded as unresolved access, and no archive is parsed as JSON', async () => {
    const fetched: string[] = [];
    const onlyArchives = { result: { resources: listing.result.resources.slice(0, 3) } };
    const { deps, events } = harness(async (url) => {
      fetched.push(url);
      return { status: 200, headers: {}, body: JSON.stringify(onlyArchives) };
    });
    const out = await pullDueFeeds({ sources: [cfpb()], acquisition: deps });
    expect(out[0]!.skipped).toMatch(/readable as JSON/);
    expect(fetched).toEqual([cfpb().acquisition!.listingUrl]);
    expect(events.some((e) => e.provider === 'data-gov-cfpb-complaints' && e.outcome === 'PERMISSION_NEED')).toBe(true);
  });
});
