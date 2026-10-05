/**
 * A plan is a proposal. The server decides whether it is one.
 *
 * §8's rule and §24's rule, at the factory: a model proposes units, and nothing
 * it proposed becomes a row until this module has checked every part of it
 * against the contract a person approved. The checks are deliberately fatal —
 * one bad unit refuses the whole plan — because a partially-installed plan is a
 * dependency graph with holes in it, and a campaign built on one would run
 * happily and produce something nobody asked for.
 *
 * What the validation is actually protecting:
 *
 *   * **Verification commands are chosen, never invented.** A unit's commands
 *     must be a subset of the ones derived from the repository's own scripts. A
 *     model that could name a command could name any command, and the factory
 *     runs them.
 *   * **Owned paths stay inside the approved mutation scope.** A change request
 *     cannot widen its own authority, and a plan is part of the change request's
 *     execution rather than a second grant.
 *   * **The graph is a graph.** Unknown dependency keys, self-edges and cycles
 *     are refused here, because a cycle discovered at run time is a campaign
 *     that waits forever and calls it "blocked on dependencies".
 *   * **Ownership overlap is reported.** Two units that can write the same file
 *     will be serialised by the claim loop; that is safe but wasteful, so the
 *     plan says so and the architect can split differently.
 *   * **Every unit can finish.** A unit whose completion needs a file a unit
 *     *waiting for it* owns is a deadlock that looks like a busy campaign. The
 *     graph questions — scope, forbidden paths, unknown edges, cycles, overlap,
 *     and that one — are asked by `ownership.ts`, the single validator repair
 *     creation and every replan also go through, and a fixable deadlock is
 *     rewritten (the file moved, or the units merged) before anything is
 *     installed. The rewrite is returned beside the plan and recorded as an
 *     event when the plan is installed, so a reader can see what the factory
 *     changed and why.
 */
