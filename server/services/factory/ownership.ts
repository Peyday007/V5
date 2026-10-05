/**
 * Whether a unit can finish the work it was given, decided before anybody runs it.
 *
 * One validator, and it is the only one. The planner asks it of a proposed plan,
 * repair creation asks it of a repair beside the campaign's installed units, and
 * every replan reaches it through `validatePlan` — so the rule a worker is held
 * to at integration is the rule its assignment was checked against, rather than
 * three rules that agree today.
 *
 * The invariant it states, in one sentence: **a unit can reach its completion
 * condition using its own writable scope, its already-integrated dependencies,
 * and read-only repository state.** Two production shapes broke it and both are
 * pinned in `tests/factoryOwnership.test.ts`:
 *
 *   * a unit whose own verification runs a test that a unit *depending on it*
 *     owns. It cannot integrate without the test change, and the test unit
 *     cannot start until it integrates — `MUTATION_OWNED_BY_DEPENDENT`;
 *   * a repair given only the file the defect was *seen* in, while the fix
 *     belongs in a file it may not touch — `REPAIR_SCOPE_INSUFFICIENT`.
 *
 * Nothing here widens authority. Every path a rewrite or a repair resolution
 * adds is one a unit of the campaign already owned, one a person named exactly
 * in the approved scope, or one the finding cites at a line inside that scope —
 * and all of it is still held to the mutation scope and the forbidden list. A
 * reviewer's free-form hint can narrow a repair; it can never widen one.
 *
 * Pure: no rows, no clock. The reads live with the callers, so a decision is
 * answerable from its inputs.
 */
import { narrowsOrEqual } from './contract.ts';
import { ownershipReachesForbidden, forbiddenIn } from './forbidden.ts';
import { matchesGlob } from './glob.ts';
import { pathsOverlap } from '../../repos/factory.ts';
import type { FactoryDependency, FactoryWorkUnit } from '../../domain/factory.ts';

/**
 * Why a graph or a unit cannot be dispatched. Closed; `DEPENDENCY_CYCLE` is the
 * same word the campaign's blocker vocabulary already uses.
 */
export const OWNERSHIP_REASONS = [
  'DEPENDENCY_CYCLE',
  'UNKNOWN_DEPENDENCY',
  'MUTATION_OWNED_BY_DEPENDENT',
  'REQUIRED_FILE_NOT_WRITABLE',
  'REPAIR_SCOPE_INSUFFICIENT',
  'OVERLAPPING_MUTATION_SCOPE',
  'OWNERSHIP_OUTSIDE_REPOSITORY',
] as const;
export type OwnershipReason = (typeof OWNERSHIP_REASONS)[number];

/** What the validator needs to know about a unit — a plan spec and an installed row both have it. */
export interface GraphUnit {
  key: string;
  kind?: string;
  ownedPaths: string[];
  dependsOn: string[];
  acceptance: string[];
  expectedArtifact?: string;
  /**
   * Files this unit must be able to change to complete. Set by repair resolution
   * (the root cause); a plan unit's requirements are derived, never declared.
   */
  mustReach?: string[];
}

export interface GraphContext {
  mutationScope: string[];
  forbiddenPaths: string[];
}

export interface OwnershipIssue {
  reason: OwnershipReason;
  /** False only for overlap, which the claim loop serialises rather than refuses. */
  fatal: boolean;
  /** For a dependency issue: the unit that needs the file first, then the one that owns it. */
  units: string[];
  paths: string[];
  detail: string;
}

export interface GraphVerdict {
  ok: boolean;
  issues: OwnershipIssue[];
}

/* ------------------------------------------------------------------------- */
/* Tests and the files they test                                              */
/* ------------------------------------------------------------------------- */

const TEST_MARK = /\.(test|spec)(\.[A-Za-z0-9]+)$/;
const TEST_DIRECTORY = /(^|\/)(tests?|__tests__)\//;

/** A concrete path, not a glob. */
export function isConcrete(path: string): boolean {
  return !/[*?]/.test(path);
}

