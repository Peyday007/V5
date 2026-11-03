#!/usr/bin/env node
/**
 * Finish the Job: an assignment ends DONE only when a check this script runs
 * says so — never because the session wrote "DONE".
 *
 * Measured 2026-11-03 (session_01QF5Tk9P9WiYWeXRCMDcviQ): the $10K session
 * read the plan (NOT_VIABLE), merged a PR recording that reading, scheduled a
 * check-in six hours out, and ended its turn. The check-in was a status read;
 * the $10K objective it belonged to had no owner until the owner noticed.
 *
 * Mechanism, reusing what exists instead of a second loop:
 *   - Continuation is the official Ralph Loop plugin's Stop hook
 *     (ralph-loop@claude-plugins-official): while `.claude/ralph-loop.local.md`
 *     names this session, every stop is refused and the prompt in it is fed back,
 *     bounded by its max_iterations. This file writes that state file; it adds no
 *     Stop hook of its own. Ralph's text "promise" is left unset, so nothing the
 *     session writes can end the loop — only `check` removing the file can.
 *   - The ledger (`.claude/finish-job/<session>.json`) holds the owner's
 *     requirements, copied from the owner's own message by the hook — not
 *     paraphrased by the session — and the evidence attached to each.
 *   - `check` runs the evidence itself (commands, git, the GitHub API) and adds
 *     the repository's own requirements: committed, pushed, merged into the
 *     canonical branch, the CI gate green on it, Deploy succeeded when deployable
 *     code changed. A requirement is done only when its evidence passes now.
 *   - WAITING releases the stop only when every open item waits on an armed,
 *     named wake; the next tool call after the wake re-arms the loop. Unchanged
 *     re-checks stall out after STALL_LIMIT, and a re-armed wait must back off.
 *   - The owner's restored words (restore-objective.mjs) carry this ledger's
 *     state after compaction or resume; the ledger is also printed into the
 *     transcript on every check, so a fresh container can rebuild it.
 *
 * Usage: `npm run finish -- <status|check|evidence|wait|block|clear|add|init|dismiss> …`
 * Hook:  `node finish-job.mjs hook` (UserPromptSubmit, PreToolUse, SessionStart).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { humanMessages } from './restore-objective.mjs';

export const RALPH_FILE = '.claude/ralph-loop.local.md';
export const LEDGER_DIR = '.claude/finish-job';
export const MAX_ITERATIONS = 20;
export const STALL_LIMIT = 3;
export const RULE11 = [
  'SPEND_OVER_CEILING', 'IRREVERSIBLE_PRODUCTION_LOSS', 'LEGAL_RISK', 'SECRET_EXPOSED', 'MAJOR_NEWS', 'MISSING_AUTHORITY',
];
/** Paths whose change production does not run, so a merge of only these needs no Deploy. */
export const NON_DEPLOY = /^(docs\/|tests\/|\.claude\/|\.github\/|objectives\/)|\.md$/;
/** Evidence that proves nothing: it passes whatever the world looks like. */
const TRIVIAL = /^\s*(true|:|exit\s+0|echo\b|printf\b|sleep\b)|\|\|\s*(true|:)\s*$|;\s*(true|exit\s+0)\s*$/;
const WAKE = /^(task|monitor|pr|trigger|send_later|workflow|run|wakeup)[:\s]+\S+/i;
/** Tools that arm a wake: calling one must not re-arm the stop the wait just released. */
const WAKE_TOOLS = /send_later|create_trigger|subscribe_pr_activity|^Monitor$|^ScheduleWakeup$|^TaskOutput$/;
const FINISH_CLI = /finish-job\.mjs|npm run (-s )?finish\b/;

const root = () => process.env.FINISH_JOB_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const short = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');

// ---------------------------------------------------------------- requirements

const ITEM = /^\s{0,6}(?:\d+[.)]|[-*•])\s+\S/;

/** Each list item of the owner's message, with the paragraph lines under it. */
export function requirementsFrom(text) {
  const items = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (ITEM.test(line)) items.push((cur = { text: line.trim() }));
    else if (cur && line.trim()) cur.text += `\n${line.trim()}`;
  }
  return items.map((i) => i.text);
}

