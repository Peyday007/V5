/**
 * The fast intelligence-development loop: a reasoning change gets an actionable
 * verdict in minutes, without a deploy.
 *
 *   npm run loop [-- --base <ref>] [--cases held-out.json]... [--workers N] [--skip typecheck,impacted,bench]
 *   npm run loop -- --merge branchA,branchB,...   (integration mode)
 *
 * Runs, concurrently where memory and cores allow (a wide impacted selection follows the
 * bench, whose verdict line is printed as soon as it is known):
 *   typecheck   `tsc --noEmit`
 *   impacted    `scripts/test-impacted.mjs --base <base>`: the tests the change reaches
 *   bench       planningReliability on this tree (public cases plus any `--cases`),
 *               diffed case by case against the base's result (`bench/diff.ts`)
 * and prints one verdict block — PASS, or REJECT with every reason — with each stage's
 * elapsed time. Exit 0 on PASS, 1 on REJECT, 2 when the loop itself could not run.
 *
 * The base defaults to origin/<canonical branch> (fetched first). Its bench result is
 * cached per base SHA, runner and held-out case set, in the repository's common git
 * directory (`<git-common-dir>/brain-loop/`, shared by every worktree and never
 * committed; `BRAIN_LOOP_CACHE` overrides it). When missing it is computed once, on a
 * clean worktree of the base.
 *
 * `--merge a,b,…` makes a temporary worktree at the base, merges the listed origin
 * branches in order, and stops at the first conflict, naming each conflicted file and
 * the branch pair. Otherwise it runs the same loop on the combination, attributes each
 * regressed case to the first branch whose merge produced it (re-running only those
 * cases on each prefix), and removes its worktrees.
 *
 * A tree that predates the parallel runner (no `bench/planningReliability/pool.ts`) is
 * given this checkout's runner files — the pool, the result shape and the CLI; never
 * the cases, the grader or the world — so both sides are measured by the same runner.
 *
 * This is level A (developmental) feedback, and it says so: the evaluator's hidden
 * cases and production remain the verification.
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffResults, formatDiff, LEVEL_A, type BenchDiff } from '../bench/diff.ts';
import type { BenchResult } from '../bench/types.ts';

const SUITE = 'planningReliability';
/** The runner's mechanics, never its judgement: what a pre-loop tree is given so both sides are measured alike. */
export const RUNNER_FILES = [
  'bench/run.ts',
  'bench/types.ts',
  'bench/diff.ts',
  'bench/planningReliability/index.ts',
  'bench/planningReliability/pool.ts',
  'bench/planningReliability/worker.ts',
  'scripts/bench.ts',
];
const GB = 1024 ** 3;
/** Measured peaks: tsc ≈2.9 GB resident; the impacted vitest run of a planner change ≈3 GB across its forks. */
const TYPECHECK_BYTES = 3.5 * GB;
const IMPACTED_BYTES = 3 * GB;
/** An impacted selection up to this many test files runs beside the bench; a wider one after it. */
const NARROW_IMPACTED = 12;

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function args(flag: string): string[] {
  return process.argv.flatMap((a, i) => (a === flag && process.argv[i + 1] !== undefined ? [process.argv[i + 1]!] : []));
}
function git(cwd: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(cwd: string, ...a: string[]): string | null {
  try {
    return git(cwd, ...a);
  } catch {
    return null;
  }
}
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function availableBytes(): number {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch {
    // not Linux
  }
  return os.freemem();
}

/** The node_modules this checkout resolves (a worktree inside the main checkout shares its parent's). */
function nodeModules(): string {
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(path.join(candidate, '.bin', 'tsx'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error('no node_modules with tsx above this checkout; run npm ci');
  }
}

interface StageResult {
  name: string;
  ok: boolean;
  ms: number;
  note: string;
  log: string;
}

/** Run a command to completion, its output to a log file; never inherits the terminal. */
function run(name: string, cmd: string, argv: string[], cwd: string, logDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; ms: number; log: string }> {
  const log = path.join(logDir, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
    child.on('exit', (code, signal) => {
      fs.closeSync(fd);
      resolve({ code: code ?? (signal ? 128 : 1), ms: performance.now() - started, log });
    });
    child.on('error', (e) => {
      fs.appendFileSync(log, `\n${String(e)}\n`);
    });
  });
}

function tail(file: string, n: number): string[] {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n);
  } catch {
    return [];
  }
}

