// Runs only this investigation's sandbox harness, with the repository's own per-file isolated data root (tests/setup.ts).
import { defineConfig } from 'vitest/config';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../../../..');
export default defineConfig({
  root,
  test: {
    include: ['docs/investigation-2026-11-26/reviews/gateb_checks/harness/*.sandbox.test.ts'],
    setupFiles: [path.join(root, 'tests/setup.ts')],
    environment: 'node', globals: false, hookTimeout: 60_000, testTimeout: 60_000, pool: 'forks',
  },
});
