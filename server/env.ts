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

export const PORT = Number(process.env.PORT ?? 5174);
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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