/** A detached worktree of `ref` with this checkout's node_modules; removed by the caller. */
function makeWorktree(ref: string, label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `brain-loop-${label}-`));
  fs.rmSync(dir, { recursive: true, force: true });
  git(ROOT, 'worktree', 'add', '--detach', '--quiet', dir, ref);
  fs.symlinkSync(nodeModules(), path.join(dir, 'node_modules'));
  return dir;
}
function removeWorktree(dir: string): void {
  tryGit(ROOT, 'worktree', 'remove', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  tryGit(ROOT, 'worktree', 'prune');
}

/** Give a tree that predates the parallel runner this checkout's runner. Returns whether it did. */
function overlayRunner(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'bench/planningReliability/pool.ts'))) return false;
  for (const f of RUNNER_FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return true;
}

function cacheDir(): string {
  const common = path.resolve(ROOT, git(ROOT, 'rev-parse', '--git-common-dir'));
  const dir = process.env['BRAIN_LOOP_CACHE'] ?? path.join(common, 'brain-loop', 'baselines');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The cache key: the base SHA, this runner's files and the held-out case files' contents. */
function baselineKey(sha: string, caseFiles: string[]): string {
  const h = crypto.createHash('sha256');
  for (const f of RUNNER_FILES) h.update(fs.readFileSync(path.join(ROOT, f)));
  for (const f of caseFiles) h.update(fs.readFileSync(f));
  return `${SUITE}-${sha}-${h.digest('hex').slice(0, 12)}.json`;
}

function benchArgs(out: string, caseFiles: string[], workers: number | undefined, only?: string[]): string[] {
  return [
    'scripts/bench.ts', '--suite', SUITE, '--out', out,
    ...caseFiles.flatMap((f) => ['--cases', path.resolve(f)]),
    ...(workers ? ['--workers', String(workers)] : []),
    ...(only?.length ? ['--only', only.join(',')] : []),
  ];
}

/** Bench a tree. The tree's own runner when it has one, else this checkout's (overlaid). */
async function benchTree(name: string, dir: string, caseFiles: string[], logDir: string, workers?: number, only?: string[]): Promise<{ result: BenchResult | null; ms: number; log: string }> {
  const out = path.join(logDir, `${name}.json`);
  const tsx = path.join(nodeModules(), '.bin', 'tsx');
  const r = await run(name, tsx, benchArgs(out, caseFiles, workers, only), dir, logDir);
  const result = r.code === 0 && fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')) as BenchResult) : null;
  return { result, ms: r.ms, log: r.log };
}

/** The base's result: from the cache, or computed once on a clean worktree of the base. */
async function baseline(sha: string, caseFiles: string[], logDir: string, workers?: number): Promise<{ result: BenchResult | null; ms: number; cached: boolean; log: string }> {
  const file = path.join(cacheDir(), baselineKey(sha, caseFiles));
  if (fs.existsSync(file)) return { result: JSON.parse(fs.readFileSync(file, 'utf8')) as BenchResult, ms: 0, cached: true, log: file };
  const wt = makeWorktree(sha, 'base');
  try {
    overlayRunner(wt);
    const r = await benchTree('baseline', wt, caseFiles, logDir, workers);
    if (r.result) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(r.result, null, 2)}\n`);
      fs.renameSync(tmp, file);
    }
    return { ...r, cached: false };
  } finally {
    removeWorktree(wt);
  }
}

interface LoopReport {
  verdict: 'PASS' | 'REJECT';
  stages: StageResult[];
  reasons: string[];
  diff: BenchDiff | null;
  totalMs: number;
}

/**
 * The loop over one tree: typecheck, impacted tests, and the bench diff against the base.
 * Typecheck and the bench start at once when the memory the machine still has holds both
 * (else the bench follows); a narrow impacted selection runs beside them and a wide one
 * after the bench, whose verdict is printed the moment it is known.
 */
async function loopOn(dir: string, baseSha: string, caseFiles: string[], logDir: string, opts: { workers?: number; skip: Set<string> }): Promise<LoopReport> {
  const started = performance.now();
  const stages: StageResult[] = [];
  const reasons: string[] = [];
  const npmBin = path.join(nodeModules(), '.bin');
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const { WORKER_BYTES } = await import('../bench/planningReliability/pool.ts');

  const typecheck = opts.skip.has('typecheck')
    ? null
    : () =>
        run('typecheck', path.join(npmBin, 'tsc'), ['--noEmit'], dir, logDir).then((r) => {
          stages.push({ name: 'typecheck', ok: r.code === 0, ms: r.ms, note: r.code === 0 ? '' : tail(r.log, 8).join('\n'), log: r.log });
        });
  let impactedCount: number | null = null;
  if (!opts.skip.has('impacted')) {
    const listed = await run('impacted-list', process.execPath, ['scripts/test-impacted.mjs', '--base', baseSha, '--list'], dir, logDir);
    impactedCount = tail(listed.log, 10_000).filter((l) => l.startsWith('tests/')).length;
  }
  const impacted = opts.skip.has('impacted')
    ? null
    : () => run('impacted', process.execPath, ['scripts/test-impacted.mjs', '--base', baseSha], dir, logDir).then((r) => {
        const head = tail(r.log, 400).find((l) => l.startsWith('  tests covering them directly')) ?? '';
        const summary = tail(r.log, 400).filter((l) => /^\s*(Test Files|Tests)\s/.test(l)).join(' · ');
        stages.push({ name: 'impacted', ok: r.code === 0, ms: r.ms, note: `${head.trim()}${summary ? ` · ${summary.trim()}` : ''}${r.code === 0 ? '' : `\n${tail(r.log, 12).join('\n')}`}`, log: r.log });
      });

  let diff: BenchDiff | null = null;
  const bench = async () => {
    if (opts.skip.has('bench')) return;
    const base = await baseline(baseSha, caseFiles, logDir, opts.workers);
    stages.push({ name: 'baseline', ok: !!base.result, ms: base.ms, note: base.cached ? `cached ${path.basename(base.log)}` : `computed on a clean worktree of ${baseSha.slice(0, 12)}`, log: base.log });
    if (!base.result) {
      reasons.push(`the base's bench did not complete (log ${base.log})`);
      return;
    }
    const cand = await benchTree('bench', dir, caseFiles, logDir, opts.workers);
    if (!cand.result) {
      stages.push({ name: 'bench', ok: false, ms: cand.ms, note: tail(cand.log, 10).join('\n'), log: cand.log });
      reasons.push(`the bench did not complete (log ${cand.log})`);
      return;
    }
    const { CRITICAL } = await import('../bench/planningReliability/grade.ts');
    const d = diffResults(base.result, cand.result, CRITICAL);
    const a = cand.result.metrics;
    stages.push({
      name: 'bench',
      ok: d.verdict === 'PASS',
      ms: cand.ms,
      note: `${a['passed']}/${a['cases']} correct, critical ${a['criticalFailures']} (base ${base.result.metrics['passed']}/${base.result.metrics['cases']}, critical ${base.result.metrics['criticalFailures']}) · ${cand.result.timing?.['workers'] ?? '?'} workers`,
      log: cand.log,
    });
    diff = d;
    reasons.push(...d.reasons);
  };

  // A wide impacted selection (a planner change reaches ~100 planner-heavy test files) beside
  // the bench's workers oversubscribes the cores and its tests time out (measured on #1214:
  // 11 timeouts, no assertion failure), so it runs after the bench; a narrow one runs beside.
  const wideImpacted = impactedCount !== null && impactedCount > NARROW_IMPACTED;
  const room = availableBytes() - (typecheck ? TYPECHECK_BYTES : 0) - (impacted && !wideImpacted ? IMPACTED_BYTES : 0);
  const concurrentWorkers = Math.min(cores - 1, Math.floor((room * 0.8) / WORKER_BYTES));
  const benchThenReport = async () => {
    await bench();
    const b = stages.find((s) => s.name === 'bench');
    if (b) console.log(`loop: bench ${b.ok ? 'PASS' : 'REJECT'} after ${secs(performance.now() - started)} — ${b.note}${wideImpacted && impacted ? ' (impacted tests follow)' : ''}`);
  };
  if (opts.workers || concurrentWorkers >= 2) {
    if (!opts.workers) opts = { ...opts, workers: concurrentWorkers };
    await Promise.all([typecheck?.(), wideImpacted ? null : impacted?.(), benchThenReport()]);
    if (wideImpacted) await impacted?.();
  } else {
    // Not enough memory for the bench beside the others: they first, then it.
    await Promise.all([typecheck?.(), impacted?.()]);
    await benchThenReport();
  }
  for (const s of stages) if (!s.ok && (s.name === 'typecheck' || s.name === 'impacted')) reasons.unshift(`${s.name} failed (log ${s.log})`);
  const order = ['typecheck', 'impacted', 'baseline', 'bench'];
  stages.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
  return { verdict: reasons.length ? 'REJECT' : 'PASS', stages, reasons, diff, totalMs: performance.now() - started };
}

