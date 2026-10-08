/**
 * The release gate's own reading of the merged diff, run from the trusted
 * checkout against the work checkout.
 *
 * Brain already refused, before anything was merged, a change whose files the
 * forge listed under a reserved path. This asks the same question of the diff
 * the gate actually built — defence in depth, because the forge's list and the
 * merge are two readings of one change — and adds one question Brain could not
 * answer without the bytes: whether an added line looks like a credential.
 *
 *   tsx scripts/release-scan.ts --work <dir> --base <ref> [--head <ref>]
 *
 * `--head` defaults to HEAD. A release resumed after the change was already
 * merged scans that merge (`--base <merge>^1 --head <merge>`) rather than the
 * branch tip, so what is classified is the change and only the change.
 *
 * Prints `RELEASE-SCAN: PASS` or `RELEASE-SCAN: FAIL <reason>` and exits
 * non-zero on a failure. One source for both lists: the domain module.
 */
import { spawnSync } from 'node:child_process';
import { RELEASE_EXCLUDED_PATHS, SECRET_PATTERNS } from '../server/domain/factoryRelease.ts';
import { matchesGlob } from '../server/services/factory/glob.ts';

export interface ScanResult {
  ok: boolean;
  reasons: string[];
}

export function scanDiff(files: string[], addedLines: string[]): ScanResult {
  const reasons: string[] = [];
  const excluded = files.filter((file) => RELEASE_EXCLUDED_PATHS.some((glob) => matchesGlob(file, glob)));
  if (excluded.length) reasons.push(`reserved path(s) changed: ${excluded.slice(0, 10).join(', ')}`);
  if (files.length === 0) reasons.push('the merge changes no files');
  const secrets = addedLines.filter((line) => SECRET_PATTERNS.some((pattern) => pattern.test(line)));
  if (secrets.length) reasons.push(`${secrets.length} added line(s) look like a credential`);
  return { ok: reasons.length === 0, reasons };
}

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

if (process.argv[1] && process.argv[1].endsWith('release-scan.ts')) {
  const work = arg('work');
  const base = arg('base');
  const head = optional('head') ?? 'HEAD';
  for (const ref of [base, head]) {
    if (!/^[A-Za-z0-9_./^-]+$/.test(ref)) throw new Error(`not a ref: ${ref}`);
  }
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', work, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const files = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  const added = git(['diff', '--unified=0', `${base}...${head}`])
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  const result = scanDiff(files, added);
  process.stdout.write(`files changed: ${files.length}\n`);
  if (result.ok) {
    process.stdout.write('RELEASE-SCAN: PASS\n');
  } else {
    process.stdout.write(`RELEASE-SCAN: FAIL ${result.reasons.join('; ')}\n`);
    process.exit(1);
  }
}
