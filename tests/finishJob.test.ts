/**
 * Finish the Job: DONE is decided by a check that reads the world, not by the
 * session's prose.
 *
 * Reproduces 2026-11-03 (session_01QF5Tk9P9WiYWeXRCMDcviQ): the $10K session read
 * the plan (NOT_VIABLE), recorded the reading, scheduled a check-in six hours out
 * (trig_01RxbZdJruyusxb1EcdF5UJa) and ended its turn with the $10K objective
 * unowned. The hook and the CLI are run as the processes Claude Code spawns,
 * against a real git repository with an `origin`, and a stand-in `gh` serving
 * the GitHub API answers. Where the Ralph Loop plugin is installed, its own Stop
 * hook is run against the state this writes.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, '.claude/hooks/finish-job.mjs');
const RESTORE = path.join(ROOT, '.claude/hooks/restore-objective.mjs');
const RALPH_STOP = path.join(os.homedir(), '.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.1/hooks/stop-hook.sh');
const SID = 'test-session-10k';

const TEN_K =
  '$10K MISSION. Make $10,000 in net cash through Brain, autonomously.\n' +
  '1. Produce a VIABLE plan for goal wst_7b4fcbb5f2384f31b6c3 on production.\n' +
  '2. Record the production evidence in docs/CASH-10K-RESULT.md.\n' +
  '3. Start the first transactions the plan names.\n';

let dir: string;
let work: string;
let fake: string;
let env: NodeJS.ProcessEnv;

function sh(cmd: string, cwd = work): string {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [HOOK, ...args], { cwd: work, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout };
}
function hook(event: object) {
  const r = spawnSync(process.execPath, [HOOK, 'hook'], { cwd: work, encoding: 'utf8', env, input: JSON.stringify({ session_id: SID, ...event }) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ralph = () => (fs.existsSync(path.join(work, '.claude/ralph-loop.local.md')) ? fs.readFileSync(path.join(work, '.claude/ralph-loop.local.md'), 'utf8') : null);
const ledger = () => JSON.parse(fs.readFileSync(path.join(work, `.claude/finish-job/${SID}.json`), 'utf8'));
const gh = (name: string, body: unknown) => fs.writeFileSync(path.join(fake, name), JSON.stringify(body));
const assign = (prompt: string) => hook({ hook_event_name: 'UserPromptSubmit', prompt });
const runs = (sha: string, conclusion: string | null, status = 'completed') => ({ workflow_runs: [{ id: 77, head_sha: sha, status, conclusion }] });

/** The plugin's own Stop hook, given a transcript whose last word is the session's claim. */
function ralphStops(claim: string): string | null {
  const transcript = path.join(dir, 'stop.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: claim }] } })}\n`);
  const r = spawnSync('bash', [RALPH_STOP], { cwd: work, encoding: 'utf8', input: JSON.stringify({ session_id: SID, transcript_path: transcript }) });
  return r.stdout.trim() ? JSON.parse(r.stdout).decision ?? null : null;
}
const haveRalph = fs.existsSync(RALPH_STOP) && spawnSync('jq', ['--version']).status === 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-job-'));
  work = path.join(dir, 'work');
  fake = path.join(dir, 'gh');
  fs.mkdirSync(fake);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(
    path.join(dir, 'bin/gh'),
    `#!/bin/bash\ncase "$2" in\n *"/pulls?head="*) f=prs;;\n */pulls/*) f=pr;;\n *postgres-suite.yml/runs*) f=ci;;\n *deploy.yml/runs*) f=deploy;;\n */actions/runs/*) f=run;;\n *) exit 1;;\nesac\n[ -f "${fake}/$f" ] && cat "${fake}/$f" || exit 1\n`,
    { mode: 0o755 },
  );
  env = {
    ...process.env,
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
    HOME: path.join(dir, 'home'),
    FINISH_JOB_ROOT: work,
    FINISH_JOB_REPO: 'Peyday007/V5',
    CLAUDE_CODE_SESSION_ID: SID,
    CLAUDE_PROJECT_DIR: work,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  sh(`git init -q --bare -b production ${dir}/origin.git && git clone -q ${dir}/origin.git ${work}`, dir);
  sh(
    'mkdir -p .github/workflows && echo production > .github/CANONICAL_BRANCH && touch .github/workflows/postgres-suite.yml .github/workflows/deploy.yml ' +
      '&& printf ".claude/finish-job/\\n.claude/ralph-loop.local.md\\n" > .gitignore && git add -A && git commit -qm base && git push -q origin HEAD:production',
  );
});

