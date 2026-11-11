/**
 * One read-only pass over the expansion businesses' campaigns
 * (server/services/cash/expansionOutreach.ts).
 *
 *   node --import tsx scripts/expansion-outreach.ts
 *
 * Prints `EXPANSION: OK` when every campaign runs with healthy bounces and no
 * reply waits, `EXPANSION: ATTENTION` otherwise.
 */
import { runExpansionOutreach } from '../server/services/cash/expansionOutreach.ts';

const result = await runExpansionOutreach();
for (const line of result.lines) console.log(`  ${line}`);
console.log(result.ok ? 'EXPANSION: OK' : 'EXPANSION: ATTENTION');
