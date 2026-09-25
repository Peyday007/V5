#!/usr/bin/env node
/**
 * The development test run: only what the change can reach.
 *
 * The full suite is thousands of tests and, against Postgres, the best part of an
 * hour on a slow runner. Paying that on every intermediate commit buys nothing the
 * final gate does not already buy, and it is what made a routine change wait on
 * three full suites before it could merge. So ordinary development runs this, and
 * exactly one full cross-system gate runs on the SHA that is actually integrated
 * and released: the `Postgres suite` workflow on a push to the canonical branch,
 * and `Deploy`'s own test job on the commit it releases (see CLAUDE.md, "Checks
 * before you call a change done").
 *
 * What it selects, and why each part is there:
 *
 *   * every test file the change itself added or edited;
 *   * every test that imports a changed file directly — not transitively (see
 *     `directlyCovering`), and not through `import type`, which is erased
 *     before anything runs; `--transitive` asks vitest's module graph instead;
 *   * the structural guards that read the repository rather than import it, and
 *     which a module graph therefore cannot see: the migration chains, the
 *     deployment ownership walk, and the workflow rules. They are cheap, and they
 *     are exactly the defects that arrive as a clean merge and fail at boot.
 *
 * Usage:
 *   npm run test:impacted                  # against origin/<canonical branch>
 *   npm run test:impacted -- --base <ref>  # against another base
 *   npm run test:impacted -- --list        # print the selection, run nothing
 *   npm run test:impacted -- --transitive  # every test the module graph reaches
 *
 * Against Postgres: set BRAIN_TEST_DATABASE_URL, exactly as for the full suite.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.chdir(root);

/** Guards that read files instead of importing them, so no module graph finds them. */
export const ALWAYS_RUN = [
  'tests/deploymentOwnership.test.ts',
  'tests/testingWorkflow.test.ts',
];
/** Run when either migration chain moved. */
export const WHEN_SCHEMA_CHANGES = [
  'tests/migration.test.ts',
  'tests/migrations.test.ts',
];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const canonical = fs.readFileSync('.github/CANONICAL_BRANCH', 'utf8').trim();
const base = argValue('--base') ?? `origin/${canonical}`;
const listOnly = process.argv.includes('--list');

let mergeBase;
try {
  mergeBase = git('merge-base', base, 'HEAD');
} catch {
  console.error(`test:impacted: cannot find a merge base with ${base}. Fetch it first, or pass --base <ref>.`);
  process.exit(2);
}

const changed = new Set(
  [
    git('diff', '--name-only', mergeBase, 'HEAD'),
    git('diff', '--name-only', 'HEAD'),
    git('ls-files', '--others', '--exclude-standard'),
  ]
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => fs.existsSync(file)),
);

const isTest = (file) => /^tests\/.*\.test\.tsx?$/.test(file);
const isSchema = (file) => /^server\/db\/(pg-)?migrations\/.*\.sql$/.test(file);
const transitive = process.argv.includes('--transitive');

/**
 * The tests that import a changed file *directly* — a static `from '…'` or a
 * dynamic `import('…')` in the test file itself, or in a `tests/` helper it
 * imports. Deliberately not the whole module graph: `policy.ts` and the router
 * sit under the server every HTTP suite boots, so the transitive closure of
 * almost any server change is most of the suite, which is the cost this script
 * exists to stop paying on every commit. `--transitive` asks vitest for the
 * wide answer when a change genuinely needs it.
 */
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  const add = (spec) => out.push(path.normalize(path.join(path.dirname(file), spec)));
  // A static import, skipped when it is `import type`: that is erased before the
  // test runs, so a test naming a type from a changed module exercises none of it.
  for (const match of text.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!match[2]) add(match[3]);
  }
  // A side-effect import and a dynamic one always run code.
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/g)) add(match[1]);
  for (const match of text.matchAll(/import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)) add(match[1]);
  return out;
}
const testFiles = fs.readdirSync('tests').filter((name) => /\.test\.tsx?$/.test(name)).map((name) => `tests/${name}`);
const helperChanged = (file) => file.startsWith('tests/') && !isTest(file) && changed.has(file);
const directlyCovering = testFiles.filter((test) => {
  if (changed.has(test)) return true;
  const imports = importsOf(test);
  return imports.some((target) => changed.has(target) || helperChanged(target));
});

const guards = [...ALWAYS_RUN, ...([...changed].some(isSchema) ? WHEN_SCHEMA_CHANGES : [])]
  .filter((file) => fs.existsSync(file) && !directlyCovering.includes(file));

console.log(`test:impacted: ${changed.size} changed file(s) since ${base} (${mergeBase.slice(0, 7)})`);
console.log(`  tests covering them directly: ${directlyCovering.length}`);
console.log(`  structural guards: ${guards.join(', ') || 'none'}`);

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
function run(args) {
  const result = spawnSync(process.execPath, [vitest, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

if (transitive) {
  // vitest's own module-graph selection, for a change whose reach is wide.
  const args = listOnly
    ? ['list', '--filesOnly', '--changed', mergeBase, '--passWithNoTests']
    : ['run', '--changed', mergeBase, '--passWithNoTests'];
  const status = run(args);
  if (listOnly) {
    for (const file of guards) console.log(`${file}  (guard)`);
    process.exit(0);
  }
  process.exit(run(['run', ...guards]) || status);
}

const selected = [...directlyCovering, ...guards];
if (listOnly) {
  for (const file of directlyCovering) console.log(file);
  for (const file of guards) console.log(`${file}  (guard)`);
  process.exit(0);
}
if (selected.length === 0) {
  console.log('test:impacted: nothing to run.');
  process.exit(0);
}
process.exit(run(['run', ...selected]));
