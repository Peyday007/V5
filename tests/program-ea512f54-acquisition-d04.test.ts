import { describe, expect, it } from 'vitest';
import { recordAcquisitionJudgment } from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory, type SourceRead } from '../server/services/sources/access.ts';
import { activeRoutine, leadOfRoute, ROUTINE_RETIRE_FAILURES, routinesFrom, type Routine } from '../server/services/sources/routines.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

const PAGE = 'Official statistics say the median wage was 41,000 dollars in 2025. '.repeat(10);
const okFetch = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
const failFetch = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'empty' });

const proposal = (host: string, route: string, at: string, kind = 'CONNECTOR') => ({ measures: JSON.stringify({ host, route, kind }), at });
const access = (host: string, attempts: { method: string; readable: boolean }[], routine?: { lead: string; proposedAt: string }) => ({
  measures: JSON.stringify({ host, attempts: attempts.map((a) => ({ ...a, reason: null, status: 200, ms: 1 })), ...(routine ? { routine } : {}) }),
  at: '2026-11-10T00:00:00.000Z',
});

describe('a CONNECTOR_PROPOSED row becomes a routine (pure)', () => {
  const AT = '2026-11-09T00:00:00.000Z';

  it('a browser or model-assisted proposal leads with the deterministic browser render', () => {
    expect(leadOfRoute('BROWSER', 'h', [])).toBe('BROWSER');
    expect(leadOfRoute('MODEL_ASSISTED', 'h', [])).toBe('BROWSER');
    const r = routinesFrom([proposal('App.Example', 'MODEL_ASSISTED', AT, 'SCRIPT')], []).get('app.example')!;
    expect(r).toMatchObject({ lead: 'BROWSER', kind: 'SCRIPT', retired: false, proposedAt: AT });
    expect(activeRoutine(r)).toEqual({ route: 'MODEL_ASSISTED', kind: 'SCRIPT', lead: 'BROWSER', proposedAt: AT });
  });

  it('a bulk proposal leads with the bulk route that has actually read the host, and none when none has', () => {
    const rows = [access('h.example', [{ method: 'ARCHIVE', readable: true }]), access('h.example', [{ method: 'ARCHIVE', readable: true }, { method: 'SITEMAP', readable: true }])];
    expect(leadOfRoute('BULK', 'h.example', rows)).toBe('ARCHIVE');
    expect(leadOfRoute('BULK', 'other.example', rows)).toBeNull();
  });

  it('a route the read path already takes first builds nothing and is not active', () => {
    for (const route of ['HTTP', 'NATIVE', 'HUMAN_HANDOFF'] as const) {
      const r = routinesFrom([proposal('h.example', route, AT)], []).get('h.example')!;
      expect(r.lead).toBeNull();
      expect(activeRoutine(r)).toBeNull();
    }
  });

  it('the newest proposal for a host decides its route', () => {
    const r = routinesFrom([proposal('h.example', 'HTTP', '2026-11-01T00:00:00.000Z'), proposal('h.example', 'BROWSER', AT)], []).get('h.example')!;
    expect(r.route).toBe('BROWSER');
  });

  it('counts only reads this routine led, and retires a routine whose led reads fail more than they work', () => {
    const led = (readable: boolean) => access('h.example', [{ method: 'BROWSER', readable }], { lead: 'BROWSER', proposedAt: AT });
    const unrelated = access('h.example', [{ method: 'BROWSER', readable: false }]);
    const healthy = routinesFrom([proposal('h.example', 'BROWSER', AT)], [led(true), led(false), unrelated]).get('h.example')!;
    expect(healthy).toMatchObject({ runs: 2, ok: 1, retired: false });
    const failing = Array.from({ length: ROUTINE_RETIRE_FAILURES }, () => led(false));
    const retired = routinesFrom([proposal('h.example', 'BROWSER', AT)], [...failing, led(true)]).get('h.example')!;
    expect(retired.retired).toBe(true);
    expect(activeRoutine(retired)).toBeNull();
  });
});

