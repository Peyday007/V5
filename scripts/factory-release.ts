/**
 * The protected half of an automatic Factory release, run by
 * `.github/workflows/factory-release.yml` from the *trusted* checkout of the
 * canonical branch — never from the change being released.
 *
 * Brain decides; this performs. Brain holds no forge write credential and no
 * deployment credential, and a Factory worker holds neither either. What this
 * script holds is the workflow's own `GITHUB_TOKEN` (contents and actions
 * write, for this repository only, for the length of one run) and the Fly token
 * the operator console already uses to ask Brain questions. Every effect it
 * performs is recorded in Brain *before* the next one is attempted, so a run
 * that dies at any point leaves a row the next run resumes:
 *
 *   GATING  → push the merge the gate job tested         → MERGED
 *   MERGED  → dispatch the canonical Deploy workflow     → DEPLOYING
 *   DEPLOYING → watch it to termination                  → VERIFYING | FAILED
 *   VERIFYING → verify inside the released Brain         → LIVE | FAILED
 *   FAILED (after release) → roll back                   → ROLLED_BACK
 *
 * The merge is pinned: the commit pushed is exactly the commit the gate job
 * merged and tested, its second parent must be the reviewed head, and the push
 * is a plain fast-forward — if the branch moved, the push is refused and the
 * attempt is retried from the gate rather than force-pushed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

type State = 'GATING' | 'MERGED' | 'DEPLOYING' | 'VERIFYING';

interface Action {
  action: 'RELEASE' | 'RESUME';
  runId: string;
  campaignId: string;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  title: string;
  state?: State;
  mergeSha?: string | null;
  deployRunId?: string | null;
}

const REPO = process.env.GITHUB_REPOSITORY ?? '';
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
const APP = (() => {
  const toml = fs.existsSync('fly.toml') ? fs.readFileSync('fly.toml', 'utf8') : '';
  return /^app = "([^"]+)"/m.exec(toml)?.[1] ?? '';
})();
const DEPLOY_WATCH_MS = Number(process.env.RELEASE_DEPLOY_WATCH_MS ?? 150 * 60 * 1000);
const POLL_MS = 30_000;

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sh(command: string, args: string[], options: { allowFail?: boolean; input?: string } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input: options.input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Free text crosses the workflow's argument class underscore-joined. */
function token(text: string): string {
  return text.replace(/[^A-Za-z0-9_.:/,-]+/g, '_').slice(0, 600);
}