/** A message that asks for work, as opposed to a question or a "continue". */
export function isAssignment(text) {
  const t = text.trim();
  if (/\?\s*$/.test(t)) return false;
  if (requirementsFrom(t).length >= 2) return true;
  return t.length >= 300 && /\b(implement|build|fix|deploy|merge|ship|install|create|add|make|finish|complete|prove|run|write|update|remove|migrate|open|start|produce|research|find|launch|verify|test|reduce|increase|improve)\b/i.test(t);
}

function makeReqs(text, start, source) {
  const items = requirementsFrom(text);
  return (items.length ? items : [text.trim()]).map((t, i) => ({
    id: `R${start + i}`, text: t, source, evidence: [], wait: null, block: null,
  }));
}

// ---------------------------------------------------------------- ledger + Ralph state

const ledgerPath = (sid) => path.join(root(), LEDGER_DIR, `${sid}.json`);
export function loadLedger(sid) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(sid), 'utf8'));
  } catch {
    return null;
  }
}
function saveLedger(l) {
  fs.mkdirSync(path.dirname(ledgerPath(l.sessionId)), { recursive: true });
  fs.writeFileSync(ledgerPath(l.sessionId), `${JSON.stringify(l, null, 2)}\n`);
}
const isOpen = (l) => l && !['DONE', 'CANCELLED', 'DISMISSED'].includes(l.status);

export function newLedger(sid, messages) {
  const [first, ...later] = messages;
  const reqs = makeReqs(first.text, 1, `owner ${first.at}`);
  for (const m of later) if (requirementsFrom(m.text).length >= 2) reqs.push(...makeReqs(m.text, reqs.length + 1, `owner ${m.at}`));
  const g = gitInfo(false);
  return {
    version: 1, sessionId: sid, createdAt: new Date().toISOString(), status: 'ACTIVE',
    base: g.ok ? g.canonicalHead : null, requirements: reqs, autoMarks: {},
    checks: 0, lastFp: null, same: 0, lastParkFp: null, unchangedParks: 0, cache: {},
  };
}

const ralphPath = () => path.join(root(), RALPH_FILE);
export function ralphState() {
  try {
    return fs.readFileSync(ralphPath(), 'utf8');
  } catch {
    return null;
  }
}

/** Write Ralph's state file: its Stop hook now refuses this session's stops. */
export function arm(l, body) {
  const prev = ralphState();
  const iteration = Number(prev?.match(/^iteration: (\d+)$/m)?.[1] ?? 1);
  fs.mkdirSync(path.dirname(ralphPath()), { recursive: true });
  fs.writeFileSync(
    ralphPath(),
    [
      '---', 'active: true', `iteration: ${iteration}`, `session_id: ${l.sessionId}`,
      `max_iterations: ${MAX_ITERATIONS}`, 'completion_promise: null', `started_at: "${new Date().toISOString()}"`, '---', '',
      body ?? continuePrompt(l, null),
    ].join('\n'),
  );
}
export function disarm(l) {
  const prev = ralphState();
  if (prev && prev.includes(`session_id: ${l.sessionId}`)) fs.unlinkSync(ralphPath());
}

