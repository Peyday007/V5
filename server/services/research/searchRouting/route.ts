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
 * The CHEAP_LANE route has one executor, and it is the lane task that already
 * runs on every feeds pass: a learned detector's near-miss (`escalate` in
 * `feeds/learned.ts`, the UNCERTAIN verdict here) is screened first by
 * `screenFeedLeads` in `feeds/run.ts` through SCREEN_LEAD, whose agreed answers
 * the shortlist and detector learning already read. A second lane task for the
 * same results would spend the same daily budget on answers nothing reads.
 *
 * Pure.
 */
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
