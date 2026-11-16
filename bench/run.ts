/**
 * Runs a suite and assembles the shared result JSON. Offline: the only thing
 * read outside the code under test is the checkout's own commit (`git
 * rev-parse HEAD`), and its absence is stated as "unknown", never guessed.
 */
// First: the process environment a scenario suite's databases need, before any Brain module loads.
import './env.ts';
import { execFileSync } from 'node:child_process';
import { feasibility } from './feasibility/index.ts';
import { mootRequests } from './mootRequests/index.ts';
import { planSpeed } from './planSpeed/index.ts';
import type { BenchResult, Suite, SuiteOptions } from './types.ts';

export const SUITES: Record<string, Suite> = { feasibility, planSpeed, mootRequests };

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export async function runBench(name: string, options: SuiteOptions & { ref?: string } = {}): Promise<{ result: BenchResult; summary: string[] }> {
  const suite = SUITES[name];
  if (!suite) throw new Error(`unknown suite "${name}" (known: ${Object.keys(SUITES).join(', ')})`);
  const outcome = await suite.run(options);
  const sha = git(['rev-parse', 'HEAD']) ?? 'unknown';
  const ref = options.ref ?? git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? sha;
  return {
    result: { suite: suite.name, sha, ref, cases: outcome.cases, metrics: outcome.metrics, ranAt: new Date().toISOString() },
    summary: outcome.summary,
  };
}
