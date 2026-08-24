/**
 * Where Brain's state lives, read from the environment once and checked.
 *
 * Two decisions are made here and nowhere else: which database holds the
 * project's state, and which store holds its files. Both default to local,
 * because a local-first tool that needed a cloud account to boot would have
 * stopped being one.
 *
 * The rule that matters most is what happens when cloud mode is asked for and
 * cannot be delivered. Nothing falls back. A Brain told to use Postgres and
 * unable to reach it refuses to start and says why, because the alternative —
 * quietly writing to a local file while reporting itself as cloud-backed — is
 * how a person ends up believing their work is safe somewhere it is not.
 *
 * Secrets are read here and go no further. `describe()` returns what an
 * operator needs in order to recognise their own configuration; it never
 * returns a key, a password, or a connection string.
 */
import { DatabaseConfigurationError } from './db/types.ts';

export type DatabaseProvider = 'sqlite' | 'postgres';
export type StorageProvider = 'local' | 'supabase';

export interface DatabaseConfig {
  provider: DatabaseProvider;
  /** Set only for Postgres. Never logged, never returned by an endpoint. */
  connectionString: string | null;
  poolSize: number;
}

export interface StorageConfig {
  provider: StorageProvider;
  supabaseUrl: string | null;
  /** Server-side only. Never crosses to the browser in any form. */
  serviceRoleKey: string | null;
  bucket: string | null;
}

export interface PersistenceConfig {
  database: DatabaseConfig;
  storage: StorageConfig;
}

function read(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

function readProvider<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = read(name);
  if (raw === null) return fallback;
  const value = raw.toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw new DatabaseConfigurationError(
      `${name} is set to "${raw}", which is not one of: ${allowed.join(', ')}.`,
      'Fix the value or unset it to use the default.',
    );
  }
  return value;
}

function readPoolSize(): number {
  const raw = read('BRAIN_DATABASE_POOL_SIZE');
  if (raw === null) return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new DatabaseConfigurationError(
      `BRAIN_DATABASE_POOL_SIZE is "${raw}", which is not a whole number between 1 and 100.`,
    );
  }
  return value;
}

/**
 * The database half, validated.
 *
 * A Postgres URL is checked for shape here rather than at first query: a
 * typo in a connection string should stop the boot with a sentence about the
 * connection string, not surface twenty seconds later as a socket error.
 */
export function databaseConfig(): DatabaseConfig {
  const provider = readProvider('BRAIN_DATABASE_PROVIDER', ['sqlite', 'postgres'] as const, 'sqlite');
  if (provider === 'sqlite') {
    return { provider, connectionString: null, poolSize: 1 };
  }

  const connectionString = read('BRAIN_DATABASE_URL');
  if (!connectionString) {
    throw new DatabaseConfigurationError(
      'BRAIN_DATABASE_PROVIDER is "postgres" but BRAIN_DATABASE_URL is not set.',
      'Set BRAIN_DATABASE_URL to your Postgres connection string, or set ' +
        'BRAIN_DATABASE_PROVIDER=sqlite to work locally. Brain will not fall back on its own: ' +
        'a server that quietly wrote to a local file while reporting itself as cloud-backed ' +
        'would be worse than one that refused to start.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new DatabaseConfigurationError(
      'BRAIN_DATABASE_URL is not a valid connection URL.',
      'It should look like postgresql://user:password@host:5432/database. The value itself is ' +
        'not repeated here, because it contains a password.',
    );
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new DatabaseConfigurationError(
      `BRAIN_DATABASE_URL uses the "${parsed.protocol.replace(':', '')}" scheme, not postgres.`,
    );
  }
  if (!parsed.hostname) {
    throw new DatabaseConfigurationError('BRAIN_DATABASE_URL names no host.');
  }

  return { provider, connectionString, poolSize: readPoolSize() };
}

/** The storage half, validated on the same terms. */
export function storageConfig(): StorageConfig {
  const provider = readProvider('BRAIN_STORAGE_PROVIDER', ['local', 'supabase'] as const, 'local');
  if (provider === 'local') {
    return { provider, supabaseUrl: null, serviceRoleKey: null, bucket: null };
  }

  const supabaseUrl = read('SUPABASE_URL');
  const serviceRoleKey = read('SUPABASE_SERVICE_ROLE_KEY');
  const bucket = read('BRAIN_STORAGE_BUCKET');

  const missing = [
    supabaseUrl ? null : 'SUPABASE_URL',
    serviceRoleKey ? null : 'SUPABASE_SERVICE_ROLE_KEY',
    bucket ? null : 'BRAIN_STORAGE_BUCKET',
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new DatabaseConfigurationError(
      `BRAIN_STORAGE_PROVIDER is "supabase" but ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } not set.`,
      'Set them, or set BRAIN_STORAGE_PROVIDER=local. Documents will not be silently written to ' +
        'the local disk while the server reports itself as using cloud storage.',
    );
  }

  try {
    const parsed = new URL(supabaseUrl!);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new DatabaseConfigurationError(
        'SUPABASE_URL must be an https address.',
        'A service-role key sent over plain http is a key somebody else now has.',
      );
    }
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) throw error;
    throw new DatabaseConfigurationError('SUPABASE_URL is not a valid URL.');
  }

  return { provider, supabaseUrl, serviceRoleKey, bucket };
}

export function persistenceConfig(): PersistenceConfig {
  return { database: databaseConfig(), storage: storageConfig() };
}

/**
 * What an operator may be shown about the configuration.
 *
 * Deliberately not the configuration: which provider, which host, which bucket.
 * No connection string, no key, not even their lengths.
 */
export function describePersistence(config: PersistenceConfig): {
  database: { provider: DatabaseProvider; target: string };
  storage: { provider: StorageProvider; target: string };
} {
  const databaseTarget =
    config.database.provider === 'sqlite'
      ? 'local file'
      : hostOf(config.database.connectionString) ?? 'configured Postgres';

  const storageTarget =
    config.storage.provider === 'local'
      ? 'local data folder'
      : `${hostOf(config.storage.supabaseUrl) ?? 'supabase'} · bucket ${config.storage.bucket}`;

  return {
    database: { provider: config.database.provider, target: databaseTarget },
    storage: { provider: config.storage.provider, target: storageTarget },
  };
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const database = url.pathname.replace(/^\//, '');
    return database ? `${url.hostname}/${database}` : url.hostname;
  } catch {
    return null;
  }
}
