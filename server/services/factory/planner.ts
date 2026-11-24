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
import { minimumModelClassOf } from '../../domain/engineeringDirector.ts';
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
  pathsOverlap,
  promoteReadyUnits,
  refreshDownstreamCounts,
} from '../../repos/factory.ts';
import { listFactoryEvents, recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { forbiddenPathsFor } from './forbidden.ts';
import { FactoryError } from './errors.ts';
import {
  isConcrete,
  isTestPath,
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
  /** How wide and how deep the plan is — the shape that decides how long DEVELOPMENT takes. */
  shape: PlanShape;
  /**
   * The shape warnings the architect has not yet answered. Non-empty means the
   * plan goes back to its architect once, before install, to be reshaped or to
   * say in `shapeReason` why the shape stands. Empty when the plan has no shape
   * warning or already carries a reason.
   */
  shapeFeedback: string[];
  /** The architect's stated reason the shape stands, when it gave one. */
  shapeReason: string | null;
}

/** The top-level plan field an architect answers shape feedback with when it keeps the shape. */
export const SHAPE_REASON_FIELD = 'shapeReason';
/** A reason shorter than this is not a reason. */
export const MIN_SHAPE_REASON_LENGTH = 24;

/**
 * The words that send a plan back to its architect for its one shape revision.
 *
 * The warnings were measured and then only logged on an already-installed plan,
 * so the serial chain and the oversized unit that held DEVELOPMENT at 44% of the
 * critical path (OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595) reached nobody
 * who could change them. This is what reaches the architect while it can.
 */
export function shapeRevisionRequest(feedback: string[]): string {
  return [
    'The plan is valid, but its shape makes DEVELOPMENT longer than the plan itself justifies:',
    ...feedback.map((line) => `- ${line}`),
    'Revise it once before it is installed: drop the dependency edges nothing reads, and split ' +
      'oversized units by file ownership into independent units that run in parallel sessions. ' +
      `If the shape is right as it is, resubmit the same plan with a top-level \`${SHAPE_REASON_FIELD}\` ` +
      `string (at least ${MIN_SHAPE_REASON_LENGTH} characters) saying why. Every other rule still applies.`,
  ].join('\n');
}

/**
 * The shape of a plan, measured rather than judged.
 *
 * DEVELOPMENT was the largest share of the measured engineering critical path
 * (OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595): every dependency edge costs a
 * whole implement-and-integrate round before the dependent unit can start, and a
 * unit that owns several modules is one long session where several short ones
 * could have run at once. Nothing here refuses a plan — a deep plan is sometimes
 * the honest one — but every validation reports the shape, and a chain or a unit
 * the plan itself gives no reason for comes back as a warning the architect reads.
 */
export interface PlanShape {
  unitCount: number;
  /** Units on the longest `dependsOn` chain; 1 when nothing waits for anything. */
  maxDepth: number;
  /** The most units that sit at one depth, i.e. that can be ready at once. */
  maxWidth: number;
  /** Concrete owned paths of the unit that owns the most. */
  largestUnitPaths: number;
  /** Distinct directories holding the non-test source files of the widest unit. */
  largestUnitModules: number;
  /** The longest chain, root first. */
  longestChain: string[];
}

const EMPTY_SHAPE: PlanShape = {
  unitCount: 0,
  maxDepth: 0,
  maxWidth: 0,
  largestUnitPaths: 0,
  largestUnitModules: 0,
  longestChain: [],
};

/** A unit owning at least this many non-test source files across two or more directories is one to split. */
export const OVERSIZED_UNIT_SOURCE_FILES = 3;

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
    return { ok: false, units: [], errors: ['The plan is not an object.'], warnings, uncoveredConditions: [], issues: [], rewrites: [], shape: EMPTY_SHAPE, shapeFeedback: [], shapeReason: null };
  }
  const raw = (proposed as { units?: unknown }).units;
  if (!Array.isArray(raw)) {
    return { ok: false, units: [], errors: ['The plan has no `units` array.'], warnings, uncoveredConditions: [], issues: [], rewrites: [], shape: EMPTY_SHAPE, shapeFeedback: [], shapeReason: null };
  }
  if (raw.length === 0) {
    return { ok: false, units: [], errors: ['The plan has no units.'], warnings, uncoveredConditions: [], issues: [], rewrites: [], shape: EMPTY_SHAPE, shapeFeedback: [], shapeReason: null };
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
      // An objective routed to the strongest class (§109) holds every unit there, whatever the plan said.
      modelClass: modelClass === 'STRONGEST' || minimumModelClassOf(changeRequest.objective) === 'STRONGEST' ? 'STRONGEST' : 'FAST',
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
  const rewriting = errors.length === 0;
  const finalUnits = rewriting ? rewritten.units : units;
  const verdict = rewriting ? rewritten.verdict : validateUnitGraph(units, ctx);
  const rewrites = rewriting ? rewritten.rewrites : [];
  for (const issue of verdict.issues) {
    // Not rewriting because of another error: a deadlock the factory would fix by
    // itself is not something to send the architect back for.
    if (!rewriting && issue.reason === 'MUTATION_OWNED_BY_DEPENDENT') continue;
    if (issue.fatal) errors.push(issue.detail);
    else warnings.push(issue.detail);
  }
  if (rewriting && rewritten.unresolved) {
    errors.push(
      'The factory could not rewrite this plan so that every unit can finish without one owning ' +
        'what another needs; restructure the units so no unit owns a file a unit it waits for must change.',
    );
  }
  for (const rewrite of rewrites) warnings.push(`Rewritten: ${rewrite.detail}`);

  const shaped = measurePlanShape(finalUnits);
  warnings.push(...shaped.warnings);
  const rawReason = (proposed as Record<string, unknown>)[SHAPE_REASON_FIELD];
  const reasonText = typeof rawReason === 'string' ? rawReason.trim() : '';
  const shapeReason = reasonText.length >= MIN_SHAPE_REASON_LENGTH ? reasonText : null;
  if (reasonText.length > 0 && shapeReason === null) {
    warnings.push(`\`${SHAPE_REASON_FIELD}\` is too short to be a reason; it was ignored.`);
  }

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
    shape: shaped.shape,
    shapeFeedback: shapeReason === null ? shaped.warnings : [],
    shapeReason,
  };
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Measure a plan's width and depth, and name what makes it deeper or longer than
 * the plan itself justifies.
 *
 * An edge is *unexplained* when the dependent owns none of the dependency's
 * paths and names none of them in its required context or objective: nothing in
 * the plan says the dependent reads what the dependency writes, so the edge only
 * delays it. That is reported, never removed — the architect may know of an
 * import the plan does not spell out, and a plan is still a proposal.
 */
