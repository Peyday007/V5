/**
 * Filesystem document storage (section 7).
 *
 * Layout:
 *   /data/projects/<project-slug>/documents/<layer-slug>/<Canonical Name vX.pdf>
 *   /data/projects/<project-slug>/documents/_unfiled/...   (ambiguous imports)
 *
 * Original files are preserved: nothing is ever rewritten in place, and a name
 * collision is resolved by suffixing rather than overwriting.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_ROOT, DATA_ROOT, toDataRelative } from '../env.ts';
import { sanitizeFilename } from '../domain/naming.ts';

export const UNFILED_SLUG = '_unfiled';

export interface StoredFile {
  absolutePath: string;
  /** POSIX, relative to the data root — this is what goes in the database. */
  relativePath: string;
  filename: string;
  size: number;
  hash: string;
}

export function projectDir(projectSlug: string): string {
  return path.join(PROJECTS_ROOT, projectSlug);
}

export function documentsDir(projectSlug: string): string {
  return path.join(projectDir(projectSlug), 'documents');
}

export function layerDir(projectSlug: string, layerSlug: string | null): string {
  return path.join(documentsDir(projectSlug), layerSlug ?? UNFILED_SLUG);
}

/** Create the whole tree for a project up front so the user can drop files in by hand. */
export function ensureProjectTree(projectSlug: string, layerSlugs: string[]): void {
  fs.mkdirSync(documentsDir(projectSlug), { recursive: true });
  for (const slug of [...layerSlugs, UNFILED_SLUG]) {
    fs.mkdirSync(layerDir(projectSlug, slug), { recursive: true });
  }
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function hashFile(absolutePath: string): string {
  return hashBuffer(fs.readFileSync(absolutePath));
}

/** Resolve a stored relative path back to an absolute one, refusing escapes. */
export function absolutePathFor(relativePath: string): string {
  const resolved = path.resolve(DATA_ROOT, relativePath);
  const root = path.resolve(DATA_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to resolve a path outside the data root: ${relativePath}`);
  }
  return resolved;
}

/**
 * Confine a caller-supplied path to one project's documents tree.
 *
 * `absolutePathFor` only proves a path is somewhere under the data root — and
 * the database, the runtime snapshot and the backups all live there too. Any
 * endpoint that takes a path from the outside world and then MOVES or registers
 * the file must use this instead, or a crafted `relativePath` of "brain.db"
 * relocates the database into the documents tree and destroys the project.
 */
export function assertInsideProjectDocuments(projectSlug: string, relativePath: string): string {
  const resolved = absolutePathFor(relativePath);
  const root = path.resolve(documentsDir(projectSlug));
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Refusing to touch "${relativePath}": it is not inside this project's documents folder.`,
    );
  }
  return resolved;
}

/**
 * The same confinement, forgiving about which root the caller counted from.
 *
 * Every stored path Brain hands out is relative to the data root
 * (`projects/<slug>/documents/_unfiled/x.txt`), but somebody looking at the
 * folder sees `_unfiled/x.txt` and types that. Both name the same file, so both
 * are accepted — and both are then confined to this project's documents tree,
 * which is the part that actually matters.
 */
export function resolveStoredFile(projectSlug: string, relativePath: string): string {
  const trimmed = relativePath.replace(/^[\\/]+/, '');
  try {
    return assertInsideProjectDocuments(projectSlug, trimmed);
  } catch (error) {
    // The second reading is a convenience, so it has to earn its exception: it
    // applies only when it names a file that is really there. Otherwise
    // "brain.db" would stop being refused and start resolving to a documents
    // path that does not exist, turning a clear refusal into a puzzling ENOENT.
    const asDocumentsRelative = path.posix.join(
      toDataRelative(documentsDir(projectSlug)),
      trimmed.split(path.sep).join('/'),
    );
    try {
      const resolved = assertInsideProjectDocuments(projectSlug, asDocumentsRelative);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Fall through: the caller's own path is what the refusal should name.
    }
    throw error;
  }
}

export function fileExists(relativePath: string | null | undefined): boolean {
  if (!relativePath) return false;
  try {
    return fs.statSync(absolutePathFor(relativePath)).isFile();
  } catch {
    return false;
  }
}

export function fileSize(relativePath: string): number | null {
  try {
    return fs.statSync(absolutePathFor(relativePath)).size;
  } catch {
    return null;
  }
}

/** Never overwrite: `name.pdf` → `name (2).pdf` → `name (3).pdf`. */
function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

export interface StoreFileInput {
  projectSlug: string;
  layerSlug: string | null;
  /** Platform-controlled filename. The model's own title is never used here. */
  filename: string;
  contents: Buffer;
}

export function storeFile(input: StoreFileInput): StoredFile {
  const dir = layerDir(input.projectSlug, input.layerSlug);
  fs.mkdirSync(dir, { recursive: true });
  const target = uniquePath(dir, sanitizeFilename(path.basename(input.filename)));
  fs.writeFileSync(target, input.contents);
  return {
    absolutePath: target,
    relativePath: toDataRelative(target),
    filename: path.basename(target),
    size: input.contents.byteLength,
    hash: hashBuffer(input.contents),
  };
}

/** Move an already-stored file into a different layer folder, e.g. after a correction. */
export function relocateFile(
  currentRelativePath: string,
  projectSlug: string,
  layerSlug: string | null,
  filename: string,
): StoredFile {
  const from = absolutePathFor(currentRelativePath);
  const dir = layerDir(projectSlug, layerSlug);
  fs.mkdirSync(dir, { recursive: true });
  const target = uniquePath(dir, sanitizeFilename(path.basename(filename)));
  fs.renameSync(from, target);
  const contents = fs.readFileSync(target);
  return {
    absolutePath: target,
    relativePath: toDataRelative(target),
    filename: path.basename(target),
    size: contents.byteLength,
    hash: hashBuffer(contents),
  };
}

/** Every file under a project's documents tree, as data-root-relative paths. */
export function listProjectFiles(projectSlug: string): string[] {
  const root = documentsDir(projectSlug);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !entry.name.startsWith('.')) out.push(toDataRelative(full));
    }
  };
  walk(root);
  return out.sort();
}

/** The layer folder a stored path sits in, or null when it is unfiled. */
export function layerSlugFromPath(projectSlug: string, relativePath: string): string | null {
  const rel = path.relative(documentsDir(projectSlug), absolutePathFor(relativePath));
  const first = rel.split(path.sep)[0];
  if (!first || first.startsWith('..')) return null;
  return first === UNFILED_SLUG ? null : first;
}
