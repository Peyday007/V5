import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createAccount } from '../server/repos/fleet.ts';
import { getRoutingPreference, listRoutingPreferences, setRoutingPreference } from '../server/repos/fleet.ts';
import {
  getProviderCapacity, isCoolingDown, listBaselines, listDecisions, listGeneralDecisions,
  recordBaseline, recordDecision, recordProviderFailure, settleDecision,
} from '../server/repos/workRouting.ts';
import { getDb } from '../server/db/database.ts';

let a = 'p_a';
let b = 'p_b';
beforeEach(async () => { await freshProject(); });
afterEach(async () => { await teardown(); });

describe('routing schema', () => {
  it('stores LAST_RESORT as data, defaulting to NORMAL, with a guarded move', async () => {
    const acct = await createAccount({ name: 'acc-x', provider: 'claude' } as never);
    expect(await getRoutingPreference(acct.id)).toBe('NORMAL');
    expect(await setRoutingPreference({ accountId: acct.id, from: 'LAST_RESORT', to: 'NORMAL' })).toBe(false);
    expect(await setRoutingPreference({ accountId: acct.id, from: 'NORMAL', to: 'LAST_RESORT' })).toBe(true);
    expect(await setRoutingPreference({ accountId: acct.id, from: 'NORMAL', to: 'LAST_RESORT' })).toBe(false);
    expect((await listRoutingPreferences())[acct.id]).toBe('LAST_RESORT');
    expect(await getRoutingPreference('nobody')).toBe('NORMAL');
    await expect(getDb().run(`UPDATE fleet_accounts SET routing_preference = 'ADMIN' WHERE id = ?`, [acct.id])).rejects.toThrow();
  });

  it('keeps the ledger project-scoped, and shares only decisions marked general', async () => {
    const d = await recordDecision({ projectId: a, workKind: 'research', resource: 'CHEAP', reasons: ['structured'], alternatives: ['STRONG'] });
    await recordDecision({ projectId: b, workKind: 'research', resource: 'STRONG', reasons: ['needs web'], general: true });
    expect((await listDecisions(a)).map((x) => x.id)).toEqual([d.id]);
    expect((await listDecisions(b)).every((x) => x.projectId === b)).toBe(true);
    expect((await listGeneralDecisions()).map((x) => x.projectId)).toEqual([b]);
    expect(await settleDecision({ projectId: b, id: d.id, outcome: 'OK' })).toBe(false); // wrong project
    expect(await settleDecision({ projectId: a, id: d.id, outcome: 'OK', validationResult: 'PASS' })).toBe(true);
    expect(await settleDecision({ projectId: a, id: d.id, outcome: 'LATER' })).toBe(false); // first outcome stands
    const got = (await listDecisions(a))[0]!;
    expect(got).toMatchObject({ outcome: 'OK', validationResult: 'PASS', reasons: ['structured'], alternatives: ['STRONG'] });
  });

  it('refuses an unknown resource', async () => {
    await expect(recordDecision({ projectId: a, workKind: 'x', resource: 'FREE' as never, reasons: [] })).rejects.toThrow();
  });

  it('keeps baselines per project and provider cooldowns without inventing limits', async () => {
    await recordBaseline({ projectId: a, label: 'before', readings: { fires: 3 } });
    expect(await listBaselines(b)).toEqual([]);
    expect((await listBaselines(a))[0]).toMatchObject({ label: 'before', readings: { fires: 3 } });
    const future = new Date(Date.now() + 60_000).toISOString();
    await recordProviderFailure({ provider: 'omni', model: 'm1', failure: 'HTTP 503', cooldownUntil: future });
    expect(await isCoolingDown('omni', 'm1')).toBe(true);
    expect(await isCoolingDown('omni', 'm2')).toBe(false);
    await recordProviderFailure({ provider: 'omni', model: 'm1', failure: 'HTTP 429', cooldownUntil: null });
    expect(await getProviderCapacity('omni', 'm1')).toMatchObject({ limitValue: null, windowSeconds: null, lastFailure: 'HTTP 429' });
    expect(await isCoolingDown('omni', 'm1')).toBe(false);
  });
});