describe('the $10K failure: a status check, a scheduled check-in, a stop', () => {
  it('keeps the objective owned: the stop is refused, then WAITING (not DONE), and the next act after the wake re-arms it', () => {
    expect(assign(TEN_K).out).toContain('R3');
    expect(ledger().requirements.map((r: { text: string }) => r.text)).toEqual([
      '1. Produce a VIABLE plan for goal wst_7b4fcbb5f2384f31b6c3 on production.',
      '2. Record the production evidence in docs/CASH-10K-RESULT.md.',
      '3. Start the first transactions the plan names.',
    ]);
    expect(ralph()).toMatch(new RegExp(`session_id: ${SID}\\n[\\s\\S]*completion_promise: null`));

    // The status check, the evidence of it, the scheduled check-in — exactly what the session did.
    sh('echo "PLAN wst_7b4fcbb5f2384f31b6c3  NOT_VIABLE" > plan.txt && mkdir -p docs && echo "03:50Z: NOT_VIABLE" > docs/CASH-10K-RESULT.md && git add docs && git commit -qm evidence && git push -q origin HEAD:production');
    expect(cli('evidence', 'R1', '--cmd', "grep -q '^PLAN .* VIABLE$' plan.txt").code).toBe(0);
    expect(cli('evidence', 'R2', '--file', 'docs/CASH-10K-RESULT.md', '--contains', 'NOT_VIABLE').code).toBe(0);
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-code-remote__send_later', tool_input: { delay_minutes: 360, message: 'check' } }).code).toBe(0);

    // "DONE … check-in at 09:54Z" — refused.
    let res = cli('check');
    expect(res.out).toMatch(/^FINISH-JOB CONTINUE/);
    expect(res.out).toMatch(/\[OPEN\s*\] R1/);
    expect(res.out).toMatch(/\[DONE\s*\] R2/);
    expect(ralph()).not.toBeNull();
    if (haveRalph) expect(ralphStops('DONE. Next construction check-in at 09:54Z.')).toBe('block');

    // A check-in is a wake for R1, not its completion; R3 is still actionable.
    expect(cli('wait', 'R1', '--on', 'the next construction round', '--wake', 'trigger:trig_01RxbZdJruyusxb1EcdF5UJa').code).toBe(0);
    res = cli('check');
    expect(res.out).toMatch(/^FINISH-JOB CONTINUE/);
    expect(res.out).toMatch(/\[WAITING\] R1/);
    expect(res.out).toMatch(/\[OPEN\s*\] R3/);
    expect(ralph()).toContain('Actionable now:\n- R3');

    // Only when everything left genuinely waits is the stop released, and the objective stays open.
    expect(cli('wait', 'R3', '--on', 'a VIABLE plan names the transactions', '--wake', 'trigger:trig_01RxbZdJruyusxb1EcdF5UJa').code).toBe(0);
    res = cli('check');
    expect(res.out).toMatch(/^FINISH-JOB WAITING/);
    expect(res.out).toContain('NOT done');
    expect(ralph()).toBeNull();
    expect(ledger().status).toBe('WAITING');
    expect(ledger().requirements).toHaveLength(3);

    // The wake fires; the first thing the session does re-arms the assignment, not just the status read.
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh api repos/x/actions/runs' } });
    expect(ledger().status).toBe('ACTIVE');
    expect(ralph()).toContain('FINISH THE JOB');

    // Nothing changed: waiting again is allowed, but polling sooner is not.
    expect(cli('check').out).toMatch(/^FINISH-JOB WAITING[\s\S]*≥ 90 min/);
    const soon = hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-code-remote__send_later', tool_input: { delay_minutes: 60, message: 'check' } });
    expect(soon.code).toBe(2);
    expect(soon.err).toContain('at least 90 minutes');
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-code-remote__send_later', tool_input: { delay_minutes: 90, message: 'check' } }).code).toBe(0);
  });
});

