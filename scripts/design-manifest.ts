/**
 * The render set a design decision is about, digested so it can be bound to.
 *
 * ---------------------------------------------------------------------------
 * Why a digest and not a path
 * ---------------------------------------------------------------------------
 *
 * "The owner approved the renders in `docs/evidence/step12b-visual/`" is not a
 * checkable statement: the directory is mutable, and the next harness run
 * replaces every file in it. An approval has to name the *bytes* somebody
 * looked at, or it silently becomes an approval of whatever is there now —
 * which is the failure mode §23 already fixed once, by binding a re-audit
 * reservation to a document's content hash instead of to its id.
 *
 * So this reads the render set, digests it, and writes a manifest beside it.
 * `design_approvals` rows carry that digest, and the acceptance reporter refuses
 * to treat an approval as current unless the digest still matches what is on
 * disk **and** the revision still matches the tree.
 *
 * It **refuses to guess** what a file is. Every render must be declared in
 * `index.json` with its screen and width, because a digest built from a
 * filename convention would silently change meaning the first time somebody
 * renamed a file, and a manifest that is wrong about what it covers is worse
 * than none.
 *
 *   npx tsx scripts/design-manifest.ts [directory]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestRenderSet } from '../server/repos/designApprovals.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DIR = path.join(REPO, 'docs', 'evidence', 'step12b-renders');

interface Declared {
  /** Which of the four approved-preview screens this is. */
  screen: string;
  /** The width it was rendered at. The direction was reviewed at 1180/953/390. */
  width: number;
  /** File name inside the directory. */
  file: string;
}

function fail(message: string): never {
  console.error(`DESIGN MANIFEST: REFUSED — ${message}`);
  process.exit(1);
}

function main(): void {
  const dir = path.resolve(process.argv[2] ?? DEFAULT_DIR);
  if (!fs.existsSync(dir)) fail(`${dir} does not exist. Produce the renders first.`);

  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    fail(
      `${indexPath} does not exist. Every render must declare its screen and width — a digest ` +
        'built from a filename convention changes meaning the first time somebody renames a file.',
    );
  }

  let declared: Declared[];
  try {
    declared = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Declared[];
  } catch (error) {
    fail(`${indexPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(declared) || declared.length === 0) fail(`${indexPath} declares no renders.`);

  const renders = declared.map((entry) => {
    if (!entry.file || !entry.screen || !Number.isFinite(entry.width)) {
      fail(`an entry in ${indexPath} is missing file, screen or width: ${JSON.stringify(entry)}`);
    }
    const full = path.join(dir, entry.file);
    if (!fs.existsSync(full)) fail(`${indexPath} declares ${entry.file}, which is not there.`);
    return { path: entry.file, width: entry.width, screen: entry.screen, bytes: fs.readFileSync(full) };
  });

  // Anything present but undeclared is a refusal, not a warning: a digest that
  // covered three of four renders would be an approval of three of them wearing
  // the name of all four.
  const declaredFiles = new Set(renders.map((render) => render.path));
  const stray = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.png') && !declaredFiles.has(name));
  if (stray.length > 0) {
    fail(
      `${stray.length} image(s) in the directory are not declared in index.json ` +
        `(${stray.slice(0, 5).join(', ')}${stray.length > 5 ? ', …' : ''}). Declare them or remove them.`,
    );
  }

  const { digest, count } = digestRenderSet(renders);

  let revision = '';
  let dirty = true;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim().length > 0;
  } catch {
    fail('git could not name this revision, and an approval has to be bound to one.');
  }

  const manifest = {
    revision,
    treeDirtyAtManifestTime: dirty,
    renderSetDigest: digest,
    renderCount: count,
    generatedAt: new Date().toISOString(),
    renders: renders.map((render) => ({
      screen: render.screen,
      width: render.width,
      file: render.path,
      bytes: render.bytes.length,
    })),
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('DESIGN MANIFEST');
  console.log(`  directory  ${path.relative(REPO, dir)}`);
  console.log(`  revision   ${revision}${dirty ? '  (TREE DIRTY — commit before asking for a decision)' : ''}`);
  console.log(`  renders    ${count}`);
  for (const render of manifest.renders) {
    console.log(`    ${render.screen.padEnd(24)} ${String(render.width).padStart(5)}px  ${render.file}`);
  }
  console.log(`  digest     ${digest}`);
  console.log(`  written to ${path.relative(REPO, manifestPath)}`);
  console.log('');
  console.log('  This is what a decision would be bound to. Recording the decision is a person’s:');
  console.log('    npm run admin -- design approve --admin someone@example.com');
  console.log('  Nothing in scripts/ can record it, deliberately.');
}

main();
