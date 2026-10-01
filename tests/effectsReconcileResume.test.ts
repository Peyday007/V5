/**
 * A reconcilable external effect is reconciled after its first pass, and a
 * crashed one is never sent twice (Step 6, §20, invariants 25-26).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { clearAdapters, type EffectAdapter } from '../server/services/effects/adapter.ts';
import {
  RECONCILABLE,
  reconcilableAdapter,
  registerSyntheticAdapters,
  resetSynthetic,
  sendCount,
  setFault,
} from '../server/services/effects/synthetic.ts';
import {
  getOperation,
  latestSentAttempt,
  listAttempts,
} from '../server/repos/idempotency.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';

const NS: OperationNamespace = {
  name: reconcilableAdapter.namespace,
  version: 1,
  principalScope: 'PRINCIPAL',
  retention: 'PERMANENT',
};

let projectId = '';
let seq = 0;
const nextKey = (): string => `resume-key-${String(++seq).padStart(8, '0')}`;

type Reconcile = NonNullable<EffectAdapter['reconcile']>;

function adapterWith(reconcile: Reconcile): EffectAdapter {
  return {
    ...reconcilableAdapter,
    reconcile,
    redactReceipt: (meta) => {
      const { first } = meta as { first?: unknown };
      return { first: first === true };
    },
  };
}

const run = (key: string, businessId: string, adapter: EffectAdapter = reconcilableAdapter) =>
  runExternalEffect({
    adapter,
    namespace: NS,
    projectId,
    key,
    businessId,
    payload: { note: 'x' },
    principalType: 'HUMAN',
    principalId: 'usr_one',
  });

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

/** A first send that reached the provider, whose reconcile then failed. */
async function leaveUncertain(key: string, businessId: string) {
  setFault(RECONCILABLE, 'ACCEPT_THEN_LOSE_RESPONSE');
  const first = await run(
    key,
    businessId,
    adapterWith(async () => {
      throw new Error('the provider is unreachable');
    }),
  );
  setFault(RECONCILABLE, 'NONE');
  expect(first.status).toBe('UNCERTAIN');
  return first.operation;
}

describe('latestSentAttempt', () => {
  it('finds an attempt that was sent without a provider key, and ignores one at INTENT', async () => {
    const operation = await leaveUncertain(nextKey(), 'biz-a');
    const sent = await latestSentAttempt(operation.id);
    expect(sent?.providerKey).toBeNull();
    expect(sent?.phase).toBe('UNCERTAIN');

    await getDb().run(`UPDATE effect_attempts SET phase = 'INTENT' WHERE operation_id = ?`, [
      operation.id,
    ]);
    expect(await latestSentAttempt(operation.id)).toBeNull();
  });
});

describe('resumeUncertain', () => {
  it('reconciles on a retry, moves the operation to SUCCEEDED and sends nothing', async () => {
    const key = nextKey();
    const operation = await leaveUncertain(key, 'biz-b');
    expect(sendCount(RECONCILABLE)).toBe(1);

    const retry = await run(key, 'biz-b');
    expect(retry.status).toBe('RECONCILED');
    expect(retry.operation.state).toBe('SUCCEEDED');
    const row = await getOperation(operation.id);
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.resultRef).toBeTruthy();
    expect(row?.resultRef).toBe((retry as { receiptRef: string }).receiptRef);
    expect(sendCount(RECONCILABLE)).toBe(1);

    const attempts = await listAttempts(operation.id);
    expect(attempts.at(-1)?.phase).toBe('CONFIRMED');
    expect(attempts.at(-1)?.endedAt).not.toBeNull();
  });

  it('asks the provider about the business id, and stores a redacted receipt', async () => {
    const key = nextKey();
    const operation = await leaveUncertain(key, 'biz-c');
    const asked: string[] = [];
    const retry = await run(
      key,
      'biz-c',
      adapterWith(async (id) => {
        asked.push(id);
        return { kind: 'FOUND', receiptRef: 'rcpt-1', receiptMeta: { first: true, secret: 'x' } };
      }),
    );
    expect(asked).toEqual(['biz-c']);
    expect(retry.status).toBe('RECONCILED');
    const attempts = await listAttempts(operation.id);
    expect(attempts.at(-1)?.receiptMeta).toEqual({ first: true });
  });

  it.each([
    ['ABSENT', async () => ({ kind: 'ABSENT' as const })],
    ['INCONCLUSIVE', async () => ({ kind: 'INCONCLUSIVE' as const })],
    [
      'a throwing reconcile',
      async (): Promise<never> => {
        throw new Error('down');
      },
    ],
  ])('stays UNCERTAIN and sends nothing on %s', async (_name, reconcile) => {
    const key = nextKey();
    const operation = await leaveUncertain(key, 'biz-d');
    const retry = await run(key, 'biz-d', adapterWith(reconcile as Reconcile));
    expect(retry.status).toBe('UNCERTAIN');
    expect((await getOperation(operation.id))?.state).toBe('UNCERTAIN');
    expect(sendCount(RECONCILABLE)).toBe(1);
  });
});

