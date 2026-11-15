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
 * Every text report ends with the probe's own verdict on the latest reading
 * (`capacityProbe.checkReading`, CAP-16-3): the writer is judged by the judge,
 * never by a copy of its rules, so the two cannot drift unnoticed.
 *
 * Read-only unless `--measure` is given, which records through the same
 * `recordStageCapacity` the lane's hourly loop calls.
 */
import { pathToFileURL } from 'node:url';
import { closeDatabase, initDatabase } from '../../db/database.ts';
import { checkReading } from '../factory/program/release01/capacityProbe.ts';
import { readStageCapacity, recordStageCapacity, stageCapacityLines, type RecordedStageCapacity } from './stageCapacity.ts';

/** The probe's verdict on one recorded reading, as the line an operator reads. */
export function contractLine(recorded: RecordedStageCapacity | null): string {
  if (!recorded) return '  probe contract  no reading to judge';
  if (!recorded.report) return `  probe contract  no measures to judge (${recorded.outcome})`;
  const measures = { ...recorded.report, queuedNow: recorded.queuedNow, queueAdvance: recorded.queueAdvance };
  const check = checkReading(JSON.parse(JSON.stringify(measures)) as Record<string, unknown>);
  return check.defect
    ? `  probe contract  DEFECT: the reading ${check.defect}`
    : `  probe contract  well-formed (${check.measured} measured, ${check.labelled} labelled with a reason, ${check.productiveJobs} productive job(s))`;
}

export async function stageCapacityReport(args: readonly string[]): Promise<string> {
  if (args.includes('--measure')) await recordStageCapacity();
  const recorded = await readStageCapacity();
  return args.includes('--json')
    ? JSON.stringify(recorded, null, 2)
    : [...stageCapacityLines(recorded), contractLine(recorded)].join('\n');
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
