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
 *   node scripts/verify-repair-loop.mjs honest-plan   # the shortfall is named, no probability is invented, the search continues
 *   node scripts/verify-repair-loop.mjs commercial    # a market test is prepared and its owner approval kept
 *   node scripts/verify-repair-loop.mjs evidence-to-plan  # research answers reach the quant model and the plan re-reads
 *   node scripts/verify-repair-loop.mjs recovery      # leases, the GPU, the free models and the plan tick are working
 *
 * Usage needs `gh` authenticated for the repository.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.BRAIN_REPO ?? 'peyday007/v5';
// A dropped connection is retried: a network blip is not a reading (2026-11-06, a reset read as FAIL).
const gh = (path) => {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      last = error;
      execFileSync('sleep', [String(2 ** attempt)]);
    }
  }
  throw last;
};

function recentLogs(workflow, mustContain, limit = 1) {
  const runs = JSON.parse(gh(`repos/${REPO}/actions/workflows/${workflow}/runs?per_page=15&status=success`)).workflow_runs;
  const out = [];
  for (const run of runs) {
    const jobs = JSON.parse(gh(`repos/${REPO}/actions/runs/${run.id}/jobs`)).jobs;
    for (const job of jobs) {
      const log = gh(`repos/${REPO}/actions/jobs/${job.id}/logs`);
      if (log.includes(mustContain)) {
        out.push({ run: run.id, sha: run.head_sha, at: run.created_at, log });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

function latestLog(workflow, mustContain) {
  return recentLogs(workflow, mustContain, 1)[0] ?? null;
}

function serving(log) {
  return /SERVING_REVISION ([0-9a-f]{40})/.exec(log)?.[1] ?? null;
}

const what = process.argv[2];
let ok = false;
let detail = '';
if (what === 'check-ran' || what === 'resumed') {
  // The newest of the last few Goals plan reads whose release had a post-boot check (or resume) to show:
  // a read taken before its release's first check is a timing, not a failure of the mechanism.
  const logs = recentLogs('goals.yml', 'PLAN wst_', 5);
  if (logs.length === 0) detail = 'no Goals plan run';
  const deploys = logs.length ? JSON.parse(gh(`repos/${REPO}/actions/workflows/deploy.yml/runs?per_page=30&status=success`)).workflow_runs : [];
  const once = (rows) => {
    const seen = new Set();
    return rows.filter((r) => !seen.has(r[0]) && seen.add(r[0]));
  };
  for (const found of logs) {
    const checks = once([...found.log.matchAll(/ {2}check {7}(\S+) ready=(\S+) blocking=(\S*) cleared=(\S*)/g)]);
    const resumes = once([...found.log.matchAll(/ {2}resumed {5}(\S+) (.*)/g)]);
    // The Deploy that actually replaced the machine with this revision (one whose "Deploy to Fly" ran).
    let bootAfter = null;
    let releasedBy = null;
    for (const d of deploys.filter((one) => one.head_sha === serving(found.log))) {
      const fly = JSON.parse(gh(`repos/${REPO}/actions/runs/${d.id}/jobs`)).jobs.find((j) => j.name === 'Deploy to Fly' && j.conclusion === 'success');
      if (fly) {
        bootAfter = fly.started_at;
        releasedBy = d.id;
        break;
      }
    }
    const onRelease = checks.filter((c) => bootAfter && c[1] > bootAfter);
    const resumedOnRelease = resumes.filter((r) => bootAfter && r[1] > bootAfter);
    const pass = what === 'check-ran' ? onRelease.length > 0 : resumedOnRelease.length > 0 && onRelease.some((c) => c[4] !== 'none');
    detail = `Goals run ${found.run} on ${serving(found.log)?.slice(0, 7)} (released by Deploy ${releasedBy}; machine replaced after ${bootAfter}): ${onRelease.length} check(s) and ${resumedOnRelease.length} resume(s) on that release`;
    for (const c of onRelease) detail += `\n  check ${c[1]} blocking=${c[3]} cleared=${c[4]}`;
    for (const r of resumedOnRelease) detail += `\n  resumed ${r[1]} ${r[2].slice(0, 160)}`;
    if (pass) {
      ok = true;
      break;
    }
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
} else if (what === 'honest-plan' || what === 'commercial') {
  const found = latestLog('goals.yml', 'PLAN wst_');
  if (!found) detail = 'no Goals plan run';
  else {
    const log = found.log;
    const has =
      what === 'honest-plan'
        ? {
            // A share of worlds is called coverage, never a probability, and no chance is stated without finished plans.
            coverageNotProbability: /coverage of tested conditions, not a probability/.test(log),
            chanceMeasuredOrNotStated: /chance +(not stated|\d)/.test(log),
            shortfallNamed: /missing +the best combination reaches the target in [\d.]+% of worlds/.test(log),
            keepsSearching: /Brain keeps searching/.test(log),
            constructs: /constructed +\d+ arrangement\(s\)/.test(log),
          }
        : {
            marketTestPrepared: /market test +cop_\S+/.test(log),
            nextTestNamed: /next test +\[PERSON\]|next test +\S/.test(log),
            approvalPreserved: /blocker +.*(CONTACT_BUYER|commercial authority)/.test(log),
            planningContinues: /searching +\d+ round\(s\)/.test(log),
          };
    ok = Object.values(has).every(Boolean);
    detail = `Goals run ${found.run} on ${serving(log)?.slice(0, 7)}: ${JSON.stringify(has)}`;
  }
} else if (what === 'evidence-to-plan' || what === 'recovery') {
  // UNPROVEN is "below the sample in that window" — no data, not a verdict. Each requirement is judged by
  // the newest of the last few readings that had its sample; BROKEN or MISSING there fails, as does no proven reading.
  const logs = recentLogs('admin.yml', 'MAP GOAL_PLAN', 4);
  if (logs.length === 0) detail = 'no Admin capabilities show run';
  else {
    const status = (log, id) => new RegExp(`(WORKING|BROKEN|UNPROVEN|MISSING) +${id.replace('.', '\\.')} `).exec(log)?.[1] ?? 'ABSENT';
    const ids =
      what === 'evidence-to-plan'
        ? ['EVIDENCE.PATH_ANSWERS', 'QUANT.MODELLED', 'PLAN.READS_NEW_EVIDENCE', 'GOAL.PLAN_EVALUATED']
        : ['RECOVERY.LEASES', 'COMPUTE.GPU', 'COMPUTE.FREE_MODELS', 'GOAL.PLAN_FRESH'];
    const read = Object.fromEntries(
      ids.map((id) => {
        const proven = logs.find((l) => !['UNPROVEN', 'ABSENT'].includes(status(l.log, id)));
        return [id, proven ? `${status(proven.log, id)}@${proven.run}` : `UNPROVEN in ${logs.length} reading(s)`];
      }),
    );
    ok = Object.values(read).every((one) => one.startsWith('WORKING@'));
    detail = `Admin runs ${logs.map((l) => l.run).join(',')}: ${JSON.stringify(read)}`;
  }
} else if (what === 'squeeze') {
  // SQUEEZE policy (2026-11-06): no market-testing phase; sellable openings are sold now, best first.
  const found = latestLog('goals.yml', '  policy      ');
  if (!found) detail = 'no Goals plan run prints the execution policy';
  else {
    const log = found.log.split('##[notice]')[0];
    const policy = /policy {6}(\S+)/.exec(log)?.[1] ?? null;
    const sales = [...new Set([...log.matchAll(/ {2}sale {8}(\S+) up to (\S+) · \[(\w+)\] (.*)/g)].map((m) => `${m[1]} up to ${m[2]} [${m[3]}] ${m[4].slice(0, 60)}`))];
    const tests = [...log.matchAll(/ {2}market test /g)].length;
    const next = /next step {3}\[(\w+)\] (.*)/.exec(log);
    ok = policy === 'SQUEEZE' && tests === 0 && sales.length > 0 && Boolean(next && next[2].startsWith('Sell "'));
    detail = `Goals run ${found.run} on ${serving(log)?.slice(0, 7)}: policy ${policy}, ${sales.length} sale(s), ${tests} market test line(s), next step ${next ? `[${next[1]}] ${next[2].slice(0, 120)}` : 'none'}`;
    for (const one of sales) detail += `\n  sale ${one}`;
  }
} else if (what === 'selection') {
  // Commercial selection (2026-11-06): constructed estimates are compared with found openings in the portfolio.
  const found = latestLog('goals.yml', '    compared  ');
  if (!found) detail = 'no Goals plan run prints the comparison';
  else {
    const m = /compared {2}(\d+) found opening\(s\) \+ (\d+) constructed estimate\(s\); refused (\d+); estimates in the best combination (\d+)/.exec(found.log);
    const best = /best {6}reaches the target in ([\d.]+)% of worlds · settled p10 (\d+) p50 (\d+) p90 (\d+)/.exec(found.log);
    ok = Boolean(m && Number(m[2]) > 0);
    detail = `Goals run ${found.run} on ${serving(found.log)?.slice(0, 7)}: ${m ? `${m[1]} found + ${m[2]} estimates compared, ${m[3]} refused, ${m[4]} estimate(s) in the best combination` : 'no comparison line'}${best ? `; best reaches ${best[1]}% · p10 ${best[2]} p50 ${best[3]} p90 ${best[4]}` : ''}`;
  }
} else {
  detail = 'name one of: squeeze, selection, check-ran, resumed, repair-work, goal-running, honest-plan, commercial, evidence-to-plan, recovery';
}
console.log(`${ok ? 'PASS' : 'FAIL'} ${what}: ${detail}`);
process.exit(ok ? 0 : 1);
