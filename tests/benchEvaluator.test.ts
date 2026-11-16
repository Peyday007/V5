/**
 * The evaluator workflow's trusted helper: it finds the JSON in an ssh
 * transcript and turns Brain's pending experiments into runs, refusing any
 * identifier outside a narrow alphabet before it can reach a shell.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'bench/evaluator.mjs');

function transcript(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-eval-')), 'out.txt');
  fs.writeFileSync(file, `Connecting to fdaa:0:1::2... complete\n${body}\n`);
  return file;
}

describe('bench/evaluator.mjs', () => {
  it('extracts the JSON a command printed between flyctl lines', () => {
    const file = transcript('[{"id":"c1","class":"UNFUNDED_DEAL"}]\nError: ssh shell: wait: remote command exited without exit status or exit signal');
    expect(JSON.parse(execFileSync('node', [HELPER, 'extract', file], { encoding: 'utf8' }))).toEqual([{ id: 'c1', class: 'UNFUNDED_DEAL' }]);
  });

  it('plans a baseline and each variant, by pull request, branch or commit', () => {
    const pending = [
      { id: 'exp_1', suite: 'feasibility', baselineSha: 'a'.repeat(40), variants: [{ id: 'v1', label: 'tighten-gate', prNumber: 12, headRef: null, headSha: null }, { id: 'v2', label: 'x y', prNumber: null, headRef: 'evo/v2', headSha: null }] },
      { id: 'exp_2', suite: 'planSpeed', baselineSha: 'b'.repeat(40), variants: [] },
    ];
    const rows = execFileSync('node', [HELPER, 'plan', transcript(JSON.stringify(pending))], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('\t'));
    expect(rows).toEqual([
      ['exp_1', 'feasibility', 'baseline', '-', 'baseline', '-', '-', 'a'.repeat(40)],
      ['exp_1', 'feasibility', 'variant', 'v1', 'tighten-gate', '12', '-', '-'],
      // A label outside the alphabet falls back to the variant id.
      ['exp_1', 'feasibility', 'variant', 'v2', 'v2', '-', 'evo/v2', '-'],
      ['exp_2', 'planSpeed', 'baseline', '-', 'baseline', '-', '-', 'b'.repeat(40)],
    ]);
    const only = execFileSync('node', [HELPER, 'plan', transcript(JSON.stringify(pending)), 'exp_2'], { encoding: 'utf8' }).trim().split('\n');
    expect(only).toHaveLength(1);
  });

  it('refuses an identifier that could reach a shell as anything but itself', () => {
    const bad = [{ id: "exp'; rm -rf /", suite: 'feasibility', baselineSha: 'a'.repeat(40), variants: [] }];
    const run = spawnSync('node', [HELPER, 'plan', transcript(JSON.stringify(bad))], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/refused experiment id/);
  });
});
