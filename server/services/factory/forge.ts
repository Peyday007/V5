/**
 * The repository, read through the forge's own API rather than a checkout.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * The deployed Brain has no `.git`: it is in `.dockerignore`, because an image is
 * pushed to a registry and pulled by machines nobody here controls. That was an
 * honest refusal and a dead end — a factory that cannot pin a commit cannot
 * accept an objective, and §27's rule that *a worker's summary is never evidence*
 * then has nothing to check a worker against.
 *
 * This is the way out that keeps both. Execution moves to a worker with a real
 * checkout; **verification stays with Brain**, through the forge. A branch's head
 * sha, the files a range of commits touched, whether a pull request exists and
 * what it points at — all of that is the repository's own account of itself, not
 * the worker's, and all of it is one HTTPS call away with no clone at all.
 *
 * ---------------------------------------------------------------------------
 * Why there is usually no credential here
 * ---------------------------------------------------------------------------
 *
 * A public repository answers every one of those questions unauthenticated. So
 * for the repositories this factory is pointed at, Brain holds **no credential**
 * — which is a stronger statement of requirement 9 than any amount of careful
 * secret handling: there is nothing to leak, nothing to scope and nothing to
 * revoke.
 *
 * A private repository needs a read token, and then exactly one thing changes:
 * `FORGE_TOKEN_VARIABLE` is read from the environment into one `Authorization`
 * header and appears nowhere else — no log line, no error message, no row, no
 * response. A repository Brain cannot read is reported as unverifiable **and
 * fails closed**; it is never assumed fine.
 *
 * Nothing in this module writes. There is no POST, no PATCH and no PUT: opening
 * or updating a pull request belongs to the worker that holds the checkout, and
 * a Brain that could push would be a Brain that could deploy.
 */
import { FactoryError } from './errors.ts';

/** The one variable a private repository needs. Read per call, never captured. */
export const FORGE_TOKEN_VARIABLE = 'BRAIN_FORGE_TOKEN';

const DEFAULT_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;

/** A repository this Brain is willing to talk about, parsed from its remote. */
export interface ForgeRepository {
  host: string;
  owner: string;
  name: string;
  /** `owner/name`, which is what every API path wants. */
  slug: string;
}

/**
 * Parse a remote into a repository, or refuse.
 *
 * Deliberately strict: `https://` only, `github.com` only, exactly two path
 * segments. A factory that accepted an arbitrary string here would be a factory
 * whose "repository" could be a file path, an ssh host or a redirect — and the
 * value travels into a manifest a worker acts on.
 */
export function parseRemote(remote: string): ForgeRepository | null {
  let url: URL;
  try {
    url = new URL(remote.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'github.com') return null;
  const segments = url.pathname.replace(/\.git$/, '').split('/').filter((part) => part.length > 0);
  if (segments.length !== 2) return null;
  const [owner, name] = segments as [string, string];
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return { host: url.hostname, owner, name, slug: `${owner}/${name}` };
}

export interface ForgeReply<T> {
  ok: boolean;
  status: number;
  body: T | null;
  /** Why it failed, in words that name no credential. */
  reason: string | null;
  /** True when the call was made with a token. Recorded; the value never is. */
  authenticated: boolean;
}

function apiBase(): string {
  return (process.env['BRAIN_FORGE_API_BASE'] ?? '').trim() || DEFAULT_API_BASE;
}

/**
 * One GET against the forge.
 *
 * The token — when there is one — is built into the header here and read from
 * the environment on every call, so a secret set after boot takes effect without
 * a restart and a test can put one in place without reloading the module.
 */
async function get<T>(path: string): Promise<ForgeReply<T>> {
  const token = (process.env[FORGE_TOKEN_VARIABLE] ?? '').trim();
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'brain-software-factory',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body: null,
        // The forge's own message, which for a 404 on a private repository is
        // deliberately indistinguishable from one that does not exist — the same
        // property invariant 23 asks of Brain.
        reason:
          response.status === 404
            ? 'The forge reports no such repository, ref or pull request. For a private ' +
              'repository that is also what "Brain may not read it" looks like.'
            : `The forge answered ${response.status}.`,
        authenticated: token.length > 0,
      };
    }
    return { ok: true, status: response.status, body: body as T, reason: null, authenticated: token.length > 0 };
  } catch (error: unknown) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: null,
      reason: aborted
        ? `The forge did not answer within ${REQUEST_TIMEOUT_MS}ms.`
        : 'The forge could not be reached.',
      authenticated: token.length > 0,
    };
  }
}

