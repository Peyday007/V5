/**
 * MEM-32, S-0472: predictions against results, classified into the owner's six
 * classes from measured signals only; one unlucky result never becomes a rule;
 * a warranted correction is recorded once with supporting and disconfirming
 * evidence, inside its project; a software correction is labelled Factory work
 * (`server/services/goals/calibration.ts`).
 */
import { describe, expect, it } from 'vitest';
import { assessModelLearning } from '../server/services/quant/learning.ts';
import type { MissCause, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';
import {
  CAUSE_CLASS,
  MIN_CORRECTION_MISSES,
  classifyMiss,
  goalPredictionRows,
  lessonOf,
  methodCorrections,
  productionCalibrationPorts,
  reconcileCalibration,
  type CalibrationPorts,
} from '../server/services/goals/calibration.ts';
import { listOperatorLearnings } from '../server/repos/operator.ts';
import { freshProject } from './helpers.ts';

const PROJECT = 'prj_a';

function prediction(i: number, over: Partial<PredictionRow> = {}): PredictionRow {
  return {
    id: `cash:${PROJECT}:claim${i}@v1`,
    claimId: `cash:${PROJECT}:claim${i}`,
    version: 1,
    outcome: 'the deal settles',
    horizonDays: 30,
    population: 'small bakeries',
    data: ['cash_outcomes:seed'],
    assumptions: ['reply rate 5%'],
    probability: 0.9,
    comparableKey: 'bucket-a',
    madeAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function outcome(p: PredictionRow, occurred: boolean, causes: MissCause[] = [], day = 1): OutcomeRow {
  return {
    predictionId: p.id,
    observedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    occurred,
    ...(causes.length ? { observedCauses: causes } : {}),
    evidence: `cash_outcomes:${p.id}`,
  };
}

/** A miscalibrated bucket: 24 predictions at 90%, `misses` of them failing with the given observed cause. */
function systematic(cause: MissCause, misses = 16, key = 'bucket-a') {
  const predictions = Array.from({ length: 24 }, (_, i) => prediction(i, { comparableKey: key, id: `cash:${PROJECT}:${key}-${i}@v1`, claimId: `cash:${PROJECT}:${key}-${i}` }));
  const outcomes = predictions.map((p, i) => outcome(p, i >= misses, i < misses ? [cause] : [], (i % 27) + 1));
  return { predictions, outcomes };
}

describe('classifying a miss', () => {
  it('maps every measured cause to one of the owner\'s classes', () => {
    for (const cause of Object.keys(CAUSE_CLASS) as MissCause[]) {
      const rows = systematic(cause);
      const reading = assessModelLearning({ ...rows, exposures: [] });
      const failed = reading.diagnoses.find((d) => d.kind === 'SYSTEMATIC' && d.causes.includes(cause));
      expect(failed, cause).toBeDefined();
      expect(classifyMiss(failed!).classes).toContain(CAUSE_CLASS[cause]);
    }
    expect(new Set(Object.values(CAUSE_CLASS))).toEqual(
      new Set(['BAD_MODEL', 'LOW_QUALITY_EVIDENCE', 'CHANGED_MARKET', 'OMITTED_DEPENDENCY', 'EXECUTION_FAILURE']),
    );
  });

  it('calls an ordinary miss in a calibrated bucket expected variability', () => {
    // 70% forecasts, 21 of 30 occurring: calibrated, so each of the 9 misses is the downside it allowed for.
    const predictions = Array.from({ length: 30 }, (_, i) => prediction(i, { probability: 0.7 }));
    const outcomes = predictions.map((p, i) => outcome(p, i % 10 >= 3, [], (i % 27) + 1));
    const reading = assessModelLearning({ predictions, exposures: [], outcomes });
    const miss = reading.diagnoses.find((d) => d.contradicted);
    expect(miss?.kind).toBe('EXPECTED_MISS');
    expect(classifyMiss(miss!).classes).toEqual(['EXPECTED_VARIABILITY']);
    expect(methodCorrections(reading, { goalId: 'wst_1', projectId: PROJECT })).toEqual([]);
  });

  it('a systematic miss nothing measured explains is UNKNOWN, never a guessed class', () => {
    const predictions = Array.from({ length: 24 }, (_, i) => prediction(i, { data: ['x'], assumptions: ['y'] }));
    const outcomes = predictions.map((p, i) => outcome(p, i >= 16, [], (i % 27) + 1));
    const reading = assessModelLearning({ predictions, exposures: [], outcomes });
    const unexplained = reading.diagnoses.find((d) => d.kind === 'SYSTEMATIC' && d.causes.length === 0);
    if (unexplained) expect(classifyMiss(unexplained).classes).toEqual(['UNKNOWN']);
    for (const d of reading.diagnoses) {
      for (const c of classifyMiss(d).classes) expect(c).not.toBe('EXPECTED_VARIABILITY');
    }
  });
});

describe('one unlucky result is not a rule', () => {
  it('a single confident miss produces no correction and reads UNKNOWN', () => {
    const p = prediction(1);
    const reading = assessModelLearning({ predictions: [p], exposures: [], outcomes: [outcome(p, false, ['TIMING'])] });
    expect(reading.diagnoses[0]!.kind).toBe('UNJUDGED');
    expect(classifyMiss(reading.diagnoses[0]!).classes).toEqual(['UNKNOWN']);
    expect(methodCorrections(reading, { goalId: 'wst_1', projectId: PROJECT })).toEqual([]);
  });

  it('misses below the minimum sample produce no correction, even many of them', () => {
    const predictions = Array.from({ length: 10 }, (_, i) => prediction(i));
    const outcomes = predictions.map((p) => outcome(p, false, ['PARAMETER_ESTIMATE']));
    const reading = assessModelLearning({ predictions, exposures: [], outcomes });
    expect(methodCorrections(reading, { goalId: 'wst_1', projectId: PROJECT })).toEqual([]);
  });

  it('a warranted correction names a specific method and keeps both sides of the evidence', () => {
    const reading = assessModelLearning({ ...systematic('TIMING'), exposures: [] });
    const [timing] = methodCorrections(reading, { goalId: 'wst_1', projectId: PROJECT }).filter((c) => c.cause === 'TIMING');
    expect(timing).toBeDefined();
    expect(timing!.missClass).toBe('EXECUTION_FAILURE');
    expect(timing!.supporting.length).toBeGreaterThanOrEqual(MIN_CORRECTION_MISSES);
    expect(timing!.disconfirming.length).toBe(8);
    expect(timing!.method).toMatch(/horizon/);
    expect(timing!.needsFactory).toBe(false);
    const { lesson, evidence } = lessonOf(timing!);
    expect(lesson).toContain('EXECUTION_FAILURE (TIMING)');
    expect(evidence).toContain('supporting 16');
    expect(evidence).toContain('disconfirming 8');
  });

  it('a software correction is labelled Factory work and not applied', () => {
    const reading = assessModelLearning({ ...systematic('MODEL_IMPLEMENTATION'), exposures: [] });
    const [model] = methodCorrections(reading, { goalId: 'wst_1', projectId: PROJECT }).filter((c) => c.cause === 'MODEL_IMPLEMENTATION');
    expect(model!.needsFactory).toBe(true);
    expect(model!.owner).toBe('FACTORY');
    expect(lessonOf(model!).lesson).toMatch(/^\[FACTORY\]/);
    expect(lessonOf(model!).lesson).toContain('not applied by this pass');
  });
});

describe('goal plan predictions on the ledger shape', () => {
  it('a reading with a defensible probability is a prediction, and its goal outcome resolves it; coverage states nothing', () => {
    const rows = goalPredictionRows(
      [
        { id: 'gpr_1', goalId: 'wst_1', projectId: PROJECT, createdAt: '2026-10-01T00:00:00.000Z', dueAt: '2026-10-31T00:00:00.000Z', forecast: { acceptance: { probability: { value: 0.92, lowerBound: 0.9, basis: 'EVIDENCED_PORTFOLIO', sample: 400, note: 'monte carlo' } } } },
        { id: 'gpr_2', goalId: 'wst_1', projectId: PROJECT, createdAt: '2026-10-02T00:00:00.000Z', dueAt: null, forecast: { acceptance: { probability: null } } },
      ],
      [{ id: 'gou_1', readingId: 'gpr_1', kind: 'MISSED', observedAt: '2026-11-01T00:00:00.000Z' }],
    );
    expect(rows.predictions).toHaveLength(1);
    expect(rows.predictions[0]).toMatchObject({ probability: 0.92, comparableKey: 'goal-plan:EVIDENCED_PORTFOLIO', horizonDays: 30, claimId: `goal:${PROJECT}:wst_1` });
    expect(rows.outcomes).toEqual([{ predictionId: rows.predictions[0]!.id, observedAt: '2026-11-01T00:00:00.000Z', occurred: false, evidence: 'goal_outcomes:gou_1' }]);
  });
});

function memoryPorts(input: { ledger: ReturnType<typeof systematic>; goals: { goalId: string; projectId: string }[] }) {
  const written: { goalId: string; lesson: string; evidence: string }[] = [];
  const ports: CalibrationPorts = {
    goals: async () => input.goals,
    ledger: async () => ({ predictions: input.ledger.predictions, exposures: [], outcomes: input.ledger.outcomes }),
    goalRows: async () => ({ readings: [], outcomes: [] }),
    recordedKeys: async (goalId) =>
      new Set(written.filter((w) => w.goalId === goalId).map((w) => w.evidence.slice('calibration-key='.length, 'calibration-key='.length + 32))),
    record: async (goalId, lesson, evidence) => {
      written.push({ goalId, lesson, evidence });
    },
  };
  return { ports, written };
}

describe('recording corrections', () => {
  it('records each correction once across passes', async () => {
    const { ports, written } = memoryPorts({ ledger: systematic('CAPACITY'), goals: [{ goalId: 'wst_1', projectId: PROJECT }] });
    const first = await reconcileCalibration(ports);
    expect(first[0]!.recorded.length).toBeGreaterThan(0);
    const count = written.length;
    const second = await reconcileCalibration(ports);
    expect(second[0]!.recorded).toEqual([]);
    expect(second[0]!.alreadyRecorded).toBe(count);
    expect(written).toHaveLength(count);
    expect(first[0]!.classes.EXECUTION_FAILURE).toBeGreaterThan(0);
  });

  it('never learns from another project\'s rows', async () => {
    // Every row belongs to another project: the goal in PROJECT sees none of it.
    const foreign = systematic('CAPACITY');
    const other = {
      predictions: foreign.predictions.map((p) => ({ ...p, id: p.id.replace(PROJECT, 'prj_other'), claimId: p.claimId.replace(PROJECT, 'prj_other') })),
      outcomes: foreign.outcomes.map((o) => ({ ...o, predictionId: o.predictionId.replace(PROJECT, 'prj_other') })),
    };
    const { ports, written } = memoryPorts({ ledger: other, goals: [{ goalId: 'wst_1', projectId: PROJECT }] });
    const report = await reconcileCalibration(ports);
    expect(report[0]!.resolved).toBe(0);
    expect(written).toEqual([]);
  });

  it('writes to the operator learning store and reads its own keys back', async () => {
    await freshProject();
    const production = await productionCalibrationPorts();
    const rows = systematic('CHANGED_CONDITIONS');
    const ports: CalibrationPorts = {
      ...production,
      goals: async () => [{ goalId: 'wst_db', projectId: PROJECT }],
      ledger: async () => ({ predictions: rows.predictions, exposures: [], outcomes: rows.outcomes }),
      goalRows: async () => ({ readings: [], outcomes: [] }),
    };
    const first = await reconcileCalibration(ports);
    const stored = await listOperatorLearnings({ goalId: 'wst_db', limit: 50 });
    expect(stored.length).toBe(first[0]!.recorded.length);
    expect(stored.some((s) => s.lesson.includes('CHANGED_MARKET (CHANGED_CONDITIONS)'))).toBe(true);
    expect(stored.every((s) => s.evidence.includes(`project=${PROJECT}`))).toBe(true);
    const second = await reconcileCalibration(ports);
    expect(second[0]!.recorded).toEqual([]);
    expect(await listOperatorLearnings({ goalId: 'wst_db', limit: 50 })).toHaveLength(stored.length);
  });
});
