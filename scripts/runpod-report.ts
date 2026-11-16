/**
 * `sh /app/scripts/runpod-report.sh` — research jobs the free lane did, by model.
 *
 * Read-only. Counts `FREE_LANE_ITEM` events (one per research work item a free-lane
 * worker answered) in the last hours, split by the model slot and outcome, and the
 * GPU's own settings. Fallbacks from the GPU are logged by `cheap/runpod.ts` as
 * `[runpod] fallback`; the workflow counts those from the logs beside this.
 *
 * Quality, per model: the research claims on the fragments that model submitted —
 * how many, what share passed source validation (`sourced`), and what share a
 * verifier later refuted. A fragment two models both answered counts for both.
 *
 * Goals: for every live cash goal, the chain from research job to plan — the
 * goal's research jobs and accepted claims by model, the openings its rounds
 * harvested and which model's fragment each came from, how many the plan
 * considers and models, how many have a buyer and a price it accepts, its
 * reach against the 90% the owner requires, the plan's history, and why the
 * research falls short (`goals/researchYield.ts`).
 *
 * Cost: a pod bills by the hour whether it is busy or not, so the GPU's cost per
 * research job is its hourly price × the window ÷ the jobs it submitted. The price
 * is RunPod's own, sampled while the pod ran; else `BRAIN_RUNPOD_USD_PER_HOUR`; else
 * RunPod's price for the pod read live with the Brain's key. With none, the cost is
 * reported as unknown rather than guessed. Also per accepted GPU claim, and per
 * surviving one (accepted and not refuted).
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { runpodConfig } from '../server/services/cheap/runpod.ts';
import { podConfig, podIdFromUrl, readPod } from '../server/services/cheap/runpodPod.ts';
import { listReadings, planProgress, readGoalPlan } from '../server/services/goals/plan.ts';
import { failureClass, goalPipelineSpeed, goalResearchProgress } from '../server/services/goals/researchYield.ts';
import { resetFreeLaneFitness, unfitNow } from '../server/services/freeLane/worker.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--hours');
const hours = at >= 0 ? Math.max(1, Number(argv[at + 1]) || 6) : 6;

async function main(): Promise<void> {
  await initDatabase();
  const gpu = runpodConfig();
  console.log(`GPU ${gpu ? `primary ${gpu.model}` : 'off'}`);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = await getDb().all<{ reason: string | null; outcome: string; workload_class: string | null; n: number | string; ms: number | string | null }>(
    `SELECT reason, outcome, workload_class, COUNT(*) AS n, AVG(duration_ms) AS ms FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY reason, outcome, workload_class`,
    [since],
  );
  const table = new Map<string, { submitted: number; failed: number; ms: number[]; kinds: Set<string> }>();
  for (const row of rows) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const entry = table.get(model) ?? { submitted: 0, failed: 0, ms: [], kinds: new Set<string>() };
    if (row.outcome === 'SUBMITTED') {
      entry.submitted += Number(row.n);
      if (row.workload_class) entry.kinds.add(row.workload_class);
      if (row.ms != null) entry.ms.push(Number(row.ms));
    } else entry.failed += Number(row.n);
    table.set(model, entry);
  }
  console.log(`FREE-LANE RESEARCH JOBS, last ${hours}h`);
  if (table.size === 0) console.log('  none');
  for (const [model, e] of table) {
    const avg = e.ms.length ? Math.round(e.ms.reduce((a, b) => a + b, 0) / e.ms.length / 1000) : null;
    console.log(`  ${model.padEnd(40)} submitted ${e.submitted} · not accepted ${e.failed}${avg !== null ? ` · ~${avg}s each` : ''}${e.kinds.size ? ` · ${[...e.kinds].join(',')}` : ''}`);
  }
  // Why each model's jobs were not accepted: outcome, kind and reason with ids and counts stripped.
  const why = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome === 'SUBMITTED') continue;
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const key = `${model}\t${row.outcome} ${row.workload_class ?? '?'}: ${failureClass(row.reason)}`;
    why.set(key, (why.get(key) ?? 0) + Number(row.n));
  }
  console.log(`NOT ACCEPTED, by model and reason, last ${hours}h`);
  if (why.size === 0) console.log('  none');
  for (const [key, n] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    const [model, reason] = key.split('\t');
    console.log(`  ${String(n).padStart(4)} × ${model!.padEnd(28)} ${reason}`);
  }
  // Which model|kind pairs the lane holds back now (24h of answers Brain rejected).
  const seen = await getDb().all<{ reason: string | null }>(
    `SELECT DISTINCT reason FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ?`,
    [new Date(Date.now() - 86_400_000).toISOString()],
  );
  const models = [...new Set(seen.map((r) => String(r.reason ?? '').replace(/^model /, '').split(':')[0]!).filter(Boolean))];
  resetFreeLaneFitness();
  const held = await unfitNow(models, Date.now(), null);
  console.log(`HELD BACK ${held.size === 0 ? 'none' : [...held].join(', ')} (model|kind whose answers Brain rejected, 24h; among ${models.join(', ') || 'no models'})`);
  const quality = await getDb().all<{ reason: string | null; claims: number | string; sourced: number | string | null; refuted: number | string | null; accepted: number | string | null; accepted_refuted: number | string | null }>(
    `SELECT e.reason AS reason, COUNT(c.id) AS claims,
            SUM(CASE WHEN c.sourced = 1 THEN 1 ELSE 0 END) AS sourced,
            SUM(CASE WHEN c.contradiction_state = 'REFUTED' THEN 1 ELSE 0 END) AS refuted,
            SUM(CASE WHEN c.accepted = 1 THEN 1 ELSE 0 END) AS accepted,
            SUM(CASE WHEN c.accepted = 1 AND c.contradiction_state = 'REFUTED' THEN 1 ELSE 0 END) AS accepted_refuted
       FROM bin_events e
       JOIN work_items w ON w.id = e.work_item_id
       JOIN research_claims c ON c.fragment_id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED'
        AND e.workload_class = 'RESEARCH_FRAGMENT' AND e.at >= ? AND w.fragment_id IS NOT NULL
      GROUP BY e.reason`,
    [since],
  );
  console.log('RESEARCH QUALITY (claims on fragments each model submitted)');
  if (quality.length === 0) console.log('  none');
  // Accepted and surviving (accepted, not refuted) claims per model, summed across
  // the reasons one model's rows carry, for the GPU's cost per claim below.
  const accepted = new Map<string, { accepted: number; surviving: number }>();
  for (const row of quality) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const a = accepted.get(model) ?? { accepted: 0, surviving: 0 };
    a.accepted += Number(row.accepted ?? 0);
    a.surviving += Number(row.accepted ?? 0) - Number(row.accepted_refuted ?? 0);
    accepted.set(model, a);
  }
  for (const row of quality) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const claims = Number(row.claims);
    const pct = (x: number | string | null) => (claims ? `${Math.round((100 * Number(x ?? 0)) / claims)}%` : '-');
    console.log(`  ${model.padEnd(40)} claims ${claims} · sourced ${pct(row.sourced)} · refuted ${pct(row.refuted)}`);
  }
  const gpuRow = [...table].find(([m]) => m.startsWith('runpod/'));
  const gpuJobs = gpuRow ? gpuRow[1].submitted : 0;
  // The pod's own power history: what Brain stopped and started, and RunPod's
  // price sampled while it ran (runpodPod.ts), so running time is measured.
  const pod = await getDb().all<{ outcome: string; n: number | string; ms: number | string | null; measures: string | null }>(
    `SELECT outcome, COUNT(*) AS n, SUM(duration_ms) AS ms, MAX(measures) AS measures FROM bin_events
      WHERE event_type = 'RUNPOD_POD' AND at >= ? GROUP BY outcome`,
    [since],
  );
  const podCount = (o: string) => Number(pod.find((r) => r.outcome === o)?.n ?? 0);
  const runningMs = Number(pod.find((r) => r.outcome === 'SAMPLE_RUNNING')?.ms ?? 0);
  const sampledCost = (() => {
    try {
      const m = JSON.parse(String(pod.find((r) => r.outcome === 'SAMPLE_RUNNING')?.measures ?? '{}')) as { costPerHr?: number | null };
      return typeof m.costPerHr === 'number' && m.costPerHr > 0 ? m.costPerHr : null;
    } catch {
      return null;
    }
  })();
  if (pod.length > 0) {
    console.log(`POD stopped ${podCount('STOPPED')} · started ${podCount('STARTED')} · moved ${podCount('MIGRATED')} · failed ${podCount('STOP_FAILED') + podCount('START_FAILED') + podCount('MIGRATE_FAILED')} · running ~${Math.round(runningMs / 60_000)} min sampled · stopped ~${Math.round(Number(pod.find((r) => r.outcome === 'SAMPLE_EXITED')?.ms ?? 0) / 60_000)} min sampled`);
    // What Brain last did to the pod, and RunPod's own words when it refused.
    const recent = await getDb().all<{ at: string; outcome: string; reason: string | null }>(
      `SELECT at, outcome, reason FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome NOT LIKE 'SAMPLE_%'
        ORDER BY at DESC LIMIT 5`,
    );
    for (const row of recent) console.log(`  pod ${row.at} ${row.outcome} ${String(row.reason ?? '').slice(0, 220)}`);
  } else console.log('POD no supervision events (auto stop/start is off without BRAIN_RUNPOD_API_KEY)');
  const gpuClaims = [...accepted].filter(([m]) => m.startsWith('runpod/')).reduce((t, [, a]) => ({ accepted: t.accepted + a.accepted, surviving: t.surviving + a.surviving }), { accepted: 0, surviving: 0 });
  /*
   * The price: RunPod's own, sampled while the pod ran; else the configured
   * `BRAIN_RUNPOD_USD_PER_HOUR`; else RunPod's price for the pod read live now
   * (production 2026-11-16: no samples and no variable, so the line said
   * "unknown" while the Brain held the key and the pod id to ask RunPod).
   */
  const configured = Number(process.env['BRAIN_RUNPOD_USD_PER_HOUR'] ?? '');
  const livePrice = sampledCost === null && !(Number.isFinite(configured) && configured > 0) ? await liveRunpodPrice() : null;
  const price = sampledCost ?? (Number.isFinite(configured) && configured > 0 ? configured : livePrice?.costPerHr ?? NaN);
  const perClaim = (spend: number) =>
    ` · ${gpuJobs ? `$${(spend / gpuJobs).toFixed(4)} per research job` : 'no GPU jobs yet'}` +
    ` · ${gpuClaims.accepted ? `$${(spend / gpuClaims.accepted).toFixed(4)} per accepted claim (${gpuClaims.accepted})` : 'no accepted GPU claims'}` +
    ` · ${gpuClaims.surviving > 0 ? `$${(spend / gpuClaims.surviving).toFixed(4)} per surviving claim (${gpuClaims.surviving}, accepted minus refuted)` : 'no surviving GPU claims'}`;
  if (sampledCost && runningMs > 0) {
    const spend = (sampledCost * runningMs) / 3_600_000;
    console.log(`GPU COST $${spend.toFixed(2)} measured: ${Math.round(runningMs / 60_000)} min running at RunPod's $${sampledCost}/h${perClaim(spend)}`);
  } else if (Number.isFinite(price) && price > 0) {
    const spend = price * hours;
    const source = livePrice ? `RunPod's live price for pod ${livePrice.podId} (${livePrice.status}), billed as if running the whole window` : 'BRAIN_RUNPOD_USD_PER_HOUR';
    console.log(`GPU COST $${spend.toFixed(2)} for ${hours}h at $${price}/h from ${source}${perClaim(spend)}`);
  } else console.log(`GPU COST unknown (${livePrice === null && !(process.env['BRAIN_RUNPOD_API_KEY'] ?? '').trim() ? 'no BRAIN_RUNPOD_API_KEY to ask RunPod, and BRAIN_RUNPOD_USD_PER_HOUR unset' : 'RunPod returned no price for the pod, and BRAIN_RUNPOD_USD_PER_HOUR unset'})`);
  console.log(`RUNPOD_ACCEPTED_CLAIMS ${gpuClaims.accepted} surviving ${gpuClaims.surviving}`);
  console.log(`RUNPOD_SUBMITTED ${gpuJobs}`);
  await goalSection(since, hours);
  console.log('RUNPOD-REPORT: OK');
}

