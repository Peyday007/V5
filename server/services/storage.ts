/**
 * Document storage, addressed by key rather than by path.
 *
 * This module used to be the filesystem. It is now the shape of the filesystem
 * kept over a store that may not be one: every function that used to build a
 * path now builds a key, and `services/storage/` decides whether that key names
 * a file under `data/` or an object in a bucket.
 *
 * Two things are deliberately unchanged.
 *
 * The local layout. `projects/<slug>/documents/<layer>/<Canonical Name vX.pdf>`
 * is what somebody sees when they open the folder, and being able to drop a file
 * in by hand is a feature of this tool rather than an implementation detail. In
 * local mode the key *is* that path.
 *
 * The confinement. A key that came from a request, or from a row somebody
 * edited, must not be able to name the database or the backups. The checks that
 * used to guard paths now guard keys, and they refuse for the same reasons.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_ROOT, DATA_ROOT, toDataRelative } from '../env.ts';
import { sanitizeFilename } from '../domain/naming.ts';
import { getStorage } from './storage/index.ts';
import { contentTypeFor, documentKey, safeSegment } from './storage/keys.ts';
import { activeStorageConfig } from './storage/index.ts';

export const UNFILED_SLUG = '_unfiled';

export interface StoredFile {
  /**
   * Where the bytes are, in the store's own terms.
   *
   * The database records this. In local mode it is the data-root-relative path
   * it has always been, which is why existing rows keep working untouched.
   */
  storageKey: string;
  /** Local mode only, and only for code that genuinely needs a path. */
  absolutePath: string | null;
  /** Kept for compatibility: the same string as `storageKey` in local mode. */
  relativePath: string;
  filename: string;
  size: number;
  hash: string;
}

// ---------------------------------------------------------------------------
// Key construction
//
// These build the human-readable local layout. They are keys, not paths: the
// separator is always `/`, and nothing here touches the filesystem.
// ---------------------------------------------------------------------------

export function projectPrefix(projectSlug: string): string {
  return `projects/${safeSegment(projectSlug, 'project')}`;
}

export function documentsPrefix(projectSlug: string): string {
  return `${projectPrefix(projectSlug)}/documents`;
}

export function layerPrefix(projectSlug: string, layerSlug: string | null): string {
  return `${documentsPrefix(projectSlug)}/${safeSegment(layerSlug ?? UNFILED_SLUG, UNFILED_SLUG)}`;
}

/** Absolute local paths, for the parts of the app that are inherently local. */
export function projectDir(projectSlug: string): string {
  return path.join(PROJECTS_ROOT, projectSlug);
}

export function documentsDir(projectSlug: string): string {
  return path.join(projectDir(projectSlug), 'documents');
}

export function layerDir(projectSlug: string, layerSlug: string | null): string {
  return path.join(documentsDir(projectSlug), layerSlug ?? UNFILED_SLUG);
}

/**
 * Create the whole tree for a project up front so the user can drop files in by
 * hand. Local mode only — a bucket has no empty folders, and needs none.
 */
export async function ensureProjectTree(projectSlug: string, layerSlugs: string[]): Promise<void> {
  if (getStorage().kind !== 'local') return;
  const fs = await import('node:fs');
  fs.mkdirSync(documentsDir(projectSlug), { recursive: true });
  for (const slug of [...layerSlugs, UNFILED_SLUG]) {
    fs.mkdirSync(layerDir(projectSlug, slug), { recursive: true });
  }
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function hashObject(key: string): Promise<string> {
  return hashBuffer(await getStorage().get(key));
}

// ---------------------------------------------------------------------------
// Confinement
// ---------------------------------------------------------------------------

/**
 * Resolve a stored key to a local path, refusing anything outside the store.
 *
 * Only meaningful in local mode. Cloud callers read bytes through
 * `readObject`; anything that insists on a path there is a bug, and gets a
 * refusal that says so rather than a path that happens to exist.
 */
export function absolutePathFor(relativePath: string): string {
  if (getStorage().kind !== 'local') {
    throw new Error(
      'This Brain stores documents in the cloud, where they have no local path. ' +
        'Read the bytes through the storage layer instead.',
    );
  }
  const resolved = path.resolve(DATA_ROOT, relativePath);
  const root = path.resolve(DATA_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to resolve a path outside the data root: ${relativePath}`);
  }
  return resolved;
}

/**
 * Confine a caller-supplied key to one project's documents tree.
 *
 * Being under the data root is not enough — the database, the runtime snapshot
 * and the backups all live there too. Any endpoint that takes a location from
 * the outside world and then MOVES or registers what is there must use this, or
 * a crafted key of "brain.db" relocates the database into the documents tree
 * and destroys the project.
 */
export function assertInsideProjectDocuments(projectSlug: string, relativePath: string): string {
  const prefix = `${documentsPrefix(projectSlug)}/`;
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalised.startsWith(prefix) || normalised.includes('../')) {
    throw new Error(
      `Refusing to touch "${relativePath}": it is not inside this project's documents folder.`,
    );
  }
  // In local mode the path check still has to hold on the resolved form, since
  // a symlink or an odd separator could satisfy the string test and not the
  // filesystem one.
  if (getStorage().kind === 'local') {
    const resolved = path.resolve(DATA_ROOT, normalised);
    const root = path.resolve(documentsDir(projectSlug));
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(
        `Refusing to touch "${relativePath}": it is not inside this project's documents folder.`,
      );
    }
  }
  return normalised;
}

