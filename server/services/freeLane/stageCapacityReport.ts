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
 * `recordStageCapacity` the lane's hourly loop calls.
 */
import { pathToFileURL } from 'node:url';
import { closeDatabase, initDatabase } from '../../db/database.ts';
import { readStageCapacity, recordStageCapacity, stageCapacityLines } from './stageCapacity.ts';

export async function stageCapacityReport(args: readonly string[]): Promise<string> {
  if (args.includes('--measure')) await recordStageCapacity();
  const recorded = await readStageCapacity();
  return args.includes('--json') ? JSON.stringify(recorded, null, 2) : stageCapacityLines(recorded).join('\n');
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