/* ------------------------------------------------------------------------- */
/* What a contract needs before it can be pinned                              */
/* ------------------------------------------------------------------------- */

export interface ForgeRef {
  ref: string;
  sha: string;
}

/** The head of one branch. This is the pin a campaign is built on. */
export async function resolveBranch(
  repository: ForgeRepository,
  branch: string,
): Promise<ForgeReply<ForgeRef>> {
  const reply = await get<{ object?: { sha?: string } }>(
    `/repos/${repository.slug}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (!reply.ok) return { ...reply, body: null };
  const sha = reply.body?.object?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    return {
      ok: false,
      status: reply.status,
      body: null,
      reason: 'The forge answered without a commit sha, so there is nothing to pin.',
      authenticated: reply.authenticated,
    };
  }
  return { ...reply, body: { ref: `refs/heads/${branch}`, sha } };
}

/** The repository's default branch, for a submission that names none. */
export async function defaultBranch(repository: ForgeRepository): Promise<ForgeReply<string>> {
  const reply = await get<{ default_branch?: string }>(`/repos/${repository.slug}`);
  if (!reply.ok) return { ...reply, body: null };
  const branch = reply.body?.default_branch;
  if (typeof branch !== 'string' || branch.length === 0) {
    return {
      ok: false,
      status: reply.status,
      body: null,
      reason: 'The forge named no default branch.',
      authenticated: reply.authenticated,
    };
  }
  return { ...reply, body: branch };
}

/**
 * One file's decoded contents, or null when it is absent.
 *
 * Absent is a legitimate answer rather than a failure: this is how the contract
 * learns a repository has no `package.json` and therefore declares no
 * verification commands of its own.
 */
export async function readFile(
  repository: ForgeRepository,
  path: string,
  ref: string,
): Promise<ForgeReply<string | null>> {
  const reply = await get<{ content?: string; encoding?: string }>(
    `/repos/${repository.slug}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  if (reply.status === 404) {
    return { ok: true, status: 404, body: null, reason: null, authenticated: reply.authenticated };
  }
  if (!reply.ok) return { ...reply, body: null };
  const { content, encoding } = reply.body ?? {};
  if (typeof content !== 'string' || encoding !== 'base64') {
    return {
      ok: false,
      status: reply.status,
      body: null,
      reason: 'The forge returned the file in a form this reader does not accept.',
      authenticated: reply.authenticated,
    };
  }
  return {
    ok: true,
    status: reply.status,
    body: Buffer.from(content, 'base64').toString('utf8'),
    reason: null,
    authenticated: reply.authenticated,
  };
}

/* ------------------------------------------------------------------------- */
/* What verification needs after a worker says it pushed                      */
/* ------------------------------------------------------------------------- */

export interface ForgeComparison {
  baseSha: string;
  headSha: string;
  aheadBy: number;
  /** Paths the range touched, as the forge reports them. */
  files: string[];
  /** True when the forge truncated the file list, so the set is not complete. */
  truncated: boolean;
  /**
   * The forge's own word for how the two commits relate: `identical`, `ahead`,
   * `behind` or `diverged`. It is what makes containment answerable — `head`
   * contains `base` exactly when this is `identical` or `ahead` — and containment
   * is what lets Brain believe an integration commit carries a unit's work
   * without holding either tree.
   */
  status: string;
}

/**
 * What changed between two commits, according to the repository.
 *
 * This is the call that makes ownership enforceable without a checkout: the unit
 * declared the paths it owns, the worker said it changed some files, and this
 * says which files actually moved. The worker's list is never the input to that
 * judgement.
 *
 * `truncated` matters and is not smoothed over. The compare endpoint caps its
 * file list, and a capped list cannot prove a diff stayed inside a scope — so a
 * caller that treats truncation as "no violation found" would be inventing a
 * guarantee. It is surfaced and the caller fails closed.
 */
export async function compareCommits(
  repository: ForgeRepository,
  base: string,
  head: string,
): Promise<ForgeReply<ForgeComparison>> {
  const reply = await get<{
    ahead_by?: number;
    status?: string;
    files?: { filename?: string }[];
    base_commit?: { sha?: string };
    merge_base_commit?: { sha?: string };
  }>(`/repos/${repository.slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  if (!reply.ok) return { ...reply, body: null };
  const files = (reply.body?.files ?? [])
    .map((file) => (typeof file.filename === 'string' ? file.filename : null))
    .filter((name): name is string => name !== null);
  return {
    ...reply,
    body: {
      baseSha: reply.body?.merge_base_commit?.sha ?? reply.body?.base_commit?.sha ?? base,
      headSha: head,
      aheadBy: Number(reply.body?.ahead_by ?? 0),
      files,
      // The documented cap. Equality rather than `>=` because the forge reports
      // exactly this many and then stops.
      truncated: files.length >= 300,
      status: String(reply.body?.status ?? 'unknown'),
    },
  };
}

export interface ForgePullRequest {
  number: number;
  state: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  merged: boolean;
  url: string;
  title: string;
  updatedAt: string;
}

/** One pull request, so Brain can say whether the worker really updated it. */
export async function readPullRequest(
  repository: ForgeRepository,
  number: number,
): Promise<ForgeReply<ForgePullRequest>> {
  const reply = await get<{
    number?: number;
    state?: string;
    merged?: boolean;
    html_url?: string;
    title?: string;
    updated_at?: string;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
  }>(`/repos/${repository.slug}/pulls/${number}`);
  if (!reply.ok) return { ...reply, body: null };
  const body = reply.body ?? {};
  if (typeof body.head?.sha !== 'string') {
    return {
      ok: false,
      status: reply.status,
      body: null,
      reason: 'The forge described a pull request with no head commit.',
      authenticated: reply.authenticated,
    };
  }
  return {
    ...reply,
    body: {
      number: Number(body.number ?? number),
      state: String(body.state ?? 'unknown'),
      headSha: body.head.sha,
      headRef: String(body.head.ref ?? ''),
      baseRef: String(body.base?.ref ?? ''),
      merged: body.merged === true,
      url: String(body.html_url ?? ''),
      title: String(body.title ?? ''),
      updatedAt: String(body.updated_at ?? ''),
    },
  };
}

/**
 * Whether this Brain can read a repository at all, as a yes or no with a reason.
 *
 * Called before an objective is accepted, so that a campaign is never created
 * against a repository whose work could not afterwards be verified. The failure
 * a person sees names the repository and never the credential.
 */
export async function checkReadable(
  remote: string,
): Promise<{ ok: true; repository: ForgeRepository; defaultBranch: string } | { ok: false; reason: string }> {
  const repository = parseRemote(remote);
  if (!repository) {
    return {
      ok: false,
      reason:
        'That is not a repository this factory can read. It must be an https github.com URL ' +
        'naming exactly one owner and one repository.',
    };
  }
  const branch = await defaultBranch(repository);
  if (!branch.ok || !branch.body) {
    return { ok: false, reason: branch.reason ?? 'The forge did not answer.' };
  }
  return { ok: true, repository, defaultBranch: branch.body };
}

/**
 * The open pull request whose head is this branch, if there is one.
 *
 * This is how a campaign comes to know which pull request it updates, and the
 * point is that **it is derived rather than supplied**. A caller naming a number
 * would be a caller choosing which pull request the factory writes into; a branch
 * that is already some request's head answers the question by itself, and a branch
 * that is nobody's head means open a new one.
 *
 * Searched by head ref rather than by listing everything, so a repository with
 * hundreds of open requests answers in one call and cannot be paged past.
 */
export async function findPullRequestForBranch(
  repository: ForgeRepository,
  branch: string,
): Promise<ForgeReply<ForgePullRequest | null>> {
  const head = `${repository.owner}:${branch}`;
  const reply = await get<
    {
      number?: number;
      state?: string;
      merged_at?: string | null;
      html_url?: string;
      title?: string;
      updated_at?: string;
      head?: { sha?: string; ref?: string };
      base?: { ref?: string };
    }[]
  >(`/repos/${repository.slug}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=10`);
  if (!reply.ok) return { ...reply, body: null };
  const rows = Array.isArray(reply.body) ? reply.body : [];
  const match = rows.find((row) => typeof row.head?.sha === 'string' && row.head.ref === branch);
  if (!match || typeof match.head?.sha !== 'string') {
    return { ...reply, body: null };
  }
  return {
    ...reply,
    body: {
      number: Number(match.number ?? 0),
      state: String(match.state ?? 'open'),
      headSha: match.head.sha,
      headRef: String(match.head.ref ?? branch),
      baseRef: String(match.base?.ref ?? ''),
      merged: typeof match.merged_at === 'string' && match.merged_at.length > 0,
      url: String(match.html_url ?? ''),
      title: String(match.title ?? ''),
      updatedAt: String(match.updated_at ?? ''),
    },
  };
}

export interface ForgeCheck {
  name: string;
  /** `queued`, `in_progress` or `completed`. */
  status: string;
  /** `success`, `failure`, `neutral`, `cancelled`, `timed_out`, `action_required`, or null. */
  conclusion: string | null;
}

export interface ForgeChecks {
  sha: string;
  checks: ForgeCheck[];
  /** No check has reported at all. Not the same fact as "everything passed". */
  none: boolean;
  pending: boolean;
  failed: ForgeCheck[];
}

/**
 * What the repository's own continuous integration says about one commit.
 *
 * This exists because of §25's rule that a worker's summary is never evidence. A
 * worker reports the exit codes it saw, and that is worth keeping — but a project
 * whose CI runs on every push has already produced an account of the same commit
 * that Brain can read for itself, and reading it turns "the tests passed" from a
 * claim into a fact about the repository.
 *
 * The three answers are kept apart on purpose. A failing check is a refusal. A
 * pending check is *not yet*, and a caller waits rather than deciding. No check at
 * all is neither — it is an absence, and a caller that treated it as a pass would
 * be reporting a guarantee the repository never gave.
 */
export async function readChecks(
  repository: ForgeRepository,
  sha: string,
): Promise<ForgeReply<ForgeChecks>> {
  const reply = await get<{
    total_count?: number;
    check_runs?: { name?: string; status?: string; conclusion?: string | null }[];
  }>(`/repos/${repository.slug}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
  if (!reply.ok) return { ...reply, body: null };
  const checks: ForgeCheck[] = (reply.body?.check_runs ?? []).map((run) => ({
    name: String(run.name ?? 'unnamed'),
    status: String(run.status ?? 'unknown'),
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
  }));
  const failed = checks.filter(
    (check) =>
      check.status === 'completed' &&
      check.conclusion !== null &&
      !['success', 'neutral', 'skipped'].includes(check.conclusion),
  );
  return {
    ...reply,
    body: {
      sha,
      checks,
      none: checks.length === 0,
      pending: checks.some((check) => check.status !== 'completed'),
      failed,
    },
  };
}

/** Raised when a caller asked for verification the forge could not supply. */
export function unverifiable(reason: string): FactoryError {
  return new FactoryError(`The repository could not be verified: ${reason}`, {
    reason: 'FORGE_UNREADABLE',
  });
}