import type {
  FactoryChangeRequest,
  FactoryModelClass,
  FactoryRiskClass,
  FactoryUnitKind,
} from '../../domain/factory.ts';
import {
  addDependency,
  ensureUnit,
  findDependencyCycle,
  getCampaign,
  getChangeRequest,
  getUnitByKey,
  promoteReadyUnits,
  refreshDownstreamCounts,
} from '../../repos/factory.ts';
import { recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { forbiddenPathsFor } from './forbidden.ts';
import { FactoryError } from './errors.ts';
import {
  rewritePlanGraph,
  validateUnitGraph,
  type OwnershipIssue,
  type PlanRewrite,
} from './ownership.ts';

/** The only shape a proposed unit may have. An unknown field refuses the plan. */
export interface UnitSpec {
  key: string;
  kind: FactoryUnitKind;
  title: string;
  objective: string;
  acceptance: string[];
  ownedPaths: string[];
  requiredContext: string[];
  verification: string[];
  expectedArtifact: string;
  risk: FactoryRiskClass;
  criticalPath: boolean;
  modelClass: FactoryModelClass;
  dependsOn: string[];
  /** Which acceptance conditions this unit serves. */
  serves: string[];
}

const ALLOWED_UNIT_FIELDS = new Set([
  'key',
  'kind',
  'title',
  'objective',
  'acceptance',
  'ownedPaths',
  'requiredContext',
  'verification',
  'expectedArtifact',
  'risk',
  'criticalPath',
  'modelClass',
  'dependsOn',
  'serves',
]);

const PLANNABLE_KINDS: FactoryUnitKind[] = [
  'INTERFACE',
  'IMPLEMENTATION',
  'TEST',
  'MIGRATION',
  'DOCS',
];

export interface PlanValidation {
  ok: boolean;
  units: UnitSpec[];
  errors: string[];
  warnings: string[];
  /** Conditions no unit claims to serve. Not fatal here; fatal at the packet check. */
  uncoveredConditions: string[];
  /** The graph verdict, typed, after any rewrite. `errors` carries the same in words. */
  issues: OwnershipIssue[];
  /** What the factory changed about the proposed graph to make it completable, in order. */
  rewrites: PlanRewrite[];
}

export const MAX_PLAN_UNITS = 24;

/**
 * Validate a proposed plan against the contract.
 *
 * Returns every error rather than the first, because an architect that has to
 * discover its mistakes one round trip at a time spends the campaign's time on
 * the factory's pedantry.
 */
export function validatePlan(
  proposed: unknown,
  changeRequest: FactoryChangeRequest,
  options: { maxUnits?: number } = {},
): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxUnits = options.maxUnits ?? MAX_PLAN_UNITS;
  /*
   * What no unit may own here: the universal set, plus anything this repository's
   * own grant adds.
   *
   * It used to be the grant's list *or nothing*, so a repository with no grant
   * forbade nothing — the local bootstrap path, and also every future repository
   * whose grant forgot to restate the list. A protection that is copied per
   * repository is one that will be missing from one of them, so it moved into the
   * envelope as a floor a grant may add to and cannot subtract from.
   */
  const forbiddenHere = forbiddenPathsFor(changeRequest.repository);

  if (typeof proposed !== 'object' || proposed === null || Array.isArray(proposed)) {
    return { ok: false, units: [], errors: ['The plan is not an object.'], warnings, uncoveredConditions: [], issues: [], rewrites: [] };
  }
  const raw = (proposed as { units?: unknown }).units;
  if (!Array.isArray(raw)) {
    return { ok: false, units: [], errors: ['The plan has no `units` array.'], warnings, uncoveredConditions: [], issues: [], rewrites: [] };
  }
  if (raw.length === 0) {
    return { ok: false, units: [], errors: ['The plan has no units.'], warnings, uncoveredConditions: [], issues: [], rewrites: [] };
  }
  if (raw.length > maxUnits) {
    errors.push(`The plan has ${raw.length} units; the ceiling is ${maxUnits}.`);
  }

  const units: UnitSpec[] = [];
  const keys = new Set<string>();

  raw.forEach((entry, index) => {
    const where = `unit ${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${where} is not an object.`);
      return;
    }
    const record = entry as Record<string, unknown>;

    for (const field of Object.keys(record)) {
      if (!ALLOWED_UNIT_FIELDS.has(field)) {
        errors.push(`${where} has an unknown field \`${field}\`.`);
      }
    }

    const key = String(record['key'] ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(key)) {
      errors.push(`${where} has an unusable key \`${key}\`; use a kebab-case slug.`);
      return;
    }
    if (keys.has(key)) {
      errors.push(`${where} repeats the key \`${key}\`.`);
      return;
    }
    keys.add(key);

    const kind = String(record['kind'] ?? '') as FactoryUnitKind;
    if (!PLANNABLE_KINDS.includes(kind)) {
      errors.push(`${key}: \`${kind}\` is not a kind a plan may create.`);
    }

    const objective = String(record['objective'] ?? '').trim();
    if (objective.length < 24) {
      errors.push(`${key}: the objective does not say enough for a worker to act on.`);
    }

    const acceptance = asStringArray(record['acceptance']);
    if (acceptance.length === 0) {
      errors.push(`${key}: no acceptance statements. A unit nobody can judge is not a unit.`);
    }

    const ownedPaths = asStringArray(record['ownedPaths']);
    if (ownedPaths.length === 0) {
      errors.push(`${key}: owns no paths, so the integrator cannot hold its diff to anything.`);
    }
    // Climbing, the approved scope and the forbidden list are graph questions,
    // asked once for every unit by `validateUnitGraph` below.

    const verification = asStringArray(record['verification']);
    for (const command of verification) {
      if (!changeRequest.verificationCommands.includes(command)) {
        errors.push(
          `${key}: \`${command}\` is not one of the repository's verification commands. A plan ` +
            'chooses from them; it does not invent them.',
        );
      }
    }

    const dependsOn = asStringArray(record['dependsOn']);

    const risk = String(record['risk'] ?? 'MEDIUM') as FactoryRiskClass;
    const modelClass = String(record['modelClass'] ?? 'FAST') as FactoryModelClass;

    units.push({
      key,
      kind: PLANNABLE_KINDS.includes(kind) ? kind : 'IMPLEMENTATION',
      title: String(record['title'] ?? key).slice(0, 200),
      objective,
      acceptance,
      ownedPaths,
      requiredContext: asStringArray(record['requiredContext']),
      verification,
      expectedArtifact: String(record['expectedArtifact'] ?? '').slice(0, 500),
      risk: (['LOW', 'MEDIUM', 'HIGH'] as string[]).includes(risk) ? risk : 'MEDIUM',
      criticalPath: record['criticalPath'] === true,
      modelClass: modelClass === 'STRONGEST' ? 'STRONGEST' : 'FAST',
      dependsOn,
      serves: asStringArray(record['serves']),
    });
  });

  /*
   * The graph, asked of the one validator and rewritten where a deadlock can be
   * removed without inventing the plan. Run even when a unit already failed its
   * own checks, so the architect hears every error in one round trip.
   */
  const ctx = { mutationScope: changeRequest.mutationScope, forbiddenPaths: forbiddenHere };
  const rewritten = rewritePlanGraph(units, ctx);
  const finalUnits = errors.length === 0 ? rewritten.units : units;
  const verdict = errors.length === 0 ? rewritten.verdict : validateUnitGraph(units, ctx);
  const rewrites = errors.length === 0 ? rewritten.rewrites : [];
  for (const issue of verdict.issues) {
    if (issue.fatal) errors.push(issue.detail);
    else warnings.push(issue.detail);
  }
  for (const rewrite of rewrites) warnings.push(`Rewritten: ${rewrite.detail}`);

  const served = new Set(finalUnits.flatMap((unit) => unit.serves));
  const uncoveredConditions = changeRequest.acceptanceConditions
    .filter((condition) => condition.mandatory && !served.has(condition.id))
    .map((condition) => condition.id);

  return {
    ok: errors.length === 0,
    units: finalUnits,
    errors,
    warnings,
    uncoveredConditions,
    issues: verdict.issues,
    rewrites,
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
}