describe('readSource runs the routine a proposal built', () => {
  const base = { resolve: async () => ['93.184.216.34'], robotsAllow: async () => true, learned: async () => null, search: null, connector: async () => null };
  const routine = (lead: Routine['lead'], route: Routine['route'] = 'BROWSER'): Routine => ({ host: 'r.example', route, kind: 'CONNECTOR', lead, proposedAt: 'p', runs: 0, ok: 0, retired: false, why: '' });

  it('a browser routine leads before DIRECT and is recorded on the read', async () => {
    const order: string[] = [];
    let recorded: SourceRead | null = null;
    const read = await readSource('https://r.example/list', {
      ...base,
      routine: async () => routine('BROWSER'),
      direct: async (u) => (order.push('DIRECT'), okFetch(u)),
      browser: async (u) => (order.push('BROWSER'), okFetch(u)),
      archive: async () => null,
      sitemap: async () => null,
      record: async (r) => void (recorded = r),
    });
    expect(order).toEqual(['BROWSER']);
    expect(read.method).toBe('BROWSER');
    expect(recorded!.routine).toEqual({ route: 'BROWSER', kind: 'CONNECTOR', lead: 'BROWSER', proposedAt: 'p' });
  });

  it('a bulk routine leads with its route, and a failed routine falls through to the ordinary routes', async () => {
    const order: string[] = [];
    const read = await readSource('https://r.example/doc', {
      ...base,
      routine: async () => routine('ARCHIVE', 'BULK'),
      direct: async (u) => (order.push('DIRECT'), okFetch(u)),
      browser: null,
      archive: async (u) => (order.push('ARCHIVE'), failFetch(u)),
      sitemap: async () => null,
      record: async () => undefined,
    });
    expect(order).toEqual(['ARCHIVE', 'DIRECT']);
    expect(read.method).toBe('DIRECT');
    expect(read.routine?.lead).toBe('ARCHIVE');
  });

  it('robots.txt still governs a browser routine', async () => {
    const order: string[] = [];
    await readSource('https://r.example/x', {
      ...base,
      robotsAllow: async () => false,
      routine: async () => routine('BROWSER'),
      direct: async (u) => (order.push('DIRECT'), okFetch(u)),
      browser: async (u) => (order.push('BROWSER'), okFetch(u)),
      archive: async () => null,
      sitemap: async () => null,
      record: async () => undefined,
    });
    expect(order).toEqual(['DIRECT']);
  });

  it('end to end on the database: a recorded proposal changes how the next read of that host runs', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const host = 'proposal-consumer.example';
    const judged = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'repeated interactive reads', host },
      { interactiveInterfaceOnly: true, bulkSearchDone: true, stableHttpDocuments: false, repeatedUses: 3, repeatedUsesNeedingFallback: 3 },
      { caller: 'proposal-consumer-test' },
    );
    expect(judged.route).toBe('BROWSER');
    expect(judged.reusableConnectorJustified).toBe(true);
    const order: string[] = [];
    const read = await readSource(`https://${host}/search?q=1`, {
      resolve: async () => ['93.184.216.34'],
      robotsAllow: async () => true,
      learned: async () => null,
      search: null,
      connector: async () => null,
      archive: async () => null,
      sitemap: async () => null,
      direct: async (u) => (order.push('DIRECT'), okFetch(u)),
      browser: async (u) => (order.push('BROWSER'), okFetch(u)),
      caller: 'proposal-consumer-test',
    });
    expect(order).toEqual(['BROWSER']);
    expect(read.routine).toMatchObject({ route: 'BROWSER', lead: 'BROWSER' });
    const rows = await getDb().all<{ measures: string }>(`SELECT measures FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND workload_class = ?`, ['proposal-consumer-test']);
    expect(rows.map((r) => (JSON.parse(r.measures) as { routine?: { lead?: string } }).routine?.lead)).toEqual(['BROWSER']);
  });
});
