/**
 * The fixed check of TEL-07-1, `probe r01.tel-07-1`, judged on production rows.
 *
 * It reads the rolling reading fresh (never the minute-long cache a screen
 * reuses) and passes only when every declared measure is present in each of
 * the 1h, 6h and 24h windows, each with its window bounds and the words for
 * its denominator, and when the job count, the useful claims and the
 * commercially actionable openings are three separate figures rather than one
 * count read three ways. A measure the rows could not answer is UNKNOWN and is
 * named in the detail; it is never read as zero.
 *
 * The judgment lives here, beside the reading it judges; the name is defined in
 * the protected `factory/program/probes.ts`, the only place a release probe may
 * be registered (a campaign does not register its own judge).
 */
import type { ProbeResult } from '../factory/program/probes.ts';
import { TELEMETRY_WINDOWS, rollingTelemetry, telemetryMeasureKeys, type RollingTelemetry } from './screenMetrics.ts';

export const TELEMETRY_PROBE = 'r01.tel-07-1';

/** The three figures S-0082 requires be kept apart: job count, useful claims, commercially actionable findings. */
export const SEPARATED_MEASURES = ['jobs', 'usefulClaims', 'actionableOpenings'] as const;

/** Judge one reading. Pure, so a test can hand it any reading. */
export function judgeTelemetryReading(reading: RollingTelemetry, measures: string[] = telemetryMeasureKeys()): ProbeResult {
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const window of TELEMETRY_WINDOWS) {
    const figures = reading.windows[window.key];
    if (!figures) {
      problems.push(`window ${window.key} is missing`);
      continue;
    }
    for (const measure of measures) {
      const matching = figures.filter((f) => f.measure === measure);
      if (matching.length !== 1) {
        problems.push(`${window.key} carries ${matching.length} figure(s) for ${measure}`);
        continue;
      }
      const f = matching[0]!;
      const since = Date.parse(f.window.since);
      const until = Date.parse(f.window.until);
      if (f.window.key !== window.key || !Number.isFinite(since) || !Number.isFinite(until) || until - since !== window.ms) {
        problems.push(`${window.key} ${measure} has no ${window.key} window bounds`);
      }
      if (!f.denominatorIs.trim()) problems.push(`${window.key} ${measure} does not say what its denominator is`);
      if (f.basis === 'UNKNOWN') unknown.push(`${window.key} ${measure}${f.note ? ` (${f.note})` : ''}`);
    }
    const separated = SEPARATED_MEASURES.map((key) => figures.find((f) => f.measure === key));
    if (separated.every(Boolean)) {
      const wordings = new Set(separated.map((f) => `${f!.label}|${f!.denominatorIs}`));
      if (wordings.size !== SEPARATED_MEASURES.length) problems.push(`${window.key} reads ${SEPARATED_MEASURES.join(', ')} as the same figure`);
    } else {
      for (const [i, key] of SEPARATED_MEASURES.entries()) if (!separated[i]) problems.push(`${window.key} does not separate ${key}`);
    }
  }
  if (problems.length > 0 || unknown.length > 0) {
    const parts = [...problems, ...(unknown.length ? [`UNKNOWN: ${unknown.join('; ')}`] : [])];
    // A malformed reading is a failure; a well-formed one the rows cannot yet answer is UNKNOWN, never a pass.
    return { ok: problems.length > 0 ? false : null, detail: `telemetry at ${reading.at}: ${parts.join('; ').slice(0, 600)}` };
  }
  return {
    ok: true,
    detail: `telemetry at ${reading.at}: ${measures.length} measures read from rows in each of ${TELEMETRY_WINDOWS.map((w) => w.key).join('/')}, each with its window and denominator; ${SEPARATED_MEASURES.join(', ')} are separate figures`,
  };
}

/** Read production rows now and judge them. */
export async function telemetryHoldsOnRows(now: Date = new Date()): Promise<ProbeResult> {
  return judgeTelemetryReading(await rollingTelemetry(now));
}

