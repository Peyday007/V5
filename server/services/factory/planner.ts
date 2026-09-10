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
  getUnitByKey,
  listUnits,
  pathsOverlap,
  promoteReadyUnits,
  refreshDownstreamCounts,
} from '../../repos/factory.ts';
import { recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { narrowsOrEqual } from './contract.ts';

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

  if (typeof proposed !== 'object' || proposed === null || Array.isArray(proposed)) {
    return { ok: false, units: [], errors: ['The plan is not an object.'], warnings, uncoveredConditions: [] };
  }
  const raw = (proposed as { units?: unknown }).units;
  if (!Array.isArray(raw)) {
    return { ok: false, units: [], errors: ['The plan has no `units` array.'], warnings, uncoveredConditions: [] };
  }
  if (raw.length === 0) {
    return { ok: false, units: [], errors: ['The plan has no units.'], warnings, uncoveredConditions: [] };
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
    for (const path of ownedPaths) {
      if (path.startsWith('/') || path.includes('..')) {
        errors.push(`${key}: \`${path}\` climbs or is absolute.`);
      }
    }
    if (ownedPaths.length > 0 && !narrowsOrEqual(ownedPaths, changeRequest.mutationScope)) {
      errors.push(
        `${key}: owns paths outside the approved mutation scope. A plan cannot widen the ` +
          'authority of the change request it implements.',
      );
    }

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
    if (dependsOn.includes(key)) errors.push(`${key}: depends on itself.`);

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

  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (!keys.has(dependency)) {
        errors.push(`${unit.key}: depends on \`${dependency}\`, which the plan does not define.`);
      }
    }
  }

  const cycle = detectCycle(units);
  if (cycle) {
    errors.push(`The plan has a dependency cycle: ${cycle.join(' -> ')}.`);
  }

  // Overlap is not fatal. The claim loop serialises overlapping units correctly;
  // what it costs is the parallelism the plan thought it had, so it is reported
  // rather than refused.
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (!a || !b) continue;
      if (a.dependsOn.includes(b.key) || b.dependsOn.includes(a.key)) continue;
      if (pathsOverlap(a.ownedPaths, b.ownedPaths)) {
        warnings.push(
          `${a.key} and ${b.key} own overlapping paths and do not depend on each other; they ` +
            'will be serialised rather than run in parallel.',
        );
      }
    }
  }

  const served = new Set(units.flatMap((unit) => unit.serves));
  const uncoveredConditions = changeRequest.acceptanceConditions
    .filter((condition) => condition.mandatory && !served.has(condition.id))
    .map((condition) => condition.id);

  return { ok: errors.length === 0, units, errors, warnings, uncoveredConditions };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
}

function detectCycle(units: UnitSpec[]): string[] | null {
  const edges = new Map(units.map((unit) => [unit.key, unit.dependsOn]));
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    const mark = state.get(key);
    if (mark === 'DONE') return null;
    if (mark === 'VISITING') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'VISITING');
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      if (!edges.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 'DONE');
    return null;
  };

  for (const unit of units) {
    const cycle = visit(unit.key);
    if (cycle) return cycle;
  }
  return null;
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
  options: { priorityBase?: number } = {},
): Promise<InstallResult> {
  let created = 0;
  let existing = 0;

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

/**
 * A short description of the repository for the architect.
 *
 * Gathered by the factory rather than asked for, and deliberately small: an
 * architect that has to read the whole tree before proposing anything spends its
 * context on orientation instead of on the decomposition.
 */
export async function repositoryNotes(campaignId: string): Promise<string> {
  const units = await listUnits(campaignId);
  if (units.length === 0) return '';
  return units.map((unit) => `- ${unit.unitKey}: ${unit.title}`).join('\n');
}
