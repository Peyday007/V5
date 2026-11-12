/**
 * CONT-35 (S-0484, S-0486): the continuity account reports, for every external
 * operation, what was attempted, what the outside world may have accepted,
 * what is confirmed and what remains unknown — read from the effects engine's
 * own rows, on a real database, without writing anything. A thrown or timed-out
 * send is never read as a failure (invariant 26).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { clearAdapters, type EffectAdapter } from '../server/services/effects/adapter.ts';
import { OPAQUE, opaqueAdapter, registerSyntheticAdapters, resetSynthetic, setFault, type Fault } from '../server/services/effects/synthetic.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';
import { getOperation, latestSentAttempt, listAttempts, listOperations, markUncertain, reserveOperation } from '../server/repos/idempotency.ts';
import { HttpError } from '../server/routes/helpers.ts';
import { readFileSync } from 'node:fs';
import { CONTINUITY_CLI, classifyOperation, effectContinuityAccount, runContinuityCommand, type ContinuityAccount, type ContinuityEntry } from '../server/services/effects/continuity.ts';
import { runIdempotentRequest } from '../server/services/effects/http.ts';
import type { EffectAttempt } from '../server/domain/types.ts';

const NS: OperationNamespace = { name: opaqueAdapter.namespace, version: 1, principalScope: 'PRINCIPAL', retention: 'PERMANENT' };

let projectId = '';
let seq = 0;
const nextKey = (): string => `continuity-key-${String(++seq).padStart(8, '0')}`;

const run = (businessId: string, adapter: EffectAdapter = opaqueAdapter) =>
  runExternalEffect({ adapter, namespace: NS, projectId, key: nextKey(), businessId, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one' });

async function runWith(fault: Fault, businessId: string) {
  setFault(OPAQUE, fault);
  const out = await run(businessId);
  setFault(OPAQUE, 'NONE');
  return out.operation.id;
}

/** An executor that sent and then stopped: the send never answers, so nothing after markAttemptSent runs. */
async function stallAfterSend(businessId: string): Promise<string> {
  const stalled: EffectAdapter = { ...opaqueAdapter, send: () => new Promise(() => undefined) };
  void run(businessId, stalled).catch(() => undefined);
  for (let i = 0; i < 200; i += 1) {
    const row = await getDb().get<{ id: string }>(
      `SELECT o.id FROM idempotency_operations o JOIN effect_attempts a ON a.operation_id = o.id
        WHERE o.project_id = ? AND a.phase = 'SENT'`,
      [projectId],
    );
    if (row) return row.id;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the stalled attempt never reached SENT');
}

async function reserveOnly(): Promise<string> {
  const reserved = await reserveOperation({
    scopeHash: `scope-${nextKey()}`,
    keyFingerprint: `fp-${nextKey()}`,
    namespace: NS.name,
    namespaceVersion: 1,
    projectId,
    requestFingerprint: 'req',
    fingerprintVersion: 1,
    createdByType: 'HUMAN',
    createdById: 'usr_one',
    retentionClass: 'PERMANENT',
    recoverAfter: new Date(Date.now() + 60_000).toISOString(),
  });
  return reserved.operation.id;
}

async function snapshot(): Promise<string> {
  const ops = await getDb().all('SELECT * FROM idempotency_operations ORDER BY id');
  const attempts = await getDb().all('SELECT * FROM effect_attempts ORDER BY id');
  return JSON.stringify({ ops, attempts });
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

describe('the effect continuity account', () => {
  it('puts each interrupted or finished effect in the class its rows support', async () => {
    const confirmed = await runWith('NONE', 'biz-confirmed');
    const threw = await runWith('THROW', 'biz-threw');
    const lost = await runWith('ACCEPT_THEN_LOSE_RESPONSE', 'biz-lost');
    const retryable = await runWith('REJECT_RETRYABLE', 'biz-retryable');
    const terminal = await runWith('REJECT_TERMINAL', 'biz-terminal');
    const neverSent = await reserveOnly();
    const died = await stallAfterSend('biz-died');

    const account = await effectContinuityAccount(projectId);
    const by = new Map(account.entries.map((e) => [e.operationId, e]));
    const entry = (id: string): ContinuityEntry => by.get(id)!;

    expect(entry(confirmed)).toMatchObject({ class: 'CONFIRMED', retrySafe: false, needsReconciliation: false });
    expect(entry(confirmed).receiptRef).toMatch(/^rcpt_/);

    // A thrown send is ambiguous, not a failure: it may have arrived.
    expect(entry(threw)).toMatchObject({ class: 'UNKNOWN', retrySafe: false, needsReconciliation: true });
    expect(entry(threw).reason).toContain('socket hang up');
    expect(entry(lost)).toMatchObject({ class: 'UNKNOWN', retrySafe: false });
    expect(entry(lost).reason).toContain('response was lost');

    expect(entry(died)).toMatchObject({ class: 'MAY_HAVE_BEEN_ACCEPTED', state: 'RESERVED', retrySafe: false, needsReconciliation: true, sentAttempts: 1 });

    expect(entry(retryable)).toMatchObject({ class: 'FAILED_RECOVERABLE', failureCategory: 'DEPENDENCY_UNAVAILABLE', retrySafe: true });
    expect(entry(terminal)).toMatchObject({ class: 'FAILED_EXTERNAL_CONSTRAINT', state: 'FAILED', failureCategory: 'PROVIDER_REJECTED', retrySafe: false });
    expect(entry(retryable).class).not.toBe(entry(terminal).class);

    expect(entry(neverSent)).toMatchObject({ class: 'ATTEMPTED_NOT_SENT', sentAttempts: 0, retrySafe: true, needsReconciliation: false });

    expect(account.totals).toEqual({
      ATTEMPTED_NOT_SENT: 1,
      MAY_HAVE_BEEN_ACCEPTED: 1,
      CONFIRMED: 1,
      UNKNOWN: 2,
      FAILED_RECOVERABLE: 1,
      FAILED_EXTERNAL_CONSTRAINT: 1,
    });
    expect(account.unsettled).toBe(3);
    expect(account.truncated).toBe(false);
    for (const one of account.entries) {
      if (one.class === 'MAY_HAVE_BEEN_ACCEPTED' || one.class === 'UNKNOWN') expect(one.retrySafe).toBe(false);
    }
  });

  it('never classifies a timed-out or thrown send as FAILED', async () => {
    const threw = await runWith('THROW', 'biz-t');
    const silent = await runWith('NEVER_ARRIVES', 'biz-n');
    const account = await effectContinuityAccount(projectId);
    for (const one of account.entries.filter((e) => e.operationId === threw || e.operationId === silent)) {
      expect(one.class).not.toMatch(/^FAILED/);
      expect(one.retrySafe).toBe(false);
    }
  });

  it('a sent attempt whose executor lease ran out is still MAY_HAVE_BEEN_ACCEPTED, never retry-safe', async () => {
    const died = await stallAfterSend('biz-expired');
    const operation = (await getOperation(died))!;
    const attempts = await listAttempts(died);
    expect((await latestSentAttempt(died))?.phase).toBe('SENT');
    const later = new Date(Date.now() + 24 * 3600_000).toISOString();
    const reading = classifyOperation(operation, attempts, later);
    expect(reading).toMatchObject({ class: 'MAY_HAVE_BEEN_ACCEPTED', executorLease: 'EXPIRED', retrySafe: false, needsReconciliation: true });
  });

  it('a reserved operation with sent attempts that ended without a definite refusal is never ATTEMPTED_NOT_SENT', async () => {
    const operation = (await getOperation(await reserveOnly()))!;
    expect(operation.failureCategory).toBeNull();
    const at = new Date().toISOString();
    const attempt = (n: number, outcome: 'SUCCEEDED' | 'FAILED', receiptRef: string | null = null): EffectAttempt => ({
      id: `att-${n}`, operationId: operation.id, attemptNumber: n, executorType: 'HUMAN', executorId: null, workItemId: null,
      leaseId: null, leaseGeneration: null, adapter: OPAQUE, providerKey: null,
      phase: outcome === 'SUCCEEDED' ? 'CONFIRMED' : 'SENT', receiptRef, receiptMeta: {},
      startedAt: at, endedAt: at, outcome, detail: null, requestId: null,
    });

    // Sent, and ended FAILED, but with no category saying the provider did nothing.
    const refusedUncategorised = classifyOperation(operation, [attempt(1, 'FAILED')]);
    expect(refusedUncategorised).toMatchObject({ class: 'MAY_HAVE_BEEN_ACCEPTED', sentAttempts: 1, retrySafe: false, needsReconciliation: true });

    // Sent and confirmed, but the operation was never settled: the receipt is carried, never "not sent".
    const confirmedUnsettled = classifyOperation(operation, [attempt(1, 'FAILED'), attempt(2, 'SUCCEEDED', 'rcpt-9')]);
    expect(confirmedUnsettled).toMatchObject({ class: 'MAY_HAVE_BEEN_ACCEPTED', sentAttempts: 2, receiptRef: 'rcpt-9', retrySafe: false, needsReconciliation: true });

    // The class and the account agree everywhere: ATTEMPTED_NOT_SENT only when nothing was sent.
    for (const reading of [refusedUncategorised, confirmedUnsettled, classifyOperation(operation, [])]) {
      if (reading.class === 'ATTEMPTED_NOT_SENT') {
        expect(reading.sentAttempts).toBe(0);
        expect(reading.needsReconciliation).toBe(false);
      }
    }
    expect(classifyOperation(operation, [])).toMatchObject({ class: 'ATTEMPTED_NOT_SENT', sentAttempts: 0, retrySafe: true });
  });

  it('writes nothing', async () => {
    await runWith('NONE', 'biz-a');
    await runWith('THROW', 'biz-b');
    await runWith('REJECT_RETRYABLE', 'biz-c');
    await reserveOnly();
    const before = await snapshot();
    await effectContinuityAccount(projectId);
    await effectContinuityAccount(projectId);
    expect(await snapshot()).toBe(before);
  });
});

/*
 * F-ACCOUNT-NO-CONSUMER: the account must be readable by a person in the running
 * Brain, not only by a caller who happens to retry the same request. The
 * terminal is its consumer, and the refusal a retrying caller gets names it.
 */
describe('the continuity account has a reader', () => {
  it('the terminal reports, from real rows, what is known and what remains uncertain', async () => {
    const confirmed = await runWith('NONE', 'cli-confirmed');
    const threw = await runWith('THROW', 'cli-threw');
    const retryable = await runWith('REJECT_RETRYABLE', 'cli-retryable');
    const died = await stallAfterSend('cli-died');

    const before = await snapshot();
    const { code, out } = await runContinuityCommand(['account', '--project', projectId]);
    expect(code).toBe(0);
    expect(await snapshot()).toBe(before);

    expect(out).toContain(`${projectId}: 4 external operation(s)`);
    expect(out).toContain('CONFIRMED 1');
    expect(out).toContain('UNKNOWN 1');
    expect(out).toContain('MAY_HAVE_BEEN_ACCEPTED 1');
    expect(out).toContain('FAILED_RECOVERABLE 1');
    expect(out).toContain('2 unsettled');
    // Each effect in doubt is listed with what is known, what is uncertain and that it is never resent.
    for (const id of [threw, died]) {
      const block = out.slice(out.indexOf(`- ${id}`));
      expect(out).toContain(`- ${id}`);
      expect(block).toMatch(/known: /);
      expect(block).toMatch(/uncertain: /);
      expect(block).toContain('never resend');
    }
    expect(out).toContain(`- ${retryable}`);
    // A settled effect is counted but not listed by default, and its receipt is not printed.
    expect(out).not.toContain(`- ${confirmed}`);
    expect(out).not.toMatch(/rcpt_/);

    const all = await runContinuityCommand(['account', '--project', projectId, '--all']);
    expect(all.out).toContain(`- ${confirmed}`);
    expect(all.out).toMatch(/receipt: rcpt_/);

    const json = await runContinuityCommand(['account', '--project', projectId, '--json']);
    const parsed = JSON.parse(json.out) as ContinuityAccount;
    expect(parsed).toEqual({ ...(await effectContinuityAccount(projectId)), at: parsed.at });
  });

  it('refuses a malformed command without reading anything', async () => {
    let read = 0;
    const account = async (id: string) => {
      read += 1;
      return effectContinuityAccount(id);
    };
    expect((await runContinuityCommand([], { account })).code).toBe(2);
    expect((await runContinuityCommand(['account'], { account })).code).toBe(2);
    expect((await runContinuityCommand(['resolve', '--project', projectId], { account })).code).toBe(2);
    expect(read).toBe(0);
  });

  it('the file is runnable as a terminal command, and the retrying caller is pointed to it', async () => {
    const source = readFileSync(new URL('../server/services/effects/continuity.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/if \(process\.argv\[1\] && import\.meta\.url\.endsWith/);
    expect(CONTINUITY_CLI).toContain('server/services/effects/continuity.ts account --project');

    const ns: OperationNamespace = { name: 'continuity.reader', version: 1, principalScope: 'PRINCIPAL', retention: 'PERMANENT' };
    const key = nextKey();
    const request = (execute: () => Promise<{ value: string }>) =>
      runIdempotentRequest<string>(
        { namespace: ns, projectId, key, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one', replay: async () => 'replayed' },
        execute,
      );
    await expect(request(async () => { throw new Error('socket hang up'); })).rejects.toThrow('socket hang up');
    const [operation] = await listOperations(projectId, { limit: 10 });
    expect(await markUncertain(operation!.id, 'went silent')).toBe(true);

    let executed = false;
    const refused = await request(async () => { executed = true; return { value: 'again' }; }).then(
      () => { throw new Error('expected a refusal'); },
      (error: unknown) => error,
    );
    expect(executed).toBe(false);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).message).toContain(CONTINUITY_CLI);
    expect((refused as HttpError).detail).toMatchObject({ reason: 'RECONCILIATION_REQUIRED', operationId: operation!.id });

    // The account the refusal names lists that operation as in doubt.
    const { out } = await runContinuityCommand(['account', '--project', projectId]);
    expect(out).toContain(`- ${operation!.id}`);
    expect(out).toContain('1 unsettled');
  });
});