/** Ask Brain, through the same console door every operator command uses. */
function brain(args: string[]): string {
  const command = `env BRAIN_DATABASE_POOL_SIZE=1 sh /app/scripts/factory.sh ${args.join(' ')}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = sh('flyctl', ['ssh', 'console', '--app', APP, '-C', command], { allowFail: true });
    const out = result.stdout + result.stderr;
    if (/^FACTORY: OK/m.test(out)) return out;
    log(`brain ${args[0]} attempt ${attempt} did not answer OK:\n${out.slice(-2000)}`);
    if (/^FACTORY REFUSED/m.test(out)) throw new Error(`Brain refused ${args[0]}: ${out.slice(-1000)}`);
    spawnSync('sleep', ['20']);
  }
  throw new Error(`Brain did not answer ${args[0]} after three attempts.`);
}

function advance(runId: string, to: string, extra: Record<string, string | null | undefined> = {}): boolean {
  const args = ['release-advance', '--run', runId, '--to', to];
  for (const [key, value] of Object.entries(extra)) {
    if (value) args.push(`--${key}`, key === 'detail' ? token(value) : value);
  }
  const out = brain(args);
  const line = /^RELEASE-ADVANCE: (.*)$/m.exec(out)?.[1];
  const parsed = line ? (JSON.parse(line) as { moved: boolean; state: string | null }) : null;
  log(`release ${runId} → ${to}: ${parsed?.moved ? 'moved' : `not moved (now ${parsed?.state ?? 'unknown'})`}`);
  return parsed?.moved === true;
}

/**
 * One GitHub API call, retried on a network failure or a 5xx.
 *
 * A single `fetch failed` used to end the whole run between MERGED and the
 * Deploy dispatch (release frr_280add20, 2026-10-09). The durable record kept
 * the merge, so nothing was lost — but nothing resumed it promptly either, and a
 * transient error at the forge is not a fact about the release.
 */
async function gh<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const reply = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (reply.status >= 500 && attempt < 5) {
        lastError = new Error(`GitHub answered ${reply.status}`);
      } else {
        const text = await reply.text();
        return { status: reply.status, body: text ? (JSON.parse(text) as T) : null };
      }
    } catch (error) {
      lastError = error;
    }
    log(`GitHub ${method} ${path} attempt ${attempt} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when `ancestor` is already on the canonical branch. */
async function productionContains(ancestor: string): Promise<boolean> {
  const reply = await gh<{ status?: string }>('GET', `/repos/${REPO}/compare/${ancestor}...production`);
  return reply.status === 200 && (reply.body?.status === 'identical' || reply.body?.status === 'ahead');
}

/** The merge commit on production whose second parent is `head`, if one exists. */
function mergeCommitFor(head: string): string | null {
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  const out = sh('git', ['log', '--merges', '--format=%H %P', '-n', '200', 'origin/production']).stdout;
  for (const line of out.split('\n')) {
    const [sha, , second] = line.trim().split(/\s+/);
    if (sha && second === head) return sha;
  }
  return null;
}

async function pushGatedMerge(action: Action): Promise<string | null> {
  const mergeSha = process.env.GATE_MERGE_SHA ?? '';
  const bundle = process.env.GATE_BUNDLE ?? '';
  if (!/^[0-9a-f]{40}$/.test(mergeSha) || !fs.existsSync(bundle)) {
    advance(action.runId, 'FAILED', { stage: 'INFRA', detail: 'the gate job left no merge commit to push' });
    return null;
  }
  sh('git', ['fetch', '--quiet', bundle, 'HEAD:refs/release/candidate']);
  const fetched = sh('git', ['rev-parse', 'refs/release/candidate']).stdout.trim();
  if (fetched !== mergeSha) {
    advance(action.runId, 'FAILED', {
      stage: 'INFRA',
      detail: `the gate's bundle carries ${fetched}, not the reported ${mergeSha}`,
    });
    return null;
  }
  const parents = sh('git', ['rev-list', '--parents', '-n', '1', mergeSha]).stdout.trim().split(/\s+/);
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  const tip = sh('git', ['rev-parse', 'origin/production']).stdout.trim();
  if (parents.length !== 3 || parents[2] !== action.headSha) {
    advance(action.runId, 'FAILED', {
      stage: 'MERGE',
      detail: `the gated commit ${mergeSha} is not a merge of the reviewed head ${action.headSha}`,
    });
    return null;
  }
  if (parents[1] !== tip) {
    advance(action.runId, 'FAILED', {
      stage: 'INFRA',
      detail: `production moved from ${parents[1]} to ${tip} while the gate ran; the next pass re-gates`,
    });
    return null;
  }
  // A plain fast-forward. No force: if the branch moved, this is refused.
  const pushed = sh('git', ['push', 'origin', `${mergeSha}:refs/heads/production`], { allowFail: true });
  if (!pushed.ok) {
    advance(action.runId, 'FAILED', { stage: 'INFRA', detail: `the push was refused: ${pushed.stderr.slice(0, 300)}` });
    return null;
  }
  log(`merged ${action.headSha} into production as ${mergeSha}`);
  advance(action.runId, 'MERGED', { 'merge-sha': mergeSha });
  return mergeSha;
}

interface WorkflowRun {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  event: string;
}

/** True when `ancestor` is in the history of `descendant`, from the trusted checkout. */
function contains(ancestor: string, descendant: string): boolean {
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  return sh('git', ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true }).ok;
}

/**
 * A Deploy run that releases `mergeSha`: one on the canonical branch whose head
 * *contains* the merge (the branch may have moved past it — a later commit
 * deploys this one too), created after the merge was made, and not already a
 * failure or a cancellation. Exact-head matching made a resume fail as soon as
 * anything else landed after the merge.
 */
async function deployRunFor(mergeSha: string, since: string): Promise<WorkflowRun | null> {
  const reply = await gh<{ workflow_runs: WorkflowRun[] }>(
    'GET',
    `/repos/${REPO}/actions/workflows/deploy.yml/runs?branch=production&event=workflow_dispatch&per_page=30`,
  );
  const runs = (reply.body?.workflow_runs ?? [])
    .filter((run) => run.created_at >= since)
    .filter((run) => run.status !== 'completed' || run.conclusion === 'success')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return runs.find((run) => run.head_sha === mergeSha || contains(mergeSha, run.head_sha)) ?? null;
}

