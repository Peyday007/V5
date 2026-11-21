/**
 * CAP-19-5 / CAP-21-7 / CAP-25-2 wiring — the free lane's existing hourly
 * stage-capacity tick also records CAPACITY_CONTRIBUTION, ACQUISITION_MEASURES
 * and STAGE_LIMIT, each isolated, and the report CLI prints all three. No new
 * timer, scheduler or table. Over real database rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  ACQUISITION_DECISION_STALE_MS,
  CAPACITY_FOLLOWER_EVENTS,
  STAGE_CAPACITY_EVENT,
  STAGE_CAPACITY_STALE_MS,
  decisionHold,
  gateGrowth,
  readCapacityDecisions,
  readStageCapacity,
  type CapacityDecisions,
  type RecordedStageCapacity,
  type StageCapacityReport,
  defaultCapacityFollowers,
  recordStageCapacity,
  runCapacityFollowers,
  type CapacityFollower,
} from '../server/services/freeLane/stageCapacity.ts';
import { capacityFollowerLines, readCapacityFollowers, stageCapacityReport } from '../server/services/freeLane/stageCapacityReport.ts';
import { CAPACITY_CONTRIBUTION_EVENT } from '../server/services/freeLane/contribution.ts';
import { STAGE_LIMIT_EVENT } from '../server/services/freeLane/stageLimit.ts';
import { ACQUISITION_MEASURES_EVENT } from '../server/services/feeds/acquisitionMeasures.ts';
import { recordBinEvent } from '../server/repos/bins.ts';

beforeEach(async () => {
  await freshProject();
});

async function rows(eventType: string): Promise<{ outcome: string; reason: string | null }[]> {
  return getDb().all(`SELECT outcome, reason FROM bin_events WHERE event_type = ? ORDER BY at, id`, [eventType]);
}

describe('the hourly stage-capacity tick records the three readings', () => {
  it('names each owner’s own event', () => {
    expect([...CAPACITY_FOLLOWER_EVENTS]).toEqual([CAPACITY_CONTRIBUTION_EVENT, ACQUISITION_MEASURES_EVENT, STAGE_LIMIT_EVENT]);
    expect(defaultCapacityFollowers().map((f) => f.event)).toEqual([...CAPACITY_FOLLOWER_EVENTS]);
  });

  it('one tick writes the stage-capacity row and all three new bin events, with the real readers', async () => {
    await recordStageCapacity({ hours: 1 });
    expect(await rows(STAGE_CAPACITY_EVENT)).toHaveLength(1);
    for (const event of CAPACITY_FOLLOWER_EVENTS) {
      const written = await rows(event);
      expect(written, event).toHaveLength(1);
      expect(written[0]!.outcome, event).not.toBe('NOT_MEASURED');
    }
  });

  it('a reader that fails is logged and recorded as NOT_MEASURED, and neither the others nor the stage-capacity row are lost', async () => {
    const ran: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const followers: CapacityFollower[] = [
      { event: CAPACITY_CONTRIBUTION_EVENT, run: async () => { throw new Error('contribution reader exploded'); } },
      { event: ACQUISITION_MEASURES_EVENT, run: async () => { ran.push('acquisition'); } },
      { event: STAGE_LIMIT_EVENT, run: async () => { ran.push('limit'); } },
    ];
    const report = await recordStageCapacity({ hours: 1, followers });
    expect(report).not.toBeNull();
    expect(await rows(STAGE_CAPACITY_EVENT)).toHaveLength(1);
    expect(ran).toEqual(['acquisition', 'limit']);
    const failed = await rows(CAPACITY_CONTRIBUTION_EVENT);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.outcome).toBe('NOT_MEASURED');
    expect(failed[0]!.reason).toContain('contribution reader exploded');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('contribution reader exploded'))).toBe(true);
    warn.mockRestore();
  });

  it('runCapacityFollowers never throws and reports each outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await runCapacityFollowers(new Date(), [
      { event: STAGE_LIMIT_EVENT, run: async () => { throw new Error('limit down'); } },
      { event: ACQUISITION_MEASURES_EVENT, run: async () => undefined },
    ]);
    expect(out).toEqual([
      { event: STAGE_LIMIT_EVENT, ok: false, error: 'limit down' },
      { event: ACQUISITION_MEASURES_EVENT, ok: true, error: null },
    ]);
    warn.mockRestore();
  });
});

describe('the report CLI prints the three readings', () => {
  it('says each is not recorded yet before the first tick', async () => {
    const lines = capacityFollowerLines(await readCapacityFollowers());
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('not recorded yet');
  });

  it('prints the latest of each after a tick, in text and JSON', async () => {
    await recordStageCapacity({ hours: 1 });
    const text = await stageCapacityReport([]);
    expect(text).toContain('stage capacity');
    for (const event of CAPACITY_FOLLOWER_EVENTS) {
      const line = text.split('\n').find((l) => l.startsWith(event.toLowerCase()));
      expect(line, event).toBeTruthy();
      expect(line, event).not.toContain('not recorded yet');
    }
    const json = JSON.parse(await stageCapacityReport(['--json'])) as { at: string; followers: { event: string; at: string | null }[] };
    expect(typeof json.at).toBe('string');
    expect(json.followers.map((f) => f.event)).toEqual([...CAPACITY_FOLLOWER_EVENTS]);
    for (const f of json.followers) expect(f.at).not.toBeNull();
  });
});

/*
 * F1 (review round 1): the decisions were written and only printed. The free
 * lane's capacity controller (`capacity.ts` controlStep) reads the recorded
 * stage capacity through `readStageCapacity` and asks `gateGrowth` before any
 * growth past proven capacity; both now carry and act on the three readings.
 */
