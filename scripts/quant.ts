/**
 * `npm run quant -- <problem.json> [--json]`
 *
 * Reconstruct, combine, optimize and value the questions of one quantitative
 * problem (§79). Reads one file, touches no database, writes nothing, and
 * prints `QUANT: OK` only when the problem solved. An analysis printed here is
 * not a plan: a quantitative recommendation to a person still goes through
 * `npm run plan:check` (§77).
 */
import { readFileSync } from 'node:fs';
import { solveProblem, renderSolution, type QuantProblem } from '../server/services/quant/problem.ts';
import { ReconstructionError } from '../server/services/quant/reconstruct.ts';

const args = process.argv.slice(2);
const file = args.find((one) => !one.startsWith('--'));
if (!file) {
  console.error('usage: npm run quant -- <problem.json> [--json]');
  console.log('QUANT: FAIL');
  process.exit(1);
}
try {
  const problem = JSON.parse(readFileSync(file, 'utf8')) as QuantProblem;
  const solution = solveProblem(problem);
  if (args.includes('--json')) console.log(JSON.stringify(solution, null, 2));
  else console.log(renderSolution(solution, problem.currency));
  console.log('QUANT: OK');
} catch (error) {
  if (error instanceof ReconstructionError || error instanceof SyntaxError) {
    console.error(`QUANT REFUSED ${error.message}`);
    console.log('QUANT: FAIL');
    process.exit(1);
  }
  throw error;
}