/**
 * The same confinement, forgiving about which root the caller counted from.
 *
 * Every key Brain hands out is relative to the store
 * (`projects/<slug>/documents/_unfiled/x.txt`), but somebody looking at the
 * folder sees `_unfiled/x.txt` and types that. Both name the same object, so
 * both are accepted — and both are then confined to this project's documents
 * tree, which is the part that actually matters.
 */
export async function resolveStoredKey(projectSlug: string, relativePath: string): Promise<string> {
  const trimmed = relativePath.replace(/^[\\/]+/, '');
  try {
    return assertInsideProjectDocuments(projectSlug, trimmed);
  } catch (error) {
    // The second reading is a convenience, so it has to earn its exception: it
    // applies only when it names an object that is really there. Otherwise
    // "brain.db" would stop being refused and start resolving to a documents
    // key that does not exist, turning a clear refusal into a puzzling absence.
    const asDocumentsRelative = `${documentsPrefix(projectSlug)}/${trimmed.split(path.sep).join('/')}`;
    try {
      const candidate = assertInsideProjectDocuments(projectSlug, asDocumentsRelative);
      if (await getStorage().exists(candidate)) return candidate;
    } catch {
      // Fall through: the caller's own key is what the refusal should name.
    }
    throw error;
  }
}

/** Kept for the local-only callers that still want a path. */
export async function resolveStoredFile(projectSlug: string, relativePath: string): Promise<string> {
  return absolutePathFor(await resolveStoredKey(projectSlug, relativePath));
}

/**
 * Where a document's bytes are, in the store's own terms.
 *
 * `storage_key` is the address; `filesystem_path` is where the file is on this
 * machine, when it is on this machine. They hold the same string in local mode
 * — migration 013 backfilled one from the other — and diverge in cloud mode,
 * where there is no local path at all.
 *
 * Any code reaching for the bytes wants this. Code that genuinely wants a
 * local path — a reconcile report naming what a person would find in the
 * folder — should keep reading `filesystemPath`, and get null when there is
 * none, which is the true answer.
 */
export function storageKeyOf(
  document: { storageKey?: string | null; filesystemPath?: string | null } | null | undefined,
): string | null {
  return document?.storageKey ?? document?.filesystemPath ?? null;
}

export async function objectExists(key: string | null | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    return await getStorage().exists(key);
  } catch {
    return false;
  }
}

export async function objectSize(key: string): Promise<number | null> {
  try {
    return (await getStorage().head(key))?.size ?? null;
  } catch {
    return null;
  }
}

/** Read a stored object's bytes, wherever it lives. */
export async function readObject(key: string): Promise<Buffer> {
  return await getStorage().get(key);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Never overwrite: `name.pdf` → `name (2).pdf` → `name (3).pdf`. */
async function uniqueKey(prefix: string, filename: string): Promise<string> {
  const store = getStorage();
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = `${prefix}/${filename}`;
  let n = 2;
  while (await store.exists(candidate)) {
    candidate = `${prefix}/${stem} (${n})${ext}`;
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
  /**
   * Identity-based key parts, used when the store is not a browsable folder.
   *
   * In the cloud a key survives a rename because it is built from ids; locally
   * the readable layout is worth more, because a person opens that folder.
   */
  identity?: { projectId: string; documentId: string };
}

export async function storeFile(input: StoreFileInput): Promise<StoredFile> {
  const store = getStorage();
  const filename = sanitizeFilename(path.basename(input.filename));

  const key =
    store.kind === 'local' || !input.identity
      ? await uniqueKey(layerPrefix(input.projectSlug, input.layerSlug), filename)
      : documentKey({ ...input.identity, filename });

  const meta = await store.put({
    key,
    body: input.contents,
    contentType: contentTypeFor(filename),
    originalFilename: path.basename(input.filename),
  });

  return {
    storageKey: meta.key,
    absolutePath: store.kind === 'local' ? path.resolve(DATA_ROOT, meta.key) : null,
    relativePath: meta.key,
    filename: path.basename(meta.key),
    size: meta.size,
    hash: meta.checksum,
  };
}

/** Move an already-stored object, e.g. after a correction. */
export async function relocateFile(
  currentKey: string,
  projectSlug: string,
  layerSlug: string | null,
  filename: string,
): Promise<StoredFile> {
  const store = getStorage();
  const target = await uniqueKey(
    layerPrefix(projectSlug, layerSlug),
    sanitizeFilename(path.basename(filename)),
  );
  const meta = await store.move(currentKey, target);
  return {
    storageKey: meta.key,
    absolutePath: store.kind === 'local' ? path.resolve(DATA_ROOT, meta.key) : null,
    relativePath: meta.key,
    filename: path.basename(meta.key),
    size: meta.size,
    hash: meta.checksum,
  };
}

/** Every object under a project's documents tree, as store keys. */
export async function listProjectFiles(projectSlug: string): Promise<string[]> {
  return await getStorage().list(`${documentsPrefix(projectSlug)}/`);
}

/** The layer folder a stored key sits in, or null when it is unfiled. */
export function layerSlugFromPath(projectSlug: string, relativePath: string): string | null {
  const prefix = `${documentsPrefix(projectSlug)}/`;
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalised.startsWith(prefix)) return null;
  const first = normalised.slice(prefix.length).split('/')[0];
  if (!first || first.startsWith('..')) return null;
  return first === UNFILED_SLUG ? null : first;
}

/** Which store a document's bytes are in, for the record kept on the row. */
export function currentStorageProvider(): 'LOCAL' | 'SUPABASE' {
  return (activeStorageConfig()?.provider ?? getStorage().kind) === 'supabase' ? 'SUPABASE' : 'LOCAL';
}

export { toDataRelative };
