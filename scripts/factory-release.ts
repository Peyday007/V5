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
 *   GATING  → merge through the pull request, as tested  → MERGED
 *   MERGED  → dispatch the canonical Deploy workflow     → DEPLOYING
 *   DEPLOYING → watch it to termination                  → VERIFYING | FAILED
 *   VERIFYING → verify inside the released Brain         → LIVE | FAILED
 *   FAILED (after release) → roll back                   → ROLLED_BACK
 *
 * The merge goes through the pull request's own merge endpoint, never a push
 * to the protected branch: that endpoint honours every branch protection rule
 * and ruleset the owner has set, so automatic release needs no bypass of any of
 * them — a rule that refuses the merge stops the release with the forge's own
 * reason. The merge is pinned to the reviewed head (`sha`), it is attempted only
 * while production is still the base the gate merged onto, and afterwards the
 * merged tree must be byte-for-byte the tree the gate tested; a tree nobody
 * tested is never deployed — the next pass gates production's tip instead.
 * Immediately before merging, Brain is asked whether the merge may still happen,
 * so an owner who withdraws the grant during the gate stops it.
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

/** Ask Brain, immediately before merging, whether the merge may still happen. */
function mayMerge(action: Action): { ok: boolean; reasons: string[] } {
  const out = brain(['release-may-merge', '--run', action.runId]);
  const line = /^RELEASE-MAY-MERGE: (.*)$/m.exec(out)?.[1];
  if (!line) return { ok: false, reasons: ['Brain did not say whether the merge may happen'] };
  return JSON.parse(line) as { ok: boolean; reasons: string[] };
}

function treeOf(sha: string): string {
  return sh('git', ['rev-parse', `${sha}^{tree}`]).stdout.trim();
}

/**
 * Merge the reviewed head through its pull request, exactly as the gate tested
 * it. Returns the merge commit, or null with the reason recorded in Brain.
 */
