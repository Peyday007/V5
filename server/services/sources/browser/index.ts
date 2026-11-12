/**
 * Browser routines as versioned reusable capabilities (ACQ-21-5): the module
 * surface callers and the program owner's probe import.
 *
 * There is one `BrowserCapability` (the definition in `capability.ts`) and one
 * way to run it (`operateCapability` in `operate.ts`); `effectGuard.ts` names
 * what an effect is performed by as an `EffectSubject`, built for a recorded
 * version by `capabilityEffectSubject`.
 */
export * from './actionClass.ts';
export * from './capability.ts';
export * from './redaction.ts';
export * from './verifyOutcome.ts';
export * from './operate.ts';
export * from './effectGuard.ts';
