/**
 * Where Brain recognizes each kind of change, and what it does next (§100).
 *
 * Not a scheduler and not a second control system: every row names a function
 * that already exists and the loop that already calls it. The register is the
 * one place a reader — or the next capability — finds which recognizer owns a
 * change, and `tests/changeRecognition.test.ts` fails the moment a row's
 * recognizer stops existing or stops being called from its loop. A capability
 * that holds state other work depends on adds its row here in the same change
 * that adds the capability.
 *
 * `trigger` says how the change is noticed:
 *   - EVENT: the write that changes reality is what Brain reads (an arrival, a
 *     consent, a completed stage, a resolved request), acted on the next tick;
 *   - PERIODIC: no event is available or reliable, so a bounded check runs —
 *     the `why` says why polling is the only reading.
 */

export type ChangeClass =
  | 'CONNECTORS_ROUTINES_WORKERS'
  | 'CREDENTIALS_PERMISSIONS_CONFIG'
  | 'PROVIDERS_GPU_CAPACITY'
  | 'FACTORY_CAMPAIGNS_DEPENDENCIES'
  | 'RESEARCH_OPPORTUNITIES_COMMERCIAL'
  | 'RESOURCES_BUDGETS_CONSTRAINTS'
  | 'IDLE_CAPACITY';

export interface Recognizer {
  changeClass: ChangeClass;
  /** The change, in a sentence. */
  change: string;
  /** Repository-relative module and its exported function that recognizes and reconciles it. */
  module: string;
  exportName: string;
  /** The running file that calls it (a loop, a route, or a scheduled script). */
  calledFrom: string;
  trigger: 'EVENT' | 'PERIODIC';
  /** What it corrects and what work it resumes. */
  effect: string;
  /** For PERIODIC: why no event can carry it. */
  why?: string;
}