async function dispatchDeploy(action: Action, mergeSha: string, reason: string): Promise<number | null> {
  const mergedAt = sh('git', ['log', '-1', '--format=%cI', mergeSha]).stdout.trim();
  const mergedAtIso = new Date(mergedAt).toISOString();
  const existing = await deployRunFor(mergeSha, mergedAtIso);
  if (existing) {
    log(`adopting Deploy run ${existing.id}, which already releases ${mergeSha.slice(0, 12)}`);
    return existing.id;
  }
  const since = new Date(Date.now() - 5_000).toISOString();
  const reply = await gh('POST', `/repos/${REPO}/actions/workflows/deploy.yml/dispatches`, {
    ref: 'production',
    inputs: { reason },
  });
  if (reply.status !== 204) {
    advance(action.runId, 'FAILED', { stage: 'DISPATCH', detail: `Deploy dispatch answered ${reply.status}` });
    return null;
  }
  for (let i = 0; i < 12; i += 1) {
    await sleep(10_000);
    const run = await deployRunFor(mergeSha, since);
    if (run) return run.id;
  }
  advance(action.runId, 'FAILED', { stage: 'DISPATCH', detail: 'the dispatched Deploy run never appeared' });
  return null;
}

interface Step {
  name: string;
  conclusion: string | null;
}

/** Whether a Deploy run actually put a new image live, from its own steps. */
export function deployReleased(steps: Step[]): boolean {
  return steps.some((step) => step.name === 'Record what was released' && step.conclusion === 'success');
}

async function watchDeploy(runId: number): Promise<{ conclusion: string; released: boolean }> {
  const deadline = Date.now() + DEPLOY_WATCH_MS;
  for (;;) {
    const reply = await gh<WorkflowRun>('GET', `/repos/${REPO}/actions/runs/${runId}`);
    const run = reply.body;
    if (run && run.status === 'completed') {
      const jobs = await gh<{ jobs: { steps?: Step[] }[] }>('GET', `/repos/${REPO}/actions/runs/${runId}/jobs`);
      const steps = (jobs.body?.jobs ?? []).flatMap((job) => job.steps ?? []);
      return { conclusion: run.conclusion ?? 'unknown', released: deployReleased(steps) };
    }
    if (Date.now() > deadline) return { conclusion: 'still-running', released: false };
    await sleep(POLL_MS);
  }
}

/** Revert the merge on the canonical branch, so the branch says what is running. */
function revertMerge(mergeSha: string): { ok: boolean; sha: string | null; detail: string } {
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  sh('git', ['checkout', '--quiet', '-B', 'release-revert', 'origin/production']);
  const reverted = sh('git', ['revert', '-m', '1', '--no-edit', mergeSha], { allowFail: true });
  if (!reverted.ok) return { ok: false, sha: null, detail: `git revert failed: ${reverted.stderr.slice(0, 300)}` };
  const sha = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  const pushed = sh('git', ['push', 'origin', 'HEAD:refs/heads/production'], { allowFail: true });
  if (!pushed.ok) return { ok: false, sha, detail: `the revert push was refused: ${pushed.stderr.slice(0, 300)}` };
  return { ok: true, sha, detail: `reverted as ${sha}` };
}

async function rollBack(action: Action, mergeSha: string, released: boolean, why: string): Promise<void> {
  /*
   * Rollback goes through the canonical pipeline, never around it: §28 is that
   * exactly one workflow runs `flyctl deploy`, and a second one "only for
   * rollbacks" is how that guard is bypassed. So the merge is reverted on the
   * branch and Deploy is dispatched for the revert — production returns to the
   * previous behaviour on that deploy, and branch and image never disagree.
   */
  const steps: string[] = [why, released ? 'the change had been released' : 'nothing had been released'];
  const revert = revertMerge(mergeSha);
  steps.push(`branch: ${revert.detail}`);
  if (revert.ok && revert.sha) {
    const reply = await gh('POST', `/repos/${REPO}/actions/workflows/deploy.yml/dispatches`, {
      ref: 'production',
      inputs: { reason: `factory release ${action.runId}: deploy the revert of ${mergeSha.slice(0, 12)}` },
    });
    steps.push(`redeploy of the revert dispatched: ${reply.status === 204 ? 'yes' : `no (${reply.status})`}`);
  }
  advance(action.runId, 'ROLLED_BACK', { detail: steps.join('; ') });
}

