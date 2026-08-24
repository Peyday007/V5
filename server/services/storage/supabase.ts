/**
 * The cloud store: Supabase Storage over its REST API.
 *
 * No SDK. The three operations Brain needs — put, get, list — are three HTTP
 * calls, and taking a dependency to make them would put a large surface between
 * Brain and its own documents for no gain. `fetch` is in the runtime.
 *
 * The service-role key is a bearer token with full access to the bucket, so it
 * lives on the server, is read from the environment, and appears in exactly one
 * place: the Authorization header of these requests. It is never logged, never
 * returned by an endpoint, and never included in an error — the error carries
 * the status and the bucket, which is what somebody debugging actually needs.
 *
 * The bucket is private. Every read goes through Brain, which is what lets it
 * apply the project's own rules about who may see what; a public bucket would
 * be a URL anybody could pass around, permanently.
 */
import { Readable } from 'node:stream';
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

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  /** Injectable so the provider can be tested without a live project. */
  fetchImpl?: typeof fetch;
}

/** What Supabase returns from a list call. Only the fields Brain uses. */
interface SupabaseListEntry {
  name: string;
  id?: string | null;
  metadata?: { size?: number; mimetype?: string; cacheControl?: string } | null;
  updated_at?: string | null;
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly kind = 'supabase' as const;

  #base: string;
  #key: string;
  #bucket: string;
  #fetch: typeof fetch;

  constructor(options: SupabaseStorageOptions) {
    this.#base = options.url.replace(/\/+$/, '');
    this.#key = options.serviceRoleKey;
    this.#bucket = options.bucket;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  describe(): string {
    try {
      return `${new URL(this.#base).hostname}/${this.#bucket}`;
    } catch {
      return this.#bucket;
    }
  }

