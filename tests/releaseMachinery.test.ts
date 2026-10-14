/**
 * The deploy and release machinery's shell halves, run as the workflows run
 * them, against fake `git`, `flyctl`, `curl`, `gh` and `npm` on PATH.
 *
 * INF-7 (what is running after a failed deploy), FAC-4 (one release pass per
 * Deploy), FAC-6 (a superseded run is neutral and stops early) and FAC-7
 * (completed Postgres evidence on the exact commit). These are the real scripts
 * and the real step bodies extracted from the workflow files — not copies — so a
 * workflow that drifts from what is tested here fails here. They are not a live
 * release: nothing here fires a workflow or reads production.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deployReleased, deploySuperseded, readDeploy } from '../scripts/factory-release.ts';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);

let bin: string;
let state: string;

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'release-machinery-bin-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'release-machinery-state-'));
});
afterEach(() => {
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

/** A fake executable whose body is shell. */
function fake(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}
/** `git ls-remote` answers the tip written to state/tip; empty means unreadable. */
function fakeGit(): void {
  fake('git', `if [ "$1" = "ls-remote" ]; then t=$(cat "${state}/tip" 2>/dev/null); [ -n "$t" ] && printf '%s\\trefs/heads/production\\n' "$t"; exit 0; fi; exec /usr/bin/git "$@"`);
}
function setTip(sha: string): void {
  fs.writeFileSync(path.join(state, 'tip'), sha);
}
function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  const out = spawnSync('bash', [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: path.join(state, 'out'), ...env },
    timeout: 60_000,
  });
  const outputs = fs.existsSync(path.join(state, 'out')) ? fs.readFileSync(path.join(state, 'out'), 'utf8') : '';
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, outputs };
}

