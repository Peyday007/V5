/**
 * Brain's experiments from a terminal (§111) — the contract the evaluator workflow
 * (`evolution-eval.yml`) uses over ssh. Results are machine-readable on stdout; every log
 * line Brain prints while opening its database goes to stderr, so stdout is only the answer.
 *
 *   pending [--json]
 *       Experiments to evaluate now (reading each variant's campaign first):
 *       [{ id, suite, baseline_sha, variants: [{ id, label, approach_type, head_sha, branch, pr_number, pr_url }] }]
 *   hidden --suite S [--json]
 *       The suite's hidden cases, from the database only: [<case>, ...]
 *   record --experiment E [--variant V] [--hidden] [--lines N] [--file result.json]
 *   record --baseline [--hidden] [--file result.json]
 *       One result `{ suite, sha, ref, cases:[{id, pass, score, ms}], metrics:{…}, ranAt }`, read from
 *       --file or stdin. Without --variant it is the experiment's baseline; with --baseline and no
 *       experiment it is a standalone production baseline. `hidden: true` in the JSON is the same as
 *       --hidden; `linesChanged` in the JSON is the same as --lines. Prints { ok, resultId } or
 *       { ok: false, reason } (exit 1).
 *   decide --experiment E
 *       Runs the selection once: { ok, verdict, winner, closePullRequests, selection, retired }.
 *       INSUFFICIENT is { ok: false, verdict: "INSUFFICIENT", reason } with exit 0 (record more and
 *       decide again); any other refusal exits 1.
 *   show
 *       Every experiment, its variants and scores, approach-type rankings and the loop's yield.
 */
import { readFile } from 'node:fs/promises';

// Brain's own logs (migrations, pressure) are not the answer: keep stdout for it.
console.log = (...args: unknown[]) => console.error(...args);

const { closeDatabase, initDatabase } = await import('../server/db/database.ts');

const command = process.argv[2] ?? 'show';

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, has('json') ? 0 : 2)}\n`);
}

async function readInput(): Promise<string> {
  const file = flag('file');
  if (file && file !== '-') return readFile(file, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

await initDatabase();
try {
  const evolution = await import('../server/services/evolution/experiments.ts');
  if (command === 'pending') {
    out(await evolution.pendingEvaluations());
  } else if (command === 'hidden') {
    const suite = flag('suite');
    if (!suite) {
      out({ ok: false, reason: 'hidden needs --suite S' });
      process.exitCode = 2;
    } else {
      const { listHiddenCases } = await import('../server/repos/evolution.ts');
      out((await listHiddenCases(suite)).map((c) => c.case));
    }
  } else if (command === 'record') {
    const { parseBenchResult } = await import('../server/domain/evolution.ts');
    let raw: unknown;
    try {
      raw = JSON.parse(await readInput());
    } catch (error) {
      raw = { __invalid: String((error as Error).message ?? error) };
    }
    const parsed = parseBenchResult(raw);
    const experimentId = flag('experiment');
    if (!parsed.ok) {
      out({ ok: false, reason: (raw as { __invalid?: string }).__invalid ? `not JSON: ${(raw as { __invalid: string }).__invalid}` : parsed.reason });
      process.exitCode = 1;
    } else if (!experimentId && !has('baseline')) {
      out({ ok: false, reason: 'record needs --experiment E (optionally --variant V), or --baseline for a standalone production baseline' });
      process.exitCode = 2;
    } else {
      const linesFlag = flag('lines');
      const linesJson = (raw as { linesChanged?: unknown }).linesChanged;
      const result = await evolution.recordResult({
        experimentId,
        variantId: flag('variant'),
        result: parsed.result,
        hidden: has('hidden') || parsed.result.hidden === true,
        linesChanged: linesFlag !== null ? Number(linesFlag) : typeof linesJson === 'number' ? linesJson : null,
      });
      out(result);
      if (!result.ok) process.exitCode = 1;
    }
  } else if (command === 'decide') {
    const experimentId = flag('experiment');
    if (!experimentId) {
      out({ ok: false, reason: 'decide needs --experiment E' });
      process.exitCode = 2;
    } else {
      const result = await evolution.decide(experimentId);
      out(result);
      if (!result.ok && result.verdict !== 'INSUFFICIENT') process.exitCode = 1;
    }
  } else if (command === 'show') {
    out(await evolution.readExperiments({ limit: 50 }));
  } else {
    console.error(
      'usage: evolution pending [--json] | hidden --suite S [--json] | record --experiment E [--variant V] [--hidden] [--lines N] [--file F] | ' +
        'record --baseline [--hidden] [--file F] | decide --experiment E | show',
    );
    process.exitCode = 2;
  }
} finally {
  await closeDatabase();
}
