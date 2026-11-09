/**
 * GUIDE-1 regression, second face: the probe `repo.file-at-revision` reads the guide from the
 * committed tree of a revision, not from the working directory. This pins the same property the
 * probe checks, through git itself: the guide is tracked at HEAD and names the three commands.
 * Skipped only when the checkout carries no git metadata (e.g. an exported tarball).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const hasGit = existsSync(resolve(root, '.git'));

function showAtHead(path: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

describe.skipIf(!hasGit)('docs/FACTORY-PROGRAMS.md in the committed tree (GUIDE-1)', () => {
  it('is tracked at HEAD, so a revision read finds it', () => {
    expect(showAtHead('docs/FACTORY-PROGRAMS.md')).not.toBeNull();
  });

  it('contains program-submit, program-approve and program-status at HEAD', () => {
    const body = showAtHead('docs/FACTORY-PROGRAMS.md') ?? '';
    for (const command of ['program-submit', 'program-approve', 'program-status']) expect(body).toContain(command);
  });

  it('a path that is not tracked reads as absent (the probe\'s negative case)', () => {
    expect(showAtHead('docs/NO-SUCH-GUIDE.md')).toBeNull();
  });
});