/** The `run:` body of the named step in a workflow, dedented. */
function stepBody(workflow: string, name: string): string {
  const text = read(workflow);
  const at = text.indexOf(`- name: ${name}`);
  expect(at).toBeGreaterThan(-1);
  const rest = text.slice(at);
  const run = rest.indexOf('run: |');
  const lines = rest.slice(run + 'run: |'.length + 1).split('\n');
  const indent = /^(\s*)/.exec(lines[0]!)![1]!.length;
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() !== '' && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

describe('the canonical guard tells superseded from wrong (FAC-6)', () => {
  it('0 on the tip, 3 when a newer tip exists, 1 for a wrong ref or an unreadable tip', () => {
    fakeGit();
    setTip(SHA);
    expect(runScript('.github/workflows/canonical-guard.sh', ['production', SHA, 'now']).status).toBe(0);
    setTip(NEWER);
    expect(runScript('.github/workflows/canonical-guard.sh', ['production', SHA, 'now']).status).toBe(3);
    expect(runScript('.github/workflows/canonical-guard.sh', ['claude/x', SHA, 'now']).status).toBe(1);
    setTip('');
    expect(runScript('.github/workflows/canonical-guard.sh', ['production', SHA, 'now']).status).toBe(1);
  });

  it('the asking immediately before flyctl deploy treats a superseded tree as a hard refusal', () => {
    const deploy = read('.github/workflows/deploy.yml');
    const last = stepBody('.github/workflows/deploy.yml', 'The ref must still be the canonical tip, now');
    expect(last).toMatch(/canonical-guard\.sh/);
    expect(last).not.toMatch(/set \+e|superseded/);
    // And it is still the step before `flyctl deploy`.
    expect(deploy.indexOf('The ref must still be the canonical tip, now')).toBeLessThan(deploy.indexOf('      - name: Deploy\n'));
  });
});

describe('a superseded Deploy stops early, deploys nothing, and reads neutral (FAC-6)', () => {
  const tests = () => stepBody('.github/workflows/deploy.yml', 'The whole suite, stopped if this commit is superseded');

  it('returns the suite\'s own exit status while the tip holds', () => {
    fakeGit();
    setTip(SHA);
    fake('npm', `sleep 2; touch "${state}/finished"; exit 7`);
    fs.writeFileSync(path.join(state, 'step.sh'), tests());
    const out = runScript(path.relative(ROOT, path.join(state, 'step.sh')), [], { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'production', SUPERSEDED_POLL_SECONDS: '1' });
    expect(out.status).toBe(7);
    expect(fs.existsSync(path.join(state, 'finished'))).toBe(true);
    expect(out.outputs).not.toMatch(/superseded=true/);
  });

  it('stops the suite and reports superseded once the branch moves', () => {
    fakeGit();
    setTip(SHA);
    fake('npm', `sleep 3; echo "${NEWER}" > "${state}/tip"; sleep 30; touch "${state}/finished"; exit 1`);
    fs.writeFileSync(path.join(state, 'step.sh'), tests());
    const started = Date.now();
    const out = runScript(path.relative(ROOT, path.join(state, 'step.sh')), [], { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'production', SUPERSEDED_POLL_SECONDS: '1' });
    expect(out.status).toBe(0);
    expect(out.outputs).toMatch(/superseded=true/);
    expect(fs.existsSync(path.join(state, 'finished'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it('every later job skips a superseded run, and the hand-off still tells a waiting release', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toMatch(/  verify:\n    needs: canonical\n    if: needs\.canonical\.outputs\.superseded != 'true'/);
    expect(deploy).toMatch(/    needs: \[verify, postgres-evidence\]\n[\s\S]{0,120}if: needs\.verify\.outputs\.superseded != 'true' && needs\.postgres-evidence\.outputs\.superseded != 'true'/);
    // Each superseded marker is the step the release script reads.
    const markers = deploy.match(/- name: Superseded by a newer canonical tip/g) ?? [];
    expect(markers.length).toBe(3);
    // Every expensive verify step is skipped once superseded.
    const verify = deploy.slice(deploy.indexOf('  verify:\n'), deploy.indexOf('  postgres-evidence:\n'));
    for (const step of ['npm ci', 'npm run typecheck', 'npm run build']) {
      const at = verify.indexOf(`- run: ${step}`);
      expect(at).toBeGreaterThan(-1);
      expect(verify.slice(at, at + 200)).toMatch(/if: steps\.fresh\.outputs\.superseded != 'true'/);
    }
  });

  it('a release reads a superseded run as nothing released — never as a release to verify', () => {
    const steps = [{ name: 'Superseded by a newer canonical tip', conclusion: 'success' }];
    expect(deploySuperseded(steps)).toBe(true);
    expect(deployReleased(steps)).toBe(false);
    expect(readDeploy({ conclusion: 'success', released: false, refusedAtTip: false, superseded: true })).toBe('NOT_RELEASED');
    // So it cannot be verified-and-rolled-back, and it cannot be adopted as its own successor.
    const script = read('scripts/factory-release.ts');
    expect(script).toMatch(/watched\.conclusion === 'success' && reading === 'RELEASED'/);
    expect(script).toMatch(/deployRunFor\(mergeSha, since, \[deployRunId\]\)/);
    // And a superseded run counts toward the bound on re-dispatches, so supersession cannot loop.
    expect(script).toMatch(/run\.conclusion !== 'success' \|\| !deployReleased\(await stepsOf\(run\.id\)\)/);
  });
});

describe('what is running after a failed flyctl deploy is read, not assumed (INF-7)', () => {
  function machine(revision: string | null, healthz: string): void {
    fake('flyctl', revision ? `echo "Connecting to fdaa::..." >&2; echo "${revision}"` : 'echo "Error: ssh: no machine" >&2; exit 1');
    fake('curl', `echo -n "${healthz}"`);
  }
  const observe = (window = '0') =>
    runScript('.github/workflows/observe-revision.sh', [SHA, OLDER, window], { OBSERVE_POLL_SECONDS: '0' });

  it('the new revision answering is NEW_SERVING', () => {
    machine(SHA, '200');
    const out = observe();
    expect(out.stdout).toMatch(/^DEPLOY-OUTCOME: NEW_SERVING running=a{40} healthz=200$/m);
    expect(out.outputs).toMatch(/outcome=NEW_SERVING/);
  });

  it('the new image not answering is NEW_NOT_SERVING, never serving', () => {
    machine(SHA, '503');
    expect(observe().stdout).toMatch(/DEPLOY-OUTCOME: NEW_NOT_SERVING/);
  });

  it('the previously released revision is PREVIOUS_SERVING, from two agreeing readings', () => {
    machine(OLDER, '200');
    const out = observe('60');
    expect(out.stdout).toMatch(/DEPLOY-OUTCOME: PREVIOUS_SERVING running=c{40}/);
    expect(out.stdout.match(/^reading:/gm)?.length).toBe(2);
  });

  it('an unreadable machine is UNKNOWN — not "the previous version"', () => {
    machine(null, '200');
    const out = observe();
    expect(out.stdout).toMatch(/DEPLOY-OUTCOME: UNKNOWN running=unknown/);
  });

  it('another commit is named rather than called previous', () => {
    machine(NEWER, '200');
    expect(observe('60').stdout).toMatch(/DEPLOY-OUTCOME: OTHER running=b{40}/);
  });

  it('the marker moves only when the new revision was observed serving, and the verdict says which it was', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toMatch(/- name: What is running after the failed deploy\n\s+id: observe\n\s+if: failure\(\) && steps\.release\.outcome == 'failure'/);
    expect(deploy).toMatch(/- name: Record what is running after the failed deploy\n\s+if: failure\(\) && steps\.observe\.outputs\.outcome == 'NEW_SERVING'/);
    const verdict = stepBody('.github/workflows/deploy.yml', 'The verdict');
    for (const outcome of ['NEW_SERVING', 'NEW_NOT_SERVING', 'PREVIOUS_SERVING', 'OTHER']) expect(verdict).toContain(`${outcome})`);
    // "Still serving the previous version" is said only on the reading that establishes it.
    const previous = verdict.split('\n').filter((line) => /previous/.test(line));
    expect(previous.every((line) => /previously released|PREVIOUS_SERVING|including that it is the previous version/.test(line))).toBe(true);
    // Released and verified are two fields.
    expect(deploy).toMatch(/'deployOutcome': os\.environ\['DEPLOY_OUTCOME'\]/);
    expect(deploy).toMatch(/RELEASED='\$\{\{ steps\.release\.outcome == 'success' \|\| steps\.observe\.outputs\.outcome == 'NEW_SERVING' \}\}'/);
    // The release script reads the observed release as a release.
    expect(deployReleased([{ name: 'Record what is running after the failed deploy', conclusion: 'success' }])).toBe(true);
    expect(readDeploy({ conclusion: 'failure', released: true, refusedAtTip: false, superseded: false })).toBe('RELEASED');
  });

  it('the rollback guard compares against the running revision when it descends from the marker', () => {
    const guard = stepBody('.github/workflows/deploy.yml', 'Refuse to overwrite a newer production revision');
    expect(guard).toMatch(/printenv BRAIN_REVISION/);
    expect(guard).toMatch(/git merge-base --is-ancestor "\$released" "\$running"/);
    // Unreadable is ignored, never fatal: the marker still stands.
    expect(guard).toMatch(/\|\| true\)/);
  });
});

describe('Deploy releases only a commit with completed Postgres evidence (FAC-7)', () => {
  /** gh: runs for SHA from state/runs.json, the commit status from state/status.json, dispatches recorded. */
  function fakeGh(runs: object[], status: object[] = []): void {
    fs.writeFileSync(path.join(state, 'runs.json'), JSON.stringify({ workflow_runs: runs }));
    fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({ statuses: status }));
    fake(
      'gh',
      `if [ "$1" = "workflow" ]; then echo "$@" >> "${state}/dispatched"; exit 0; fi
url="$2"; jqx="$4"
case "$url" in
  *"head_sha=${SHA}"*) jq -r "$jqx" "${state}/runs.json" ;;
  *runs*) echo '[]' ;;
  *"commits/${SHA}/status"*) jq -r "$jqx" "${state}/status.json" ;;
  *) echo '{}' ;;
esac`,
    );
  }
  const evidence = (deadline = '0', env: Record<string, string> = {}) =>
    runScript('.github/workflows/postgres-evidence.sh', [SHA, deadline], {
      GITHUB_REPOSITORY: 'Peyday007/V5',
      // Deploy runs on the canonical branch. Pinned, because a suite run on a
      // feature branch inherits that branch's name and the guard then refuses
      // the ref before it can say the commit was superseded.
      GITHUB_REF_NAME: 'production',
      EVIDENCE_POLL_SECONDS: '0',
      ...env,
    });

  beforeEach(() => {
    fakeGit();
    setTip(SHA);
  });

  it('a completed successful run on this exact commit passes', () => {
    fakeGh([{ status: 'completed', conclusion: 'success', id: 1 }]);
    const out = evidence();
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/POSTGRES-EVIDENCE: PASS/);
  });

  it('a failed run fails; cancelled or skipped runs are not evidence', () => {
    fakeGh([{ status: 'completed', conclusion: 'failure', id: 1 }]);
    expect(evidence().status).toBe(1);
    fakeGh([{ status: 'completed', conclusion: 'cancelled', id: 1 }, { status: 'completed', conclusion: 'skipped', id: 2 }]);
    const out = evidence();
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/POSTGRES-EVIDENCE: NONE/);
  });

  it('a run still in progress is waited for, not accepted', () => {
    fakeGh([{ status: 'in_progress', conclusion: null, id: 1 }]);
    const out = evidence();
    expect(out.stdout).toMatch(/reading: PENDING/);
    expect(out.status).toBe(1);
  });

  it('a descendant passing proves nothing about this commit', () => {
    // Only runs on another sha exist; the query is by this commit's sha, so none count.
    fakeGh([]);
    expect(evidence().stdout).toMatch(/POSTGRES-EVIDENCE: NONE/);
  });

  it('the factory gate\'s attestation of this exact tree counts, without a second run', () => {
    fakeGh([], [{ context: 'brain/postgres-suite', state: 'success' }]);
    const out = evidence();
    expect(out.status).toBe(0);
    expect(fs.existsSync(path.join(state, 'dispatched'))).toBe(false);
  });

  it('with no evidence at all, it asks for exactly one run', () => {
    fakeGh([]);
    evidence('2', { DISPATCH_AFTER_SECONDS: '0', EVIDENCE_POLL_SECONDS: '1' });
    const dispatched = fs.readFileSync(path.join(state, 'dispatched'), 'utf8').trim().split('\n');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatch(/workflow run postgres-suite\.yml -R Peyday007\/V5 --ref production/);
  });

  it('a newer tip makes it superseded rather than failed', () => {
    fakeGh([]);
    setTip(NEWER);
    const out = evidence('60');
    expect(out.status).toBe(3);
    expect(out.stdout).toMatch(/POSTGRES-EVIDENCE: SUPERSEDED/);
  });

  it('the canonical run is never cancelled, and other refs still are', () => {
    const suite = read('.github/workflows/postgres-suite.yml');
    const canonical = read('.github/CANONICAL_BRANCH').trim();
    expect(suite).toContain(`cancel-in-progress: \${{ github.ref != 'refs/heads/${canonical}' }}`);
    expect(suite).not.toMatch(/cancel-in-progress: true/);
  });
});

describe('one release pass per Deploy (FAC-4)', () => {
  it('a person\'s Deploy raises workflow_run; only a bot\'s Deploy hands off', () => {
    const deploy = read('.github/workflows/deploy.yml');
    const handOff = deploy.slice(deploy.indexOf('\n  hand-off:'));
    expect(handOff).toMatch(/if: \$\{\{ always\(\) && \(github\.triggering_actor \|\| github\.actor\) == 'github-actions\[bot\]' \}\}/);
    // The release workflow is dispatched with the same bot token, so a hand-off cannot recurse into Deploy.
    expect(handOff).toMatch(/gh workflow run factory-release\.yml/);
    expect(handOff).not.toMatch(/deploy\.yml/);
    const release = read('.github/workflows/factory-release.yml');
    expect(release).toMatch(/^  workflow_run:\n    workflows: \[Deploy\]/m);
    // A repeated event is still one attempt: every pass shares one queue and asks Brain the same question.
    expect(release).toMatch(/cancel-in-progress: false/);
  });
});