async function mergeGated(action: Action): Promise<{ mergeSha: string; deploySha: string } | null> {
  const gated = process.env.GATE_MERGE_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(gated)) {
    advance(action.runId, 'FAILED', { stage: 'INFRA', detail: 'the gate job left no tested commit' });
    return null;
  }
  const permission = mayMerge(action);
  if (!permission.ok) {
    advance(action.runId, 'FAILED', { stage: 'GATE', detail: `not merged: ${permission.reasons.join(' ')}` });
    return null;
  }
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  const tip = sh('git', ['rev-parse', 'origin/production']).stdout.trim();

  if (process.env.GATE_ALREADY_MERGED === 'true') {
    // A previous attempt merged and died, or production moved under the last
    // merge: the gate tested production's tip itself, and that is what deploys.
    if (gated !== tip) {
      advance(action.runId, 'FAILED', {
        stage: 'INFRA',
        detail: `production moved from the gated ${gated} to ${tip}; the next pass gates its tip`,
      });
      return null;
    }
    const mergeSha = mergeCommitFor(action.headSha);
    if (!mergeSha) {
      advance(action.runId, 'FAILED', {
        stage: 'MERGE',
        detail: `production holds ${action.headSha} but no merge commit of it was found to roll back to`,
      });
      return null;
    }
    advance(action.runId, 'MERGED', { 'merge-sha': mergeSha });
    return { mergeSha, deploySha: tip };
  }

  const bundle = process.env.GATE_BUNDLE ?? '';
  if (!fs.existsSync(bundle)) {
    advance(action.runId, 'FAILED', { stage: 'INFRA', detail: 'the gate job left no tested merge to compare against' });
    return null;
  }
  sh('git', ['fetch', '--quiet', bundle, 'HEAD:refs/release/candidate']);
  const fetched = sh('git', ['rev-parse', 'refs/release/candidate']).stdout.trim();
  if (fetched !== gated) {
    advance(action.runId, 'FAILED', { stage: 'INFRA', detail: `the gate's bundle carries ${fetched}, not the reported ${gated}` });
    return null;
  }
  const parents = sh('git', ['rev-list', '--parents', '-n', '1', gated]).stdout.trim().split(/\s+/);
  if (parents.length !== 3 || parents[2] !== action.headSha) {
    advance(action.runId, 'FAILED', {
      stage: 'MERGE',
      detail: `the gated commit ${gated} is not a merge of the reviewed head ${action.headSha}`,
    });
    return null;
  }
  // The tree the forge's merge must produce: the gated merge itself, or — when
  // production moved while the gate ran — the reviewed head merged onto the new
  // tip, accepted only under the conditions `onProductionMoved` names.
  let expectedTree = treeOf(gated);
  let movedNote: string | null = null;
  if (parents[1] !== tip) {
    const base = parents[1] ?? '';
    const fastForward = sh('git', ['merge-base', '--is-ancestor', base, tip], { allowFail: true }).ok;
    const changeFiles = fastForward ? filesBetween(base, gated) : [];
    const productionFiles = fastForward ? filesBetween(base, tip) : [];
    const remerged = fastForward ? remergeOnto(tip, action.headSha) : null;
    const decision = onProductionMoved({ fastForward, changeFiles, productionFiles, remergedCleanly: remerged !== null });
    if (!decision.ok || !remerged) {
      const reason = decision.ok ? 'the reviewed head does not merge onto the new tip cleanly' : decision.reason;
      advance(action.runId, 'FAILED', {
        stage: 'INFRA',
        detail: `production moved from ${base} to ${tip} while the gate ran and ${reason}; the next pass re-gates`,
      });
      return null;
    }
    expectedTree = treeOf(remerged);
    movedNote = `production moved from ${base.slice(0, 12)} to ${tip.slice(0, 12)} while the gate ran; its ${productionFiles.length} changed file(s) are disjoint from the change's ${changeFiles.length}, so the reviewed head was merged onto the new tip and Deploy's full suite gates the result`;
    log(movedNote);
  }
  const reply = await gh<{ sha?: string; merged?: boolean; message?: string }>(
    'PUT',
    `/repos/${REPO}/pulls/${action.prNumber}/merge`,
    {
      sha: action.headSha,
      merge_method: 'merge',
      commit_title: `Merge pull request #${action.prNumber} (factory release)`,
      commit_message: `Released by Brain under the owner's grant; release ${action.runId}.`,
    },
  );
  const mergeSha = reply.body?.sha ?? '';
  if (reply.status !== 200 || !reply.body?.merged || !/^[0-9a-f]{40}$/.test(mergeSha)) {
    // 405 is a branch rule or an unmergeable request, 409 a moved head: the
    // forge's own words are the actionable reason, and nothing was merged.
    advance(action.runId, 'FAILED', {
      stage: 'MERGE',
      detail: `the forge refused the merge (${reply.status}): ${reply.body?.message ?? 'no reason given'}`,
    });
    return null;
  }
  log(`merged ${action.headSha} into production as ${mergeSha} through pull request #${action.prNumber}`);
  advance(action.runId, 'MERGED', { 'merge-sha': mergeSha });
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  if (treeOf(mergeSha) !== expectedTree) {
    // Production moved between the check and the merge. The merge is real and
    // stays recorded; what does not happen is a deploy of a tree nobody tested.
    advance(action.runId, 'FAILED', {
      stage: 'INFRA',
      detail: `merged as ${mergeSha}, whose tree is not the tree the gate tested; nothing was deployed, and the next pass gates production's tip`,
    });
    return null;
  }
  if (movedNote) log(`merged onto a moved production: ${movedNote}`);
  return { mergeSha, deploySha: mergeSha };
}

