/**
 * The release workflow's safety properties, read from the file (CLAUDE.md §58).
 *
 * What must hold is structural — which job holds which token, where the
 * classifier runs from, what is never done — and a behavioural test of a GitHub
 * workflow cannot see any of it, so this reads the YAML the way
 * `deploymentOwnership` does.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
const code = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

function job(name: string): string {
  const start = code.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('unattended release needs both keys', () => {
  it('does nothing unless a repository administrator enabled it in GitHub', () => {
    expect(job('decide')).toMatch(/if: vars\.FACTORY_AUTO_RELEASE == 'enabled'/);
    expect(job('verify')).toMatch(/needs: decide/);
    expect(job('release')).toMatch(/needs: \[decide, verify\]/);
  });

  it('pushes only from the protected factory-release environment', () => {
    expect(job('release')).toMatch(/environment: factory-release/);
  });

  it('asks Brain, which answers MANUAL without a person’s authorization', () => {
    expect(job('decide')).toMatch(/factory\.sh release-decision/);
    expect(job('decide')).toMatch(/factory\.sh release-queue/);
  });
});

describe('a pull request cannot release itself', () => {
  it('runs the classifier from the canonical branch’s checkout, never the pull request’s', () => {
    const verify = job('verify');
    expect(verify).toMatch(/ref: \$\{\{ needs\.decide\.outputs\.base_sha \}\}/);
    expect(verify).toMatch(/working-directory: trusted\n[\s\S]*scripts\/release-eligibility\.ts/);
    const classify = verify.slice(0, verify.indexOf('Build the merge'));
    expect(classify).not.toMatch(/working-directory: merged/);
  });

  it('runs the pull request’s code only where there is a read-only token and no secret', () => {
    const verify = job('verify');
    expect(verify).toMatch(/permissions:\n\s+contents: read\n/);
    expect(verify).not.toMatch(/secrets\./);
    expect(verify).not.toMatch(/contents: write/);
    // The read-only token is stripped before the merged tree's code runs.
    const strip = verify.indexOf('--unset-all');
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(verify.indexOf('npm ci\n'));
  });

  it('holds the write token only where no pull request code runs', () => {
    const release = job('release');
    expect(release).toMatch(/contents: write/);
    expect(release).not.toMatch(/npm (ci|run|test)|npx /);
    expect(release).toMatch(/core\.hooksPath=\/dev\/null/);
  });

  it('pushes exactly the merge that was tested, and never forces', () => {
    const release = job('release');
    expect(release).toMatch(/test "\$\(git rev-parse HEAD\)" = "\$MERGE_SHA"/);
    expect(code).not.toMatch(/push[^\n]*(--force|\s-f\b|\+refs\/heads)/);
    expect(code).not.toMatch(/x-access-token:\$\{?GH_TOKEN\}?@/);
  });

  it('refuses a fork, a draft, another base, or a head that moved', () => {
    const decide = job('decide');
    expect(decide).toMatch(/head_repo" != "\$GITHUB_REPOSITORY"/);
    expect(decide).toMatch(/draft" != false/);
    expect(decide).toMatch(/base_ref" != "\$canonical"/);
    expect(decide).toMatch(/forge_head" != "\$head"/);
  });
});

describe('it is not a second deploy', () => {
  it('never runs flyctl deploy; it dispatches the one Deploy workflow', () => {
    expect(code).not.toMatch(/flyctl\s+deploy\b/);
    expect(job('release')).toMatch(/gh workflow run deploy\.yml --ref "\$canonical"/);
  });

  it('tests the merged tree on both backends through the one Postgres runner', () => {
    const verify = job('verify');
    expect(verify).toMatch(/npm run typecheck/);
    expect(verify).toMatch(/npm run test:impacted/);
    expect(verify).toMatch(/npm run test:pg/);
    expect(verify).toMatch(/TEST-PG: OK/);
  });

  it('validates the one dispatch input before it reaches a shell', () => {
    expect(job('decide')).toMatch(/\*\[!0-9\]\*\) echo "::error::The pull request input must be a number/);
  });
});

describe('unattended Postgres testing is one allowlisted command', () => {
  const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8')) as {
    permissions: { allow: string[] };
  };
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

  it('is an npm script a worker may run without a prompt', () => {
    expect(pkg.scripts['test:pg']).toBe('node scripts/test-pg.mjs');
    expect(settings.permissions.allow).toContain('Bash(npm run test:pg)');
    expect(settings.permissions.allow).toContain('Bash(npm run test:pg:*)');
  });

  it('starts a cluster with no TCP and no password, and refuses the full suite outside the release gate', () => {
    const script = fs.readFileSync('scripts/test-pg.mjs', 'utf8');
    expect(script).toMatch(/listen_addresses=''/);
    expect(script).toMatch(/--auth=trust/);
    expect(script).not.toMatch(/PGPASSWORD|password=/i);
    expect(script).toMatch(/process\.env\.CI !== 'true' && process\.env\.BRAIN_FULL_GATE !== '1'/);
  });
});
