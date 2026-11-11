import { describe, expect, it } from 'vitest';
import {
  interfaceRecurrenceFromRows,
  judgeAcquisitionNeed,
  recordAcquisitionJudgment,
  recordSiteAccountGrant,
  repeatedUseFromRows,
  siteAccountFromRows,
} from '../server/services/sources/acquisition.ts';
import { readSource, resetSourceAccessMemory } from '../server/services/sources/access.ts';
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

/*
 * The finding this guards: the only production producer of OPERATE judgments
 * (`operateEvidenceOfRead`) states no account, so OPERATE could never select
 * BROWSER, propose a connector or convert a routine to a script on production
 * records. An account a person granted is now a record the judgment reads.
 */
describe('OPERATE runs under an account a person granted on record', () => {
  const grantRow = (host: string, at: string, outcome = 'GRANTED', extra: Record<string, unknown> = {}) => ({
    outcome,
    at,
    measures: JSON.stringify({ host, accountLabel: 'research login', grantedBy: 'owner@example.org', paths: [], expiresAt: null, ...extra }),
  });

  it('the latest grant row for the host decides; revoked, lapsed or other hosts are none', () => {
    expect(siteAccountFromRows([grantRow('portal.example', hoursAgo(2))], 'Portal.Example', { now: NOW })).toMatchObject({
      host: 'portal.example',
      accountLabel: 'research login',
      grantedBy: 'owner@example.org',
    });
    expect(siteAccountFromRows([grantRow('portal.example', hoursAgo(2)), grantRow('portal.example', hoursAgo(1), 'REVOKED')], 'portal.example', { now: NOW })).toBeNull();
    expect(siteAccountFromRows([grantRow('portal.example', hoursAgo(2), 'REVOKED'), grantRow('portal.example', hoursAgo(1))], 'portal.example', { now: NOW })).not.toBeNull();
    expect(siteAccountFromRows([grantRow('portal.example', hoursAgo(2), 'GRANTED', { expiresAt: hoursAgo(1) })], 'portal.example', { now: NOW })).toBeNull();
    expect(siteAccountFromRows([grantRow('other.example', hoursAgo(2))], 'portal.example', { now: NOW })).toBeNull();
  });

  it('a path-limited grant covers only its paths, and never a need with no known path', () => {
    const rows = [grantRow('portal.example', hoursAgo(2), 'GRANTED', { paths: ['/reports'] })];
    expect(siteAccountFromRows(rows, 'portal.example', { now: NOW, path: '/reports/2026' })).not.toBeNull();
    expect(siteAccountFromRows(rows, 'portal.example', { now: NOW, path: '/admin' })).toBeNull();
    expect(siteAccountFromRows(rows, 'portal.example', { now: NOW })).toBeNull();
  });

  it('a grant names the account and refuses to carry a credential', async () => {
    const recorded: Record<string, unknown>[] = [];
    const record = (async (e: Record<string, unknown>) => void recorded.push(e)) as never;
    await recordSiteAccountGrant({ host: 'Portal.Example', accountLabel: 'research login', grantedBy: 'owner@example.org', paths: ['reports/'] }, { record });
    expect(recorded[0]).toMatchObject({ eventType: 'SITE_ACCOUNT_GRANT', outcome: 'GRANTED', evidenceClass: 'OPERATOR_POLICY' });
    expect((recorded[0] as { measures: { host: string; paths: string[] } }).measures).toMatchObject({ host: 'portal.example', paths: ['/reports'] });
    await expect(recordSiteAccountGrant({ host: 'p.example', accountLabel: 'password: hunter2', grantedBy: 'o' }, { record })).rejects.toThrow(/credential/);
    await expect(recordSiteAccountGrant({ host: 'p.example', accountLabel: 'x', grantedBy: '' }, { record })).rejects.toThrow();
    expect(recorded).toHaveLength(1);
  });

  it("the production producer's false is overridden by a grant on record: BROWSER is selected and a connector proposed", async () => {
    const recorded: { eventType: string; outcome: string; measures: Record<string, unknown> }[] = [];
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'operate the interface at https://portal.example/search', host: 'portal.example' },
      { interactiveInterfaceOnly: true, interfaceUnfamiliarOrChanged: false, authorizedAccountOnRecord: false, blockedAtBoundary: false, requiresLicence: false },
      {
        repeatedUse: async () => ({ repeatedUses: 3, repeatedUsesNeedingFallback: 3 }),
        accountOnRecord: async (host, path) => (host === 'portal.example' && path === '/search' ? { host, accountLabel: 'research login', grantedBy: 'owner@example.org', grantedAt: hoursAgo(1), paths: [], expiresAt: null } : null),
        interfaceRecurrence: async () => ({ runs: 3, stable: 3 }),
        proposalOnRecord: async () => false,
        record: (async (e: never) => void recorded.push(e)) as never,
      },
    );
    expect(j.outcome).toBe('ROUTE_SELECTED');
    expect(j.route).toBe('BROWSER');
    expect(j.boundaries).toEqual([]);
    expect(j.reusableConnectorJustified).toBe(true);
    expect(j.reason).toContain('research login');
    expect(recorded.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'CONNECTOR_PROPOSED']);
    expect(recorded[0]!.measures.authorizedAccount).toMatchObject({ label: 'research login', grantedBy: 'owner@example.org', source: 'GRANT_RECORD' });
  });

  it('with no grant on record the same read still stops at NO_AUTHORIZED_ACCOUNT', async () => {
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p', host: 'portal.example' },
      { interactiveInterfaceOnly: true, authorizedAccountOnRecord: false },
      { repeatedUse: async () => ({ repeatedUses: 3, repeatedUsesNeedingFallback: 3 }), accountOnRecord: async () => null, interfaceRecurrence: async () => ({ runs: 0, stable: 0 }), record: (async () => undefined) as never },
    );
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
  });

  it('a grant never gets past a boundary: a CAPTCHA met while operating still stops at a person', async () => {
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p', host: 'portal.example' },
      { interactiveInterfaceOnly: true, authorizedAccountOnRecord: false, blockedAtBoundary: true, boundary: 'CAPTCHA' },
      { repeatedUse: async () => ({ repeatedUses: 3, repeatedUsesNeedingFallback: 3 }), accountOnRecord: async (host) => ({ host, accountLabel: 'l', grantedBy: 'o', grantedAt: hoursAgo(1), paths: [], expiresAt: null }), interfaceRecurrence: async () => ({ runs: 0, stable: 0 }), record: (async () => undefined) as never },
    );
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['ACCESS_BARRIER']);
  });

  it('a stable recurring model-assisted routine under a grant is proposed as a script', async () => {
    const recorded: { eventType: string; outcome: string }[] = [];
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p', host: 'portal.example' },
      { interactiveInterfaceOnly: true, interfaceUnfamiliarOrChanged: true, authorizedAccountOnRecord: false, routeReliability: { BROWSER: 0.1, MODEL_ASSISTED: 0.9 } },
      {
        repeatedUse: async () => ({ repeatedUses: 5, repeatedUsesNeedingFallback: 5 }),
        accountOnRecord: async (host) => ({ host, accountLabel: 'l', grantedBy: 'o', grantedAt: hoursAgo(1), paths: [], expiresAt: null }),
        interfaceRecurrence: async () => ({ runs: 5, stable: 5 }),
        proposalOnRecord: async () => false,
        record: (async (e: never) => void recorded.push(e)) as never,
      },
    );
    expect(j.route).toBe('MODEL_ASSISTED');
    expect(j.convertToScript).toBe(true);
    expect(recorded.find((e) => e.eventType === 'CONNECTOR_PROPOSED')?.outcome).toBe('SCRIPT');
  });

  it('interface recurrence counts browser runs of one workflow and how many held', () => {
    const rows = [
      { at: hoursAgo(1), measures: JSON.stringify({ host: 'portal.example', url: 'https://portal.example/s?q=1', attempts: [{ method: 'DIRECT', readable: false }, { method: 'BROWSER', readable: true }] }) },
      { at: hoursAgo(2), measures: JSON.stringify({ host: 'portal.example', url: 'https://portal.example/s?q=2', attempts: [{ method: 'BROWSER', readable: false }] }) },
      { at: hoursAgo(3), measures: JSON.stringify({ host: 'portal.example', url: 'https://portal.example/s', attempts: [{ method: 'DIRECT', readable: true }] }) },
      { at: hoursAgo(24 * 30), measures: JSON.stringify({ host: 'portal.example', url: 'https://portal.example/s', attempts: [{ method: 'BROWSER', readable: true }] }) },
    ];
    expect(interfaceRecurrenceFromRows(rows, 'portal.example', { now: NOW })).toEqual({ runs: 2, stable: 1 });
  });

  it('end to end on the database: a recorded grant makes the production producer select BROWSER', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await recordSiteAccountGrant({ host: 'granted-portal.example', accountLabel: 'research login', grantedBy: 'owner@example.org' });
    const PAGE = 'The registry lists 1,204 licensed operators as of October 2026. '.repeat(10);
    await readSource('https://granted-portal.example/registry', {
      resolve: async () => ['93.184.216.34'],
      robotsAllow: async () => true,
      learned: async () => null,
      archive: async () => null,
      sitemap: async () => null,
      search: null,
      connector: async () => null,
      direct: async (u) => ({ readable: false, requestedUrl: u, finalUrl: u, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'needs a browser' }),
      browser: async (u) => ({ readable: true, requestedUrl: u, finalUrl: u, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length }),
      caller: 'granted-operate-test',
    });
    const rows = await getDb().all<{ provider: string | null; outcome: string; measures: string }>(
      `SELECT provider, outcome, measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`,
      ['granted-operate-test'],
    );
    const operate = rows.map((r) => ({ ...r, m: JSON.parse(r.measures) as Record<string, unknown> })).find((r) => r.m.capability === 'OPERATE');
    expect(operate?.outcome).toBe('ROUTE_SELECTED');
    expect(operate?.provider).toMatch(/^(BROWSER|MODEL_ASSISTED)$/);
    expect(operate?.m.boundaries).toEqual([]);
    expect(operate?.m.authorizedAccount).toMatchObject({ label: 'research login', source: 'GRANT_RECORD' });
  });
});