/** Files that differ between two commits, from the trusted checkout. */
function filesBetween(from: string, to: string): string[] {
  return sh('git', ['diff', '--name-only', from, to]).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** The reviewed head merged onto `tip` locally; null when it does not merge cleanly. */
function remergeOnto(tip: string, head: string): string | null {
  sh('git', ['checkout', '--quiet', '-B', 'release-remerge', tip]);
  const merged = sh(
    'git',
    ['-c', 'user.name=factory-release', '-c', 'user.email=factory-release@users.noreply.github.com',
      'merge', '--no-ff', '--no-edit', head],
    { allowFail: true },
  );
  if (!merged.ok) {
    sh('git', ['merge', '--abort'], { allowFail: true });
    return null;
  }
  return sh('git', ['rev-parse', 'HEAD']).stdout.trim();
}

/**
 * Whether a merge may go ahead when production moved while the gate ran.
 *
 * The gate's whole Postgres suite takes about an hour, and on 2026-10-11
 * production took eight merges in three hours — so "production must not move"
 * would spend all three attempts in an ordinary afternoon and stop the release
 * for a reason that is not about the change. The gate tested the change on the
 * base it merged onto; what moved since is other work that reached production
 * through its own review. It is accepted only when production moved forward
 * (never rewound), when none of the files production changed is a file the
 * change touches, and when the reviewed head merges onto the new tip cleanly.
 * The merged tree is then checked against that local re-merge, and Deploy's
 * own full suite runs on it before anything is released. Anything else
 * re-gates, as before.
 */
export function onProductionMoved(input: {
  fastForward: boolean;
  changeFiles: readonly string[];
  productionFiles: readonly string[];
  remergedCleanly: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.fastForward) return { ok: false, reason: 'production was rewound rather than moved forward' };
  const touched = new Set(input.changeFiles);
  const overlap = input.productionFiles.filter((file) => touched.has(file));
  if (overlap.length > 0) {
    return { ok: false, reason: `production changed ${overlap.length} file(s) the change also touches (${overlap.slice(0, 5).join(', ')})` };
  }
  if (input.changeFiles.length === 0) return { ok: false, reason: 'the gated merge changes nothing' };
  if (!input.remergedCleanly) return { ok: false, reason: 'the reviewed head does not merge onto the new tip cleanly' };
  return { ok: true };
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
  const existing = await deployRunFor(mergeSha, mergedAtIso(mergeSha));
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

/** Whether a Deploy run stopped at its own pre-release tip check: production moved, nothing was released. */
export function deployRefusedAtTip(steps: Step[]): boolean {
  return steps.some((step) => step.name === 'The ref must still be the canonical tip, now' && step.conclusion === 'failure');
}

async function watchDeploy(runId: number): Promise<{ conclusion: string; released: boolean; refusedAtTip: boolean }> {
  const deadline = Date.now() + DEPLOY_WATCH_MS;
  for (;;) {
    const reply = await gh<WorkflowRun>('GET', `/repos/${REPO}/actions/runs/${runId}`);
    const run = reply.body;
    if (run && run.status === 'completed') {
      const jobs = await gh<{ jobs: { steps?: Step[] }[] }>('GET', `/repos/${REPO}/actions/runs/${runId}/jobs`);
      const steps = (jobs.body?.jobs ?? []).flatMap((job) => job.steps ?? []);
      return { conclusion: run.conclusion ?? 'unknown', released: deployReleased(steps), refusedAtTip: deployRefusedAtTip(steps) };
    }
    if (Date.now() > deadline) return { conclusion: 'still-running', released: false, refusedAtTip: false };
    await sleep(POLL_MS);
  }
}

/**
 * Revert the merge on the canonical branch through a pull request of its own,
 * so a rollback obeys the same branch rules the merge did. Returns whether the
 * revert is on production.
 */
async function revertMerge(runId: string, mergeSha: string): Promise<{ ok: boolean; detail: string }> {
  sh('git', ['fetch', '--quiet', 'origin', 'production']);
  const branch = `factory-release/revert-${runId}`.replace(/[^A-Za-z0-9_./-]/g, '-');
  sh('git', ['checkout', '--quiet', '-B', 'release-revert', 'origin/production']);
  const reverted = sh('git', ['revert', '-m', '1', '--no-edit', mergeSha], { allowFail: true });
  if (!reverted.ok) return { ok: false, detail: `git revert failed: ${reverted.stderr.slice(0, 300)}` };
  const pushed = sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true });
  if (!pushed.ok) return { ok: false, detail: `the revert branch could not be pushed: ${pushed.stderr.slice(0, 300)}` };
  const revertSha = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  const opened = await gh<{ number?: number; message?: string }>('POST', `/repos/${REPO}/pulls`, {
    title: `Revert factory release ${runId}`,
    head: branch,
    base: 'production',
    body: `Brain's factory release ${runId} did not go live; this reverts ${mergeSha}.`,
  });
  const number = opened.body?.number;
  if (opened.status !== 201 || !number) {
    return { ok: false, detail: `the revert pull request could not be opened (${opened.status}): ${opened.body?.message ?? ''}; the revert is on branch ${branch}` };
  }
  const merged = await gh<{ merged?: boolean; message?: string }>('PUT', `/repos/${REPO}/pulls/${number}/merge`, {
    sha: revertSha,
    merge_method: 'merge',
  });
  if (merged.status !== 200 || !merged.body?.merged) {
    return {
      ok: false,
      detail: `the revert is open as pull request #${number} and the forge refused to merge it (${merged.status}): ${merged.body?.message ?? ''}; a person merges it and dispatches Deploy`,
    };
  }
  return { ok: true, detail: `reverted through pull request #${number}` };
}

