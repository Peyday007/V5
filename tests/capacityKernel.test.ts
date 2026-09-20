/**
 * The capacity kernel, held to the thing it exists to stop.
 *
 * Every test here is an *absence* rather than a success: the kernel's failure
 * mode is not crashing, it is producing a confident number. A fleet that reports
 * "capacity 5" from five activations that finished one bin between them has not
 * malfunctioned — it has said something false in the one direction somebody acts
 * on. So the assertions below are mostly of the form "this must NOT be claimed",
 * and several were run against a neutered rule to watch them fail before they
 * were trusted to pass.
 *
 * Where a derivation is pure it is called directly with a constructed input,
 * because that is the honest test of a pure function and lets a timing-sensitive
 * case be stated exactly. Where a rule is about rows — a claim's history, an
 * experiment's transitions, whether a tick performs an effect — the real
 * repository functions are driven against the real database, because a fixture
 * that hand-wrote those rows would be testing the fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createAccount,
  createRoutine,
  currentPolicy,
  recordWorkerSession,
  setPolicy,
  renameRoutine,
} from '../server/repos/fleet.ts';
import { createBin, listBins, recordBinEvent } from '../server/repos/bins.ts';
import {
  authorizeExperiment,
  liveClaim,
  claimHistory,
  parkExperimentForUser,
  proposeExperiment,
  recordClaim,
  settleExperiment,
  startCanary,
} from '../server/repos/capacityKernel.ts';
import { maxOverlap, maxProductiveOverlap, observeCapacity, percentile, startRatePerHour, type SessionInterval } from '../server/services/capacity/observe.ts';
import { deriveEnvelope } from '../server/services/capacity/envelope.ts';
import { diagnose } from '../server/services/capacity/diagnose.ts';
import { checkStopConditions, judgeCanary, selectExperiment } from '../server/services/capacity/experiments.ts';
import { capacityKernelTick } from '../server/services/capacity/kernel.ts';
import { capacityReportFrom, capacitySnapshot } from '../server/services/capacity/report.ts';
import { CAPACITY_DIMENSIONS, EXPERIMENT_AUTHORITY } from '../server/domain/capacity.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let accountId = '';
let routineId = '';
let workerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const account = await createAccount({ provider: 'anthropic', name: 'capacity-account' });
  accountId = account.id;
  const worker = await createWorker({
    name: 'capacity-worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    principalType: 'WORKER',
    principalId: worker.id,
    projectId,
    role: 'MEMBER',
    scopes: ['project:read', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_capacity',
    name: 'Capacity A',
    tokenSecretName: 'CAPACITY_SECRET',
  });
  routineId = routine.id;
  await getDb().run('UPDATE fleet_routines SET worker_id = ? WHERE id = ?', [worker.id, routine.id]);
  /*
   * The deployment secret, so this Routine is a real routing candidate.
   *
   * Without it `fleetSnapshot` leaves the Routine out — correctly, since §23
   * says not to spend a fire discovering a missing secret — and every fixture
   * here would then be a fleet with no surface, which is one specific and
   * unusual condition rather than the normal case these tests are about.
   */
  process.env['CAPACITY_SECRET'] = 'deployed-for-the-test';
});

afterEach(() => {
  delete process.env['CAPACITY_SECRET'];
});

function manifest(): BinManifest {
  return {
    objective: 'measure',
    why: 'capacity',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: [],
    outputs: [],
    authorizedActions: [],
    prohibitedActions: [],
    budgetUnits: 1,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: [],
  } as unknown as BinManifest;
}

async function makeBin(title: string, state?: string): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title,
    objective: 'measure',
    manifest: manifest(),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'SURFACE_PROBE_RESEARCH_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  if (state) await getDb().run('UPDATE bins SET state = ? WHERE id = ?', [state, bin.id]);
  return bin.id;
}

