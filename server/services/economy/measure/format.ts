import type { GoalMeasurement } from './measure.ts';
import { STAGE_LABEL } from './measure.ts';

const unknown = (value: number | null, unit = ''): string => (value === null ? 'unknown' : `${value}${unit}`);

function duration(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 120) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  return minutes < 120 ? `${Math.round(minutes)} min` : `${Math.round((minutes / 60) * 10) / 10} h`;
}

/** Lines for the plan readout. Unmeasured figures say unknown; none is printed as zero. */
export function measurementLines(m: GoalMeasurement): string[] {
  const lines = ['  measured    per stage (unknown = no row records it)'];
  for (const s of m.stages) {
    lines.push(
      `    ${STAGE_LABEL[s.stage].padEnd(34)} time ${duration(s.timeMs)} · screened ${unknown(s.candidatesScreened)} rejected ${unknown(s.candidatesRejected)} advanced ${unknown(s.candidatesAdvanced)} · research jobs ${unknown(s.researchJobs)} · AI passes ${unknown(s.aiPasses)}`,
    );
    for (const note of s.unmeasured) lines.push(`      note      ${note}`);
  }
  lines.push(`  found       ${unknown(m.relevantOpenings)} opening(s) with every evidence link established · ${unknown(m.supportedPlans)} supported plan(s)`);
  if (m.bottlenecks.length === 0) lines.push('  slow because  nothing measured is waiting');
  for (const b of m.bottlenecks) lines.push(`  slow because  ${b}`);
  return lines;
}
