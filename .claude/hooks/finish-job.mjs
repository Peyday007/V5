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
 *   - A deadline the owner names (§112) is registered with an independent
 *     scheduler, tracked on the critical path, escalated early, and delivered at
 *     the deadline whatever is unfinished: `deadline status|set|register|
 *     estimate|defer|escalate|deliver`.
 *
 * Usage: `npm run finish -- <status|check|evidence|withdraw|wait|block|clear|add|init|dismiss|deadline> …`
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
/** Different approaches demanded on a repeated identical failure before STALLED releases the stop. */
export const MAX_STRATEGY_SHIFTS = 1;
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
/** A prompt the harness delivered on someone else's behalf: a task, a subagent, a peer, a webhook. */
export const HARNESS_NOTICE =
  /^\s*(<(task-notification|system-reminder|agent-message|teammate-message|cross-session-message|webhook-payload|wake|event|command-|local-command)|\[SYSTEM NOTIFICATION)/;
const FINISH_CLI = /finish-job\.mjs|npm run (-s )?finish\b/;

const root = () => process.env.FINISH_JOB_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
/** The time. FINISH_JOB_NOW exists for the tests; the scheduled tasks fire on the real clock whatever it says. */
const clock = () => (process.env.FINISH_JOB_NOW ? Date.parse(process.env.FINISH_JOB_NOW) : Date.now());
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const short = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');

// ---------------------------------------------------------------- requirements

const ITEM = /^\s{0,6}(?:\d+[.)]|[-*•])\s+\S/;

/** A short label line ("PRIORITY 1 — AUTHORITY", "SUCCESS:") that names the paragraphs under it. */
const HEADING = (s) => s.length <= 80 && (/:$/.test(s) || (/^[^a-z]+$/.test(s) && /[A-Z]{3}/.test(s)));

/**
 * Each list item of the owner's message, with the lines directly under it, and
 * each prose paragraph after the first item as a requirement of its own,
 * prefixed by the heading it sits under.
 *
 * 2026-11-11: a message listed its existing infrastructure, then gave PRIORITY
 * 1–3 as paragraphs, then a numbered demonstration. Lines were glued to the
 * last item whatever the blank lines said, so all three priorities became the
 * tail of "- GitHub PR, merge, CI, and deployment machinery" — one requirement,
 * shown truncated, satisfiable by evidence about a bullet. A blank line ends an
 * item; an indented line still continues it.
 */
