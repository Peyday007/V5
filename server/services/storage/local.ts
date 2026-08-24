/**
 * The local store: keys mapped onto the data folder.
 *
 * This is the behaviour Brain has always had, expressed through the new
 * interface — files under `data/`, browsable by hand, which is a feature rather
 * than an implementation detail. Somebody looking at a project folder should
 * recognise their own documents.
 *
 * The confinement is the part to keep intact. Every key is resolved and then
 * checked to be inside the root, because `absolutePathFor` alone only proves a
 * path is under the data root — and the database, the runtime snapshot and the
 * backups all live there too. A crafted key of `brain.db` must not resolve.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertSafeKey, contentTypeFor } from './keys.ts';
import {
  ObjectNotFoundError,
  StorageConfigurationError,
  type ObjectStream,
  type PutObjectInput,
  type StorageProvider,
  type StoredObjectMeta,
} from './types.ts';

/** Where the original filename and content type are remembered. */
interface SidecarMeta {
  originalFilename?: string;
  contentType?: string;
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local' as const;
  #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  describe(): string {
    return this.#root;
  }

  /** A key, as a path inside the root — and never outside it. */
  #pathFor(key: string): string {
    const safe = assertSafeKey(key);
    const resolved = path.resolve(this.#root, safe);
    if (resolved !== this.#root && !resolved.startsWith(this.#root + path.sep)) {
      throw new Error(`Refusing to resolve an object key outside the store: ${key}`);
    }
    return resolved;
  }

  /**
   * Metadata lives beside the object.
   *
   * A filesystem has nowhere else to put "the name this arrived under", and
   * losing that would mean a download handing back a sanitised key instead of
   * the file the person uploaded.
   */
  #metaPathFor(key: string): string {
    return `${this.#pathFor(key)}.brainmeta.json`;
  }

  async #readMeta(key: string): Promise<SidecarMeta> {
    try {
      return JSON.parse(await fsp.readFile(this.#metaPathFor(key), 'utf8')) as SidecarMeta;
    } catch {
      return {};
    }
  }

  async put(input: PutObjectInput): Promise<StoredObjectMeta> {
    const target = this.#pathFor(input.key);
    if (!input.overwrite && fs.existsSync(target)) {
      throw new Error(
        `An object already exists at ${input.key}. Storage never overwrites silently — ` +
          'a superseded document keeps its bytes.',
      );
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, input.body);

    const meta: SidecarMeta = {
      contentType: input.contentType ?? contentTypeFor(input.key),
    };
    if (input.originalFilename) meta.originalFilename = input.originalFilename;
    await fsp.writeFile(this.#metaPathFor(input.key), JSON.stringify(meta), 'utf8');

    return {
      key: assertSafeKey(input.key),
      size: input.body.byteLength,
      checksum: sha256(input.body),
      contentType: meta.contentType!,
      originalFilename: meta.originalFilename ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fsp.readFile(this.#pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async openRead(key: string): Promise<ObjectStream> {
    const meta = await this.head(key);
    if (!meta) throw new ObjectNotFoundError(key);
    return {
      stream: fs.createReadStream(this.#pathFor(key)),
      size: meta.size,
      contentType: meta.contentType,
    };
  }

  async head(key: string): Promise<StoredObjectMeta | null> {
    const target = this.#pathFor(key);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(target);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const meta = await this.#readMeta(key);
    return {
      key: assertSafeKey(key),
      size: stat.size,
      // Read rather than remembered: the checksum has to describe the bytes that
      // are there now, which is the whole point of checking it.
      checksum: sha256(await fsp.readFile(target)),
      contentType: meta.contentType ?? contentTypeFor(key),
      originalFilename: meta.originalFilename ?? null,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await fsp.stat(this.#pathFor(key))).isFile();
    } catch {
      return false;
    }
  }

  async move(fromKey: string, toKey: string): Promise<StoredObjectMeta> {
    const from = this.#pathFor(fromKey);
    const to = this.#pathFor(toKey);
    if (from === to) {
      const existing = await this.head(fromKey);
      if (!existing) throw new ObjectNotFoundError(fromKey);
      return existing;
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    try {
      await fsp.rename(this.#metaPathFor(fromKey), this.#metaPathFor(toKey));
    } catch {
      // A file stored before metadata existed has none to move.
    }
    const moved = await this.head(toKey);
    if (!moved) throw new ObjectNotFoundError(toKey);
    return moved;
  }

  async remove(key: string): Promise<void> {
    await fsp.rm(this.#pathFor(key), { force: true });
    await fsp.rm(this.#metaPathFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const root = this.#pathFor(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.brainmeta.json')) {
          out.push(path.relative(this.#root, full).split(path.sep).join('/'));
        }
      }
    };
    await walk(root);
    return out.sort();
  }

  async verify(): Promise<void> {
    try {
      await fsp.mkdir(this.#root, { recursive: true });
      await fsp.access(this.#root, fs.constants.W_OK);
    } catch (error) {
      throw new StorageConfigurationError(
        `The local document store at ${this.#root} is not writable.`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
