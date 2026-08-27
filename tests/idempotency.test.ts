/**
 * Idempotency, at the level where the concurrency lives.
 *
 * Step 5's queue is at-least-once by design. These tests are about what stops
 * that from meaning "twice". They are written as races and as crash windows
 * rather than as features, and every one of them runs against whichever backend
 * the suite is pointed at — including real Postgres with concurrent
 * connections, where a design that only works because nothing is ever truly
 * simultaneous has nowhere to hide.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { createWorker } from '../server/repos/identity.ts';
import { freshProject } from './helpers.ts';
import {
  canonicalize,
  fingerprintRequest,
  assertValidKey,
  logicalEffectKey,
  scopeHash,
} from '../server/services/effects/fingerprint.ts';
import {
  OperationConflict,
  OperationInProgress,
  TerminalEffectFailure,
  runIdempotent,
} from '../server/services/effects/engine.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { clearAdapters, assertAdapterContract } from '../server/services/effects/adapter.ts';
import {
  NATIVE_IDEMPOTENT,
  OPAQUE,
  RECONCILABLE,
  keysSeenBy,
  nativeIdempotentAdapter,
  opaqueAdapter,
  providerLedger,
  reconcilableAdapter,
  registerSyntheticAdapters,
  resetSynthetic,
  sendCount,
  setFault,
} from '../server/services/effects/synthetic.ts';
import { getOperation, listAttempts } from '../server/repos/idempotency.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';

const NS: OperationNamespace = {
  name: 'test.widget.create',
  version: 1,
  principalScope: 'PRINCIPAL',
  retention: 'STANDARD',
};

let projectId = '';
let otherProjectId = '';
let keySeq = 0;

const nextKey = (): string => `test-key-${String(++keySeq).padStart(8, '0')}`;

async function countWidgets(): Promise<number> {
  const row = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM widgets');
  return Number(row?.n ?? 0);
}

/** A minimal domain effect, so the tests are about the engine and not a feature. */
async function makeWidget(
  key: string,
  options: {
    payload?: Record<string, unknown>;
    principalId?: string;
    projectId?: string;
    onExecute?: () => void;
    fail?: 'terminal' | 'transient';
  } = {},
) {
  return await runIdempotent(
    {
      namespace: NS,
      projectId: options.projectId ?? projectId,
      key,
      payload: options.payload ?? { note: 'hello' },
      principalType: 'HUMAN',
      principalId: options.principalId ?? 'usr_one',
    },
    async ({ operation }) => {
      options.onExecute?.();
      if (options.fail === 'terminal') {
        throw new TerminalEffectFailure('INVALID_INPUT', 'this will never work');
      }
      if (options.fail === 'transient') throw new Error('a transient problem');
      const id = `wid_${operation.id.slice(-10)}`;
      await getDb().run('INSERT INTO widgets (id, note) VALUES (?, ?)', [
        id,
        String((options.payload ?? { note: 'hello' })['note']),
      ]);
      return { resultRef: id, resultStatus: 200, value: { id } };
    },
  );
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  otherProjectId = (await createProject({ name: 'Another Project' })).id;
  await getDb().exec('CREATE TABLE IF NOT EXISTS widgets (id text PRIMARY KEY, note text)');
  await getDb().run('DELETE FROM widgets');
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

// ---------------------------------------------------------------------------

describe('canonical fingerprinting', () => {
  it('tells apart every shape that means something different', () => {
    const encodings = [
      {},
      { note: null },
      { note: '' },
      { note: false },
      { note: 0 },
      { note: '0' },
      { note: [] },
      { note: {} },
    ].map(canonicalize);
    // Absent, null, empty, false, zero, "0", [] and {} are eight different
    // requests, and a fingerprint that collapses any pair of them would hand
    // one caller another caller's result.
    expect(new Set(encodings).size).toBe(encodings.length);
  });

  it('treats key order as meaningless and array order as meaningful', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ n: [1, 2] })).not.toBe(canonicalize({ n: [2, 1] }));
  });

  it('cannot be confused by a string that looks like its own separators', () => {
    expect(canonicalize({ a: 'x', b: 'y' })).not.toBe(canonicalize({ a: 'x:b:y' }));
  });

  it('refuses a cycle rather than hanging', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalize(cyclic)).toThrow();
  });

  it('separates the same payload across namespaces and projects', () => {
    const base = { namespace: 'a', namespaceVersion: 1, projectId: 'p', payload: { x: 1 } };
    expect(fingerprintRequest(base)).not.toBe(fingerprintRequest({ ...base, namespace: 'b' }));
    expect(fingerprintRequest(base)).not.toBe(fingerprintRequest({ ...base, projectId: 'q' }));
  });

  it('refuses a key that is too short or has illegal characters', () => {
    expect(() => assertValidKey('short')).toThrow();
    expect(() => assertValidKey('has spaces!')).toThrow();
    expect(assertValidKey('a-perfectly-fine-key')).toBe('a-perfectly-fine-key');
  });
});

