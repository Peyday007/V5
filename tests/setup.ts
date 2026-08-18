/**
 * Every test file gets its own isolated data root. Vitest runs each file in a
 * fresh forked process with a fresh module registry, and setup files execute
 * before the test module (and therefore before server/env.ts) is imported.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
process.env.BRAIN_DATA_DIR = dir;
process.env.BRAIN_DB_PATH = path.join(dir, 'brain.db');
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
