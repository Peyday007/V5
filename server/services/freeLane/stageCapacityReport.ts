/**
 * The stage-capacity report CLI (CAP-16-3): prints the latest recorded
 * `FREE_LANE_STAGE_CAPACITY` reading — per-stage figures, the diagnosed failing
 * route, whether queued work advanced, and the constrained stage with its
 * recommendation — so nobody has to query `bin_events` by hand (CLAUDE.md §2).
 *
 *   tsx server/services/freeLane/stageCapacityReport.ts            # the latest recorded reading
 *   tsx server/services/freeLane/stageCapacityReport.ts --json     # the same, as JSON
 *   tsx server/services/freeLane/stageCapacityReport.ts --measure  # measure and record now, then print it
 *
 * Read-only unless `--measure` is given, which records through the same
 * `recordStageCapacity` the lane's hourly loop calls. Below the stage-capacity
 * reading it prints the latest of each reading the same tick records:
 * `CAPACITY_CONTRIBUTION` (CAP-19-5), `ACQUISITION_MEASURES` (CAP-21-7) and
 * `STAGE_LIMIT` (CAP-25-2).
 */
import { pathToFileURL } from 'node:url';
import { closeDatabase, getDb, initDatabase } from '../../db/database.ts';
import { CAPACITY_FOLLOWER_EVENTS, readStageCapacity, recordStageCapacity, stageCapacityLines } from './stageCapacity.ts';

/** The latest row of one follower reading, or null when none has been recorded. */
export interface FollowerReading {
  event: string;
  at: string | null;
  outcome: string | null;
  reason: string | null;
  measures: Record<string, unknown> | null;
}

/** The latest recorded row of each reading the stage-capacity tick records. */
export async function readCapacityFollowers(): Promise<FollowerReading[]> {
  const out: FollowerReading[] = [];
  for (const event of CAPACITY_FOLLOWER_EVENTS) {
    const row = await getDb().get<{ at: string; outcome: string | null; reason: string | null; measures: string | null }>(
      'SELECT at, outcome, reason, measures FROM bin_events WHERE event_type = ? ORDER BY at DESC, id DESC LIMIT 1',
      [event],
    );
    let measures: Record<string, unknown> | null = null;
    try {
      measures = row?.measures ? (JSON.parse(row.measures) as Record<string, unknown>) : null;
    } catch {
      measures = null;
    }
    out.push({ event, at: row?.at ?? null, outcome: row?.outcome ?? null, reason: row?.reason ?? null, measures });
  }
  return out;
}

/** One line per follower reading: its outcome, when, and the reason it recorded. Pure. */
export function capacityFollowerLines(readings: readonly FollowerReading[]): string[] {
  return readings.map((r) =>
    r.at === null
      ? `${r.event.toLowerCase().padEnd(22)}not recorded yet (recorded on the hourly stage-capacity tick)`
      : `${r.event.toLowerCase().padEnd(22)}${r.outcome ?? '—'} ${r.at} — ${r.reason ?? ''}`,
  );
}

export async function stageCapacityReport(args: readonly string[]): Promise<string> {
  if (args.includes('--measure')) await recordStageCapacity();
  const recorded = await readStageCapacity();
  const followers = await readCapacityFollowers();
  if (args.includes('--json')) return JSON.stringify({ ...(recorded ?? {}), followers }, null, 2);
  return [...stageCapacityLines(recorded), ...capacityFollowerLines(followers)].join('\n');
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (invoked) {
  void (async () => {
    try {
      await initDatabase();
      console.log(await stageCapacityReport(process.argv.slice(2)));
    } catch (error) {
      console.error(`stage capacity report failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      await closeDatabase().catch(() => undefined);
    }
  })();
}
