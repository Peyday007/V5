/**
 * The CI bench's verdict (`.github/workflows/bench.yml`): merges the shard results of the
 * baseline and of the head, diffs them case by case (`bench/diff.ts`), and prints
 * IMPROVED, REGRESSED and UNCHANGED as GitHub annotations and a job-summary table.
 *
 *   node --experimental-strip-types scripts/bench-verdict.ts --base DIR --head DIR [--summary FILE]
 *
 * The table goes to `--summary`, else to the job summary file when one is set.
 * Each DIR holds one `*.json` bench result per shard. Exits 1 on any regression, any new
 * critical failure or any baseline case that did not run, exactly as `--baseline` does.
 *
 * Level A/B developmental evidence: public cases on a GitHub runner. It never gates or
 * substitutes for Deploy, the evaluator's hidden cases, or production verification.
 * Imports types only beyond the pure diff, so it runs without `npm ci`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { diffResults, mergeResults, type CaseDiff } from '../bench/diff.ts';
import { CRITICAL } from '../bench/planningReliability/grade.ts';
import type { BenchResult } from '../bench/types.ts';

export const CI_LEVEL =
  'Level A/B developmental evidence: public planningReliability cases on GitHub runners. It does not gate or substitute for Deploy, the evaluator\'s hidden cases or production verification.';

function arg(flag: string): string {
  const i = process.argv.indexOf(flag);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (!v) throw new Error(`usage: bench-verdict --base DIR --head DIR (missing ${flag})`);
  return v;
}

function shards(dir: string): BenchResult[] {
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`${dir} holds no shard result`);
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BenchResult);
}

/** An annotation's text on one line: GitHub ends the command at a newline. */
const one = (s: string) => s.replace(/%/g, '%25').replace(/\r?\n/g, ' ').slice(0, 900);

function verdictOf(c: CaseDiff, side: 'before' | 'after'): string {
  const r = c[side];
  return r ? (r.verdict ?? (r.pass ? 'PASS' : 'FAIL')) : '—';
}

function main(): void {
  const base = mergeResults(shards(arg('--base')));
  const head = mergeResults(shards(arg('--head')));
  const d = diffResults(base, head, CRITICAL);
  const by = (k: CaseDiff['change']) => d.cases.filter((c) => c.change === k);
  const improved = by('IMPROVED');
  const regressed = by('REGRESSED');
  const unchanged = by('UNCHANGED');

  for (const c of regressed) console.log(`::error title=REGRESSED ${c.id}::${one(`${verdictOf(c, 'before')} → ${verdictOf(c, 'after')} — ${c.after?.reason ?? ''}`)}`);
  for (const c of d.cases.filter((x) => x.newCritical.length)) console.log(`::error title=NEW CRITICAL ${c.id}::${one(c.newCritical.join(', '))}`);
  for (const c of by('REMOVED')) console.log(`::error title=REMOVED ${c.id}::${one('a baseline case did not run on the head')}`);
  for (const c of improved) console.log(`::notice title=IMPROVED ${c.id}::${one(`${verdictOf(c, 'before')} → ${verdictOf(c, 'after')}`)}`);
  for (const c of by('NEW')) console.log(`::notice title=NEW ${c.id}::${one(verdictOf(c, 'after'))}`);
  console.log(`::notice title=UNCHANGED::${unchanged.length} case(s) unchanged`);

  const pct = (x: number | undefined) => `${((x ?? 0) * 100).toFixed(1)}%`;
  const headline = `planningReliability ${head.sha.slice(0, 12)} vs ${base.sha.slice(0, 12)}: IMPROVED ${improved.length} · REGRESSED ${regressed.length} · UNCHANGED ${unchanged.length} · accuracy ${pct(base.metrics['accuracy'])} → ${pct(head.metrics['accuracy'])} · critical ${base.metrics['criticalFailures']} → ${head.metrics['criticalFailures']}`;
  console.log(headline);
  console.log(`${d.verdict}${d.reasons.length ? `: ${d.reasons.join('; ')}` : ''}`);
  console.log(CI_LEVEL);

  const at = process.argv.indexOf('--summary');
  const summary = at === -1 ? process.env['GITHUB_STEP_SUMMARY'] : process.argv[at + 1];
  if (summary) {
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);
    const rows = d.cases.map((c) => `| ${c.change}${c.newCritical.length ? ' (NEW CRITICAL)' : ''} | \`${c.id}\` | ${cell(verdictOf(c, 'before'))} | ${cell(verdictOf(c, 'after'))} | ${c.change === 'UNCHANGED' ? '' : cell(c.after?.reason ?? c.before?.reason ?? '')} |`);
    fs.appendFileSync(
      summary,
      [
        `## Bench verdict: ${d.verdict === 'PASS' ? 'PASS' : 'REGRESSED'}`,
        '',
        headline,
        '',
        ...(d.reasons.length ? [`**${d.reasons.join('; ')}**`, ''] : []),
        `> ${CI_LEVEL}`,
        '',
        '| change | case | baseline | head | reason |',
        '|---|---|---|---|---|',
        ...rows,
        '',
      ].join('\n'),
    );
  }
  if (d.verdict === 'REJECT') process.exitCode = 1;
}

main();
