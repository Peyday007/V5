/**
 * `npm run plan:check -- <plan.json> [...]`
 *
 * The one door a quantitative plan goes through before anybody is shown it
 * (`services/scenario/planCheck.ts`). It prints `PLAN: VERIFIED <digest>`,
 * `PLAN: VERIFIED_ANALYSIS <digest>` or `PLAN: REJECTED <digest>` and the
 * reasons; it exits non-zero on a rejection. Only the narrative printed under a
 * VERIFIED line may be presented, and only with that digest: changing a word or
 * a number in it produces a different digest, which has not been checked.
 */
import { readFileSync } from 'node:fs';
import { checkPlan, renderCheck } from '../server/services/scenario/planCheck.ts';

const files = process.argv.slice(2).filter((a) => a !== '--');
if (files.length === 0) {
  console.error('usage: npm run plan:check -- <plan.json> [...]');
  process.exit(2);
}
let rejected = 0;
for (const file of files) {
  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.log(`PLAN: REJECTED (unreadable) ${file}: ${(error as Error).message}`);
    rejected++;
    continue;
  }
  const check = checkPlan(plan);
  console.log(`# ${file}`);
  console.log(renderCheck(check));
  console.log('');
  if (check.verdict === 'REJECTED') rejected++;
}
process.exitCode = rejected > 0 ? 1 : 0;