describe('the capacity controller acts on the recorded decisions', () => {
  const none: CapacityDecisions = { contribution: null, stageLimit: null, acquisition: null };
  // A current reading that, on its own, allows a GPU slot to grow: a lane stage is constrained with a measured gain.
  const allowing = (decisions: CapacityDecisions): RecordedStageCapacity => ({
    at: '2026-11-17T12:00:00.000Z', outcome: 'MEASURED', reason: 'r', ageMinutes: 5, stale: false, queuedNow: 3, queueAdvance: null,
    report: {
      windowHours: 6, since: '2026-11-17T06:00:00.000Z', stages: [],
      diagnosis: { routes: [], gpu: { samples: {}, startFailures: 0, lastStartFailure: null, notRunning: false }, primary: null, restored: [] },
      constrained: { stage: 'model-interpretation', expectedGain: { measured: true, value: { acceptedFactsPerHour: 4, dollars: 0.5 } } },
    } as unknown as StageCapacityReport,
    decisions,
  });
  const model = 'runpod/Org/A';
  const grow = (decisions: CapacityDecisions, answering = false) =>
    gateGrowth({ model, gpu: true, current: 2, stableHigh: 2, proposed: 4, recorded: allowing(decisions), answering });
  const contribution = (verdict: string, basis: string, id = model): CapacityDecisions => ({
    ...none, contribution: { at: 't', decisions: [{ kind: 'MODEL_ROUTE', id, verdict, basis, recommendation: 'r' }] },
  });

  it('grows when no reading objects', () => {
    expect(grow(none)).toMatchObject({ held: false, target: 4 });
  });

  it('holds growth of a component the contribution reading says to repair, retire, or that holds idle slots', () => {
    expect(grow(contribution('REPAIR', 'FAILING:provider availability'))).toMatchObject({ held: true, target: 2 });
    expect(grow(contribution('RETIRE', 'COST_WITHOUT_OUTPUT')).reason).toContain('no accepted output');
    expect(grow(contribution('HOLD', 'PROVISIONED_NOT_PRODUCTIVE')).reason).toContain('provisioned concurrency is not throughput');
    // Another component's verdict, or a verdict that is not a hold, does not bind this one.
    expect(grow(contribution('REPAIR', 'FAILING:credentials', 'brain-b'))).toMatchObject({ held: false });
    expect(grow(contribution('SCALE', 'MEASURED_SATURATION'))).toMatchObject({ held: false });
    // A route that has answered since the reading is restored, as for the stage reading's own failing route.
    expect(grow(contribution('REPAIR', 'FAILING:provider availability'), true)).toMatchObject({ held: false });
  });

  it('holds growth while the stage-limit reading names a limit more model slots do not relieve, or its spend gate refuses', () => {
    const limit = (kind: string, gate = 'ALLOW_THEN_MEASURE'): CapacityDecisions => ({
      ...none, stageLimit: { at: 't', kind, basis: 'b', remedy: 'Improve access or source selection.', gate, gateReason: 'Remove the reversible blockage first.' },
    });
    for (const kind of ['SOURCE_ACCESS', 'PARSING', 'RECONCILIATION', 'DATABASE', 'APP_CPU', 'COMMERCIAL_RELEVANCE']) {
      expect(grow(limit(kind)), kind).toMatchObject({ held: true, target: 2 });
    }
    for (const kind of ['MODEL_INTERPRETATION', 'VERIFICATION', 'NONE']) expect(grow(limit(kind)), kind).toMatchObject({ held: false });
    expect(grow(limit('NONE', 'REFUSE_REMOVE_BLOCKAGE_FIRST')).reason).toContain('pre-spend gate');
    expect(grow(limit('NONE', 'NO_GAIN_REVERT'))).toMatchObject({ held: true });
    // The spend gate binds hardware: a free provider's slot is not hardware spend.
    expect(decisionHold({ model: 'brain-a', gpu: false, decisions: limit('NONE', 'REFUSE_REMOVE_BLOCKAGE_FIRST') })).toBeNull();
  });

  it('holds growth of the resource class the acquisition reading says to repair', () => {
    const acq = (resource: string, action: string): CapacityDecisions => ({ ...none, acquisition: { at: 't', recommendations: [{ resource, action, reason: 'outage in front of it' }] } });
    expect(grow(acq('GPU', 'REPAIR'))).toMatchObject({ held: true });
    expect(grow(acq('LLM_WORKERS', 'REPAIR'))).toMatchObject({ held: false });
    expect(decisionHold({ model: 'brain-a', gpu: false, decisions: acq('LLM_WORKERS', 'REPAIR') })).toContain('repair LLM_WORKERS');
    expect(grow(acq('GPU', 'INCREASE'))).toMatchObject({ held: false });
  });

  it('readStageCapacity carries the current decisions from their real rows, and drops stale ones', async () => {
    await recordStageCapacity({ hours: 1, followers: [] });
    await recordBinEvent({
      eventType: CAPACITY_CONTRIBUTION_EVENT, workloadClass: 'capacity', outcome: 'REPAIR_FIRST', reason: 'r', evidenceClass: 'MEASURED',
      measures: { decisions: [{ kind: 'MODEL_ROUTE', id: model, verdict: 'REPAIR', basis: 'FAILING:broken GPU', recommendation: 'Repair it.' }] },
    });
    await recordBinEvent({
      eventType: STAGE_LIMIT_EVENT, workloadClass: 'capacity', outcome: 'PARSING', reason: 'r', evidenceClass: 'MEASURED',
      measures: { limit: { kind: 'PARSING', basis: '10% parsed', remedy: 'Add efficient code workers for parsing.' }, gate: { decision: 'ALLOW_THEN_MEASURE', reason: 'ok' } },
    });
    await recordBinEvent({
      eventType: ACQUISITION_MEASURES_EVENT, workloadClass: 'acquisition', outcome: 'MEASURED', reason: 'r', evidenceClass: 'MEASURED',
      measures: { constraint: { recommendations: [{ resource: 'GPU', action: 'REPAIR', reason: 'outage' }] } },
    });
    const recorded = await readStageCapacity();
    expect(recorded?.decisions?.contribution?.decisions).toEqual([{ kind: 'MODEL_ROUTE', id: model, verdict: 'REPAIR', basis: 'FAILING:broken GPU', recommendation: 'Repair it.' }]);
    expect(recorded?.decisions?.stageLimit).toMatchObject({ kind: 'PARSING', gate: 'ALLOW_THEN_MEASURE' });
    expect(recorded?.decisions?.acquisition?.recommendations).toEqual([{ resource: 'GPU', action: 'REPAIR', reason: 'outage' }]);
    expect(decisionHold({ model, gpu: true, decisions: recorded!.decisions })).toContain('repair model_route');

    const later = Date.now() + STAGE_CAPACITY_STALE_MS + 60_000;
    const aged = await readCapacityDecisions(later);
    expect(aged.contribution).toBeNull();
    expect(aged.stageLimit).toBeNull();
    expect(aged.acquisition).not.toBeNull();
    expect((await readCapacityDecisions(Date.now() + ACQUISITION_DECISION_STALE_MS + 60_000)).acquisition).toBeNull();
  });

  it('an absent or unreadable follower row decides nothing', async () => {
    expect(await readCapacityDecisions()).toEqual(none);
    await recordBinEvent({ eventType: STAGE_LIMIT_EVENT, workloadClass: 'capacity', outcome: 'X', reason: 'r', evidenceClass: 'MEASURED', measures: { nothing: true } });
    expect((await readCapacityDecisions()).stageLimit).toBeNull();
  });
});

