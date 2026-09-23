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
