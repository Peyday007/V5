/**
 * Brain's capability benchmarks (docs/evolution/DESIGN.md, workstream B).
 *
 *   npm run bench -- --suite <name> [--cases file.json] [--out result.json] [--ref label]
 *                    [--worlds N] [--runs N] [--quiet]
 *
 * Runs one suite offline — no database, no network — and deterministically
 * (seeded engines, fixed worlds, a fixed clock). Prints a summary and writes
 * the shared result JSON `{ suite, sha, ref, cases, metrics, ranAt }` to
 * `--out`, or to stdout when no file is named.
 *
 * `--cases` adds extra cases in the suite's own case format (a JSON array) —
 * the evaluator's hidden cases. They are reported with ids prefixed `hidden:`,
 * and their content is never printed.
 */
import fs from 'node:fs';
import { runBench, SUITES } from '../bench/run.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
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
    console.error(`usage: npm run bench -- --suite <${Object.keys(SUITES).join('|')}> [--cases file.json] [--out result.json] [--ref label] [--worlds N] [--runs N]`);
    process.exit(2);
  }
  const casesFile = arg('--cases');
  let extraCases: unknown[] = [];
  if (casesFile) {
    const parsed: unknown = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--cases must hold a JSON array of cases');
    extraCases = parsed;
  }
  const out = arg('--out');
  const quiet = process.argv.includes('--quiet');
  // With no --out the JSON goes to stdout, so progress goes to stderr.
  const log = quiet ? undefined : (line: string) => (out ? console.log(line) : console.error(line));
  const worlds = positiveInt('--worlds');
  const runs = positiveInt('--runs');
  const ref = arg('--ref');
  const { result, summary } = await runBench(suite, {
    extraCases,
    ...(worlds !== undefined ? { worlds } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(log ? { log } : {}),
  });
  const json = JSON.stringify(result, null, 2);
  const print = out ? console.log : console.error;
  for (const line of summary) print(line);
  print(`metrics ${JSON.stringify(result.metrics)}`);
  if (out) {
    fs.writeFileSync(out, `${json}\n`);
    console.log(`wrote ${out} (${result.suite} @ ${result.sha.slice(0, 12)}, ref ${result.ref})`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(`bench: ${String((error as Error)?.stack ?? error)}`);
  process.exit(1);
});
