import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/** Repository root — the directory that contains package.json. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Everything the user owns lives under the data root: the SQLite database,
 * imported documents, backups and derived runtime state. Overridable so tests
 * (and multiple checkouts) can run against an isolated tree.
 */
export const DATA_ROOT = path.resolve(
  process.env.BRAIN_DATA_DIR ?? path.join(REPO_ROOT, 'data'),
);

export const DB_PATH = process.env.BRAIN_DB_PATH ?? path.join(DATA_ROOT, 'brain.db');
export const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects');
export const RUNTIME_ROOT = path.join(DATA_ROOT, 'runtime');
export const BACKUP_ROOT = path.join(DATA_ROOT, 'backups');
export const TMP_ROOT = path.join(DATA_ROOT, 'tmp');
export const PROJECT_STATE_FILE = path.join(RUNTIME_ROOT, 'project-state.json');

/**
 * Where the Software Factory puts the worktrees its workers run in.
 *
 * Disposable by design: a worktree is execution scratch, and the evidence a
 * campaign keeps is its commits, its rows and its artifacts. So this is the one
 * factory path that is deliberately *not* authoritative state in either mode —
 * retiring a worktree after a campaign destroys nothing that mattered.
 *
 * Overridable because a factory needs somewhere on a local disk to check code
 * out, and the data root is not always the right disk for that.
 */
export const FACTORY_ROOT = path.resolve(
  process.env.BRAIN_FACTORY_ROOT ?? path.join(DATA_ROOT, 'factory'),
);

/**
 * The repository the factory operates on when a change request does not name
 * one. The checkout this server is running from, which is the only repository a
 * local factory can reach without being given a clone.
 */
export const FACTORY_DEFAULT_REPO_ROOT = path.resolve(
  process.env.BRAIN_FACTORY_REPO_ROOT ?? REPO_ROOT,
);

/**
 * `??` does not catch an empty string, and `Number('')` is 0 — which binds a
 * random ephemeral port while the banner cheerfully prints localhost:0 and the
 * Vite proxy points nowhere. Treat anything unusable as "not set".
 */
function readPort(raw: string | undefined, fallback: number): number {
  const value = Number((raw ?? '').trim());
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

export const PORT = readPort(process.env.PORT, 5174);
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * The git revision this build was made from, or null when nothing stamped it.
 *
 * ---------------------------------------------------------------------------
 * Why the deployment has to attest this itself
 * ---------------------------------------------------------------------------
 *
 * The acceptance reporter takes half its evidence from the deployed Brain's own
 * rows and half from the repository tree, and a reader can only combine the two
 * if both name the same revision. Until this existed, the revision attached to
 * a production reading came from the *workflow* that had just deployed it —
 * which is a reasonable claim and is not the deployment's own. A re-run of an
 * older dispatch, a rollback, or a machine that failed to take the new release
 * would all still be labelled with whatever sha the workflow was holding.
 *
 * So the sha is baked in at image build time (`ARG BRAIN_REVISION` in the
 * Dockerfile, passed from the deploy workflow) and read here. A process that
 * was not stamped answers **null** rather than guessing: a local checkout, a
 * plain `docker run`, and a test all legitimately have no revision, and
 * inventing one would be worse than admitting there is none — the combiner
 * refuses an unstamped production record rather than trusting it.
 *
 * It is deliberately **not** on `/healthz`, which is unauthenticated and says
 * only "the process is up" without naming the project, the database or the
 * bucket. Which commit is deployed is an operator's fact, so it travels with
 * the rest of them on `/api/health`, behind the gate and behind the
 * administrator check.
 */
export const BRAIN_REVISION: string | null =
  (process.env['BRAIN_REVISION'] ?? '').trim() || null;

/** Absolute path for a path stored relative to the data root. */
export function resolveDataPath(relativePath: string): string {
  return path.resolve(DATA_ROOT, relativePath);
}

/** Convert an absolute path into the POSIX-style, data-root-relative form we persist. */
export function toDataRelative(absolutePath: string): string {
  return path.relative(DATA_ROOT, absolutePath).split(path.sep).join('/');
}

export function ensureDataDirs(): void {
  for (const dir of [DATA_ROOT, PROJECTS_ROOT, RUNTIME_ROOT, BACKUP_ROOT, TMP_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
