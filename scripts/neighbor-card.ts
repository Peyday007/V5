/**
 * One pass of The Neighbor Card outreach: sync the Instantly campaign, refill it
 * with newly found published addresses, report delivery (server/services/cash/neighborCard.ts).
 *
 *   node --import tsx scripts/neighbor-card.ts [--no-refill] [--slot N] [--max-sites N]
 *
 * Prints `NEIGHBOR-CARD: OK` when the campaign is active, `NEIGHBOR-CARD: ATTENTION` otherwise.
 *
 * Discovery includes Google Places through V2's signed bridge when the
 * deployment holds its signing key (§103); each search is recorded before it is
 * sent and refused past the registry's daily ceiling. With the agents app
 * connected (§104), sites with no address the plain reader found go to
 * Sellbird, then (shells only) to Browser Use.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { countIntegrationUsage, recordIntegrationEvent } from '../server/repos/integrationEvents.ts';
import { defaultAgents, defaultDeps, runNeighborCard } from '../server/services/cash/neighborCard.ts';
import { signingKey } from '../server/services/integrations/keys.ts';
import { searchPlacesViaV2 } from '../server/services/integrations/v2Bridge.ts';
import { personalDesk } from '../server/services/sales/desk.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};

// One pooler client, like every operator script beside the running app (§39).
process.env.BRAIN_DATABASE_POOL_SIZE ??= '1';

const deps = defaultDeps();
let database = false;
if (signingKey()) {
  try {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      initDatabase(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the database did not open within 60 seconds')), 60_000); }),
    ]).finally(() => clearTimeout(timer));
    database = true;
    const meter = {
      used: () => countIntegrationUsage('google-places', `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
      record: async (detail: string) => {
        await recordIntegrationEvent({ integrationId: 'google-places', kind: 'USAGE', state: 'SENT', detail: `Text Search "${detail}"`, source: 'neighbor-card' });
      },
    };
    deps.places = (query) => searchPlacesViaV2(query, meter);
    // The open-source agents (§104) record every call, so they run only with the database open.
    deps.agents = defaultAgents();
    // Sellbird's desk (§107): research, fit order and a written first email for the best new leads.
    deps.personal = await personalDesk();
  } catch (error) {
    console.log(`  Places not metered this pass, so not used: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const result = await runNeighborCard(deps, { refill: !argv.includes('--no-refill'), slot: flag('--slot'), maxSites: flag('--max-sites') });
for (const line of result.lines) console.log(`  ${line}`);
console.log(result.ok ? 'NEIGHBOR-CARD: OK' : 'NEIGHBOR-CARD: ATTENTION');
if (database) await closeDatabase().catch(() => undefined);
