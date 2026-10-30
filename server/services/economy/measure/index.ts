import type { PlanReading } from '../../goals/plan.ts';
import { measureGoal, readMeasureRows, type GoalMeasurement } from './measure.ts';

export { measureGoal, readMeasureRows, MEASURE_STAGES, STAGE_LABEL } from './measure.ts';
export type { GoalMeasurement, MeasureInput, StageMeasure, MeasureStage } from './measure.ts';
export { measurementLines } from './format.ts';

/** The measurement for a plan reading already in hand. Reads, never writes. */
export async function measurePlan(reading: PlanReading, now = new Date()): Promise<GoalMeasurement> {
  const rows = await readMeasureRows(reading.goalId);
  return measureGoal({
    goalId: reading.goalId,
    considered: reading.considered.length,
    modelled: reading.considered.filter((one) => one.modelled).length,
    excluded: reading.excluded.length,
    relevantOpenings: reading.considered.filter((one) => one.missing.length === 0).length,
    supportedPlans: reading.strategies.filter((one) => one.verdict === 'RECOMMENDABLE').length,
    needsMoreOpenings: reading.needsMoreOpenings,
    now,
    ...rows,
  });
}