describe('boundMeasures (finding F8)', () => {
  it('leaves a small reading as it is and cuts long lists, counting what it cut', async () => {
    const { boundMeasures, STORED_LIST_LIMIT, STORED_MEASURES_MAX_BYTES } = await import('../server/services/freeLane/stageCapacity.ts');
    expect(boundMeasures({ a: 1, list: [1, 2] })).toEqual({ a: 1, list: [1, 2] });
    const big = { since: 's', nested: { rows: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(400) })) } };
    const out = boundMeasures(big);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(STORED_MEASURES_MAX_BYTES);
    expect((out['nested'] as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(STORED_LIST_LIMIT);
    expect((out['truncated'] as Record<string, { total: number }>)['nested.rows']!.total).toBe(500);
    expect(out['since']).toBe('s');
    const scalarOnly = boundMeasures({ until: 'u', blob: { s: 'y'.repeat(200_000) } });
    expect(scalarOnly['until']).toBe('u');
    expect(JSON.stringify(scalarOnly).length).toBeLessThanOrEqual(STORED_MEASURES_MAX_BYTES);
    // A top-level list given its own limit keeps more, and shrinks with the rest when the row is too big.
    const own = boundMeasures({ keep: Array.from({ length: 300 }, (_, i) => i), other: Array.from({ length: 300 }, (_, i) => i) }, { limits: { keep: 200 } });
    expect((own['keep'] as unknown[]).length).toBe(200);
    expect((own['other'] as unknown[]).length).toBe(STORED_LIST_LIMIT);
  });
});
