/**
 * Hold a merge into the canonical branch while a Deploy of the current tip is
 * still in its test gate — `npm run release-wait`, and the same check inside
 * the Factory release's merge (`scripts/factory-release.ts`).
 *
 * Why: a Deploy run asks three times whether its commit is still the canonical
 * tip, and a run whose tip moved deploys nothing (FAC-6, "Superseded by a newer
 * canonical tip"). Measured over 67 hours ending 2026-11-18: 113 Deploy runs,
 * 44 live, 39 skipped their "Deploy to Fly" because another merge — a Factory
 * release or a session's — landed while they were in their ~30-minute gate.
 * Each supersession threw that gate away. A merge that waits for the in-flight
 * run to reach `flyctl deploy` costs the merger minutes and saves the lane the
 * whole gate; the next Deploy then releases both.
 *
 * It waits, it never cancels: the in-flight run is left alone, and the wait is
 * bounded (75 minutes) and fails open, like `.github/actions/await-release` —
 * a stuck Deploy must not stop every merge, and an unreadable Actions API is a
 * warning, not a refusal. Only a run on the canonical branch whose head *is*
 * the tip holds anything: a run for an older commit is already superseded and
 * waiting for it would save nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export interface LaneRun {
  id: number;
  status: string;
  head_branch?: string | null;
  head_sha: string;
}

export interface LaneJob {
  name: string;
  status: string;
  steps?: { name: string; status: string }[];
}

export type LaneDecision = { decision: 'wait' | 'go'; holding: number[]; reason: string };

/** The job and the step that put an image on Fly, as `deploy.yml` names them. */
export const FLY_JOB = 'Deploy to Fly';
export const FLY_STEP = 'Deploy';

/** Whether a Deploy run has reached `flyctl deploy` (or finished its Fly job). */
export function reachedFly(jobs: LaneJob[]): boolean {
  return jobs.some(
    (job) =>
      job.name === FLY_JOB &&
      (job.status === 'completed' ||
        (job.steps ?? []).some((step) => step.name === FLY_STEP && step.status !== 'queued' && step.status !== 'pending')),
  );
}

/** Wait while a Deploy of the canonical tip is in flight and has not reached Fly; go otherwise. */
export function releaseLane(input: { branch: string; tip: string; runs: { run: LaneRun; jobs: LaneJob[] }[] }): LaneDecision {
  const holding = input.runs
    .filter(({ run }) => run.status !== 'completed')
    .filter(({ run }) => (run.head_branch ?? input.branch) === input.branch && run.head_sha === input.tip)
    .filter(({ jobs }) => !reachedFly(jobs))
    .map(({ run }) => run.id);
  return holding.length
    ? {
        decision: 'wait',
        holding,
        reason: `Deploy run ${holding.join(', ')} of ${input.tip.slice(0, 12)} is in its gate; a merge now would supersede it`,
      }
    : { decision: 'go', holding: [], reason: 'no Deploy of the canonical tip is short of Fly' };
}

/** A GitHub GET: the parsed body, or null when it could not be read. */
export type GitHubGet = (path: string) => Promise<unknown>;

export async function readLane(get: GitHubGet, repo: string, branch: string): Promise<LaneDecision | null> {
  const head = (await get(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)) as { commit?: { sha?: string } } | null;
  const tip = head?.commit?.sha;
  const listing = (await get(`/repos/${repo}/actions/workflows/deploy.yml/runs?branch=${encodeURIComponent(branch)}&per_page=20`)) as {
    workflow_runs?: LaneRun[];
  } | null;
  if (!tip || !listing?.workflow_runs) return null;
  const runs: { run: LaneRun; jobs: LaneJob[] }[] = [];
  for (const run of listing.workflow_runs) {
    if (run.status === 'completed' || run.head_sha !== tip) continue;
    const jobs = (await get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=50`)) as { jobs?: LaneJob[] } | null;
    if (!jobs?.jobs) return null;
    runs.push({ run, jobs: jobs.jobs });
  }
  return releaseLane({ branch, tip, runs });
}

export const RELEASE_WAIT_MS = 75 * 60 * 1000;

/** Poll until the lane says go, or the bound passes. Fails open: never throws for the API's sake. */
export async function waitForReleaseLane(options: {
  get: GitHubGet;
  repo: string;
  branch: string;
  log: (line: string) => void;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<'go' | 'timeout' | 'unreadable'> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? RELEASE_WAIT_MS);
  const started = now();
  for (;;) {
    let lane: LaneDecision | null = null;
    try {
      lane = await readLane(options.get, options.repo, options.branch);
    } catch {
      lane = null;
    }
    if (!lane) {
      options.log('RELEASE-LANE: UNREADABLE — could not read the Actions API; merging without waiting.');
      return 'unreadable';
    }
    const waited = Math.round((now() - started) / 1000);
    if (lane.decision === 'go') {
      options.log(`RELEASE-LANE: GO — ${lane.reason}${waited ? ` (waited ${waited}s)` : ''}.`);
      return 'go';
    }
    if (now() >= deadline) {
      options.log(`RELEASE-LANE: TIMEOUT — ${lane.reason}, still, after ${waited}s; merging rather than holding for ever.`);
      return 'timeout';
    }
    options.log(`RELEASE-LANE: WAIT — ${lane.reason} (waited ${waited}s).`);
    await sleep(options.pollMs ?? 30_000);
  }
}

function repoFromGit(): string {
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  return /([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? '';
}

/**
 * The `gh` CLI when it is installed (it honours the session's proxy and its own
 * sign-in or GH_TOKEN; Node's fetch honours neither proxy), else fetch with a token.
 */
function cliGet(): GitHubGet {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const hasGh = !spawnSync('gh', ['--version'], { encoding: 'utf8' }).error;
  if (!hasGh) {
    return async (path) => {
      const reply = await fetch(`https://api.github.com${path}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
      });
      return reply.ok ? reply.json() : null;
    };
  }
  return async (path) => {
    const result = spawnSync('gh', ['api', path.replace(/^\//, '')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? (JSON.parse(result.stdout) as unknown) : null;
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const repo = flag('repo') ?? process.env.GITHUB_REPOSITORY ?? repoFromGit();
  const branch = fs.existsSync('.github/CANONICAL_BRANCH') ? fs.readFileSync('.github/CANONICAL_BRANCH', 'utf8').trim() : 'production';
  const get = cliGet();
  if (args.includes('--once')) {
    const lane = await readLane(get, repo, branch).catch(() => null);
    process.stdout.write(`RELEASE-LANE: ${lane ? `${lane.decision.toUpperCase()} — ${lane.reason}` : 'UNREADABLE'}\n`);
    process.exit(lane?.decision === 'wait' ? 3 : 0);
  }
  const minutes = Number(flag('timeout-minutes') ?? 75);
  await waitForReleaseLane({ get, repo, branch, timeoutMs: minutes * 60_000, log: (line) => process.stdout.write(`${line}\n`) });
}

if (process.argv[1] && process.argv[1].endsWith('release-wait.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`RELEASE-LANE: ERROR ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