describe('key scoping', () => {
  const base = {
    boundary: 'brain',
    projectId: 'p1',
    namespace: 'ns',
    namespaceVersion: 1,
    principalScope: 'PRINCIPAL' as const,
    principalType: 'HUMAN',
    principalId: 'u1',
  };

  it('keeps the same visible key independent across projects', () => {
    expect(scopeHash(base)).not.toBe(scopeHash({ ...base, projectId: 'p2' }));
  });

  it('keeps it independent across principals when the namespace says so', () => {
    expect(scopeHash(base)).not.toBe(scopeHash({ ...base, principalId: 'u2' }));
  });

  it('shares it across principals when the namespace says the intent is one', () => {
    const shared = { ...base, principalScope: 'PROJECT' as const };
    expect(scopeHash(shared)).toBe(scopeHash({ ...shared, principalId: 'someone-else' }));
  });
});

describe('a queue effect key', () => {
  it('is identical across attempts, leases and workers', () => {
    // The single property the whole redelivery guarantee rests on. If this key
    // varied with the attempt, every redelivery would be a fresh effect.
    const a = logicalEffectKey({ workItemId: 'wki_1', namespace: 'ns' });
    const b = logicalEffectKey({ workItemId: 'wki_1', namespace: 'ns' });
    expect(a).toBe(b);
    expect(a).not.toBe(logicalEffectKey({ workItemId: 'wki_2', namespace: 'ns' }));
  });
});

// ---------------------------------------------------------------------------

describe('duplicate suppression', () => {
  it('executes the first request and replays the second', async () => {
    let executions = 0;
    const key = nextKey();
    const first = await makeWidget(key, { onExecute: () => (executions += 1) });
    const second = await makeWidget(key, { onExecute: () => (executions += 1) });

    expect(first.status).toBe('EXECUTED');
    expect(second.status).toBe('REPLAYED');
    expect(executions).toBe(1);
    expect(await countWidgets()).toBe(1);
  });

  it('produces exactly one domain effect from eight concurrent duplicates', async () => {
    let executions = 0;
    const key = nextKey();
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => makeWidget(key, { onExecute: () => (executions += 1) })),
    );

    expect(executions).toBe(1);
    expect(await countWidgets()).toBe(1);
    const executed = settled.filter(
      (result) => result.status === 'fulfilled' && result.value.status === 'EXECUTED',
    );
    expect(executed).toHaveLength(1);
    // Everybody else either replayed or was told it is running. Nobody executed.
    for (const result of settled) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(OperationInProgress);
    }
  });

  it('refuses the same key with different input, and executes nothing', async () => {
    const key = nextKey();
    await makeWidget(key, { payload: { note: 'original' } });
    let executed = false;
    await expect(
      makeWidget(key, { payload: { note: 'different' }, onExecute: () => (executed = true) }),
    ).rejects.toBeInstanceOf(OperationConflict);
    expect(executed).toBe(false);
    expect(await countWidgets()).toBe(1);
  });

  it('does not disclose the earlier request when it refuses', async () => {
    const key = nextKey();
    await makeWidget(key, { payload: { note: 'a-secret-note' } });
    await expect(makeWidget(key, { payload: { note: 'other' } })).rejects.toSatisfy(
      (error: unknown) => !String((error as Error).message).includes('a-secret-note'),
    );
  });

  it('keeps the same key independent in another project', async () => {
    const key = nextKey();
    await makeWidget(key);
    const elsewhere = await makeWidget(key, { projectId: otherProjectId });
    expect(elsewhere.status).toBe('EXECUTED');
    expect(await countWidgets()).toBe(2);
  });
});

