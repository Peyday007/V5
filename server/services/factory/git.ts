/**
 * The factory's hands on the repository.
 *
 * Every statement the factory makes about what a worker produced resolves to
 * something in this file: a branch that exists, a head the factory read, a diff
 * it listed, a merge it performed. That is the whole reason it exists — a
 * worker's summary is evidence of what the worker believes, and the repository
 * is evidence of what happened. When the two disagree the repository wins, and
 * nothing above this file is allowed to take the other side.
 *
 * Three rules the callers depend on:
 *
 *   * **The primary checkout is never mutated.** Not by a worker, not by the
 *     integrator, not to "just check something". A campaign gets its own
 *     integration worktree and every unit gets its own; the branch the server
 *     is running from is left exactly as the operator left it. That matters
 *     here specifically because this Brain's own repository is the one under
 *     work, and a factory that checked out over its own running code would be
 *     sawing the branch it is sitting on.
 *
 *   * **A worktree is disposable; a commit is not.** Retiring a worktree keeps
 *     its branch, so the evidence survives the scratch space. Nothing deletes a
 *     branch.
 *
 *   * **Nothing here pushes anywhere by itself.** Pushing a campaign branch and
 *     opening a pull request are deliberate, separately authorized steps. A
 *     function that quietly published would make "the factory may not deploy to
 *     production" depend on nobody calling it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY_ROOT } from '../../env.ts';

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Plenty for a test suite; bounded so a hung command cannot hold a lane forever. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_CAPTURED_BYTES = 2 * 1024 * 1024;

/**
 * Run a command and capture what it did.
 *
 * `spawn` without a shell, with the argument vector given explicitly: a factory
 * that interpolated a branch name into a shell string would be a factory whose
 * planner could write commands. Where a caller genuinely needs a shell — the
 * repository's own verification commands are shell lines — it asks for one
 * explicitly and the string it passes came from the change request, not from a
 * model.
 */