async function verify(action: Action, mergeSha: string): Promise<void> {
  const out = brain(['release-verify', '--run', action.runId]);
  log(out);
  const verdict = /^RELEASE-VERIFY: (\w+)/m.exec(out)?.[1];
  if (verdict === 'LIVE') {
    log(`RELEASE: LIVE ${action.runId} ${mergeSha}`);
    return;
  }
  await rollBack(action, mergeSha, true, 'verification inside the released Brain failed');
  log(`RELEASE: ROLLED_BACK ${action.runId}`);
}

async function fromDeploying(action: Action, mergeSha: string, deployRunId: number): Promise<void> {
  log(`watching Deploy run ${deployRunId}`);
  const watched = await watchDeploy(deployRunId);
  if (watched.conclusion === 'still-running') {
    log(`Deploy run ${deployRunId} is still running; the next pass resumes watching it.`);
    log('RELEASE: WAITING');
    return;
  }
  if (watched.conclusion === 'success') {
    advance(action.runId, 'VERIFYING');
    await verify(action, mergeSha);
    return;
  }
  advance(action.runId, 'FAILED', {
    stage: 'DEPLOY',
    detail: `Deploy run ${deployRunId} concluded ${watched.conclusion}${watched.released ? ' after releasing' : ' before releasing'}`,
  });
  await rollBack(action, mergeSha, watched.released, `Deploy concluded ${watched.conclusion}`);
  log(`RELEASE: ROLLED_BACK ${action.runId}`);
}

async function fromMerged(action: Action, mergeSha: string): Promise<void> {
  const deployRunId = await dispatchDeploy(
    action,
    mergeSha,
    `factory release ${action.runId}: campaign ${action.campaignId}, PR #${action.prNumber}`,
  );
  if (deployRunId === null) {
    log('RELEASE: FAILED');
    return;
  }
  advance(action.runId, 'DEPLOYING', { 'deploy-run': String(deployRunId) });
  await fromDeploying(action, mergeSha, deployRunId);
}

async function main(): Promise<void> {
  const raw = process.env.RELEASE_ACTION ?? 'null';
  const action = JSON.parse(raw) as Action | null;
  if (!action) {
    log('RELEASE: NOTHING');
    return;
  }
  if (!REPO || !TOKEN || !APP) throw new Error('GITHUB_REPOSITORY, GH_TOKEN and fly.toml are all required.');
  const state: State = action.action === 'RELEASE' ? 'GATING' : (action.state ?? 'GATING');
  log(`release ${action.runId}: ${action.action} at ${state} — campaign ${action.campaignId}, PR #${action.prNumber}`);

  if (state === 'GATING') {
    // A previous run may have pushed and died before recording it.
    if (await productionContains(action.headSha)) {
      const mergeSha = mergeCommitFor(action.headSha);
      if (mergeSha) {
        advance(action.runId, 'MERGED', { 'merge-sha': mergeSha });
        await fromMerged(action, mergeSha);
        return;
      }
    }
    const gate = process.env.GATE_RESULT ?? 'skipped';
    if (gate !== 'success') {
      const failure = process.env.GATE_FAILURE ?? '';
      advance(action.runId, 'FAILED', {
        stage: failure ? 'GATE' : 'INFRA',
        detail: failure ? `the release gate refused: ${failure}` : `the gate job ended ${gate}`,
      });
      log('RELEASE: FAILED');
      return;
    }
    const mergeSha = await pushGatedMerge(action);
    if (!mergeSha) {
      log('RELEASE: FAILED');
      return;
    }
    await fromMerged(action, mergeSha);
    return;
  }
  const mergeSha = action.mergeSha ?? '';
  if (!mergeSha) throw new Error(`release ${action.runId} is ${state} with no merge commit recorded`);
  if (state === 'MERGED') return fromMerged(action, mergeSha);
  if (state === 'DEPLOYING') {
    const id = Number(action.deployRunId);
    if (!Number.isInteger(id) || id <= 0) return fromMerged(action, mergeSha);
    return fromDeploying(action, mergeSha, id);
  }
  if (state === 'VERIFYING') return verify(action, mergeSha);
}

if (process.argv[1] && process.argv[1].endsWith('factory-release.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`RELEASE: ERROR ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
