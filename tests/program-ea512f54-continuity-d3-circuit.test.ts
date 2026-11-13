/**
 * CONT-35 (S-0484, S-0485): the open circuit is enforced, not only reported.
 *
 * repair-F-CIRCUIT-CLAIM-UNENFORCED. The continuity page says of a namespace in
 * OUTAGE that "the circuit is open" and that it is not sent to again until it
 * recovers. That sentence is only truthful if the send paths read it:
 *
 * - `runExternalEffect` withholds a new attempt on a namespace in OUTAGE — the
 *   provider is not called, no attempt row is opened, the operation stays open
 *   for a later attempt under the same key — and says so;
 * - a replay of an effect that already happened still answers while the
 *   circuit is open, because a replay sends nothing;
 * - the circuit closes when the refusals that opened it age out of the window,
 *   and the next attempt is the probe that goes out;
 * - `runIdempotentRequest` refuses a new execution on a namespace in OUTAGE
 *   with 503 CIRCUIT_OPEN, and still replays a settled key;
 * - the one-namespace reader the send paths use agrees with the page's reader.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { runIdempotentRequest } from '../server/services/effects/http.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import { OPAQUE, opaqueAdapter, registerSyntheticAdapters, resetSynthetic, sendCount, setFault, type Fault } from '../server/services/effects/synthetic.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';
import { listAttempts, operationNow } from '../server/repos/idempotency.ts';
import {
  HEALTH_WINDOW_MS,
  OUTAGE_THRESHOLD,
  dependencyHealth,
  judgeDependency,
  namespaceHealth,
  openCircuit,
  planContinuation,
} from '../server/services/effects/posture.ts';

const NS: OperationNamespace = { name: opaqueAdapter.namespace, version: 1, principalScope: 'PRINCIPAL', retention: 'PERMANENT' };

let projectId = '';
let seq = 0;
const nextKey = (): string => `circuit-key-${String(++seq).padStart(8, '0')}`;

function send(key: string, businessId: string) {
  return runExternalEffect({ adapter: opaqueAdapter, namespace: NS, projectId, key, businessId, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one' });
}

async function runWith(fault: Fault, businessId: string) {
  setFault(OPAQUE, fault);
  const out = await send(nextKey(), businessId);
  setFault(OPAQUE, 'NONE');
  return out;
}

async function openTheCircuit(): Promise<void> {
  for (let i = 0; i < OUTAGE_THRESHOLD; i += 1) await runWith('REJECT_RETRYABLE', `biz-down-${i}`);
}

/** Age every recorded outcome past the health window, as time passing would. */
async function ageOutcomes(): Promise<void> {
  const old = new Date(Date.parse(operationNow()) - HEALTH_WINDOW_MS - 60_000).toISOString();
  await getDb().run('UPDATE effect_attempts SET ended_at = ? WHERE ended_at IS NOT NULL', [old]);
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

describe('runExternalEffect honours the open circuit', () => {
  it('withholds a new attempt on a namespace in OUTAGE: the provider is not called and nothing is recorded as sent', async () => {
    await openTheCircuit();
    expect((await openCircuit(projectId, NS.name))?.status).toBe('OUTAGE');
    const sentBefore = sendCount(OPAQUE);

    const out = await send(nextKey(), 'biz-withheld');

    expect(sendCount(OPAQUE)).toBe(sentBefore);
    expect(out.status).toBe('FAILED');
    if (out.status !== 'FAILED') throw new Error('unreachable');
    expect(out.withheld).toContain('circuit is open');
    expect(out.withheld).toContain('Nothing left Brain');
    // Open for a later attempt, not closed for good, and not itself an outcome.
    expect(out.operation.state).toBe('RESERVED');
    expect(out.operation.failureCategory).toBe('DEPENDENCY_UNAVAILABLE');
    expect(await listAttempts(out.operation.id)).toEqual([]);
    // Withholding does not hold the circuit open by itself.
    expect((await namespaceHealth(projectId, NS.name)).observed).toBe(OUTAGE_THRESHOLD);
  });

  it('still replays an effect that already happened while the circuit is open', async () => {
    const key = nextKey();
    const first = await send(key, 'biz-before');
    expect(first.status).toBe('CONFIRMED');
    await openTheCircuit();
    const sentBefore = sendCount(OPAQUE);

    const again = await send(key, 'biz-before');
    expect(again.status).toBe('REPLAYED');
    expect(sendCount(OPAQUE)).toBe(sentBefore);
  });

  it('closes when the refusals age out, and the next attempt is the probe that goes out', async () => {
    await openTheCircuit();
    const key = nextKey();
    const withheld = await send(key, 'biz-probe');
    expect(withheld.status === 'FAILED' && withheld.withheld).toBeTruthy();

    await ageOutcomes();
    expect(await openCircuit(projectId, NS.name)).toBeNull();
    const sentBefore = sendCount(OPAQUE);
    // The same key: the withheld operation was left open for exactly this.
    const probe = await send(key, 'biz-probe');
    expect(sendCount(OPAQUE)).toBe(sentBefore + 1);
    expect(probe.status).toBe('CONFIRMED');
  });

  it('does not open on refusals short of the threshold, nor on an unknown outcome', async () => {
    for (let i = 0; i < OUTAGE_THRESHOLD - 1; i += 1) await runWith('REJECT_RETRYABLE', `biz-short-${i}`);
    await runWith('THROW', 'biz-unknown');
    expect(await openCircuit(projectId, NS.name)).toBeNull();
    const sentBefore = sendCount(OPAQUE);
    expect((await send(nextKey(), 'biz-goes')).status).toBe('CONFIRMED');
    expect(sendCount(OPAQUE)).toBe(sentBefore + 1);
  });
});

describe('runIdempotentRequest honours the open circuit', () => {
  const request = (key: string, execute: () => Promise<{ value: string }>) =>
    runIdempotentRequest<string>(
      { namespace: NS, projectId, key, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one', replay: async () => 'replayed' },
      execute,
    );

  it('refuses a new execution with 503 CIRCUIT_OPEN, and still replays a settled key', async () => {
    const settledKey = nextKey();
    expect((await request(settledKey, async () => ({ value: 'done' }))).value).toBe('done');
    await openTheCircuit();

    let executed = false;
    const refused = await request(nextKey(), async () => {
      executed = true;
      return { value: 'again' };
    }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (error: unknown) => error as { status?: number; detail?: { reason?: string } },
    );
    expect(executed).toBe(false);
    expect(refused.status).toBe(503);
    expect(refused.detail?.reason).toBe('CIRCUIT_OPEN');

    const replay = await request(settledKey, async () => {
      executed = true;
      return { value: 'again' };
    });
    expect(replay).toMatchObject({ value: 'replayed', replayed: true });
    expect(executed).toBe(false);
  });
});

describe('the page and the send path read one judge', () => {
  it('namespaceHealth agrees with dependencyHealth', async () => {
    await openTheCircuit();
    const [page] = await dependencyHealth(projectId);
    const sendPath = await namespaceHealth(projectId, NS.name);
    expect(sendPath).toMatchObject({ status: page!.status, observed: page!.observed, lastOutcomeAt: page!.lastOutcomeAt });
  });

  it('says what the send paths now do', () => {
    const outage = judgeDependency(
      'mail',
      [1, 2, 3].map((m) => ({ at: new Date(Date.parse(operationNow()) - m * 60_000).toISOString(), succeeded: false, category: 'DEPENDENCY_UNAVAILABLE' as const })),
    );
    expect(outage.status).toBe('OUTAGE');
    expect(outage.reason).toContain('runExternalEffect and runIdempotentRequest withhold it');
    const wait = planContinuation({ namespace: 'mail', channel: null, health: outage, unsettled: 0, timeCritical: false, alternatives: [] });
    expect(wait.action).toBe('WAIT_RECOVERABLE');
    expect(wait.reason).toContain('withheld unsent');
  });
});
