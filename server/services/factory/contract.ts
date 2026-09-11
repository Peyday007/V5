/**
 * The change request, and what may and may not happen to it afterwards.
 *
 * A person supplies the objective, the outcome they expect, what is out of
 * scope, and the conditions that would convince them it worked. They are asked
 * for nothing else. Every technical field on the contract — the repository, the
 * commit to pin, the mutation scope, the verification commands, the rollback
 * requirement — is derived here from the repository and the objective, because
 * a form that asks a person to configure a factory is a form they will fill in
 * wrongly and then trust.
 *
 * The one rule this module exists to enforce: **the factory may clarify its own
 * implementation and may never redefine success.** Objective, expected outcome
 * and the acceptance conditions already approved are immutable to a FACTORY
 * actor. A person may change them, and when they do it is an amendment carrying
 * both values, the reason, the affected units and a re-verification
 * requirement — because work already judged against the old contract has not
 * been judged against the new one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  FactoryAcceptanceCondition,
  FactoryAmendment,
  FactoryChangeRequest,
  FactoryDeploymentPolicy,
  FactoryEnvironment,
  FactoryRiskClass,
} from '../../domain/factory.ts';
import {
  approveChangeRequest,
  ensureChangeRequest,
  getChangeRequest,
  recordAmendment,
} from '../../repos/factory.ts';
import { recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { inspectRepository } from './git.ts';
import { FACTORY_DEFAULT_REPO_ROOT } from '../../env.ts';

/** A contract field nothing but a person may change. */
export const IMMUTABLE_FIELDS = [
  'objective',
  'expected_outcome',
  'acceptance_conditions',
  'external_spend_policy',
  'deployment_policy',
  'approved_via',
  'approved_by_user_id',
] as const;

export type ImmutableField = (typeof IMMUTABLE_FIELDS)[number];

export function isImmutableField(field: string): field is ImmutableField {
  return (IMMUTABLE_FIELDS as readonly string[]).includes(field);
}

export class ContractError extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'ContractError';
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------------- */
/* What a person supplies                                                     */
/* ------------------------------------------------------------------------- */

export interface ObjectiveSubmission {
  projectId: string;
  objective: string;
  expectedOutcome: string;
  nonGoals?: string[];
  /**
   * The conditions that decide whether it worked.
   *
   * Optional in the submission and mandatory before implementation: when a
   * person does not supply them the architect derives them and they are recorded
   * as an amendment before any unit is claimable. What is never allowed is
   * implementation starting while the contract has none.
   */
  acceptanceConditions?: { statement: string; verification: string; mandatory?: boolean }[];
  /** Defaults to the repository this server is running from. */
  repositoryRoot?: string;
  /** Defaults to a digest of the objective, so resubmitting the same ask collides. */
  submissionKey?: string;
  environment?: FactoryEnvironment;
  deploymentPolicy?: FactoryDeploymentPolicy;
  riskClass?: FactoryRiskClass;
  /** Narrow the factory's reach below what the repository would allow. */
  mutationScope?: string[];
}

/**
 * A stable identity for "this ask", so two submissions of it are one.
 *
 * Derived from the project and the objective's own text, normalised for
 * whitespace and case. A person who presses the button twice, a retried HTTP
 * request and a redelivered queue item therefore all collide on the row that
 * already exists rather than forking the work.
 */