/** A session row with a start and an end we choose, as `recordWorkerSession` writes them. */
async function session(input: {
  ref: string;
  binId: string;
  startedAt: string;
  endedAt?: string;
  workerId?: string;
  routineId?: string;
  accountId?: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_sessions (session_ref, worker_id, routine_id, account_id, bin_id,
       lease_generation, observed_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [
      input.ref,
      input.workerId ?? workerId,
      input.routineId ?? routineId,
      input.accountId ?? accountId,
      input.binId,
      input.startedAt,
    ],
  );
  if (input.endedAt) {
    await recordBinEvent({ eventType: 'BIN_RELEASED', binId: input.binId, sessionRef: input.ref });
    await getDb().run(
      `UPDATE bin_events SET at = ? WHERE bin_id = ? AND session_ref = ? AND event_type = 'BIN_RELEASED'`,
      [input.endedAt, input.binId, input.ref],
    );
  }
}

function interval(over: Partial<SessionInterval> & { sessionRef: string; startedAt: string }): SessionInterval {
  return {
    sessionRef: over.sessionRef,
    accountId: over.accountId ?? 'acct',
    routineId: over.routineId ?? 'rtn',
    binId: over.binId ?? 'bin',
    workloadClass: over.workloadClass ?? null,
    startedAt: over.startedAt,
    endedAt: over.endedAt ?? null,
    productive: over.productive ?? false,
  };
}

/* ========================================================================== */

describe('1. one normal execution produces a reconstructable lifecycle', () => {
  it('reads every stage back out of the ledger from its correlated ids', async () => {
    const binId = await makeBin('lifecycle');
    const base = Date.parse('2026-09-20T10:00:00.000Z');
    const at = (seconds: number): string => new Date(base + seconds * 1000).toISOString();

    for (const [type, offset] of [
      ['BIN_READY', 0],
      ['DISPATCH_SENT', 4],
      ['BIN_ASSIGNED', 19],
      ['BIN_ITEM_CLAIMED', 25],
      ['BIN_COMPLETION_ACCEPTED', 120],
    ] as const) {
      await recordBinEvent({
        eventType: type,
        binId,
        projectId,
        accountId,
        routineId,
        sessionRef: 'cse_one',
        workloadClass: 'SURFACE_PROBE_RESEARCH_V1',
      });
      await getDb().run(
        `UPDATE bin_events SET at = ? WHERE bin_id = ? AND event_type = ?`,
        [at(offset), binId, type],
      );
    }

    const observation = await observeCapacity({ now: at(600) });

    // Every stage is reconstructed, and each is the difference between two
    // timestamps Brain wrote rather than anything derived from `now`.
    expect(observation.latencies.readyToFired.p50).toBe(4_000);
    expect(observation.latencies.firedToArrived.p50).toBe(15_000);
    expect(observation.latencies.arrivedToFirstProgress.p50).toBe(6_000);
    expect(observation.latencies.arrivedToCompleted.p50).toBe(101_000);
    expect(observation.latencies.endToEnd.p50).toBe(120_000);
    expect(observation.validatedCompletions.map((one) => one.binId)).toEqual([binId]);
  });
});

describe('2. account attribution survives a display name change', () => {
  it('renaming a Routine changes the label and moves no attribution', async () => {
    const binId = await makeBin('attribution');
    await recordWorkerSession({
      sessionRef: 'cse_attr',
      workerId,
      routineId,
      accountId,
      binId,
      leaseGeneration: 1,
    });

    const before = await observeCapacity();
    expect(before.sessions[0]?.accountId).toBe(accountId);
    expect(before.sessions[0]?.routineId).toBe(routineId);

    /*
     * The production incident this pins: a session attributed to the wrong
     * person because a human-named label was treated as identity. `fleet rename`
     * exists precisely so a label can change, so the label is changed to one
     * naming a different person entirely and the attribution must not move.
     */
    await renameRoutine({ routineId, from: 'Capacity A', to: 'Somebody Else 9-Z' });

    const after = await observeCapacity();
    expect(after.sessions[0]?.accountId).toBe(accountId);
    expect(after.sessions[0]?.routineId).toBe(routineId);
    expect(after.sessions[0]?.sessionRef).toBe('cse_attr');
  });
});

describe('3. the counts stay distinct', () => {
  it('configured, enabled, eligible, offered, admitted, active and productive are seven answers', async () => {
    // Two more definitions, one of them switched off.
    await createRoutine({ accountId, routineRef: 'trig_b', name: 'B', tokenSecretName: 'S_B' });
    const off = await createRoutine({ accountId, routineRef: 'trig_c', name: 'C', tokenSecretName: 'S_C' });
    await getDb().run(`UPDATE fleet_routines SET state = 'QUARANTINED' WHERE id = ?`, [off.id]);

    const observation = await observeCapacity();
    const envelope = deriveEnvelope(observation);

    /*
     * Three definitions exist, two of them are switched on, and exactly one of
     * those two has its deployment secret present — so all three counts differ,
     * which is the whole point of keeping them apart. Collapsing any pair here
     * would report a fleet that can serve twice what it can.
     */
    expect(envelope.readings.DEFINITION_CAPACITY.value).toBe(3);
    expect(envelope.readings.ENABLEMENT_CAPACITY.value).toBe(2);
    expect(envelope.readings.ELIGIBLE_CAPACITY.value).toBe(1);
    expect(envelope.readings.ELIGIBLE_CAPACITY.bound).toBe('EXACT');

    // And the three that have no evidence are unknown rather than zero.
    for (const dimension of ['OFFERED_CONCURRENCY', 'ACTIVE_CONCURRENCY', 'PRODUCTIVE_CONCURRENCY'] as const) {
      expect(envelope.readings[dimension].evidenceClass).toBe('UNKNOWN');
      expect(envelope.readings[dimension].value).toBeNull();
    }
  });

  it('a definition count is a floor and an eligible count is not', async () => {
    const envelope = deriveEnvelope(await observeCapacity());
    expect(envelope.readings.DEFINITION_CAPACITY.bound).toBe('AT_LEAST');
    expect(envelope.readings.ENABLEMENT_CAPACITY.bound).toBe('AT_LEAST');
    expect(envelope.readings.ELIGIBLE_CAPACITY.bound).toBe('EXACT');
  });
});

describe('4. missing telemetry is UNKNOWN and never zero', () => {
  it('every unestablished dimension carries a null value, not a zero', async () => {
    const envelope = deriveEnvelope(await observeCapacity());
    for (const dimension of CAPACITY_DIMENSIONS) {
      const reading = envelope.readings[dimension];
      if (reading.evidenceClass === 'UNKNOWN') {
        expect(reading.value).toBeNull();
        expect(reading.sampleCount).toBe(0);
      } else {
        expect(reading.value).not.toBeNull();
      }
    }
  });

  it('the claims table refuses a value dressed as an unknown, and the reverse', async () => {
    await expect(
      recordClaim({
        dimension: 'ACTIVE_CONCURRENCY',
        scope: 'FLEET',
        value: 0,
        bound: 'EXACT',
        evidenceClass: 'UNKNOWN',
        explanation: 'a zero wearing an unknown',
        sampleCount: 0,
        confidence: 'LOW',
      }),
    ).rejects.toThrow(/UNKNOWN claim carries no value/);

    await expect(
      recordClaim({
        dimension: 'ACTIVE_CONCURRENCY',
        scope: 'FLEET',
        value: null,
        bound: 'EXACT',
        evidenceClass: 'MEASURED',
        explanation: 'an unknown wearing a measurement',
        sampleCount: 3,
        confidence: 'HIGH',
      }),
    ).rejects.toThrow(/UNKNOWN claim carries no value/);
  });

  it('a rate whose denominator is empty is null rather than zero', async () => {
    const snapshot = await capacitySnapshot();
    expect(snapshot.rates.attemptsPerValidatedCompletion).toBeNull();
    expect(snapshot.rates.takeoverRate).toBeNull();
  });

  it('throughput over a window in which nothing ran is null, not a measured zero', async () => {
    /*
     * The CLI printed this contradiction on one screen — `0.00/h — MEASURED`
     * above its own line saying throughput is unknown rather than zero — and the
     * distinction the fix rests on is what this pins: zero completions with
     * sessions running is a real and alarming measurement, and zero completions
     * with nothing running is not a measurement at all.
     */
    const idle = capacityReportFrom(await capacitySnapshot());
    const throughput = idle.proven.find((row) => row.label === 'Validated useful throughput')!;
    expect(throughput.value).toBe('UNKNOWN');
    expect(throughput.evidence).toMatch(/different from a measured zero/);

    // With a session that ran and finished nothing, zero *is* the reading.
    const binId = await makeBin('ran-and-finished-nothing');
    await session({
      ref: 'cse_idle',
      binId,
      startedAt: '2026-09-20T10:00:00.000Z',
      endedAt: '2026-09-20T10:05:00.000Z',
    });
    const busy = await capacitySnapshot();
    expect(busy.rates.validatedCompletionsPerHour).toBe(0);
  });
});

describe('5. a local guardrail is never labelled PROVIDER_ENFORCED', () => {
  it('a fleet target of four with refusals at four reads UNKNOWN, naming the local cause', async () => {
    const binId = await makeBin('local-cap');
    await setPolicy({ scope: 'FLEET', target: 4, actor: 'test', reason: 'a guardrail somebody set' });

    const base = Date.parse('2026-09-20T09:00:00.000Z');
    const at = (m: number): string => new Date(base + m * 60_000).toISOString();
    // Four sessions open, and two provider refusals while they are.
    for (let i = 0; i < 4; i += 1) {
      await session({ ref: `cse_local_${i}`, binId, startedAt: at(0), endedAt: at(30) });
    }
    for (let i = 0; i < 2; i += 1) {
      await recordBinEvent({
        eventType: 'PROVIDER_ALLOWANCE',
        binId,
        accountId,
        routineId,
        evidenceClass: 'PROVIDER_ENFORCED',
        outcome: 'RATE_LIMITED',
        reason: '429',
      });
      await getDb().run(`UPDATE bin_events SET at = ? WHERE event_type = 'PROVIDER_ALLOWANCE' AND at > ?`, [at(10), at(0)]);
    }

    const envelope = deriveEnvelope(await observeCapacity({ now: at(60) }));
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.evidenceClass).toBe('UNKNOWN');
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.explanation).toMatch(/local guardrail/);
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.explanation).toMatch(/fleet target is 4/);
  });

  it('a constant, a schema restriction or an absence of work never produces the label', async () => {
    // Nothing has refused at all, so the ceiling is unknown and the explanation
    // says what would not count as one.
    const envelope = deriveEnvelope(await observeCapacity());
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.evidenceClass).toBe('UNKNOWN');
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.explanation).toMatch(
      /internal target, a scheduler decision or an absence of work is never this/,
    );
  });
});

