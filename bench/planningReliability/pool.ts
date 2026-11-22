/**
 * A bounded pool of case processes for planningReliability.
 *
 * Nearly all of a run is the planner itself (`readGoalPlan`, ~10–30 s a case, one
 * core), so the cases are spread over child processes instead of read one after
 * another. Isolation is unchanged: the parent migrates the one template database
 * once (`buildTemplate`), and every case — in whichever worker — opens its own copy
 * of it (`runWorld`), with the process memos cleared before it, exactly as the
 * serial runner does. Workers take the next case when they finish one, and rows are
 * returned in the cases' own order, so the result does not depend on scheduling.
 *
 * Hidden cases travel to a worker over the IPC channel only; nothing here prints one.
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { caseId, type CaseJob, type PlanningRow } from './index.ts';
import type { Template } from './world.ts';

/** A worker's measured peak (≈1.5 GB resident on a full run), rounded up. */
export const WORKER_BYTES = 2 * 1024 ** 3;
/** Each worker's own heap ceiling: an over-budget case fails as that case, not as the machine. */
export const WORKER_HEAP_MB = 3072;

/** Memory the machine can still give, from the kernel's own estimate (MemAvailable), else free memory. */
function availableBytes(): number {
  try {
    const line = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (line) return Number(line[1]) * 1024;
  } catch {
    // not Linux
  }
  return os.freemem();
}

/**
 * The default pool size: one core left for everything else, and no more workers than
 * half of the memory still available can hold (the machine is shared). At least one.
 * `BRAIN_BENCH_WORKERS` overrides it.
 */
export function defaultWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const forced = Number(env['BRAIN_BENCH_WORKERS']);
  if (Number.isInteger(forced) && forced > 0) return forced;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const byMemory = Math.floor((availableBytes() * 0.5) / WORKER_BYTES);
  return Math.max(1, Math.min(cores - 1, byMemory));
}

export type ToWorker = { type: 'init'; template: Template; dir: string } | { type: 'job'; job: CaseJob } | { type: 'stop' };
export type FromWorker = { type: 'ready' } | { type: 'row'; index: number; row: PlanningRow };

export interface PoolOptions {
  template: Template;
  dir: string;
  workers: number;
  onRow?: (row: PlanningRow) => void;
}

const WORKER = new URL('./worker.ts', import.meta.url).pathname;

/**
 * The TypeScript loader a worker needs: this process's own when it was started by tsx
 * (`npm run bench`), else tsx registered explicitly (a test runner's process has its own).
 */
function loaderArgs(): string[] {
  if (process.execArgv.some((a) => a.includes('/tsx/'))) return [...process.execArgv];
  return ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href];
}

export async function runPool(jobs: CaseJob[], options: PoolOptions): Promise<PlanningRow[]> {
  const queue = [...jobs];
  const rows = new Map<number, PlanningRow>();
  let live = 0;
  // A worker that dies takes its case with it, as that case's error; a replacement takes the rest.
  let respawns = Math.max(2, options.workers);

  await new Promise<void>((resolve) => {
    const settle = () => {
      if (live === 0) resolve();
    };
    const start = () => {
      live += 1;
      const child: ChildProcess = fork(WORKER, [], {
        execArgv: [...loaderArgs(), `--max-old-space-size=${WORKER_HEAP_MB}`],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let current: CaseJob | null = null;
      const next = () => {
        current = queue.shift() ?? null;
        child.send((current ? { type: 'job', job: current } : { type: 'stop' }) satisfies ToWorker);
      };
      child.on('message', (raw: FromWorker) => {
        if (raw.type === 'ready') return next();
        if (raw.type === 'row') {
          rows.set(raw.index, raw.row);
          options.onRow?.(raw.row);
          next();
        }
      });
      child.on('exit', (code, signal) => {
        live -= 1;
        if (current && !rows.has(current.index)) {
          const row = errorRow(current, `error: the case's worker exited (${signal ?? `code ${code}`})`);
          rows.set(current.index, row);
          options.onRow?.(row);
        }
        if (queue.length && respawns > 0) {
          respawns -= 1;
          start();
        }
        settle();
      });
      child.send({ type: 'init', template: options.template, dir: options.dir } satisfies ToWorker);
    };
    for (let i = 0; i < Math.min(options.workers, queue.length); i++) start();
    settle();
  });
  // Anything a worker never reached (every respawn spent) is an error row, not a silent omission.
  for (const job of queue) rows.set(job.index, errorRow(job, 'error: no worker was left to run the case'));
  return jobs.map((j) => rows.get(j.index)!);
}

function errorRow(job: CaseJob, detail: string): PlanningRow {
  return { id: caseId(job), hidden: job.hidden, heldOut: job.hidden, expect: null, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail };
}