export async function run(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string>; shell?: boolean } = {
    cwd: process.cwd(),
  },
): Promise<CommandResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({
        command: `${file} ${args.join(' ')}`,
        exitCode: -1,
        stdout,
        stderr: `${stderr}${error.message}`,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({
        command: `${file} ${args.join(' ')}`,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

export async function git(
  repoRoot: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return await run('git', args, { cwd: repoRoot, timeoutMs });
}

/** Run git and throw on failure, because the caller has no sensible fallback. */
export async function gitOrThrow(
  repoRoot: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  const result = await git(repoRoot, args, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/* ------------------------------------------------------------------------- */
/* Inspection                                                                 */
/* ------------------------------------------------------------------------- */

export interface RepositoryState {
  root: string;
  branch: string;
  headSha: string;
  /** Uncommitted changes in the primary checkout, which the factory never uses. */
  dirtyPaths: string[];
  remote: string | null;
  /** Branches that exist locally, so a campaign cannot reuse a name by accident. */
  branches: string[];
}

/**
 * Read the repository's state before anything is changed.
 *
 * The campaign's base SHA comes from here and is then pinned: every later
 * statement about "the base" means this commit, not whatever the branch has
 * moved to since. That is what makes a stale base detectable rather than
 * invisible.
 */
export async function inspectRepository(repoRoot: string): Promise<RepositoryState> {
  const branch = await gitOrThrow(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
  const status = await gitOrThrow(repoRoot, ['status', '--porcelain']);
  const remoteResult = await git(repoRoot, ['remote', 'get-url', 'origin']);
  const branchList = await gitOrThrow(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  return {
    root: repoRoot,
    branch,
    headSha,
    dirtyPaths: status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0),
    remote: remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null,
    branches: branchList.split('\n').filter((b) => b.length > 0),
  };
}

export async function resolveSha(repoRoot: string, ref: string): Promise<string | null> {
  const result = await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function isAncestor(
  repoRoot: string,
  maybeAncestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repoRoot, ['merge-base', '--is-ancestor', maybeAncestor, descendant]);
  return result.exitCode === 0;
}

/** Paths a commit range touched, as the repository reports them. */
export async function changedPaths(
  repoRoot: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const out = await gitOrThrow(repoRoot, ['diff', '--name-only', `${fromSha}..${toSha}`]);
  return out.split('\n').filter((line) => line.length > 0);
}

export async function commitsBetween(
  repoRoot: string,
  fromSha: string,
  toSha: string,
): Promise<{ sha: string; subject: string }[]> {
  const out = await gitOrThrow(repoRoot, [
    'log',
    '--format=%H%x09%s',
    `${fromSha}..${toSha}`,
  ]);
  return out
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha: sha ?? '', subject: rest.join('\t') };
    });
}

export async function diffStat(
  repoRoot: string,
  fromSha: string,
  toSha: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const out = await gitOrThrow(repoRoot, ['diff', '--numstat', `${fromSha}..${toSha}`]);
  let insertions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed] = line.split('\t');
    filesChanged += 1;
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { filesChanged, insertions, deletions };
}

/* ------------------------------------------------------------------------- */
/* Worktrees                                                                  */
/* ------------------------------------------------------------------------- */

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export function campaignWorkspace(campaignId: string): string {
  return path.join(FACTORY_ROOT, campaignId);
}

/**
 * Give a unit its own checkout, on its own branch, pinned to a recorded commit.
 *
 * The branch is created from `baseSha` rather than from whatever HEAD happens to
 * be, which is what makes "pinned to the campaign base or an explicitly
 * recorded integration descendant" true of the filesystem and not only of a
 * column.
 *
 * Idempotent: an existing worktree at the same path for the same branch is
 * reused, because a crash between `git worktree add` and the row that records
 * it must not make the unit unclaimable.
 */
export async function ensureWorktree(
  repoRoot: string,
  options: { path: string; branch: string; baseSha: string },
): Promise<Worktree> {
  const existing = await listWorktrees(repoRoot);
  const match = existing.find((w) => path.resolve(w.path) === path.resolve(options.path));
  if (match) {
    if (match.branch === options.branch) {
      return { path: options.path, branch: options.branch, baseSha: options.baseSha };
    }
    await removeWorktree(repoRoot, options.path);
  }

  fs.mkdirSync(path.dirname(options.path), { recursive: true });
  const branchExists =
    (await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${options.branch}`])).exitCode === 0;
  const args = branchExists
    ? ['worktree', 'add', options.path, options.branch]
    : ['worktree', 'add', '-b', options.branch, options.path, options.baseSha];
  await gitOrThrow(repoRoot, args);
  prepareWorktree(repoRoot, options.path);
  return { path: options.path, branch: options.branch, baseSha: options.baseSha };
}

/**
 * Make a fresh worktree able to run the repository's own commands.
 *
 * A git worktree contains tracked files only, so a JavaScript project's
 * `node_modules` is absent from every one of them — and a unit whose verification
 * is `npm run typecheck` would fail for a reason that has nothing to do with its
 * change. Installing per worktree would cost minutes and gigabytes per lane, so
 * the dependency tree is linked rather than copied.
 *
 * A symlink rather than a copy is also the honest arrangement: the worktree is
 * execution scratch, and what a worker is allowed to change is its tracked files.
 * Nothing in a campaign ever writes to the linked tree.
 */
export function prepareWorktree(repoRoot: string, worktreePath: string): void {
  const source = path.join(repoRoot, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(target)) return;
  try {
    fs.symlinkSync(source, target, 'junction');
  } catch {
    // A platform or permission that refuses the link leaves the worktree without
    // dependencies, which its verification commands will report plainly. Better
    // than a half-copied tree that fails in a way nobody can read.
  }
}

export async function listWorktrees(
  repoRoot: string,
): Promise<{ path: string; branch: string | null; head: string | null }[]> {
  const out = await gitOrThrow(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries: { path: string; branch: string | null; head: string | null }[] = [];
  let current: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Retire a worktree without destroying evidence.
 *
 * The directory goes; the branch, its commits and every row that references
 * them stay. A campaign that finished should not be carrying a full checkout per
 * unit around on disk, and it does not need to: the commits are the artifact.
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<boolean> {
  const result = await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  if (result.exitCode !== 0 && fs.existsSync(worktreePath)) {
    // A worktree whose metadata git has already lost still has a directory.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await git(repoRoot, ['worktree', 'prune']);
  }
  return true;
}

/* ------------------------------------------------------------------------- */
/* Committing and integrating                                                 */
/* ------------------------------------------------------------------------- */

/** Is there anything uncommitted in this worktree? */
export async function isDirty(worktreePath: string): Promise<boolean> {
  const out = await gitOrThrow(worktreePath, ['status', '--porcelain']);
  return out.length > 0;
}

/**
 * Commit whatever a worker left behind, attributing it to the unit.
 *
 * Workers are asked to commit their own work, and most do. This exists because
 * the alternative — treating uncommitted changes as the result — would make the
 * worktree itself the channel between a worker and the integrator, and an
 * uncommitted change cannot be reviewed, reverted, merged or attributed.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  trailers: Record<string, string> = {},
): Promise<string | null> {
  if (!(await isDirty(worktreePath))) return null;
  await gitOrThrow(worktreePath, ['add', '-A']);
  const lines = [message, ''];
  for (const [key, value] of Object.entries(trailers)) lines.push(`${key}: ${value}`);
  const args = ['commit', '--no-verify', '-m', lines.join('\n')];
  const result = await git(worktreePath, args);
  if (result.exitCode !== 0) {
    // "nothing to commit" after `add -A` means the change was to an ignored
    // path, which is not a failure and not a result either.
    if (/nothing to commit/i.test(result.stdout + result.stderr)) return null;
    throw new Error(`git commit failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return await gitOrThrow(worktreePath, ['rev-parse', 'HEAD']);
}

export interface MergeOutcome {
  ok: boolean;
  conflict: boolean;
  sha: string | null;
  detail: string;
}

/**
 * Merge a unit's branch into the campaign's integration branch.
 *
 * A merge commit rather than a rebase, deliberately: the unit's branch is
 * evidence another process may be holding, and rewriting it would invalidate
 * every sha already recorded against it. Integration never silently drops
 * another lane's work — a conflict is reported as a conflict and the merge is
 * aborted, leaving the integration branch exactly where it was.
 */
export async function mergeBranch(
  integrationWorktree: string,
  branch: string,
  message: string,
): Promise<MergeOutcome> {
  const before = await gitOrThrow(integrationWorktree, ['rev-parse', 'HEAD']);
  const result = await git(integrationWorktree, [
    'merge',
    '--no-ff',
    '--no-verify',
    '-m',
    message,
    branch,
  ]);
  if (result.exitCode === 0) {
    const after = await gitOrThrow(integrationWorktree, ['rev-parse', 'HEAD']);
    return { ok: true, conflict: false, sha: after, detail: result.stdout.trim() };
  }
  const conflict = /conflict/i.test(result.stdout + result.stderr);
  await git(integrationWorktree, ['merge', '--abort']);
  const after = await gitOrThrow(integrationWorktree, ['rev-parse', 'HEAD']);
  if (after !== before) {
    await gitOrThrow(integrationWorktree, ['reset', '--hard', before]);
  }
  return {
    ok: false,
    conflict,
    sha: null,
    detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 2000),
  };
}

/**
 * Is this branch already contained in that one?
 *
 * Asked before every merge, because a redelivered tick must not produce a
 * second merge commit for work that already landed. The merge itself would be
 * empty, but the commit would not be, and a campaign's history is evidence.
 */
export async function alreadyMerged(
  repoRoot: string,
  branch: string,
  intoSha: string,
): Promise<boolean> {
  const branchSha = await resolveSha(repoRoot, branch);
  if (!branchSha) return false;
  return await isAncestor(repoRoot, branchSha, intoSha);
}