export function isTestPath(path: string): boolean {
  return TEST_MARK.test(path) || TEST_DIRECTORY.test(path);
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash + 1);
}

/** `src/impl.test.ts` → `impl`; `src/impl.ts` → `impl`. */
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(TEST_MARK, '$2');
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

/** The conventional sibling tests of a source file. Names only; nothing is read from disk. */
export function siblingTestsOf(path: string): string[] {
  if (isTestPath(path) || !isConcrete(path)) return [];
  const dot = path.lastIndexOf('.');
  if (dot <= path.lastIndexOf('/')) return [];
  return [`${path.slice(0, dot)}.test${path.slice(dot)}`, `${path.slice(0, dot)}.spec${path.slice(dot)}`];
}

/** The conventional sibling subject of a test file. */
export function siblingSubjectOf(testPath: string): string | null {
  return TEST_MARK.test(testPath) ? testPath.replace(TEST_MARK, '$2') : null;
}

/**
 * Stems too common to pair across directories: `tests/ui/index.test.tsx` says
 * nothing about `server/routes/index.ts`. A heuristic's own limit rather than a
 * list of files — same-directory siblings still pair whatever the stem.
 */
const AMBIGUOUS_STEMS = new Set(['index', 'main', 'mod', 'types', 'type', 'utils', 'util', 'helpers', 'helper', 'constants', 'config']);

/**
 * The tests a unit's own verification exercises for a file it owns: the sibling
 * test, plus a test the graph names in a test directory with the same stem —
 * only when exactly one source file in the graph has that stem and the stem is
 * not one every project repeats. `fcp_5b8378e0bd3f4920bb85` was
 * `server/services/research/startPacket.ts` and `tests/startPacket.test.ts`.
 */
function testsExercising(path: string, knownPaths: string[]): string[] {
  if (isTestPath(path) || !isConcrete(path)) return [];
  const out = new Set(siblingTestsOf(path));
  const stem = stemOf(path);
  const sameStemSubjects = knownPaths.filter((p) => !isTestPath(p) && isConcrete(p) && stemOf(p) === stem);
  for (const candidate of knownPaths) {
    if (!isTestPath(candidate) || !isConcrete(candidate) || stemOf(candidate) !== stem) continue;
    if (dirOf(candidate) === dirOf(path)) out.add(candidate);
    else if (
      TEST_DIRECTORY.test(candidate) &&
      sameStemSubjects.length === 1 &&
      !AMBIGUOUS_STEMS.has(stem.toLowerCase())
    ) {
      out.add(candidate);
    }
  }
  return [...out];
}

function owns(ownedPaths: string[], path: string): boolean {
  return ownedPaths.some((glob) => glob === path || matchesGlob(path, glob));
}

/**
 * Repository-relative files a piece of text names, `path:line` included.
 *
 * Kept here rather than in `repair.ts` because the validator reads acceptance
 * statements with it too, and two readers of one regex are two regexes soon.
 */
export function pathsNamedIn(text: string): string[] {
  const out = new Set<string>();
  const pattern = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1]!;
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('://')) continue;
    out.add(path);
  }
  return [...out];
}

/** Files the text cites at a line, which is a located claim rather than a name. */
export function pathsCitedAtLine(text: string): string[] {
  const out = new Set<string>();
  const pattern = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+):\d+/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1]!;
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('://')) continue;
    out.add(path);
  }
  return [...out];
}

/**
 * What a unit needs to be able to change to complete, derived from the plan:
 * the tests its own verification runs against the files it owns, and any file
 * its acceptance statements or expected artifact name. Files it already owns
 * are not requirements on anybody else.
 */
function derivedRequirements(unit: GraphUnit, knownPaths: string[]): string[] {
  const needs = new Set<string>();
  for (const path of unit.ownedPaths) for (const test of testsExercising(path, knownPaths)) needs.add(test);
  for (const text of [...unit.acceptance, unit.expectedArtifact ?? '']) {
    for (const path of pathsNamedIn(text)) if (!negatedMention(text, path)) needs.add(path);
  }
  return [...needs].filter((path) => !owns(unit.ownedPaths, path));
}