describe('6. a fifth definition records ≥5, never =5', () => {
  it('records AT_LEAST and says in words that it establishes no maximum', async () => {
    for (const ref of ['b', 'c', 'd', 'e']) {
      await createRoutine({ accountId, routineRef: `trig_${ref}`, name: ref, tokenSecretName: `S_${ref}` });
    }
    const envelope = deriveEnvelope(await observeCapacity());
    expect(envelope.readings.DEFINITION_CAPACITY.value).toBe(5);
    expect(envelope.readings.DEFINITION_CAPACITY.bound).toBe('AT_LEAST');
    expect(envelope.readings.DEFINITION_CAPACITY.explanation).toMatch(/at least 5/);
    expect(envelope.readings.DEFINITION_CAPACITY.explanation).toMatch(/no maximum/);
  });
});

describe('7. five overlapping starts without five results is not productive capacity', () => {
  it('reports active 5 and productive 1, and refuses to let the safe bound follow the larger', async () => {
    const intervals: SessionInterval[] = [];
    for (let i = 0; i < 5; i += 1) {
      intervals.push(
        interval({
          sessionRef: `cse_${i}`,
          startedAt: '2026-09-20T10:00:00.000Z',
          endedAt: '2026-09-20T10:05:00.000Z',
          // Exactly one of the five produced distinct validated work.
          productive: i === 0,
        }),
      );
    }
    expect(maxOverlap(intervals).max).toBe(5);
    expect(maxProductiveOverlap(intervals).max).toBe(1);

    const observation = await observeCapacity();
    const envelope = deriveEnvelope({
      ...observation,
      sessions: intervals,
      validatedCompletions: [{ binId: 'bin', at: '2026-09-20T10:03:00.000Z', eventId: 'bev_1' }],
    });

    expect(envelope.readings.ACTIVE_CONCURRENCY.value).toBe(5);
    expect(envelope.readings.PRODUCTIVE_CONCURRENCY.value).toBe(1);
    // The bound the recommendation is derived from follows the *productive*
    // number, so the fleet is never scaled on five activations that finished one
    // piece of work.
    expect(envelope.readings.OBSERVED_SAFE_LOWER_BOUND.value).toBe(1);
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.value).toBe(1);
    expect(envelope.readings.PRODUCTIVE_CONCURRENCY.explanation).toMatch(/did not turn into/);
  });
});

describe('8. one transient failure is not a hard limit', () => {
  it('a single refusal leaves the ceiling UNKNOWN and says one episode proves one episode', async () => {
    const binId = await makeBin('one-refusal');
    await recordBinEvent({
      eventType: 'PROVIDER_ALLOWANCE',
      binId,
      accountId,
      routineId,
      evidenceClass: 'PROVIDER_ENFORCED',
      outcome: 'RATE_LIMITED',
      reason: '429 once',
    });

    const envelope = deriveEnvelope(await observeCapacity());
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.evidenceClass).toBe('UNKNOWN');
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.explanation).toMatch(/One episode establishes/);
    // The failure *point* is recorded, because a refusal did happen — but on one
    // sample, at LOW confidence, and as an AT_MOST rather than a ceiling.
    expect(envelope.readings.OBSERVED_FAILURE_POINT.bound).toBe('AT_MOST');
    expect(envelope.readings.OBSERVED_FAILURE_POINT.confidence).toBe('LOW');
    expect(envelope.readings.OBSERVED_FAILURE_POINT.explanation).toMatch(/not yet a recurring rule/);
  });
});

describe('9. a repeatable provider boundary is classified only after local causes are gone', () => {
  it('two refusals with no binding local target produce PROVIDER_ENFORCED at the lowest level seen', async () => {
    const binId = await makeBin('real-ceiling');
    const base = Date.parse('2026-09-20T09:00:00.000Z');
    const at = (m: number): string => new Date(base + m * 60_000).toISOString();

    // Two sessions open across the refusals, and a target well above them, so no
    // local guardrail was binding.
    await setPolicy({ scope: 'FLEET', target: 20, actor: 'test', reason: 'deliberately not binding' });
    await session({ ref: 'cse_r1', binId, startedAt: at(0), endedAt: at(40) });
    await session({ ref: 'cse_r2', binId, startedAt: at(0), endedAt: at(40) });

    for (const minute of [10, 20]) {
      await recordBinEvent({
        eventType: 'PROVIDER_ALLOWANCE',
        binId,
        accountId,
        routineId,
        evidenceClass: 'PROVIDER_ENFORCED',
        outcome: 'RATE_LIMITED',
        reason: '429 again',
      });
      await getDb().run(
        `UPDATE bin_events SET at = ? WHERE id = (SELECT id FROM bin_events
           WHERE event_type = 'PROVIDER_ALLOWANCE' AND at > ? ORDER BY at DESC LIMIT 1)`,
        [at(minute), at(50)],
      );
    }

    const envelope = deriveEnvelope(await observeCapacity({ now: at(60) }));
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.evidenceClass).toBe('PROVIDER_ENFORCED');
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.bound).toBe('AT_MOST');
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.value).toBe(2);
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.explanation).toMatch(/no local target was binding/);
  });
});

