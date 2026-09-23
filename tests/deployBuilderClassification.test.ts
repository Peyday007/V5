/**
 * A deploy failure is classified from the failure, not from the progress.
 *
 * ---------------------------------------------------------------------------
 * What was observed
 * ---------------------------------------------------------------------------
 *
 * Deploy 324, 2026-09-23. Depot built the image successfully — `Building image
 * with Depot` at 09:58:36, `Building image done` at 09:58:54 — and the deploy
 * was then refused by a health check at 10:04:19, because Supabase's storage
 * API was answering `544 DatabaseTimeout` and the Brain correctly refused to
 * boot (§18). Nothing was wrong with the builder.
 *
 * The step nonetheless printed `The Depot builder never answered` and spent a
 * second full build and a second machine replacement — while production was
 * down — before failing again for the same reason.
 *
 * The cause is one line. `flyctl` prints `Waiting for depot builder...` on
 * **every** Depot build, and the classifier's `depot builder` alternative
 * matches it. So the question *was this a builder failure?* answered yes for
 * every failed deploy that used Depot, whatever actually went wrong, and the
 * honest branch beside it — *"The deploy failed for a reason that is not the
 * builder"* — was unreachable for all of them.
 *
 * That is this repository's recurring defect at a workflow: a signal that
 * fires on the ordinary case tells a reader nothing, and here it also acted,
 * which made it expensive rather than merely noisy.
 *
 * ---------------------------------------------------------------------------
 * What this pins
 * ---------------------------------------------------------------------------
 *
 * The patterns are read out of the workflow rather than restated, so this is a
 * test of the classifier that actually ships. It asserts that the progress
 * line no longer classifies as a builder failure, that every genuine builder
 * failure still does, and that an unrelated failure still does not — the last
 * being the branch the defect had made unreachable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

/** The alternation the workflow greps for, taken from the workflow itself. */
function builderPatterns(): RegExp {
  const line = workflow
    .split('\n')
    .find((l) => l.includes('grep -qiE') && l.includes('depot builder'));
  expect(line, 'the builder classifier is still a grep -qiE over deploy output').toBeDefined();
  const quoted = /grep -qiE '([^']+)'/.exec(line!);
  expect(quoted, 'the alternation is a single-quoted pattern').not.toBeNull();
  return new RegExp(quoted![1]!, 'i');
}

/**
 * The line the workflow drops before classifying, or null when it drops none.
 *
 * Null rather than a failure, deliberately: this models the workflow as it
 * was as faithfully as the workflow as it is, so each assertion below fails
 * against the defect for its *own* reason rather than because a helper threw.
 */
function excludedPattern(): RegExp | null {
  const line = workflow.split('\n').find((l) => l.includes('grep -viE') && l.includes('deploy.txt'));
  if (!line) return null;
  const quoted = /grep -viE '([^']+)'/.exec(line);
  expect(quoted).not.toBeNull();
  return new RegExp(quoted![1]!, 'i');
}

/**
 * What the shipped step decides about a whole `deploy.txt`.
 *
 * A whole output rather than one line, because that is what `grep` is given
 * and it is the entire mechanism of the defect: the progress line and the
 * real failure are in the same file, so one matching pattern anywhere decided
 * for all of it.
 */
function classifiesAsBuilderFailure(output: string[]): boolean {
  const excluded = excludedPattern();
  const haystack = excluded ? output.filter((l) => !excluded.test(l)) : output;
  const patterns = builderPatterns();
  return haystack.some((l) => patterns.test(l));
}

/** Deploy 324's own output, abridged to the lines that decide this. */
const HEALTH_CHECK_FAILURE = [
  '==> Verifying app config',
  'Waiting for depot builder...',
  '==> Building image with Depot',
  '--> Building image done',
  '> Machine 811d651c26d948 reached started state',
  '> Checking health of machine 811d651c26d948',
  'Error: failed to update machine 811d651c26d948: Unrecoverable error: timeout reached ' +
    'waiting for health checks to pass for machine 811d651c26d948',
];

describe('the Depot fallback fires on a builder failure and not on a Depot build', () => {
  /*
   * The whole defect, in one assertion. Deploy 324's output carries Depot's
   * progress line and a health-check timeout, and nothing about the builder
   * went wrong — yet this is what the step called a builder failure, before
   * spending a second build and a second machine replacement on it.
   */
  it('lets a failure that is not the builder’s reach the honest branch', () => {
    expect(classifiesAsBuilderFailure(HEALTH_CHECK_FAILURE)).toBe(false);
  });

  it('does not treat flyctl’s ordinary progress line as evidence of anything', () => {
    expect(classifiesAsBuilderFailure(['Waiting for depot builder...'])).toBe(false);
  });

  /*
   * And it still catches every condition it was written for. Narrowing the
   * haystack rather than the patterns is what keeps this true, and each of
   * these arrives *alongside* the same progress line in a real run.
   */
  it('still recognises a real builder failure, progress line and all', () => {
    for (const failure of [
      'failed to fetch an image or build from source: error connecting to depot builder: context deadline exceeded',
      'Error: failed to list workers: rpc error: code = Unavailable',
      'transport: authentication handshake failed: tls: first record does not look like a TLS handshake',
      'WARN error releasing builder machine: machine not found',
    ]) {
      expect(classifiesAsBuilderFailure(['Waiting for depot builder...', failure]), failure).toBe(
        true,
      );
    }
  });

  /*
   * The exclusion has to be narrow too: it drops one progress line, not
   * anything that merely mentions Depot.
   */
  it('excludes only the progress line, not every mention of Depot', () => {
    const excluded = excludedPattern();
    expect(excluded, 'the workflow filters before it classifies').not.toBeNull();
    expect(excluded!.test('==> Building image with Depot')).toBe(false);
    expect(excluded!.test('error connecting to depot builder')).toBe(false);
    expect(excluded!.test('Waiting for depot builder...')).toBe(true);
  });

  it('classifies from the filtered output rather than the raw log', () => {
    expect(workflow).toMatch(
      /grep -viE 'waiting for depot builder' deploy\.txt > deploy\.classify\.txt/,
    );
    expect(workflow).toMatch(/grep -qiE '[^']*' deploy\.classify\.txt/);
  });
});
