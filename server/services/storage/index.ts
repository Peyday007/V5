/**
 * Choosing the document store, and holding the one Brain is using.
 *
 * The same rule the database follows: local is the default, cloud is asked for
 * explicitly, and a cloud store that cannot be reached stops the boot rather
 * than falling back. A document written to a laptop by a server reporting
 * itself as cloud-backed is a document the rest of the fleet cannot see, and
 * nobody finds out until they look for it.
 */
import { DATA_ROOT } from '../../env.ts';
import { storageConfig, type StorageConfig } from '../../config.ts';
import { LocalStorageProvider } from './local.ts';
import { SupabaseStorageProvider } from './supabase.ts';
import { StorageConfigurationError, type StorageProvider } from './types.ts';

let provider: StorageProvider | null = null;
let activeConfig: StorageConfig | null = null;

export interface InitStorageOptions {
  /** Overrides the environment. Used by the migration tool and by tests. */
  config?: StorageConfig;
  /** Local mode only: where the store lives. */
  root?: string;
  /** Injected so the cloud provider can be exercised without a live project. */
  fetchImpl?: typeof fetch;
  /**
   * Whether to prove the store works before returning.
   *
   * On by default. Turning it off is for a caller that has already verified,
   * never a way to skip finding out.
   */
  verify?: boolean;
}

/** Open the configured store and prove it is usable. */
export async function initStorage(options: InitStorageOptions = {}): Promise<StorageProvider> {
  const config = options.config ?? storageConfig();
  const opened = buildProvider(config, options);

  if (options.verify !== false) {
    try {
      await opened.verify();
    } catch (error) {
      if (error instanceof StorageConfigurationError) throw error;
      throw new StorageConfigurationError(
        `Brain is configured for ${config.provider} document storage but could not use it.`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  provider = opened;
  activeConfig = config;
  return opened;
}

function buildProvider(config: StorageConfig, options: InitStorageOptions): StorageProvider {
  if (config.provider === 'supabase') {
    return new SupabaseStorageProvider({
      url: config.supabaseUrl!,
      serviceRoleKey: config.serviceRoleKey!,
      bucket: config.bucket!,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  return new LocalStorageProvider(options.root ?? DATA_ROOT);
}

/**
 * The store in use.
 *
 * Falls back to a local provider only when nothing has been initialised — which
 * happens in a unit test that never boots. That is not a silent cloud fallback:
 * cloud mode goes through `initStorage`, and a cloud store that failed to open
 * has already stopped the process.
 */
export function getStorage(): StorageProvider {
  if (!provider) provider = new LocalStorageProvider(DATA_ROOT);
  return provider;
}

export function activeStorageConfig(): StorageConfig | null {
  return activeConfig;
}

/** Test/teardown helper. */
export function resetStorage(): void {
  provider = null;
  activeConfig = null;
}

export { LocalStorageProvider, SupabaseStorageProvider };
export * from './types.ts';
export * from './keys.ts';