export function submissionKeyFor(projectId: string, objective: string): string {
  const normalised = objective.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(`${projectId}\n${normalised}`).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------------- */
/* What Brain derives                                                         */
/* ------------------------------------------------------------------------- */

export interface DerivedDefaults {
  repository: string;
  /** The checkout the pin came from, so a later tick uses the same one. */
  repositoryRoot: string;
  baseBranch: string;
  baseSha: string;
  mutationScope: string[];
  verificationCommands: string[];
  rollbackRequirement: string;
  riskClass: FactoryRiskClass;
}

/**
 * What the repository itself says the safe defaults are.
 *
 * The verification commands come from the repository's own scripts, in the order
 * a contributor would run them: the cheapest check that can fail first. A
 * factory that invented its own commands would verify something the project does
 * not actually require, and pass.
 */
export async function deriveDefaults(
  submission: ObjectiveSubmission,
): Promise<DerivedDefaults> {
  const root = path.resolve(submission.repositoryRoot ?? FACTORY_DEFAULT_REPO_ROOT);
  /*
   * No checkout, no pin — said in those words rather than as a git error.
   *
   * A deployed Brain deliberately contains no repository: `.git` is in
   * `.dockerignore`, and the image is copied to registries and pulled by
   * machines nobody here controls. So `inspectRepository` throws there, and it
   * used to throw straight through the HTTP route as a 500 carrying git's own
   * complaint — which tells a caller that something broke when in fact the
   * server did exactly what it should and simply cannot answer this request.
   *
   * A ContractError instead, naming the remedy and not the path. The path is
   * server-controlled (§18: a request never chooses a location), and a refusal
   * that prints it hands a caller a fact about the filesystem they did not have.
   */
  let state;
  try {
    state = await inspectRepository(root);
  } catch (error: unknown) {
    throw new ContractError(
      'This Brain has no repository checkout to pin a base commit against, so it cannot ' +
        'accept an objective. Submit where the repository is: a campaign needs a real commit ' +
        'to pin and a worker with that commit in front of it.',
      { reason: 'NO_REPOSITORY_CHECKOUT', cause: error instanceof Error ? error.name : 'unknown' },
    );
  }

  const commands: string[] = [];
  const packageJsonPath = path.join(root, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
    // Ordered cheapest-first so a campaign learns it is broken as early as it can.
    for (const candidate of ['typecheck', 'lint']) {
      if (scripts[candidate]) commands.push(`npm run ${candidate}`);
    }
    if (scripts['test']) commands.push('npm test');
    if (scripts['build']) commands.push('npm run build');
  }

  return {
    repository: state.remote ?? root,
    // The path that was actually inspected, so a later tick operates on the
    // checkout this pin came from rather than on whatever the caller defaults to.
    repositoryRoot: root,
    baseBranch: state.branch,
    baseSha: state.headSha,
    // Everything under version control, narrowed by the submission if it asked
    // for less. The factory never widens its own reach: a scope the submission
    // did not grant is not available by deriving it.
    mutationScope: submission.mutationScope ?? ['**'],
    verificationCommands: commands,
    rollbackRequirement:
      'Every change lands as commits on a campaign branch that is never merged to the ' +
      'protected branch by the factory. Rolling back is declining the pull request, or ' +
      'reverting the merge commit if a person has already taken it.',
    riskClass: submission.riskClass ?? inferRisk(submission.objective),
  };
}

/**
 * A coarse risk reading from the objective's own words.
 *
 * Coarse on purpose: risk here decides how much verification a unit carries and
 * how many attempts it gets, and the expensive mistake is reading a schema
 * change as low risk. Anything that mentions migrations, authorization or
 * deployment is HIGH whatever else it says.
 */
export function inferRisk(objective: string): FactoryRiskClass {
  const text = objective.toLowerCase();
  if (/migration|schema|auth|credential|deploy|production|delete|drop table/.test(text)) {
    return 'HIGH';
  }
  if (/refactor|rename|endpoint|route|scheduler|queue|lease/.test(text)) return 'MEDIUM';
  return 'LOW';
}

/**
 * Acceptance conditions, validated.
 *
 * A condition must say what is true when it works *and* how a reader could
 * check it. One without a check is an intention, and a factory judged against
 * intentions passes every time.
 */
export function validateConditions(
  conditions: { statement: string; verification: string; mandatory?: boolean }[],
): FactoryAcceptanceCondition[] {
  const validated: FactoryAcceptanceCondition[] = [];
  const seen = new Set<string>();
  conditions.forEach((condition, index) => {
    const statement = condition.statement.trim();
    const verification = condition.verification.trim();
    if (statement.length < 8) {
      throw new ContractError(`Acceptance condition ${index + 1} does not say anything testable.`);
    }
    if (verification.length < 4) {
      throw new ContractError(
        `Acceptance condition ${index + 1} has no verification. A condition nobody could ` +
          'check is not an acceptance condition.',
      );
    }
    const id = `A${String(index + 1).padStart(2, '0')}`;
    if (seen.has(id)) throw new ContractError(`Duplicate acceptance condition id ${id}.`);
    seen.add(id);
    validated.push({
      id,
      statement,
      verification,
      mandatory: condition.mandatory ?? true,
    });
  });
  return validated;
}

/* ------------------------------------------------------------------------- */
/* Submitting and approving                                                   */
/* ------------------------------------------------------------------------- */

export interface SubmissionResult {
  changeRequest: FactoryChangeRequest;
  created: boolean;
  derived: DerivedDefaults;
}

/**
 * Record the ask, deriving everything a person should not have to supply.
 *
 * Idempotent by submission key, and the *same* change request is returned when
 * the ask already exists — including when its derived fields would be different
 * now, because a pinned base that moved because somebody resubmitted would make
 * the pin meaningless.
 */
export async function submitObjective(
  submission: ObjectiveSubmission,
): Promise<SubmissionResult> {
  const objective = submission.objective.trim();
  const expectedOutcome = submission.expectedOutcome.trim();
  if (objective.length < 12) {
    throw new ContractError('An objective needs to say what should become true.');
  }
  if (expectedOutcome.length < 8) {
    throw new ContractError(
      'An expected outcome needs to say what a person would see differently afterwards.',
    );
  }

  const derived = await deriveDefaults(submission);
  const conditions = validateConditions(submission.acceptanceConditions ?? []);
  const submissionKey =
    submission.submissionKey ?? submissionKeyFor(submission.projectId, objective);

  const { changeRequest, created } = await ensureChangeRequest({
    projectId: submission.projectId,
    submissionKey,
    objective,
    expectedOutcome,
    nonGoals: submission.nonGoals ?? [],
    acceptanceConditions: conditions,
    repository: derived.repository,
    repositoryRoot: derived.repositoryRoot,
    baseBranch: derived.baseBranch,
    baseSha: derived.baseSha,
    environment: submission.environment ?? 'LOCAL',
    riskClass: derived.riskClass,
    mutationScope: derived.mutationScope,
    deploymentPolicy: submission.deploymentPolicy ?? 'NONE',
    rollbackRequirement: derived.rollbackRequirement,
    verificationCommands: derived.verificationCommands,
  });

  await recordFactoryEvent({
    kind: created ? 'CHANGE_REQUEST_CREATED' : 'CHANGE_REQUEST_DEDUPED',
    evidenceClass: 'MEASURED',
    detail: {
      changeRequestId: changeRequest.id,
      submissionKey,
      baseSha: changeRequest.baseSha,
      conditions: changeRequest.acceptanceConditions.length,
    },
  });

  return { changeRequest, created, derived };
}

/**
 * The first of a person's two actions.
 *
 * Approval is what makes the objective and its conditions immutable, so it is
 * refused when there is nothing to freeze: a change request with no acceptance
 * condition could be approved and then have success defined for it afterwards,
 * which is the loophole this whole module exists to close.
 */
export async function approveObjective(input: {
  changeRequestId: string;
  via: 'PERSON' | 'STANDING_AUTHORITY';
  userId: string | null;
  authorityId?: string | null;
}): Promise<{ ok: boolean; changeRequest: FactoryChangeRequest; reason?: string }> {
  const changeRequest = await getChangeRequest(input.changeRequestId);
  if (!changeRequest) throw new ContractError('No such change request.');
  if (changeRequest.state === 'APPROVED') {
    return { ok: true, changeRequest, reason: 'already approved' };
  }
  if (changeRequest.acceptanceConditions.length === 0) {
    return {
      ok: false,
      changeRequest,
      reason:
        'This change request has no acceptance conditions. Approving it would freeze an ' +
        'objective whose success is still undefined.',
    };
  }
  if (input.via === 'PERSON' && !input.userId) {
    return { ok: false, changeRequest, reason: 'A person approving has to be a person.' };
  }

  const moved = await approveChangeRequest({
    changeRequestId: input.changeRequestId,
    via: input.via,
    userId: input.userId,
    authorityId: input.authorityId ?? null,
  });
  const fresh = await getChangeRequest(input.changeRequestId);
  if (!fresh) throw new ContractError('The change request vanished while being approved.');

  await recordFactoryEvent({
    kind: 'CHANGE_REQUEST_APPROVED',
    evidenceClass: 'MEASURED',
    detail: {
      changeRequestId: fresh.id,
      via: input.via,
      conditions: fresh.acceptanceConditions.length,
      moved,
    },
  });
  return { ok: moved, changeRequest: fresh };
}

/* ------------------------------------------------------------------------- */
/* Amendments                                                                 */
/* ------------------------------------------------------------------------- */

export interface AmendRequest {
  changeRequestId: string;
  campaignId: string | null;
  field: string;
  newValue: unknown;
  reason: string;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
  affectedWork: string[];
}

const COLUMN_FOR_FIELD: Record<string, string> = {
  objective: 'objective',
  expected_outcome: 'expected_outcome',
  acceptance_conditions: 'acceptance_conditions',
  non_goals: 'non_goals',
  mutation_scope: 'mutation_scope',
  verification_commands: 'verification_commands',
  risk_class: 'risk_class',
  base_sha: 'base_sha',
  base_branch: 'base_branch',
  environment: 'environment',
  deployment_policy: 'deployment_policy',
  rollback_requirement: 'rollback_requirement',
};

const JSON_FIELDS = new Set([
  'acceptance_conditions',
  'non_goals',
  'mutation_scope',
  'verification_commands',
]);

/**
 * Change one field of an approved contract, or be refused.
 *
 * The refusals are the content of this function:
 *
 *   * A FACTORY actor cannot touch an immutable field. Not to clarify it, not to
 *     add a condition it would find easier to satisfy — the acceptance
 *     conditions a person approved are what the final verification reads, and a
 *     factory that could edit them would be grading its own exam.
 *   * A mutation scope can only narrow. Widening is how a campaign reaches
 *     outside what it was approved for, and "the factory may not grant itself
 *     additional authority" has to be true of the contract as well as of the
 *     deployment.
 *   * A verification command can only be added. Removing one removes the
 *     evidence, which is the same defect in a different place.
 *
 * Everything that is allowed is still recorded, with both values and the reason,
 * and everything that touches what success means requires re-verification.
 */
export async function amendContract(
  request: AmendRequest,
): Promise<{ ok: true; amendment: FactoryAmendment } | { ok: false; reason: string }> {
  const changeRequest = await getChangeRequest(request.changeRequestId);
  if (!changeRequest) return { ok: false, reason: 'No such change request.' };

  const column = COLUMN_FOR_FIELD[request.field];
  if (!column) return { ok: false, reason: `The contract has no amendable field ${request.field}.` };

  if (request.actorType === 'FACTORY' && isImmutableField(request.field)) {
    // The one exception, and it is an addition rather than a redefinition: a
    // contract approved with conditions keeps them, and the architect may only
    // derive conditions into one that has none.
    const derivingFirstConditions =
      request.field === 'acceptance_conditions' &&
      changeRequest.acceptanceConditions.length === 0;
    if (!derivingFirstConditions) {
      return {
        ok: false,
        reason:
          `${request.field} is part of what a person approved. The factory may clarify how it ` +
          'implements the objective; it may not change what counts as success.',
      };
    }
  }

  const before = currentValue(changeRequest, request.field);

  if (request.field === 'mutation_scope') {
    const next = request.newValue as string[];
    if (!Array.isArray(next)) return { ok: false, reason: 'A mutation scope is a list of globs.' };
    if (!narrowsOrEqual(next, changeRequest.mutationScope)) {
      return {
        ok: false,
        reason:
          'A mutation scope may only narrow. Reaching further than the approved scope is the ' +
          'factory granting itself authority.',
      };
    }
  }

  if (request.field === 'verification_commands') {
    const next = request.newValue as string[];
    if (!Array.isArray(next)) return { ok: false, reason: 'Verification commands are a list.' };
    const missing = changeRequest.verificationCommands.filter((c) => !next.includes(c));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Verification commands may only be added. This would drop: ${missing.join(', ')}.`,
      };
    }
  }

  const serialised = JSON_FIELDS.has(request.field)
    ? JSON.stringify(request.newValue ?? null)
    : String(request.newValue ?? '');

  const amendment = await recordAmendment({
    changeRequestId: request.changeRequestId,
    campaignId: request.campaignId,
    field: request.field,
    oldValue: before,
    newValue: serialised,
    reason: request.reason,
    actorType: request.actorType,
    actorId: request.actorId,
    affectedWork: request.affectedWork,
    // Anything that changes what success means, or what the work is built on,
    // invalidates a judgement already made against the old contract.
    requiresReverification:
      isImmutableField(request.field) ||
      request.field === 'base_sha' ||
      request.field === 'verification_commands',
    column,
    columnValue: serialised,
  });

  await recordFactoryEvent({
    campaignId: request.campaignId,
    kind: 'CONTRACT_AMENDED',
    evidenceClass: 'MEASURED',
    detail: {
      changeRequestId: request.changeRequestId,
      field: request.field,
      actorType: request.actorType,
      requiresReverification: amendment.requiresReverification,
      affectedWork: request.affectedWork.length,
    },
  });

  return { ok: true, amendment };
}

function currentValue(changeRequest: FactoryChangeRequest, field: string): string {
  switch (field) {
    case 'objective':
      return changeRequest.objective;
    case 'expected_outcome':
      return changeRequest.expectedOutcome;
    case 'acceptance_conditions':
      return JSON.stringify(changeRequest.acceptanceConditions);
    case 'non_goals':
      return JSON.stringify(changeRequest.nonGoals);
    case 'mutation_scope':
      return JSON.stringify(changeRequest.mutationScope);
    case 'verification_commands':
      return JSON.stringify(changeRequest.verificationCommands);
    case 'risk_class':
      return changeRequest.riskClass;
    case 'base_sha':
      return changeRequest.baseSha;
    case 'base_branch':
      return changeRequest.baseBranch;
    case 'environment':
      return changeRequest.environment;
    case 'deployment_policy':
      return changeRequest.deploymentPolicy;
    case 'rollback_requirement':
      return changeRequest.rollbackRequirement;
    default:
      return '';
  }
}

/**
 * Is every glob in `next` inside something `current` already allowed?
 *
 * The comparison is the same coarse prefix test the claim loop uses for
 * ownership, for the same reason: the expensive mistake is deciding a scope
 * narrowed when it actually reached somewhere new.
 */
export function narrowsOrEqual(next: string[], current: string[]): boolean {
  // A path that climbs or is absolute is outside every scope, including the one
  // that says `**`. `**` means everything in the repository, not everything on
  // the disk, and the difference is the whole of the containment guarantee.
  if (next.some((glob) => glob.startsWith('/') || glob.split('/').includes('..'))) return false;

  const stem = (glob: string): string => {
    const star = glob.indexOf('*');
    return star === -1 ? glob : glob.slice(0, star);
  };
  const allowed = current.map(stem);
  if (allowed.some((a) => a === '')) return true; // '**' allows everything in the tree
  return next.map(stem).every((n) => allowed.some((a) => n.startsWith(a)));
}
