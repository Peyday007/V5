/**
 * Work-routing schema: a project-scoped ledger, settle-once outcomes, provider
 * cooldowns recorded from refusals, and a routing preference that is data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createAccount } from '../server/repos/fleet.ts';
import {
  accountRoutingPreference, accountRoutingPreferences, setAccountRoutingPreference,
} from '../server/repos/fleet.ts';
import {
  getProviderCapacity, listProviderCapacity, listRoutingBaselines, listRoutingDecisions,
  providerCoolingDown, recordProviderFailure, recordRoutingBaseline, recordRoutingDecision,
  routingCounts, settleRoutingDecision,
} from '../server/repos/workRouting.ts';

beforeEach(async () => {
  await freshProject();
});

describe('routing preference', () => {
  it('defaults to NORMAL and moves only from the value read', async () => {
    const a = await createAccount({ name: 'owner' });
    expect(await accountRoutingPreference(a.id)).toBe('NORMAL');
    expect(await setAccountRoutingPreference({ accountId: a.id, from: 'NORMAL', to: 'LAST_RESORT' })).toBe(true);
    expect(await setAccountRoutingPreference({ accountId: a.id, from: 'NORMAL', to: 'LAST_RESORT' })).toBe(false);
    expect(await accountRoutingPreference(a.id)).toBe('LAST_RESORT');
    expect((await accountRoutingPreferences()).get(a.id)).toBe('LAST_RESORT');
    expect(await accountRoutingPreference('acct_missing')).toBe('NORMAL');
  });

  it('refuses a value outside the closed set', async () => {
    const a = await createAccount({ name: 'x' });
    await expect(getDb().run(`UPDATE fleet_accounts SET routing_preference = 'ALWAYS' WHERE id = ?`, [a.id])).rejects.toThrow();
  });
});

describe('decision ledger', () => {
  it('is scoped to one project', async () => {
    await recordRoutingDecision({ projectId: 'prj_a', workKind: 'FRAGMENT', workRef: 'f1', resource: 'CODE', reasons: ['detector exists'] });
    await recordRoutingDecision({ projectId: 'prj_b', workKind: 'FRAGMENT', workRef: 'f1', resource: 'STRONG', reasons: ['needs reasoning'] });
    expect((await listRoutingDecisions('prj_a')).map((d) => d.resource)).toEqual(['CODE']);
    expect((await listRoutingDecisions('prj_b')).map((d) => d.resource)).toEqual(['STRONG']);
    expect(await listRoutingDecisions('prj_c')).toEqual([]);
    expect(await routingCounts('prj_c')).toEqual([]);
  });

  it('settles a pending decision once, with its failure class', async () => {
    const d = await recordRoutingDecision({
      projectId: 'prj_a', workKind: 'SCREEN', workRef: 's1', resource: 'CHEAP', reasons: ['structured'],
      alternatives: [{ resource: 'CODE', why: 'no detector' }],
    });
    expect(d.outcome).toBe('PENDING');
    expect(d.alternatives).toEqual([{ resource: 'CODE', why: 'no detector' }]);
    expect(await settleRoutingDecision(d.id, { outcome: 'FAILED', failureClass: 'MALFORMED_OUTPUT', validation: 'FAILED' })).toBe(true);
    expect(await settleRoutingDecision(d.id, { outcome: 'SUCCEEDED' })).toBe(false);
    const [stored] = await listRoutingDecisions('prj_a');
    expect(stored?.failureClass).toBe('MALFORMED_OUTPUT');
    expect(stored?.validationResult).toBe('FAILED');
    expect(stored?.settledAt).not.toBeNull();
  });

  it('records reuse and prevention as already settled, and counts them apart', async () => {
    await recordRoutingDecision({ projectId: 'prj_a', workKind: 'FRAGMENT', workRef: 'r', resource: 'CODE', reasons: ['answered'], outcome: 'REUSED', reusedResultId: 'cr_1' });
    await recordRoutingDecision({ projectId: 'prj_a', workKind: 'FRAGMENT', workRef: 'p', resource: 'CODE', reasons: ['duplicate'], outcome: 'PREVENTED' });
    const counts = await routingCounts('prj_a');
    expect(counts.map((c) => `${c.outcome}:${c.count}`).sort()).toEqual(['PREVENTED:1', 'REUSED:1']);
    const reused = (await listRoutingDecisions('prj_a')).find((d) => d.outcome === 'REUSED');
    expect(reused?.reusedResultId).toBe('cr_1');
    expect(reused?.settledAt).not.toBeNull();
  });

  it('refuses a resource or failure class outside the closed sets', async () => {
    await expect(getDb().run(
      `INSERT INTO work_routing_decisions (id, project_id, work_kind, work_ref, resource, reasons, alternatives, outcome, decided_at)
       VALUES ('x', 'p', 'k', 'r', 'FREE', '[]', '[]', 'PENDING', 't')`,
    )).rejects.toThrow();
  });
});

describe('baselines', () => {
  it('keeps measurements per project', async () => {
    await recordRoutingBaseline({ projectId: 'prj_a', label: 'before', windowFrom: 'a', windowTo: 'b', measurements: { claude: 'UNKNOWN', n: 3 } });
    const [b] = await listRoutingBaselines('prj_a');
    expect(b?.measurements).toEqual({ claude: 'UNKNOWN', n: 3 });
    expect(await listRoutingBaselines('prj_b')).toEqual([]);
  });
});

describe('provider capacity', () => {
  it('records a cooldown from a refusal and keeps a limit already known', async () => {
    expect(await providerCoolingDown('omni', 'm1')).toBe(false);
    await recordProviderFailure({ provider: 'omni', model: 'm1', note: '429', cooldownUntil: '2999-01-01T00:00:00.000Z', limitValue: 100, limitUnit: 'requests', windowSeconds: 86400 });
    await recordProviderFailure({ provider: 'omni', model: 'm1', note: 'down', cooldownUntil: '2999-01-02T00:00:00.000Z' });
    const c = await getProviderCapacity('omni', 'm1');
    expect(c?.limitValue).toBe(100);
    expect(c?.lastFailureNote).toBe('down');
    expect(await providerCoolingDown('omni', 'm1')).toBe(true);
    expect(await providerCoolingDown('omni', 'm1', '3000-01-01T00:00:00.000Z')).toBe(false);
    expect(await providerCoolingDown('omni', 'other')).toBe(false);
    expect((await listProviderCapacity()).length).toBe(1);
  });
});