describe('completion is decided by evidence and the repository', () => {
  it('rejects a false DONE: no evidence, trivial evidence, unmerged work, and tampering', () => {
    assign('Fix the plan read and ship it:\n- make the read take under a minute\n- merge and deploy it\n');
    sh('git checkout -qb claude/fix && mkdir -p server && echo "x" > server/read.ts && git add -A && git commit -qm fix && git push -q origin claude/fix');
    gh('prs', [{ number: 9, state: 'open', merged_at: null, head: { sha: sh('git rev-parse HEAD') }, base: { ref: 'production' } }]);

    expect(cli('evidence', 'R1', '--cmd', 'true').code).toBe(1);
    expect(cli('evidence', 'R1', '--cmd', 'npx vitest run || true').code).toBe(1);
    expect(cli('evidence', 'R1', '--cmd', 'echo passed').code).toBe(1);

    const res = cli('check');
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/^FINISH-JOB CONTINUE/);
    expect(res.out).toMatch(/\[OPEN\s*\] R1: .* no evidence attached/);
    expect(res.out).toMatch(/\[OPEN\s*\] MERGE: .*PR #9 is open/);
    if (haveRalph) expect(ralphStops('DONE — every requirement met.')).toBe('block');

    // The session cannot release the stop by hand.
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm .claude/ralph-loop.local.md' } }).code).toBe(2);
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${work}/.claude/finish-job/${SID}.json` } }).code).toBe(2);
    expect(cli('block', 'R2', '--code', 'NEEDS_REVIEW', '--detail', 'merge it please').code).toBe(1);
    expect(ralph()).not.toBeNull();
  });

  it('allows a genuinely finished assignment: evidence passes, merged, the gate green, deployed', () => {
    assign('Fix the plan read and ship it:\n- make the read take under a minute\n- merge and deploy it\n');
    sh('git checkout -qb claude/fix && mkdir -p server && echo "export const fast = 1" > server/read.ts && git add -A && git commit -qm fix && git push -q origin claude/fix');
    const head = sh('git rev-parse HEAD');
    sh('git checkout -q production && git merge -q --no-ff claude/fix -m "Merge #9" && git push -q origin production && git checkout -q claude/fix && git fetch -q origin');
    const merge = sh('git rev-parse origin/production');
    const pr = { number: 9, state: 'closed', merged_at: '2026-11-03T05:00:00Z', merge_commit_sha: merge, head: { sha: head }, base: { ref: 'production' } };
    gh('prs', [pr]);
    gh('pr', pr);
    expect(cli('evidence', 'R1', '--cmd', 'grep -q fast server/read.ts').code).toBe(0);
    expect(cli('evidence', 'R2', '--workflow', 'deploy.yml', '--pr', '9').code).toBe(0);

    gh('ci', runs(merge, null, 'in_progress'));
    let res = cli('check');
    expect(res.out).toMatch(/\[OPEN\s*\] CI: .*run 77 is in_progress/);
    expect(res.out).toMatch(/\[OPEN\s*\] DEPLOY/);

    gh('ci', runs(merge, 'success'));
    gh('deploy', runs(merge, 'success'));
    res = cli('check');
    expect(res.out).toMatch(/^FINISH-JOB DONE/);
    expect(res.code).toBe(0);
    expect(ralph()).toBeNull();
    expect(ledger().status).toBe('DONE');
    if (haveRalph) expect(ralphStops('DONE')).toBeNull();
  });

  it('a merge of only docs, tests or tooling needs no Deploy', () => {
    assign('Write the runbook and merge it:\n- write docs/RUNBOOK.md\n- merge it\n');
    sh('git checkout -qb claude/doc && mkdir -p docs && echo "# Runbook" > docs/RUNBOOK.md && git add -A && git commit -qm doc && git push -q origin claude/doc');
    sh('git checkout -q production && git merge -q claude/doc && git push -q origin production && git checkout -q claude/doc && git fetch -q origin');
    gh('ci', runs(sh('git rev-parse origin/production'), 'success'));
    cli('evidence', 'R1', '--file', 'docs/RUNBOOK.md');
    cli('evidence', 'R2', '--covered', 'R1');
    const res = cli('check');
    expect(res.out).not.toContain('DEPLOY');
    expect(res.out).toMatch(/^FINISH-JOB DONE/);
  });
});

describe('waiting on the outside world without looping', () => {
  it('a wait on a run that has ended stops counting, and the session must act on its result', () => {
    assign('Ship the research change:\n- run the research job\n- record its result\n');
    cli('wait', 'R1', '--on', 'research job', '--wake', 'run:41574598841');
    cli('wait', 'R2', '--on', 'research job', '--wake', 'run:41574598841');
    gh('run', { id: 41574598841, status: 'in_progress' });
    expect(cli('check').out).toMatch(/^FINISH-JOB WAITING/);
    gh('run', { id: 41574598841, status: 'completed', conclusion: 'success' });
    const res = cli('check');
    expect(res.out).toMatch(/^FINISH-JOB CONTINUE/);
    expect(res.out).toContain('has ended — act on its result');
  });

  it('the same failing state three checks running is STALLED: released, not looped, and the failed probe is not re-run', () => {
    assign('Make the probe pass:\n- the probe passes\n- nothing else\n');
    cli('evidence', 'R1', '--cmd', 'date >> ../count.txt; grep -q yes missing.txt');
    cli('block', 'R2', '--code', 'MISSING_AUTHORITY', '--detail', 'needs a login');
    expect(cli('check').out).toMatch(/^FINISH-JOB CONTINUE/);
    expect(cli('check').out).toMatch(/^FINISH-JOB CONTINUE/);
    expect(cli('check').out).toMatch(/^FINISH-JOB STALLED/);
    expect(ralph()).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'count.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a wait must name an armed wake; everything blocked for a rule-11 reason is BLOCKED, not DONE', () => {
    assign('Open the account and take a payment:\n- open the Square account\n- take the first payment\n');
    expect(cli('wait', 'R1', '--on', 'the owner').code).toBe(1);
    expect(cli('wait', 'R1', '--on', 'the owner', '--wake', 'later').code).toBe(1);
    cli('block', 'R1', '--code', 'MISSING_AUTHORITY', '--detail', 'only the owner can sign up');
    cli('block', 'R2', '--code', 'MISSING_AUTHORITY', '--detail', 'needs R1');
    const res = cli('check');
    expect(res.out).toMatch(/^FINISH-JOB BLOCKED/);
    expect(res.code).toBe(1);
  });
});

describe('arming, cancelling and surviving a restart', () => {
  it('a question does not arm it; "stop" from the owner ends it', () => {
    expect(assign('What does the plan read return right now?').out).toBe('');
    expect(fs.existsSync(path.join(work, `.claude/finish-job/${SID}.json`))).toBe(false);
    assign(TEN_K);
    expect(ralph()).not.toBeNull();
    assign('stop');
    expect(ralph()).toBeNull();
    expect(ledger().status).toBe('CANCELLED');
  });

  it('after compaction in a fresh container the ledger comes back from the transcript and re-arms', () => {
    assign(TEN_K);
    cli('evidence', 'R2', '--file', 'plan.txt');
    const printed = cli('check').out;
    const transcript = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        { type: 'user', origin: { kind: 'human' }, timestamp: '2026-11-03T00:00:00Z', message: { role: 'user', content: TEN_K } },
        { type: 'user', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', content: printed }] } },
      ].map((e) => JSON.stringify(e)).join('\n'),
    );
    fs.rmSync(path.join(work, '.claude'), { recursive: true });
    const r = spawnSync(process.execPath, [RESTORE], {
      cwd: work, encoding: 'utf8', env,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: SID, transcript_path: transcript }),
    });
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('ORIGINAL ASSIGNMENT');
    expect(context).toContain('FINISH-THE-JOB LEDGER');
    expect(context).toMatch(/\[OPEN\] R1/);
    expect(context.length).toBeLessThanOrEqual(10_000);
    expect(ledger().requirements[1].evidence).toEqual([{ kind: 'file', path: 'plan.txt' }]);
    expect(ralph()).toContain(`session_id: ${SID}`);
  });
});

describe('registration', () => {
  it('uses the Ralph Loop plugin for continuation, registers its own hooks, and adds no Stop hook', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
    expect(settings.enabledPlugins['ralph-loop@claude-plugins-official']).toBe(true);
    expect(settings.extraKnownMarketplaces['claude-plugins-official'].source.repo).toBe('anthropics/claude-plugins-official');
    expect(settings.hooks.Stop).toBeUndefined();
    const uses = (event: string) =>
      (settings.hooks[event] ?? []).filter((e: { hooks: { command: string }[] }) => e.hooks.some((h) => /finish-job\.mjs"? hook/.test(h.command)));
    expect(uses('UserPromptSubmit')).toHaveLength(1);
    expect(uses('PreToolUse').map((e: { matcher: string }) => e.matcher)).toEqual(['*']);
    expect(uses('SessionStart').map((e: { matcher: string }) => e.matcher)).toEqual(['startup']);
    expect(fs.readFileSync(path.join(ROOT, '.claude/skills/finish-the-job/SKILL.md'), 'utf8')).toMatch(/^---\nname: finish-the-job\n/);
  });
});
