/**
 * The engineering policy: how much rigor a change has earned, decided once, in
 * code, for every coding worker.
 *
 * Every Claude session used to invent its own answer to four questions — how
 * risky is this, which tests must run, may I build a new mechanism, am I done —
 * and the answers drifted towards the expensive end: a known root cause became
 * an architecture project, a SHA that had already passed its full suite ran it
 * again, an observable workflow was "checked in fifteen minutes", and a task
 * whose outcome was "production works" stopped at an open pull request.
 *
 * This module is the one place those answers live. It is pure: every function
 * here is a decision over its inputs, so "why did the policy say that" is
 * answerable from the input rather than from a re-run, and a test can hold each
 * rule against the behaviour it exists to prevent. The rows it reads and writes
 * are `repos/engineering.ts`; the doors are `mcp/engineeringTools.ts` and
 * `scripts/engineering.ts`. There is deliberately no model call anywhere in it —
 * a policy that asked a model whether a change was risky would be the drift it
 * replaces.
 *
 * It advises and records. It moves no work, grants no authority and blocks no
 * route: the enforcement that exists is the thin hook in `.claude/hooks/`, and
 * everything else is a worker being told the answer before it spends an hour
 * finding a worse one.
 */

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

export const RISK_TIERS = ['TIER_0', 'TIER_1', 'TIER_2', 'TIER_3'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const EVIDENCE_STATUSES = ['PROVEN', 'FAILED', 'STALE', 'UNKNOWN'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Strongest first. The rank is the whole of "real beats synthetic". */
export const EVIDENCE_SOURCES = ['REAL_PRODUCTION', 'CI', 'OPERATOR', 'TEST', 'SYNTHETIC'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export function sourceRank(source: EvidenceSource): number {
  return EVIDENCE_SOURCES.length - EVIDENCE_SOURCES.indexOf(source);
}

/** What a worker may write through the MCP door. Everything stronger is Brain's or a shell's. */
export const WORKER_RECORDABLE_SOURCES: readonly EvidenceSource[] = ['TEST', 'SYNTHETIC'];

export const INTERVENTION_KINDS = [
  'OVERENGINEERING_BLOCKED',
  'REDUNDANT_TEST_BLOCKED',
  'BAD_WAIT_BLOCKED',
  'PREMATURE_STOP_PREVENTED',
  'DUPLICATE_MECHANISM_BLOCKED',
  'UNNECESSARY_HUMAN_QUESTION',
  'IDLE_WITH_EXECUTABLE_WORK',
  'REAL_EVIDENCE_REUSED',
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export const BLOCKER_KINDS = [
  'AUTO_WAIT',
  'RETRYABLE',
  'MISSING_AUTHORITY',
  'HUMAN_DECISION',
  'EXTERNAL_SERVICE',
  'DEFECT',
  'AMBIGUOUS_REQUIREMENT',
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** The kinds only a person can answer. Everything else Brain or the worker resolves. */
export const HUMAN_BLOCKER_KINDS: readonly BlockerKind[] = [
  'MISSING_AUTHORITY',
  'HUMAN_DECISION',
  'AMBIGUOUS_REQUIREMENT',
];

/**
 * Where a question can be answered without a person (rule 7). A blocker that
 * asks a person must say which of these it consulted first.
 */
export const SELF_ANSWERABLE_SOURCES = [
  'repo',
  'git_history',
  'database',
  'brain_records',
  'github',
  'workflow_logs',
  'configuration',
] as const;

/**
 * How far a task goes. Ordered: a task whose outcome is PRODUCTION_WORKING is
 * not done at PR_OPEN, and a task whose outcome is PLAN is done at PLAN.
 */
export const OUTCOME_LEVELS = [
  'PLAN',
  'BRANCH',
  'TESTS_PASS',
  'PR_OPEN',
  'MERGED',
  'DEPLOYED',
  'PRODUCTION_WORKING',
] as const;
export type OutcomeLevel = (typeof OUTCOME_LEVELS)[number];

export function outcomeReached(reached: OutcomeLevel | null, wanted: OutcomeLevel): boolean {
  if (reached === null) return false;
  return OUTCOME_LEVELS.indexOf(reached) >= OUTCOME_LEVELS.indexOf(wanted);
}

/* ------------------------------------------------------------------------- */
/* Risk                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Path classes, most dangerous first; a change's tier is the highest any of its
 * paths reaches. Prefix matching and nothing cleverer: a policy nobody can read
 * in one screen is a policy nobody trusts.
 */
const TIER_3_PREFIXES = [
  'server/db/',
  'server/repos/',
  'server/services/identity/',
  'server/services/bins/routing.ts',
  'server/services/dispatch/router.ts',
  'server/routes/guard.ts',
  'server/routes/oauth.ts',
  'server/mcp/endpoint.ts',
  'server/services/effects/',
  '.github/',
  'fly.toml',
  'Dockerfile',
];
const TIER_2_PREFIXES = ['server/services/', 'server/mcp/', 'server/routes/', 'server/index.ts'];
const TIER_1_PREFIXES = ['client/', 'server/domain/', 'scripts/', 'tests/', '.claude/', 'package.json'];

function isDocs(path: string): boolean {
  return path.startsWith('docs/') || /\.(md|txt)$/i.test(path);
}

export function riskForPaths(paths: readonly string[]): { tier: RiskTier; reasons: string[] } {
  if (paths.length === 0) {
    // Nothing declared is not nothing changed. Unknown scope is tier 2, never 0.
    return { tier: 'TIER_2', reasons: ['no changed paths were declared, so the scope is unknown'] };
  }
  let tier: RiskTier = 'TIER_0';
  const reasons: string[] = [];
  const raise = (to: RiskTier, why: string): void => {
    if (RISK_TIERS.indexOf(to) > RISK_TIERS.indexOf(tier)) tier = to;
    if (!reasons.includes(why)) reasons.push(why);
  };
  for (const path of paths) {
    if (TIER_3_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      raise('TIER_3', `${path} is identity, routing, persistence, schema or deployment`);
    } else if (TIER_2_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      raise('TIER_2', `${path} is subsystem or business logic`);
    } else if (TIER_1_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      raise('TIER_1', `${path} is isolated UI, logic, script or test`);
    } else if (isDocs(path)) {
      raise('TIER_0', `${path} is documentation`);
    } else {
      raise('TIER_1', `${path} is not classified, so it is treated as isolated logic`);
    }
  }
  return { tier, reasons };
}

/* ------------------------------------------------------------------------- */
/* Test policy                                                                */
/* ------------------------------------------------------------------------- */

export interface TestPolicyInput {
  changedPaths: readonly string[];
  /** The exact commit the tests would run against. */
  sha?: string | null;
  /** The commit is the one being integrated and released. */
  releaseSha?: boolean;
  /** Current readings of FULL_GATE:<sha>:sqlite and :postgres, if looked up. */
  fullGate?: { sqlite?: EvidenceStatus; postgres?: EvidenceStatus };
  /** The worker is proposing to run the whole suite. */
  proposesFullSuite?: boolean;
}

export interface TestPolicy {
  tier: RiskTier;
  typecheck: boolean;
  impacted: boolean;
  focusedPostgres: boolean;
  fullSuite: boolean;
  /** Set when a full suite was asked for and refused, and why. */
  fullSuiteRefused: string | null;
  commands: string[];
  reasons: string[];
}

export function testPolicy(input: TestPolicyInput): TestPolicy {
  const risk = riskForPaths(input.changedPaths);
  const tier = risk.tier;
  const reasons = [...risk.reasons];
  const allDocs = input.changedPaths.length > 0 && input.changedPaths.every(isDocs);

  const typecheck = !allDocs;
  const impacted = tier !== 'TIER_0';
  const persistence = input.changedPaths.some(
    (path) => path.startsWith('server/db/') || path.startsWith('server/repos/'),
  );
  const focusedPostgres = tier === 'TIER_3' && persistence;

  if (typecheck) reasons.push('typecheck: every code change, because it is seconds and catches drift the suite would take minutes to');
  if (impacted) reasons.push('impacted: the tests that import what changed, plus the structural guards');
  if (focusedPostgres) reasons.push('focused Postgres: persistence changed, and only the second backend can say whether a statement is true in both dialects');

  const gate = input.fullGate ?? {};
  const alreadyPassed = gate.sqlite === 'PROVEN' && (!persistence || gate.postgres === 'PROVEN');
  let fullSuite = false;
  let fullSuiteRefused: string | null = null;

  if (input.releaseSha) {
    if (alreadyPassed) {
      fullSuiteRefused =
        `This exact SHA${input.sha ? ` (${input.sha.slice(0, 12)})` : ''} already has a valid full-gate PASS. ` +
        'Reuse it; the canonical release gate is paid once per SHA, not once per session.';
    } else {
      fullSuite = true;
      reasons.push('full suite: this is the release SHA and the canonical gate has not passed on it yet — paid once, by CI');
    }
  } else if (input.proposesFullSuite) {
    fullSuiteRefused = alreadyPassed
      ? 'This exact SHA already has a valid full-gate PASS. Reuse it.'
      : 'A full suite on an intermediate commit is not justified: run typecheck and test:impacted now; the full gate runs once, on the SHA that is integrated and released (Postgres suite on push to the canonical branch, and Deploy\'s own test job).';
  }

  const commands: string[] = [];
  if (typecheck) commands.push('npm run typecheck');
  if (impacted) commands.push('npm run test:impacted');
  if (focusedPostgres) commands.push('BRAIN_TEST_DATABASE_URL=postgresql://... npm run test:impacted');
  if (fullSuite) commands.push('the canonical release gate (CI), once');
  if (allDocs) reasons.push('documentation only: no test run is required');

  return { tier, typecheck, impacted, focusedPostgres, fullSuite, fullSuiteRefused, commands, reasons };
}

/* ------------------------------------------------------------------------- */
/* Existing owners (rule 6)                                                   */
/* ------------------------------------------------------------------------- */

export interface MechanismOwner {
  responsibility: string;
  /** Words in a proposal that mean "I am about to build one of these". */
  keywords: string[];
  owners: string[];
  extend: string;
}

/**
 * Every durable mechanism this Brain already has an owner for. A proposal to
 * build another is refused unless it names why extension cannot work. Paths
 * are asserted to exist by `tests/engineeringPolicy.test.ts`, so a moved file
 * fails a test instead of sending a worker to a path that is gone.
 */
export const MECHANISM_OWNERS: readonly MechanismOwner[] = [
  {
    responsibility: 'scheduler / periodic tick',
    keywords: ['scheduler', 'cron', 'tick', 'periodic', 'timer loop', 'background loop'],
    owners: ['server/services/russell/loop.ts', 'server/services/dispatch/loop.ts'],
    extend: 'Add a step to the durable Russell tick (derived from rows, idempotent), or to the dispatch tick if it is about firing work.',
  },
  {
    responsibility: 'work queue',
    keywords: ['queue', 'job table', 'work items', 'task queue'],
    owners: ['server/repos/workQueue.ts', 'server/repos/bins.ts'],
    extend: 'Use work_items (leases, fencing) or a bin with a completion contract.',
  },
  {
    responsibility: 'worker dispatch / orchestration',
    keywords: ['orchestrat', 'dispatcher', 'worker manager', 'worker pool', 'fan out'],
    owners: ['server/services/dispatch/loop.ts', 'server/services/factory/remote.ts', 'server/repos/fleet.ts'],
    extend: 'Create a bin; the dispatcher routes and fires it. A worker is a fleet_routines row.',
  },
  {
    responsibility: 'authentication / authorization',
    keywords: ['auth layer', 'permission system', 'access control', 'new role', 'authorization'],
    owners: ['server/services/identity/policy.ts', 'server/routes/guard.ts'],
    extend: 'Add to decideProjectAccess; never write a role check into a handler.',
  },
  {
    responsibility: 'verification / proof',
    keywords: ['verification subsystem', 'proof system', 'synthetic probe', 'commission', 'self-test', 'prove the surface'],
    owners: ['server/services/dispatch/deliveryEvidence.ts', 'server/services/fleet/probe.ts', 'scripts/verify-hosted.ts'],
    extend: 'Real work is the evidence (deliveryEvidence.ts); a probe exists already for a surface with no real work.',
  },
  {
    responsibility: 'evidence / what is already known',
    keywords: ['evidence store', 'evidence layer', 'cache of results', 'knowledge base'],
    owners: ['server/repos/engineering.ts', 'server/repos/deliveryProofs.ts'],
    extend: 'Record a property in engineering_evidence; derive from rows Brain already writes.',
  },
  {
    responsibility: 'retry / idempotency',
    keywords: ['retry system', 'retry logic', 'idempotency', 'dedupe'],
    owners: ['server/services/effects/engine.ts', 'server/services/factory/regrant.ts'],
    extend: 'Key the effect through idempotentEffect; raise a ceiling with regrant, never reset it.',
  },
  {
    responsibility: 'repository access',
    keywords: ['repository abstraction', 'git wrapper', 'github client', 'forge client'],
    owners: ['server/services/factory/forge.ts', 'server/services/factory/git.ts'],
    extend: 'Read through forge.ts (remote) or git.ts (local checkout).',
  },
  {
    responsibility: 'monitoring / status',
    keywords: ['monitoring', 'dashboard', 'health check', 'watchdog', 'status page'],
    owners: ['server/services/fleet/view.ts', 'server/services/goals/briefing.ts', 'server/repos/engineering.ts'],
    extend: 'Derive a reading on the read path; record an intervention row; never store a verdict.',
  },
  {
    responsibility: 'goals / task state',
    keywords: ['task tracker', 'work register', 'goal tracking', 'task state'],
    owners: ['server/repos/register.ts', 'server/services/goals/tick.ts'],
    extend: 'File a workstream and link the rows; the state is derived.',
  },
];

export interface DuplicateCheck {
  matches: { responsibility: string; owners: string[]; extend: string }[];
  extensionPreferred: boolean;
  newMechanismJustified: boolean;
  reason: string;
}

export function duplicateMechanismCheck(input: {
  proposal: string;
  /** Why extending the existing owner cannot work. Required to justify a new one. */
  whyExtensionFails?: string | null;
}): DuplicateCheck {
  const text = input.proposal.toLowerCase();
  const matches = MECHANISM_OWNERS.filter((owner) =>
    owner.keywords.some((keyword) => text.includes(keyword)),
  ).map((owner) => ({ responsibility: owner.responsibility, owners: owner.owners, extend: owner.extend }));
  if (matches.length === 0) {
    return {
      matches,
      extensionPreferred: false,
      newMechanismJustified: true,
      reason: 'No existing owner matches this proposal. Search the repository once before building it.',
    };
  }
  const justification = (input.whyExtensionFails ?? '').trim();
  const justified = justification.length >= 40;
  return {
    matches,
    extensionPreferred: !justified,
    newMechanismJustified: justified,
    reason: justified
      ? `An owner exists (${matches.map((m) => m.responsibility).join(', ')}); a new mechanism is allowed because: ${justification}`
      : `An owner already exists for ${matches.map((m) => m.responsibility).join(', ')}. Extend it. A new mechanism needs a stated reason extension cannot work.`,
  };
}

/* ------------------------------------------------------------------------- */
/* Preflight (rules 1, 2, 5, 6, 10)                                           */
/* ------------------------------------------------------------------------- */

export const EXECUTION_MODES = ['RESTORE_FIRST', 'FIX_FIRST', 'INVESTIGATE', 'DESIGN'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface PreflightInput {
  objective: string;
  intendedOutcome?: OutcomeLevel | null;
  changedPaths?: readonly string[];
  knownRootCause?: string | null;
  reversible?: boolean;
  blastRadius?: 'SMALL' | 'MEDIUM' | 'LARGE';
  productionBroken?: boolean;
  proposedAction?: string | null;
  schemaChange?: boolean;
  /** Real evidence already found for what the task wants proven. */
  provenProperties?: readonly string[];
}

export interface Preflight {
  riskTier: RiskTier;
  rootCauseKnown: boolean;
  recommendedMode: ExecutionMode;
  investigationBudgetMinutes: number;
  architectureExpansionAllowed: boolean;
  proposalRefused: string | null;
  testPolicy: TestPolicy;
  existingEvidence: string[];
  duplicateCheck: DuplicateCheck | null;
  parallelismAdvice: string;
  doneWhen: string;
  humanAuthorityRequired: boolean;
  reasons: string[];
}

/** Words that mean "I am about to add structure", matched against a proposal. */
const EXPANSION_MARKERS = [
  'migration',
  'new table',
  'schema',
  'new service',
  'subsystem',
  'framework',
  'proof system',
  'synthetic proof',
  'synthetic probe',
  'commissioning',
  'new command',
  'router gate',
  'generalized',
  'generalised',
  'platform',
  'architecture',
];

const AUTHORITY_MARKERS = [
  'secret',
  'credential',
  'new repository',
  'grant',
  'spend',
  'purchase',
  'widen scope',
  'merge to production',
  'delete account',
];

const DONE_TEXT: Record<OutcomeLevel, string> = {
  PLAN: 'a plan exists that a person can approve',
  BRANCH: 'the change is committed and pushed on its branch',
  TESTS_PASS: 'the policy-selected tests pass on the change',
  PR_OPEN: 'a reviewable pull request is open with the policy-selected tests green',
  MERGED: 'the change is merged into the canonical branch',
  DEPLOYED: 'the released image is serving this commit',
  PRODUCTION_WORKING: 'the real user journey succeeds in production — not a PR, not a green test, the journey',
};

export function preflight(input: PreflightInput): Preflight {
  const paths = input.changedPaths ?? [];
  const policy = testPolicy({ changedPaths: paths });
  let tier = policy.tier;
  if (input.schemaChange) tier = 'TIER_3';
  const rootCauseKnown = (input.knownRootCause ?? '').trim().length > 0;
  const reversible = input.reversible ?? true;
  const blast = input.blastRadius ?? 'SMALL';
  const reasons: string[] = [];

  let mode: ExecutionMode;
  if (input.productionBroken) {
    mode = 'RESTORE_FIRST';
    reasons.push('Rule 10: production is broken — restore the user journey first; decide on hardening after it works.');
  } else if (rootCauseKnown && reversible && blast === 'SMALL') {
    mode = 'FIX_FIRST';
    reasons.push('Rule 1: root cause known, fix reversible, blast radius small — apply the smallest root-cause fix, then retry the real work.');
  } else if (blast === 'LARGE') {
    mode = 'DESIGN';
    reasons.push('Large blast radius: a design pass is justified before code.');
  } else {
    mode = 'INVESTIGATE';
    reasons.push(rootCauseKnown ? 'Root cause known but the fix is not small or not reversible — investigate the fix, bounded.' : 'Root cause unknown — investigate, bounded, then fix.');
  }

  const budget: Record<ExecutionMode, number> = {
    RESTORE_FIRST: 10,
    FIX_FIRST: 5,
    INVESTIGATE: tier === 'TIER_3' ? 45 : 20,
    DESIGN: 60,
  };

  const architectureExpansionAllowed = mode === 'DESIGN';
  const proposal = (input.proposedAction ?? '').toLowerCase();
  let proposalRefused: string | null = null;
  const expansion = EXPANSION_MARKERS.filter((marker) => proposal.includes(marker));
  if (!architectureExpansionAllowed && expansion.length > 0) {
    proposalRefused =
      `The proposal adds structure (${expansion.join(', ')}) in ${mode}. ` +
      (mode === 'FIX_FIRST' || mode === 'RESTORE_FIRST'
        ? 'Apply the smallest root-cause fix and retry the real journey first; add structure only if the journey still fails or evidence independently requires it.'
        : 'Establish the cause before adding structure.');
    reasons.push('Rule 1: no schema, migration, service or proof architecture before the minimal fix has been retried.');
  }
  if ((input.provenProperties ?? []).length > 0 && /synthetic|probe|prove/.test(proposal)) {
    proposalRefused =
      (proposalRefused ? `${proposalRefused} ` : '') +
      `Rule 2: real evidence already proves ${input.provenProperties!.join(', ')} — do not build a synthetic proof of it.`;
  }

  const duplicateCheck = input.proposedAction ? duplicateMechanismCheck({ proposal: input.proposedAction }) : null;
  if (duplicateCheck && duplicateCheck.extensionPreferred) {
    reasons.push(`Rule 6: ${duplicateCheck.reason}`);
  }

  const humanAuthorityRequired = AUTHORITY_MARKERS.some((marker) => proposal.includes(marker)) ||
    AUTHORITY_MARKERS.some((marker) => input.objective.toLowerCase().includes(marker));
  if (humanAuthorityRequired) reasons.push('New authority (secret, credential, repository, spend or protected merge) stays with a person.');

  const outcome = input.intendedOutcome ?? 'PRODUCTION_WORKING';
  reasons.push(`Rule 5: done means ${DONE_TEXT[outcome]}.`);

  return {
    riskTier: tier,
    rootCauseKnown,
    recommendedMode: mode,
    investigationBudgetMinutes: budget[mode],
    architectureExpansionAllowed,
    proposalRefused,
    testPolicy: tier === policy.tier ? policy : { ...policy, tier },
    existingEvidence: [...(input.provenProperties ?? [])],
    duplicateCheck,
    parallelismAdvice:
      'Independent work (no dependency, disjoint owned paths, separate branches) runs concurrently when a surface is free; do not serialize it.',
    doneWhen: DONE_TEXT[outcome],
    humanAuthorityRequired,
    reasons,
  };
}

/* ------------------------------------------------------------------------- */
/* Next action (rules 4, 5, 8, 9)                                             */
/* ------------------------------------------------------------------------- */

export const NEXT_ACTIONS = [
  'CONTINUE',
  'WATCH_PROCESS',
  'START_NEXT_WORK',
  'WAIT_EXTERNAL',
  'NEEDS_HUMAN',
  'DONE',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface NextActionInput {
  intendedOutcome: OutcomeLevel;
  reached: OutcomeLevel | null;
  /** A command, workflow or deploy the worker can watch to termination. */
  runningProcess?: { observable: boolean; expectedMinutes: number | null } | null;
  /** The worker is proposing to wait this long before looking again. */
  proposedWaitMinutes?: number | null;
  independentWorkAvailable?: boolean;
  humanBlockerOpen?: boolean;
  proposingToStop?: boolean;
}

export interface NextActionDecision {
  action: NextAction;
  reason: string;
  pollSeconds: number | null;
  interventions: { kind: InterventionKind; attempted: string; replacement: string; minutesAvoided: number | null }[];
}

export function nextEngineeringAction(input: NextActionInput): NextActionDecision {
  const interventions: NextActionDecision['interventions'] = [];
  if (outcomeReached(input.reached, input.intendedOutcome)) {
    return { action: 'DONE', reason: `The requested outcome (${input.intendedOutcome}) is reached.`, pollSeconds: null, interventions };
  }
  if (input.humanBlockerOpen) {
    return { action: 'NEEDS_HUMAN', reason: 'A classified blocker only a person can answer is open.', pollSeconds: null, interventions };
  }
  if (input.proposingToStop) {
    interventions.push({
      kind: 'PREMATURE_STOP_PREVENTED',
      attempted: `stop at ${input.reached ?? 'nothing'}`,
      replacement: `continue to ${input.intendedOutcome}`,
      minutesAvoided: null,
    });
  }
  const process = input.runningProcess;
  if (process) {
    if (!process.observable) {
      return {
        action: input.independentWorkAvailable ? 'START_NEXT_WORK' : 'WAIT_EXTERNAL',
        reason: 'The thing being waited on is not observable from here; do independent work meanwhile if any exists.',
        pollSeconds: null,
        interventions,
      };
    }
    const expected = process.expectedMinutes;
    // Poll at about a quarter of the expected run, between 15s and 5 minutes.
    const pollSeconds = expected === null ? 30 : Math.min(300, Math.max(15, Math.round((expected * 60) / 4)));
    if (input.proposedWaitMinutes !== null && input.proposedWaitMinutes !== undefined) {
      const tooLong = expected === null ? input.proposedWaitMinutes >= 10 : input.proposedWaitMinutes > expected * 1.5 + 1;
      if (tooLong) {
        interventions.push({
          kind: 'BAD_WAIT_BLOCKED',
          attempted: `check again in ${input.proposedWaitMinutes} minutes`,
          replacement: `watch the process to termination, polling every ${pollSeconds}s`,
          minutesAvoided: expected === null ? null : Math.max(0, Math.round(input.proposedWaitMinutes - expected)),
        });
      }
    }
    if (input.independentWorkAvailable && (expected ?? 0) > 10) {
      return {
        action: 'START_NEXT_WORK',
        reason: 'The process is long and observable: background it, do the independent work, react when it ends.',
        pollSeconds,
        interventions,
      };
    }
    return {
      action: 'WATCH_PROCESS',
      reason: 'An observable process is running: watch it to termination rather than scheduling a delayed check.',
      pollSeconds,
      interventions,
    };
  }
  return {
    action: 'CONTINUE',
    reason: `The requested outcome is ${input.intendedOutcome} and the task is at ${input.reached ?? 'nothing yet'}. Continue.`,
    pollSeconds: null,
    interventions,
  };
}

/** Rule 9. Pure over counts the caller read. */
export function idleCheck(input: {
  executableWork: number;
  eligibleCapacity: number;
  activeWork: number;
  safeTarget: number;
}): { idle: boolean; reason: string } {
  const idle =
    input.executableWork > 0 && input.eligibleCapacity > 0 && input.activeWork < input.safeTarget;
  return {
    idle,
    reason: idle
      ? `${input.executableWork} executable item(s), ${input.eligibleCapacity} eligible surface(s), ${input.activeWork} active against a target of ${input.safeTarget}: capacity is unexplainedly idle.`
      : 'No unexplained idle: either nothing is executable, nothing can run it, or capacity is at its target.',
  };
}

/* ------------------------------------------------------------------------- */
/* Blockers (rule 7)                                                          */
/* ------------------------------------------------------------------------- */

export function classifyBlocker(input: {
  kind: BlockerKind;
  statement: string;
  checked: readonly string[];
}): { accepted: boolean; needsHuman: boolean; reason: string } {
  const needsHuman = HUMAN_BLOCKER_KINDS.includes(input.kind);
  if (!needsHuman) {
    return {
      accepted: true,
      needsHuman: false,
      reason: `${input.kind} is resolved by Brain or the worker, not a person: ${
        input.kind === 'AUTO_WAIT' || input.kind === 'EXTERNAL_SERVICE' ? 'wait and re-ask' : input.kind === 'RETRYABLE' ? 'retry' : 'fix it'
      }.`,
    };
  }
  const consulted = input.checked.filter((source) =>
    (SELF_ANSWERABLE_SOURCES as readonly string[]).includes(source),
  );
  if (input.kind !== 'MISSING_AUTHORITY' && consulted.length === 0) {
    return {
      accepted: false,
      needsHuman: false,
      reason:
        'Rule 7: a question for a person must first be looked up where Brain can know it — name what you checked ' +
        `(${SELF_ANSWERABLE_SOURCES.join(', ')}).`,
    };
  }
  return { accepted: true, needsHuman: true, reason: `${input.kind} is a person's to answer.` };
}

/* ------------------------------------------------------------------------- */
/* Evidence reading                                                           */
/* ------------------------------------------------------------------------- */

export interface EvidenceObservation {
  status: EvidenceStatus;
  source: EvidenceSource;
  evidenceRef: string;
  codeSha: string | null;
  configFingerprint: string | null;
  provenAt: string;
  validUntil: string | null;
  invalidationScope: string[];
  createdAt: string;
}

export interface EvidenceReading {
  status: EvidenceStatus;
  sourceKind: EvidenceSource | null;
  evidenceRef: string | null;
  provenAt: string | null;
  codeSha: string | null;
  configFingerprint: string | null;
  stillValidBecause: string;
  invalidatedBy: string[];
  observations: number;
}

/**
 * The current reading of a property: the newest observation of the strongest
 * source present. So a real production PROVEN is not undone by a later
 * synthetic FAILED, but a later real FAILED undoes an earlier real PROVEN — and
 * a STALE row (an explicit invalidation) at the strongest rank ends it.
 */
export function readEvidence(
  observations: readonly EvidenceObservation[],
  now: string,
  currentFingerprint?: string | null,
): EvidenceReading {
  if (observations.length === 0) {
    return {
      status: 'UNKNOWN',
      sourceKind: null,
      evidenceRef: null,
      provenAt: null,
      codeSha: null,
      configFingerprint: null,
      stillValidBecause: 'Nothing has observed this property.',
      invalidatedBy: [],
      observations: 0,
    };
  }
  const best = Math.max(...observations.map((o) => sourceRank(o.source)));
  const top = observations
    .filter((o) => sourceRank(o.source) === best)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0]!;
  let status = top.status;
  let because = `Newest ${top.source} observation (${top.evidenceRef}).`;
  if (status === 'PROVEN' && top.validUntil && top.validUntil <= now) {
    status = 'STALE';
    because = `It was valid until ${top.validUntil}.`;
  } else if (
    status === 'PROVEN' &&
    currentFingerprint &&
    top.configFingerprint &&
    currentFingerprint !== top.configFingerprint
  ) {
    status = 'STALE';
    because = `The configuration it was proven under (${top.configFingerprint}) is not the current one (${currentFingerprint}).`;
  } else if (status === 'PROVEN') {
    because = `Proven by ${top.source} at ${top.provenAt}; nothing in its invalidation scope has been recorded since.`;
  }
  return {
    status,
    sourceKind: top.source,
    evidenceRef: top.evidenceRef,
    provenAt: top.provenAt,
    codeSha: top.codeSha,
    configFingerprint: top.configFingerprint,
    stillValidBecause: because,
    invalidatedBy: top.invalidationScope,
    observations: observations.length,
  };
}

/** Property keys Brain derives, so a worker never has to spell them from memory. */
export function fullGateKey(sha: string, backend: 'sqlite' | 'postgres'): string {
  return `FULL_GATE:${sha}:${backend}`;
}

/* ------------------------------------------------------------------------- */
/* What a Factory bin carries                                                 */
/* ------------------------------------------------------------------------- */

export interface BinEngineeringEnvelope {
  policyVersion: number;
  riskTier: RiskTier;
  testPolicy: { commands: string[]; reasons: string[]; fullSuite: false; refused: string };
  contractVerification: string[];
  doneWhen: string;
  authority: string;
  mechanismHint: string;
  parallelism: string;
  consult: string[];
}

export const ENGINEERING_POLICY_VERSION = 1;

/**
 * The envelope every Factory bin carries, so a new worker inherits the same
 * engineering policy the moment it is handed work rather than inventing its own
 * rigor. It never contradicts the contract: the contract's verification
 * commands are what Brain judges the merged tree by, and they stay required.
 */
export function factoryEnvelope(input: {
  role: string;
  paths: readonly string[];
  verificationCommands: readonly string[];
}): BinEngineeringEnvelope {
  const policy = testPolicy({ changedPaths: input.paths, proposesFullSuite: true });
  const done: Record<string, string> = {
    PLAN: 'a validated plan is submitted for this bin',
    IMPLEMENT: 'every unit has a pushed branch the forge confirms and a submitted result',
    INTEGRATE: 'the integration branch carries every unit and the contract commands pass on the merged tree',
    REVIEW: 'a verdict is submitted from the reviewed commit',
    DELIVER: 'the pull request exists at the integrated commit',
  };
  return {
    policyVersion: ENGINEERING_POLICY_VERSION,
    riskTier: policy.tier,
    testPolicy: {
      commands: policy.commands,
      reasons: policy.reasons,
      fullSuite: false,
      refused: policy.fullSuiteRefused ?? 'The full gate runs once, in CI, on the released SHA.',
    },
    contractVerification: [...input.verificationCommands],
    doneWhen: done[input.role] ?? 'the bin\'s stopping conditions hold',
    authority:
      'Routine engineering inside the declared paths needs no person. New repositories, secrets, credentials, ' +
      'spending, scope widening and protected merges do.',
    mechanismHint:
      'Before creating a scheduler, queue, verifier, auth layer, retry system or orchestration mechanism, call ' +
      'brain_duplicate_mechanism_check — Brain almost certainly has an owner to extend.',
    parallelism: 'Units in one bin are independent by construction; implement them concurrently.',
    consult: [
      'brain_engineering_preflight before starting',
      'brain_evidence_lookup before proving anything again',
      'brain_test_policy before running tests',
      'brain_next_engineering_action before stopping or waiting',
    ],
  };
}