async function rollBack(
  action: Action,
  mergeSha: string,
  released: boolean,
  why: string,
  stage: 'DEPLOY' | 'VERIFY',
): Promise<boolean> {
  /*
   * Rollback goes through the canonical pipeline, never around it: §28 is that
   * exactly one workflow runs `flyctl deploy`, and a second one "only for
   * rollbacks" is how that guard is bypassed. So the merge is reverted on the
   * branch and Deploy is dispatched for the revert — production returns to the
   * previous behaviour on that deploy, and branch and image never disagree.
   */
  const steps: string[] = [why, released ? 'the change had been released' : 'nothing had been released'];
  const revert = await revertMerge(action.runId, mergeSha);
  steps.push(`branch: ${revert.detail}`);
  if (revert.ok) {
    const reply = await gh('POST', `/repos/${REPO}/actions/workflows/deploy.yml/dispatches`, {
      ref: 'production',
      inputs: { reason: `factory release ${action.runId}: deploy the revert of ${mergeSha.slice(0, 12)}` },
    });
    steps.push(`redeploy of the revert dispatched: ${reply.status === 204 ? 'yes' : `no (${reply.status})`}`);
  }
  if (revert.ok) {
    advance(action.runId, 'ROLLED_BACK', { detail: steps.join('; ') });
    return true;
  }
  // The revert did not land. The attempt stays FAILED — never ROLLED_BACK,
  // which would tell the owner production is back when it may not be — and its
  // detail says exactly what a person has to do.
  advance(action.runId, 'FAILED', { stage, detail: steps.join('; ') });
  log(`the revert did not land: ${revert.detail}`);
  return false;
}

async function verify(action: Action, mergeSha: string): Promise<void> {
  const out = brain(['release-verify', '--run', action.runId]);
  log(out);
  const verdict = /^RELEASE-VERIFY: (\w+)/m.exec(out)?.[1];
  if (verdict === 'LIVE') {
    log(`RELEASE: LIVE ${action.runId} ${mergeSha}`);
    return;
  }
  // FAILED first: ROLLED_BACK may only follow a recorded failure, and a run left
  // at VERIFYING would be resumed, re-verified and reverted a second time.
  advance(action.runId, 'FAILED', { stage: 'VERIFY', detail: 'verification inside the released Brain failed' });
  const rolled = await rollBack(action, mergeSha, true, 'verification inside the released Brain failed', 'VERIFY');
  log(rolled ? `RELEASE: ROLLED_BACK ${action.runId}` : `RELEASE: FAILED ${action.runId}`);
}

/** How many Deploy runs for one merge may be cancelled before releasing before the attempt stops. */
export const MAX_CANCELLED_DEPLOYS = 3;