/* ------------------------------------------------------------------------- */
/* Installing                                                                 */
/* ------------------------------------------------------------------------- */

export interface InstallResult {
  created: number;
  existing: number;
  promoted: number;
  cycle: string[] | null;
}

/**
 * Write a validated plan into the campaign.
 *
 * Idempotent by unit key, so a tick that runs twice, a resumed planner and a
 * crash between the units and their edges all converge on the same graph rather
 * than forking it. The cycle check runs again over the *installed* rows, because
 * a repair unit added later could close a loop the original plan did not have.
 */
export async function installPlan(
  campaignId: string,
  units: UnitSpec[],
  options: { priorityBase?: number; rewrites?: PlanRewrite[] } = {},
): Promise<InstallResult> {
  let created = 0;
  let existing = 0;

  /*
   * The same validator again, over exactly what is about to become rows. Every
   * caller ran `validatePlan` first; this is what makes a caller that did not —
   * or a retry carrying the proposal rather than the validation — unable to
   * install a graph a worker could never finish. Refused whole, before a row.
   */
  const campaign = await getCampaign(campaignId);
  const changeRequest = campaign ? await getChangeRequest(campaign.changeRequestId) : null;
  if (changeRequest) {
    const verdict = validateUnitGraph(units, {
      mutationScope: changeRequest.mutationScope,
      forbiddenPaths: changeRequest.repository ? forbiddenPathsFor(changeRequest.repository) : [],
    });
    const fatal = verdict.issues.filter((issue) => issue.fatal);
    if (fatal.length > 0) {
      throw new FactoryError(
        `The plan cannot be installed: ${fatal.map((issue) => `${issue.reason} — ${issue.detail}`).join(' ')}`,
        { issues: fatal },
      );
    }
  }

  /*
   * What the factory changed about the proposal, recorded once per campaign:
   * a plan is installed exactly once (every later call finds its units), so a
   * rewrite is written only on the call that creates the first unit.
   */
  const firstInstall = units.length > 0 && !(await getUnitByKey(campaignId, units[0]!.key));

  for (const spec of units) {
    const { unit, created: isNew } = await ensureUnit({
      campaignId,
      unitKey: spec.key,
      kind: spec.kind,
      role: spec.kind === 'INTERFACE' ? 'IMPLEMENTER' : 'IMPLEMENTER',
      title: spec.title,
      objective: spec.objective,
      acceptance: spec.acceptance,
      ownedPaths: spec.ownedPaths,
      requiredContext: spec.requiredContext,
      verification: spec.verification,
      expectedArtifact: spec.expectedArtifact,
      risk: spec.risk,
      criticalPath: spec.criticalPath,
      priority: (options.priorityBase ?? 5) + (spec.criticalPath ? 2 : 0),
      modelClass: spec.modelClass,
      maxAttempts: spec.risk === 'HIGH' ? 4 : 3,
      state: 'BLOCKED',
    });
    if (isNew) {
      created += 1;
      await recordFactoryEvent({
        campaignId,
        unitId: unit.id,
        kind: FACTORY_EVENT_KINDS.unitPlanned,
        evidenceClass: 'MEASURED',
        detail: {
          unitKey: spec.key,
          kind: spec.kind,
          ownedPaths: spec.ownedPaths,
          dependsOn: spec.dependsOn,
          serves: spec.serves,
          criticalPath: spec.criticalPath,
        },
      });
    } else {
      existing += 1;
    }
  }

  for (const spec of units) {
    const unit = await getUnitByKey(campaignId, spec.key);
    if (!unit) continue;
    for (const dependencyKey of spec.dependsOn) {
      const dependency = await getUnitByKey(campaignId, dependencyKey);
      if (!dependency) continue;
      await addDependency(campaignId, unit.id, dependency.id, `${spec.key} needs ${dependencyKey}`);
    }
  }

  if (firstInstall && created > 0) {
    for (const rewrite of options.rewrites ?? []) {
      await recordFactoryEvent({
        campaignId,
        kind: FACTORY_EVENT_KINDS.planRewritten,
        evidenceClass: 'DERIVED',
        detail: {
          action: rewrite.action,
          reason: rewrite.reason,
          from: rewrite.from,
          to: rewrite.to,
          paths: rewrite.paths,
          detail: rewrite.detail,
        },
      });
    }
  }

  await refreshDownstreamCounts(campaignId);

  const cycle = await findDependencyCycle(campaignId);
  if (cycle) return { created, existing, promoted: 0, cycle };

  const promoted = await promoteReadyUnits(campaignId);
  for (const unit of promoted) {
    await recordFactoryEvent({
      campaignId,
      unitId: unit.id,
      kind: FACTORY_EVENT_KINDS.unitReady,
      evidenceClass: 'MEASURED',
      detail: { unitKey: unit.unitKey, reason: 'dependencies integrated' },
    });
  }

  return { created, existing, promoted: promoted.length, cycle: null };
}
