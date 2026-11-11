/**
 * CONT-35: a transaction interrupted at a dangerous boundary is reconciled with
 * the provider, never duplicated, and Brain records what it knows and what it
 * does not (§20, §25, invariants 25-27; S-0484 approved reading: when and why
 * reconciliation was applied or skipped is written on the rows).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import {
  reconcileInterruptedEffect,
  runExternalEffect,
} from '../server/services/effects/external.ts';
import { clearAdapters, type EffectAdapter } from '../server/services/effects/adapter.ts';
import {
  OPAQUE,
  RECONCILABLE,
  opaqueAdapter,
  reconcilableAdapter,
  registerSyntheticAdapters,
  resetSynthetic,
  sendCount,
  setFault,
} from '../server/services/effects/synthetic.ts';
import { getOperation, listAttempts } from '../server/repos/idempotency.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';

const ns = (adapter: EffectAdapter): OperationNamespace => ({
  name: adapter.namespace,
  version: 1,
  principalScope: 'PRINCIPAL',
  retention: 'PERMANENT',
});

let projectId = '';
let seq = 0;
const nextKey = (): string => `cont35-key-${String(++seq).padStart(8, '0')}`;

/** The provider is unreachable when the first pass tries to ask it. */
const unreachable: EffectAdapter = {
  ...reconcilableAdapter,
  reconcile: async () => {
    throw new Error('the provider is unreachable');
  },
};

const run = (adapter: EffectAdapter, key: string, businessId: string, runAs: EffectAdapter = adapter) =>
  runExternalEffect({
    adapter: runAs,
    namespace: ns(adapter),
    projectId,
    key,
    businessId,
    payload: { note: 'charge' },
    principalType: 'HUMAN',
    principalId: 'usr_cont35',
  });

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

/** Accepted by the provider, response lost, provider unreachable to ask. */
async function interruptAfterAcceptance(key: string, businessId: string) {
  setFault(RECONCILABLE, 'ACCEPT_THEN_LOSE_RESPONSE');
  const first = await run(reconcilableAdapter, key, businessId, unreachable);
  setFault(RECONCILABLE, 'NONE');
  expect(first.status).toBe('UNCERTAIN');
  return first.operation;
}

/** Simulate a restart: the executor died after markAttemptSent. */
async function dieAfterSend(operationId: string): Promise<void> {
  await getDb().run(
    `UPDATE idempotency_operations
        SET state = 'RESERVED', uncertainty_reason = NULL, completed_at = NULL, recover_after = ?
      WHERE id = ?`,
    ['2000-01-01T00:00:00.000Z', operationId],
  );
  await getDb().run(
    `UPDATE effect_attempts SET phase = 'SENT', ended_at = NULL, outcome = NULL, detail = NULL
      WHERE operation_id = ?`,
    [operationId],
  );
}

describe('CONT-35: interrupted at an uncertain boundary', () => {
  it('records on the rows why the first pass could not settle it', async () => {
    const operation = await interruptAfterAcceptance(nextKey(), 'pay-1');
    const row = await getOperation(operation.id);
    expect(row?.state).toBe('UNCERTAIN');
    expect(row?.uncertaintyReason).toMatch(/reconciliation skipped at \d{4}-\d\d-\d\dT.*unreachable.*nothing was resent/);
  });

  it('a retry with the same key after a restart sends once and settles on the receipt', async () => {
    const key = nextKey();
    const operation = await interruptAfterAcceptance(key, 'pay-2');
    expect(sendCount(RECONCILABLE)).toBe(1);

    const retried = await run(reconcilableAdapter, key, 'pay-2');
    expect(retried.status).toBe('RECONCILED');
    expect(sendCount(RECONCILABLE)).toBe(1);
    const row = await getOperation(operation.id);
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.resultRef).toBe((retried as { receiptRef: string }).receiptRef);
    const attempts = await listAttempts(operation.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('SUCCEEDED');
    expect(attempts[0]?.detail).toMatch(/reconciliation applied at/);
  });

  it('the reconcile-only resume settles it without calling send', async () => {
    const operation = await interruptAfterAcceptance(nextKey(), 'pay-3');
    const guarded: EffectAdapter = {
      ...reconcilableAdapter,
      send: async () => {
        throw new Error('send must not be called by reconciliation');
      },
    };
    const resumed = await reconcileInterruptedEffect({ adapter: guarded, operation, businessId: 'pay-3' });
    expect(resumed?.status).toBe('RECONCILED');
    expect(sendCount(RECONCILABLE)).toBe(1);
    expect((await getOperation(operation.id))?.state).toBe('SUCCEEDED');

    // Running it again reports the settled state, and still sends nothing.
    const again = await reconcileInterruptedEffect({ adapter: guarded, operation, businessId: 'pay-3' });
    expect(again?.status).toBe('REPLAYED');
    expect(sendCount(RECONCILABLE)).toBe(1);
  });
});