/**
 * What a Deploy that ended `cancelled` means for the release.
 *
 * `brain-release` keeps one *pending* Deploy, and a newer dispatch evicts the
 * waiting one — so a Deploy this release dispatched can end `cancelled` without
 * ever starting, because another session dispatched a Deploy of a tip that
 * already contains this merge (Deploy 434, evicted by 435, 2026-10-11). That is
 * not a verdict about the change, and rolling the change back for it would undo
 * a good release. So:
 *
 *   - cancelled after releasing: the image is live; verify it, which decides.
 *   - cancelled before releasing, with another Deploy that contains the merge
 *     running or succeeded: adopt that one.
 *   - cancelled before releasing with none: dispatch again, at most
 *     MAX_CANCELLED_DEPLOYS times for one merge, then stop with the reason.
 *
 * A Deploy that *failed* is still a failure and still rolls back.
 */
export function onCancelledDeploy(input: {
  released: boolean;
  successorRunId: number | null;
  cancelledSoFar: number;
}): { kind: 'VERIFY' } | { kind: 'ADOPT'; runId: number } | { kind: 'REDISPATCH' } | { kind: 'STOP' } {
  if (input.released) return { kind: 'VERIFY' };
  if (input.successorRunId !== null) return { kind: 'ADOPT', runId: input.successorRunId };
  if (input.cancelledSoFar >= MAX_CANCELLED_DEPLOYS) return { kind: 'STOP' };
  return { kind: 'REDISPATCH' };
}

/** Deploy runs created since the merge whose head contains it and that ended without success. */
async function cancelledDeploysFor(mergeSha: string, since: string): Promise<number> {
  const reply = await gh<{ workflow_runs: WorkflowRun[] }>(
    'GET',
    `/repos/${REPO}/actions/workflows/deploy.yml/runs?branch=production&event=workflow_dispatch&per_page=30`,
  );
  return (reply.body?.workflow_runs ?? [])
    .filter((run) => run.created_at >= since && run.status === 'completed' && run.conclusion !== 'success')
    .filter((run) => run.head_sha === mergeSha || contains(mergeSha, run.head_sha)).length;
}

function mergedAtIso(mergeSha: string): string {
  return new Date(sh('git', ['log', '-1', '--format=%cI', mergeSha]).stdout.trim()).toISOString();
}

/** What one Deploy run recorded about its hosted verification, from its artifact. */
export interface DeployVerification {
  released?: boolean;
  complete?: boolean;
  failing?: string[];
}

/**
 * Whether a released Deploy's failed verdict counts against the change.
 *
 * Deploy's hosted verification checks the whole Brain, and it fails for
 * reasons that have nothing to do with the change being released — a slow
 * pooler, a storage API refusing connections, or a defect another workstream
 * merged (Deploys 438 and 439 on 2026-10-11 both failed on the Scenario
 * engine's checks). Rolling a Factory change back for that undoes a good
 * change and fixes nothing. So:
 *
 *   - a verification that never reached a verdict is **unknown**, not a
 *     failure (§20: an unknown is recorded as unknown). Deploy 444 released and
 *     its first pass died on Supabase `429 too_many_connections`; its second
 *     pass then failed the check that reads what the first pass left behind.
 *   - a complete verification whose every failing condition was already
 *     failing on the last complete release before the merge is pre-existing.
 *
 * Either way the release goes on to verify the live Brain itself (revision,
 * health, the owner's live checks), which is what decides LIVE. A complete
 * verification with a condition the previous release passed — or with no
 * readable baseline to say otherwise — still rolls back.
 */