function continuePrompt(l, verdict) {
  const open = verdict?.open ?? l.requirements.map((r) => ({ id: r.id, text: r.text }));
  const lines = [
    `FINISH THE JOB — this assignment is not verified complete${verdict ? ` (check #${l.checks}: CONTINUE)` : ''}.`,
    'Your written status is not read. The stop is released only by `npm run finish -- check` returning',
    'DONE, WAITING (every open item waits on an armed wake), BLOCKED (a rule-11 reason) or STALLED.',
    '', 'Actionable now:', ...open.map((o) => `- ${o.id}: ${short(o.text, 160)}${o.detail ? ` — ${short(o.detail, 160)}` : ''}`),
  ];
  if (verdict?.waiting?.length) {
    lines.push('', 'Waiting (fine — keep doing the actionable items meanwhile):', ...verdict.waiting.map((w) => `- ${w.id}: ${short(w.detail, 160)}`));
  }
  lines.push(
    '', 'Do the work, then attach proof the checker can run itself:',
    '  npm run finish -- evidence <id> --cmd "<test or probe>" | --pr <n> | --workflow deploy.yml --pr <n> | --http <url> --expect <text> | --covered R2,R3',
    '  npm run finish -- wait <id> --on "<what>" --wake "monitor:<id>|task:<id>|pr:<n>|run:<id>|trigger:<id>"',
    '  npm run finish -- block <id> --code <RULE-11 CODE> --detail "<why only the owner can>"',
    'Skill: .claude/skills/finish-the-job/SKILL.md',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------- the world

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root(), encoding: 'utf8', timeout: opts.timeout ?? 60_000, maxBuffer: 32 << 20, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${opts.both ? r.stderr ?? '' : ''}`.trim(), status: r.status };
}
const git = (...a) => run('git', a);

function repoSlug() {
  if (process.env.FINISH_JOB_REPO) return process.env.FINISH_JOB_REPO;
  const m = git('remote', 'get-url', 'origin').out.match(/([^/:]+)\/([^/]+?)(\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
function gh(apiPath) {
  const r = run('gh', ['api', apiPath], { timeout: 30_000 });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

function gitInfo(fetch = true) {
  if (!git('rev-parse', '--git-dir').ok) return { ok: false };
  let canonical = 'main';
  try {
    canonical = fs.readFileSync(path.join(root(), '.github/CANONICAL_BRANCH'), 'utf8').trim() || 'main';
  } catch { /* default */ }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
  if (fetch) {
    git('fetch', '-q', 'origin', canonical);
    if (branch !== canonical && branch !== 'HEAD') git('fetch', '-q', 'origin', branch);
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no').out;
  return {
    ok: true, canonical, branch, head: git('rev-parse', 'HEAD').out, dirty,
    canonicalHead: git('rev-parse', `origin/${canonical}`).out || null, slug: repoSlug(),
  };
}
const contains = (ancestor, descendant) => !!ancestor && !!descendant && git('merge-base', '--is-ancestor', ancestor, descendant).ok;

function prFor(g, number) {
  if (!g.slug) return null;
  if (number) return gh(`repos/${g.slug}/pulls/${number}`);
  const owner = g.slug.split('/')[0];
  const list = gh(`repos/${g.slug}/pulls?head=${owner}:${encodeURIComponent(g.branch)}&state=all&per_page=10`);
  return Array.isArray(list) ? list.find((p) => p.head?.sha === g.head) ?? null : null;
}

/** A successful run of `workflow` on the canonical branch at a commit containing `target`. */
function workflowPassed(g, workflow, target) {
  const runs = g.slug && gh(`repos/${g.slug}/actions/workflows/${workflow}/runs?branch=${g.canonical}&per_page=30`);
  if (!runs?.workflow_runs) return { ok: false, detail: `could not read ${workflow} runs from GitHub` };
  const covering = runs.workflow_runs.filter((r) => r.head_sha === target || contains(target, r.head_sha));
  const pass = covering.find((r) => r.conclusion === 'success');
  if (pass) return { ok: true, detail: `${workflow} run ${pass.id} succeeded on ${pass.head_sha.slice(0, 7)}` };
  const live = covering.find((r) => r.status !== 'completed');
  if (live) return { ok: false, pending: `run:${live.id}`, detail: `${workflow} run ${live.id} is ${live.status}` };
  const failed = covering[0];
  return { ok: false, detail: failed ? `${workflow} run ${failed.id} ended ${failed.conclusion}` : `no ${workflow} run covers ${target.slice(0, 7)}` };
}

/** What the repository itself requires of finished work, whatever the session says. */
export function repoChecks(g, since = null) {
  if (!g.ok) return [];
  const items = [{ id: 'GIT-COMMIT', text: 'Every change is committed', ok: !g.dirty, detail: g.dirty ? `uncommitted: ${short(g.dirty, 160)}` : 'clean' }];
  if (g.branch === g.canonical || g.branch === 'HEAD' || !g.canonicalHead) return items;
  // The assignment's own work: since the canonical head it started from, so a merge does not hide it.
  const base = since && contains(since, g.head) ? since : git('merge-base', 'HEAD', `origin/${g.canonical}`).out;
  const files = base ? git('diff', '--name-only', base, 'HEAD').out.split('\n').filter(Boolean) : [];
  if (files.length === 0) return items;
  const pushed = contains(g.head, git('rev-parse', `origin/${g.branch}`).out);
  items.push({ id: 'GIT-PUSH', text: `Branch ${g.branch} is pushed`, ok: pushed, detail: pushed ? 'pushed' : 'HEAD is not on the remote branch' });
  const pr = prFor(g);
  const sameContent = git('diff', '--quiet', `origin/${g.canonical}`, 'HEAD', '--', ...files).ok;
  const merged = (pr?.merged_at && pr.base?.ref === g.canonical) || sameContent;
  const target = pr?.merge_commit_sha && contains(pr.merge_commit_sha, g.canonicalHead) ? pr.merge_commit_sha : g.canonicalHead;
  items.push({
    id: 'MERGE', text: `The work on ${g.branch} is merged into ${g.canonical} (owner's standing order: merge it yourself)`, ok: !!merged,
    detail: merged ? `merged${pr ? ` as PR #${pr.number}` : ''}` : `${files.length} changed file(s) not in origin/${g.canonical}${pr ? `; PR #${pr.number} is ${pr.state}` : '; no PR'}`,
  });
  if (!merged) return items;
  const wf = (f) => fs.existsSync(path.join(root(), '.github/workflows', f));
  if (wf('postgres-suite.yml')) items.push({ id: 'CI', text: `The full gate passed on the merged ${g.canonical} commit`, ...workflowPassed(g, 'postgres-suite.yml', target) });
  if (wf('deploy.yml') && files.some((f) => !NON_DEPLOY.test(f))) {
    items.push({ id: 'DEPLOY', text: `Deploy released and verified the merged commit (deployable files changed)`, ...workflowPassed(g, 'deploy.yml', target) });
  }
  return items;
}

/** Runs one piece of evidence. Results are cached on the tree they ran against, pass or fail. */
function verify(ev, l, g, done) {
  switch (ev.kind) {
    case 'cmd': {
      const key = sha(`${ev.run}\0${g.head ?? ''}\0${sha(g.dirty ?? '')}`);
      if (l.cache[key]) return { ...l.cache[key], detail: `${l.cache[key].detail} (cached for this tree)` };
      const r = run('bash', ['-c', ev.run], { timeout: (ev.timeoutSec ?? 1200) * 1000, both: true });
      const res = { ok: r.ok, detail: `\`${short(ev.run, 80)}\` exit ${r.status ?? 'timeout'}: ${short(r.out.slice(-200), 200)}` };
      l.cache[key] = res;
      return res;
    }
    case 'pr': {
      const pr = prFor(g, ev.pr);
      const ok = !!pr?.merged_at && pr.base?.ref === g.canonical && contains(pr.merge_commit_sha, g.canonicalHead);
      return { ok, detail: pr ? `PR #${ev.pr} ${pr.merged_at ? `merged into ${pr.base?.ref}` : pr.state}` : `PR #${ev.pr} unreadable` };
    }
    case 'workflow': {
      const target = ev.sha ?? prFor(g, ev.pr)?.merge_commit_sha;
      return target ? workflowPassed(g, ev.workflow, target) : { ok: false, detail: `no commit for ${ev.workflow} (PR not merged?)` };
    }
    case 'http': {
      const r = run('curl', ['-fsS', '-m', '30', ev.url], { timeout: 40_000 });
      return { ok: r.ok && r.out.includes(ev.expect), detail: `${ev.url} ${r.ok ? (r.out.includes(ev.expect) ? 'contains' : 'lacks') : 'unreachable;'} "${short(ev.expect, 40)}"` };
    }
    case 'file': {
      const p = path.join(root(), ev.path);
      const ok = fs.existsSync(p) && (!ev.contains || fs.readFileSync(p, 'utf8').includes(ev.contains));
      return { ok, detail: `${ev.path} ${ok ? 'present' : 'missing or lacks text'}` };
    }
    case 'covered': {
      const missing = ev.ids.filter((id) => !done.has(id));
      return { ok: missing.length === 0, detail: missing.length ? `waits on ${missing.join(', ')}` : `covered by ${ev.ids.join(', ')}` };
    }
    default:
      return { ok: false, detail: `unknown evidence ${ev.kind}` };
  }
}

/** A wait on a run or a PR is checked: one that already ended is no longer a reason to wait. */
function waitLive(w, g) {
  const m = w.wake.match(/^(run|workflow|pr)[:\s]+#?(\d+)/i);
  if (!m || !g.slug) return true;
  if (m[1].toLowerCase() === 'pr') return gh(`repos/${g.slug}/pulls/${m[2]}`)?.state !== 'closed';
  const runInfo = gh(`repos/${g.slug}/actions/runs/${m[2]}`);
  return !runInfo || runInfo.status !== 'completed';
}

// ---------------------------------------------------------------- check

export function check(l, { fetch = true } = {}) {
  const g = gitInfo(fetch);
  l.checks += 1;
  const rows = [];
  const done = new Set();
  const judge = (id, text, results, mark) => {
    const ok = results.length > 0 && results.every((r) => r.ok);
    let status = ok ? 'done' : 'open';
    let detail = results.map((r) => r.detail).join('; ') || 'no evidence attached';
    if (!ok && mark?.block) {
      status = 'blocked';
      detail = `${mark.block.code}: ${mark.block.detail}`;
    } else if (!ok && mark?.wait) {
      if (waitLive(mark.wait, g)) {
        status = 'waiting';
        detail = `on ${mark.wait.on} (wake ${mark.wait.wake})`;
      } else detail = `the wait on ${mark.wait.wake} has ended — act on its result. ${detail}`;
    }
    if (status === 'done') done.add(id);
    rows.push({ id, text, status, detail, results });
  };
  // Covered-by evidence depends on other rows: judge plain ones first.
  const reqs = [...l.requirements].sort((a, b) => Number(a.evidence.some((e) => e.kind === 'covered')) - Number(b.evidence.some((e) => e.kind === 'covered')));
  for (const r of reqs) judge(r.id, r.text, r.evidence.map((e) => verify(e, l, g, done)), r);
  for (const a of repoChecks(g, l.base)) {
    const hint = a.pending ? ` — watch it (Monitor) and \`npm run finish -- wait ${a.id} --on "${a.pending}" --wake ${a.pending}\`` : '';
    judge(a.id, a.text, [{ ok: a.ok, detail: `${a.detail}${hint}` }], l.autoMarks[a.id]);
  }
  const by = (s) => rows.filter((r) => r.status === s);
  const verdict = { open: by('open'), waiting: by('waiting'), blocked: by('blocked'), done: by('done') };
  let word = verdict.open.length ? 'CONTINUE' : verdict.waiting.length ? 'WAITING' : verdict.blocked.length ? 'BLOCKED' : 'DONE';
  const fp = sha(JSON.stringify([g.head, sha(g.dirty ?? ''), rows.map((r) => [r.id, r.status, r.detail.replace(/ \(cached for this tree\)/g, '')])]));
  if (word === 'CONTINUE') {
    l.same = fp === l.lastFp ? l.same + 1 : 0;
    if (l.same >= STALL_LIMIT - 1) word = 'STALLED';
  } else l.same = 0;
  l.lastFp = fp;
  if (word === 'WAITING') {
    l.unchangedParks = fp === l.lastParkFp ? l.unchangedParks + 1 : 0;
    l.lastParkFp = fp;
  }
  l.status = word === 'CONTINUE' ? 'ACTIVE' : word;
  if (word === 'CONTINUE') arm(l, continuePrompt(l, verdict));
  else disarm(l);
  l.lastCheck = { at: new Date().toISOString(), word, rows: rows.map(({ id, status, detail }) => ({ id, status, detail })) };
  saveLedger(l);
  return { word, verdict, rows };
}

export function report(l, res) {
  const say = {
    CONTINUE: 'Actionable work remains. The stop stays refused: do it.',
    WAITING: `Every open item waits on an armed wake. The stop is released; the objective is NOT done and the next tool call re-arms it.${l.unchangedParks ? ` Unchanged since the last wait (${l.unchangedParks}x): a re-armed check-in must be ≥ ${minDelay(l)} min out.` : ''}`,
    BLOCKED: 'Everything left is blocked by a rule-11 reason. Report NOT DONE with each blocker.',
    STALLED: `The same failing state ${STALL_LIMIT} checks in a row. The stop is released; report NOT DONE with each open item. Do not repeat the same attempt.`,
    DONE: 'Every requirement and repository check passed. Report DONE.',
  }[res.word];
  const lines = [`FINISH-JOB ${res.word} — ${say}`];
  for (const r of res.rows) lines.push(`  [${r.status.toUpperCase().padEnd(7)}] ${r.id}: ${short(r.text, 70)} — ${short(r.detail, 200)}`);
  const { cache, ...portable } = l;
  lines.push(`FINISH-JOB-LEDGER ${Buffer.from(JSON.stringify(portable)).toString('base64')}`);
  return lines.join('\n');
}

export const minDelay = (l) => Math.min(1440, 45 * 2 ** Math.max(0, l.unchangedParks));

// ---------------------------------------------------------------- recovery

/** The last ledger a check printed into the transcript: a fresh container's only copy. */
export function ledgerFromTranscript(jsonl) {
  const m = [...jsonl.matchAll(/FINISH-JOB-LEDGER ([A-Za-z0-9+/=]+)/g)].pop();
  if (!m) return null;
  try {
    return { cache: {}, ...JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) };
  } catch {
    return null;
  }
}

function brief(l) {
  const rows = l.lastCheck?.rows ?? l.requirements.map((r) => ({ id: r.id, status: 'open', detail: 'not yet checked' }));
  const text = Object.fromEntries(l.requirements.map((r) => [r.id, r.text]));
  return [
    `FINISH-THE-JOB LEDGER (${l.status}, ${l.requirements.length} owner requirement(s)) — enforced by \`npm run finish -- check\`; Ralph Loop refuses the stop until it releases it.`,
    ...rows.map((r) => `  [${r.status.toUpperCase()}] ${r.id}${text[r.id] ? `: ${short(text[r.id], 90)}` : ''} — ${short(r.detail, 110)}`),
  ].join('\n').slice(0, 2500);
}

/** For restore-objective.mjs: put the ledger back after compaction or resume, and re-arm it. */
export function sessionContext(event) {
  const sid = event.session_id;
  if (!sid) return '';
  let l = loadLedger(sid);
  if (!l && event.transcript_path) {
    try {
      l = ledgerFromTranscript(fs.readFileSync(event.transcript_path, 'utf8'));
      if (l) l.sessionId = sid;
    } catch { /* no transcript */ }
  }
  if (!isOpen(l)) return '';
  if (l.status !== 'BLOCKED') {
    l.status = 'ACTIVE';
    arm(l);
  }
  saveLedger(l);
  return brief(l);
}

// ---------------------------------------------------------------- hooks

function hookUserPrompt(e) {
  const sid = e.session_id;
  const prompt = String(e.prompt ?? '');
  if (!sid || !prompt.trim()) return '';
  let l = loadLedger(sid);
  if (isOpen(l) && /^\s*(stop|cancel|abort|abandon)\b/i.test(prompt) && prompt.length < 120) {
    l.status = 'CANCELLED';
    disarm(l);
    saveLedger(l);
    return 'FINISH-THE-JOB: the owner cancelled the assignment; the stop is released.';
  }
  if (!isOpen(l)) {
    if (!isAssignment(prompt)) return '';
    if (l) fs.renameSync(ledgerPath(sid), ledgerPath(`${sid}.${l.createdAt.replace(/\W/g, '')}`));
    l = newLedger(sid, [{ at: new Date().toISOString(), text: prompt }]);
    arm(l);
    saveLedger(l);
    return `${brief(l)}\nThese are the owner's words, split by list item. Attach evidence to each; \`npm run finish -- check\` decides DONE.`;
  }
  if (requirementsFrom(prompt).length >= 2) l.requirements.push(...makeReqs(prompt, l.requirements.length + 1, `owner ${new Date().toISOString()}`));
  if (l.status !== 'ACTIVE') {
    l.status = 'ACTIVE';
    arm(l);
  }
  saveLedger(l);
  return brief(l);
}

/** Returns a refusal message, or '' to allow. Also re-arms a parked wait on the first act after a wake. */
function hookPreTool(e) {
  const tool = String(e.tool_name ?? '');
  const input = e.tool_input ?? {};
  const target = String(input.file_path ?? input.notebook_path ?? '');
  const isLedgerPath = (s) => s.includes('ralph-loop.local.md') || s.includes('.claude/finish-job');
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && isLedgerPath(target)) {
    return 'FINISH-THE-JOB: the ledger and the Ralph state are written only by `npm run finish`. Attach evidence instead.';
  }
  const command = String(input.command ?? '');
  if (tool === 'Bash' && isLedgerPath(command) && !FINISH_CLI.test(command)) {
    return 'FINISH-THE-JOB: the ledger and the Ralph state are written only by `npm run finish` (`npm run finish -- status` to read it).';
  }
  const sid = e.session_id;
  const l = sid && loadLedger(sid);
  if (!isOpen(l)) return '';
  if (/send_later/.test(tool) && l.unchangedParks > 0) {
    const minutes = input.delay_minutes ? Number(input.delay_minutes) : input.at ? (Date.parse(String(input.at).replace(/\[.*\]$/, '')) - Date.now()) / 60_000 : 0;
    if (minutes < minDelay(l)) {
      return `FINISH-THE-JOB: nothing changed since the last wait (${l.unchangedParks}x). A further check-in must be at least ${minDelay(l)} minutes out — or watch the real event (a run, a PR) instead of polling.`;
    }
  }
  if ((l.status === 'WAITING' || l.status === 'STALLED') && !WAKE_TOOLS.test(tool) && !(tool === 'Bash' && FINISH_CLI.test(command))) {
    l.status = 'ACTIVE';
    arm(l);
    saveLedger(l);
  }
  return '';
}