describe('failure', () => {
  it('leaves nothing committed when the effect throws after mutating', async () => {
    const before = await countWidgets();
    await expect(
      runIdempotent(
        {
          namespace: NS,
          projectId,
          key: nextKey(),
          payload: { note: 'rollback' },
          principalType: 'HUMAN',
          principalId: 'usr_one',
        },
        async ({ operation }) => {
          await getDb().run('INSERT INTO widgets (id, note) VALUES (?, ?)', [
            `wid_x${operation.id.slice(-8)}`,
            'rollback',
          ]);
          throw new Error('after the mutation, before the commit');
        },
      ),
    ).rejects.toThrow();
    expect(await countWidgets()).toBe(before);
  });

  it('does not re-execute a terminal failure', async () => {
    const key = nextKey();
    await expect(makeWidget(key, { fail: 'terminal' })).rejects.toBeInstanceOf(
      TerminalEffectFailure,
    );
    let executed = false;
    const retry = await makeWidget(key, { onExecute: () => (executed = true) });
    expect(retry.status).toBe('TERMINAL_FAILURE');
    expect(executed).toBe(false);
  });

  it('allows a retryable failure to be executed again', async () => {
    const key = nextKey();
    let attempts = 0;
    await expect(
      makeWidget(key, { fail: 'transient', onExecute: () => (attempts += 1) }),
    ).rejects.toThrow();
    const retry = await makeWidget(key, { onExecute: () => (attempts += 1) });
    expect(retry.status).toBe('EXECUTED');
    expect(attempts).toBe(2);
    expect(await countWidgets()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the adapter contract', () => {
  it('refuses an adapter that claims reconciliation it cannot perform', () => {
    expect(() =>
      assertAdapterContract({ ...reconcilableAdapter, reconcile: undefined }),
    ).toThrow(/reconcilable/);
  });

  it('refuses an opaque adapter that can in fact be reconciled', () => {
    expect(() =>
      assertAdapterContract({ ...opaqueAdapter, reconcile: async () => ({ kind: 'ABSENT' }) }),
    ).toThrow(/opaque/);
  });

  it('refuses a native-idempotent adapter that will not state its key limit', () => {
    // A provider that silently truncates keys de-duplicates on a prefix, which
    // is a different guarantee from the one it advertises.
    expect(() =>
      assertAdapterContract({ ...nativeIdempotentAdapter, providerKeyLimit: undefined }),
    ).toThrow(/key limit/);
  });
});

describe('an external provider with native idempotency', () => {
  const run = (key: string, businessId: string) =>
    runExternalEffect({
      adapter: nativeIdempotentAdapter,
      namespace: { ...NS, name: nativeIdempotentAdapter.namespace, retention: 'PERMANENT' },
      projectId,
      key,
      businessId,
      payload: { note: 'x' },
      principalType: 'HUMAN',
      principalId: 'usr_one',
    });

  it('sends once and replays afterwards', async () => {
    const key = nextKey();
    expect((await run(key, 'biz-1')).status).toBe('CONFIRMED');
    expect((await run(key, 'biz-1')).status).toBe('REPLAYED');
    expect(sendCount(NATIVE_IDEMPOTENT)).toBe(1);
  });

  it('calls it with one stable key, never a per-attempt one', async () => {
    setFault(NATIVE_IDEMPOTENT, 'ACCEPT_THEN_LOSE_RESPONSE');
    const key = nextKey();
    await run(key, 'biz-2');
    setFault(NATIVE_IDEMPOTENT, 'NONE');
    const keys = keysSeenBy(NATIVE_IDEMPOTENT);
    expect(new Set(keys).size).toBe(1);
    // And the provider performed the effect exactly once, which is what the
    // stable key bought.
    expect(providerLedger(NATIVE_IDEMPOTENT).size).toBe(1);
  });

  it('treats a lost response as uncertain rather than failed', async () => {
    setFault(NATIVE_IDEMPOTENT, 'ACCEPT_THEN_LOSE_RESPONSE');
    const outcome = await run(nextKey(), 'biz-3');
    expect(outcome.status).toBe('UNCERTAIN');
  });
});

describe('an external provider that can be asked what it did', () => {
  const run = (key: string, businessId: string) =>
    runExternalEffect({
      adapter: reconcilableAdapter,
      namespace: { ...NS, name: reconcilableAdapter.namespace, retention: 'PERMANENT' },
      projectId,
      key,
      businessId,
      payload: { note: 'x' },
      principalType: 'HUMAN',
      principalId: 'usr_one',
    });

  it('reconciles an ambiguous send instead of repeating it', async () => {
    setFault(RECONCILABLE, 'ACCEPT_THEN_LOSE_RESPONSE');
    const outcome = await run(nextKey(), 'biz-4');
    expect(outcome.status).toBe('RECONCILED');
    expect(sendCount(RECONCILABLE)).toBe(1);
  });

  it('discovers that a send never arrived, and allows a retry', async () => {
    setFault(RECONCILABLE, 'NEVER_ARRIVES');
    const key = nextKey();
    expect((await run(key, 'biz-5')).status).toBe('FAILED');
    setFault(RECONCILABLE, 'NONE');
    expect((await run(key, 'biz-5')).status).toBe('CONFIRMED');
  });
});

describe('an external provider that can neither de-duplicate nor be asked', () => {
  const run = (key: string, businessId: string) =>
    runExternalEffect({
      adapter: opaqueAdapter,
      namespace: { ...NS, name: opaqueAdapter.namespace, retention: 'PERMANENT' },
      projectId,
      key,
      businessId,
      payload: { note: 'x' },
      principalType: 'HUMAN',
      principalId: 'usr_one',
    });

  it('stops at uncertain and never resends automatically', async () => {
    setFault(OPAQUE, 'ACCEPT_THEN_LOSE_RESPONSE');
    const key = nextKey();
    expect((await run(key, 'biz-6')).status).toBe('UNCERTAIN');
    expect(sendCount(OPAQUE)).toBe(1);

    // The provider is healthy again — and it still does not get sent again,
    // because nothing here can know whether the first one landed.
    setFault(OPAQUE, 'NONE');
    expect((await run(key, 'biz-6')).status).toBe('UNCERTAIN');
    expect(sendCount(OPAQUE)).toBe(1);
  });

  it('is never handed a provider key it cannot use', async () => {
    await run(nextKey(), 'biz-7');
    const operations = await getDb().all<{ id: string }>(
      "SELECT id FROM idempotency_operations WHERE namespace = ?",
      [opaqueAdapter.namespace],
    );
    for (const operation of operations) {
      for (const attempt of await listAttempts(operation.id)) {
        expect(attempt.providerKey).toBeNull();
      }
    }
  });

  it('records intent before anything is sent', async () => {
    setFault(OPAQUE, 'THROW');
    const key = nextKey();
    await run(key, 'biz-8');
    const operations = await getDb().all<{ id: string }>(
      "SELECT id FROM idempotency_operations WHERE namespace = ? ORDER BY created_at DESC",
      [opaqueAdapter.namespace],
    );
    const attempts = await listAttempts(operations[0]!.id);
    // The row exists even though the send blew up, which is the difference
    // between "we may have sent something" and "we have no idea".
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]!.startedAt).toBeTruthy();
  });

  it('treats a thrown transport error as uncertain, never as a silent failure', async () => {
    setFault(OPAQUE, 'THROW');
    const outcome = await run(nextKey(), 'biz-9');
    expect(outcome.status).toBe('UNCERTAIN');
  });
});

describe('what the database itself refuses', () => {
  it('will not let two operations share one scoped key', async () => {
    const key = nextKey();
    const outcome = await makeWidget(key);
    const operation = await getOperation(outcome.operation.id);
    await expect(
      getDb().run(
        `INSERT INTO idempotency_operations (id, scope_hash, key_fingerprint, namespace,
           namespace_version, project_id, created_by_type, request_fingerprint,
           fingerprint_version, state, attempt_count, retention_class, reserved_at,
           created_at, updated_at)
         VALUES ('idop_duplicate', ?, ?, 'x', 1, ?, 'SYSTEM', 'f', 1, 'RESERVED', 0,
                 'STANDARD', '2026-01-01', '2026-01-01', '2026-01-01')`,
        [operation!.scopeHash, operation!.keyFingerprint, projectId],
      ),
    ).rejects.toThrow();
  });

  it('will not store an uncertain operation with no reason', async () => {
    const outcome = await makeWidget(nextKey());
    await expect(
      getDb().run(
        `UPDATE idempotency_operations SET state = 'UNCERTAIN', uncertainty_reason = NULL
          WHERE id = ?`,
        [outcome.operation.id],
      ),
    ).rejects.toThrow();
  });
});
