/**
 * A coding worker as a Cowork activation Brain fires.
 *
 * Brain already has this machinery and it already works: §22 and §23 built the
 * dispatch loop, the fleet registry, the fire slot and the compare-and-swap that
 * stops two dispatchers firing one surface. A factory that grew its own version
 * of it would be a second orchestration universe beside Brain, which is exactly
 * what this step is not allowed to be.
 *
 * So this executor is deliberately thin, and deliberately honest about what is
 * not yet connected. Firing a Routine starts a session somewhere else; that
 * session reaches Brain through `/mcp` as a `WORKER` principal and works a bin.
 * What does not exist yet is the unit-level handshake — the remote session
 * claiming a *factory* unit, checking out its worktree and reporting a branch.
 * That is a real piece of work with a real surface dependency, and the
 * assignment's own rule applies: a capability nobody has observed is UNKNOWN and
 * says so, rather than being reported as capacity.
 *
 * The value of the file being here is that it is the second kind, which is what
 * proves the registry's claim: adding a surface is a row plus an executor that
 * already exists, and the scheduler, the integrator and the review path never
 * learn which kind they were talking to.
 */
import type { ExecutionRequest, ExecutionResult, Executor } from './index.ts';

export const coworkExecutor: Executor = {
  kind: 'COWORK_ROUTINE',

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: false,
      detail:
        'Cowork dispatch exists in Brain and drives research bins. The factory-unit handshake ' +
        'for it is not built, so this surface is UNKNOWN capacity rather than available ' +
        'capacity. Registering a COWORK_ROUTINE worker is allowed; the scheduler will not ' +
        'route to it while this probe fails.',
    };
  },

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return {
      outcome: 'ERROR',
      externalSessionId: null,
      summary: '',
      rawLog: '',
      durationMs: 0,
      numTurns: null,
      usage: null,
      retryAfterMs: null,
      detail:
        `No Cowork handshake exists for factory unit ${request.unitId}. This surface reports ` +
        'itself unusable rather than pretending to have run.',
      paidApi: false,
    };
  },
};
