/**
 * The result contract shared with the experiment core (docs/evolution/DESIGN.md):
 * `{ suite, sha, ref, cases:[{id, pass, score, ms}], metrics:{name: number}, ranAt }`.
 * `scripts/evolution.ts record` reads exactly this on its stdin (and ignores the
 * optional fields below, which are for the developmental loop's diff, `bench/diff.ts`).
 */
export interface CaseResult {
  id: string;
  pass: boolean;
  score: number;
  ms: number;
  /** The case's verdict in one token: the correct outcome when it passed, its failure classes when not, or ERROR. */
  verdict?: string;
  failures?: string[];
  /** A failure that would send Brain executing a wrong plan. */
  critical?: boolean;
  /** The grader's reason. Never present on a hidden case. */
  reason?: string;
}

/** Wall-clock milliseconds of a run's stages, and the worker count it ran on. */
export type BenchTiming = Record<string, number>;

export interface BenchResult {
  suite: string;
  sha: string;
  ref: string;
  cases: CaseResult[];
  metrics: Record<string, number>;
  ranAt: string;
  timing?: BenchTiming;
}

export interface SuiteOptions {
  /** Extra cases in the suite's own case format; reported with ids prefixed `hidden:`. */
  extraCases?: unknown[];
  /** Override the suite's Monte Carlo worlds (tests run a reduced count). */
  worlds?: number;
  /** Tests only: the smallest run that still goes through the suite's path (a timing suite skips its slowest stage). */
  quick?: boolean;
  /** Runs per case, for a timing suite. */
  runs?: number;
  /** Case processes to run on, for a suite that can run its cases apart (1: serially, in this process). */
  workers?: number;
  /** Only these reported case ids (hidden ones with their prefix), for a suite that can select. */
  only?: string[];
  /** Progress lines; never given a hidden case's content. */
  log?: (line: string) => void;
}

export interface SuiteOutcome {
  cases: CaseResult[];
  metrics: Record<string, number>;
  /** Human lines for the terminal summary: ids and verdicts only. */
  summary: string[];
  timing?: BenchTiming;
}

export interface Suite {
  name: string;
  /** The metric the experiment selects on, and which way is better. */
  primary: { metric: string; direction: 'higher' | 'lower' };
  run(options: SuiteOptions): Promise<SuiteOutcome>;
}

export const HIDDEN_PREFIX = 'hidden:';