/** The $10K-style goals: does research, and the GPU's in particular, reach the plan? */
async function goalSection(since: string, hours: number): Promise<void> {
  const goals = await getDb().all<{ id: string; title: string }>(
    `SELECT id, title FROM workstreams WHERE target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL`,
  );
  let gpuOpenings = 0;
  let gpuInPlan = 0;
  for (const goal of goals) {
    const reading = await readGoalPlan({ goalId: goal.id, persist: false });
    if (!reading) continue;
    const progress = await goalResearchProgress(reading.target.projectId, goal.id, since);
    console.log(`GOAL ${goal.id} ${goal.title.slice(0, 80)}`);
    const r = progress.rounds;
    console.log(`  rounds (${hours}h)   opened ${r.opened} · harvested ${r.harvested} (${r.withOpenings} with openings) · abandoned ${r.abandoned} · open now ${r.open}`);
    for (const [model, j] of Object.entries(progress.jobs)) {
      const c = progress.claims[model];
      console.log(`  jobs ${model.padEnd(28)} submitted ${j.submitted} · not accepted ${j.failed}${c ? ` · claims ${c.claims}, sourced ${c.sourced}, opening signals ${c.signalled}` : ''}`);
    }
    if (Object.keys(progress.jobs).length === 0) console.log('  jobs                 none on this goal');
    for (const f of progress.failures) console.log(`  not accepted ${String(f.n).padStart(4)} × ${f.reason}`);
    const considered = new Map(reading.considered.map((one) => [one.opportunityId, one]));
    const p = planProgress(reading);
    for (const one of progress.openings) {
      const judged = considered.get(one.id);
      const left = reading.excluded.find((x) => x.opportunityId === one.id);
      const where = judged ? (judged.modelled ? 'MODELLED' : 'CONSIDERED') : left ? `left out: ${left.reason.slice(0, 70)}` : 'not read by the plan';
      if (one.model?.startsWith('runpod/')) {
        gpuOpenings += 1;
        if (judged) gpuInPlan += 1;
      }
      console.log(`  opening ${one.id} [${one.model ?? 'no fragment'}] payer ${one.payer ? 'yes' : 'no'} · price ${one.price ? 'yes' : 'no'} · ${where}${judged ? ` · missing ${judged.missing.join(',') || 'nothing'}` : ''} · ${one.title.slice(0, 70)}`);
    }
    console.log(`  new openings         ${progress.openings.length} in ${hours}h · ${progress.openings.filter((o) => o.payer && o.price).length} with payer and price on the card`);
    console.log(`  plan                 ${reading.verdict} · considered ${p.considered} · modelled ${p.modelled} · buyer and price accepted by the plan ${p.evidencedBuyerAndPrice}`);
    console.log(`  combined             reach ${p.reach === null ? 'n/a' : `${Math.round(p.reach * 100)}%`} of worlds (requirement 90%) · p50 settled ${p.settledP50 ?? 'n/a'} · best reach ${p.bestReach ?? 'n/a'} · basis ${reading.portfolio?.basis ?? 'n/a'}`);
    const history = (await listReadings(goal.id)).slice(-6);
    for (const row of history) {
      let f: Record<string, unknown> = {};
      try {
        f = row.forecast ? (JSON.parse(row.forecast) as Record<string, unknown>) : {};
      } catch {
        f = {};
      }
      console.log(`  history ${row.created_at} ${row.verdict} reach ${f['reach'] ?? '-'} p50 ${f['settledP50'] ?? '-'} considered ${f['considered'] ?? '-'} modelled ${f['modelled'] ?? '-'} causes ${Array.isArray(f['causes']) ? (f['causes'] as string[]).join(',') : '-'}`);
    }
    const earlier = new Date(Date.parse(since) - hours * 3_600_000).toISOString();
    const windows = [
      { label: `last ${hours}h`, speed: await goalPipelineSpeed({ goalId: goal.id, projectId: reading.target.projectId, since }) },
      { label: `the ${hours}h before`, speed: await goalPipelineSpeed({ goalId: goal.id, projectId: reading.target.projectId, since: earlier, until: since }) },
    ];
    for (const { label, speed } of windows) {
    const min = (ms: number | null) => (ms === null ? 'n/a' : `${Math.round(ms / 6_000) / 10} min`);
    const sec = (ms: number | null) => (ms === null ? 'n/a' : `${Math.round(ms / 100) / 10} s`);
    const since0 = (at: string | null) => (at && speed.goalCreatedAt ? min(Date.parse(at) - Date.parse(speed.goalCreatedAt)) : 'not yet');
    console.log(`  SPEED ${label}`);
    console.log(`  speed submit→plan    first reading ${since0(speed.firstReadingAt)} after the goal was filed · complete plan (RECOMMENDABLE) ${since0(speed.firstRecommendableAt)}`);
    console.log(`  speed concurrency    free-lane jobs at once: peak ${speed.jobs.peak}, average ${speed.jobs.average} (${speed.jobs.total} jobs) · this goal's: peak ${speed.jobs.goalPeak}, average ${speed.jobs.goalAverage} (${speed.jobs.goal} jobs)`);
    console.log(`  speed throughput     accepted claims ${speed.acceptedClaimsPerHour}/h (this goal ${speed.goalAcceptedClaimsPerHour}/h) · openings filed ${speed.openingsPerHour}/h · plan evaluations ${speed.planRunsPerHour}/h`);
    console.log(`  speed waiting        opening → next plan run: median ${min(speed.evidenceToPlan.medianMs)}, p90 ${min(speed.evidenceToPlan.p90Ms)}, max ${min(speed.evidenceToPlan.maxMs)} over ${speed.evidenceToPlan.openings} opening(s), ${speed.evidenceToPlan.unread} not yet read · free lane idle with work queued ~${speed.idleWithWorkMinutes} min`);
    console.log(`  speed quant          plan run: median ${sec(speed.planRunMs.medianMs)}, max ${sec(speed.planRunMs.maxMs)} over ${speed.planRunMs.runs} run(s)`);
    console.log(`  speed gpu            job time ${min(speed.gpu.jobMs)} over ${min(speed.gpu.runningMs)} running · ${speed.gpu.busySlots === null ? 'utilization unknown (no running samples)' : `${speed.gpu.busySlots} slot(s) busy on average while running`}`);
    }
    console.log(`SPEED_EVIDENCE_TO_PLAN_MEDIAN_MS ${windows[0]!.speed.evidenceToPlan.medianMs ?? 'n/a'} before ${windows[1]!.speed.evidenceToPlan.medianMs ?? 'n/a'}`);
    console.log(`SPEED_JOBS_PEAK ${windows[0]!.speed.jobs.peak} before ${windows[1]!.speed.jobs.peak}`);
    for (const d of reading.researchDiagnosis) console.log(`  why short ${d.cause}: ${d.evidence}`);
    if (reading.researchDiagnosis.length === 0) console.log('  why short            nothing stands out');
  }
  console.log(`RUNPOD_GOAL_OPENINGS ${gpuOpenings}`);
  console.log(`RUNPOD_GOAL_OPENINGS_IN_PLAN ${gpuInPlan}`);
}

/** RunPod's price for Brain's pod, asked live with the Brain's own key; null when there is no key, no pod id or no price. */
async function liveRunpodPrice(): Promise<{ podId: string; status: string; costPerHr: number } | null> {
  const apiKey = process.env['BRAIN_RUNPOD_API_KEY']?.trim();
  if (!apiKey) return null;
  const supervised = podConfig();
  const podId = supervised?.podId || process.env['BRAIN_RUNPOD_POD_ID']?.trim() || podIdFromUrl(process.env['BRAIN_RUNPOD_URL'] ?? '');
  if (!podId) return null;
  const read = await readPod({ apiKey, podId, idleStopMs: 0, vllm: { url: '', key: null } });
  return read.costPerHr !== null && read.costPerHr > 0 ? { podId, status: read.status, costPerHr: read.costPerHr } : null;
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error('RUNPOD-REPORT: FAILED', pooler ?? error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
