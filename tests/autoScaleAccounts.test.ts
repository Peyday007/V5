/**
 * Account targets that follow the provider's answers (`autoScaleAccounts`).
 *
 * `proposeScale` had no caller, so an account's concurrency was whatever a
 * person last typed. These pin the applier: it writes only a scope with
 * auto-scale on, and a provider refusal halves the target.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createAccount, currentPolicy, recordAccountRefusal, setPolicy } from '../server/repos/fleet.ts';
import { autoScaleAccounts, resetAutoScale } from '../server/services/dispatch/scaler.ts';

describe('automatic account targets', () => {
  beforeEach(async () => {
    await freshProject();
    resetAutoScale();
  });
  afterEach(async () => {
    await teardown();
  });

  it('halves an auto-scaled account the provider refused, and leaves a manual one alone', async () => {
    const scaled = await createAccount({ provider: 'anthropic', name: `scaled-${Math.random().toString(36).slice(2, 8)}` });
    const manual = await createAccount({ provider: 'anthropic', name: `manual-${Math.random().toString(36).slice(2, 8)}` });
    await setPolicy({ scope: 'ACCOUNT', scopeId: scaled.id, target: 6, autoScale: true, autoScaleCeiling: 8, actor: 'test', reason: 'test' });
    await setPolicy({ scope: 'ACCOUNT', scopeId: manual.id, target: 6, autoScale: false, actor: 'test', reason: 'test' });
    await recordAccountRefusal({ accountId: scaled.id, reason: '429', retryAt: null });
    await recordAccountRefusal({ accountId: manual.id, reason: '429', retryAt: null });

    const steps = await autoScaleAccounts(new Date(), true);
    expect(steps.map((s) => [s.accountId, s.from, s.to])).toEqual([[scaled.id, 6, 3]]);
    expect((await currentPolicy('ACCOUNT', scaled.id))?.target).toBe(3);
    expect((await currentPolicy('ACCOUNT', scaled.id))?.autoScaleCeiling).toBe(8);
    expect((await currentPolicy('ACCOUNT', manual.id))?.target).toBe(6);
  });

  it('runs at most once an interval unless forced', async () => {
    const account = await createAccount({ provider: 'anthropic', name: `once-${Math.random().toString(36).slice(2, 8)}` });
    await setPolicy({ scope: 'ACCOUNT', scopeId: account.id, target: 4, autoScale: true, autoScaleCeiling: 8, actor: 'test', reason: 'test' });
    await recordAccountRefusal({ accountId: account.id, reason: '429', retryAt: null });
    const now = new Date();
    expect(await autoScaleAccounts(now)).toHaveLength(1);
    expect(await autoScaleAccounts(new Date(now.getTime() + 60_000))).toEqual([]);
  });

  it('holds an account that has room, however deep the queue', async () => {
    const account = await createAccount({ provider: 'anthropic', name: `room-${Math.random().toString(36).slice(2, 8)}` });
    await setPolicy({ scope: 'ACCOUNT', scopeId: account.id, target: 4, autoScale: true, autoScaleCeiling: 8, actor: 'test', reason: 'test' });
    expect(await autoScaleAccounts(new Date(), true)).toEqual([]);
    expect((await currentPolicy('ACCOUNT', account.id))?.target).toBe(4);
  });
});
