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
    // The check must have run on the release now serving: after the Deploy that released it started.
    const deploys = JSON.parse(gh(`repos/${REPO}/actions/workflows/deploy.yml/runs?per_page=10&status=success`)).workflow_runs;
    const released = deploys.find((d) => d.head_sha === serving(found.log));
    detail += released ? ` (released by Deploy ${released.id}, started ${released.run_started_at})` : ' (no successful Deploy of the serving revision)';
    if (what === 'check-ran') ok = Boolean(released) && checks.some((c) => c[1] > released.run_started_at);
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
  const found = latestLog('admin.yml', 'MAP GOAL_PLAN');
  if (!found) detail = 'no Admin capabilities show run';
  else {
    const status = (id) => new RegExp(`(WORKING|BROKEN|UNPROVEN|MISSING) +${id.replace('.', '\\.')} `).exec(found.log)?.[1] ?? 'ABSENT';
    const ids =
      what === 'evidence-to-plan'
        ? ['EVIDENCE.PATH_ANSWERS', 'QUANT.MODELLED', 'PLAN.READS_NEW_EVIDENCE', 'GOAL.PLAN_EVALUATED']
        : ['RECOVERY.LEASES', 'COMPUTE.GPU', 'COMPUTE.FREE_MODELS', 'GOAL.PLAN_FRESH'];
    const read = Object.fromEntries(ids.map((id) => [id, status(id)]));
    ok = Object.values(read).every((one) => one === 'WORKING');
    detail = `Admin run ${found.run} on ${found.sha.slice(0, 7)}: ${JSON.stringify(read)}`;
  }
} else {
  detail = 'name one of: check-ran, resumed, repair-work, goal-running, honest-plan, commercial, evidence-to-plan, recovery';
}
console.log(`${ok ? 'PASS' : 'FAIL'} ${what}: ${detail}`);
process.exit(ok ? 0 : 1);