describe('10. duplicate callbacks cannot inflate throughput', () => {
  it('counts distinct bins rather than acceptance events', async () => {
    const binId = await makeBin('duplicate');
    for (let i = 0; i < 4; i += 1) {
      await recordBinEvent({ eventType: 'BIN_COMPLETION_ACCEPTED', binId, projectId });
    }
    const observation = await observeCapacity();
    expect(observation.validatedCompletions).toHaveLength(1);

    // And a second, genuinely different bin does move it.
    const other = await makeBin('duplicate-2');
    await recordBinEvent({ eventType: 'BIN_COMPLETION_ACCEPTED', binId: other, projectId });
    expect((await observeCapacity()).validatedCompletions).toHaveLength(2);
  });

  it('a productive session counts once however many times its bin was accepted', async () => {
    const binId = await makeBin('dup-overlap', 'COMPLETE');
    await session({
      ref: 'cse_dup',
      binId,
      startedAt: '2026-09-20T10:00:00.000Z',
      endedAt: '2026-09-20T10:05:00.000Z',
    });
    for (let i = 0; i < 3; i += 1) {
      await recordBinEvent({ eventType: 'BIN_COMPLETION_ACCEPTED', binId, projectId });
    }
    const observation = await observeCapacity({ now: '2026-09-20T11:00:00.000Z' });
    expect(maxProductiveOverlap(observation.sessions).max).toBe(1);
  });
});

describe('11. restarting during an experiment cannot duplicate the canary', () => {
  it('a second proposal for a live question returns the existing row rather than a new one', async () => {
    const first = await proposeExperiment({
      kind: 'CONCURRENCY_STAIRCASE',
      dimension: 'PRODUCTIVE_CONCURRENCY',
      scope: 'FLEET',
      hypothesis: 'h',
      successMetric: 's',
      stopCondition: 'c',
      resolvesUnknown: 'u',
      requestedBy: 'test',
    });
    expect(first.created).toBe(true);

    const second = await proposeExperiment({
      kind: 'CONCURRENCY_STAIRCASE',
      dimension: 'PRODUCTIVE_CONCURRENCY',
      scope: 'FLEET',
      hypothesis: 'h',
      successMetric: 's',
      stopCondition: 'c',
      resolvesUnknown: 'u',
      requestedBy: 'test',
    });
    expect(second.created).toBe(false);
    expect(second.experiment.id).toBe(first.experiment.id);
  });

  it('only one of two concurrent starts wins, and the loser creates no second canary', async () => {
    const { experiment } = await proposeExperiment({
      kind: 'CONCURRENCY_STAIRCASE',
      dimension: 'PRODUCTIVE_CONCURRENCY',
      scope: 'FLEET',
      hypothesis: 'h',
      successMetric: 's',
      stopCondition: 'c',
      resolvesUnknown: 'u',
      requestedBy: 'test',
    });
    expect(await authorizeExperiment({ id: experiment.id, rollbackPolicyVersion: 1, rollbackTarget: 2 })).toBe(true);
    // A second authorize from a replaying tick matches nothing.
    expect(await authorizeExperiment({ id: experiment.id, rollbackPolicyVersion: 1, rollbackTarget: 2 })).toBe(false);

    const started = await startCanary({
      id: experiment.id,
      appliedPolicyVersion: 2,
      canaryBinIds: ['bin_one'],
      canaryUntil: '2026-09-20T11:00:00.000Z',
      baselineReading: {},
    });
    expect(started).toBe(true);
    // And a restart replaying the same step is refused, so the recorded bin list
    // is not replaced by a second set.
    expect(
      await startCanary({
        id: experiment.id,
        appliedPolicyVersion: 3,
        canaryBinIds: ['bin_two'],
        canaryUntil: '2026-09-20T11:00:00.000Z',
        baselineReading: {},
      }),
    ).toBe(false);
  });

  it('the whole tick is idempotent: a second pass transitions nothing new', async () => {
    const first = await capacityKernelTick();
    const second = await capacityKernelTick();
    // Every claim was created on the first pass and merely re-verified on the
    // second — which is the property that makes the tick safe on two instances.
    expect(first.claims.every((one) => one.action === 'CREATED')).toBe(true);
    expect(second.claims.every((one) => one.action === 'REVERIFIED')).toBe(true);
    expect(second.live).toHaveLength(first.live.length);
  });
});