  #objectUrl(key: string): string {
    const safe = assertSafeKey(key);
    const encoded = safe.split('/').map(encodeURIComponent).join('/');
    return `${this.#base}/storage/v1/object/${encodeURIComponent(this.#bucket)}/${encoded}`;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#key}`,
      apikey: this.#key,
      ...extra,
    };
  }

  /** One request, with the key kept out of the failure message's blast radius. */
  async #request(url: string, init: RequestInit, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      throw new StorageConfigurationError(
        `Could not reach the document store at ${this.describe()} to ${what}.`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return response;
  }

  async put(input: PutObjectInput): Promise<StoredObjectMeta> {
    const key = assertSafeKey(input.key);
    const contentType = input.contentType ?? contentTypeFor(key);
    const response = await this.#request(
      this.#objectUrl(key),
      {
        method: input.overwrite ? 'PUT' : 'POST',
        headers: this.#headers({
          'Content-Type': contentType,
          // Supabase reads this on POST; without it a second upload to the same
          // key succeeds and the first document's bytes are gone.
          'x-upsert': input.overwrite ? 'true' : 'false',
          ...(input.originalFilename
            ? { 'x-metadata-original-filename': encodeURIComponent(input.originalFilename) }
            : {}),
        }),
        body: new Uint8Array(input.body),
      },
      'store a document',
    );

    if (!response.ok) {
      if (response.status === 409 && !input.overwrite) {
        throw new Error(
          `An object already exists at ${key}. Storage never overwrites silently — ` +
            'a superseded document keeps its bytes.',
        );
      }
      throw new StorageConfigurationError(
        `The document store refused an upload (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }

    return {
      key,
      size: input.body.byteLength,
      checksum: sha256(input.body),
      contentType,
      originalFilename: input.originalFilename ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.#request(
      this.#objectUrl(key),
      { method: 'GET', headers: this.#headers() },
      'read a document',
    );
    if (response.status === 404) throw new ObjectNotFoundError(key);
    if (!response.ok) {
      throw new StorageConfigurationError(
        `The document store refused a read (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Streaming, as far as the runtime allows.
   *
   * `fetch` gives a web stream; it is adapted rather than buffered so a large
   * PDF does not have to sit in memory to be served.
   */
  async openRead(key: string): Promise<ObjectStream> {
    const response = await this.#request(
      this.#objectUrl(key),
      { method: 'GET', headers: this.#headers() },
      'read a document',
    );
    if (response.status === 404) throw new ObjectNotFoundError(key);
    if (!response.ok || !response.body) {
      throw new StorageConfigurationError(
        `The document store refused a read (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      size: Number(response.headers.get('content-length') ?? 0),
      contentType: response.headers.get('content-type') ?? contentTypeFor(key),
    };
  }

  async head(key: string): Promise<StoredObjectMeta | null> {
    const safe = assertSafeKey(key);
    const slash = safe.lastIndexOf('/');
    const prefix = slash === -1 ? '' : safe.slice(0, slash);
    const name = slash === -1 ? safe : safe.slice(slash + 1);

    const entries = await this.#listRaw(prefix, name);
    const match = entries.find((entry) => entry.name === name);
    if (!match) return null;

    return {
      key: safe,
      size: match.metadata?.size ?? 0,
      // Supabase does not publish a sha-256, and a checksum Brain did not
      // compute is not a checksum Brain can stand behind — so the bytes are
      // read and hashed. Callers that only wanted a size pay for that; callers
      // that wanted an integrity check get a real one.
      checksum: sha256(await this.get(safe)),
      contentType: match.metadata?.mimetype ?? contentTypeFor(safe),
      originalFilename: null,
      updatedAt: match.updated_at ?? null,
    };
  }

  async exists(key: string): Promise<boolean> {
    const safe = assertSafeKey(key);
    const slash = safe.lastIndexOf('/');
    const prefix = slash === -1 ? '' : safe.slice(0, slash);
    const name = slash === -1 ? safe : safe.slice(slash + 1);
    const entries = await this.#listRaw(prefix, name);
    return entries.some((entry) => entry.name === name);
  }

  async move(fromKey: string, toKey: string): Promise<StoredObjectMeta> {
    const from = assertSafeKey(fromKey);
    const to = assertSafeKey(toKey);
    if (from === to) {
      const existing = await this.head(from);
      if (!existing) throw new ObjectNotFoundError(from);
      return existing;
    }
    const response = await this.#request(
      `${this.#base}/storage/v1/object/move`,
      {
        method: 'POST',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ bucketId: this.#bucket, sourceKey: from, destinationKey: to }),
      },
      'move a document',
    );
    if (response.status === 404) throw new ObjectNotFoundError(from);
    if (!response.ok) {
      throw new StorageConfigurationError(
        `The document store refused a move (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }
    const moved = await this.head(to);
    if (!moved) throw new ObjectNotFoundError(to);
    return moved;
  }

  async remove(key: string): Promise<void> {
    const response = await this.#request(
      this.#objectUrl(key),
      { method: 'DELETE', headers: this.#headers() },
      'delete a document',
    );
    if (!response.ok && response.status !== 404) {
      throw new StorageConfigurationError(
        `The document store refused a delete (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }
  }

  async list(prefix: string): Promise<string[]> {
    const clean = prefix.replace(/^\/+|\/+$/g, '');
    const out: string[] = [];
    const walk = async (current: string): Promise<void> => {
      const entries = await this.#listRaw(current);
      for (const entry of entries) {
        const key = current ? `${current}/${entry.name}` : entry.name;
        // Supabase reports a folder as an entry with no id.
        if (entry.id) out.push(key);
        else await walk(key);
      }
    };
    await walk(clean);
    return out.sort();
  }

  /** One page of a listing. Supabase's list is POST with a JSON body. */
  async #listRaw(prefix: string, search?: string): Promise<SupabaseListEntry[]> {
    const response = await this.#request(
      `${this.#base}/storage/v1/object/list/${encodeURIComponent(this.#bucket)}`,
      {
        method: 'POST',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          prefix,
          limit: 1000,
          offset: 0,
          ...(search ? { search } : {}),
          sortBy: { column: 'name', order: 'asc' },
        }),
      },
      'list documents',
    );
    if (!response.ok) {
      throw new StorageConfigurationError(
        `The document store refused a listing (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }
    const body = (await response.json()) as SupabaseListEntry[] | { error?: string };
    if (!Array.isArray(body)) {
      throw new StorageConfigurationError(
        'The document store returned a listing Brain could not read.',
      );
    }
    return body;
  }

  /**
   * Prove the bucket exists and this key can reach it.
   *
   * A listing is the cheapest call that fails for every reason worth failing
   * for: wrong project, wrong key, missing bucket, no network.
   */
  async verify(): Promise<void> {
    const response = await this.#request(
      `${this.#base}/storage/v1/object/list/${encodeURIComponent(this.#bucket)}`,
      {
        method: 'POST',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: '', limit: 1, offset: 0 }),
      },
      'check the bucket',
    );
    if (response.status === 400 || response.status === 404) {
      throw new StorageConfigurationError(
        `The bucket "${this.#bucket}" does not exist on ${this.describe()}.`,
        'Create it in the Supabase dashboard, keep it private, and set BRAIN_STORAGE_BUCKET to its name.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new StorageConfigurationError(
        `The document store rejected Brain's credentials (HTTP ${response.status}).`,
        'SUPABASE_SERVICE_ROLE_KEY must be the service-role key for this project. The key itself ' +
          'is not shown here.',
      );
    }
    if (!response.ok) {
      throw new StorageConfigurationError(
        `The document store could not be checked (HTTP ${response.status}).`,
        await safeBody(response),
      );
    }
  }
}

/** A response body, truncated, with nothing echoed that was sent. */
async function safeBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
