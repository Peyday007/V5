/**
 * Method development and search execution are different work.
 *
 * Developing a method (deciding what to look for, where, and how to check it)
 * is Claude reasoning, done once and stored. Executing a stored method is code
 * and, for the results code cannot settle, the cheap lane. This module is the
 * one decision about which, and it has no way to create a Claude job for
 * execution: the only Claude route it knows is `DEVELOP`, and `execute` never
 * returns it.
 *
 * Pure apart from the lane call in `settleUncertain`, which is injected.
 */
import { classifyResult, type LaneOptions, type ResultInput, type ResultOutput } from '../../cheap/lane.ts';

/** What a stored method's own code check said about one result. */
export type CodeVerdict = 'MATCH' | 'NO_MATCH' | 'UNCERTAIN';

export interface MethodResult {
  /** Stable id of the result, so the lane's cache and subject line up. */
  id: string;
  source: string;
  title: string;
  body: string | null;
  codeVerdict: CodeVerdict;
}

/** The part of a stored method execution needs; the record itself lives elsewhere. */
export interface ExecutableMethod {
  id: string;
  looksFor: string;
}

export const ROUTES = ['CODE', 'CHEAP_LANE', 'DEVELOP'] as const;
export type Route = (typeof ROUTES)[number];

/** Execution never routes to DEVELOP; that is only for a method that does not exist yet. */
export type ExecutionRoute = Exclude<Route, 'DEVELOP'>;

export interface RoutedResult {
  result: MethodResult;
  route: ExecutionRoute;
}

export interface ExecutionPlan {
  routed: RoutedResult[];
  /** Always zero. Present so a reader can assert it rather than assume it. */
  claudeJobs: 0;
}

/** Route every result of an executed method. Settled by code stays with code. */
export function planExecution(results: MethodResult[]): ExecutionPlan {
  return {
    routed: results.map((result) => ({
      result,
      route: result.codeVerdict === 'UNCERTAIN' ? 'CHEAP_LANE' : 'CODE',
    })),
    claudeJobs: 0,
  };
}

/** Which route a request with no stored method takes: the method must be developed first. */
export function routeRequest(method: ExecutableMethod | null): Route {
  return method ? 'CODE' : 'DEVELOP';
}

export type SettledVerdict = 'KEEP' | 'DROP' | 'UNSURE';

export interface SettledResult {
  id: string;
  verdict: SettledVerdict;
  by: 'CODE' | 'CHEAP_LANE' | 'NONE';
  reason: string;
}

/**
 * Settle every result. Code verdicts stand as they are; uncertain ones go to
 * the cheap lane. A lane that is off, spent or failed gives no signal, which is
 * UNSURE and never DROP: the result is kept for a later look, not discarded.
 */
export async function settleUncertain(
  method: ExecutableMethod,
  results: MethodResult[],
  options: LaneOptions = {},
): Promise<SettledResult[]> {
  const plan = planExecution(results);
  const out: SettledResult[] = [];
  for (const { result, route } of plan.routed) {
    if (route === 'CODE') {
      out.push({
        id: result.id,
        verdict: result.codeVerdict === 'MATCH' ? 'KEEP' : 'DROP',
        by: 'CODE',
        reason: result.codeVerdict === 'MATCH' ? 'The method\'s check matched.' : 'The method\'s check did not match.',
      });
      continue;
    }
    const input: ResultInput = {
      looksFor: method.looksFor,
      source: result.source,
      title: result.title,
      body: result.body,
    };
    const answer: ResultOutput | null = await classifyResult(`${method.id}:${result.id}`, input, options);
    out.push(
      answer
        ? { id: result.id, verdict: answer.verdict, by: 'CHEAP_LANE', reason: answer.reason }
        : { id: result.id, verdict: 'UNSURE', by: 'NONE', reason: 'The cheap lane gave no signal.' },
    );
  }
  return out;
}
