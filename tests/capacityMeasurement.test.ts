/**
 * The one bounded measurement that actually fires, and the two things that
 * look like it and are not.
 *
 * Gate G asks what a real provider surface holds. The first version of it asked
 * for a `FLEET_PROVIDER` experiment that was `COMPLETE`, in a `TECHNICAL`
 * scope, whose stored envelope matched the one in code — and **every one of
 * those is satisfiable with zero worker execution**. A `HEALTH_CHECK` declared
 * with that manifest reads rows, completes in milliseconds and fires nothing.
 * A pressure mode drives Brain's own queue in this process and fires nothing
 * either. Both would have answered a question about a provider.
 *
 * So the negative cases are the point of this file and they come first. What
 * makes a capacity reading real is evidence only a fire can produce, and the
 * assertions below are about the correlation rather than about the prose: bins
 * carrying the experiment's own key, `bin_dispatch` rows Brain marked `SENT`
 * naming a provider session, `worker_sessions` arrivals attributed from that
 * same dispatch row, and bins that reached `COMPLETE`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import {
  assignNextBin,
  getBin,
  markDispatchSent,
  ensureDispatchIntent,
  claimDispatchIntent,
} from '../server/repos/bins.ts';
import { recordWorkerSession } from '../server/repos/fleet.ts';
import { requestCompletion, submitUnit } from '../server/services/bins/service.ts';
import { UNIT_TRANSFORMS } from '../server/services/bins/contracts.ts';
import { declareExperiment, runExperiment, isBoundedCapacityMeasurement } from '../server/services/fleet/lab.ts';
import {
  CAPACITY_MEASUREMENT_KEY,
  capacityEvidence,
  claimsCapacityEnvelope,
  enforceCapacityLimits,
  runningCapacityMeasurements,
  startCapacityMeasurement,
  stopConditionReached,
} from '../server/services/fleet/capacityMeasurement.ts';
import {
  PROVIDER_CAPACITY_ENVELOPE,
  PROVIDER_CAPACITY_ENVELOPE_ID,
  PROVIDER_CAPACITY_MAX_ACTIVATIONS,
  PROVIDER_CAPACITY_WORKLOAD,
} from '../server/services/fleet/measurementEnvelope.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { enqueueWork, claimWork, completeWork } from '../server/repos/workQueue.ts';
import type { WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];

/** The manifest and envelope a capacity measurement has to carry. */
const MANIFEST = { envelopeId: PROVIDER_CAPACITY_ENVELOPE_ID };
const ENVELOPE = PROVIDER_CAPACITY_ENVELOPE;

let technical = '';
let live = '';

beforeEach(async () => {
  const fixture = await freshProject();
  live = fixture.project.id;
  technical = (
    await createProject({
      name: 'Capability Lab scope',
      slug: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      purpose: 'TECHNICAL',
    })
  ).id;
});

/* ========================================================================= */

