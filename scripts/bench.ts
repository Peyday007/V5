/**
 * Brain's capability benchmarks (docs/evolution/DESIGN.md, workstream B).
 *
 *   npm run bench -- --suite <name> [--cases file.json] [--out result.json] [--ref label]
 *                    [--worlds N] [--runs N] [--workers N] [--only id,id] [--shard i/N] [--baseline prior.json] [--quiet]
 *
 * Runs one suite offline — no database, no network — and deterministically
 * (seeded engines, fixed worlds, a fixed clock). Prints a summary and writes
 * the shared result JSON `{ suite, sha, ref, cases, metrics, ranAt }` to
 * `--out`, or to stdout when no file is named.
 *
 * `--cases` adds extra cases in the suite's own case format (a JSON array) —
 * the evaluator's hidden cases. They are reported with ids prefixed `hidden:`,
 * and their content is never printed. It may be given more than once.
 *
 * `--workers N` runs a suite that can (planningReliability) on N case processes;
 * the default is `defaultWorkers()` (cores − 1, bounded by available memory), and
 * `--workers 1` is the serial run. `--only` narrows the run to the listed case ids.
 *
 * `--shard i/N` (planningReliability) runs the i-th of N deterministic shares of the
 * selection — position modulo N — so N CI runners partition the public cases exactly
 * (`.github/workflows/bench.yml`; dispatch it with `.github/workflows/bench-ci.sh`).
 * It refuses `--cases`: hidden cases never go to CI.
 *
 * `--baseline prior.json` compares this run with a prior result case by case
 * (`bench/diff.ts`): IMPROVED, REGRESSED and UNCHANGED, each with its verdict and
 * reason, and exits 1 on any regression or new critical failure.
 */
import fs from 'node:fs';
import { runBench, SUITES } from '../bench/run.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function args(flag: string): string[] {
  return process.argv.flatMap((a, i) => (a === flag && process.argv[i + 1] !== undefined ? [process.argv[i + 1]!] : []));
}

function positiveInt(flag: string): number | undefined {
  const raw = arg(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function main(): Promise<void> {
  const suite = arg('--suite');
  if (!suite || !SUITES[suite]) {
    console.error(
      `usage: npm run bench -- --suite <${Object.keys(SUITES).join('|')}> [--cases file.json] [--out result.json] [--ref label] [--worlds N] [--runs N] [--workers N] [--only id,id] [--shard i/N] [--baseline prior.json]`,
    );
    process.exit(2);
  }
  const extraCases: unknown[] = [];
  for (const casesFile of args('--cases')) {
    const parsed: unknown = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--cases must hold a JSON array of cases');
    extraCases.push(...parsed);
  }
  const shardRaw = arg('--shard');
  let shard: { index: number; of: number } | undefined;
  if (shardRaw !== undefined) {
    if (suite !== 'planningReliability') throw new Error('--shard is for planningReliability, the suite that selects cases');
    // Sharding exists for CI runners, and hidden cases never leave the evaluator.
    if (args('--cases').length) throw new Error('--shard takes public cases only; it refuses --cases');
    const { parseShard } = await import('../bench/planningReliability/index.ts');
    shard = parseShard(shardRaw);
  }
  const baselineFile = arg('--baseline');
  const baseline = baselineFile ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
  const only = arg('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  // A narrowed run is compared with the same cases of the baseline, not reported as having lost the rest.
  if (baseline && only?.length && Array.isArray(baseline.cases)) baseline.cases = baseline.cases.filter((c: { id: string }) => only.includes(c.id));
  const out = arg('--out');
  const quiet = process.argv.includes('--quiet');
  // With no --out the JSON goes to stdout, so progress goes to stderr.
  const log = quiet ? undefined : (line: string) => (out ? console.log(line) : console.error(line));
  const worlds = positiveInt('--worlds');
  const runs = positiveInt('--runs');
  const { defaultWorkers } = await import('../bench/planningReliability/pool.ts');
  const workers = positiveInt('--workers') ?? defaultWorkers();
  const ref = arg('--ref');
  const { result, summary } = await runBench(suite, {
    extraCases,
    workers,
    ...(only?.length ? { only } : {}),
    ...(shard ? { shard } : {}),
    ...(worlds !== undefined ? { worlds } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(log ? { log } : {}),
  });
  const json = JSON.stringify(result, null, 2);
  const print = out ? console.log : console.error;
  for (const line of summary) print(line);
  print(`metrics ${JSON.stringify(result.metrics)}`);
  if (result.timing) print(`timing ${JSON.stringify(result.timing)}`);
  if (out) {
    fs.writeFileSync(out, `${json}\n`);
    console.log(`wrote ${out} (${result.suite} @ ${result.sha.slice(0, 12)}, ref ${result.ref})`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  if (baseline) {
    const { diffResults, formatDiff, LEVEL_A } = await import('../bench/diff.ts');
    const { CRITICAL } = await import('../bench/planningReliability/grade.ts');
    const d = diffResults(baseline, result, suite === 'planningReliability' ? CRITICAL : null);
    for (const line of formatDiff(d)) print(line);
    print(`${d.verdict}${d.reasons.length ? `: ${d.reasons.join('; ')}` : ''}`);
    print(LEVEL_A);
    if (d.verdict === 'REJECT') process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`bench: ${String((error as Error)?.stack ?? error)}`);
  process.exit(1);
});
