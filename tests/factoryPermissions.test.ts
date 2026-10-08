/**
 * What an unattended Factory session may run without a prompt, read from the
 * checked-in settings a fired worker actually loads.
 *
 * The remedy for a permission prompt nobody is there to answer is a narrow,
 * reviewed allow rule — never `Bash` or `Bash(*)`, which would let a worker run
 * anything at all. So this asserts the shape of the allowlist rather than its
 * exact contents: every Bash rule names a command, the hard prohibitions are
 * present, and the Postgres setup that used to prompt is one reviewed script
 * that never asks for a superuser.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8')) as {
  permissions: { allow: string[]; deny: string[] };
};
const allow = settings.permissions.allow;
const deny = settings.permissions.deny;

describe('the unattended worker’s permissions', () => {
  it('never allows Bash wholesale', () => {
    for (const rule of allow) {
      expect(rule).not.toBe('Bash');
      expect(rule).not.toMatch(/^Bash\(\s*\*?\s*(:\*)?\s*\)$/);
      expect(rule).not.toMatch(/^Bash\((sh|bash|sudo|env|eval|exec|node|npx|npm run)\s*:\*\)$/);
    }
    for (const rule of allow.filter((one) => one.startsWith('Bash('))) {
      // Every Bash rule names a specific command before any wildcard.
      expect(rule).toMatch(/^Bash\([A-Za-z0-9_./=-]+[ A-Za-z0-9_./:=-]*(:\*)?\)$/);
    }
  });

  it('pre-approves the standardized test database and the routine checks', () => {
    for (const rule of [
      'Bash(scripts/test-postgres.sh:*)',
      'Bash(npm run test:pg:*)',
      'Bash(npm run typecheck)',
      'Bash(npm run test:impacted:*)',
      'Bash(npm run build)',
    ]) {
      expect(allow).toContain(rule);
    }
  });

  it('keeps the hard prohibitions', () => {
    for (const rule of [
      'Bash(git push --force:*)',
      'Bash(git push -f:*)',
      'Bash(git push --force-with-lease:*)',
      'Bash(git push origin production:*)',
      'Bash(git push origin HEAD:production:*)',
      'Bash(flyctl:*)',
      'Bash(flyctl deploy:*)',
      'Bash(flyctl secrets set:*)',
      'Bash(sudo:*)',
      'Bash(printenv:*)',
      'Bash(env)',
      'Read(./.env)',
    ]) {
      expect(deny).toContain(rule);
    }
  });

  it('starts Postgres without sudo, without a superuser, on loopback only', () => {
    const script = fs.readFileSync('scripts/test-postgres.sh', 'utf8');
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\bsudo\b/);
    expect(code).not.toMatch(/SUPERUSER/);
    expect(code).not.toMatch(/systemctl|pg_ctlcluster/);
    expect(code).toMatch(/LOGIN CREATEDB/);
    expect(code).toMatch(/listen_addresses = '127\.0\.0\.1'/);
    expect(code).toMatch(/--auth-host=reject/);
    // The suite's baseline refuses a SQL_ASCII database, which is what a bare
    // initdb under the C locale makes; found by running the suite on it.
    expect(code).toMatch(/-E UTF8/);
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:pg']).toContain('scripts/test-postgres.sh run');
  });
});
