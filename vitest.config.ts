import { defineConfig } from 'vitest/config';
import DurationSequencer from './tests/helpers/shardSequencer.ts';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    globals: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Forked processes give each test file a clean module registry, which the
    // database singleton and env-derived paths rely on.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    // `--shard` splits by recorded duration rather than by file count, and a
    // shard runs its longest files first (tests/helpers/shardSequencer.ts).
    sequence: { sequencer: DurationSequencer },
  },
});