function printReport(r: LoopReport, header: string): void {
  console.log('');
  console.log(`== LOOP ${r.verdict} == ${header}`);
  for (const s of r.stages) {
    console.log(`  ${s.name.padEnd(10)} ${(s.ok ? 'ok' : 'FAIL').padEnd(5)} ${secs(s.ms).padStart(8)}  ${s.note.split('\n')[0] ?? ''}`);
    if (!s.ok) for (const l of s.note.split('\n').slice(1)) console.log(`      ${l}`);
  }
  if (r.diff) for (const l of formatDiff(r.diff, { showUnchanged: false })) console.log(l);
  if (r.reasons.length) {
    console.log('  REJECT because:');
    for (const reason of r.reasons) console.log(`    - ${reason}`);
  }
  console.log(`  total ${secs(r.totalMs)}`);
  console.log(`  ${LEVEL_A}`);
}

/** Merge `branches` (origin/<b>) onto the worktree in order; the first conflict names its files and pair. */
function mergeAll(dir: string, baseSha: string, branches: string[]): { ok: true } | { ok: false; lines: string[] } {
  const merged: string[] = [];
  for (const b of branches) {
    const ref = `origin/${b}`;
    try {
      git(dir, '-c', 'user.name=brain-loop', '-c', 'user.email=brain-loop@localhost', 'merge', '--no-ff', '--no-edit', '--quiet', ref);
      merged.push(b);
    } catch {
      const files = (tryGit(dir, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
      tryGit(dir, 'merge', '--abort');
      const lines = [`conflict merging ${b} after ${merged.length ? merged.join(', ') : 'nothing (onto the base alone)'}:`];
      for (const f of files.length ? files : ['(no file named; the merge refused before writing)']) {
        // Which earlier branch also changed this file — or the base itself, when none did.
        const with_ = merged.filter((m) => (tryGit(dir, 'diff', '--name-only', `${baseSha}...origin/${m}`) ?? '').split('\n').includes(f));
        lines.push(`  ${f}: ${with_.length ? with_.map((m) => `${m} × ${b}`).join(', ') : `base ${baseSha.slice(0, 12)} × ${b}`}`);
      }
      return { ok: false, lines };
    }
  }
  return { ok: true };
}

async function main(): Promise<number> {
  const canonical = fs.readFileSync(path.join(ROOT, '.github/CANONICAL_BRANCH'), 'utf8').trim();
  const baseRef = arg('--base') ?? `origin/${canonical}`;
  const merge = arg('--merge')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const caseFiles = args('--cases').map((f) => path.resolve(f));
  const workers = arg('--workers') ? Number(arg('--workers')) : undefined;
  const skip = new Set((arg('--skip') ?? '').split(',').filter(Boolean));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-loop-run-'));
  // test-impacted runs vitest from <checkout>/node_modules; a worktree nested in the main checkout resolves its parent's.
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(nodeModules(), path.join(ROOT, 'node_modules'));
  if (!arg('--base') || merge) tryGit(ROOT, 'fetch', '--quiet', 'origin', canonical, ...(merge ?? []));
  const baseSha = tryGit(ROOT, 'rev-parse', '--verify', `${baseRef}^{commit}`);
  if (!baseSha) {
    console.error(`loop: cannot resolve the base ${baseRef}`);
    return 2;
  }
  console.log(`loop: base ${baseRef} = ${baseSha.slice(0, 12)} · logs ${logDir}`);

  if (!merge) {
    const head = tryGit(ROOT, 'rev-parse', 'HEAD') ?? 'unknown';
    const dirty = (tryGit(ROOT, 'status', '--porcelain', '--untracked-files=no') ?? '') !== '';
    const r = await loopOn(ROOT, baseSha, caseFiles, logDir, { ...(workers ? { workers } : {}), skip });
    printReport(r, `${path.basename(ROOT)} @ ${head.slice(0, 12)}${dirty ? ' (+ uncommitted changes)' : ''} vs ${baseRef} ${baseSha.slice(0, 12)}`);
    return r.verdict === 'PASS' ? 0 : 1;
  }

  // Integration mode.
  const started = performance.now();
  for (const b of merge) {
    if (!tryGit(ROOT, 'rev-parse', '--verify', `origin/${b}^{commit}`)) {
      console.error(`loop: origin/${b} does not exist`);
      return 2;
    }
  }
  const wt = makeWorktree(baseSha, 'merge');
  try {
    const m = mergeAll(wt, baseSha, merge);
    if (!m.ok) {
      console.log('');
      console.log(`== LOOP REJECT == merge of ${merge.join(' + ')} onto ${baseRef} ${baseSha.slice(0, 12)}`);
      for (const l of m.lines) console.log(`  ${l}`);
      console.log(`  total ${secs(performance.now() - started)}`);
      console.log(`  ${LEVEL_A}`);
      return 1;
    }
    const mergedHead = git(wt, 'rev-parse', 'HEAD');
    overlayRunner(wt);
    const r = await loopOn(wt, baseSha, caseFiles, logDir, { ...(workers ? { workers } : {}), skip });
    // Attribution: re-run only the regressed cases on each prefix of the merge order.
    const bad = r.diff ? r.diff.cases.filter((c) => c.change === 'REGRESSED' || c.newCritical.length).map((c) => c.id) : [];
    const blame = new Map<string, string>();
    if (bad.length && merge.length === 1) for (const id of bad) blame.set(id, merge[0]!);
    if (bad.length && merge.length > 1 && r.diff) {
      const base = await baseline(baseSha, caseFiles, logDir, workers);
      const pw = makeWorktree(baseSha, 'prefix');
      try {
        for (const [k, b] of merge.slice(0, -1).entries()) {
          // Drop the previous prefix's overlaid runner before merging the next branch onto it.
          tryGit(pw, 'reset', '--hard', '--quiet');
          tryGit(pw, 'clean', '-fdq');
          const pm = mergeAll(pw, baseSha, [b]);
          if (!pm.ok) break;
          overlayRunner(pw);
          const pending = bad.filter((id) => !blame.has(id));
          if (!pending.length) break;
          const pr = await benchTree(`prefix-${k + 1}`, pw, caseFiles, logDir, workers, pending);
          if (!pr.result || !base.result) break;
          const { CRITICAL } = await import('../bench/planningReliability/grade.ts');
          const only = { ...base.result, cases: base.result.cases.filter((c) => pending.includes(c.id)) };
          for (const c of diffResults(only, pr.result, CRITICAL).cases) if (c.change === 'REGRESSED' || c.newCritical.length) blame.set(c.id, b);
        }
        for (const id of bad) if (!blame.has(id)) blame.set(id, merge[merge.length - 1]!);
      } finally {
        removeWorktree(pw);
      }
    }
    r.totalMs = performance.now() - started;
    printReport(r, `merge ${merge.join(' + ')} onto ${baseRef} ${baseSha.slice(0, 12)} = ${mergedHead.slice(0, 12)}`);
    if (blame.size) {
      console.log('  regressions by branch (the first merge in order whose prefix produced it):');
      for (const [id, b] of blame) console.log(`    ${id}: ${b}`);
    }
    return r.verdict === 'PASS' ? 0 : 1;
  } finally {
    removeWorktree(wt);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`loop: ${String((error as Error)?.stack ?? error)}`);
    process.exit(2);
  },
);