describe('12. stop conditions trigger rollback', () => {
  const baseline = {
    validatedCompletions: 3,
    completionRefusals: 0,
    takeovers: 0,
    sessionCount: 2,
    providerRefusals: 0,
  };

  it('a new provider refusal stops, and a pre-existing one does not', async () => {
    const observation = await observeCapacity();

    expect(
      checkStopConditions({
        observation: { ...observation, providerRefusals: [{ eventId: 'e', at: 'x', accountId: null, routineId: null, retryAfterMs: null, reason: null }] },
        baseline,
      }).condition,
    ).toBe('PROVIDER_REFUSAL');

    /*
     * The same refusal already present at the baseline is history, not a stop.
     *
     * The baseline is otherwise empty on purpose: with completions or sessions on
     * it, a different condition trips and the assertion would pass for the wrong
     * reason — which is a vacuous test, and worse than none because it reads as
     * coverage. The condition is asserted by name as well as the verdict.
     */
    const historic = checkStopConditions({
      observation: {
        ...observation,
        providerRefusals: [{ eventId: 'e', at: 'x', accountId: null, routineId: null, retryAfterMs: null, reason: null }],
      },
      baseline: { validatedCompletions: 0, completionRefusals: 0, takeovers: 0, sessionCount: 0, providerRefusals: 1 },
    });
    expect(historic.condition).not.toBe('PROVIDER_REFUSAL');
    expect(historic.stop).toBe(false);
  });

  it('a fall in accepted completions stops, and a baseline of zero cannot', async () => {
    const observation = await observeCapacity();
    expect(
      checkStopConditions({ observation, baseline }).condition,
    ).toBe('VALIDATION_DECLINE');
    /*
     * With nothing to fall from, an idle window is not a decline. `sessionCount`
     * goes to zero with it: leaving it at two would trip TELEMETRY_LOST instead,
     * which is a different (and also correct) stop — and asserting `stop` alone
     * would have passed for the wrong reason.
     */
    expect(
      checkStopConditions({
        observation,
        baseline: { ...baseline, validatedCompletions: 0, sessionCount: 0 },
      }).stop,
    ).toBe(false);
  });

  it('losing the telemetry stops, because a clean result from nothing observed is worse than a failure', async () => {
    const observation = await observeCapacity();
    const verdict = checkStopConditions({
      observation: { ...observation, sessions: [], validatedCompletions: [] },
      baseline: { ...baseline, validatedCompletions: 0 },
    });
    expect(verdict.condition).toBe('TELEMETRY_LOST');
  });

  it('a rolled-back experiment restores the recorded target rather than the current one', async () => {
    await setPolicy({ scope: 'FLEET', target: 2, actor: 'operator', reason: 'the standing target' });
    const before = await currentPolicy('FLEET', null);

    const { experiment } = await proposeExperiment({
      kind: 'CONCURRENCY_STAIRCASE',
      dimension: 'PRODUCTIVE_CONCURRENCY',
      scope: 'FLEET',
      hypothesis: 'h',
      successMetric: 's',
      stopCondition: 'c',
      resolvesUnknown: 'u',
      canaryValue: 3,
      requestedBy: 'test',
    });
    await authorizeExperiment({
      id: experiment.id,
      rollbackPolicyVersion: before!.version,
      rollbackTarget: before!.target,
    });
    // The experiment raises the ceiling.
    await setPolicy({ scope: 'FLEET', target: 2, exploreCeiling: 3, exploreUntil: '2099-01-01T00:00:00.000Z', actor: 'capacity-kernel', reason: 'exploring' });
    await startCanary({
      id: experiment.id,
      appliedPolicyVersion: (await currentPolicy('FLEET', null))!.version,
      canaryBinIds: [],
      canaryUntil: '1999-01-01T00:00:00.000Z',
      baselineReading: baseline,
    });

    // A tick with a refusal in the window must roll it back.
    const binId = await makeBin('stopper');
    await recordBinEvent({
      eventType: 'PROVIDER_ALLOWANCE',
      binId,
      accountId,
      routineId,
      evidenceClass: 'PROVIDER_ENFORCED',
      outcome: 'RATE_LIMITED',
      reason: '429 mid-canary',
    });

    const result = await capacityKernelTick();
    const rolled = result.transitions.find((one) => one.to === 'ROLLED_BACK');
    expect(rolled).toBeDefined();

    const after = await currentPolicy('FLEET', null);
    expect(after!.target).toBe(before!.target);
    // And the explore ceiling is cleared, so nothing is left carrying an expiry
    // that would quietly undo the rollback.
    expect(after!.exploreCeiling).toBeNull();
    // Every version stays. A rollback is a new row, never a delete.
    expect(after!.version).toBeGreaterThan(before!.version);
  });
});