/** "Must not modify src/b.ts" names a file it does not need. */
function negatedMention(text: string, path: string): boolean {
  const at = text.indexOf(path);
  if (at === -1) return false;
  const before = text.slice(Math.max(0, at - 40), at);
  const clause = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(',')) + 1);
  return /\b(not|never|without|no|nor)\b|n't\b/i.test(clause);
}

/* ------------------------------------------------------------------------- */
/* The validator                                                              */
/* ------------------------------------------------------------------------- */

function findCycle(units: GraphUnit[]): string[] | null {
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
      // A self-edge is reported as itself, once, above.
      if (!edges.has(next) || next === key) continue;
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

/** Every unit this one waits for, directly or not. Assumes no cycle. */
function ancestorsOf(key: string, byKey: Map<string, GraphUnit>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(byKey.get(key)?.dependsOn ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next) || !byKey.has(next)) continue;
    seen.add(next);
    queue.push(...(byKey.get(next)?.dependsOn ?? []));
  }
  return seen;
}

/**
 * The one pre-dispatch check.
 *
 * Every issue rather than the first, in plan order, so the same graph always
 * produces the same verdict — which is what lets a rewrite be deterministic and
 * lets SQLite and Postgres rows decide identically.
 */
export function validateUnitGraph(units: GraphUnit[], ctx: GraphContext): GraphVerdict {
  const issues: OwnershipIssue[] = [];
  const byKey = new Map(units.map((unit) => [unit.key, unit]));

  for (const unit of units) {
    for (const path of unit.ownedPaths) {
      if (path.startsWith('/') || path.split('/').includes('..')) {
        issues.push({
          reason: 'OWNERSHIP_OUTSIDE_REPOSITORY', fatal: true, units: [unit.key], paths: [path],
          detail: `${unit.key}: \`${path}\` climbs or is absolute.`,
        });
      }
    }
    if (unit.ownedPaths.length > 0 && !narrowsOrEqual(unit.ownedPaths, ctx.mutationScope)) {
      issues.push({
        reason: 'OWNERSHIP_OUTSIDE_REPOSITORY', fatal: true, units: [unit.key],
        paths: unit.ownedPaths.filter((p) => !narrowsOrEqual([p], ctx.mutationScope)),
        detail:
          `${unit.key}: owns paths outside the approved mutation scope. A plan cannot widen the ` +
          'authority of the change request it implements.',
      });
    }
    for (const path of unit.ownedPaths) {
      const forbidden = ownershipReachesForbidden(path, ctx.forbiddenPaths);
      if (forbidden) {
        issues.push({
          reason: 'OWNERSHIP_OUTSIDE_REPOSITORY', fatal: true, units: [unit.key], paths: [path],
          detail:
            `${unit.key}: \`${path}\` reaches into \`${forbidden}\`, which this repository's grant puts ` +
            "out of the factory's reach whatever a contract says. Name narrower paths that " +
            'stay clear of it.',
        });
      }
    }
    for (const dependency of unit.dependsOn) {
      if (dependency === unit.key) {
        issues.push({
          reason: 'DEPENDENCY_CYCLE', fatal: true, units: [unit.key], paths: [],
          detail: `${unit.key}: depends on itself.`,
        });
      } else if (!byKey.has(dependency)) {
        issues.push({
          reason: 'UNKNOWN_DEPENDENCY', fatal: true, units: [unit.key], paths: [],
          detail: `${unit.key}: depends on \`${dependency}\`, which the plan does not define.`,
        });
      }
    }
    for (const path of unit.mustReach ?? []) {
      const allowed =
        !path.startsWith('/') &&
        !path.split('/').includes('..') &&
        ctx.mutationScope.some((glob) => matchesGlob(path, glob)) &&
        forbiddenIn([path], ctx.forbiddenPaths).length === 0;
      if (!allowed) {
        issues.push({
          reason: 'REQUIRED_FILE_NOT_WRITABLE', fatal: true, units: [unit.key], paths: [path],
          detail: `${unit.key}: must change \`${path}\`, which the approved scope or the repository does not allow.`,
        });
      } else if (!owns(unit.ownedPaths, path)) {
        issues.push({
          reason: 'REPAIR_SCOPE_INSUFFICIENT', fatal: true, units: [unit.key], paths: [path],
          detail: `${unit.key}: must change \`${path}\` to complete, and does not own it.`,
        });
      }
    }
  }

  const cycle = findCycle(units);
  if (cycle) {
    issues.push({
      reason: 'DEPENDENCY_CYCLE', fatal: true, units: [...new Set(cycle)], paths: [],
      detail: `The plan has a dependency cycle: ${cycle.join(' -> ')}.`,
    });
  }

  // The ordering question needs a graph that is a graph.
  if (!cycle) {
    const knownPaths = [...new Set(units.flatMap((unit) => unit.ownedPaths))];
    const ancestors = new Map(units.map((unit) => [unit.key, ancestorsOf(unit.key, byKey)]));

    for (const needer of units) {
      const needs = derivedRequirements(needer, knownPaths);
      if (needs.length === 0) continue;
      for (const owner of units) {
        if (owner.key === needer.key) continue;
        // Only a unit that waits for `needer` can deadlock it.
        if (!ancestors.get(owner.key)?.has(needer.key)) continue;
        const held = needs.filter((path) => owns(owner.ownedPaths, path));
        if (held.length === 0) continue;
        issues.push({
          reason: 'MUTATION_OWNED_BY_DEPENDENT', fatal: true, units: [needer.key, owner.key], paths: held,
          detail:
            `${needer.key} needs ${held.map((p) => `\`${p}\``).join(', ')} to complete, and ${owner.key} — ` +
            `which waits for ${needer.key} — owns it. Neither could ever finish.`,
        });
      }
    }

    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        const a = units[i]!;
        const b = units[j]!;
        if (ancestors.get(a.key)?.has(b.key) || ancestors.get(b.key)?.has(a.key)) continue;
        if (pathsOverlap(a.ownedPaths, b.ownedPaths)) {
          issues.push({
            reason: 'OVERLAPPING_MUTATION_SCOPE', fatal: false, units: [a.key, b.key], paths: [],
            detail:
              `${a.key} and ${b.key} own overlapping paths and do not depend on each other; they ` +
              'will be serialised rather than run in parallel.',
          });
        }
      }
    }
  }

  return { ok: !issues.some((issue) => issue.fatal), issues };
}

/** Installed rows, as the validator reads them. */
export function graphFromRows(
  units: Pick<FactoryWorkUnit, 'id' | 'unitKey' | 'kind' | 'ownedPaths' | 'acceptance' | 'expectedArtifact' | 'state'>[],
  dependencies: Pick<FactoryDependency, 'unitId' | 'dependsOnUnitId'>[],
): GraphUnit[] {
  const keyOf = new Map(units.map((unit) => [unit.id, unit.unitKey]));
  return units
    // A unit nobody will ever run again imposes nothing on anybody.
    .filter((unit) => unit.state !== 'CANCELLED' && unit.state !== 'SUPERSEDED')
    .map((unit) => ({
      key: unit.unitKey,
      kind: unit.kind,
      ownedPaths: unit.ownedPaths,
      acceptance: unit.acceptance,
      expectedArtifact: unit.expectedArtifact,
      dependsOn: dependencies
        .filter((edge) => edge.unitId === unit.id)
        .map((edge) => keyOf.get(edge.dependsOnUnitId))
        .filter((key): key is string => typeof key === 'string'),
    }));
}

/* ------------------------------------------------------------------------- */
/* Rewriting an invalid plan                                                  */
/* ------------------------------------------------------------------------- */

export interface PlanRewrite {
  action: 'MOVE_PATH' | 'MERGE_UNITS';
  reason: OwnershipReason;
  /** The unit that gave the path up, or was merged away. */
  from: string;
  /** The unit that received it. */
  to: string;
  paths: string[];
  detail: string;
}

/** The fields a rewrite touches. A plan spec carries more; they ride along. */
export interface RewritableUnit extends GraphUnit {
  serves?: string[];
  verification?: string[];
  requiredContext?: string[];
  criticalPath?: boolean;
  risk?: string;
  modelClass?: string;
}

const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH'];

function union(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Make an invalid plan valid with the smallest structural change, or say it cannot.
 *
 * Only `MUTATION_OWNED_BY_DEPENDENT` is rewritten, and only two ways:
 *
 *   * **move the file** the earlier unit needs into it, when the dependent names
 *     that file exactly — the dependent keeps everything else it owns and still
 *     waits;
 *   * **merge** the dependent into the earlier unit, when moving the file left it
 *     owning nothing, or when it owned the file through a glob that cannot be
 *     split. Units that waited for it wait for the merged unit.
 *
 * Nothing else is: a cycle is the architect's mistake about what depends on
 * what, and guessing which edge to drop would be inventing the plan. The
 * objective and the contract's acceptance conditions are untouched — a merge
 * unions what both units served, so nothing a condition depended on is lost.
 * Bounded by the unit count, because every rewrite removes a path from a
 * dependent or a unit from the plan.
 */
export function rewritePlanGraph<T extends RewritableUnit>(
  input: T[],
  ctx: GraphContext,
): { units: T[]; rewrites: PlanRewrite[]; verdict: GraphVerdict; unresolved: boolean } {
  const original = validateUnitGraph(input, ctx);
  let units: T[] = input.map((unit) => ({ ...unit, dependsOn: [...unit.dependsOn] }));
  const rewrites: PlanRewrite[] = [];
  const ceiling = input.reduce((n, unit) => n + unit.ownedPaths.length, 0) + input.length + 1;

  const finish = (verdict: GraphVerdict) => {
    /*
     * A rewrite may only ever remove problems. If what is left carries a reason
     * the proposal did not have — a cycle a merge produced, say — the factory's
     * own change is what failed, and the architect must hear about the plan it
     * wrote rather than a defect it never wrote. So the original is returned,
     * flagged unresolved.
     */
    const before = new Set(original.issues.filter((i) => i.fatal).map((i) => i.reason));
    const introduced = verdict.issues.some((i) => i.fatal && !before.has(i.reason));
    if (!verdict.ok && (introduced || rewrites.length > 0)) {
      return { units: input.map((unit) => ({ ...unit })), rewrites: [], verdict: original, unresolved: rewrites.length > 0 || introduced };
    }
    return { units, rewrites, verdict, unresolved: false };
  };

  for (let round = 0; round < ceiling; round += 1) {
    const verdict = validateUnitGraph(units, ctx);
    const fatal = verdict.issues.filter((issue) => issue.fatal);
    if (fatal.length === 0) return finish(verdict);
    if (fatal.some((issue) => issue.reason !== 'MUTATION_OWNED_BY_DEPENDENT')) return finish(verdict);
    const issue = fatal[0]!;
    const [neederKey, ownerKey] = issue.units as [string, string];
    const needer = units.find((u) => u.key === neederKey)!;
    const owner = units.find((u) => u.key === ownerKey)!;
    const literal = issue.paths.filter((path) => owner.ownedPaths.includes(path));

    if (literal.length === issue.paths.length) {
      const moved = literal;
      const namesMoved = (text: string): boolean => moved.some((path) => text.includes(path));
      needer.ownedPaths = union(needer.ownedPaths, moved);
      needer.acceptance = union(needer.acceptance, owner.acceptance.filter(namesMoved));
      owner.ownedPaths = owner.ownedPaths.filter((path) => !moved.includes(path));
      owner.acceptance = owner.acceptance.filter((text) => !namesMoved(text));
      rewrites.push({
        action: 'MOVE_PATH', reason: issue.reason, from: owner.key, to: needer.key, paths: moved,
        detail:
          `Moved ${moved.map((p) => `\`${p}\``).join(', ')} from ${owner.key} to ${needer.key}: ` +
          `${needer.key} cannot complete without changing it, and ${owner.key} waits for ${needer.key}.`,
      });
      if (owner.ownedPaths.length > 0) continue;
    }

    /*
     * Merge `owner` into `needer`: their completion conditions are inseparable.
     * Every unit on a path between them goes too — `owner` waits for it and it
     * waits for `needer` — because leaving it out would make the merged unit wait
     * for something that waits for the merged unit. A cycle the factory made.
     */
    const byKey = new Map(units.map((unit) => [unit.key, unit as GraphUnit]));
    const ownerAncestors = ancestorsOf(owner.key, byKey);
    const between = units.filter(
      (unit) => unit.key !== needer.key && ownerAncestors.has(unit.key) && ancestorsOf(unit.key, byKey).has(needer.key),
    );
    for (const absorbed of [...between, owner]) {
      units = mergeInto(units, needer, absorbed);
      rewrites.push({
        action: 'MERGE_UNITS', reason: issue.reason, from: absorbed.key, to: needer.key, paths: issue.paths,
        detail:
          absorbed === owner
            ? `Merged ${owner.key} into ${needer.key}: ${owner.key} owned ` +
              `${issue.paths.map((p) => `\`${p}\``).join(', ')} that ${needer.key} needs to complete, and ` +
              'what was left of it could not stand on its own.'
            : `Merged ${absorbed.key} into ${needer.key}: it sits between ${needer.key} and ${owner.key}, ` +
              'which are being merged, so it could not wait for one and be waited for by the other.',
      });
    }
  }
  return finish(validateUnitGraph(units, ctx));
}

function mergeInto<T extends RewritableUnit>(units: T[], into: T, absorbed: T): T[] {
  into.ownedPaths = union(into.ownedPaths, absorbed.ownedPaths);
  into.acceptance = union(into.acceptance, absorbed.acceptance);
  into.serves = union(into.serves, absorbed.serves);
  into.verification = union(into.verification, absorbed.verification);
  into.requiredContext = union(into.requiredContext, absorbed.requiredContext);
  into.criticalPath = Boolean(into.criticalPath || absorbed.criticalPath);
  if (into.risk && absorbed.risk && RISK_ORDER.indexOf(absorbed.risk) > RISK_ORDER.indexOf(into.risk)) {
    into.risk = absorbed.risk;
  }
  if (absorbed.modelClass === 'STRONGEST') into.modelClass = 'STRONGEST';
  into.dependsOn = union(into.dependsOn, absorbed.dependsOn).filter((key) => key !== into.key && key !== absorbed.key);
  const rest = units.filter((unit) => unit.key !== absorbed.key);
  for (const unit of rest) {
    if (!unit.dependsOn.includes(absorbed.key)) continue;
    unit.dependsOn = union(unit.dependsOn.map((key) => (key === absorbed.key ? into.key : key))).filter(
      (key) => key !== unit.key,
    );
  }
  return rest;
}

/* ------------------------------------------------------------------------- */
/* What a repair may write                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Categories that mean the finding is about the test itself — missing or weak
 * coverage — rather than about what a test shows. Closed and exact: a reviewer
 * writing "failing test" is describing a symptom, and reading that as a test-only
 * finding would hand back the repair that could only weaken the test.
 */
export const TEST_ONLY_CATEGORIES = new Set(['coverage', 'test-coverage', 'test-quality', 'missing-test', 'missing-tests']);

export function isTestFinding(category: string): boolean {
  return TEST_ONLY_CATEGORIES.has(category.trim().toLowerCase());
}

export interface RepairScopeInput {
  /** Files the reviewer suggested. A hint: it can narrow and never widen. */
  suggested: string[];
  /** The finding's own statement. */
  statement: string;
  /** The finding's evidence; read only for a file cited at a line when nothing else names one. */
  evidence: string;
  category: string;
  mutationScope: string[];
  forbiddenPaths: string[];
  units: { unitKey: string; ownedPaths: string[]; dependsOn?: string[] }[];
}

export type RepairScope =
  | {
      ok: true;
      ownedPaths: string[];
      /** Where the defect was named or observed. */
      evidenceFiles: string[];
      /** Where it must be fixed. */
      rootCauseFiles: string[];
      /** The tests that prove it fixed, writable so a regression can be added. */
      verificationFiles: string[];
      /** Named files nothing the factory holds anchors. Kept out, and recorded. */
      rejectedHints: string[];
      derivedFrom: 'REQUIRED_FILES' | 'UNIT_OWNERSHIP';
      /** Required files no unit of this campaign owned — the widening, named. */
      beyondUnits: string[];
    }
  | {
      ok: false;
      reason: 'REQUIRED_FILE_NOT_WRITABLE';
      required: string[];
      outsideScope: string[];
      forbidden: string[];
    }
  | {
      ok: false;
      reason: 'REPAIR_SCOPE_INSUFFICIENT';
      evidenceFiles: string[];
      rejectedHints: string[];
      detail: string;
    };

/**
 * The minimum sufficient writable scope for a repair.
 *
 * The finding's named files are evidence. Each is kept only when something the
 * factory holds anchors it: a unit of this campaign owns it, the approved scope
 * names it exactly (a person named that file), or the statement cites it at a
 * line. A bare suggestion anchored by none of those is a reviewer reaching, and
 * is recorded as a rejected hint rather than granted.
 *
 * A named test is where the defect *showed*. Unless the finding is about the
 * test itself, its subject is where it must be *fixed*, and is resolved — by the
 * sibling convention, by the graph's own same-stem file, or by the single
 * non-test file the test's owning unit or its dependencies own — and anchored the
 * same way. A test whose subject cannot be established is a repair that could
 * only weaken the test, so it is refused: `REPAIR_SCOPE_INSUFFICIENT`, and no bin.
 */
export function resolveRepairScope(input: RepairScopeInput): RepairScope {
  /*
   * The reviewer's suggestions, else the files its statement names, else the
   * files its evidence cites at a line. Evidence is read last and only for a
   * located citation, because it routinely names files for context that nobody
   * has to change.
   */
  const fromStatement = pathsNamedIn(input.statement);
  const fromEvidence = pathsCitedAtLine(input.evidence);
  const named =
    input.suggested.length > 0
      ? [...input.suggested, ...pathsCitedAtLine(input.statement)]
      : fromStatement.length > 0
        ? fromStatement
        : fromEvidence;
  // A glob is not a file anybody saw a defect in; it would be a reviewer asking
  // for a directory. Recorded and left out, so a hint can never widen.
  const globHints = [...new Set(named.filter((path) => !isConcrete(path)))];
  const evidenceFiles = [...new Set(named.filter(isConcrete))];

  if (evidenceFiles.length === 0) {
    const union = [...new Set(input.units.flatMap((unit) => unit.ownedPaths))];
    if (union.length === 0) {
      return {
        ok: false, reason: 'REPAIR_SCOPE_INSUFFICIENT', evidenceFiles: [], rejectedHints: globHints,
        detail: 'The finding names no file and the campaign has no unit whose work it could be about.',
      };
    }
    return {
      ok: true, ownedPaths: union, evidenceFiles: [], rootCauseFiles: [], verificationFiles: [],
      rejectedHints: globHints, derivedFrom: 'UNIT_OWNERSHIP', beyondUnits: [],
    };
  }

  const forbidden = forbiddenIn(evidenceFiles, input.forbiddenPaths);
  const outsideScope = evidenceFiles.filter(
    (path) => !forbidden.includes(path) && !input.mutationScope.some((glob) => matchesGlob(path, glob)),
  );
  if (outsideScope.length > 0 || forbidden.length > 0) {
    return { ok: false, reason: 'REQUIRED_FILE_NOT_WRITABLE', required: evidenceFiles, outsideScope, forbidden };
  }

  const unitOwned = (path: string): boolean => input.units.some((unit) => owns(unit.ownedPaths, path));
  const namedInScope = (path: string): boolean => input.mutationScope.includes(path);
  const cited = new Set([...pathsCitedAtLine(input.statement), ...(named === fromEvidence ? fromEvidence : [])]);
  const anchored = (path: string): boolean =>
    unitOwned(path) || namedInScope(path) || cited.has(path);
  const allowed = (path: string): boolean =>
    input.mutationScope.some((glob) => matchesGlob(path, glob)) &&
    forbiddenIn([path], input.forbiddenPaths).length === 0;

  const accepted = evidenceFiles.filter(anchored);
  const rejectedHints = [...evidenceFiles.filter((path) => !anchored(path)), ...globHints];
  if (accepted.length === 0) {
    return {
      ok: false, reason: 'REPAIR_SCOPE_INSUFFICIENT', evidenceFiles, rejectedHints,
      detail:
        `Nothing the factory holds anchors ${evidenceFiles.map((p) => `\`${p}\``).join(', ')}: no unit ` +
        'owned it, the approved scope does not name it, and the finding does not cite it at a line.',
    };
  }

  const tests = accepted.filter(isTestPath);
  const sources = accepted.filter((path) => !isTestPath(path));
  const knownSources = [
    ...new Set(input.units.flatMap((unit) => unit.ownedPaths).filter((p) => isConcrete(p) && !isTestPath(p))),
  ];

  const subjects: string[] = [];
  const unresolved: string[] = [];
  if (!isTestFinding(input.category)) {
    for (const test of tests) {
      const found = subjectsOf(
        test,
        knownSources,
        input.units,
        (path) => allowed(path) && (unitOwned(path) || namedInScope(path)),
      );
      if (found.length === 0) unresolved.push(test);
      for (const path of found) if (!subjects.includes(path)) subjects.push(path);
    }
  }

  if (sources.length === 0 && subjects.length === 0 && tests.length > 0 && !isTestFinding(input.category)) {
    return {
      ok: false, reason: 'REPAIR_SCOPE_INSUFFICIENT', evidenceFiles, rejectedHints,
      detail:
        `The defect showed in ${unresolved.map((p) => `\`${p}\``).join(', ')}, and the file it tests could ` +
        'not be established from the campaign. A repair owning only the test could make the finding ' +
        'untrue only by weakening the test, so none is created. A person can name the file exactly in ' +
        'the mutation scope, and the next tick queues the repair.',
    };
  }

  const rootCauseFiles = [...new Set([...sources, ...subjects])];
  const verificationFiles = tests;
  const ownedPaths = [...new Set([...rootCauseFiles, ...verificationFiles])];
  const beyondUnits = ownedPaths.filter((path) => !unitOwned(path));
  return {
    ok: true, ownedPaths, evidenceFiles, rootCauseFiles, verificationFiles, rejectedHints,
    derivedFrom: 'REQUIRED_FILES', beyondUnits,
  };
}

/**
 * The file a test tests: by naming first (the sibling, then the graph's own
 * same-stem file), and by the test's own unit second — the single source file
 * it, or what it waits for, owns. Every candidate must pass `accept`, which is
 * where anchoring and the scope are asked.
 */
function subjectsOf(
  test: string,
  knownSources: string[],
  units: RepairScopeInput['units'],
  accept: (path: string) => boolean,
): string[] {
  const byName: string[] = [];
  const sibling = siblingSubjectOf(test);
  if (sibling) byName.push(sibling);
  const stem = stemOf(test);
  const sameStem = knownSources.filter((path) => stemOf(path) === stem);
  const sameDir = sameStem.filter((path) => dirOf(path) === dirOf(test));
  for (const path of sameDir.length > 0 ? sameDir : sameStem.length === 1 ? sameStem : []) {
    if (!byName.includes(path)) byName.push(path);
  }
  const named = byName.filter(accept);
  if (named.length > 0) return named;

  const owners = units.filter((unit) => owns(unit.ownedPaths, test));
  const context = new Set<string>();
  for (const owner of owners) {
    const scope = [owner, ...units.filter((unit) => (owner.dependsOn ?? []).includes(unit.unitKey))];
    for (const unit of scope) {
      for (const path of unit.ownedPaths) if (isConcrete(path) && !isTestPath(path)) context.add(path);
    }
  }
  return context.size === 1 ? [...context].filter(accept) : [];
}
