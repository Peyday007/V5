import { describe, expect, it } from 'vitest';
import {
  judgeAcquisitionNeed,
  operatePermissionFromRows,
  readOperatePermission,
  recordAcquisitionJudgment,
  recordOperatePermission,
  repeatedUseFromRows,
} from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory } from '../server/services/sources/access.ts';
import { runOperatePermissionCommand } from '../server/services/sources/operatePermissionCli.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const row = (url: string, at: string, provider = 'DIRECT', attempts?: string[]) => ({
  provider,
  at,
  measures: JSON.stringify({ host: 'example.org', url, ...(attempts ? { attempts: attempts.map((method) => ({ method })) } : {}) }),
});

describe('repeatedUseFromRows counts repeated work, not host traffic', () => {
  it('many different pages on one host are not repetition', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`https://example.org/page-${i}`, hoursAgo(i), 'BROWSER'));
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW }).repeatedUses).toBe(1);
  });

  it('the same workflow read again counts, whatever its query string', () => {
    const rows = [
      row('https://example.org/search?q=a', hoursAgo(1)),
      row('https://example.org/search?q=b', hoursAgo(2)),
      row('https://example.org/search/', hoursAgo(3)),
      row('https://example.org/other', hoursAgo(4)),
    ];
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW }).repeatedUses).toBe(3);
  });

  it('rows outside the window or undated are ignored', () => {
    const rows = [
      row('https://example.org/a', hoursAgo(1)),
      row('https://example.org/a', hoursAgo(24 * 30)),
      { provider: 'DIRECT', at: null, measures: JSON.stringify({ host: 'example.org', url: 'https://example.org/a' }) },
    ];
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW }).repeatedUses).toBe(1);
  });

  it('a fallback is a read whose attempts went beyond DIRECT, not any non-DIRECT provider label', () => {
    const rows = [
      row('https://example.org/a', hoursAgo(1), 'ARCHIVE', ['DIRECT']),
      row('https://example.org/a', hoursAgo(2), 'DIRECT', ['DIRECT', 'BROWSER']),
      row('https://example.org/a', hoursAgo(3), 'DIRECT', ['DIRECT']),
    ];
    expect(repeatedUseFromRows(rows, 'example.org', { now: NOW })).toEqual({ repeatedUses: 3, repeatedUsesNeedingFallback: 1 });
  });

  it('host volume alone does not justify a connector', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`https://example.org/p${i}`, hoursAgo(i), 'BROWSER', ['DIRECT', 'BROWSER']));
    const counted = repeatedUseFromRows(rows, 'example.org', { now: NOW });
    const j = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'x', host: 'example.org' }, { authorizedAccountOnRecord: true, ...counted });
    expect(j.reusableConnectorJustified).toBe(false);
  });
});

