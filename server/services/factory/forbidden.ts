/**
 * What no unit may change, asked at the two moments it can be asked.
 *
 * §27: *a campaign may not edit what authorizes it, what bounds it, or what
 * deploys it.* The list lives in the envelope (`UNIVERSAL_FORBIDDEN_PATHS` plus
 * a grant's own `forbiddenPaths`), and for a long time exactly one place read
 * it — the planner, which asked whether a unit's owned **glob** matched a
 * forbidden glob *as though the owned glob were a path*. So `**`, `server/**`
 * and `.github/**` all passed, because none of those strings is itself inside
 * `.github/workflows/deploy*`, and a unit owning any of them could then change
 * the deployment workflow or the policy module and pass the ownership check at
 * integration. The rule held only for a plan that named a forbidden file
 * exactly — which is the one plan nobody trying to reach it would write.
 *
 * Two questions, and they are deliberately different strengths:
 *
 * - **At planning, ownership.** Does an owned glob *reach into* a forbidden
 *   one? Read with `pathsOverlap`, the same stem comparison the claim loop uses
 *   to keep two units off one surface, which over-approximates: it may refuse a
 *   glob that could never actually produce a forbidden path. That is the right
 *   direction for an early refusal — the remedy is to name narrower
 *   directories, and §27 already says this list refuses *ownership*.
 * - **At the diff, the files.** Did anything that actually changed land inside
 *   a forbidden glob? This is the binding check and it is exact: it runs on the
 *   forge's own list of changed files (hosted) or git's (local), after the
 *   ownership check, so a plan that slipped past the first question by any route
 *   still cannot deliver a forbidden change.
 */
import { pathsOverlap } from '../../repos/factory.ts';
import { matchesGlob } from './glob.ts';
import { UNIVERSAL_FORBIDDEN_PATHS, decideRepository } from './repositoryEnvelope.ts';

/** The universal floor plus whatever this repository's grant adds. */
export function forbiddenPathsFor(repository: string): string[] {
  const grant = decideRepository(repository).grant;
  return [...UNIVERSAL_FORBIDDEN_PATHS, ...(grant?.forbiddenPaths ?? [])];
}

/** The forbidden glob an owned glob reaches into, or null. */
export function ownershipReachesForbidden(ownedGlob: string, forbidden: string[]): string | null {
  return (
    forbidden.find(
      (glob) => matchesGlob(ownedGlob, glob) || ownedGlob === glob || pathsOverlap([ownedGlob], [glob]),
    ) ?? null
  );
}

/** The changed files that landed inside something no unit may change. */
export function forbiddenIn(files: string[], forbidden: string[]): string[] {
  return files.filter((file) => forbidden.some((glob) => matchesGlob(file, glob)));
}

/**
 * A path standing for what a scope glob could produce: each wildcard segment
 * replaced by a name nothing forbids by spelling. `server/x/**` → `server/x/f/f.ts`.
 */
function sampleOf(glob: string): string {
  if (!/[*?[{]/.test(glob)) return glob;
  const parts = glob.split('/').map((part) => (/[*?[{]/.test(part) ? 'f' : part));
  if (glob.endsWith('/**')) parts.push('f.ts');
  return parts.join('/');
}

/**
 * The scope globs, when **every** one of them lies inside a forbidden path, or null.
 *
 * Production, 2026-11-09 → 11-11: fcp_17725629's whole mutation scope was
 * `server/services/factory/release/outcome.ts`, which the V5 grant puts out of
 * every worker's reach. Nothing asked before planning, so the plan bin was
 * handed to worker after worker — 38 attempts, each one reading the grant and
 * reporting "the only mutation-scope path is forbidden" — until it parked on the
 * owner. Work no worker may ever do is not dispatched; it is routed to the
 * maintainer (`PROTECTED_SCOPE`). A scope with one writable implementation glob
 * is planned as before, and the plan's own ownership check keeps units off the rest.
 *
 * Test paths do not count as a way in. A program's campaigns always carry a
 * writable `tests/program-…*.test.ts` beside their scope, so fcp_17725629's scope
 * was not *entirely* forbidden — only every file a test could test. A scope of
 * nothing but tests is a test objective, and is planned.
 */
export function scopeOnlyForbidden(scope: string[], forbidden: string[]): string[] | null {
  const implementation = scope.filter((glob) => !isTestGlob(glob));
  if (implementation.length === 0) return null;
  return implementation.every((glob) => forbiddenIn([sampleOf(glob)], forbidden).length > 0) ? implementation : null;
}

function isTestGlob(glob: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(glob) || /\.(test|spec)\.[^/]*$/.test(glob);
}
