import { describe, expect, it } from 'vitest';
import {
  acquisitionHistoryLoads,
  readOperatePermission,
  recordOperatePermission,
} from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory } from '../server/services/sources/access.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

/*
 * The acquisition judgments run on every public read. Their history (SOURCE_ACCESS,
 * OPERATE_PERMISSION, CONNECTOR_PROPOSED rows) is loaded once per refresh, not per
 * read, and what the process writes is seen at once (§61/§63).
 */
const PAGE = 'The portal lists 1,204 filings for the quarter, with the agency and date. '.repeat(10);
const ok = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
const empty = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'needs a browser' });
const browserRead = (url: string, caller: string) =>
  readSource(url, {
    resolve: async () => ['93.184.216.34'],
    robotsAllow: async () => true,
    learned: async () => null,
    archive: async () => null,
    sitemap: async () => null,
    search: null,
    connector: async () => null,
    routine: async () => null,
    direct: async (u) => empty(u),
    browser: async (u) => ok(u),
    caller,
  });

describe('acquisition judgments do not read their history once per read', () => {
  it('many browser reads load the history once, and still count the reads they made', async () => {
    await freshProject();
    resetSourceAccessMemory();
    for (let i = 0; i < 12; i++) await browserRead('https://load-bound.example/filings', `load-bound-${i}`);
    expect(acquisitionHistoryLoads()).toBe(1);

    const judgments = await getDb().all<{ measures: string }>(
      `SELECT measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`,
      ['load-bound-11'],
    );
    const parsed = judgments.map((j) => JSON.parse(j.measures) as { capability: string; repeatedUses: number | null });
    // The twelfth read's judgment (ACQUIRE only: a read is never an operation) sees all twelve reads of the workflow, counted once.
    expect(parsed.map((p) => p.capability)).toEqual(['ACQUIRE']);
    expect(parsed.every((p) => p.repeatedUses === 12)).toBe(true);
    // A justified connector is proposed once per host and route, not once per read.
    const proposals = await getDb().all<{ provider: string; measures: string }>(`SELECT provider, measures FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED'`);
    const keys = proposals.map((p) => `${(JSON.parse(p.measures) as { host: string }).host}|${p.provider}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a grant and a revocation recorded in this process apply to the next read without a reload', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await browserRead('https://held-grant.example/app', 'held-before');
    expect(acquisitionHistoryLoads()).toBe(1);
    await recordOperatePermission({ host: 'held-grant.example', granted: true, accountRef: 'owner login for held-grant', grantedBy: 'owner' });
    expect((await readOperatePermission('held-grant.example')).permitted).toBe(true);
    await recordOperatePermission({ host: 'held-grant.example', granted: false, grantedBy: 'owner' });
    expect((await readOperatePermission('held-grant.example')).permitted).toBe(false);
    expect(acquisitionHistoryLoads()).toBe(1);
  });

  it('rows another process wrote are read on the next load', async () => {
    await freshProject();
    resetSourceAccessMemory();
    expect((await readOperatePermission('elsewhere.example')).permitted).toBe(false);
    // Written by somebody else: straight into the table, not through this process's writer.
    await getDb().run(
      `INSERT INTO bin_events (id, event_type, at, outcome, evidence_class, measures) VALUES (?, 'OPERATE_PERMISSION', ?, 'GRANTED', 'MEASURED', ?)`,
      ['bev_elsewhere', new Date().toISOString(), JSON.stringify({ host: 'elsewhere.example', accountRef: 'ops login', grantedBy: 'owner' })],
    );
    resetSourceAccessMemory();
    expect((await readOperatePermission('elsewhere.example')).permitted).toBe(true);
  });
});