describe('OPERATE is reachable through a person\'s permission, and only by an operation that uses the account', () => {
  // What `browserWorkflow.ts operateWorkflow` hands the judgment for an account workflow: an interface-only
  // site, no account established by the caller, and the operation runs in the signed-in session.
  const producerEvidence = () => ({ interactiveInterfaceOnly: true, authorizedAccountOnRecord: false });
  const underAccount = { kind: 'OPERATE', purpose: 'p', host: 'app.example', runsUnderAccount: true } as const;
  const recorder = () => {
    const events: { eventType: string; outcome?: string | null; provider?: string | null; measures?: Record<string, unknown> }[] = [];
    return { events, record: async (e: (typeof events)[number]) => void events.push(e) };
  };
  const granted = async () => ({ permitted: true, accountRef: 'owner account on app.example', grantedBy: 'owner', at: '2026-11-09T00:00:00Z' });
  const none = async () => ({ permitted: false, accountRef: null, grantedBy: null, at: null });

  it('the producer asserts no account, and without a grant the judgment is a handoff', async () => {
    const r = recorder();
    const j = await recordAcquisitionJudgment(underAccount, producerEvidence(), {
      record: r.record as never,
      repeatedUse: async () => ({ repeatedUses: 5, repeatedUsesNeedingFallback: 5 }),
      operatePermission: none,
    });
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
    // No connector is proposed without a grant; the missing grant is opened for a person instead.
    expect(r.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'ACCESS_HANDOFF']);
    expect(r.events[0]!.measures).toMatchObject({ authorizedAccount: 'NONE', accountRef: null });
    expect(r.events[1]!.measures).toMatchObject({ host: 'app.example', boundary: 'NO_AUTHORIZED_ACCOUNT' });
  });

  it('a granted permission turns the same producer evidence into a BROWSER route and a connector proposal', async () => {
    const r = recorder();
    const j = await recordAcquisitionJudgment(underAccount, producerEvidence(), {
      record: r.record as never,
      repeatedUse: async () => ({ repeatedUses: 4, repeatedUsesNeedingFallback: 4 }),
      operatePermission: granted,
      proposalOnRecord: async () => false,
    });
    expect(j.outcome).toBe('ROUTE_SELECTED');
    expect(j.route).toBe('BROWSER');
    expect(j.boundaries).toEqual([]);
    expect(j.reusableConnectorJustified).toBe(true);
    expect(r.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'CONNECTOR_PROPOSED']);
    expect(r.events[0]!.measures).toMatchObject({ authorizedAccount: 'PERMISSION_RECORD', accountRef: 'owner account on app.example' });
    expect(r.events[1]).toMatchObject({ provider: 'BROWSER', outcome: 'CONNECTOR' });
  });

  it('an unfamiliar interface under a grant is operated, not handed off', async () => {
    const ev = { ...producerEvidence(), interfaceUnfamiliarOrChanged: true };
    const r = recorder();
    const j = await recordAcquisitionJudgment(underAccount, ev, {
      record: r.record as never,
      repeatedUse: async () => ({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 }),
      operatePermission: granted,
    });
    expect(['BROWSER', 'MODEL_ASSISTED']).toContain(j.route);
    expect(j.boundaries).toEqual([]);
  });

  it('a grant never lifts a hard boundary', async () => {
    const r = recorder();
    const j = await recordAcquisitionJudgment({ ...underAccount, evadesDefenses: true }, producerEvidence(), {
      record: r.record as never,
      repeatedUse: async () => ({ repeatedUses: 9, repeatedUsesNeedingFallback: 9 }),
      operatePermission: granted,
    });
    expect(j.outcome).toBe('REFUSED');
    expect(j.boundaries).toEqual(['EVADE_SITE_DEFENSES']);
  });

  it('a grant is never named on a judgment whose operation does not run under the account', async () => {
    let consulted = 0;
    const r = recorder();
    const j = await recordAcquisitionJudgment({ kind: 'OPERATE', purpose: 'p', host: 'app.example' }, producerEvidence(), {
      record: r.record as never,
      repeatedUse: async () => ({ repeatedUses: 4, repeatedUsesNeedingFallback: 4 }),
      operatePermission: async () => {
        consulted += 1;
        return granted();
      },
      proposalOnRecord: async () => false,
    });
    expect(consulted).toBe(0);
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
    // The missing account is opened for a person to act on; neither row names the grant's account.
    expect(r.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'ACCESS_HANDOFF']);
    expect(r.events[0]!.measures).toMatchObject({ authorizedAccount: 'NONE', accountRef: null });
    expect(r.events[1]!.measures).toMatchObject({ host: 'app.example', boundary: 'NO_AUTHORIZED_ACCOUNT' });
    expect(JSON.stringify(r.events[1]!.measures)).not.toContain('owner account on');
  });

  it('the newest row for the host decides, and a revocation ends the grant', () => {
    const row = (outcome: string, at: string, host = 'app.example', accountRef: string | null = 'acct') => ({
      outcome,
      at,
      measures: JSON.stringify({ host, accountRef, grantedBy: 'owner' }),
    });
    expect(operatePermissionFromRows([], 'app.example').permitted).toBe(false);
    expect(operatePermissionFromRows([row('GRANTED', '2026-11-01T00:00:00Z')], 'APP.example').permitted).toBe(true);
    expect(operatePermissionFromRows([row('GRANTED', '2026-11-01T00:00:00Z'), row('REVOKED', '2026-11-02T00:00:00Z')], 'app.example').permitted).toBe(false);
    expect(operatePermissionFromRows([row('REVOKED', '2026-11-01T00:00:00Z'), row('GRANTED', '2026-11-02T00:00:00Z')], 'app.example').permitted).toBe(true);
    expect(operatePermissionFromRows([row('GRANTED', '2026-11-01T00:00:00Z', 'other.example')], 'app.example').permitted).toBe(false);
    expect(operatePermissionFromRows([row('GRANTED', '2026-11-01T00:00:00Z', 'app.example', null)], 'app.example').permitted).toBe(false);
  });

  it('a grant names an account by reference and refuses anything credential-shaped', async () => {
    const r = recorder();
    await expect(recordOperatePermission({ host: 'app.example', granted: true, grantedBy: 'owner' }, { record: r.record as never })).rejects.toThrow();
    await expect(
      recordOperatePermission({ host: 'app.example', granted: true, accountRef: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', grantedBy: 'owner' }, { record: r.record as never }),
    ).rejects.toThrow(/never a credential/);
    expect(r.events).toEqual([]);
  });

  it('end to end: a recorded grant never makes a read record an operation or name the account', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const PAGE = 'The dashboard lists 41,000 records for the account in 2025. '.repeat(10);
    const ok = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
    const empty = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'needs a browser' });
    const read = (caller: string) =>
      readSource('https://granted-app.example/workflow', {
        resolve: async () => ['93.184.216.34'],
        robotsAllow: async () => true,
        learned: async () => null,
        archive: async () => null,
        sitemap: async () => null,
        search: null,
        connector: async () => null,
        direct: async (u) => empty(u),
        browser: async (u) => ok(u),
        caller,
      });
    const operateRows = async (caller: string) =>
      (await getDb().all<{ provider: string | null; measures: string }>(`SELECT provider, measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`, [caller]))
        .map((r) => ({ provider: r.provider, m: JSON.parse(r.measures) as { capability: string; authorizedAccount?: string } }))
        .filter((r) => r.m.capability === 'OPERATE');

    // Before any person placed the host under the operate record, a browser read is a public read: no OPERATE row.
    await read('operate-ungranted');
    expect((await operateRows('operate-ungranted')).map((r) => r.provider)).toEqual([]);

    // The research browser renders signed out (browserMcp.ts): a grant on the host changes nothing about a read.
    await recordOperatePermission({ host: 'granted-app.example', granted: true, accountRef: 'owner login for granted-app', grantedBy: 'owner' });
    expect((await readOperatePermission('granted-app.example')).permitted).toBe(true);
    await read('operate-granted-1');
    await read('operate-granted-2');
    expect((await operateRows('operate-granted-1')).map((r) => r.provider)).toEqual([]);
    expect((await operateRows('operate-granted-2')).map((r) => r.provider)).toEqual([]);
    const judgments = await getDb().all<{ measures: string }>(`SELECT measures FROM bin_events WHERE event_type IN ('ACQUISITION_JUDGMENT', 'CONNECTOR_PROPOSED')`);
    expect(judgments.length).toBeGreaterThan(0);
    for (const j of judgments) {
      expect(j.measures).not.toContain('owner login for granted-app');
      expect(j.measures).not.toContain('PERMISSION_RECORD');
      expect(j.measures).not.toContain('"capability":"OPERATE"');
    }

    await recordOperatePermission({ host: 'granted-app.example', granted: false, grantedBy: 'owner' });
    await read('operate-revoked');
    expect((await operateRows('operate-revoked')).map((r) => r.provider)).toEqual([]);
  });
});

