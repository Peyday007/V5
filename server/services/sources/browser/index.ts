/**
 * Browser routines as versioned reusable capabilities (ACQ-21-5): the module
 * surface callers and the program owner's probe import.
 *
 * `effectGuard.ts` names its own key input `BrowserCapability` (host, name,
 * version), which is not `capability.ts`'s definition of the same name, so it
 * is exported here under `EffectCapability`.
 */
export * from './actionClass.ts';
export * from './capability.ts';
export * from './redaction.ts';
export * from './verifyOutcome.ts';
export * from './operate.ts';
export {
  BROWSER_EFFECT_NAMESPACE,
  BROWSER_EFFECT_NAMESPACE_VERSION,
  DEFAULT_HOST_RUNS_PER_MINUTE,
  EFFECT_CLAIM_TTL_MS,
  REQUEST_WINDOW_MS,
  browserEffectKey,
  claimBrowserEffect,
  guardBrowserRun,
  readBrowserEffect,
  readRecentRunRows,
  readRequestBudget,
  requestBudgetFrom,
  resolveUnknownBrowserEffect,
  settleBrowserEffect,
  type BrowserCapability as EffectCapability,
  type ClaimInput,
  type ClaimResult,
  type EffectKeyInput,
  type GuardDecision,
  type GuardInput,
  type RequestBudget,
  type RunRow,
} from './effectGuard.ts';
