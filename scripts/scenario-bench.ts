/**
 * Measure the scenario engine on this machine.
 *
 *   npm run scenario:bench [-- --runs 5 --evaluations 50000]
 *
 * Runs the demonstration model several times at the given size and prints the
 * wall-clock time of each run, the median, the heap growth and the result's
 * size. It reads and writes no rows. The numbers are a reading of one machine
 * at one moment, not a claim about any other.
 */
import { performance } from 'node:perf_hooks';
import { resultDigest, runScenarioModel } from '../server/services/scenario/run.ts';
import { DEMONSTRATION_SEED, demonstrationModel } from '../server/services/scenario/demo.ts';

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(process.argv[at + 1]) : fallback;
  return Number.isFinite(value) ? value : fallback;
}

const runs = arg('runs', 5);
const evaluations = arg('evaluations', 50_000);
const timings: number[] = [];
let digest = '';
const heapBefore = process.memoryUsage().heapUsed;
let bytes = 0;
for (let i = 0; i < runs; i++) {
  const start = performance.now();
  const result = runScenarioModel(demonstrationModel(), { seed: DEMONSTRATION_SEED, evaluations });
  timings.push(performance.now() - start);
  const d = resultDigest(result);
  if (digest && d !== digest) throw new Error('A repeated run produced a different digest.');
  digest = d;
  bytes = JSON.stringify(result).length;
}
const sorted = [...timings].sort((a, b) => a - b);
console.log(`node ${process.version}, ${process.platform}/${process.arch}`);
console.log(`evaluations per run: ${evaluations}`);
console.log(`runs (ms): ${timings.map((t) => t.toFixed(0)).join(', ')}`);
console.log(`median: ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, min ${sorted[0]!.toFixed(0)} ms, max ${sorted[sorted.length - 1]!.toFixed(0)} ms`);
console.log(`heap growth across runs: ${((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(1)} MiB; peak RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`);
console.log(`result JSON: ${(bytes / 1024).toFixed(0)} KiB; digest ${digest.slice(0, 16)} (identical on every run)`);
