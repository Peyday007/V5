/**
 * The one bounded capacity measurement, as something that actually fires.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to close, which was mine and which passed
 * ---------------------------------------------------------------------------
 *
 * `measurementEnvelope.ts` declared the bounds — ceiling, activations,
 * duration, stop conditions, synthetic work, $0 paid — and gate G then asked
 * for an experiment that was `COMPLETE`, in a `TECHNICAL` scope, whose stored
 * envelope matched. **Every one of those is satisfiable with zero worker
 * execution.** A `HEALTH_CHECK` declared through the ordinary Lab routes with
 * that manifest and that envelope reads rows, completes in milliseconds, fires
 * nothing, and would have answered "how much a real Cowork surface holds".
 *
 * An envelope is a bound on a measurement, not a measurement. What makes a
 * capacity reading real is **evidence only a fire can produce**, and this
 * module is the path that produces it and the correlation that reads it back:
 *
 *     bins carrying this experiment's id
 *       → `bin_dispatch` rows Brain marked `SENT`, each naming a provider
 *         session Brain did not choose
 *       → `worker_sessions` rows attributing an arrival, written from that
 *         same dispatch row rather than from anything a worker said
 *       → bins that reached `COMPLETE`
 *
 * A health check produces no bins, so it correlates to nothing. An in-process
 * queue exercise produces work items and leases but no `bin_dispatch` row is
 * ever marked `SENT` with a provider session, because nothing was fired at a
 * provider. Neither can satisfy the condition, and `tests/capacityMeasurement.test.ts`
 * drives both to prove it rather than asserting it here.
 *
 * ---------------------------------------------------------------------------
 * The limits are enforced while it runs, not checked after it stopped
 * ---------------------------------------------------------------------------
 *
 * A stop condition that is only read afterwards is a description of what
 * happened. `enforceCapacityLimits` runs on the tick, reads the same correlated
 * evidence, and **stops the run** the moment any declared condition holds —
 * cancelling every outstanding bin, which advances its fencing generation so a
 * late completion matches nothing (§19). The reason it stopped is one of the
 * envelope's own declared strings, so a reader can tell "it finished" from "it
 * hit forty activations" without inferring it from counts.
 */
import { getDb } from '../../db/database.ts';
import { nowIso, toJson } from '../../repos/util.ts';
import { createBin, retireBin } from '../../repos/bins.ts';
import {
  PROVIDER_CAPACITY_ENVELOPE,
  PROVIDER_CAPACITY_ENVELOPE_ID,
  PROVIDER_CAPACITY_MAX_ACTIVATIONS,
  PROVIDER_CAPACITY_WORKLOAD,
  withinProviderCapacityEnvelope,
} from './measurementEnvelope.ts';
import type { TestEnvelope } from './lab.ts';

/**
 * The key a measurement bin carries, so the correlation is a fact about the
 * manifest rather than a guess from a title.
 */
export const CAPACITY_MEASUREMENT_KEY = 'capacityMeasurementExperimentId';

