/**
 * The manufacturing kernel's source input, and whether the deployed Brain can
 * actually open it.
 *
 * `registerBlueprint` reads a source **by path** and hashes the bytes it read,
 * so a blueprint that exists only in the repository is one the deployed Brain
 * can never ingest. The Dockerfile's own comment records that failing twice —
 * once for the input living under `docs/` (excluded) and once for the `COPY`
 * being absent — and records a third: a `COPY` whose *source* was under an
 * excluded path, which died at `"/docs/capability": not found` on every deploy
 * while the test guarding it passed, because reading a Dockerfile tells you
 * what it intends and never what it can reach.
 *
 * So this reads all three things together: the bytes exist, a `COPY` carries
 * them, and no `.dockerignore` pattern removes them from the build context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BLUEPRINT = 'blueprints/MANUFACTURING-EMPIRE-KERNEL.md';

/**
 * Docker's ignore semantics, as far as this needs them.
 *
 * Patterns are matched against the whole relative path with Go's
 * `filepath.Match`, where `*` does **not** cross a `/`. So `*.md` removes
 * root-level markdown and nothing under a directory, and `docs` removes that
 * directory and everything beneath it. Written out rather than assumed,
 * because "`*.md` surely does not match `blueprints/x.md`" is exactly the kind
 * of belief that put `COPY docs/capability` into a Dockerfile.
 */
function excludedByDocker(candidate: string, pattern: string): boolean {
  const clean = pattern.replace(/\/+$/, '');
  if (clean.includes('**')) {
    const rx = new RegExp(
      `^${clean.split('**').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*')}$`,
    );
    return rx.test(candidate);
  }
  const segments = clean.split('/');
  const parts = candidate.split('/');
  if (segments.length > parts.length) return false;
  for (const [index, segment] of segments.entries()) {
    const rx = new RegExp(
      `^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`,
    );
    if (!rx.test(parts[index]!)) return false;
  }
  // A directory pattern removes everything beneath it.
  return true;
}

describe('the manufacturing blueprint is an input the deployed Brain can open', () => {
  it('exists in the repository at the path the image copies from', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, BLUEPRINT))).toBe(true);
  });

  it('is carried into the image, outside the tree DOCUMENTED is read from', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/COPY blueprints \.\/blueprints/);
    // `readTextIndex` reads `docs/`, and a `docs/` tree holding a blueprint and
    // nothing else makes every component it does not name read a confident NO.
    expect(dockerfile).not.toMatch(/COPY\s+\S*blueprints\S*\s+\.\/docs/);
  });

  /**
   * The matcher itself, checked against paths whose answer is already known.
   *
   * A survival test is worth nothing if the matcher excludes nothing: it would
   * pass for any path, including one genuinely removed from the context. So
   * the three cases that decide this are asserted first — `docs/` is excluded
   * as a directory, a root-level `.md` is excluded by `*.md`, and that same
   * pattern does **not** reach inside a directory, which is the exact belief
   * the blueprint's placement rests on.
   */
  it('has a matcher that excludes what .dockerignore really excludes', () => {
    expect(excludedByDocker('docs/CLOUD.md', 'docs')).toBe(true);
    expect(excludedByDocker('data/brain.db', 'data/')).toBe(true);
    expect(excludedByDocker('CLAUDE.md', '*.md')).toBe(true);
    expect(excludedByDocker('tests/helpers.ts', 'tests')).toBe(true);
    // The one that matters: `*` does not cross a `/`.
    expect(excludedByDocker('blueprints/MANUFACTURING-EMPIRE-KERNEL.md', '*.md')).toBe(false);
    expect(excludedByDocker('blueprints/x.md', 'docs')).toBe(false);
  });

  it('survives every .dockerignore pattern, so the build context contains it', () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8');
    const patterns = ignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    let removed = false;
    for (const pattern of patterns) {
      if (pattern.startsWith('!')) {
        if (excludedByDocker(BLUEPRINT, pattern.slice(1))) removed = false;
        continue;
      }
      if (excludedByDocker(BLUEPRINT, pattern)) removed = true;
    }
    expect(removed, `${BLUEPRINT} is excluded from the Docker build context`).toBe(false);
  });

  /**
   * The mechanism is what the kernel is for, and a named progression is
   * evidence for it.
   *
   * Reducing this to one company's story would encode the roadmap the source
   * spends its own words refusing — so the general statement has to be there,
   * and the sequence has to be marked as an example rather than as an
   * instruction.
   */
  it('states the mechanism generally, and marks every named progression as evidence', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BLUEPRINT), 'utf8');

    // The three moves of the mechanism, in the general form.
    expect(text).toMatch(/buyers are already demonstrated and reachable/i);
    expect(text).toMatch(/reusable manufacturing capability through real production/i);
    expect(text).toMatch(/expand the feasible product frontier/i);

    // A named progression is evidence, never the plan.
    expect(text).toMatch(/evidence for that\s+mechanism, never the roadmap/i);
    expect(text).toMatch(/These are examples, NOT mandatory sequencing/i);
    expect(text).toMatch(/DO NOT blindly follow/i);

    // And it is explicitly not reduced to one industry or one company.
    expect(text).toMatch(/many industries, many product\s+classes, many/i);
  });

  it('keeps the original objective rather than a summary of it', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BLUEPRINT), 'utf8');
    for (const load of [
      'DO NOT manufacture products merely because we want to manufacture them',
      'Distribution and demand intelligence should pull manufacturing forward',
      'Think in capability chains',
      'Do NOT vertically integrate merely for ideological reasons',
      'BUILD THE CAPABILITIES REQUIRED TO BUILD HARDER MACHINES',
    ]) {
      expect(text, `the blueprint dropped: ${load}`).toContain(load);
    }
  });

  it('carries no authority of its own, and says so', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BLUEPRINT), 'utf8');
    expect(text).toMatch(/carries no authority of its own/i);
    expect(text).toMatch(/nothing here authorizes spending, contact, purchase/i);
  });
});
