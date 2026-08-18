import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    globals: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Forked processes give each test file a clean module registry, which the
    // database singleton and env-derived paths rely on.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});