describe('CONT-35: executor died after markAttemptSent', () => {
  it('is reconciled by asking, through a retry with the same key', async () => {
    const key = nextKey();
    const operation = await interruptAfterAcceptance(key, 'pay-4');
    await dieAfterSend(operation.id);
    const retried = await run(reconcilableAdapter, key, 'pay-4');
    expect(retried.status).toBe('RECONCILED');
    expect(sendCount(RECONCILABLE)).toBe(1);
    expect((await getOperation(operation.id))?.state).toBe('SUCCEEDED');
  });

  it('is reconciled by asking, through the reconcile-only resume', async () => {
    const operation = await interruptAfterAcceptance(nextKey(), 'pay-5');
    await dieAfterSend(operation.id);
    const resumed = await reconcileInterruptedEffect({
      adapter: reconcilableAdapter,
      operation: (await getOperation(operation.id))!,
      businessId: 'pay-5',
    });
    expect(resumed?.status).toBe('RECONCILED');
    expect(sendCount(RECONCILABLE)).toBe(1);
  });

  it('records why when the provider still cannot confirm it, and resends nothing', async () => {
    const operation = await interruptAfterAcceptance(nextKey(), 'pay-6');
    await dieAfterSend(operation.id);
    const resumed = await reconcileInterruptedEffect({
      adapter: { ...reconcilableAdapter, reconcile: async () => ({ kind: 'ABSENT' }) },
      operation: (await getOperation(operation.id))!,
      businessId: 'pay-6',
    });
    expect(resumed?.status).toBe('UNCERTAIN');
    expect(sendCount(RECONCILABLE)).toBe(1);
    const row = await getOperation(operation.id);
    expect(row?.state).toBe('UNCERTAIN');
    expect(row?.uncertaintyReason).toMatch(/did not record an outcome/);
    expect(row?.uncertaintyReason).toMatch(/reconciliation applied at .*no record of it/);
    const attempts = await listAttempts(operation.id);
    expect(attempts.at(-1)?.outcome).toBe('UNCERTAIN');
    expect(attempts.at(-1)?.detail).toMatch(/reconciliation applied/);
  });

  it('leaves a live lease alone', async () => {
    const operation = await interruptAfterAcceptance(nextKey(), 'pay-7');
    await dieAfterSend(operation.id);
    await getDb().run(`UPDATE idempotency_operations SET recover_after = ? WHERE id = ?`, [
      '2999-01-01T00:00:00.000Z',
      operation.id,
    ]);
    const resumed = await reconcileInterruptedEffect({
      adapter: reconcilableAdapter,
      operation: (await getOperation(operation.id))!,
      businessId: 'pay-7',
    });
    expect(resumed).toBeNull();
    expect((await getOperation(operation.id))?.state).toBe('RESERVED');
  });
});

describe('CONT-35: a provider that cannot be asked', () => {
  it('stays UNCERTAIN with the skip recorded; nothing resent, nothing called failed or succeeded', async () => {
    const key = nextKey();
    setFault(OPAQUE, 'ACCEPT_THEN_LOSE_RESPONSE');
    const first = await run(opaqueAdapter, key, 'outreach-1');
    setFault(OPAQUE, 'NONE');
    expect(first.status).toBe('UNCERTAIN');
    expect(first.operation.uncertaintyReason).toMatch(/reconciliation skipped at .*cannot be asked/);

    const retried = await run(opaqueAdapter, key, 'outreach-1');
    expect(retried.status).toBe('UNCERTAIN');
    const resumed = await reconcileInterruptedEffect({
      adapter: opaqueAdapter,
      operation: first.operation,
      businessId: 'outreach-1',
    });
    expect(resumed?.status).toBe('UNCERTAIN');
    expect(sendCount(OPAQUE)).toBe(1);
    const row = await getOperation(first.operation.id);
    expect(row?.state).toBe('UNCERTAIN');
    expect(row?.resultRef).toBeNull();
    expect(row?.failureCategory).toBeNull();
    expect(row?.uncertaintyReason).toMatch(/reconciliation skipped at .*cannot be asked.*nothing was resent/);
    const attempts = await listAttempts(first.operation.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('UNCERTAIN');
    expect(attempts[0]?.detail).toMatch(/reconciliation skipped/);
  });

  it('an executor that died mid-send is recorded as skipped, never resent', async () => {
    setFault(OPAQUE, 'ACCEPT_THEN_LOSE_RESPONSE');
    const first = await run(opaqueAdapter, nextKey(), 'outreach-2');
    setFault(OPAQUE, 'NONE');
    await dieAfterSend(first.operation.id);
    const resumed = await reconcileInterruptedEffect({
      adapter: opaqueAdapter,
      operation: (await getOperation(first.operation.id))!,
      businessId: 'outreach-2',
    });
    expect(resumed?.status).toBe('UNCERTAIN');
    expect(sendCount(OPAQUE)).toBe(1);
    expect((await getOperation(first.operation.id))?.uncertaintyReason).toMatch(
      /did not record an outcome.*reconciliation skipped/,
    );
  });
});

describe('CONT-35: unaffected work continues', () => {
  it('another key and business id confirms while the interrupted one stays UNCERTAIN', async () => {
    setFault(OPAQUE, 'ACCEPT_THEN_LOSE_RESPONSE');
    const stuck = await run(opaqueAdapter, nextKey(), 'order-stuck');
    setFault(OPAQUE, 'NONE');
    expect(stuck.status).toBe('UNCERTAIN');

    const other = await run(opaqueAdapter, nextKey(), 'order-other');
    expect(other.status).toBe('CONFIRMED');
    expect((await getOperation(stuck.operation.id))?.state).toBe('UNCERTAIN');
    expect((await getOperation(other.operation.id))?.state).toBe('SUCCEEDED');
    expect(sendCount(OPAQUE)).toBe(2);
  });
});
