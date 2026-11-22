/**
 * CAP-16-3, structural review (episode 4): a held model route is asked with a
 * route probe (FREE_LANE_ROUTE_PROBE) instead of a work item, so the stage
 * measurement counts the probe's failures as provider failures of the model
 * stages. Moving outage discovery off work items must hide no failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { ROUTE_PROBE_EVENT } from '../server/services/freeLane/routeProbe.ts';
import { diagnoseThroughput, recordStageCapacity, STAGE_CAPACITY_EVENT, stageCapacity } from '../server/services/freeLane/stageCapacity.ts';
import { checkReading } from '../server/services/factory/program/release01/capacityProbe.ts';

const FREE = 'brain-a';
const OTHER = 'brain-b';
const t = (minutes: number) => new Date(Date.UTC(2026, 10, 22, 1, 0, 0) + minutes * 60_000).toISOString();

async function at(iso: string, input: Parameters<typeof recordBinEvent>[0]): Promise<void> {
  await recordBinEvent(input);
  await getDb().run('UPDATE bin_events SET at = ? WHERE id = (SELECT id FROM bin_events ORDER BY rowid DESC LIMIT 1)', [iso]);
}
const item = (iso: string, workType: string, outcome: string, reason: string) =>
  at(iso, { eventType: 'FREE_LANE_ITEM', workloadClass: workType, outcome, reason, durationMs: 1000 });
const probe = (iso: string, outcome: 'OK' | 'FAILED', reason: string) =>
  at(iso, { eventType: ROUTE_PROBE_EVENT, outcome, reason, durationMs: 200, measures: { route: FREE } });

const laneStage = (report: Awaited<ReturnType<typeof stageCapacity>>, id: string) => report.stages.find((s) => s.stage === id)!;
const failures = (stage: { providerFailures: unknown }): number => {
  const m = stage.providerFailures as { measured: boolean; value?: number };
  expect(m.measured).toBe(true);
  return m.value!;
};

describe('stage capacity counts route-probe failures (CAP-16-3 structural)', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  it('reports K failed probes + F failed item calls as provider failures for the lane stages', async () => {
    // F: failed item calls, per stage.
    await item(t(1), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await item(t(2), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await item(t(3), 'RESEARCH_VERIFY', 'RELEASED_TRANSIENT', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 503`);
    await item(t(4), 'RESEARCH_VERIFY', 'SUBMITTED', `model ${OTHER}`);
    // K: the held route's probes, three failed and one answered; a database refusal is not a provider failure.
    await probe(t(10), 'FAILED', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await probe(t(20), 'FAILED', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await probe(t(40), 'FAILED', `model ${FREE}: model call failed [credentials]: cheap lane HTTP 401`);
    await probe(t(45), 'FAILED', `model ${FREE}: model call failed [database]: The database pool had no free connection`);
    await probe(t(80), 'OK', `model ${FREE}`);

    const report = await stageCapacity({ hours: 6, now: Date.parse(t(90)) });
    expect(failures(laneStage(report, 'model-interpretation'))).toBe(3 + 2);
    expect(failures(laneStage(report, 'evidence-verification'))).toBe(3 + 1);
    // A probe is not an item: the items-processed rate and accepted count read item rows only.
    expect(laneStage(report, 'evidence-verification').accepted).toBe(1);
    expect((laneStage(report, 'model-interpretation').itemsProcessedPerHour as { value: number }).value).toBeCloseTo(2 / 6);
  });

  it('a window with no probe rows reads exactly as before', async () => {
    await item(t(1), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    const report = await stageCapacity({ hours: 6, now: Date.parse(t(10)) });
    expect(failures(laneStage(report, 'model-interpretation'))).toBe(1);
    expect(failures(laneStage(report, 'evidence-verification'))).toBe(0);
  });

  it('the route diagnosis reports probe outcomes beside item outcomes, and a failing probe keeps the route named', async () => {
    await item(t(1), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await probe(t(10), 'FAILED', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await probe(t(20), 'FAILED', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await probe(t(25), 'OK', `model ${FREE}`);
    await probe(t(28), 'FAILED', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    const diagnosis = await diagnoseThroughput(t(-1), Date.parse(t(30)));
    const route = diagnosis.routes.find((r) => r.route === FREE)!;
    expect(route.providerFailures).toBe(4);
    expect(route.probeFailures).toBe(3);
    expect(route.probeAnswered).toBe(1);
    // An answered probe is not accepted work: the route is not counted as having submitted anything.
    expect(route.submitted).toBe(0);
    expect(route.restored).toBe(false);
    expect(diagnosis.primary).toMatchObject({ route: FREE, cause: 'provider availability', failures: 4 });
  });

  it('a reading recorded over probe rows still has the shape the CAP-16-3 probe accepts', async () => {
    await item(t(1), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await item(t(2), 'RESEARCH_VERIFY', 'SUBMITTED', `model ${OTHER}`);
    await probe(t(10), 'FAILED', `model ${FREE}: model call failed [provider availability]: cheap lane HTTP 429`);
    await recordStageCapacity({ hours: 6, now: Date.parse(t(20)) });
    const row = await getDb().get<{ outcome: string; measures: string }>('SELECT outcome, measures FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1', [STAGE_CAPACITY_EVENT]);
    expect(row?.outcome).toBe('MEASURED');
    const measures = JSON.parse(row!.measures) as Record<string, unknown>;
    expect(checkReading(measures).defect).toBeNull();
    const stages = measures['stages'] as { stage: string; providerFailures: { value: number } }[];
    expect(stages.find((s) => s.stage === 'model-interpretation')!.providerFailures.value).toBe(2);
    expect(stages.find((s) => s.stage === 'evidence-verification')!.providerFailures.value).toBe(1);
  });
});