export const CHANGE_RECOGNIZERS: readonly Recognizer[] = [
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: "A Routine's owner switched it to another Brain connector in the same Claude account.",
    module: 'server/services/fleet/arrivalIdentity.ts',
    exportName: 'adoptSwitchedIdentities',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect:
      'The fired session\'s authenticated check-in is the event; the Routine is re-registered for the worker it now ' +
      'arrives as (audited, reversible), its stale connector replaced, its quarantine lifted, and its deferred work re-armed.',
  },
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: 'A Routine picks between two connectors, or arrives as a worker it cannot be adopted for.',
    module: 'server/services/fleet/arrivalIdentity.ts',
    exportName: 'quarantineWrongWorkerSurfaces',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect: 'Stops spending activations on it after one fire, naming the exact mismatch and who can correct it.',
  },
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: 'An operator repointed a Routine to the worker its sessions were proven to arrive as.',
    module: 'server/services/fleet/arrivalIdentity.ts',
    exportName: 'recoverRebindedSurfaces',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect: 'Re-enables the Routine without a second command.',
  },
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: 'A quarantined Routine\'s worker gained or used a new connector, or its owner fixed it silently.',
    module: 'server/services/fleet/autoRecovery.ts',
    exportName: 'autoProbeQuarantinedSurfaces',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect:
      'A new consent or unattributed-client use by the registered worker probes it within the hour; a right arrival lifts ' +
      'the quarantine and work routes to it. Backoff, then daily, then weekly is the fallback for a change with no token trace.',
  },
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: 'An OAuth client or Routine arrived through a connector Brain had not attributed.',
    module: 'server/services/fleet/connectorBinding.ts',
    exportName: 'reconcileConnectorBindings',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect: 'Attributes the client and Routine to their logical connector so its health is readable.',
  },
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: 'A Routine is bound to a connector verified to authorize as a different worker (a stale record).',
    module: 'server/services/fleet/connectorBinding.ts',
    exportName: 'clearStaleConnectorBindings',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect: 'Clears the binding, guarded on itself; the next proven arrival binds the right connector.',
  },
  {
    changeClass: 'CONNECTORS_ROUTINES_WORKERS',
    change: 'A Routine, account or worker routing row changed (enabled, repointed, granted, narrowed).',
    module: 'server/repos/bins.ts',
    exportName: 'rearmSurfaceDeferredIntents',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect: 'Re-arms every deferred dispatch the change now makes routable, re-checked with the router.',
  },
  {
    changeClass: 'CREDENTIALS_PERMISSIONS_CONFIG',
    change: "A connector's consent was renewed after its authorization lapsed.",
    module: 'server/services/fleet/connectorBinding.ts',
    exportName: 'recoverReauthorizedSurfaces',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'EVENT',
    effect: 'Puts back every surface whose quarantine was that connector\'s, without anybody re-enabling it.',
  },
  {
    changeClass: 'CREDENTIALS_PERMISSIONS_CONFIG',
    change: 'A Brain connector was (re)authorized.',
    module: 'server/services/fleet/connectorHealth.ts',
    exportName: 'forgetRoutingHealth',
    calledFrom: 'server/routes/oauth.ts',
    trigger: 'EVENT',
    effect: 'Drops the cached routing health after the consent commits, so the next tick routes on the new fact.',
  },
  {
    changeClass: 'PROVIDERS_GPU_CAPACITY',
    change: "An account's measured headroom, refusals or rate limits changed.",
    module: 'server/services/dispatch/scaler.ts',
    exportName: 'autoScaleAccounts',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'PERIODIC',
    why: 'Claude exposes no usage notification; the fire results are read on a ten-minute cadence.',
    effect: 'Raises or lowers each account\'s concurrency target from its own measured outcomes.',
  },
  {
    changeClass: 'PROVIDERS_GPU_CAPACITY',
    change: 'Free-model or GPU capacity, errors or database pressure changed.',
    module: 'server/services/freeLane/capacity.ts',
    exportName: 'controlStep',
    calledFrom: 'server/services/freeLane/capacity.ts',
    trigger: 'PERIODIC',
    why: 'Provider latency and errors are measured per call; the controller reads them on its own cadence (§86).',
    effect: 'Sets each model\'s concurrency and tops up idle slots with waiting work.',
  },
  {
    changeClass: 'PROVIDERS_GPU_CAPACITY',
    change: 'GPU work started or ran out.',
    module: 'server/services/cheap/runpodPod.ts',
    exportName: 'superviseRunpodPod',
    calledFrom: 'server/services/freeLane/capacity.ts',
    trigger: 'PERIODIC',
    why: 'The pod is billed while running; its state is a provider API reading with no push notification.',
    effect: 'Starts the pod for waiting GPU work and stops it when none waits.',
  },
  {
    changeClass: 'PROVIDERS_GPU_CAPACITY',
    change: 'RunPod deleted the GPU pod.',
    module: 'server/services/cheap/runpodRestore.ts',
    exportName: 'ensurePod',
    calledFrom: 'scripts/runpod-restore.ts',
    trigger: 'PERIODIC',
    why: 'RunPod sends no deletion event; the hourly cheap-lane workflow asks its API.',
    effect: 'Recreates the pod from code with the same template and volume.',
  },
  {
    changeClass: 'FACTORY_CAMPAIGNS_DEPENDENCIES',
    change: 'A Factory stage completed, integrated or failed, releasing or blocking its dependents.',
    module: 'server/services/factory/remoteLoop.ts',
    exportName: 'tickAllRemoteCampaigns',
    calledFrom: 'server/services/factory/remoteLoop.ts',
    trigger: 'EVENT',
    effect: 'Advances every campaign whose dependency is now integrated, and dispatches the new bins at once.',
  },
  {
    changeClass: 'FACTORY_CAMPAIGNS_DEPENDENCIES',
    change: 'A program requirement was met on production, or a campaign it waits on finished.',
    module: 'server/services/factory/program/loop.ts',
    exportName: 'tickAllProgramsIfDue',
    calledFrom: 'server/services/factory/remoteLoop.ts',
    trigger: 'EVENT',
    effect: 'Verifies requirements already shown on production and starts the next release\'s campaigns.',
  },
  {
    changeClass: 'FACTORY_CAMPAIGNS_DEPENDENCIES',
    change: 'An approved program sits blocked on a condition that has since cleared.',
    module: 'server/services/factory/program/unblock.ts',
    exportName: 'unblockApprovedPrograms',
    calledFrom: 'server/services/dispatch/loop.ts',
    trigger: 'PERIODIC',
    why: 'Its blockers live in several owners with no shared event; one hourly reading covers them all.',
    effect: 'Unblocks the program and lets its campaigns continue.',
  },
  {
    changeClass: 'RESEARCH_OPPORTUNITIES_COMMERCIAL',
    change: 'A dependency a parked research item waited on arrived.',
    module: 'server/services/russell/resumeParked.ts',
    exportName: 'resumeParkedAcrossProjects',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'EVENT',
    effect: 'Resumes the parked item.',
  },
  {
    changeClass: 'RESEARCH_OPPORTUNITIES_COMMERCIAL',
    change: "New evidence changed a goal plan's inputs.",
    module: 'server/services/goals/plan.ts',
    exportName: 'advanceGoalPlans',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'EVENT',
    effect: 'Re-reads the plan when its evidence fingerprint moves (§90) and resumes repaired goals.',
  },
  {
    changeClass: 'RESEARCH_OPPORTUNITIES_COMMERCIAL',
    change: 'An opportunity\'s evidence, or the authority over it, changed.',
    module: 'server/services/cash/discovery.ts',
    exportName: 'runDiscovery',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'EVENT',
    effect: 'Re-ranks candidates and resumes those parked on authority once a grant covers them.',
  },
  {
    changeClass: 'RESEARCH_OPPORTUNITIES_COMMERCIAL',
    change: 'A person answered a request a mission was parked on.',
    module: 'server/services/russell/needsHuman.ts',
    exportName: 'unparkResolvedMissions',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'EVENT',
    effect: 'Unparks the mission; nobody is asked the same question twice.',
  },
  {
    changeClass: 'RESOURCES_BUDGETS_CONSTRAINTS',
    change: 'Database pressure rose or fell.',
    module: 'server/db/pressure.ts',
    exportName: 'databasePressure',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'PERIODIC',
    why: 'Load is a measurement of the shared database, not an event any writer emits (§61, §63).',
    effect: 'Defers optional passes under pressure and runs them again by itself when it clears.',
  },
  {
    changeClass: 'RESOURCES_BUDGETS_CONSTRAINTS',
    change: 'A bin\'s lease expired, its holder vanished, or its state drifted from its rows.',
    module: 'server/services/bins/service.ts',
    exportName: 'reconcileBins',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'PERIODIC',
    why: 'A lease ending by silence has no event; only the clock says it ended.',
    effect: 'Releases or re-queues the work so another surface takes it.',
  },
  {
    changeClass: 'IDLE_CAPACITY',
    change: 'Capacity sat idle beside executable work.',
    module: 'server/services/engineering/watchdog.ts',
    exportName: 'watchIdleOnTick',
    calledFrom: 'server/services/russell/loop.ts',
    trigger: 'PERIODIC',
    why: 'Idleness is the absence of an event; it can only be read (§98).',
    effect: 'Records it once per window and continues the pool through its own scheduler.',
  },
];