export function requirementsFrom(text) {
  const items = [];
  let cur = null;
  let gap = false;
  let heading = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      gap = true;
      continue;
    }
    if (ITEM.test(line)) {
      items.push((cur = { text: t }));
    } else if (cur && (!gap || /^\s{2,}/.test(line))) {
      cur.text += `\n${t}`;
    } else if (HEADING(t)) {
      heading = t.replace(/:$/, '');
      cur = null;
    } else if (items.length > 0) {
      items.push((cur = { text: heading ? `${heading}: ${t}` : t }));
    }
    gap = false;
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
const isOpen = (l) => l && !['DONE', 'CANCELLED', 'DISMISSED', 'DELIVERED'].includes(l.status);

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
export function arm(l, body, { renew = false } = {}) {
  const prev = ralphState();
  const iteration = renew ? 1 : Number(prev?.match(/^iteration: (\d+)$/m)?.[1] ?? 1);
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

function continuePrompt(l, verdict, shift = false) {
  const open = verdict?.open ?? l.requirements.map((r) => ({ id: r.id, text: r.text }));
  const lines = [
    `FINISH THE JOB — this assignment is not verified complete${verdict ? ` (check #${l.checks}: CONTINUE)` : ''}.`,
    ...(shift ? [`CHANGE STRATEGY: the same failing state ${STALL_LIMIT} checks running. Do not repeat the attempt behind these items; choose a different approach or owner first.`] : []),
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
  // A Deploy superseded by a newer canonical tip ends `success` having released
  // nothing: its "Deploy to Fly" job is skipped. 2026-11-11 08:31–09:10, nine
  // such runs in a row while parallel sessions merged, and this check read each
  // as a release. A release is the job that releases.
  const released = (r) =>
    workflow !== 'deploy.yml' ||
    (gh(`repos/${g.slug}/actions/runs/${r.id}/jobs`)?.jobs ?? []).some((j) => /^Deploy to Fly/.test(j.name) && j.conclusion === 'success');
  const pass = covering.find((r) => r.conclusion === 'success' && released(r));
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
  // Covered-by evidence depends on other rows: judge plain ones first, then the
  // covered ones until nothing changes, so a heading covered by an item that is
  // itself covered is judged after that item (one pass left it open for ever).
  const isCovered = (r) => r.evidence.some((e) => e.kind === 'covered');
  for (const r of l.requirements.filter((x) => !isCovered(x))) judge(r.id, r.text, r.evidence.map((e) => verify(e, l, g, done)), r);
  const covered = l.requirements.filter(isCovered);
  for (let pass = 0; pass <= covered.length; pass += 1) {
    const before = done.size;
    for (const r of covered) {
      if (done.has(r.id)) continue;
      const results = r.evidence.map((e) => verify(e, l, g, done));
      if (results.every((x) => x.ok)) judge(r.id, r.text, results, r);
    }
    if (done.size === before) break;
  }
  for (const r of covered.filter((x) => !done.has(x.id))) judge(r.id, r.text, r.evidence.map((e) => verify(e, l, g, done)), r);
  for (const a of repoChecks(g, l.base)) {
    const hint = a.pending ? ` — watch it (Monitor) and \`npm run finish -- wait ${a.id} --on "${a.pending}" --wake ${a.pending}\`` : '';
    judge(a.id, a.text, [{ ok: a.ok, detail: `${a.detail}${hint}` }], l.autoMarks[a.id]);
  }
  const dl = deadlineState(l, clock(), done);
  if (dl && dl.phase !== 'DELIVERED') {
    trackRisk(l, dl);
    const gate = deadlineState(l, clock(), done)?.gate;
    const registered = !['UNSET', 'UNREGISTERED'].includes(dl.phase);
    rows.push({ id: 'DEADLINE', text: `Deadline ${l.deadline.at ?? '(not set)'} is registered with the independent scheduler and on track`, status: registered && !gate ? 'done' : 'open', detail: dl.detail, results: [] });
  }
  const by = (s) => rows.filter((r) => r.status === s);
  const verdict = { open: by('open'), waiting: by('waiting'), blocked: by('blocked'), done: by('done') };
  let word = verdict.open.length ? 'CONTINUE' : verdict.waiting.length ? 'WAITING' : verdict.blocked.length ? 'BLOCKED' : 'DONE';
  // Past the deadline the only next act is the delivery, whatever else is open.
  const due = dl?.phase === 'DUE' && word !== 'DONE';
  if (due) word = 'DELIVER';
  const fp = sha(JSON.stringify([g.head, sha(g.dirty ?? ''), rows.map((r) => [r.id, r.status, r.detail.replace(/ \(cached for this tree\)/g, '')])]));
  // Progress (a requirement newly verified) renews the loop's budget: the
  // iteration limit bounds unproductive stops, never a long objective that keeps
  // moving, and an objective that moved earns its strategy changes back.
  const progressed = l.doneCount !== undefined && done.size > l.doneCount;
  l.doneCount = done.size;
  if (progressed) l.strategyShifts = 0;
  let shift = false;
  if (word === 'CONTINUE' || word === 'DELIVER') {
    l.same = fp === l.lastFp ? l.same + 1 : 0;
    if (l.same >= STALL_LIMIT - 1) {
      // A repeated identical failure is first a demand for a different approach,
      // and only after that has also failed a reason to release the stop.
      if ((l.strategyShifts ?? 0) < MAX_STRATEGY_SHIFTS) {
        l.strategyShifts = (l.strategyShifts ?? 0) + 1;
        l.same = 0;
        shift = true;
      } else word = 'STALLED';
    }
  } else l.same = 0;
  l.lastFp = fp;
  if (word === 'WAITING') {
    l.unchangedParks = fp === l.lastParkFp ? l.unchangedParks + 1 : 0;
    l.lastParkFp = fp;
  }
  if (due) word = 'DELIVER';
  l.status = word === 'CONTINUE' || word === 'DELIVER' ? 'ACTIVE' : word;
  if (word === 'DELIVER') arm(l, deliverPrompt(l));
  else if (word === 'CONTINUE') arm(l, continuePrompt(l, verdict, shift), { renew: progressed });
  else disarm(l);
  l.lastCheck = { at: new Date().toISOString(), word, rows: rows.map(({ id, status, detail }) => ({ id, status, detail })) };
  saveLedger(l);
  return { word, verdict, rows, shift };
}

export function report(l, res) {
  const say = {
    CONTINUE: res.shift
      ? `CHANGE STRATEGY (${l.strategyShifts}/${MAX_STRATEGY_SHIFTS}) — the same failing state ${STALL_LIMIT} checks running. The approach behind the open items below does not work: take a different root-cause hypothesis, a different path, or another owner (the Factory, or the maintainer route for a protected file) before checking again. Independent items do not wait on these.`
      : 'Actionable work remains. The stop stays refused: do it.',
    WAITING: `Every open item waits on an armed wake. The stop is released; the objective is NOT done and the next tool call re-arms it.${l.unchangedParks ? ` Unchanged since the last wait (${l.unchangedParks}x): a re-armed check-in must be ≥ ${minDelay(l)} min out.` : ''}`,
    BLOCKED: 'Everything left is blocked by a rule-11 reason. Report NOT DONE with each blocker.',
    STALLED: `The same failing state ${STALL_LIMIT} checks in a row. The stop is released; report NOT DONE with each open item. Do not repeat the same attempt.`,
    DONE: `Every requirement and repository check passed. Report DONE.${l.deadline?.scheduler ? ` Delete the deadline's scheduled task(s) ${[l.deadline.scheduler.trigger, l.deadline.scheduler.warn].filter(Boolean).join(', ')}.` : ''}`,
    DELIVER: 'The deadline has passed. Deliver now: `npm run finish -- deadline deliver`, and send its report as the final message. No extension, no further engineering.',
  }[res.word];
  const lines = [`FINISH-JOB ${res.word} — ${say}`];
  for (const r of res.rows) lines.push(`  [${r.status.toUpperCase().padEnd(7)}] ${r.id}: ${short(r.text, 70)} — ${short(r.detail, 200)}`);
  const { cache, ...portable } = l;
  lines.push(`FINISH-JOB-LEDGER ${Buffer.from(JSON.stringify(portable)).toString('base64')}`);
  return lines.join('\n');
}

export const minDelay = (l) => Math.min(1440, 45 * 2 ** Math.max(0, l.unchangedParks));

// ---------------------------------------------------------------- deadline

/*
 * A deadline the owner names is a delivery commitment the session cannot move
 * (owner's permanent operating rule, 2026-11-17; §112). The ledger holds it; an
 * independent scheduler — a one-shot Claude Code Remote scheduled task the
 * session must register, firing whatever the session is doing and even after
 * its container is gone — enforces it; and this hook's clock enforces it
 * mid-turn. Past the deadline nothing but delivery runs.
 */

/** Minutes assumed for an open requirement with no estimate on the critical path. */
export const DEFAULT_ESTIMATE_MIN = 30;
/** The prompt the scheduler delivers begins with this, so it is never read as the owner's words. */
export const DEADLINE_FIRE = /^\s*\[DEADLINE SCHEDULER\]/;
const TIME_AFTER =
  '(?:today|tonight|tomorrow|noon|midnight|eod|cob|end\\s+of\\s+(?:the\\s+)?(?:day|week|month)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|' +
  '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b|\\d{1,2}:\\d{2}|\\d{4}-\\d{2}-\\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}|' +
  '(?:in\\s+)?\\d+\\s*(?:min|minute|hour|hr|day)s?\\b)';
/** A deadline word followed by a time: "deadline: 5pm", "by Friday", "due 2026-11-20", "within 3 hours". A rule about deadlines names none. */
const DEADLINE_WORDS = new RegExp(`\\b(?:hard\\s+deadline|deadline|due|no\\s+later\\s+than|by|within|before)\\b[\\s:—–-]*(?:is\\s+|at\\s+|on\\s+|of\\s+)?(?:the\\s+)?${TIME_AFTER}`, 'i');

/** The line of the owner's message that names a deadline, or null. */
export function deadlineIn(text) {
  const m = String(text).match(DEADLINE_WORDS);
  if (!m) return null;
  const start = text.lastIndexOf('\n', m.index) + 1;
  const end = text.indexOf('\n', m.index);
  return short(text.slice(start, end < 0 ? undefined : end).trim(), 240);
}

const AUTO_IDS = ['GIT-COMMIT', 'GIT-PUSH', 'MERGE', 'CI', 'DEPLOY'];

/**
 * Where the deadline stands now. `done` is the set of verified ids (the last
 * check's, unless a fresher one is given). `gate` names what must happen before
 * any other work may: register the deadline, escalate a risk, or deliver.
 */
export function deadlineState(l, now = clock(), done = null) {
  const d = l?.deadline;
  if (!d) return null;
  if (d.delivered) return { phase: 'DELIVERED', detail: `delivered ${d.delivered.at}${d.delivered.met ? '' : ' (AFTER the deadline)'}` };
  if (!d.at) {
    return { phase: 'UNSET', gate: 'register', detail: `the owner named a deadline ("${short(d.ownerText ?? '', 100)}") and it is not set: \`npm run finish -- deadline set --at <ISO> --deliverable "<…>" --accept R1,R2\`` };
  }
  const at = Date.parse(d.at);
  const remaining = Math.floor((at - now) / 60_000);
  if (remaining <= 0) return { phase: 'DUE', gate: 'deliver', remaining, detail: `the deadline ${d.at} has passed: deliver now — \`npm run finish -- deadline deliver\`` };
  if (!d.scheduler) {
    return { phase: 'UNREGISTERED', gate: 'register', remaining, detail: `the deadline ${d.at} has no independent scheduler: create the scheduled task(s) \`npm run finish -- deadline status\` prints, then \`npm run finish -- deadline register …\`` };
  }
  const verified = done ?? new Set((l.lastCheck?.rows ?? []).filter((r) => r.status === 'done').map((r) => r.id));
  const ids = [...new Set([...l.requirements.map((r) => r.id), ...(l.lastCheck?.rows ?? []).map((r) => r.id).filter((id) => AUTO_IDS.includes(id))])];
  const path_ = ids.filter((id) => !verified.has(id) && !d.deferred?.[id]);
  const needed = path_.reduce((s, id) => s + (d.estimates?.[id] ?? DEFAULT_ESTIMATE_MIN), 0);
  const failingAccept = (d.accept ?? []).filter((id) => !verified.has(id));
  const risk = needed > remaining ? `critical path ${path_.join(', ')} needs ~${needed} min; ${remaining} min remain` : null;
  const escalated = !!risk && !!d.riskSince && (d.escalations ?? []).some((e) => Date.parse(e.at) >= Date.parse(d.riskSince));
  return {
    phase: risk ? 'AT_RISK' : 'ON_TRACK', remaining, needed, path: path_, failingAccept, risk, escalated,
    gate: risk && d.riskSince && !escalated ? 'escalate' : null,
    detail: risk
      ? `AT RISK — ${risk}.${escalated ? ' Escalated to the owner.' : ' Tell the owner now: `npm run finish -- deadline escalate --note "<what will and will not be done by the deadline>"` and a PushNotification.'}`
      : `${remaining} min to ${d.at}; critical path ~${needed} min (${path_.join(', ') || 'nothing open'})`,
  };
}

/** Keeps the risk episode current: a risk first seen now needs an escalation made after now. */
function trackRisk(l, s, now = clock()) {
  const d = l.deadline;
  if (!d || !s) return false;
  if (s.risk && !d.riskSince) {
    d.riskSince = new Date(now).toISOString();
    return true;
  }
  if (!s.risk && d.riskSince && s.phase === 'ON_TRACK') {
    d.riskSince = null;
    return true;
  }
  return false;
}

/** The exact scheduled tasks to create: the deadline itself and an early warning. */
export function schedulerPlan(l, now = clock()) {
  const d = l.deadline;
  const at = Date.parse(d.at);
  const window = at - now;
  const what = short(d.deliverable ?? 'the assignment', 160);
  const deadline = {
    name: `Deadline: ${short(what, 60)}`, run_once_at: new Date(at).toISOString(),
    prompt: `[DEADLINE SCHEDULER] DEADLINE ${d.at} reached for: ${what}. Whatever you are doing, stop it: run \`npm run finish -- deadline deliver\` now and send the owner its report (completed work, unfinished work, failed acceptance criteria). No extension and no further engineering first. If the ledger is already DONE or DELIVERED, reply in one line.`,
  };
  if (window <= 30 * 60_000) return { deadline, warn: null };
  const warnAt = at - Math.max(10 * 60_000, Math.round(window * 0.25));
  return {
    deadline,
    warn: {
      name: `Deadline warning: ${short(what, 52)}`, run_once_at: new Date(warnAt).toISOString(),
      prompt: `[DEADLINE SCHEDULER] WARNING: the deadline ${d.at} for "${what}" is ${Math.round((at - warnAt) / 60_000)} min away. Run \`npm run finish -- check\` and \`npm run finish -- deadline status\`. If completion by the deadline is unlikely, escalate now (\`npm run finish -- deadline escalate --note …\` and tell the owner), defer nonessential work, and keep the acceptance criteria first.`,
    },
  };
}

/** Tools a deadline gate still allows: reading, notifying the owner, the scheduler, and the ledger's own CLI. */
const GATE_TOOLS = /^(Read|Grep|Glob|ToolSearch|Skill|PushNotification|SendUserFile|TaskList|TaskGet)$|send_message|create_trigger|list_triggers|get_trigger|send_later/;

/** Refuses moving or cancelling the registered deadline's own scheduled tasks: no autonomous extension. */
function schedulerTamper(l, tool, input) {
  const s = l.deadline?.scheduler;
  if (!s || l.deadline.delivered || !/update_trigger|delete_trigger/.test(tool)) return '';
  if (![s.trigger, s.warn].includes(String(input.trigger_id ?? ''))) return '';
  if (/delete_trigger/.test(tool) || input.run_once_at || input.cron_expression || input.enabled === false || input.prompt) {
    return `FINISH-THE-JOB DEADLINE: ${input.trigger_id} is the registered deadline's independent scheduler. It is not moved, disabled, rewritten or deleted before delivery — the deadline is not extended by the session (owner's rule 7). Only the owner can change it.`;
  }
  return '';
}

function deadlineGate(l, tool, input, command) {
  const tamper = schedulerTamper(l, tool, input);
  if (tamper) return tamper;
  const s = deadlineState(l);
  if (trackRisk(l, s)) saveLedger(l);
  const gate = deadlineState(l)?.gate;
  if (!gate) return '';
  if (gate === 'deliver') {
    const prev = ralphState();
    if (!prev || !prev.includes('DEADLINE REACHED')) arm(l, deliverPrompt(l));
  }
  if (GATE_TOOLS.test(tool) || (tool === 'Bash' && FINISH_CLI.test(command))) return '';
  const why = {
    register: 'register the deadline with the independent scheduler before any other work',
    escalate: 'completion by the deadline has become unlikely; report that to the owner before any other work',
    deliver: 'the deadline has passed; deliver what exists now. Continued engineering is not a substitute for the deliverable',
  }[gate];
  return `FINISH-THE-JOB DEADLINE: ${why}. ${deadlineState(l).detail}`;
}

function deliverPrompt(l) {
  return [
    `FINISH THE JOB — DEADLINE REACHED (${l.deadline.at}). Deliver now, even though the work may be incomplete.`,
    'Run `npm run finish -- deadline deliver`, then send the owner its report as your final message, verbatim:',
    'completed work, unfinished work and failed acceptance criteria, each listed. Do not extend the deadline and',
    'do not continue engineering instead of delivering.',
  ].join('\n');
}

/** The delivery: what is verified, what is not, and which acceptance criteria failed, at the moment of delivery. */
export function deliveryReport(l, res, now = clock()) {
  const d = l.deadline;
  const text = Object.fromEntries(l.requirements.map((r) => [r.id, r.text]));
  const line = (r) => `- ${r.id}${text[r.id] ? `: ${short(text[r.id], 160)}` : `: ${short(r.text, 160)}`} — ${short(r.detail, 220)}`;
  const accept = new Set(d.accept ?? []);
  const rows = res.rows.filter((r) => r.id !== 'DEADLINE');
  const completed = rows.filter((r) => r.status === 'done');
  const unfinished = rows.filter((r) => r.status !== 'done');
  const failed = unfinished.filter((r) => accept.has(r.id));
  const met = now <= Date.parse(d.at);
  const pass = failed.length === 0 && unfinished.length === 0;
  return [
    `# Deadline delivery — ${pass ? 'ACCEPTED' : failed.length ? 'ACCEPTANCE FAILED' : 'INCOMPLETE'}`,
    '',
    `- Deadline: ${d.at} (${met ? 'delivered on time' : 'delivered AFTER the deadline'}, at ${new Date(now).toISOString()})`,
    `- Deliverable: ${d.deliverable}`,
    `- Acceptance criteria: ${[...accept].join(', ') || 'none named'}`,
    ...(d.escalations?.length ? [`- Escalated: ${d.escalations.map((e) => `${e.at} — ${short(e.note, 120)}`).join('; ')}`] : []),
    '',
    `## Completed work (verified) — ${completed.length}`,
    ...(completed.length ? completed.map(line) : ['- none']),
    '',
    `## Unfinished work — ${unfinished.length}`,
    ...(unfinished.length ? unfinished.map((r) => `${line(r)}${d.deferred?.[r.id] ? ` [deferred as nonessential: ${short(d.deferred[r.id], 100)}]` : ''}`) : ['- none']),
    '',
    `## Failed acceptance criteria — ${failed.length}`,
    ...(failed.length ? failed.map(line) : ['- none']),
    '',
  ].join('\n');
}

function deadlineCli(l, sub, id, flags, now = clock()) {
  const fail = (m) => ({ code: 1, out: `FINISH-JOB DEADLINE: ${m}` });
  const d = l.deadline;
  const exists = (x) => l.requirements.some((r) => r.id === x) || AUTO_IDS.includes(x);
  const ok = (m) => {
    saveLedger(l);
    return { code: 0, out: `FINISH-JOB DEADLINE: ${m}` };
  };
  if (sub === 'status' || !sub) {
    if (!d) return { code: 0, out: 'FINISH-JOB DEADLINE: this assignment has no deadline.' };
    const s = deadlineState(l, now);
    const lines = [`FINISH-JOB DEADLINE ${s.phase} — ${s.detail}`];
    if (d.at) lines.push(`  deliverable: ${d.deliverable}`, `  acceptance criteria: ${(d.accept ?? []).join(', ')}`);
    if (d.scheduler) lines.push(`  scheduler: ${d.scheduler.trigger} at ${d.scheduler.at}${d.scheduler.warn ? `; warning ${d.scheduler.warn} at ${d.scheduler.warnAt}` : ''}`);
    else if (d.at) {
      const p = schedulerPlan(l, now);
      lines.push('  Register it: call create_trigger (claude-code-remote) with exactly these, then `npm run finish -- deadline register --trigger <trig_…> --at <run_once_at>' + (p.warn ? ' --warn <trig_…> --warn-at <run_once_at>`' : '`'));
      for (const [k, t] of Object.entries(p)) if (t) lines.push(`  ${k}: ${JSON.stringify({ ...t, initiation: 'human_request' })}`);
    }
    return { code: 0, out: lines.join('\n') };
  }
  if (sub === 'set') {
    const at = Date.parse(String(flags.at ?? ''));
    if (!Number.isFinite(at)) return fail('set needs --at <ISO-8601 time with a zone, e.g. 2026-11-17T22:00:00Z>.');
    if (at <= now) return fail(`${new Date(at).toISOString()} is not in the future.`);
    const accept = typeof flags.accept === 'string' ? flags.accept.split(',').map((s) => s.trim()).filter(Boolean) : d?.accept;
    const deliverable = typeof flags.deliverable === 'string' ? flags.deliverable : d?.deliverable;
    if (!deliverable || !accept?.length) return fail('set needs --deliverable "<the final deliverable>" and --accept <requirement ids that are its acceptance criteria>.');
    const unknown = accept.filter((x) => !exists(x));
    if (unknown.length) return fail(`no requirement ${unknown.join(', ')} (add one with \`npm run finish -- add "<criterion>"\`).`);
    const next = l.deadline ?? (l.deadline = { ownerText: null });
    if (next.at && at > Date.parse(next.at)) {
      // Rule 7: only the owner moves a deadline later, in a message after it was set.
      const rev = next.ownerRevision;
      if (!rev || Date.parse(rev.at) <= Date.parse(next.setAt)) {
        return fail(`refused: ${new Date(at).toISOString()} is later than the deadline ${next.at}. The session never extends a deadline; only a new owner message naming one can.`);
      }
      next.ownerRevision = { ...rev, usedAt: new Date(now).toISOString() };
    }
    if (next.at && next.delivered) return fail('this deadline was already delivered.');
    (next.history ??= []).push({ at: new Date(now).toISOString(), from: next.at ?? null, to: new Date(at).toISOString() });
    const moved = next.at && Date.parse(next.at) !== at;
    Object.assign(next, { at: new Date(at).toISOString(), setAt: new Date(now).toISOString(), deliverable, accept, estimates: next.estimates ?? {}, deferred: next.deferred ?? {}, escalations: next.escalations ?? [] });
    if (moved || !next.scheduler) next.scheduler = null;
    saveLedger(l);
    return { code: 0, out: `FINISH-JOB DEADLINE: set to ${next.at}.\n${deadlineCli(l, 'status', null, {}, now).out}` };
  }
  if (!d?.at) return fail('no deadline is set (`npm run finish -- deadline set …`).');
  if (sub === 'register') {
    const p = schedulerPlan(l, now);
    const near = (a, b) => Math.abs(Date.parse(String(a)) - Date.parse(b)) <= 60_000;
    if (!/^trig_\w+$/.test(String(flags.trigger ?? ''))) return fail('register needs --trigger <the trig_… id create_trigger returned>.');
    if (!near(flags.at, d.at)) return fail(`--at must be the trigger's run_once_at, and it must be the deadline ${d.at}.`);
    if (p.warn) {
      if (!/^trig_\w+$/.test(String(flags.warn ?? ''))) return fail(`a deadline more than 30 minutes out needs an early-warning task too: --warn <trig_…> --warn-at ${p.warn.run_once_at}.`);
      const w = Date.parse(String(flags['warn-at']));
      if (!(w > now && w <= Date.parse(p.warn.run_once_at) + 60_000)) return fail(`--warn-at must be between now and ${p.warn.run_once_at}.`);
    }
    d.scheduler = { trigger: flags.trigger, at: d.at, warn: p.warn ? flags.warn : null, warnAt: p.warn ? new Date(Date.parse(String(flags['warn-at']))).toISOString() : null, registeredAt: new Date(now).toISOString() };
    return ok(`registered — ${d.scheduler.trigger} fires at ${d.at}${d.scheduler.warn ? `, ${d.scheduler.warn} warns at ${d.scheduler.warnAt}` : ''}. Neither may be moved or removed by the session.`);
  }
  if (sub === 'estimate') {
    const min = Number(flags.min);
    if (!exists(id) || !(min > 0)) return fail('estimate needs a requirement id and --min <minutes left on it>.');
    d.estimates[id] = min;
    return ok(`${id} ~${min} min. ${deadlineState(l, now).detail}`);
  }
  if (sub === 'defer') {
    if (!exists(id) || typeof flags.reason !== 'string') return fail('defer needs a requirement id and --reason.');
    if ((d.accept ?? []).includes(id)) return fail(`${id} is an acceptance criterion: it is never deferred to protect the deadline.`);
    d.deferred[id] = flags.reason;
    return ok(`${id} deferred as nonessential; it leaves the critical path and is reported as unfinished. ${deadlineState(l, now).detail}`);
  }
  if (sub === 'escalate') {
    if (typeof flags.note !== 'string' || flags.note.length < 10) return fail('escalate needs --note "<what will and will not be done by the deadline, and why>".');
    d.escalations.push({ at: new Date(now).toISOString(), note: flags.note });
    return ok(`escalation recorded. Send it to the owner now (PushNotification, and in your next message): ${flags.note}`);
  }
  if (sub === 'deliver') {
    const due = now >= Date.parse(d.at);
    const res = check(l);
    if (!due && !['DONE', 'BLOCKED', 'STALLED'].includes(res.word)) {
      return fail(`the deadline is ${d.at} and executable work remains (${res.word}): keep working; delivery is mandatory at the deadline, not before it.\n${report(l, res)}`);
    }
    const body = deliveryReport(l, res, now);
    const file = path.join(LEDGER_DIR, `${l.sessionId}.delivery.md`);
    fs.writeFileSync(path.join(root(), file), body);
    d.delivered = { at: new Date(now).toISOString(), met: now <= Date.parse(d.at), file };
    l.status = res.word === 'DONE' ? 'DONE' : 'DELIVERED';
    disarm(l);
    saveLedger(l);
    return { code: 0, out: `FINISH-JOB DELIVERED — written to ${file}. Send this to the owner as your final message now:\n\n${body}` };
  }
  return fail(`unknown deadline command ${sub}. Use status, set, register, estimate, defer, escalate or deliver.`);
}

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
    ...(l.deadline ? [`  DEADLINE ${deadlineState(l).phase}: ${short(deadlineState(l).detail, 300)}`] : []),
  ].join('\n').slice(0, 2800);
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

/** The scheduler fired. It is not the owner and adds no requirement; it demands the delivery or a fresh risk reading. */
function deadlineFired(e, kind) {
  let l = loadLedger(e.session_id);
  if (!l && e.transcript_path) {
    // A fired task can resume a session whose container was reclaimed: the ledger comes back from the transcript.
    try {
      l = ledgerFromTranscript(fs.readFileSync(e.transcript_path, 'utf8'));
      if (l) l.sessionId = e.session_id;
    } catch { /* no transcript */ }
  }
  if (!isOpen(l) || !l.deadline || l.deadline.delivered) {
    return `FINISH-THE-JOB: the deadline scheduler fired (${kind}) for an assignment that is ${l?.status ?? 'not on record'}. Reply in one line; nothing is due.`;
  }
  (l.deadline.firings ??= []).push({ at: new Date(clock()).toISOString(), kind });
  if (l.status !== 'ACTIVE') l.status = 'ACTIVE';
  const s = deadlineState(l);
  trackRisk(l, s);
  arm(l, s.phase === 'DUE' ? deliverPrompt(l) : undefined);
  saveLedger(l);
  return `${brief(l)}\n${s.phase === 'DUE' ? deliverPrompt(l) : 'DEADLINE WARNING: run `npm run finish -- check`; if completion is unlikely escalate now (`npm run finish -- deadline escalate --note …`, PushNotification), defer nonessential work, acceptance criteria first.'}`;
}

function hookUserPrompt(e) {
  const sid = e.session_id;
  const prompt = String(e.prompt ?? '');
  if (!sid || !prompt.trim()) return '';
  if (DEADLINE_FIRE.test(prompt)) return deadlineFired(e, /WARNING/.test(prompt.slice(0, 40)) ? 'warning' : 'deadline');
  // A harness notice (a finished background task or subagent, a reminder) arrives as a
  // prompt but is not the owner's words: 2026-11-04 a subagent's report became R8-R72,
  // and 2026-11-11 a subagent hand-back (`<agent-message …>`) became R18-R33.
  if (HARNESS_NOTICE.test(prompt)) return isOpen(loadLedger(sid)) ? brief(loadLedger(sid)) : '';
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
    const named = deadlineIn(prompt);
    if (named) l.deadline = { ownerText: named, detectedAt: new Date().toISOString(), at: null };
    arm(l);
    saveLedger(l);
    return `${brief(l)}\nThese are the owner's words, split by list item. Attach evidence to each; \`npm run finish -- check\` decides DONE.`;
  }
  if (requirementsFrom(prompt).length >= 2) l.requirements.push(...makeReqs(prompt, l.requirements.length + 1, `owner ${new Date().toISOString()}`));
  const named = deadlineIn(prompt);
  // Only the owner's own later message can move a deadline (rule 7); it unlocks one `deadline set`.
  if (named && l.deadline?.at) l.deadline.ownerRevision = { text: named, at: new Date(clock()).toISOString() };
  else if (named && !l.deadline) l.deadline = { ownerText: named, detectedAt: new Date().toISOString(), at: null };
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
  if (l.deadline) {
    const refusal = deadlineGate(l, tool, input, command);
    if (refusal) return refusal;
  }
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
  if (cmd === 'deadline') {
    if (!isOpen(l) && pos[1] !== 'status') return fail(`the assignment is ${l.status}; its deadline is closed.`);
    return deadlineCli(l, pos[1], pos[2], flags, clock());
  }
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
  } else if (cmd === 'withdraw') {
    // A proof attached by mistake (the wrong range, the wrong file) would hold the
    // requirement open for ever. Only one that fails now may go: a passing proof
    // is never withdrawn, so this cannot turn a requirement from done to anything.
    if (!req) return fail(`${id} takes no evidence.`);
    if (typeof flags.reason !== 'string') return fail('withdraw needs --reason.');
    const g = gitInfo(false);
    const failing = req.evidence.filter((ev) => !verify(ev, l, g, new Set()).ok);
    if (!failing.length) return fail(`every proof on ${id} passes; nothing to withdraw.`);
    req.evidence = req.evidence.filter((ev) => !failing.includes(ev));
    (req.withdrawn ??= []).push(...failing.map((ev) => ({ ...ev, reason: flags.reason, at: new Date().toISOString() })));
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
