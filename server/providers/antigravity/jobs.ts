/**
 * Where a research job keeps its working files, and what it leaves behind.
 *
 * Each job gets its own directory under Brain's existing data root, named for
 * the run it belongs to. Two reasons it is per-job rather than shared: a
 * concurrent job can never read or clobber another's prompt, and clearing up
 * after a failure is a single directory removal rather than a guess about which
 * files belonged to whom.
 *
 * The execution log is written here too. It is the reproducibility record the
 * spec asks for — the exact prompt, which tool ran it, how long it took, what it
 * exited with — and it stays on disk beside the job rather than in the browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_ROOT } from '../../env.ts';
import type { JobResult } from './process.ts';

export const JOBS_ROOT = path.join(DATA_ROOT, 'research-jobs');

/** The record kept for every attempt, successful or not. */
export interface ExecutionLog {
  runId: string;
  jobId: string;
  provider: string;
  providerVersion: string | null;
  model: string | null;
  /** Digest of the exact prompt, so a report can be tied to what produced it. */
  promptSha256: string;
  promptBytes: number;
  promptDelivery: string;
  /** The tool and its arguments — never the prompt, which is not an argument. */
  command: string;
  args: string[];
  outcome: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
  startedAt: string;
  completedAt: string;
}

export interface ResearchJob {
  jobId: string;
  directory: string;
}

/** Create the directory this job owns. */
export function createJob(runId: string): ResearchJob {
  const jobId = `${runId}-${Date.now().toString(36)}`;
  const directory = path.join(JOBS_ROOT, jobId);
  fs.mkdirSync(directory, { recursive: true });
  return { jobId, directory };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Write the execution log, plus the raw streams.
 *
 * Raw output is kept on disk deliberately: when a run fails, "what did the tool
 * actually say" is the first question, and an answer that only exists in a
 * console nobody was watching is no answer at all.
 */
export function writeExecutionLog(job: ResearchJob, log: ExecutionLog, result: JobResult): void {
  fs.writeFileSync(path.join(job.directory, 'execution.json'), JSON.stringify(log, null, 2), 'utf8');
  if (result.stdout.length > 0) {
    fs.writeFileSync(path.join(job.directory, 'stdout.txt'), result.stdout, 'utf8');
  }
  if (result.stderr.length > 0) {
    fs.writeFileSync(path.join(job.directory, 'stderr.txt'), result.stderr, 'utf8');
  }
}

/** Read a job's execution log back, for the run detail view. */
export function readExecutionLog(jobId: string): ExecutionLog | null {
  const file = path.join(JOBS_ROOT, jobId, 'execution.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionLog;
  } catch {
    return null;
  }
}
