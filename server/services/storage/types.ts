/**
 * The document store, as an interface.
 *
 * A research platform's files are not incidental to its state: a claim resolves
 * to a passage, a passage to a page, a page to the bytes of a document. If those
 * bytes live on one laptop then so does the project, whatever the database says.
 * So storage gets the same treatment the database got — one boundary, two
 * implementations, and nothing above it knowing which is underneath.
 *
 * Objects are addressed by key, never by path. A key is a stable string derived
 * from Brain's own identifiers; the local provider happens to map it onto a
 * directory tree, and the cloud provider onto a bucket, but no caller may
 * assume either. That is what stops a filesystem path from leaking into the
 * database, an API response, or a request.
 */
import type { Readable } from 'node:stream';

export type StorageProviderKind = 'local' | 'supabase';

/** What the store knows about one object. */
export interface StoredObjectMeta {
  key: string;
  size: number;
  /** sha-256 of the bytes, hex. The same value the documents table records. */
  checksum: string;
  contentType: string;
  /** The name the file arrived with, kept as metadata rather than as the key. */
  originalFilename: string | null;
  updatedAt: string | null;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType?: string;
  originalFilename?: string;
  /**
   * Whether an existing object at this key may be replaced.
   *
   * Off by default, and deliberately: this platform's whole discipline is that
   * a superseded document keeps its bytes. Overwriting is something a caller
   * has to ask for by name.
   */
  overwrite?: boolean;
}

export interface ObjectStream {
  stream: Readable;
  size: number;
  contentType: string;
}

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  /** Where objects are being kept, for a banner. Never a credential. */
  describe(): string;

  put(input: PutObjectInput): Promise<StoredObjectMeta>;
  get(key: string): Promise<Buffer>;
  /** For serving a document without holding it in memory. */
  openRead(key: string): Promise<ObjectStream>;
  head(key: string): Promise<StoredObjectMeta | null>;
  exists(key: string): Promise<boolean>;
  /** Move an object to a new key, keeping its bytes. */
  move(fromKey: string, toKey: string): Promise<StoredObjectMeta>;
  /**
   * Remove an object.
   *
   * Only ever called by an explicit application operation. Nothing in the
   * research pipeline deletes evidence, and nothing here makes it easy to.
   */
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /**
   * Prove the store is usable before anything depends on it.
   *
   * The same rule as the database: having the environment variables is not the
   * same fact as the bucket answering, and only one of them may be reported.
   */
  verify(): Promise<void>;
}

/** A storage failure that is about configuration rather than one object. */
export class StorageConfigurationError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'StorageConfigurationError';
    this.detail = detail;
  }
}

/** An object that should be there and is not. */
export class ObjectNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`No stored object at ${key}.`);
    this.name = 'ObjectNotFoundError';
    this.key = key;
  }
}
