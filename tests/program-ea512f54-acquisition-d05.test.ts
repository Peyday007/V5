import { describe, expect, it } from 'vitest';
import { hostMeasuresPattern, readOperatePermission, recordOperatePermission } from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory, sourceAccessDbLoad } from '../server/services/sources/access.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

/*
 * F-PER-READ-DB-LOAD: a read's acquisition judgments must not each re-read the
 * SOURCE_ACCESS / CONNECTOR_PROPOSED history. The history is loaded once per
 * refresh and shared, and a judgment that has not changed is not written again.
 * A read is never an operation (F-OPERATE-RECORD-UNTRUE), so it reads no operate
 * permission at all: the permission belongs to `operateWorkflow`, which uses it.
 */

const PAGE = 'The dashboard lists 41,000 records for the account in 2025. '.repeat(10);
const ok = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
const empty = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'needs a browser' });

const browserRead = (url: string, caller: string) =>
  readSource(url, {
    resolve: async () => ['93.184.216.34'],
    robotsAllow: async () => true,
    archive: async () => null,
    sitemap: async () => null,
    search: null,
    connector: async () => null,
    direct: async (u) => empty(u),
    browser: async (u) => ok(u),
    caller,
  });

const rowsOf = async (eventType: string, caller: string) =>
  (await getDb().all<{ provider: string | null; measures: string }>(`SELECT provider, measures FROM bin_events WHERE event_type = ? AND workload_class = ?`, [eventType, caller])).map((r) => ({
    provider: r.provider,
    m: JSON.parse(r.measures) as { capability?: string; repeatedUses?: number; host?: string },
  }));

describe('the read path loads its history once per refresh, not per read', () => {
  it('twenty browser reads of one host cost one history load and no query per read', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const caller = 'per-read-load-test';
    const N = 20;
    for (let i = 0; i < N; i++) await browserRead('https://load.example/workflow', caller);
    const load = sourceAccessDbLoad();
    // The SOURCE_ACCESS and CONNECTOR_PROPOSED rows: read together, once, for every consumer.
    expect(load.historyLoads).toBe(1);
    // Two history queries, and nothing per read: a read consults no operate permission.
    expect(load.queries).toBe(2);
    // One SOURCE_ACCESS row per read, and judgments only when they change.
    expect((await rowsOf('SOURCE_ACCESS', caller)).length).toBe(N);
    const judgments = await rowsOf('ACQUISITION_JUDGMENT', caller);
    expect(judgments.length).toBeLessThan(N);
    expect(load.writes).toBeLessThan(2 * N);
    expect(load.judgmentsSkipped).toBeGreaterThan(0);
    expect(load.writes).toBe(N + judgments.length + (await getDb().all(`SELECT 1 FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED' AND workload_class = ?`, [caller])).length);
  });

  it('repetition is still counted from the record, including this process’s own reads, without reading it back', async () => {
    await freshProject();
    resetSourceAccessMemory();
    // A judgment that has not changed is not rewritten for one caller, so each read is made under its own
    // caller: every row then shows the count the held history gave it, without reading the record back.
    await browserRead('https://repeat.example/flow', 'per-read-repeat-1');
    await browserRead('https://repeat.example/flow', 'per-read-repeat-2');
    await browserRead('https://repeat.example/other', 'per-read-repeat-3');
    await browserRead('https://repeat.example/flow', 'per-read-repeat-4');
    const counted = async (caller: string) => (await rowsOf('ACQUISITION_JUDGMENT', caller)).map((r) => [r.m.capability, r.m.repeatedUses]);
    // The first read counted itself; the second counted the first; a different workflow on the host is not repetition.
    expect(await counted('per-read-repeat-1')).toEqual([['ACQUIRE', 1]]);
    expect(await counted('per-read-repeat-2')).toEqual([['ACQUIRE', 2]]);
    expect(await counted('per-read-repeat-3')).toEqual([['ACQUIRE', 2]]);
    expect(await counted('per-read-repeat-4')).toEqual([['ACQUIRE', 3]]);
    const load = sourceAccessDbLoad();
    expect(load.historyLoads).toBe(1);
    expect(load.queries).toBe(2);
  });

  it('a grant or a revocation never changes how a read is recorded: a read is never an operation under an account', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await recordOperatePermission({ host: 'revoke.example', granted: true, accountRef: 'owner login for revoke', grantedBy: 'owner' });
    await browserRead('https://revoke.example/flow', 'revoke-before');
    await recordOperatePermission({ host: 'revoke.example', granted: false, grantedBy: 'owner' });
    await browserRead('https://revoke.example/flow', 'revoke-after');
    const capabilities = async (caller: string) => (await rowsOf('ACQUISITION_JUDGMENT', caller)).map((r) => r.m.capability);
    expect(await capabilities('revoke-before')).toEqual(['ACQUIRE']);
    expect(await capabilities('revoke-after')).toEqual(['ACQUIRE']);
    const named = await getDb().all(`SELECT 1 FROM bin_events WHERE event_type IN ('ACQUISITION_JUDGMENT', 'CONNECTOR_PROPOSED') AND (measures LIKE '%owner login for revoke%' OR measures LIKE '%PERMISSION_RECORD%')`);
    expect(named).toEqual([]);
  });
});

describe('the permission reader reads one host’s rows only', () => {
  it('selects by the host in measures, and a wildcard character in a host is not a wildcard', async () => {
    expect(hostMeasuresPattern('A_b.example')).toBe('%"host":"a\\_b.example"%');
    await freshProject();
    await recordOperatePermission({ host: 'a_b.example', granted: true, accountRef: 'login one', grantedBy: 'owner' });
    await recordOperatePermission({ host: 'axb.example', granted: false, grantedBy: 'owner' });
    expect((await readOperatePermission('a_b.example')).permitted).toBe(true);
    expect((await readOperatePermission('axb.example')).permitted).toBe(false);
    // Unrelated hosts' rows do not push a host's own grant out of the window.
    for (let i = 0; i < 30; i++) await recordOperatePermission({ host: `other-${i}.example`, granted: false, grantedBy: 'owner' });
    expect((await readOperatePermission('a_b.example')).permitted).toBe(true);
  });
});
