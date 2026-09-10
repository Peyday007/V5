/**
 * The console is gone, and this is what stops it coming back.
 *
 * Deleting a page is easy and reverting to it is easier: a link in a runbook, a
 * "just go to /operator" in a comment, a fallback route added while debugging.
 * Every one of those is a user journey that depends on a surface that is not
 * supposed to exist, and none of them would fail a test that only checked the
 * HTTP response.
 *
 * So this reads the repository. It is deliberately a *classification* rather
 * than a ban: the codebase records its own corrections, and sentences like "it
 * was on the operator console, and that was wrong" are history worth keeping.
 * What must not exist is an instruction, a link, or a route.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

function tracked(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function read(file: string): string {
  return fs.readFileSync(path.join(REPO, file), 'utf8');
}

describe('nothing serves the operator console', () => {
  it('has no route module for it', () => {
    expect(fs.existsSync(path.join(REPO, 'server/routes/operator.ts'))).toBe(false);
    const index = read('server/index.ts');
    expect(index).not.toContain('operatorRouter');
    expect(index).not.toContain('OPERATOR_BASE');
  });

  it('refuses the path explicitly rather than letting the client bundle answer it', () => {
    // Without this the SPA fallback serves a 200 and a Russell shell at
    // /operator — not a console, but not an honest answer either.
    const index = read('server/index.ts');
    expect(index).toMatch(/'\/operator'/);
    expect(index).toMatch(/404/);
  });

  it('leaves no server-rendered form behind anywhere', () => {
    for (const file of tracked().filter((f) => f.startsWith('server/') && f.endsWith('.ts'))) {
      const source = read(file);
      // The consent screen is the one server-rendered form that survives, and
      // it posts to the OAuth authorization endpoint rather than to a console.
      if (file === 'server/routes/oauth.ts') continue;
      expect(source, file).not.toMatch(/action="\/operator/);
    }
  });
});

describe('no journey and no document sends a person there', () => {
  /**
   * An occurrence is a *dependency* when it reads as somewhere to go: a link, a
   * URL, an instruction. It is history when it is prose about a past decision.
   */
  const INSTRUCTION = /(?:go to|visit|open|sign in (?:to|at)|navigate to|head to|at)\s+\**`?\/operator/i;
  const LINK = /href=["']\/operator|\]\(\/operator|https?:\/\/[^\s)"']*\/operator/i;

  it('has no link to it in anything a person reads', () => {
    const offenders: string[] = [];
    for (const file of tracked()) {
      /*
       * Tests are exempt, and only tests. A suite proving the console is gone
       * has to name the thing it is proving absent — `queryByRole` and
       * `a[href="/operator"]` are assertions that it is *not* there, and a scan
       * that could not tell those apart would forbid checking.
       */
      if (file.startsWith('tests/')) continue;
      if (!/\.(ts|tsx|md|css|html|yml|json)$/.test(file)) continue;
      const source = read(file);
      if (LINK.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('has no instruction to go there in the documentation or the client', () => {
    const offenders: string[] = [];
    for (const file of tracked()) {
      if (file.startsWith('tests/')) continue;
      if (!(file.startsWith('docs/') || file.startsWith('client/') || file === 'README.md')) continue;
      const source = read(file);
      for (const line of source.split('\n')) {
        if (INSTRUCTION.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no /operator anywhere in the client at all', () => {
    for (const file of tracked().filter((f) => f.startsWith('client/'))) {
      expect(read(file), file).not.toContain('/operator');
    }
  });
});

describe('what replaced it exists', () => {
  it('connects a site from Russell rather than from an administration page', () => {
    const routes = read('server/routes/russell.ts');
    expect(routes).toContain("'/projects/:projectId/sites'");
    expect(routes).toContain("'/projects/:projectId/sites/:site/connect'");
    expect(routes).toContain("'/projects/:projectId/sites/:site/disconnect'");
    // The guard pair, not an administrator-plus-same-site pair.
    expect(routes).toContain('requirePerson()');
  });

  it('offers Connected sites as an ordinary section of the shell', () => {
    const shell = read('client/src/russell/RussellShell.tsx');
    expect(shell).toContain("label: 'Connected sites'");
    expect(shell).toContain('SitesView');
  });

  it('keeps the machinery on a terminal, where reaching the shell is the authentication', () => {
    const admin = read('scripts/admin.ts');
    for (const command of ['workers list', 'workers archive', 'access grant', 'packets approve']) {
      expect(admin).toContain(command);
    }
    // And it cannot mint a site credential: that is a person's decision and it
    // is shown once, in Russell, to somebody signed in.
    expect(admin).not.toContain('issueWorkerCredential');
    expect(admin).not.toContain('SITE_CONNECTOR_SCOPES');
  });

  it('names the site scope set in exactly one place that writes it', () => {
    const writers = tracked()
      .filter((f) => f.startsWith('server/') && f.endsWith('.ts'))
      .filter((f) => /grantMembership\([\s\S]*SITE_CONNECTOR_SCOPES|SITE_CONNECTOR_SCOPES[\s\S]*grantMembership\(/.test(read(f)));
    expect(writers).toEqual(['server/services/connect/sites.ts']);
  });
});