export function judgeReleasedVerdict(
  current: DeployVerification | null,
  baseline: DeployVerification | null,
): { countsAgainst: false; why: string } | { countsAgainst: true; reason: string } {
  if (!current || current.complete !== true) {
    return { countsAgainst: false, why: 'its hosted verification never reached a verdict, which is unknown rather than a failure' };
  }
  const failing = Array.isArray(current.failing) ? current.failing : [];
  if (failing.length === 0) return { countsAgainst: true, reason: 'the verdict failed without naming a condition' };
  if (!baseline || baseline.complete !== true || !Array.isArray(baseline.failing)) {
    return { countsAgainst: true, reason: 'no earlier complete release recorded its failing conditions to compare with' };
  }
  const before = new Set(baseline.failing);
  const added = failing.filter((name) => !before.has(name));
  if (added.length > 0) return { countsAgainst: true, reason: `new failing condition(s): ${added.slice(0, 5).join('; ')}` };
  return { countsAgainst: false, why: `it failed only on condition(s) the last release before the merge also failed (${failing.join('; ')})` };
}

/** A Deploy run's recorded verification, or null when it cannot be read. */
function readVerification(runId: number): DeployVerification | null {
  const dir = `release-verification-${runId}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const got = sh('gh', ['run', 'download', String(runId), '-R', REPO, '-n', 'step12b-hosted-verification', '-D', dir], { allowFail: true });
  if (!got.ok) return null;
  try {
    return JSON.parse(fs.readFileSync(`${dir}/verification.json`, 'utf8')) as DeployVerification;
  } catch {
    return null;
  }
}

/**
 * What a Deploy run's own log says failed, for a run recorded before Deploy
 * kept the names in its artifact. Only the release job prints a verdict.
 */
export function verificationFromLog(log: string, released: boolean): DeployVerification {
  const failing = new Set<string>();
  for (const match of log.matchAll(/^\S*\s+FAIL  (.+)$/gm)) {
    failing.add((match[1] ?? '').split(' — ')[0]!.trim());
  }
  const complete = /HOSTED-VERIFICATION: (PASS|FAIL)/.test(log) && !/could-not-complete/.test(log);
  return { released, complete, failing: [...failing].sort() };
}

async function verificationFromRunLog(runId: number, released: boolean): Promise<DeployVerification | null> {
  const jobs = await gh<{ jobs: { id: number; name: string }[] }>('GET', `/repos/${REPO}/actions/runs/${runId}/jobs`);
  const job = (jobs.body?.jobs ?? []).find((one) => one.name === 'Deploy to Fly');
  if (!job) {
    log(`Deploy run ${runId} has no release job to read a verdict from`);
    return null;
  }
  // The logs endpoint redirects to a short-lived blob URL; fetch follows it and
  // drops the Authorization header across origins, which is what the blob wants.
  try {
    const reply = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${job.id}/logs`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (reply.status !== 200) {
      log(`Deploy run ${runId}'s log answered ${reply.status}`);
      return null;
    }
    return verificationFromLog(await reply.text(), released);
  } catch (error) {
    log(`Deploy run ${runId}'s log could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The last Deploy before the merge that released an image and recorded what failed. */
async function baselineVerification(mergeSha: string): Promise<DeployVerification | null> {
  const since = mergedAtIso(mergeSha);
  const reply = await gh<{ workflow_runs: WorkflowRun[] }>(
    'GET',
    `/repos/${REPO}/actions/workflows/deploy.yml/runs?branch=production&status=completed&per_page=30`,
  );
  const earlier = (reply.body?.workflow_runs ?? [])
    .filter((run) => run.created_at < since)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  for (const run of earlier.slice(0, 10)) {
    const recorded = readVerification(run.id);
    if (recorded && recorded.released === false) continue;
    if (recorded?.released === true && Array.isArray(recorded.failing)) {
      // A release whose verification never reached a verdict says nothing
      // about which conditions were failing; keep looking further back.
      if (recorded.complete === true) return recorded;
      continue;
    }
    // Recorded before the artifact named its failures: read the run's own steps and log.
    const jobs = await gh<{ jobs: { steps?: Step[] }[] }>('GET', `/repos/${REPO}/actions/runs/${run.id}/jobs`);
    const steps = (jobs.body?.jobs ?? []).flatMap((job) => job.steps ?? []);
    if (!deployReleased(steps)) continue;
    const fromLog = await verificationFromRunLog(run.id, true);
    if (fromLog?.complete === true) return fromLog;
  }
  return null;
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
  // A Deploy refused at its own tip check never released: another merge moved
  // production while it tested (Deploy 443, refused when this mechanism's own
  // merge of #178 landed, 2026-10-11). That says nothing against the change,
  // and the next Deploy of the branch carries it — the same as an eviction.
  const notReleasedNoVerdict =
    watched.conclusion === 'cancelled' || (watched.conclusion === 'failure' && !watched.released && watched.refusedAtTip);
  if (notReleasedNoVerdict) {
    const since = mergedAtIso(mergeSha);
    const successor = watched.released ? null : await deployRunFor(mergeSha, since);
    const next = onCancelledDeploy({
      released: watched.released,
      successorRunId: successor ? successor.id : null,
      cancelledSoFar: watched.released || successor ? 0 : await cancelledDeploysFor(mergeSha, since),
    });
    if (next.kind === 'VERIFY') {
      log(`Deploy run ${deployRunId} was cancelled after releasing; verifying the released Brain.`);
      advance(action.runId, 'VERIFYING');
      await verify(action, mergeSha);
      return;
    }
    if (next.kind === 'ADOPT') {
      log(`Deploy run ${deployRunId} was cancelled before releasing; adopting Deploy run ${next.runId}, which contains the merge.`);
      advance(action.runId, 'DEPLOYING', { 'deploy-run': String(next.runId) });
      await fromDeploying(action, mergeSha, next.runId);
      return;
    }
    if (next.kind === 'REDISPATCH') {
      log(`Deploy run ${deployRunId} was cancelled before releasing and nothing else deploys the merge; dispatching again.`);
      const id = await dispatchDeploy(action, mergeSha, `factory release ${action.runId}: re-dispatch after a cancelled Deploy`);
      if (id === null) {
        log('RELEASE: FAILED');
        return;
      }
      advance(action.runId, 'DEPLOYING', { 'deploy-run': String(id) });
      await fromDeploying(action, mergeSha, id);
      return;
    }
    // Nothing was released, so there is nothing to roll back: the merge is on
    // the branch and the next Deploy of the branch carries it.
    advance(action.runId, 'FAILED', {
      stage: 'DISPATCH',
      detail: `${MAX_CANCELLED_DEPLOYS} Deploy runs of ${mergeSha.slice(0, 12)} were cancelled before releasing; nothing was released and the merge stays on the branch`,
    });
    log('RELEASE: FAILED');
    return;
  }
  if (watched.conclusion === 'failure' && watched.released) {
    const current = readVerification(deployRunId);
    const judged = judgeReleasedVerdict(current, current?.complete === true ? await baselineVerification(mergeSha) : null);
    if (!judged.countsAgainst) {
      log(`Deploy run ${deployRunId} released and its verdict failed, but ${judged.why}; verifying the live Brain.`);
      advance(action.runId, 'VERIFYING');
      await verify(action, mergeSha);
      return;
    }
    log(`Deploy run ${deployRunId} released and its verdict failed: ${judged.reason}.`);
  }
  advance(action.runId, 'FAILED', {
    stage: 'DEPLOY',
    detail: `Deploy run ${deployRunId} concluded ${watched.conclusion}${watched.released ? ' after releasing' : ' before releasing'}`,
  });
  const rolled = await rollBack(action, mergeSha, watched.released, `Deploy concluded ${watched.conclusion}`, 'DEPLOY');
  log(rolled ? `RELEASE: ROLLED_BACK ${action.runId}` : `RELEASE: FAILED ${action.runId}`);
}

async function fromMerged(action: Action, mergeSha: string, deploySha: string = mergeSha): Promise<void> {
  const deployRunId = await dispatchDeploy(
    action,
    deploySha,
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
    // Whether production already holds the head (a previous attempt merged and
    // died) the gate decided from the same tree, and tested accordingly.
    const merged = await mergeGated(action);
    if (!merged) {
      log('RELEASE: FAILED');
      return;
    }
    await fromMerged(action, merged.mergeSha, merged.deploySha);
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