describe('a person grants an operate permission from the terminal, and a read never claims it', () => {
  it('refuses incomplete or credential-shaped commands without writing a row', async () => {
    const writes: unknown[] = [];
    const record = (async (i: unknown) => {
      writes.push(i);
      return { permitted: true, accountRef: 'x', grantedBy: 'x', at: null };
    }) as never;
    expect((await runOperatePermissionCommand([], { record })).code).toBe(2);
    expect((await runOperatePermissionCommand(['grant', '--host', 'a.example', '--by', 'owner'], { record })).code).toBe(2);
    expect((await runOperatePermissionCommand(['grant', '--host', 'a.example', '--account', 'acct'], { record })).code).toBe(2);
    expect((await runOperatePermissionCommand(['delete', '--host', 'a.example'], { record })).code).toBe(2);
    expect(writes).toEqual([]);
    const refused = await runOperatePermissionCommand(['grant', '--host', 'a.example', '--account', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '--by', 'owner']);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/never a credential/);
    expect(refused.out).not.toContain('ghp_');
  });

  it('end to end: grant and revoke from the terminal are on record, and reads of the host never record an operation under it', async () => {
    await freshProject();
    resetSourceAccessMemory();
    const PAGE = 'The account dashboard lists 312 open orders for the week. '.repeat(10);
    const ok = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
    const empty = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'needs a browser' });
    const read = (caller: string) =>
      readSource('https://cli-granted.example/orders', {
        resolve: async () => ['93.184.216.34'],
        robotsAllow: async () => true,
        learned: async () => null,
        archive: async () => null,
        sitemap: async () => null,
        search: null,
        connector: async () => null,
        direct: async (u) => empty(u),
        browser: async (u) => ok(u),
        caller,
      });
    const operated = async (caller: string) =>
      (await getDb().all<{ provider: string | null; measures: string }>(`SELECT provider, measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`, [caller]))
        .map((r) => ({ provider: r.provider, m: JSON.parse(r.measures) as { capability: string; authorizedAccount?: string } }))
        .filter((r) => r.m.capability === 'OPERATE');

    expect((await runOperatePermissionCommand(['show', '--host', 'cli-granted.example'])).out).toMatch(/no standing permission/);
    await read('cli-before');
    expect((await operated('cli-before')).map((r) => r.provider)).toEqual([]);

    const granted = await runOperatePermissionCommand(['grant', '--host', 'CLI-Granted.example', '--account', 'ops login for cli-granted', '--by', 'owner']);
    expect(granted.code).toBe(0);
    expect(granted.out).toMatch(/may operate this site under "ops login for cli-granted"/);
    expect((await readOperatePermission('cli-granted.example')).accountRef).toBe('ops login for cli-granted');
    await read('cli-granted-1');
    await read('cli-granted-2');
    expect((await operated('cli-granted-1')).map((r) => r.provider)).toEqual([]);
    expect((await operated('cli-granted-2')).map((r) => r.provider)).toEqual([]);
    const proposals = await getDb().all<{ provider: string; measures: string }>(`SELECT provider, measures FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED'`);
    expect(proposals.some((p) => (JSON.parse(p.measures) as { capability: string }).capability === 'OPERATE')).toBe(false);

    expect((await runOperatePermissionCommand(['revoke', '--host', 'cli-granted.example', '--by', 'owner'])).code).toBe(0);
    expect((await readOperatePermission('cli-granted.example')).permitted).toBe(false);
    await read('cli-revoked');
    expect((await operated('cli-revoked')).map((r) => r.provider)).toEqual([]);
  });
});
