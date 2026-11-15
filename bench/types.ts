/**
 * The result contract shared with the experiment core (docs/evolution/DESIGN.md):
 * `{ suite, sha, ref, cases:[{id, pass, score, ms}], metrics:{name: number}, ranAt }`.
 * `scripts/evolution.ts record` reads exactly this on its stdin.
 */
export interface CaseResult {
  id: string;
  pass: boolean;
  score: number;
  ms: number;
}

export interface BenchResult {
  suite: string;
  sha: string;
  ref: string;
  cases: CaseResult[];
  metrics: Record<string, number>;
  ranAt: string;
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
  /** Progress lines; never given a hidden case's content. */
  log?: (line: string) => void;
}

export interface SuiteOutcome {
  cases: CaseResult[];
  metrics: Record<string, number>;
  /** Human lines for the terminal summary: ids and verdicts only. */
  summary: string[];
}

export interface Suite {
  name: string;
  /** The metric the experiment selects on, and which way is better. */
  primary: { metric: string; direction: 'higher' | 'lower' };
  run(options: SuiteOptions): Promise<SuiteOutcome>;
}

export const HIDDEN_PREFIX = 'hidden:';
