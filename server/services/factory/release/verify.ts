/**
 * Whether a released change is actually live, asked from inside the Brain that
 * is serving it.
 *
 * Run by the release workflow through the same `flyctl ssh console` door every
 * other operator command uses, so the process answering is the released process
 * itself: if it is the old image, `BRAIN_REVISION` says so and nothing else here
 * matters. LIVE needs all three readings, and none of them is a worker's say-so:
 *
 *   1. this process was built from the merge commit (or a commit the forge says
 *      contains it — a later release carrying this one is still this one live);
 *   2. it answers `/healthz` on its own port;
 *   3. every live check the owner wrote into the grant passes against it.
 *
 * Checks are unauthenticated and read-only by construction: a GET with no
 * credential, against loopback.
 */
import { BRAIN_REVISION, PORT } from '../../../env.ts';
import { getChangeRequest } from '../../../repos/factory.ts';
import { getGrant, getRun } from '../../../repos/factoryRelease.ts';
import type { LiveCheck } from '../../../domain/factoryRelease.ts';
import { compareCommits, parseRemote } from '../forge.ts';
import { advanceRelease } from './plan.ts';

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface VerifyDeps {
  revision: string | null;
  baseUrl: string;
  fetch: typeof fetch;
  contains: (ancestor: string, descendant: string) => Promise<boolean | null>;
}

const TIMEOUT_MS = 20_000;

async function getText(deps: VerifyDeps, path: string): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const reply = await deps.fetch(new URL(path, deps.baseUrl), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: reply.status, text: await reply.text() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runLiveCheck(deps: VerifyDeps, check: LiveCheck): Promise<CheckResult> {
  if (check.kind === 'HTTP') {
    const label = `HTTP ${check.path} → ${check.expectStatus}${check.expectText ? ` containing "${check.expectText}"` : ''}`;
    const reply = await getText(deps, check.path);
    if ('error' in reply) return { check: label, ok: false, detail: reply.error };
    if (reply.status !== check.expectStatus) {
      return { check: label, ok: false, detail: `answered ${reply.status}` };
    }
    if (check.expectText && !reply.text.includes(check.expectText)) {
      return { check: label, ok: false, detail: 'the expected text is not in the body' };
    }
    return { check: label, ok: true, detail: `answered ${reply.status}` };
  }
  const label = `served bundle contains "${check.text}"`;
  const page = await getText(deps, '/');
  if ('error' in page) return { check: label, ok: false, detail: page.error };
  const scripts = [...page.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((match) => match[1] ?? '');
  if (scripts.length === 0) return { check: label, ok: false, detail: 'the page names no script' };
  for (const src of scripts) {
    const bundle = await getText(deps, src);
    if (!('error' in bundle) && bundle.status === 200 && bundle.text.includes(check.text)) {
      return { check: label, ok: true, detail: `found in ${src}` };
    }
  }
  return { check: label, ok: false, detail: `not in ${scripts.join(', ')}` };
}

export interface VerifyOutcome {
  live: boolean;
  checks: CheckResult[];
}

export async function verifyLive(
  deps: VerifyDeps,
  input: { mergeSha: string; liveChecks: LiveCheck[] },
): Promise<VerifyOutcome> {
  const checks: CheckResult[] = [];
  if (!deps.revision) {
    checks.push({ check: 'revision', ok: false, detail: 'this process carries no BRAIN_REVISION' });
  } else if (deps.revision === input.mergeSha) {
    checks.push({ check: 'revision', ok: true, detail: `serving ${deps.revision.slice(0, 12)}` });
  } else {
    const contains = await deps.contains(input.mergeSha, deps.revision);
    checks.push({
      check: 'revision',
      ok: contains === true,
      detail:
        contains === true
          ? `serving ${deps.revision.slice(0, 12)}, which contains ${input.mergeSha.slice(0, 12)}`
          : contains === false
            ? `serving ${deps.revision.slice(0, 12)}, which does not contain ${input.mergeSha.slice(0, 12)}`
            : `serving ${deps.revision.slice(0, 12)}; the forge could not say whether it contains the release`,
    });
  }
  const health = await getText(deps, '/healthz');
  checks.push(
    'error' in health
      ? { check: 'healthz', ok: false, detail: health.error }
      : { check: 'healthz', ok: health.status === 200, detail: `answered ${health.status}` },
  );
  for (const check of input.liveChecks) checks.push(await runLiveCheck(deps, check));
  return { live: checks.every((one) => one.ok), checks };
}

/** Verify a release run from inside the released Brain and record the verdict. */
export async function verifyReleaseRun(runId: string): Promise<VerifyOutcome & { recorded: boolean }> {
  const run = await getRun(runId);
  if (!run) throw new Error(`No release run ${runId}.`);
  if (run.state !== 'VERIFYING') throw new Error(`Release run ${runId} is ${run.state}, not VERIFYING.`);
  if (!run.mergeSha) throw new Error(`Release run ${runId} has no merge commit.`);
  const grant = await getGrant(run.grantId);
  const changeRequest = await getChangeRequest(run.changeRequestId);
  const repository = changeRequest ? parseRemote(changeRequest.repository) : null;
  const deps: VerifyDeps = {
    revision: BRAIN_REVISION,
    baseUrl: `http://127.0.0.1:${PORT}`,
    fetch,
    contains: async (ancestor, descendant) => {
      if (!repository) return null;
      const reply = await compareCommits(repository, ancestor, descendant);
      if (!reply.ok || !reply.body) return null;
      return reply.body.status === 'identical' || reply.body.status === 'ahead';
    },
  };
  const outcome = await verifyLive(deps, { mergeSha: run.mergeSha, liveChecks: grant?.liveChecks ?? [] });
  const verification = { revision: BRAIN_REVISION, checks: outcome.checks, at: new Date().toISOString() };
  const { moved } = outcome.live
    ? await advanceRelease({ runId, to: 'LIVE', verification })
    : await advanceRelease({
        runId,
        to: 'FAILED',
        failureStage: 'VERIFY',
        failureDetail: outcome.checks
          .filter((one) => !one.ok)
          .map((one) => `${one.check}: ${one.detail}`)
          .join('; '),
        verification,
      });
  return { ...outcome, recorded: moved };
}
