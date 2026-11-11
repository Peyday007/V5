/**
 * One pass of The Neighbor Card outreach: sync the Instantly campaign, refill it
 * with newly found published addresses, report delivery (server/services/cash/neighborCard.ts).
 *
 *   node --import tsx scripts/neighbor-card.ts [--no-refill] [--slot N] [--max-sites N]
 *
 * Prints `NEIGHBOR-CARD: OK` when the campaign is active, `NEIGHBOR-CARD: ATTENTION` otherwise.
 */
import { runNeighborCard } from '../server/services/cash/neighborCard.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};
const result = await runNeighborCard(undefined, { refill: !argv.includes('--no-refill'), slot: flag('--slot'), maxSites: flag('--max-sites') });
for (const line of result.lines) console.log(`  ${line}`);
console.log(result.ok ? 'NEIGHBOR-CARD: OK' : 'NEIGHBOR-CARD: ATTENTION');