describe('resumeAfterCrash', () => {
  /** An executor that died after markAttemptSent: RESERVED, recoverable, SENT, open. */
  async function crashAfterSend(key: string, businessId: string) {
    const operation = await leaveUncertain(key, businessId);
    await getDb().run(
      `UPDATE idempotency_operations
          SET state = 'RESERVED', uncertainty_reason = NULL, completed_at = NULL,
              recover_after = ?
        WHERE id = ?`,
      ['2000-01-01T00:00:00.000Z', operation.id],
    );
    await getDb().run(
      `UPDATE effect_attempts SET phase = 'SENT', ended_at = NULL, outcome = NULL
        WHERE operation_id = ?`,
      [operation.id],
    );
    return operation;
  }

  it('reconciles instead of sending a second time', async () => {
    const key = nextKey();
    const operation = await crashAfterSend(key, 'biz-e');
    const retry = await run(key, 'biz-e');
    expect(retry.status).toBe('RECONCILED');
    expect(sendCount(RECONCILABLE)).toBe(1);
    expect((await getOperation(operation.id))?.state).toBe('SUCCEEDED');
  });

  it.each([
    ['ABSENT', async () => ({ kind: 'ABSENT' as const })],
    ['INCONCLUSIVE', async () => ({ kind: 'INCONCLUSIVE' as const })],
    [
      'a throwing reconcile',
      async (): Promise<never> => {
        throw new Error('down');
      },
    ],
  ])('stays UNCERTAIN and sends nothing on %s', async (_name, reconcile) => {
    const key = nextKey();
    const operation = await crashAfterSend(key, 'biz-f');
    const retry = await run(key, 'biz-f', adapterWith(reconcile as Reconcile));
    expect(retry.status).toBe('UNCERTAIN');
    expect((await getOperation(operation.id))?.state).toBe('UNCERTAIN');
    expect(sendCount(RECONCILABLE)).toBe(1);
    // Stated rule, not an accident: after a crash only FOUND resolves it, and
    // the operation records why it is stopped.
    expect((await getOperation(operation.id))?.uncertaintyReason).toMatch(
      /did not record an outcome/,
    );
  });

  it('treats an attempt still at INTENT as never sent, and sends exactly once', async () => {
    const key = nextKey();
    const operation = await crashAfterSend(key, 'biz-g');
    await getDb().run(`UPDATE effect_attempts SET phase = 'INTENT' WHERE operation_id = ?`, [
      operation.id,
    ]);
    // The provider never saw it in this scenario.
    const { providerLedger } = await import('../server/services/effects/synthetic.ts');
    providerLedger(RECONCILABLE).clear();
    const retry = await run(key, 'biz-g');
    expect(retry.status).toBe('CONFIRMED');
    expect(sendCount(RECONCILABLE)).toBe(2);
  });
});
