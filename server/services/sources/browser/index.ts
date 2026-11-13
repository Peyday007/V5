/**
 * Browser routines as versioned reusable capabilities (ACQ-21-5): the module
 * surface callers and the program owner's probe import.
 *
 * There is one capability type (`capability.ts`'s `BrowserCapability`). The
 * effect guard's key input is an `EffectSubject` (host, name, version), built
 * from a capability record by `effectSubject`.
 */
export * from './actionClass.ts';
export * from './capability.ts';
export * from './redaction.ts';
export * from './verifyOutcome.ts';
export * from './operate.ts';
export * from './schedule.ts';
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
  CAPABILITY_RATE_WINDOW_MS,
  type CapabilityRate,
  type EffectSubject,
  type ClaimInput,
  type ClaimResult,
  type EffectKeyInput,
  type GuardDecision,
  type GuardInput,
  type RequestBudget,
  type RunRow,
} from './effectGuard.ts';