describe('13. normal operation at the previous configuration stays healthy', () => {
  it('a kernel tick performs no fire, no enqueue, no claim and no registration', async () => {
    const binId = await makeBin('untouched');
    const beforeBins = (await listBins({ limit: 500 })).length;
    const beforeQueue = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM work_items', []);
    const beforeDispatch = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bin_dispatch', []);
    const beforeFires = await getDb().get<{ n: number }>(
      'SELECT COALESCE(SUM(total_fires), 0) AS n FROM fleet_routines',
      [],
    );

    await capacitySnapshot();

    // A *read* performs nothing at all.
    expect((await listBins({ limit: 500 })).length).toBe(beforeBins);
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM work_items', []))!.n).toBe(beforeQueue!.n);
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bin_dispatch', []))!.n).toBe(beforeDispatch!.n);
    expect(
      (await getDb().get<{ n: number }>('SELECT COALESCE(SUM(total_fires), 0) AS n FROM fleet_routines', []))!.n,
    ).toBe(beforeFires!.n);

    // And a full tick fires nothing either: the dispatcher is the only thing
    // that fires, and the kernel never calls it.
    await capacityKernelTick();
    expect(
      (await getDb().get<{ n: number }>('SELECT COALESCE(SUM(total_fires), 0) AS n FROM fleet_routines', []))!.n,
    ).toBe(beforeFires!.n);
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM work_items', []))!.n).toBe(beforeQueue!.n);
    expect(await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bins WHERE id = ?', [binId])).toBeTruthy();
  });

  it('the standing target is untouched while nothing is being tested', async () => {
    await setPolicy({ scope: 'FLEET', target: 6, actor: 'operator', reason: 'the standing target' });
    await capacityKernelTick();
    const after = await currentPolicy('FLEET', null);
    expect(after!.target).toBe(6);
    expect(after!.exploreCeiling).toBeNull();
  });
});

describe('14. no parallel scheduler, registry or control plane was introduced', () => {
  it('the kernel imports the existing fleet, bins and probe machinery and defines no queue of its own', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync('server/services/capacity/kernel.ts', 'utf8');

    // It reuses the canonical owners of each fact.
    expect(source).toMatch(/from '\.\.\/\.\.\/repos\/fleet\.ts'/);
    expect(source).toMatch(/from '\.\.\/\.\.\/repos\/bins\.ts'/);
    expect(source).toMatch(/from '\.\.\/fleet\/probe\.ts'/);

    /*
     * And it defines none of its own. Read from the source rather than from
     * behaviour, for `operatorConsoleRemoved`'s reason: what must not exist is
     * not something a behavioural test can see, because a second scheduler that
     * nothing calls yet passes every behavioural assertion.
     */
    expect(source).not.toMatch(/setInterval|setTimeout/);
    expect(source).not.toMatch(/CREATE TABLE/);
    expect(source).not.toMatch(/fireRoutine|claimRoutineFireSlot/);
  });

  it('the capacity tables hold pointers and conclusions, never a copy of the ledger', async () => {
    const fs = await import('node:fs');
    const migration = fs.readFileSync('server/db/migrations/074_capacity_kernel.sql', 'utf8');
    // Exactly two tables, and neither is a second event store.
    const tables = [...migration.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
    expect(tables).toEqual(['capacity_claims', 'capacity_experiments']);
    expect(migration).not.toMatch(/CREATE TABLE capacity_events/);
  });

  it('every dimension has a derivation, so adding one cannot be forgotten', async () => {
    const envelope = deriveEnvelope(await observeCapacity());
    for (const dimension of CAPACITY_DIMENSIONS) {
      expect(envelope.readings[dimension]).toBeDefined();
      expect(envelope.readings[dimension].dimension).toBe(dimension);
      expect(envelope.readings[dimension].explanation.length).toBeGreaterThan(20);
    }
  });
});

describe('15. the report separates what Brain does from what a person must do', () => {
  it('an internal configuration task never appears under the user actions', async () => {
    const report = capacityReportFrom(await capacitySnapshot());
    for (const action of report.youNeedToDo) {
      // Everything Brain can do itself is a policy row or a bin, and neither is
      // ever asked of a person.
      expect(action).not.toMatch(/raise the (fleet )?target/i);
      expect(action).not.toMatch(/set the explore ceiling/i);
      expect(action).not.toMatch(/create a canary bin/i);
    }
    expect(Array.isArray(report.brainIsDoingNow)).toBe(true);
  });

  it('a definition staircase is a PERSON action and names the exact command', async () => {
    // A fleet with one eligible surface and a local target is starved, which is
    // the only condition under which another definition is worth asking for.
    expect(EXPERIMENT_AUTHORITY.DEFINITION_STAIRCASE).toBe('PERSON');

    const observation = await observeCapacity();
    const starved = {
      ...observation,
      eligibleRoutineIds: [],
      stages: { ...observation.stages, readyNotFired: 3 },
    };
    const proposal = selectExperiment({
      observation: starved,
      envelope: deriveEnvelope(starved),
      diagnosis: {
        bottleneck: 'NO_EXECUTION_SURFACE',
        evidenceFor: '',
        evidenceAgainst: '',
        discriminator: '',
        actionable: 'PERSON',
      },
      claimedDimensions: [],
      canaryRunning: false,
    });

    expect(proposal?.kind).toBe('DEFINITION_STAIRCASE');
    expect(proposal?.authority).toBe('PERSON');
    expect(proposal?.userAction).toMatch(/fleet register-routine/);
    expect(proposal?.userAction).toMatch(/Brain cannot create a Routine/);
  });

  it('stops asking for an action the same tick its answering transition fires', async () => {
    /*
     * A `NEEDS_USER` experiment whose condition has since been met is settled by
     * the tick that notices — and the tick used to report its action anyway,
     * because the live list was read *before* the transitions ran. Asking
     * somebody to do a thing that is already done is §29's stale status in the
     * direction that wastes their time.
     *
     * The experiment is parked against a baseline of one registered Routine, and
     * the fixture already has one, so its condition is met the moment it is
     * created — which is exactly the collision this pins.
     */
    const { experiment } = await proposeExperiment({
      kind: 'DEFINITION_STAIRCASE',
      dimension: 'DEFINITION_CAPACITY',
      scope: 'FLEET',
      hypothesis: 'one more definition will fit',
      successMetric: 'it appears in the provider listing',
      stopCondition: 'the provider refuses the creation',
      resolvesUnknown: 'whether definition capacity is higher than what is registered',
      canaryValue: 1,
      requestedBy: 'test',
    });
    expect(
      await parkExperimentForUser({ id: experiment.id, userAction: 'Create one additional Routine.' }),
    ).toBe(true);

    const result = await capacityKernelTick();

    // It settled, and it is not still being asked for.
    expect(result.transitions.some((one) => one.from === 'NEEDS_USER' && one.to === 'ADOPTED')).toBe(true);
    expect(result.userActions).not.toContain('Create one additional Routine.');
    // And the claim it existed to establish was recorded as a floor.
    const claim = await liveClaim('DEFINITION_CAPACITY', 'FLEET', null);
    expect(claim?.bound).toBe('AT_LEAST');
  });

  it('an empty user-action list is a real answer rather than a missing section', async () => {
    const report = capacityReportFrom(await capacitySnapshot());
    expect(report.youNeedToDo).toEqual([]);
    // And the bottleneck always carries its own counter-evidence, so no
    // diagnosis is printed as a certainty.
    expect(report.mainBottleneck.evidenceAgainst.length).toBeGreaterThan(20);
  });
});

/* ========================================================================== */
/* The arithmetic the headline numbers rest on                                */
/* ========================================================================== */

describe('the overlap sweep', () => {
  it('does not count a handover as two sessions running at once', () => {
    const abutting = [
      interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:05:00.000Z' }),
      interval({ sessionRef: 'b', startedAt: '2026-09-20T10:05:00.000Z', endedAt: '2026-09-20T10:10:00.000Z' }),
    ];
    expect(maxOverlap(abutting).max).toBe(1);
  });

  it('drops an unfinished session rather than extending it to now', () => {
    const reading = maxOverlap([
      interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:05:00.000Z' }),
      interval({ sessionRef: 'b', startedAt: '2026-09-20T10:01:00.000Z' }),
    ]);
    expect(reading.max).toBe(1);
    expect(reading.droppedUnfinished).toBe(1);
  });

  it('finds the true peak and says when it happened and who was in it', () => {
    const reading = maxOverlap([
      interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:10:00.000Z' }),
      interval({ sessionRef: 'b', startedAt: '2026-09-20T10:02:00.000Z', endedAt: '2026-09-20T10:08:00.000Z' }),
      interval({ sessionRef: 'c', startedAt: '2026-09-20T10:04:00.000Z', endedAt: '2026-09-20T10:06:00.000Z' }),
    ]);
    expect(reading.max).toBe(3);
    expect(reading.at).toBe('2026-09-20T10:04:00.000Z');
    expect(reading.sessionRefs.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('percentiles and rates', () => {
  it('uses nearest rank, so a small sample never invents a value between two', () => {
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
    expect(percentile([10, 20, 30], 0.95)).toBe(30);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('a start rate counts accepted fires only', () => {
    const rate = startRatePerHour(
      [
        { binId: 'a', accountId: null, routineId: null, at: 'x', accepted: true },
        { binId: 'b', accountId: null, routineId: null, at: 'y', accepted: false },
      ],
      2,
    );
    expect(rate.accepted).toBe(1);
    expect(rate.perHour).toBe(0.5);
  });
});

describe('the claim record', () => {
  it('re-verifying keeps the first-observed date and moves only the last-verified one', async () => {
    const first = await recordClaim({
      dimension: 'ACTIVE_CONCURRENCY',
      scope: 'FLEET',
      value: 2,
      bound: 'AT_LEAST',
      evidenceClass: 'MEASURED',
      explanation: 'two overlapped',
      sampleCount: 2,
      confidence: 'LOW',
    });
    expect(first.action).toBe('CREATED');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await recordClaim({
      dimension: 'ACTIVE_CONCURRENCY',
      scope: 'FLEET',
      value: 2,
      bound: 'AT_LEAST',
      evidenceClass: 'MEASURED',
      explanation: 'two overlapped, again',
      sampleCount: 4,
      confidence: 'MEDIUM',
    });
    expect(again.action).toBe('REVERIFIED');
    expect(again.claim.firstObservedAt).toBe(first.claim.firstObservedAt);
    expect(again.claim.lastVerifiedAt >= first.claim.lastVerifiedAt).toBe(true);
    expect(again.claim.sampleCount).toBe(4);
  });

  it('the same number established a different way is a new claim, not a re-verification', async () => {
    await recordClaim({
      dimension: 'ACTIVE_CONCURRENCY',
      scope: 'FLEET',
      value: 2,
      bound: 'AT_LEAST',
      evidenceClass: 'MEASURED',
      explanation: 'measured',
      sampleCount: 2,
      confidence: 'LOW',
    });
    const inferred = await recordClaim({
      dimension: 'ACTIVE_CONCURRENCY',
      scope: 'FLEET',
      value: 2,
      bound: 'AT_LEAST',
      evidenceClass: 'INFERRED',
      explanation: 'inferred',
      sampleCount: 2,
      confidence: 'LOW',
    });
    expect(inferred.action).toBe('SUPERSEDED');
  });

  it('a superseded claim keeps its row, its value and the reason it was replaced', async () => {
    await recordClaim({
      dimension: 'ACTIVE_CONCURRENCY',
      scope: 'FLEET',
      value: 6,
      bound: 'AT_LEAST',
      evidenceClass: 'MEASURED',
      explanation: 'six overlapped',
      sampleCount: 6,
      confidence: 'MEDIUM',
    });
    await recordClaim({
      dimension: 'ACTIVE_CONCURRENCY',
      scope: 'FLEET',
      value: 4,
      bound: 'AT_MOST',
      evidenceClass: 'PROVIDER_ENFORCED',
      explanation: 'refused at four',
      sampleCount: 2,
      confidence: 'MEDIUM',
    });

    const history = await claimHistory('ACTIVE_CONCURRENCY', 'FLEET', null);
    expect(history).toHaveLength(2);
    const old = history.find((one) => one.value === 6)!;
    expect(old.supersededAt).not.toBeNull();
    expect(old.supersededReason).toMatch(/PROVIDER_ENFORCED AT_MOST 4/);
    // Exactly one live answer to the question, always.
    expect((await liveClaim('ACTIVE_CONCURRENCY', 'FLEET', null))!.value).toBe(4);
  });
});

describe('an inference never lowers the recommendation below a measurement', () => {
  /*
   * Both of these were found by *running* the kernel rather than by reading it,
   * and they are pinned here because the direction of the error is the expensive
   * one: a spurious knee talks the fleet down from a level it has demonstrably
   * run, and nobody ever measures that throughput back.
   */
  it('one completion at each of two levels is not a knee', async () => {
    const observation = await observeCapacity();
    const thin = {
      ...observation,
      sessions: [
        interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:08:00.000Z', productive: true }),
        interval({ sessionRef: 'b', startedAt: '2026-09-20T10:02:00.000Z', endedAt: '2026-09-20T10:06:00.000Z', productive: true }),
      ],
      validatedCompletions: [
        { binId: 'one', at: '2026-09-20T10:06:00.000Z', eventId: 'bev_1' },
        { binId: 'two', at: '2026-09-20T10:08:00.000Z', eventId: 'bev_2' },
      ],
    };
    const envelope = deriveEnvelope(thin);
    // Two levels, one completion each. That is two single events, not a trend.
    expect(envelope.readings.INFERRED_SATURATION_KNEE.evidenceClass).toBe('UNKNOWN');
    expect(envelope.readings.INFERRED_SATURATION_KNEE.explanation).toMatch(/single events/);
    // And the recommendation follows the demonstrated bound rather than a knee
    // that does not exist.
    expect(envelope.readings.PRODUCTIVE_CONCURRENCY.value).toBe(2);
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.value).toBe(2);
  });

  it('a knee below the demonstrated bound loses, and the disagreement is recorded', async () => {
    const observation = await observeCapacity();
    /*
     * Three sessions overlap productively, and enough completions land at level 1
     * and level 3 for both to clear the sample floor — with level 3 no better than
     * level 1, so the knee genuinely computes to 1 while 3 has demonstrably run.
     */
    const sessions = [
      interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:30:00.000Z', productive: true }),
      interval({ sessionRef: 'b', startedAt: '2026-09-20T10:05:00.000Z', endedAt: '2026-09-20T10:20:00.000Z', productive: true }),
      interval({ sessionRef: 'c', startedAt: '2026-09-20T10:06:00.000Z', endedAt: '2026-09-20T10:19:00.000Z', productive: true }),
    ];
    const completions = [
      // Three at level 3 (inside the triple overlap).
      { binId: 'l3a', at: '2026-09-20T10:07:00.000Z', eventId: 'e1' },
      { binId: 'l3b', at: '2026-09-20T10:08:00.000Z', eventId: 'e2' },
      { binId: 'l3c', at: '2026-09-20T10:09:00.000Z', eventId: 'e3' },
      // And four at level 1 (after b and c have gone).
      { binId: 'l1a', at: '2026-09-20T10:22:00.000Z', eventId: 'e4' },
      { binId: 'l1b', at: '2026-09-20T10:23:00.000Z', eventId: 'e5' },
      { binId: 'l1c', at: '2026-09-20T10:24:00.000Z', eventId: 'e6' },
      { binId: 'l1d', at: '2026-09-20T10:25:00.000Z', eventId: 'e7' },
    ];
    const envelope = deriveEnvelope({ ...observation, sessions, validatedCompletions: completions });

    expect(envelope.readings.PRODUCTIVE_CONCURRENCY.value).toBe(3);
    expect(envelope.readings.INFERRED_SATURATION_KNEE.value).toBe(1);
    // The measurement wins.
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.value).toBe(3);
    // And the inference that argued for less is kept where a reader can see it,
    // rather than dropped once it lost.
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.contradictions).toHaveLength(1);
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.contradictions[0]).toMatch(/below the demonstrated 3/);
  });

  it('a provider failure point does bound it from above, because that is a measurement too', async () => {
    const observation = await observeCapacity();
    const sessions = [
      interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:30:00.000Z', productive: true }),
      interval({ sessionRef: 'b', startedAt: '2026-09-20T10:05:00.000Z', endedAt: '2026-09-20T10:20:00.000Z', productive: true }),
      interval({ sessionRef: 'c', startedAt: '2026-09-20T10:06:00.000Z', endedAt: '2026-09-20T10:19:00.000Z', productive: true }),
    ];
    const envelope = deriveEnvelope({
      ...observation,
      sessions,
      validatedCompletions: [{ binId: 'x', at: '2026-09-20T10:07:00.000Z', eventId: 'e' }],
      providerRefusals: [
        { eventId: 'r1', at: '2026-09-20T10:07:00.000Z', accountId: null, routineId: null, retryAfterMs: null, reason: '429' },
      ],
    });
    /*
     * Refused with three already open, so the level that *failed* is four and the
     * highest admitted is three. The recommendation is `failure - 1`, which lands
     * exactly on the demonstrated three — the two measurements agree, which is
     * what they should do, and there is no contradiction to record.
     */
    expect(envelope.readings.OBSERVED_FAILURE_POINT.value).toBe(4);
    expect(envelope.readings.PROVIDER_ENFORCED_CEILING.value).toBeNull();
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.value).toBe(3);
    expect(envelope.readings.RECOMMENDED_OPERATING_TARGET.contradictions).toHaveLength(0);
  });
});

describe('the bottleneck diagnosis', () => {
  it('never reports a certainty: every verdict carries its counter-evidence and a discriminator', async () => {
    const observation = await observeCapacity();
    for (const shape of [
      observation,
      { ...observation, stages: { ...observation.stages, readyNotFired: 5 } },
      { ...observation, stages: { ...observation.stages, firedNotArrived: 5 } },
      { ...observation, stages: { ...observation.stages, leasedLive: 2 } },
      {
        ...observation,
        providerRefusals: [{ eventId: 'e', at: 'x', accountId: null, routineId: null, retryAfterMs: null, reason: null }],
      },
    ]) {
      const verdict = diagnose(shape);
      expect(verdict.evidenceFor.length).toBeGreaterThan(10);
      expect(verdict.evidenceAgainst.length).toBeGreaterThan(10);
      expect(verdict.discriminator.length).toBeGreaterThan(10);
    }
  });

  it('a provider refusal outranks a deep queue', async () => {
    const observation = await observeCapacity();
    const verdict = diagnose({
      ...observation,
      stages: { ...observation.stages, readyNotFired: 50 },
      providerRefusals: [{ eventId: 'e', at: 'x', accountId: null, routineId: null, retryAfterMs: null, reason: '429' }],
    });
    expect(verdict.bottleneck).toBe('PROVIDER_BOUNDARY');
  });

  it('nothing waiting is not a capacity problem', async () => {
    const verdict = diagnose(await observeCapacity());
    expect(verdict.bottleneck).toBe('NO_ELIGIBLE_WORK');
  });
});

describe('judging a canary', () => {
  it('failing to reach a level is inconclusive rather than a refutation', async () => {
    const observation = await observeCapacity();
    const judged = judgeCanary({ observation, targetLevel: 3, baseline: { validatedCompletions: 1 } });
    expect(judged.verdict).toBe('INCONCLUSIVE');
    expect(judged.reason).toMatch(/not exercised rather than found to be unavailable/);
  });

  it('a refusal during the window refutes the level and says it brackets the boundary', async () => {
    const observation = await observeCapacity();
    const judged = judgeCanary({
      observation: {
        ...observation,
        providerRefusals: [{ eventId: 'e', at: 'x', accountId: null, routineId: null, retryAfterMs: null, reason: '429' }],
      },
      targetLevel: 3,
      baseline: { validatedCompletions: 1 },
    });
    expect(judged.verdict).toBe('REFUTED');
    expect(judged.reason).toMatch(/brackets the boundary/);
  });
});

describe('choosing the next experiment', () => {
  it('prefers the free observation while the headline measurement is unknown', async () => {
    const observation = await observeCapacity();
    const proposal = selectExperiment({
      observation,
      envelope: deriveEnvelope(observation),
      diagnosis: diagnose(observation),
      claimedDimensions: [],
      canaryRunning: false,
    });
    expect(proposal?.kind).toBe('PASSIVE_BASELINE');
    expect(proposal?.factor).toBeNull();
  });

  it('never proposes a staircase while the provider is refusing', async () => {
    const observation = await observeCapacity();
    const withRefusal = {
      ...observation,
      sessions: [
        interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:05:00.000Z', productive: true }),
      ],
      providerRefusals: [{ eventId: 'e', at: 'x', accountId: null, routineId: null, retryAfterMs: null, reason: '429' }],
    };
    const proposal = selectExperiment({
      observation: withRefusal,
      envelope: deriveEnvelope(withRefusal),
      diagnosis: diagnose(withRefusal),
      claimedDimensions: [],
      canaryRunning: false,
    });
    expect(proposal?.kind).not.toBe('CONCURRENCY_STAIRCASE');
  });

  it('never proposes a second capacity-changing experiment while one is applied', async () => {
    const observation = await observeCapacity();
    const healthy = {
      ...observation,
      sessions: [
        interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:05:00.000Z', productive: true }),
      ],
      stages: { ...observation.stages, leasedLive: 1 },
      validatedCompletions: [{ binId: 'bin', at: '2026-09-20T10:03:00.000Z', eventId: 'bev' }],
    };
    const proposal = selectExperiment({
      observation: healthy,
      envelope: deriveEnvelope(healthy),
      diagnosis: diagnose(healthy),
      claimedDimensions: [],
      canaryRunning: true,
    });
    expect(proposal?.kind).not.toBe('CONCURRENCY_STAIRCASE');
  });

  it('steps exactly one above what has been demonstrated, never further', async () => {
    const observation = await observeCapacity();
    const healthy = {
      ...observation,
      sessions: [
        interval({ sessionRef: 'a', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:06:00.000Z', productive: true }),
        interval({ sessionRef: 'b', startedAt: '2026-09-20T10:01:00.000Z', endedAt: '2026-09-20T10:05:00.000Z', productive: true }),
      ],
      stages: { ...observation.stages, leasedLive: 1 },
      validatedCompletions: [{ binId: 'bin', at: '2026-09-20T10:03:00.000Z', eventId: 'bev' }],
    };
    // The fleet has a surface, so the diagnosis is NONE rather than
    // NO_EXECUTION_SURFACE and a step is the right next question.
    expect(healthy.eligibleRoutineIds.length).toBeGreaterThan(0);
    const proposal = selectExperiment({
      observation: healthy,
      envelope: deriveEnvelope(healthy),
      diagnosis: diagnose(healthy),
      claimedDimensions: [],
      canaryRunning: false,
    });
    expect(proposal?.kind).toBe('CONCURRENCY_STAIRCASE');
    expect(proposal?.canaryValue).toBe(3);
  });
});