export function measurePlanShape(units: UnitSpec[]): { shape: PlanShape; warnings: string[] } {
  if (units.length === 0) return { shape: EMPTY_SHAPE, warnings: [] };
  const warnings: string[] = [];
  const byKey = new Map(units.map((unit) => [unit.key, unit]));

  // Longest chain ending at each unit, cycle-safe: a cycle is refused elsewhere,
  // so here it only stops the walk.
  const depth = new Map<string, { depth: number; chain: string[] }>();
  const visiting = new Set<string>();
  const walk = (key: string): { depth: number; chain: string[] } => {
    const known = depth.get(key);
    if (known) return known;
    if (visiting.has(key)) return { depth: 0, chain: [] };
    visiting.add(key);
    let best: { depth: number; chain: string[] } = { depth: 0, chain: [] };
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dependency) || dependency === key) continue;
      const candidate = walk(dependency);
      if (candidate.depth > best.depth) best = candidate;
    }
    visiting.delete(key);
    const result = { depth: best.depth + 1, chain: [...best.chain, key] };
    depth.set(key, result);
    return result;
  };
  for (const unit of units) walk(unit.key);

  let longest: { depth: number; chain: string[] } = { depth: 0, chain: [] };
  const atDepth = new Map<number, number>();
  for (const unit of units) {
    const entry = depth.get(unit.key) ?? { depth: 1, chain: [unit.key] };
    if (entry.depth > longest.depth) longest = entry;
    atDepth.set(entry.depth, (atDepth.get(entry.depth) ?? 0) + 1);
  }

  let largestUnitPaths = 0;
  let largestUnitModules = 0;
  for (const unit of units) {
    const concrete = unit.ownedPaths.filter(isConcrete);
    largestUnitPaths = Math.max(largestUnitPaths, concrete.length);
    const sources = concrete.filter((path) => !isTestPath(path));
    const modules = new Set(sources.map(directoryOf));
    largestUnitModules = Math.max(largestUnitModules, modules.size);
    if (sources.length >= OVERSIZED_UNIT_SOURCE_FILES && modules.size >= 2) {
      warnings.push(
        `Shape: \`${unit.key}\` owns ${sources.length} source files across ${modules.size} directories ` +
          `(${[...modules].map((m) => m || '.').join(', ')}); split it by file ownership into ` +
          'independent units so they run in parallel sessions rather than one long one.',
      );
    }
  }

  const unexplained: string[] = [];
  for (const unit of units) {
    const named = [...unit.requiredContext, ...unit.ownedPaths];
    for (const dependencyKey of unit.dependsOn) {
      const dependency = byKey.get(dependencyKey);
      if (!dependency || dependencyKey === unit.key) continue;
      const read =
        pathsOverlap(named, dependency.ownedPaths) ||
        dependency.ownedPaths.some((path) => path.length > 0 && unit.objective.includes(path));
      if (!read) unexplained.push(`${unit.key} -> ${dependencyKey}`);
    }
  }
  if (unexplained.length > 0) {
    warnings.push(
      `Shape: ${unexplained.length} dependency edge(s) the plan gives no reason for ` +
        `(${unexplained.join('; ')}): the dependent owns none of the dependency's paths and names ` +
        'none of them in its required context or objective. Each edge costs a whole implement-and-' +
        'integrate round; drop it unless the dependent really reads code the dependency creates. ' +
        `Longest chain: ${longest.chain.join(' -> ')} (depth ${longest.depth}).`,
    );
  }

  return {
    shape: {
      unitCount: units.length,
      maxDepth: longest.depth,
      maxWidth: Math.max(0, ...atDepth.values()),
      largestUnitPaths,
      largestUnitModules,
      longestChain: longest.chain,
    },
    warnings,
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
    // The same derivation `validatePlan` uses, so the two cannot disagree.
    const verdict = validateUnitGraph(units, {
      mutationScope: changeRequest.mutationScope,
      forbiddenPaths: forbiddenPathsFor(changeRequest.repository),
    });
    const fatal = verdict.issues.filter((issue) => issue.fatal);
    if (fatal.length > 0) {
      throw new FactoryError(
        `The plan cannot be installed: ${fatal.map((issue) => `${issue.reason} — ${issue.detail}`).join(' ')}`,
        { issues: fatal },
      );
    }
  }


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

  /*
   * What the factory changed about the proposal, recorded once per change and
   * idempotent by the ledger itself rather than by whether units existed — a
   * crash between the units and these rows is finished by the next call.
   */
  const recorded = new Set(
    (options.rewrites ?? []).length === 0
      ? []
      : (await listFactoryEvents(campaignId, { kinds: [FACTORY_EVENT_KINDS.planRewritten] })).map(
          (event) =>
            `${String(event.detail['action'])}:${String(event.detail['from'])}:${String(event.detail['to'])}:` +
            `${[...((event.detail['paths'] as string[] | undefined) ?? [])].sort().join(',')}`,
        ),
  );
  {
    for (const rewrite of (options.rewrites ?? []).filter(
      (r) => !recorded.has(`${r.action}:${r.from}:${r.to}:${[...r.paths].sort().join(',')}`),
    )) {
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