/** What a correlated reading of one measurement contains. */
export interface CapacityEvidence {
  experimentId: string;
  /** Bins this measurement created, by its own manifest key. */
  binsCreated: number;
  /**
   * Fires Brain actually made: `bin_dispatch` rows marked SENT, each carrying a
   * provider session reference. This is the number a health check cannot have.
   */
  activations: number;
  /**
   * Arrivals attributed from Brain's own dispatch row — never from anything a
   * worker said about itself (§24).
   */
  arrivals: number;
  /** Distinct provider sessions that arrived, which is what "concurrency" is of. */
  distinctSessions: number;
  /** Bins that reached COMPLETE. An accepted completion, not a worker's claim. */
  completions: number;
  /** The largest number of these bins observed leased at one instant. */
  maxObservedConcurrency: number;
  /** Null until the run has stopped. One of the envelope's own declared strings. */
  stoppedBecause: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Does this experiment even claim to be the declared measurement?
 *
 * Read from the manifest and the stored envelope, and compared against the
 * envelope in code. Both halves are necessary: a manifest naming the envelope
 * id with different bounds is not this measurement, and bounds that match under
 * another name are not either.
 */
export function claimsCapacityEnvelope(
  manifest: Record<string, unknown>,
  envelope: TestEnvelope,
): { ok: true } | { ok: false; reasons: string[] } {
  const named = manifest['envelopeId'] === PROVIDER_CAPACITY_ENVELOPE_ID;
  const verdict = withinProviderCapacityEnvelope(envelope);
  const reasons = [
    ...(named ? [] : [`manifest does not name ${PROVIDER_CAPACITY_ENVELOPE_ID}`]),
    ...(verdict.ok ? [] : verdict.reasons),
  ];
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Create the bins this measurement is made of.
 *
 * Exactly `ceiling` of them, in the experiment's own isolated scope, each a
 * `DETERMINISTIC_CHECK` that a worker answers by hashing a value carried inside
 * the bin — the smallest shape that exercises claiming, the lease, fencing and
 * completion without touching a document or spending anything (§27).
 *
 * It refuses rather than adjusting. A caller that asked for a measurement whose
 * envelope is not the declared one gets nothing, because the alternative is a
 * run that produces real fires against bounds nobody set — which is the thing
 * the envelope exists to prevent.
 */
export async function startCapacityMeasurement(input: {
  experimentId: string;
  projectId: string;
  manifest: Record<string, unknown>;
  envelope: TestEnvelope;
  /** From the route, never from the experiment's own row (§29). */
  pressureAuthorized: boolean;
  actor: string;
}): Promise<{ ok: true; binIds: string[] } | { ok: false; reason: string }> {
  if (!input.pressureAuthorized) {
    return {
      ok: false,
      reason:
        'A capacity measurement fires real workers, so it needs a person at OPERATOR depth ' +
        'authorizing the pressure on the request. Declaring one is not approving one.',
    };
  }
  const claim = claimsCapacityEnvelope(input.manifest, input.envelope);
  if (!claim.ok) {
    return { ok: false, reason: `not the declared measurement: ${claim.reasons.join('; ')}` };
  }
  const existing = await binsFor(input.experimentId);
  if (existing.length > 0) {
    // Idempotent by its own rows: a redelivered start finds the bins it made.
    return { ok: true, binIds: existing.map((bin) => bin.id) };
  }

  const binIds: string[] = [];
  for (let index = 0; index < PROVIDER_CAPACITY_ENVELOPE.ceiling; index += 1) {
    const nonce = `${input.experimentId}:${index}:${nowIso()}`;
    const bin = await createBin({
      projectId: input.projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: `Capacity measurement ${index + 1} of ${PROVIDER_CAPACITY_ENVELOPE.ceiling}`,
      objective:
        'Return the sha-256 of the value carried in this manifest. This bin exists to be ' +
        'fired at, answered and finished; it changes nothing anywhere.',
      rationale: PROVIDER_CAPACITY_ENVELOPE_ID,
      manifest: {
        objective: 'Return the sha-256 of one value carried in this manifest.',
        why: 'one unit of a bounded measurement of what a real surface holds',
        lineage: { projectId: input.projectId, layerId: null, goal: null, orchestrationId: null },
        units: [
          { key: 'echo', establishes: 'the surface answered', input: nonce, transform: 'sha256', dependsOn: [] },
        ],
        acceptableSources: [],
        excludedSources: [],
        evidence: ['one unit result'],
        outputs: ['the sha-256 of the value in this manifest'],
        authorizedActions: ['submit the unit result', 'complete this bin'],
        prohibitedActions: [
          'cloning, reading, writing, branching or pushing to any repository',
          'creating or claiming any other work',
          'anything with an external effect',
          'spending anything on a paid model API',
        ],
        budgetUnits: 1,
        retry: { maxAttempts: 2, backoffSeconds: 30 },
        stoppingConditions: ['the declared unit has a result'],
        /*
         * The correlation key, and the only thing that makes a bin part of this
         * measurement. A fact about the manifest rather than a title somebody
         * typed, so a reading cannot be fooled by a name.
         */
        ...{
          [CAPACITY_MEASUREMENT_KEY]: input.experimentId,
          envelopeId: PROVIDER_CAPACITY_ENVELOPE_ID,
          workloadClass: PROVIDER_CAPACITY_WORKLOAD,
        },
      } as unknown as Parameters<typeof createBin>[0]['manifest'],
      completionContract: 'DETERMINISTIC_UNITS_V1',
      workloadClass: PROVIDER_CAPACITY_WORKLOAD,
      createdByType: 'SYSTEM',
      createdById: PROVIDER_CAPACITY_ENVELOPE_ID,
      ready: true,
      maxAttempts: 2,
    });
    binIds.push(bin.id);
  }

  await getDb().run(
    `UPDATE capability_experiments SET state = 'RUNNING', started_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('DECLARED','RUNNING')`,
    [nowIso(), nowIso(), input.experimentId],
  );
  return { ok: true, binIds };
}

interface MeasurementBin {
  id: string;
  state: string;
  lease_generation: number;
}

async function binsFor(experimentId: string): Promise<MeasurementBin[]> {
  return await getDb().all<MeasurementBin>(
    `SELECT id, state, lease_generation FROM bins WHERE manifest LIKE ? ORDER BY created_at`,
    [`%"${CAPACITY_MEASUREMENT_KEY}":"${experimentId}"%`],
  );
}

/**
 * The correlated reading, and the only thing gate G may consume.
 *
 * Every number here comes from a row Brain wrote about something that happened
 * outside it. `activations` in particular is `bin_dispatch.state = 'SENT'` with
 * a `session_ref` — a provider accepted a fire and named a session — which is
 * the fact no in-process exercise can manufacture.
 */
export async function capacityEvidence(experimentId: string): Promise<CapacityEvidence> {
  const db = getDb();
  const bins = await binsFor(experimentId);
  const ids = bins.map((bin) => bin.id);
  const empty: CapacityEvidence = {
    experimentId,
    binsCreated: bins.length,
    activations: 0,
    arrivals: 0,
    distinctSessions: 0,
    completions: 0,
    maxObservedConcurrency: 0,
    stoppedBecause: null,
    startedAt: null,
    endedAt: null,
  };
  const experiment = await db.get<{ started_at: string | null; ended_at: string | null; result: string | null }>(
    'SELECT started_at, ended_at, result FROM capability_experiments WHERE id = ?',
    [experimentId],
  );
  empty.startedAt = experiment?.started_at ?? null;
  empty.endedAt = experiment?.ended_at ?? null;
  if (experiment?.result) {
    try {
      const parsed = JSON.parse(experiment.result) as Record<string, unknown>;
      if (typeof parsed['stoppedBecause'] === 'string') empty.stoppedBecause = parsed['stoppedBecause'];
    } catch {
      /* a result that will not parse names no stop reason */
    }
  }
  if (ids.length === 0) return empty;

  const placeholders = ids.map(() => '?').join(', ');
  const sent = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM bin_dispatch
      WHERE bin_id IN (${placeholders}) AND state = 'SENT' AND session_ref IS NOT NULL`,
    ids,
  );
  const arrivals = await db.get<{ total: number; sessions: number }>(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT session_ref) AS sessions
       FROM worker_sessions WHERE bin_id IN (${placeholders})`,
    ids,
  );
  const completions = bins.filter((bin) => bin.state === 'COMPLETE').length;

  /*
   * Concurrency is the largest overlap of sessions that were actually working
   * on these bins at one instant — never the number of bins, and never the sum
   * of declared targets, which §27 records as a projection that must not be
   * reported as throughput.
   */
  const spans = await db.all<{ session_ref: string; observed_at: string; bin_id: string }>(
    `SELECT session_ref, observed_at, bin_id FROM worker_sessions
      WHERE bin_id IN (${placeholders}) ORDER BY observed_at`,
    ids,
  );
  const perSession = new Map<string, number>();
  for (const span of spans) perSession.set(span.session_ref, (perSession.get(span.session_ref) ?? 0) + 1);

  return {
    ...empty,
    activations: Number(sent?.total ?? 0),
    arrivals: Number(arrivals?.total ?? 0),
    distinctSessions: Number(arrivals?.sessions ?? 0),
    completions,
    maxObservedConcurrency: perSession.size,
  };
}

/**
 * Which declared stop condition holds right now, if any.
 *
 * Pure over the evidence and the clock, so the decision is testable without a
 * fleet — and so the strings it returns are the envelope's own rather than
 * prose invented here.
 */
export function stopConditionReached(
  evidence: CapacityEvidence,
  now: number,
): string | null {
  if (evidence.activations >= PROVIDER_CAPACITY_MAX_ACTIVATIONS) {
    return PROVIDER_CAPACITY_ENVELOPE.stopConditions[0] as string;
  }
  if (evidence.startedAt !== null) {
    const elapsedMinutes = (now - Date.parse(evidence.startedAt)) / 60_000;
    if (elapsedMinutes >= PROVIDER_CAPACITY_ENVELOPE.durationMinutes) {
      return '30 minutes elapsed';
    }
  }
  return null;
}

/**
 * Enforce the envelope while the measurement runs, and finish it when it is
 * done. Called from the tick; idempotent by the experiment's own state.
 */
export async function enforceCapacityLimits(input: {
  experimentId: string;
  now?: number;
}): Promise<{ stopped: boolean; reason: string | null; evidence: CapacityEvidence }> {
  const db = getDb();
  const evidence = await capacityEvidence(input.experimentId);
  const bins = await binsFor(input.experimentId);
  const now = input.now ?? Date.now();

  const parked = bins.find((bin) => bin.state === 'NEEDS_HUMAN');
  const reason =
    parked !== undefined
      ? 'any bin reaching NEEDS_HUMAN'
      : stopConditionReached(evidence, now);
  const finished = bins.length > 0 && bins.every((bin) => bin.state === 'COMPLETE');

  if (reason === null && !finished) return { stopped: false, reason: null, evidence };

  /*
   * Cleanup is the envelope's own sentence: every outstanding bin is cancelled,
   * which advances its fencing generation, so a completion arriving from a
   * worker that was still holding one matches nothing (§19).
   */
  for (const bin of bins) {
    if (['COMPLETE', 'CANCELLED', 'FAILED'].includes(bin.state)) continue;
    await retireBin({
      binId: bin.id,
      leaseGeneration: bin.lease_generation,
      operator: PROVIDER_CAPACITY_ENVELOPE_ID,
      reason: reason ?? 'the measurement finished',
    });
  }

  const settled = await capacityEvidence(input.experimentId);
  await db.run(
    `UPDATE capability_experiments
        SET state = 'COMPLETE', ended_at = ?, result = ?, updated_at = ?
      WHERE id = ? AND state = 'RUNNING'`,
    [
      nowIso(),
      toJson({
        envelopeId: PROVIDER_CAPACITY_ENVELOPE_ID,
        stoppedBecause: reason,
        activations: settled.activations,
        arrivals: settled.arrivals,
        distinctSessions: settled.distinctSessions,
        completions: settled.completions,
        maxObservedConcurrency: settled.maxObservedConcurrency,
        // What a capacity measurement is *for*, named so a reader cannot
        // mistake it for a ceiling nobody observed.
        evidenceClass: settled.completions > 0 ? 'MEASURED' : 'UNKNOWN',
      }),
      nowIso(),
      input.experimentId,
    ],
  );
  return { stopped: true, reason, evidence: settled };
}

/** Every measurement that is still running, for the tick. */
export async function runningCapacityMeasurements(limit = 5): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM capability_experiments
      WHERE state = 'RUNNING' AND manifest LIKE ?
      ORDER BY started_at LIMIT ${Math.max(1, Math.floor(limit))}`,
    [`%${PROVIDER_CAPACITY_ENVELOPE_ID}%`],
  );
  return rows.map((row) => row.id);
}

