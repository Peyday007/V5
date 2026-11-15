#!/usr/bin/env node
/**
 * The evaluator workflow's trusted helper (`.github/workflows/evolution-eval.yml`).
 * Plain JavaScript with no imports from the repository, so it runs from the
 * workflow's own checkout before any variant's code is installed.
 *
 *   node bench/evaluator.mjs extract <file>            → the JSON value in an ssh transcript, on stdout
 *   node bench/evaluator.mjs plan <file> [experiment]  → one TSV line per run to make:
 *        experiment  suite  kind(baseline|variant)  variantId(-)  label  prNumber(-)  headRef(-)  sha(-)
 *
 * `flyctl ssh console` prints its own lines around a command's output, so the
 * value is the first line that opens a JSON array or object, parsed to its end.
 * Every identifier that reaches a shell is held to a narrow alphabet here;
 * anything else is refused, never quoted around.
 */
import fs from 'node:fs';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function extractJson(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trimStart();
    if (!head.startsWith('[') && !head.startsWith('{')) continue;
    const rest = [head, ...lines.slice(i + 1)].join('\n');
    // Parse the longest prefix that is JSON: trailing transcript lines are dropped one by one.
    const tail = rest.split('\n');
    for (let end = tail.length; end > 0; end--) {
      try {
        return JSON.parse(tail.slice(0, end).join('\n'));
      } catch {
        /* shorter */
      }
    }
  }
  throw new Error('no JSON value in the transcript');
}

function field(value, re, what) {
  if (value === null || value === undefined) return '-';
  const s = String(value);
  if (!re.test(s)) throw new Error(`refused ${what}: not in the allowed alphabet`);
  return s;
}

export function planOf(pending, only) {
  if (!Array.isArray(pending)) throw new Error('pending is not a list');
  const rows = [];
  for (const e of pending) {
    const experiment = field(e.id, SAFE, 'experiment id');
    if (only && experiment !== only) continue;
    const suite = field(e.suite, SAFE, 'suite');
    const baseline = field(e.baselineSha, SHA, 'baseline sha');
    rows.push([experiment, suite, 'baseline', '-', 'baseline', '-', '-', baseline]);
    for (const v of e.variants ?? []) {
      const id = field(v.id, SAFE, 'variant id');
      const label = v.label && SAFE.test(String(v.label)) ? String(v.label) : id;
      const pr = v.prNumber === null || v.prNumber === undefined ? '-' : field(v.prNumber, /^[0-9]{1,7}$/, 'pull request number');
      const ref = field(v.headRef, REF, 'head ref');
      const sha = field(v.headSha, SHA, 'head sha');
      if (pr === '-' && ref === '-' && sha === '-') throw new Error(`variant ${id} names no pull request, branch or commit`);
      rows.push([experiment, suite, 'variant', id, label, pr, ref, sha]);
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, file, only] = process.argv.slice(2);
  try {
    const value = extractJson(fs.readFileSync(file, 'utf8'));
    if (command === 'extract') process.stdout.write(`${JSON.stringify(value)}\n`);
    else if (command === 'plan') {
      if (only && !SAFE.test(only)) throw new Error('refused experiment filter: not in the allowed alphabet');
      for (const row of planOf(value, only || null)) process.stdout.write(`${row.join('\t')}\n`);
    } else throw new Error('usage: evaluator.mjs extract|plan <file> [experiment]');
  } catch (error) {
    // The message names what was refused, never the transcript (it may hold hidden cases).
    process.stderr.write(`evaluator: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
