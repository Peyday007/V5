/**
 * What stops a person's name becoming an identity again.
 *
 * The defect was not in the chain that decides a principal — that has always
 * been credential -> `oauth_tokens.worker_id` -> `workers.id`, and no step of it
 * reads a name. It was that `workers.name`, a handle whoever created the row
 * typed, was the string every surface *printed*: `brain_whoami`, the OAuth
 * consent screen, the People page, the pool report, `fleet show`. So a correct
 * resolution read as a claim about whose Claude account had run a session.
 *
 * Reverting that is one line in one file, and nothing about the running system
 * would look wrong afterwards — which is exactly why this reads the repository
 * rather than the behaviour. It is a **classification** rather than a ban, the
 * shape `operatorConsoleRemoved` settled on: `workers.name` is still a lookup
 * key two modules genuinely need, and this file says which uses are which.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

function tracked(prefixes: string[]): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
}

const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8');

/**
 * The only uses of an identity worker's `.name` that are allowed to remain, each
 * with the reason it is not an attribution.
 *
 * `server/repos/factory*.ts`, `server/services/factory/registry.ts` and
 * `scripts/factory.ts` are excluded wholesale: their `worker` is a
 * `factory_workers` row, a different table with its own operator-chosen name and
 * no principal behind it.
 */
const ALLOWED: Record<string, string> = {
  'server/services/identity/authenticate.ts':
    'workerIdentity itself — the one place the fallback from label to handle lives',
  'server/services/identity/attribution.ts':
    'reports the legacy handle beside the label, explicitly as a lookup key that attributes nothing',
  'server/services/connect/sites.ts':
    'resolves a connected site’s worker by handle; the handle is a site slug, not a person',
  'server/services/dispatch/pool.ts':
    'looks a pool’s expected worker up by handle, and prints the label',
  'server/routes/admin.ts':
    'keeps the typed handle in the identity audit beside the label, as history',
  'server/routes/oauth.ts': 'records the handle on an audit row; every screen prints the label',
  'scripts/admin.ts': 'keeps the typed handle beside the label in the identity audit and one listing',
  'scripts/fleet.ts': 'prints the legacy handle beside the label, labelled as legacy',
};

const FACTORY = [
  'server/repos/factory.ts',
  'server/repos/factoryFleet.ts',
  'server/routes/factory.ts',
  'server/services/factory/',
  'scripts/factory.ts',
  'scripts/factory-',
];

describe('a worker is named by its label', () => {
  it('builds every worker principal from the label, never from the handle', () => {
    const source = read('server/services/identity/authenticate.ts');
    // Two worker principals — the Step 7 bearer and the Step 8 token — and
    // neither may take its handle from the row's name.
    expect(source).not.toMatch(/handle:\s*worker\.name/);
    expect(source.match(/handle:\s*workerIdentity\(worker\)/g) ?? []).toHaveLength(2);
    expect(source).toContain('export function workerIdentity');
  });

  it('has no other module assembling a principal from a worker name', () => {
    const offenders = tracked(['server/', 'scripts/', 'client/'])
      .filter((file) => !FACTORY.some((prefix) => file.startsWith(prefix)))
      .filter((file) => /handle:\s*worker\??\.(name|displayName)/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('prints the label on the screen where a connector identity is chosen', () => {
    // The consent screen is where somebody decides which identity a connector
    // will authenticate as. §27 records what choosing an existing one by
    // mistake costs, and a human name on that screen is how the mistake is
    // invited.
    const source = read('server/routes/oauth.ts');
    for (const shown of [
      '<h1>Connect ${esc(workerIdentity(worker))}</h1>',
      '<dt>Worker</dt><dd><code>${esc(workerIdentity(worker))}</code></dd>',
    ]) {
      expect(source).toContain(shown);
    }
    expect(source).not.toContain('<h1>Connect ${esc(worker.displayName)}</h1>');
  });

  it('classifies every remaining read of an identity worker’s handle', () => {
    const unexplained = tracked(['server/', 'scripts/'])
      .filter((file) => !FACTORY.some((prefix) => file.startsWith(prefix)))
      .filter((file) => /\bworker\??\.(name|displayName)\b/.test(read(file)))
      .filter((file) => !(file in ALLOWED));
    // A new one is not banned — it is unexplained. Add it to ALLOWED with the
    // reason it is a lookup rather than an attribution, or use workerIdentity.
    expect(unexplained).toEqual([]);
  });

  it('keeps the allowlist honest by refusing a stale entry', () => {
    // An entry that no longer matches is a reason nobody is reading any more,
    // and the next person would trust it.
    const stale = Object.keys(ALLOWED).filter(
      (file) => !fs.existsSync(path.join(REPO, file)) || !/\bworker\??\.(name|displayName)\b/.test(read(file)),
    );
    expect(stale).toEqual([]);
  });

  it('assigns a label in exactly one place', () => {
    const source = read('server/repos/identity.ts');
    expect(source).toContain('async function nextWorkerLabel');
    // And the INSERT is the only writer of the column outside the migration,
    // so a label cannot be chosen by a caller.
    const writers = tracked(['server/', 'scripts/']).filter((file) =>
      /UPDATE\s+workers\s+SET[^`]*\blabel\b/.test(read(file)),
    );
    expect(writers).toEqual([]);
  });
});