function ensureRalphInstalled() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'), 'utf8'));
    if (reg.plugins?.['ralph-loop@claude-plugins-official']) return;
  } catch { /* not installed */ }
  const child = spawnSync('sh', ['-c', 'claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1; claude plugin install ralph-loop@claude-plugins-official --scope project >/dev/null 2>&1'], { cwd: root(), timeout: 50_000 });
  return child.status;
}

export function hook(e) {
  const name = e.hook_event_name;
  if (name === 'UserPromptSubmit') {
    const ctx = hookUserPrompt(e);
    return { out: ctx ? JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: ctx } }) : '' };
  }
  if (name === 'PreToolUse') {
    const refusal = hookPreTool(e);
    return refusal ? { err: refusal, code: 2 } : {};
  }
  if (name === 'SessionStart' && e.source === 'startup') ensureRalphInstalled();
  return {};
}

// ---------------------------------------------------------------- CLI

function args(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

function currentSid(flags) {
  if (flags.session) return flags.session;
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  const dir = path.join(root(), LEDGER_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[^.]+\.json$/.test(f)) : [];
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return files[0]?.replace(/\.json$/, '') ?? null;
}

function transcriptFor(sid) {
  const slug = root().replace(/[^A-Za-z0-9]/g, '-');
  const p = path.join(os.homedir(), '.claude/projects', slug, `${sid}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

export function cli(argv) {
  const { pos, flags } = args(argv);
  const [cmd, id] = pos;
  const sid = currentSid(flags);
  if (!sid) return { code: 1, out: 'FINISH-JOB: no session id (set CLAUDE_CODE_SESSION_ID or pass --session).' };
  let l = loadLedger(sid);
  const fail = (m) => ({ code: 1, out: `FINISH-JOB: ${m}` });

  if (cmd === 'init') {
    if (isOpen(l) && !flags.force) return { code: 0, out: brief(l) };
    let messages;
    if (flags.text || flags.file) messages = [{ at: new Date().toISOString(), text: flags.text ?? fs.readFileSync(flags.file, 'utf8') }];
    else {
      const t = flags.transcript ?? transcriptFor(sid);
      messages = t ? humanMessages(fs.readFileSync(t, 'utf8')) : [];
    }
    if (!messages.length) return fail('no owner message to build requirements from (pass --text or --file).');
    l = newLedger(sid, messages);
    arm(l);
    saveLedger(l);
    return { code: 0, out: brief(l) };
  }
  if (!l) return fail('no ledger for this session. `npm run finish -- init` builds one from the owner\'s messages.');
  if (cmd === 'status' || !cmd) return { code: 0, out: brief(l) };
  if (cmd === 'check') {
    const res = check(l);
    return { code: res.word === 'DONE' ? 0 : 1, out: report(l, res) };
  }
  if (cmd === 'add') {
    const text = pos.slice(1).join(' ') || flags.text;
    if (!text) return fail('add needs the requirement text.');
    l.requirements.push({ id: `R${l.requirements.length + 1}`, text, source: 'session', evidence: [], wait: null, block: null });
    l.status = 'ACTIVE';
    arm(l);
    saveLedger(l);
    return { code: 0, out: brief(l) };
  }
  if (cmd === 'dismiss') {
    const young = Date.now() - Date.parse(l.createdAt) < 15 * 60_000;
    const untouched = l.requirements.every((r) => !r.evidence.length && !r.wait && !r.block);
    const g = gitInfo(false);
    const noCommits = !g.ok || !l.base || git('rev-list', '--count', `${l.base}..HEAD`).out === '0';
    if (!(young && untouched && noCommits) || typeof flags.reason !== 'string') {
      return fail('dismiss is only for a message that was not an assignment: within 15 minutes, before any evidence or commit, with --reason.');
    }
    l.status = 'DISMISSED';
    l.dismissed = flags.reason;
    disarm(l);
    saveLedger(l);
    return { code: 0, out: `FINISH-JOB DISMISSED: ${flags.reason}` };
  }

  const auto = ['GIT-COMMIT', 'GIT-PUSH', 'MERGE', 'CI', 'DEPLOY'].includes(id);
  const req = l.requirements.find((r) => r.id === id);
  if (!req && !auto) return fail(`no requirement ${id}. Ids: ${l.requirements.map((r) => r.id).join(', ')}, GIT-COMMIT, GIT-PUSH, MERGE, CI, DEPLOY.`);
  const mark = req ?? (l.autoMarks[id] ??= {});

  if (cmd === 'evidence') {
    if (!req) return fail(`${id} is checked from the repository itself; it takes no evidence.`);
    let ev;
    if (typeof flags.cmd === 'string') {
      if (TRIVIAL.test(flags.cmd) || !/[a-z]/i.test(flags.cmd)) return fail('that command passes whatever the world looks like; give one that can fail.');
      ev = { kind: 'cmd', run: flags.cmd, ...(flags.timeout ? { timeoutSec: Number(flags.timeout) } : {}) };
    } else if (typeof flags.workflow === 'string') ev = { kind: 'workflow', workflow: flags.workflow, pr: flags.pr ? Number(flags.pr) : undefined, sha: flags.sha };
    else if (flags.pr) ev = { kind: 'pr', pr: Number(flags.pr) };
    else if (typeof flags.http === 'string' && typeof flags.expect === 'string') ev = { kind: 'http', url: flags.http, expect: flags.expect };
    else if (typeof flags.file === 'string') ev = { kind: 'file', path: flags.file, contains: flags.contains };
    else if (typeof flags.covered === 'string') {
      const ids = flags.covered.split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length || ids.includes(id) || ids.some((x) => !l.requirements.some((r) => r.id === x))) return fail('--covered takes other existing requirement ids.');
      ev = { kind: 'covered', ids };
    } else return fail('evidence needs --cmd, --pr, --workflow, --http with --expect, --file or --covered.');
    req.evidence.push(ev);
  } else if (cmd === 'wait') {
    if (typeof flags.on !== 'string' || typeof flags.wake !== 'string' || !WAKE.test(flags.wake)) {
      return fail('wait needs --on "<what>" and --wake "<kind>:<id>" (kind: task, monitor, pr, run, workflow, trigger, send_later, wakeup) naming a wake you already armed.');
    }
    mark.wait = { on: flags.on, wake: flags.wake, at: new Date().toISOString() };
  } else if (cmd === 'block') {
    if (!RULE11.includes(flags.code) || typeof flags.detail !== 'string') return fail(`block needs --code one of ${RULE11.join(', ')} and --detail.`);
    mark.block = { code: flags.code, detail: flags.detail };
  } else if (cmd === 'clear') {
    mark.wait = null;
    mark.block = null;
  } else return fail(`unknown command ${cmd}.`);
  saveLedger(l);
  return { code: 0, out: `FINISH-JOB: ${cmd} recorded on ${id}. Run \`npm run finish -- check\`.` };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'hook') {
    let res = {};
    try {
      res = hook(JSON.parse(fs.readFileSync(0, 'utf8')));
    } catch {
      /* a hook never fails the session */
    }
    if (res.out) process.stdout.write(res.out);
    if (res.err) process.stderr.write(`${res.err}\n`);
    process.exit(res.code ?? 0);
  }
  const res = cli(argv);
  process.stdout.write(`${res.out}\n`);
  process.exit(res.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