describe('the two things that look like a capacity measurement', () => {
  it('a health check carrying the same manifest and envelope produces no evidence at all', async () => {
    /*
     * The literal defect, driven through the ordinary Lab routes: same
     * envelope id, same bounds, same isolated scope, and it completes. If gate
     * G read only the row, this would have answered "how much a real Cowork
     * surface holds" without a single fire.
     */
    const declared = await declareExperiment({
      projectId: technical,
      mode: 'HEALTH_CHECK',
      title: 'Is the fleet reachable?',
      envelope: ENVELOPE,
      manifest: MANIFEST,
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });

    // Everything the old condition asked for holds.
    expect(ran.state).toBe('COMPLETE');
    expect(claimsCapacityEnvelope(ran.manifest, ran.envelope).ok).toBe(true);

    // And none of the evidence a fire produces exists.
    const evidence = await capacityEvidence(ran.id);
    expect(evidence).toMatchObject({
      binsCreated: 0,
      activations: 0,
      arrivals: 0,
      distinctSessions: 0,
      completions: 0,
      maxObservedConcurrency: 0,
    });

    // The mode is what separates them, read from the rows rather than chosen.
    expect(isBoundedCapacityMeasurement(ran.mode, ran.manifest, ran.envelope)).toBe(false);
  });

  it('an in-process queue exercise claims, leases and completes and still produces no activation', async () => {
    /*
     * This is what `labRunners.ts` drives, and it is real: genuine claims,
     * genuine leases, genuine compare-and-swaps against the deployed queue
     * code. What it is not is a provider fire — nothing left this process — so
     * there is no `bin_dispatch` row marked SENT and no session to attribute.
     *
     * Asserted here rather than taken on trust, because "it exercised the
     * queue" is exactly the sentence that would make somebody read it as
     * capacity.
     */
    const workerId = await workerOn(technical, 'queue-worker');
    const declared = await declareExperiment({
      projectId: technical,
      mode: 'FLEET_PROVIDER',
      title: 'What has the fleet done?',
      // Deliberately NOT the capacity envelope: this is the ledger read.
      envelope: { ...ENVELOPE, ceiling: 3, durationMinutes: 5 },
      manifest: {},
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(ran.state).toBe('COMPLETE');

    const item = await enqueueWork({
      projectId: technical,
      workType: 'SYNTHETIC_ECHO',
      payload: { say: 'hello' },
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const claimed = await claimWork({
      workerId,
      scopes: [{ projectId: technical, scopes: SCOPES }],
      workTypes: ['SYNTHETIC_ECHO'],
    });
    expect(claimed[0]?.workItemId).toBe(item.id);
    const done = await completeWork({
      workItemId: item.id,
      workerId,
      leaseId: claimed[0]!.leaseId,
      leaseGeneration: claimed[0]!.leaseGeneration,
    });
    expect(done.ok).toBe(true);

    // A whole item claimed, leased and completed — and nothing a provider did.
    const evidence = await capacityEvidence(ran.id);
    expect(evidence.binsCreated).toBe(0);
    expect(evidence.activations).toBe(0);
    expect(evidence.arrivals).toBe(0);
    expect(evidence.completions).toBe(0);
  });
});

/* ========================================================================= */

describe('starting one', () => {
  it('refuses without a person authorizing the pressure, and creates nothing', async () => {
    const declared = await declareExperiment({
      projectId: technical,
      mode: 'FLEET_PROVIDER',
      title: 'How much does one surface hold?',
      envelope: ENVELOPE,
      manifest: MANIFEST,
      actor: 'A person',
    });
    expect(declared.state).toBe('DECLARED');

    const refused = await runExperiment({ id: declared.id, pressureAuthorized: false });
    expect(refused.state).toBe('REFUSED');
    expect(refused.refusalReason).toMatch(/needs a person to authorize/i);
    expect((await capacityEvidence(declared.id)).binsCreated).toBe(0);
  });

  it('refuses a measurement declared against a live project', async () => {
    const declared = await declareExperiment({
      projectId: live,
      mode: 'FLEET_PROVIDER',
      title: 'How much does one surface hold?',
      envelope: ENVELOPE,
      manifest: MANIFEST,
      actor: 'A person',
    });
    expect(declared.state).toBe('REFUSED');
    expect(declared.refusalReason).toMatch(/isolated testing scope/i);
  });

  it('refuses bounds that are not the declared envelope, rather than adjusting them', async () => {
    const started = await startCapacityMeasurement({
      experimentId: 'cex_never_written',
      projectId: technical,
      manifest: MANIFEST,
      envelope: { ...ENVELOPE, ceiling: ENVELOPE.ceiling + 1 },
      pressureAuthorized: true,
      actor: 'A person',
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toMatch(/not the declared measurement/i);
  });

  it('creates exactly the envelope ceiling of bins, each carrying the correlation key', async () => {
    const experiment = await authorizedMeasurement();
    expect(experiment.state).toBe('RUNNING');

    const bins = await getDb().all<{ id: string; manifest: string; workload_class: string | null }>(
      'SELECT id, manifest, workload_class FROM bins WHERE project_id = ? ORDER BY created_at',
      [technical],
    );
    expect(bins).toHaveLength(PROVIDER_CAPACITY_ENVELOPE.ceiling);
    for (const bin of bins) {
      expect(bin.manifest).toContain(`"${CAPACITY_MEASUREMENT_KEY}":"${experiment.id}"`);
      expect(bin.workload_class).toBe(PROVIDER_CAPACITY_WORKLOAD);
    }
    expect(await runningCapacityMeasurements()).toContain(experiment.id);
  });

  it('is idempotent by its own rows: a redelivered start finds the bins it made', async () => {
    const experiment = await authorizedMeasurement();
    const first = await capacityEvidence(experiment.id);
    const again = await startCapacityMeasurement({
      experimentId: experiment.id,
      projectId: technical,
      manifest: MANIFEST,
      envelope: ENVELOPE,
      pressureAuthorized: true,
      actor: 'A person',
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.binIds).toHaveLength(first.binsCreated);
    expect((await capacityEvidence(experiment.id)).binsCreated).toBe(first.binsCreated);
  });
});

/* ========================================================================= */

describe('the evidence a fire produces', () => {
  it('counts only a dispatch the provider accepted, an attributed arrival and an accepted completion', async () => {
    const experiment = await authorizedMeasurement();
    const binIds = (await capacityBinIds(experiment.id)).slice(0, 2);

    // A fire Brain made and a provider accepted, on the first bin only.
    await fireAt(binIds[0]!, 'cse_one');
    let evidence = await capacityEvidence(experiment.id);
    expect(evidence.activations).toBe(1);
    // Firing is not arriving: nothing has taken the bin yet.
    expect(evidence.arrivals).toBe(0);
    expect(evidence.completions).toBe(0);

    // A session arrives, attributed from Brain's own dispatch row.
    const worker = await workerOn(technical, 'surface-one');
    const assigned = await assignNextBin({
      workerId: worker,
      projectIds: [technical],
      sessionRef: 'cse_one',
    });
    expect(assigned).toBeTruthy();
    await recordWorkerSession({
      sessionRef: 'cse_one',
      workerId: worker,
      routineId: 'rtn_one',
      accountId: 'acc_one',
      binId: assigned!.bin.id,
      leaseGeneration: assigned!.leaseGeneration,
    });
    evidence = await capacityEvidence(experiment.id);
    expect(evidence.arrivals).toBe(1);
    expect(evidence.distinctSessions).toBe(1);
    expect(evidence.completions).toBe(0);

    // And an accepted completion — Brain checking the unit itself, not a
    // worker's claim to have done the work.
    await answer(assigned!, worker);
    evidence = await capacityEvidence(experiment.id);
    expect(evidence.completions).toBe(1);
    expect(evidence.maxObservedConcurrency).toBe(1);
  });

  it('stops at the declared activation ceiling and says which condition ended it', async () => {
    const experiment = await authorizedMeasurement();

    // The envelope's own first stop condition, reached rather than described.
    expect(
      stopConditionReached(
        { ...(await capacityEvidence(experiment.id)), activations: PROVIDER_CAPACITY_MAX_ACTIVATIONS },
        Date.now(),
      ),
    ).toBe(PROVIDER_CAPACITY_ENVELOPE.stopConditions[0]);

    const binIds = await capacityBinIds(experiment.id);
    // Forty fires against ten bins: four attempts each is what a run that keeps
    // being redelivered looks like, and it is the ceiling that stops it.
    for (let index = 0; index < PROVIDER_CAPACITY_MAX_ACTIVATIONS; index += 1) {
      await fireAt(binIds[index % binIds.length]!, `cse_${index}`, index);
    }
    expect((await capacityEvidence(experiment.id)).activations).toBe(PROVIDER_CAPACITY_MAX_ACTIVATIONS);

    const outcome = await enforceCapacityLimits({ experimentId: experiment.id });
    expect(outcome.stopped).toBe(true);
    expect(outcome.reason).toBe(PROVIDER_CAPACITY_ENVELOPE.stopConditions[0]);

    // Cleanup is the envelope's own sentence: every outstanding bin cancelled,
    // which advances its fencing generation so a late completion matches
    // nothing.
    for (const binId of binIds) {
      const bin = await getBin(binId);
      expect(['CANCELLED', 'COMPLETE']).toContain(bin!.state);
    }
    const settled = await getDb().get<{ state: string; result: string | null }>(
      'SELECT state, result FROM capability_experiments WHERE id = ?',
      [experiment.id],
    );
    expect(settled!.state).toBe('COMPLETE');
    expect(JSON.parse(settled!.result!)).toMatchObject({
      stoppedBecause: PROVIDER_CAPACITY_ENVELOPE.stopConditions[0],
      // Nothing completed, so the reading is UNKNOWN rather than zero capacity.
      evidenceClass: 'UNKNOWN',
    });
  });

  it('a run that finished every bin is MEASURED, and a run that finished none is UNKNOWN', async () => {
    const experiment = await authorizedMeasurement();
    const binIds = await capacityBinIds(experiment.id);
    for (const [index, binId] of binIds.entries()) {
      await fireAt(binId, `cse_done_${index}`);
      const worker = await workerOn(technical, `surface-${index}`);
      const assigned = await assignNextBin({
        workerId: worker,
        projectIds: [technical],
        sessionRef: `cse_done_${index}`,
      });
      await recordWorkerSession({
        sessionRef: `cse_done_${index}`,
        workerId: worker,
        routineId: `rtn_${index}`,
        accountId: `acc_${index}`,
        binId: assigned!.bin.id,
        leaseGeneration: assigned!.leaseGeneration,
      });
      await answer(assigned!, worker);
    }

    const outcome = await enforceCapacityLimits({ experimentId: experiment.id });
    expect(outcome.stopped).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.evidence.completions).toBe(binIds.length);
    expect(outcome.evidence.distinctSessions).toBe(binIds.length);

    const settled = await getDb().get<{ result: string | null }>(
      'SELECT result FROM capability_experiments WHERE id = ?',
      [experiment.id],
    );
    expect(JSON.parse(settled!.result!)).toMatchObject({ evidenceClass: 'MEASURED' });
  });

  it('the dispatch tick enforces the envelope before it creates any further intent', async () => {
    const experiment = await authorizedMeasurement();
    const binIds = await capacityBinIds(experiment.id);
    for (let index = 0; index < PROVIDER_CAPACITY_MAX_ACTIVATIONS; index += 1) {
      await fireAt(binIds[index % binIds.length]!, `cse_tick_${index}`, index);
    }

    const result = await dispatchTick();
    expect(result.capacityMeasurementsStopped).toEqual([
      { experimentId: experiment.id, reason: PROVIDER_CAPACITY_ENVELOPE.stopConditions[0] },
    ]);
    // And nothing of this measurement is left for the rest of the tick to fire.
    for (const binId of binIds) {
      expect((await getBin(binId))!.state).toBe('CANCELLED');
    }
  });
});

/* ========================================================================= *
 * Helpers — the surface's side of a fire, written from Brain's own rows.
 * ========================================================================= */

async function authorizedMeasurement() {
  const declared = await declareExperiment({
    projectId: technical,
    mode: 'FLEET_PROVIDER',
    title: 'How much does one surface hold?',
    envelope: ENVELOPE,
    manifest: MANIFEST,
    actor: 'A person',
  });
  expect(declared.state).toBe('DECLARED');
  return await runExperiment({ id: declared.id, pressureAuthorized: true });
}

async function capacityBinIds(experimentId: string): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(
    'SELECT id FROM bins WHERE manifest LIKE ? ORDER BY created_at',
    [`%"${CAPACITY_MEASUREMENT_KEY}":"${experimentId}"%`],
  );
  return rows.map((row) => row.id);
}

/**
 * One fire: Brain's own intent, claimed and marked SENT with the session the
 * provider named. The dispatcher does exactly this after `fire.ts` returns; the
 * only thing standing in for a real surface here is the session string.
 */
async function fireAt(binId: string, sessionRef: string, nonce = 0): Promise<void> {
  /*
   * A second fire at one bin needs a second generation, because `bin_dispatch`
   * is UNIQUE (bin_id, lease_generation) and that is the whole reason a no-show
   * strands a bin (§24). In production the generation advances when a worker
   * takes a lease; here it is advanced directly, because what is being counted
   * is accepted dispatches rather than how the generation moved.
   */
  if (nonce > 0) {
    await getDb().run('UPDATE bins SET lease_generation = lease_generation + 1 WHERE id = ?', [binId]);
  }
  const bin = await getBin(binId);
  await ensureDispatchIntent(bin!);
  const intent = await claimDispatchIntent();
  if (!intent) throw new Error(`no dispatch intent was claimable for ${binId}`);
  await markDispatchSent(intent.id, { routineRef: 'trig_test', sessionRef });
}

async function workerOn(projectId: string, name: string): Promise<string> {
  const worker = await createWorker({
    name: `${name}-${Math.random().toString(36).slice(2, 7)}`,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 't',
  });
  return worker.id;
}

/** Answer the bin's one declared unit and ask Brain to accept the completion. */
async function answer(
  assigned: { bin: { id: string; manifest: { units: { key: string; input: string; transform: string }[] } }; leaseId: string; leaseGeneration: number },
  workerId: string,
): Promise<void> {
  const proof = {
    binId: assigned.bin.id,
    leaseId: assigned.leaseId,
    leaseGeneration: assigned.leaseGeneration,
    workerId,
  };
  for (const unit of assigned.bin.manifest.units) {
    await submitUnit({
      workerId,
      proof,
      unitKey: unit.key,
      value: UNIT_TRANSFORMS[unit.transform as keyof typeof UNIT_TRANSFORMS]!(unit.input),
    });
  }
  const outcome = await requestCompletion({ workerId, proof });
  expect(outcome.state).toBe('COMPLETE');
}
