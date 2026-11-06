#!/usr/bin/env node
/**
 * Reads production's own report of the repair-to-goal loop (§88) and fails
 * unless the named property is shown. It reads the latest `Goals` (`plan`) and
 * `Admin` (`improvement show`) runs on the canonical branch through the GitHub
 * API, so the verdict is production's rows, not this checkout's code.
 *
 *   node scripts/verify-repair-loop.mjs check-ran     # a capability check ran on the running release
 *   node scripts/verify-repair-loop.mjs resumed       # a cleared gap resumed the goal
 *   node scripts/verify-repair-loop.mjs repair-work   # a failed check is Factory work
 *   node scripts/verify-repair-loop.mjs goal-running  # the goal's plan, construction, quant and search ran
 *
 * Usage needs `gh` authenticated for the repository.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.BRAIN_REPO ?? 'peyday007/v5';
const gh = (path) => execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function latestLog(workflow, mustContain) {
  const runs = JSON.parse(gh(`repos/${REPO}/actions/workflows/${workflow}/runs?per_page=15&status=success`)).workflow_runs;
  for (const run of runs) {
    const jobs = JSON.parse(gh(`repos/${REPO}/actions/runs/${run.id}/jobs`)).jobs;
    for (const job of jobs) {
      const log = gh(`repos/${REPO}/actions/jobs/${job.id}/logs`);
      if (log.includes(mustContain)) return { run: run.id, sha: run.head_sha, log };
    }
  }
  return null;
}

function serving(log) {
  return /SERVING_REVISION ([0-9a-f]{40})/.exec(log)?.[1] ?? null;
}

const what = process.argv[2];
let ok = false;
let detail = '';
if (what === 'check-ran' || what === 'resumed') {
  const found = latestLog('goals.yml', 'PLAN wst_');
  if (!found) detail = 'no Goals plan run';
  else {
    const once = (rows) => {
      const seen = new Set();
      return rows.filter((r) => !seen.has(r[0]) && seen.add(r[0]));
    };
    const checks = once([...found.log.matchAll(/ {2}check {7}(\S+) ready=(\S+) blocking=(\S*) cleared=(\S*)/g)]);
    const resumes = once([...found.log.matchAll(/ {2}resumed {5}(\S+) (.*)/g)]);
    detail = `Goals run ${found.run} on ${serving(found.log)?.slice(0, 7)}: ${checks.length} check row(s), ${resumes.length} resume row(s)`;
    if (what === 'check-ran') ok = checks.length > 0;
    else ok = resumes.length > 0 && checks.some((c) => c[4] !== 'none');
    for (const c of checks) detail += `\n  check ${c[1]} blocking=${c[3]} cleared=${c[4]}`;
    for (const r of resumes) detail += `\n  resumed ${r[1]} ${r[2].slice(0, 160)}`;
  }
} else if (what === 'repair-work') {
  const found = latestLog('admin.yml', 'CANDIDATES');
  if (!found) detail = 'no Admin improvement show run';
  else {
    const seen = new Set();
    const rows = [...found.log.matchAll(/ {4}(CAPABILITY:\S+) +(\S+) +(\S+).*\n.*\[([^\]]*fcp_[^\]]*)\]/g)].filter((r) => !seen.has(r[1]) && seen.add(r[1]));
    ok = rows.length > 0;
    detail = `Admin run ${found.run}: ${rows.length} capability gap(s) sent to Factory`;
    for (const r of rows) detail += `\n  ${r[1]} ${r[2]} ${r[4].split(' ').filter((x) => x.startsWith('fcp_')).join(',')}`;
  }
} else if (what === 'goal-running') {
  const found = latestLog('goals.yml', 'PLAN wst_');
  if (!found) detail = 'no Goals plan run';
  else {
    const log = found.log;
    const has = {
      limits: /spending +at most USD 375 before any money comes in; at most USD 750 newly tied up a week; at most USD 3000 in all/.test(log),
      quant: /quant +coverage of tested conditions, not a probability/.test(log),
      constructed: /constructed +\d+ arrangement\(s\)/.test(log),
      searching: /searching +\d+ round\(s\)/.test(log),
      gpu: /runpod\/\S+: \d+ answers/.test(log),
      tick: /tick +RUNNING/.test(log),
    };
    ok = Object.values(has).every(Boolean);
    detail = `Goals run ${found.run} on ${serving(log)?.slice(0, 7)}: ${JSON.stringify(has)}`;
  }
} else {
  detail = 'name one of: check-ran, resumed, repair-work, goal-running';
}
console.log(`${ok ? 'PASS' : 'FAIL'} ${what}: ${detail}`);
process.exit(ok ? 0 : 1);
