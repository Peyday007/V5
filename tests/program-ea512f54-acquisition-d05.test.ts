import { describe, expect, it } from 'vitest';
import { hostMeasuresPattern, readOperatePermission, recordOperatePermission } from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory, sourceAccessDbLoad } from '../server/services/sources/access.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

/*
 * F-PER-READ-DB-LOAD: a read's acquisition judgments must not each re-read the
 * SOURCE_ACCESS / OPERATE_PERMISSION / CONNECTOR_PROPOSED history. The history is
 * loaded once per refresh and shared; the permission is read for its one host;
 * a judgment that has not changed is not written again.
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

const failed = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 404, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'no sitemap entry' });

const rowsOf = async (eventType: string, caller: string) =>
  (await getDb().all<{ provider: string | null; measures: string }>(`SELECT provider, measures FROM bin_events WHERE event_type = ? AND workload_class = ?`, [eventType, caller])).map((r) => ({
    provider: r.provider,
    m: JSON.parse(r.measures) as { capability?: string; repeatedUses?: number; host?: string; boundaries?: string[]; grantedAccountRef?: string | null },
  }));

describe('the read path loads its history once per refresh, not per read', () => {
  it('twenty browser reads of one host cost one history load and one permission query each — never a history query per judgment', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const caller = 'per-read-load-test';
    const N = 20;
    for (let i = 0; i < N; i++) await browserRead('https://load.example/workflow', caller);
    const load = sourceAccessDbLoad();
    // The SOURCE_ACCESS and CONNECTOR_PROPOSED rows: read together, once, for every consumer.
    expect(load.historyLoads).toBe(1);
    // Two history queries, plus one host-filtered permission query per OPERATE judgment.
    expect(load.queries).toBe(2 + N);
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
    const caller = 'per-read-repeat-test';
    // A page only an archived copy serves: every read needs a route beyond a direct read,
    // so the ACQUIRE judgment changes (a connector becomes justified) when the read repeats.
    const read = () =>
      readSource('https://repeat.example/flow', {
        resolve: async () => ['93.184.216.34'],
        robotsAllow: async () => true,
        archive: async (u) => ok(u),
        sitemap: async (u) => failed(u),
        search: null,
        connector: async () => null,
        direct: async (u) => empty(u),
        browser: async (u) => failed(u),
        caller,
      });
    await read();
    await read();
    const acquire = (await rowsOf('ACQUISITION_JUDGMENT', caller)).filter((r) => r.m.capability === 'ACQUIRE');
    // The first read counted itself (1); the second changed the decision (a connector is now justified) and counted 2.
    expect(acquire.map((r) => r.m.repeatedUses)).toEqual([1, 2]);
    expect(acquire.map((r) => r.provider)).toEqual(['BULK', 'BULK']);
    const proposals = await rowsOf('CONNECTOR_PROPOSED', caller);
    expect(proposals.map((p) => p.m.host)).toEqual(['repeat.example']);
    expect(proposals.map((p) => p.m.capability)).toEqual(['ACQUIRE']);
    // A third read proposes nothing new: the held proposal answers, no proposal query is made.
    await read();
    expect((await rowsOf('CONNECTOR_PROPOSED', caller)).length).toBe(1);
    expect(sourceAccessDbLoad().historyLoads).toBe(1);
  });

  it('a revocation applies to the very next read: the permission is never held', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await recordOperatePermission({ host: 'revoke.example', granted: true, accountRef: 'owner login for revoke', grantedBy: 'owner' });
    await browserRead('https://revoke.example/flow', 'revoke-before');
    await recordOperatePermission({ host: 'revoke.example', granted: false, grantedBy: 'owner' });
    await browserRead('https://revoke.example/flow', 'revoke-after');
    const provider = async (caller: string) => (await rowsOf('ACQUISITION_JUDGMENT', caller)).filter((r) => r.m.capability === 'OPERATE').map((r) => r.provider);
    const operate = async (caller: string) => (await rowsOf('ACQUISITION_JUDGMENT', caller)).filter((r) => r.m.capability === 'OPERATE').map((r) => r.m);
    // The anonymous render is a handoff either way; what changes on the very next read is the grant it reports.
    expect(await provider('revoke-before')).toEqual(['HUMAN_HANDOFF']);
    expect(await provider('revoke-after')).toEqual(['HUMAN_HANDOFF']);
    expect(await operate('revoke-before')).toMatchObject([{ boundaries: ['NO_SIGNED_IN_SESSION'], grantedAccountRef: 'owner login for revoke' }]);
    expect(await operate('revoke-after')).toMatchObject([{ boundaries: ['NO_AUTHORIZED_ACCOUNT'], grantedAccountRef: null }]);
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
