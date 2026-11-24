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
import { runpodConfig, servedByGpu } from '../server/services/cheap/runpod.ts';
import { podConfig, readPod } from '../server/services/cheap/runpodPod.ts';
import { BENCH_PREFIX, listPods } from '../server/services/cheap/runpodRestore.ts';
import { listReadings, planProgress, readGoalPlan } from '../server/services/goals/plan.ts';
import { failureClass, goalPipelineSpeed, goalResearchProgress, percentile, waitsUntilNext } from '../server/services/goals/researchYield.ts';
import { FREE_LANE_PURPOSES, resetFreeLaneFitness, unfitNow } from '../server/services/freeLane/worker.ts';
import { claimQualityByModel } from '../server/repos/research.ts';
import { accountReading } from '../server/services/cheap/runpodAccount.ts';
import { gpuThroughput, hoursToClear, runningByDay, shrinkCauses, summarizeGpuJobs, type LaneJobRow } from '../server/services/cheap/gpuCapacity.ts';
import { launchableByProject } from '../server/services/russell/loop.ts';

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
  // Windowed by submission or by the gate's ruling: a claim judged an hour after it was submitted still counts (2026-11-18).
  const quality = await claimQualityByModel(since);
  console.log('RESEARCH QUALITY (claims on fragments each model submitted, or the gate judged, in the window)');
  if (quality.length === 0) console.log('  none');
  // Accepted and surviving (accepted, not refuted) claims per model, summed across
  // the reasons one model's rows carry, for the GPU's cost per claim below.
  const accepted = new Map<string, { accepted: number; surviving: number }>();
  for (const row of quality) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const a = accepted.get(model) ?? { accepted: 0, surviving: 0 };
    a.accepted += row.accepted;
    a.surviving += row.accepted - row.acceptedRefuted;
    accepted.set(model, a);
  }
  for (const row of quality) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const claims = row.claims;
    const pct = (x: number) => (claims ? `${Math.round((100 * x) / claims)}%` : '-');
    console.log(`  ${model.padEnd(40)} claims ${claims} · sourced ${pct(row.sourced)} · refuted ${pct(row.refuted)} · accepted ${row.accepted}`);
  }
  const gpuRow = [...table].find(([m]) => m.startsWith('runpod/'));
  const gpuJobs = gpuRow ? gpuRow[1].submitted : 0;
  const gpuRows = await readGpuLaneRows(since);
  const gpuServed = summarizeGpuJobs(gpuRows);
  console.log(
    `GPU SERVED, last ${hours}h (who answered, from servedBy) · the GPU itself: submitted ${gpuServed.gpu.submitted} · not accepted ${gpuServed.gpu.notAccepted}` +
      ` · its slot answered only by the free fallback: submitted ${gpuServed.slotFallback.submitted} · not accepted ${gpuServed.slotFallback.notAccepted}`,
  );
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
  const livePrice = sampledCost === null || runningMs === 0 ? await liveRunpodPrice() : null;
  const price = Number.isFinite(configured) && configured > 0 ? configured : NaN;
  const perClaim = (spend: number) =>
    ` · ${gpuServed.gpu.submitted ? `$${(spend / gpuServed.gpu.submitted).toFixed(4)} per research job the GPU answered` : 'no job answered by the GPU'}` +
    ` · ${gpuClaims.accepted ? `$${(spend / gpuClaims.accepted).toFixed(4)} per accepted claim (${gpuClaims.accepted})` : 'no accepted GPU claims'}` +
    ` · ${gpuClaims.surviving > 0 ? `$${(spend / gpuClaims.surviving).toFixed(4)} per surviving claim (${gpuClaims.surviving}, accepted minus refuted)` : 'no surviving GPU claims'}`;
  if (sampledCost && runningMs > 0) {
    const spend = (sampledCost * runningMs) / 3_600_000;
    console.log(`GPU COST $${spend.toFixed(2)} measured: ${Math.round(runningMs / 60_000)} min running at RunPod's $${sampledCost}/h${perClaim(spend)}`);
  } else if (livePrice && livePrice.costPerHr >= 0 && !(Number.isFinite(configured) && configured > 0)) {
    /*
     * RunPod's live rate, priced over the time the pod actually ran in the
     * window, not the whole window: the owner runs bounded GPU tests and
     * stops the pod (2026-11-16 21:35Z), so "rate × window" would bill hours
     * it was stopped. Running time is the larger of Brain's own STARTED→STOPPED
     * events and the span of GPU jobs; a pod running now runs to now.
     */
    // The span of jobs the GPU itself answered: its slot's label is no evidence the pod ran
    // (2026-11-23: $31.09 priced over the span of fallback-answered jobs on a pod EXITED for four days).
    const answered = gpuRows.filter((r) => servedByGpu(r.measures)).map((r) => r.at).sort();
    const span = { first: answered[0] ?? null, last: answered[answered.length - 1] ?? null };
    const power = await getDb().all<{ at: string; outcome: string }>(
      `SELECT at, outcome FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome IN ('STARTED', 'STOPPED') AND at >= ? ORDER BY at`,
      [since],
    );
    const nowMs = Date.now();
    const running = livePrice.status === 'RUNNING';
    let eventMs = 0;
    let on: number | null = running && !power.some((p) => p.outcome === 'STARTED') ? Date.parse(since) : null;
    for (const p of power) {
      if (p.outcome === 'STARTED' && on === null) on = Date.parse(p.at);
      else if (p.outcome === 'STOPPED') {
        eventMs += on === null ? Date.parse(p.at) - Date.parse(since) : Date.parse(p.at) - on;
        on = null;
      }
    }
    if (on !== null && running) eventMs += nowMs - on;
    const jobMs = span?.first && span.last ? Math.max(0, (running ? nowMs : Date.parse(span.last)) - Date.parse(span.first)) : 0;
    const ranMs = Math.min(hours * 3_600_000, Math.max(eventMs, jobMs));
    const spend = (livePrice.costPerHr * ranMs) / 3_600_000;
    const now = running ? `$${livePrice.costPerHr}/h now` : `$0/h now (rate ${livePrice.costPerHr > 0 ? `$${livePrice.costPerHr}/h` : 'not reported'} while running)`;
    console.log(`GPU COST $${spend.toFixed(2)} for ~${Math.round(ranMs / 60_000)} min running in ${hours}h · pod ${livePrice.podId} ${livePrice.status}, RunPod's live price ${now}${spend > 0 ? perClaim(spend) : ''}`);
  } else if (Number.isFinite(price) && price > 0) {
    const spend = price * hours;
    console.log(`GPU COST $${spend.toFixed(2)} for ${hours}h at $${price}/h from BRAIN_RUNPOD_USD_PER_HOUR${perClaim(spend)}`);
  } else console.log(`GPU COST unknown (${livePrice === null && !(process.env['BRAIN_RUNPOD_API_KEY'] ?? '').trim() ? 'no BRAIN_RUNPOD_API_KEY to ask RunPod, and BRAIN_RUNPOD_USD_PER_HOUR unset' : `RunPod returned no price for the pod${liveFailure ? `: ${liveFailure}` : ''}, and BRAIN_RUNPOD_USD_PER_HOUR unset`})`);
  console.log(`RUNPOD_ACCEPTED_CLAIMS ${gpuClaims.accepted} surviving ${gpuClaims.surviving}`);
  // What the GPU itself answered, not its slot: the slot keeps its label while the fallback answers it.
  console.log(`RUNPOD_SUBMITTED ${gpuServed.gpu.submitted}`);
  console.log(`RUNPOD_SLOT_SUBMITTED ${gpuJobs} (on the GPU slot; ${gpuServed.slotFallback.submitted} of them answered only by the free fallback)`);
  await capacitySection();
  await queueSection(since, hours);
  await pressureSection(since, hours);
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
    await traceSection(goal.id, reading, since, hours);
  }
  console.log(`RUNPOD_GOAL_OPENINGS ${gpuOpenings}`);
  console.log(`RUNPOD_GOAL_OPENINGS_IN_PLAN ${gpuInPlan}`);
}

const num = (x: number | string | null | undefined): number => Number(x ?? 0) || 0;
const ageMin = (at: string | null | undefined, nowMs = Date.now()): string => (at ? `${Math.round((nowMs - Date.parse(at)) / 6_000) / 10} min` : '-');
function parseJson(text: string | null | undefined): Record<string, unknown> {
  try {
    const value = text ? (JSON.parse(text) as unknown) : {};
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The work queue under a surge (surge readiness W4): what arrived against what
 * finished, per work type and per hour; what waits now, how much of it is
 * claimable and how long the oldest has waited; and the retries — items that
 * needed more than one lease, split into those a retry rescued and those it did
 * not (an ineffective retry). Read-only and aggregated in the database: every
 * statement is bounded by the window or by the live states.
 */
async function queueSection(since: string, hours: number): Promise<void> {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const arrived = await db.all<{ work_type: string; hour: string; n: number | string }>(
    `SELECT work_type, SUBSTR(created_at, 1, 13) AS hour, COUNT(*) AS n FROM work_items
      WHERE created_at >= ? GROUP BY work_type, SUBSTR(created_at, 1, 13)`,
    [since],
  );
  const finished = await db.all<{ work_type: string; hour: string; state: string; n: number | string; retried: number | string | null }>(
    `SELECT work_type, SUBSTR(completed_at, 1, 13) AS hour, state, COUNT(*) AS n,
            SUM(CASE WHEN attempt_count > 1 THEN 1 ELSE 0 END) AS retried
       FROM work_items WHERE completed_at >= ? GROUP BY work_type, SUBSTR(completed_at, 1, 13), state`,
    [since],
  );
  type Flow = { arrived: number; succeeded: number; failed: number; cancelled: number; retriedOk: number; retriedNot: number };
  const blank = (): Flow => ({ arrived: 0, succeeded: 0, failed: 0, cancelled: 0, retriedOk: 0, retriedNot: 0 });
  const byType = new Map<string, Flow>();
  const byHour = new Map<string, Flow>();
  for (const row of arrived) {
    for (const [map, key] of [[byType, row.work_type], [byHour, row.hour]] as const) {
      const f = map.get(key) ?? blank();
      f.arrived += num(row.n);
      map.set(key, f);
    }
  }
  for (const row of finished) {
    for (const [map, key] of [[byType, row.work_type], [byHour, row.hour]] as const) {
      const f = map.get(key) ?? blank();
      if (row.state === 'SUCCEEDED') {
        f.succeeded += num(row.n);
        f.retriedOk += num(row.retried);
      } else {
        if (row.state === 'FAILED') f.failed += num(row.n);
        else f.cancelled += num(row.n);
        f.retriedNot += num(row.retried);
      }
      map.set(key, f);
    }
  }
  console.log(`QUEUE FLOW, last ${hours}h (work_items: arrived = created, finished = completed; retried = needed more than one lease)`);
  if (byType.size === 0) console.log('  none');
  const line = (f: Flow) => {
    const done = f.succeeded + f.failed + f.cancelled;
    return `arrived ${String(f.arrived).padStart(5)} · finished ${String(done).padStart(5)} (succeeded ${f.succeeded}, failed ${f.failed}, cancelled ${f.cancelled}) · net ${f.arrived - done >= 0 ? '+' : ''}${f.arrived - done} · retries rescued ${f.retriedOk}, ineffective ${f.retriedNot}`;
  };
  for (const [type, f] of [...byType].sort((a, b) => b[1].arrived - a[1].arrived)) console.log(`  ${type.padEnd(26)} ${line(f)}`);
  for (const [hour, f] of [...byHour].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  hour ${hour}Z${' '.repeat(8)} ${line(f)}`);
  const total = [...byType.values()].reduce((t, f) => ({ arrived: t.arrived + f.arrived, done: t.done + f.succeeded + f.failed + f.cancelled, ok: t.ok + f.succeeded, ineffective: t.ineffective + f.retriedNot }), { arrived: 0, done: 0, ok: 0, ineffective: 0 });
  console.log(`QUEUE_ARRIVED ${total.arrived} FINISHED ${total.done} SUCCEEDED ${total.ok} INEFFECTIVE_RETRIES ${total.ineffective}`);

  const live = await db.all<{ work_type: string; state: string; n: number | string; claimable: number | string | null; oldest_created: string | null; oldest_claimable: string | null; oldest_leased: string | null; overdue: number | string | null }>(
    `SELECT work_type, state, COUNT(*) AS n,
            SUM(CASE WHEN available_at <= ? THEN 1 ELSE 0 END) AS claimable,
            MIN(created_at) AS oldest_created,
            MIN(CASE WHEN available_at <= ? THEN available_at END) AS oldest_claimable,
            MIN(leased_at) AS oldest_leased,
            SUM(CASE WHEN lease_expires_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM work_items WHERE state IN ('QUEUED', 'LEASED') GROUP BY work_type, state`,
    [nowIso, nowIso, nowIso],
  );
  console.log('QUEUE DEPTH now (QUEUED: claimable = available now, waited = since it became available; LEASED: overdue = lease past expiry)');
  if (live.length === 0) console.log('  empty');
  for (const row of live.sort((a, b) => a.state.localeCompare(b.state) || num(b.n) - num(a.n))) {
    if (row.state === 'QUEUED') {
      console.log(`  QUEUED ${row.work_type.padEnd(26)} ${String(num(row.n)).padStart(5)} · claimable ${num(row.claimable)} · oldest claimable waited ${ageMin(row.oldest_claimable)} · oldest created ${ageMin(row.oldest_created)} ago`);
    } else {
      console.log(`  LEASED ${row.work_type.padEnd(26)} ${String(num(row.n)).padStart(5)} · oldest lease ${ageMin(row.oldest_leased)} · overdue ${num(row.overdue)}`);
    }
  }
  const queued = live.filter((r) => r.state === 'QUEUED');
  const oldestClaimable = queued.map((r) => r.oldest_claimable).filter((x): x is string => !!x).sort()[0] ?? null;
  console.log(`QUEUE_DEPTH queued ${queued.reduce((t, r) => t + num(r.n), 0)} claimable ${queued.reduce((t, r) => t + num(r.claimable), 0)} leased ${live.filter((r) => r.state === 'LEASED').reduce((t, r) => t + num(r.n), 0)} oldest_claimable_wait_min ${oldestClaimable ? Math.round((Date.now() - Date.parse(oldestClaimable)) / 60_000) : 'n/a'}`);

  const leases = await db.all<{ outcome: string | null; n: number | string }>(
    'SELECT outcome, COUNT(*) AS n FROM work_leases WHERE ended_at >= ? GROUP BY outcome',
    [since],
  );
  console.log(`LEASES ENDED, last ${hours}h ${leases.length ? leases.map((r) => `${(r.outcome ?? 'none').toLowerCase()}=${num(r.n)}`).join(' ') : 'none'}`);
  const bins = await db.all<{ state: string; n: number | string; oldest: string | null }>(
    `SELECT state, COUNT(*) AS n, MIN(created_at) AS oldest FROM bins WHERE state IN ('READY', 'LEASED') GROUP BY state`,
  );
  console.log(`BINS now ${bins.length ? bins.map((r) => `${r.state.toLowerCase()}=${num(r.n)} (oldest ${ageMin(r.oldest)})`).join(' · ') : 'none ready or leased'}`);
}

/**
 * Server pressure as Brain itself records it (surge readiness W4): each live
 * process's own last reading (`runtime_liveness.readings`, written about every
 * thirty seconds: CPU, memory, event loop, pool waits, the §63 database
 * pressure state), and across the window the free-lane controller's measured
 * decisions (`FREE_LANE_CAPACITY`, each carrying the CPU, loop lag, database
 * state and queue it acted on) and its idle-with-work readings. The database
 * server's own view (sessions, Supabase host CPU and disk) is the connection
 * report's; this does not repeat it.
 */
async function pressureSection(since: string, hours: number): Promise<void> {
  const db = getDb();
  const alive = await db.all<{ instance_id: string; alive_at: string; readings: string | null }>(
    'SELECT instance_id, alive_at, readings FROM runtime_liveness WHERE alive_at >= ? ORDER BY alive_at DESC LIMIT 5',
    [new Date(Date.now() - 120_000).toISOString()],
  );
  console.log('PRESSURE now (each live process\'s own last reading)');
  if (alive.length === 0) console.log('  no process wrote a reading in the last 2 min');
  for (const row of alive) {
    const r = parseJson(row.readings);
    const cpu = r['cpu'] as { windowMs?: number; processPctOfCore?: number; stealPct?: number | null; idlePct?: number | null; vcpus?: number | null } | null | undefined;
    const mem = r['memory'] as { rssMB?: number; heapUsedMB?: number; heapLimitMB?: number; peakRssMB?: number } | null | undefined;
    const loop = r['eventLoop'] as { p99?: number; max?: number } | null | undefined;
    const pools = r['pools'] as Record<string, { total?: number; idle?: number; waiting?: number; max?: number }> | null | undefined;
    const checkouts = r['checkouts'] as Record<string, { p95?: number; max?: number }> | null | undefined;
    const pressure = r['pressure'] as { state?: string; p90Ms?: number | null; failures?: number; reason?: string; since?: string } | null | undefined;
    const pool = (name: string) => {
      const p = pools?.[name];
      const c = checkouts?.[name.toUpperCase()];
      return p ? `${name} ${num(p.total) - num(p.idle)}/${num(p.max)} busy, ${num(p.waiting)} waiting${c ? `, wait p95 ${num(c.p95)}ms max ${num(c.max)}ms` : ''}` : `${name} -`;
    };
    console.log(`  ${row.instance_id.slice(0, 12)} rev ${String(r['revision'] ?? '?').slice(0, 8)} alive ${row.alive_at}`);
    console.log(`    cpu ${cpu ? `${cpu.processPctOfCore ?? '?'}% of one core over ${Math.round(num(cpu.windowMs) / 1000)}s · machine idle ${cpu.idlePct ?? '?'}% steal ${cpu.stealPct ?? '?'}% · ${cpu.vcpus ?? '?'} vCPU` : 'not measured'} · memory ${mem ? `rss ${mem.rssMB}MB heap ${mem.heapUsedMB}/${mem.heapLimitMB}MB peak rss ${mem.peakRssMB}MB` : 'not measured'} · loop ${loop ? `p99 ${loop.p99}ms max ${loop.max}ms` : 'not measured'}`);
    console.log(`    db ${pool('workload')} · ${pool('control')} · pressure ${pressure ? `${pressure.state} (statement p90 ${pressure.p90Ms === null || pressure.p90Ms === undefined ? '-' : Math.round(pressure.p90Ms)}ms, ${num(pressure.failures)} overload failure(s) in 120s)` : 'not measured'}`);
    // The state alone read as a database mislabel on 2026-11-17 (SHEDDING beside a 23 ms p90); the reason says what entered it.
    if (pressure?.state === 'SHEDDING' && pressure.reason) console.log(`    shedding since ${pressure.since ?? '?'}: ${pressure.reason}`);
  }
  const decisions = await db.all<{ at: string; outcome: string; workload_class: string | null; measures: string | null; reason: string | null }>(
    `SELECT at, outcome, workload_class, measures, reason FROM bin_events
      WHERE event_type = 'FREE_LANE_CAPACITY' AND at >= ? ORDER BY at DESC LIMIT 500`,
    [since],
  );
  const counts = new Map<string, number>();
  let maxCpu = 0;
  let maxLoop = 0;
  let maxMachine: number | null = null;
  let maxLag = 0;
  let maxWaiting = 0;
  const dbStates = new Map<string, number>();
  for (const d of decisions) {
    counts.set(d.outcome, (counts.get(d.outcome) ?? 0) + 1);
    const m = parseJson(d.measures);
    maxCpu = Math.max(maxCpu, num(m['cpu'] as number));
    maxLoop = Math.max(maxLoop, num(m['loop'] as number));
    if (m['machine'] !== undefined) maxMachine = Math.max(maxMachine ?? 0, num(m['machine'] as number));
    maxLag = Math.max(maxLag, num(m['lagMs'] as number));
    maxWaiting = Math.max(maxWaiting, num(m['waiting'] as number));
    if (m['db'] !== undefined) dbStates.set(String(m['db']), (dbStates.get(String(m['db'])) ?? 0) + 1);
  }
  const idle = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_IDLE' AND at >= ?`,
    [since],
  );
  console.log(`PRESSURE over ${hours}h (free-lane controller's measured decisions${decisions.length === 500 ? ', newest 500' : ''})`);
  console.log(`  decisions ${decisions.length ? [...counts].map(([k, v]) => `${k.toLowerCase()}=${v}`).join(' ') : 'none'} · peak brain cpu ${Math.round(maxCpu * 100)}% (event loop ${Math.round(maxLoop * 100)}%, machine ${maxMachine === null ? '-' : `${Math.round(maxMachine * 100)}%`}) · peak loop lag ${Math.round(maxLag)}ms · peak waiting items ${maxWaiting} · database ${dbStates.size ? [...dbStates].map(([k, v]) => `${k}=${v}`).join(' ') : '-'} · idle with work queued ~${num(idle?.n) * 10} min`);
  for (const d of decisions.filter((one) => one.outcome === 'SHRINK').slice(0, 5)) {
    console.log(`  shrink ${d.at} ${d.workload_class ?? '?'}: ${String(d.reason ?? '').slice(0, 200)}`);
  }
}

/**
 * Whether research is used (surge readiness W4): the goal's newest accepted
 * claims, each traced from the round and question that asked for it, through
 * what it was stored as, to the plan reading that judged it — or to the point
 * it stopped. Brain records no per-claim retrieval event, so "reached the plan"
 * is read from the rows that carry a claim into it: an opening filed from the
 * claim or its fragment (`cash_opportunities.source_claim_id` / `fragment_id`),
 * a card fact citing it (`cash_card_facts.claim_id`), a construction fact
 * derived from it (`construction_facts.source_claim_id`), and the plan reading's
 * own considered/excluded lists. Retained knowledge is a shared finding
 * (`shared_findings`, §31). Latency is from the claim's acceptance to the
 * goal's next plan evaluation (a scenario run or a reading).
 */
async function traceSection(goalId: string, reading: NonNullable<Awaited<ReturnType<typeof readGoalPlan>>>, since: string, hours: number): Promise<void> {
  const db = getDb();
  const projectId = reading.target.projectId;
  await planInputsSection(goalId, projectId, reading);
  const rounds = await db.all<{ id: string; bucket_id: string; round: number | string; state: string; orchestration_id: string }>(
    `SELECT r.id, r.bucket_id, r.round, r.state, m.orchestration_id FROM cash_discovery_rounds r
       JOIN russell_missions m ON m.candidate_id = r.candidate_id
      WHERE r.project_id = ? AND r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL
      ORDER BY r.opened_at DESC LIMIT 400`,
    [projectId, `goal-${goalId}%`],
  );
  const roundOf = new Map(rounds.map((r) => [r.orchestration_id, r]));
  const orchestrations = [...roundOf.keys()];
  if (orchestrations.length === 0) {
    console.log('  TRACE no research round of this goal has a packet yet');
    return;
  }
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  const claims: { id: string; orchestration_id: string; fragment_id: string | null; claim: string; created_at: string; opportunity_signal: string | null }[] = [];
  for (let i = 0; i < orchestrations.length; i += 200) {
    const chunk = orchestrations.slice(i, i + 200);
    claims.push(
      ...(await db.all<(typeof claims)[number]>(
        // Accepted in the window: by the gate's ruling, not only by when the claim was written (2026-11-18).
        `SELECT c.id, c.orchestration_id, c.fragment_id, c.claim, c.created_at, c.opportunity_signal FROM research_claims c
           LEFT JOIN research_fragments f ON f.id = c.fragment_id
          WHERE c.accepted = 1 AND COALESCE(f.completed_at, c.created_at) >= ? AND c.orchestration_id IN (${marks(chunk.length)})
          ORDER BY c.created_at DESC LIMIT 200`,
        [since, ...chunk],
      )),
    );
  }
  claims.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const window = claims.slice(0, 200);
  if (window.length === 0) {
    console.log(`  TRACE no accepted claim on this goal's research in ${hours}h`);
    return;
  }
  const ids = window.map((c) => c.id);
  const fragmentIds = [...new Set(window.map((c) => c.fragment_id).filter((x): x is string => !!x))];
  const questions = new Map(
    fragmentIds.length
      ? (await db.all<{ id: string; question: string }>(`SELECT id, question FROM research_fragments WHERE id IN (${marks(fragmentIds.length)})`, fragmentIds)).map((f) => [f.id, f.question])
      : [],
  );
  const openings = await db.all<{ id: string; source_claim_id: string | null; fragment_id: string | null; created_at: string }>(
    `SELECT id, source_claim_id, fragment_id, created_at FROM cash_opportunities
      WHERE project_id = ? AND duplicate_of_id IS NULL
        AND (source_claim_id IN (${marks(ids.length)})${fragmentIds.length ? ` OR fragment_id IN (${marks(fragmentIds.length)})` : ''})`,
    [projectId, ...ids, ...fragmentIds],
  );
  const facts = await db.all<{ claim_id: string; opportunity_id: string; field: string }>(
    `SELECT claim_id, opportunity_id, field FROM cash_card_facts WHERE project_id = ? AND claim_id IN (${marks(ids.length)})`,
    [projectId, ...ids],
  );
  const construction = await db.all<{ source_claim_id: string; fact_key: string }>(
    `SELECT source_claim_id, fact_key FROM construction_facts WHERE source_claim_id IN (${marks(ids.length)})`,
    ids,
  );
  const findings = await db.all<{ claim_id: string; state: string }>(
    `SELECT claim_id, state FROM shared_findings WHERE claim_id IN (${marks(ids.length)})`,
    ids,
  );
  const evaluations = [
    ...(await db.all<{ at: string }>('SELECT started_at AS at FROM scenario_runs WHERE project_id = ? AND label = ? AND started_at >= ?', [projectId, `goal ${goalId}`, since])),
    ...(await db.all<{ at: string }>('SELECT created_at AS at FROM goal_plan_readings WHERE workstream_id = ? AND created_at >= ?', [goalId, since])),
  ].map((e) => Date.parse(e.at));
  const considered = new Map(reading.considered.map((one) => [one.opportunityId, one]));
  const excluded = new Map(reading.excluded.map((one) => [one.opportunityId, one]));
  const traces = window.map((c) => {
    const opened = openings.filter((o) => o.source_claim_id === c.id || (c.fragment_id !== null && o.fragment_id === c.fragment_id));
    const cardFacts = facts.filter((f) => f.claim_id === c.id);
    const openingIds = [...new Set([...opened.map((o) => o.id), ...cardFacts.map((f) => f.opportunity_id)])];
    const plan = openingIds.map((id) => {
      const judged = considered.get(id);
      const left = excluded.get(id);
      return { id, where: judged ? (judged.modelled ? 'MODELLED' : 'CONSIDERED') : left ? `EXCLUDED: ${left.reason.slice(0, 60)}` : 'NOT READ' };
    });
    const built = construction.filter((f) => f.source_claim_id === c.id);
    const retained = findings.filter((f) => f.claim_id === c.id);
    const [wait] = waitsUntilNext([Date.parse(c.created_at)], evaluations);
    return { c, openingIds, cardFacts, plan, built, retained, wait: wait ?? null };
  });
  const inPlan = traces.filter((t) => t.plan.some((p) => p.where === 'MODELLED' || p.where === 'CONSIDERED') || t.built.length > 0);
  const stored = traces.filter((t) => t.openingIds.length > 0 || t.built.length > 0);
  const waits = traces.map((t) => t.wait).filter((x): x is number => x !== null);
  const pct = (n: number) => `${Math.round((100 * n) / traces.length)}%`;
  console.log(`  TRACE ${traces.length} newest accepted claim(s) on this goal's research in ${hours}h`);
  console.log(`  trace reach          became an opening, card fact or construction fact ${stored.length} (${pct(stored.length)}) · read by the plan (considered/modelled, or a construction fact) ${inPlan.length} (${pct(inPlan.length)}) · reached nothing ${traces.length - stored.length} · retained as shared findings ${traces.filter((t) => t.retained.some((f) => f.state === 'ACTIVE')).length}`);
  console.log(`  trace latency        claim accepted → next plan evaluation: median ${waits.length ? `${Math.round((percentile(waits, 50) ?? 0) / 6_000) / 10} min` : 'n/a'}, p90 ${waits.length ? `${Math.round((percentile(waits, 90) ?? 0) / 6_000) / 10} min` : 'n/a'} over ${waits.length} claim(s), ${traces.length - waits.length} with no evaluation since`);
  for (const t of traces.slice(0, 8)) {
    const round = roundOf.get(t.c.orchestration_id);
    console.log(`  trace claim ${t.c.id} accepted ${t.c.created_at}${t.wait === null ? ' · no plan evaluation since' : ` · next plan evaluation +${Math.round(t.wait / 6_000) / 10} min`}`);
    console.log(`        round   ${round ? `${round.bucket_id} r${round.round} (${round.state})` : '-'} · question: ${(t.c.fragment_id ? (questions.get(t.c.fragment_id) ?? '-') : '-').replace(/\s+/g, ' ').slice(0, 140)}`);
    console.log(`        answer  ${t.c.claim.replace(/\s+/g, ' ').slice(0, 160)}${t.c.opportunity_signal ? ' [opening signal]' : ''}`);
    console.log(`        reached ${t.plan.length ? t.plan.map((p) => `${p.id} ${p.where}`).join('; ') : 'no opening'}${t.cardFacts.length ? ` · card facts ${t.cardFacts.map((f) => f.field).join(',')}` : ''}${t.built.length ? ` · construction ${t.built.map((f) => f.fact_key).join(',')}` : ''}${t.retained.length ? ` · shared finding ${t.retained.map((f) => f.state).join(',')}` : ''}`);
  }
  console.log(`TRACE_${goalId} claims ${traces.length} stored ${stored.length} in_plan ${inPlan.length} retained ${traces.filter((t) => t.retained.some((f) => f.state === 'ACTIVE')).length} latency_median_ms ${percentile(waits, 50) ?? 'n/a'}`);
}

/**
 * When the plan was last re-derived, and what each of its inputs rested on.
 *
 * A plan reading's `readAt` does not move while its conclusion is unchanged, so
 * it cannot say whether new evidence was considered. The scenario run is the
 * re-derivation itself, and the model it evaluated is stored with every
 * variable's provenance and source (`goalScenario.ts` `variable()`): a CLAIM or
 * CARD_FACT source is research that fed the plan; an ASSUMPTION or UNKNOWN
 * input is one no research fed. Read from the latest run's own stored model,
 * so it is what the plan actually computed on, not what it would compute now.
 */
async function planInputsSection(goalId: string, projectId: string, reading: NonNullable<Awaited<ReturnType<typeof readGoalPlan>>>): Promise<void> {
  const db = getDb();
  const run = await db.get<{ id: string; model_id: string; state: string; started_at: string; finished_at: string | null; elapsed_ms: number | string | null }>(
    `SELECT id, model_id, state, started_at, finished_at, elapsed_ms FROM scenario_runs
      WHERE project_id = ? AND label = ? ORDER BY started_at DESC LIMIT 1`,
    [projectId, `goal ${goalId}`],
  );
  const latest = await db.get<{ created_at: string; verdict: string; scenario_run_id: string | null }>(
    'SELECT created_at, verdict, scenario_run_id FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1',
    [goalId],
  );
  console.log(`  PLAN DERIVATION      latest re-derivation (scenario run) ${run ? `${run.id} started ${run.started_at} ${run.state}${run.elapsed_ms != null ? ` in ${Math.round(num(run.elapsed_ms) / 1000)}s` : ''} (${ageMin(run.started_at)} ago)` : 'none recorded'} · latest stored reading ${latest ? `${latest.created_at} ${latest.verdict} on run ${latest.scenario_run_id ?? '-'}` : 'none'} · this report's reading on run ${reading.scenarioRunId ?? '-'}`);
  if (!run) return;
  const model = await db.get<{ definition_json: string }>('SELECT definition_json FROM scenario_models WHERE id = ?', [run.model_id]);
  const variables = (parseJson(model?.definition_json)['variables'] as { key?: string; label?: string; provenance?: string; controllable?: boolean; sources?: { kind?: string; ref?: string }[] }[] | undefined) ?? [];
  const inputs = variables.filter((v) => !v.controllable);
  const fedBy = (v: (typeof inputs)[number]) => (v.sources ?? []).filter((s) => s.kind === 'CLAIM' || s.kind === 'CARD_FACT');
  const claimRefs = [...new Set(inputs.flatMap((v) => fedBy(v).filter((s) => s.kind === 'CLAIM').map((s) => String(s.ref))))];
  const newer = await db.get<{ n: number | string; newest: string | null }>(
    `SELECT COUNT(*) AS n, MAX(c.created_at) AS newest FROM research_claims c
      WHERE c.accepted = 1 AND c.created_at > ? AND c.orchestration_id IN (
        SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id
         WHERE r.project_id = ? AND r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL)`,
    [run.started_at, projectId, `goal-${goalId}%`],
  );
  const tally = new Map<string, number>();
  for (const v of inputs) {
    const key = fedBy(v).length ? `research-fed (${v.provenance})` : String(v.provenance ?? 'UNKNOWN');
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log(`  PLAN INPUTS          model ${run.model_id}: ${inputs.length} input(s) · ${[...tally].map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'} · distinct claims cited ${claimRefs.length} · accepted goal claims newer than this derivation ${num(newer?.n)}${newer?.newest ? ` (newest ${newer.newest})` : ''}`);
  for (const v of inputs.slice(0, 80)) {
    const fed = fedBy(v);
    const other = (v.sources ?? []).filter((s) => !fed.includes(s));
    const basis = fed.length
      ? fed.map((s) => `${s.kind} ${s.ref}`).join(', ')
      : v.provenance === 'EVIDENCE' || v.provenance === 'HISTORICAL'
        ? `${v.provenance} via ${other.map((s) => `${s.kind} ${String(s.ref).slice(0, 60)}`).join(', ') || 'no source'}`
        : `${v.provenance ?? 'UNKNOWN'}${other.length ? ` (${other.map((s) => `${s.kind} ${String(s.ref).slice(0, 60)}`).join(', ')})` : ''}`;
    console.log(`    input ${String(v.label ?? v.key).replace(/\s+/g, ' ').slice(0, 70).padEnd(70)} ${basis}`);
  }
  if (inputs.length > 80) console.log(`    … ${inputs.length - 80} more input(s)`);
  console.log(`PLAN_DERIVED_${goalId} ${run.started_at} inputs ${inputs.length} research_fed ${inputs.filter((v) => fedBy(v).length).length} claims_cited ${claimRefs.length} newer_claims ${num(newer?.n)}`);
}

/** The free-lane rows that touched the GPU slot or were answered by the GPU, since an instant. */
async function readGpuLaneRows(since: string): Promise<LaneJobRow[]> {
  const rows = await getDb().all<{ at: string; outcome: string; reason: string | null; duration_ms: number | string | null; measures: string | null }>(
    `SELECT at, outcome, reason, duration_ms, measures FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND (reason LIKE 'model runpod/%' OR measures LIKE '%runpod/%')`,
    [since],
  );
  return rows.map((r) => ({
    at: r.at,
    outcome: r.outcome,
    slot: String(r.reason ?? '').replace(/^model /, '').split(':')[0] ?? '',
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    measures: r.measures,
  }));
}

/** The days `GPU CAPACITY` reads back: long enough to hold the last bounded GPU run. */
const CAPACITY_DAYS = 14;

/**
 * `GPU CAPACITY` (§86, §98): what the GPU is, what it costs, when it ran, what it
 * answered per running hour, what moved its slot count, and what research waits
 * for it — from RunPod and Brain's own rows. Read-only.
 */
async function capacitySection(): Promise<void> {
  const db = getDb();
  const since = new Date(Date.now() - CAPACITY_DAYS * 86_400_000).toISOString();
  console.log(`GPU CAPACITY, last ${CAPACITY_DAYS} days`);
  const apiKey = process.env['BRAIN_RUNPOD_API_KEY']?.trim();
  if (apiKey) {
    const account = await accountReading(apiKey);
    console.log(`  account   balance ${account.balance === null ? 'unknown' : `$${account.balance.toFixed(2)}`} · spending ${account.spendPerHour === null ? 'unknown' : `$${account.spendPerHour.toFixed(3)}/h`} · runway ${account.runwayHours === null ? 'n/a (nothing billing)' : `${Math.round(account.runwayHours)} h`}${account.error ? ` · ${account.error.slice(0, 120)}` : ''}`);
    try {
      const res = await fetch('https://api.runpod.io/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query:
            '{ myself { pods { id name desiredStatus costPerHr gpuCount vcpuCount memoryInGb containerDiskInGb lastStatusChange machine { gpuDisplayName } runtime { uptimeInSeconds gpus { id gpuUtilPercent memoryUtilPercent } } } } gpuTypes { displayName memoryInGb } }',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as { data?: { myself?: { pods?: Record<string, unknown>[] }; gpuTypes?: { displayName?: string; memoryInGb?: number }[] } };
      const vram = new Map((body.data?.gpuTypes ?? []).map((g) => [String(g.displayName ?? ''), Number(g.memoryInGb ?? 0)]));
      for (const p of body.data?.myself?.pods ?? []) {
        const gpu = String((p['machine'] as Record<string, unknown> | null)?.['gpuDisplayName'] ?? '?');
        const runtime = p['runtime'] as { uptimeInSeconds?: number; gpus?: { gpuUtilPercent?: number; memoryUtilPercent?: number }[] } | null;
        const util = runtime?.gpus?.map((g) => `util ${g.gpuUtilPercent ?? '?'}% vram ${g.memoryUtilPercent ?? '?'}%`).join(', ');
        console.log(
          `  pod       ${p['id']} ${p['name']} ${p['desiredStatus']} · ${p['gpuCount'] ?? '?'} x ${gpu} (${vram.get(gpu) ?? '?'} GB each) · ${p['vcpuCount'] ?? '?'} vCPU · ${p['memoryInGb'] ?? '?'} GB RAM · $${p['costPerHr'] ?? '?'}/h` +
            ` · ${runtime ? `up ${Math.round((runtime.uptimeInSeconds ?? 0) / 60)} min${util ? ` · ${util}` : ''}` : 'not running (no GPU telemetry)'} · last change ${String(p['lastStatusChange'] ?? '-').slice(0, 90)}`,
        );
      }
    } catch (error) {
      console.log(`  pod       RunPod's pod list unreadable: ${String((error as Error).message).slice(0, 120)}`);
    }
  } else console.log('  account   no BRAIN_RUNPOD_API_KEY: balance and pod hardware unreadable from here');

  const samples = await db.all<{ at: string; outcome: string; duration_ms: number | string | null; measures: string | null }>(
    `SELECT at, outcome, duration_ms, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' AND at >= ? ORDER BY at`,
    [since],
  );
  const days = runningByDay(
    samples.map((s) => {
      const cost = Number(parseJson(s.measures)['costPerHr']);
      return { at: s.at, outcome: s.outcome, durationMs: s.duration_ms === null ? null : Number(s.duration_ms), costPerHr: Number.isFinite(cost) ? cost : null };
    }),
  );
  const jobs = summarizeGpuJobs(await readGpuLaneRows(since));
  for (const d of days) {
    const j = jobs.byDay.get(d.day);
    console.log(
      `  day ${d.day} running ${d.runningHours.toFixed(1)} h · stopped ${d.stoppedHours.toFixed(1)} h · $${d.dollars.toFixed(2)}${d.costPerHr !== null ? ` at $${d.costPerHr}/h` : ''}` +
        ` · GPU answered: submitted ${j?.gpu.submitted ?? 0}, not accepted ${j?.gpu.notAccepted ?? 0} · slot on fallback: submitted ${j?.slotFallback.submitted ?? 0}, not accepted ${j?.slotFallback.notAccepted ?? 0}`,
    );
  }
  const t = gpuThroughput(jobs, days);
  console.log(
    `  throughput ${t.runningHours} h running · ${t.jobsPerRunningHour ?? 'n/a'} GPU jobs/h · ${t.acceptedPerRunningHour ?? 'n/a'} accepted/h · ${t.meanInFlight ?? 'n/a'} in flight on average` +
      ` · accepted ${t.acceptedShare === null ? 'n/a' : `${Math.round(t.acceptedShare * 100)}%`} · $${t.dollars} · ${t.dollarsPerAccepted === null ? 'no accepted GPU job' : `$${t.dollarsPerAccepted} per accepted job`}`,
  );
  console.log(`GPU_THROUGHPUT running_h ${t.runningHours} jobs_per_h ${t.jobsPerRunningHour ?? 'n/a'} accepted_per_h ${t.acceptedPerRunningHour ?? 'n/a'} in_flight ${t.meanInFlight ?? 'n/a'}`);

  // What moved the GPU slot's count, and the highest it reached.
  const decisions = await db.all<{ outcome: string; reason: string | null }>(
    `SELECT outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class LIKE 'runpod/%' AND at >= ?`,
    [since],
  );
  const peak = decisions.reduce((m, d) => Math.max(m, ...[...String(d.reason ?? '').matchAll(/(\d+) -> (\d+)/g)].flatMap((x) => [Number(x[1]), Number(x[2])])), 0);
  console.log(`  slots     highest GPU target ${peak || 'n/a'} over ${decisions.length} decision(s)`);
  for (const [cause, n] of [...shrinkCauses(decisions.map((d) => ({ outcome: d.outcome, reason: String(d.reason ?? '') })))].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(n).padStart(5)} × ${cause}`);
  }

  // What waits, and whether the lane may take it (§84/§85: FREE_LANE_PURPOSES, plus improvement research while active).
  const bins = await db.all<{ purpose: string | null; kind: string; state: string; n: number | string; oldest: string | null; launched: number | string | null }>(
    `SELECT purpose, kind, state, COUNT(*) AS n, MIN(created_at) AS oldest,
            SUM(CASE WHEN orchestration_id IS NOT NULL THEN 1 ELSE 0 END) AS launched
       FROM bins WHERE state IN ('READY', 'LEASED', 'NEEDS_HUMAN') GROUP BY purpose, kind, state`,
  );
  const lanePurposes = new Set<string>(FREE_LANE_PURPOSES);
  for (const b of bins.sort((a, c) => num(c.n) - num(a.n))) {
    console.log(`  bins      ${b.state.padEnd(11)} ${String(b.purpose ?? '(none)').padEnd(18)} ${b.kind.padEnd(22)} ${String(num(b.n)).padStart(5)} · with a mission ${num(b.launched)} · oldest ${ageMin(b.oldest)} · ${lanePurposes.has(String(b.purpose)) ? 'lane may take its research' : 'not the lane\'s purpose'}`);
  }
  const nowIso = new Date().toISOString();
  const items = await db.all<{ work_type: string; purpose: string | null; n: number | string; claimable: number | string | null }>(
    `SELECT work_type, purpose, COUNT(*) AS n, SUM(claimable) AS claimable FROM (
       SELECT w.work_type,
              (SELECT MIN(b.purpose) FROM bins b
                WHERE b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id)) AS purpose,
              CASE WHEN w.available_at <= ? AND w.attempt_count < w.max_attempts THEN 1 ELSE 0 END AS claimable
         FROM work_items w WHERE w.state = 'QUEUED'
     ) q GROUP BY work_type, purpose`,
    [nowIso],
  );
  let admissible = 0;
  for (const i of items.sort((a, c) => num(c.n) - num(a.n))) {
    const research = /^RESEARCH_/.test(i.work_type);
    const lane = research && lanePurposes.has(String(i.purpose));
    if (lane) admissible += num(i.claimable);
    console.log(`  queued    ${i.work_type.padEnd(22)} ${String(i.purpose ?? '(no bin)').padEnd(18)} ${String(num(i.n)).padStart(5)} · claimable ${num(i.claimable)} · ${lane ? 'GPU-suitable (lane research)' : research ? 'research the lane may not take (purpose)' : 'not a research job'}`);
  }
  const launch = await launchableByProject().catch(() => []);
  const ideas = launch.reduce((s, p) => s + p.waiting, 0);
  const cap = launch.reduce((s, p) => s + (p.slots?.cap ?? 0), 0);
  const live = launch.reduce((s, p) => s + (p.slots?.live ?? 0), 0);
  console.log(`  ideas     ${ideas} launchable research idea(s) in ${launch.length} project(s) · research grants hold ${live} live of ${cap} at-once slots · ${launch.filter((p) => p.slots === null).length} project(s) with no grant`);
  for (const p of launch.sort((a, c) => c.waiting - a.waiting).slice(0, 8)) {
    console.log(`    project ${p.projectId} ideas ${p.waiting} · grant ${p.slots ? `${p.slots.live}/${p.slots.cap} live` : 'none'} · free ${p.free}`);
  }
  console.log(`GPU_BACKLOG lane_claimable ${admissible} ideas ${ideas} grant_live ${live} grant_cap ${cap} clear_h ${hoursToClear(admissible, t.acceptedPerRunningHour) ?? 'n/a'}`);
}

/** RunPod's price for Brain's pod, asked live with the Brain's own key; null when there is no key, no pod id or no price. */
async function liveRunpodPrice(): Promise<{ podId: string; status: string; costPerHr: number } | null> {
  const apiKey = process.env['BRAIN_RUNPOD_API_KEY']?.trim();
  if (!apiKey) return null;
  const supervised = podConfig();
  const podId = supervised?.podId || process.env['BRAIN_RUNPOD_POD_ID']?.trim();
  if (podId) {
    const read = await readPod({ apiKey, podId, idleStopMs: 0, vllm: { url: '', key: null } });
    // A stopped pod may report no price; its status still answers "what does it bill now".
    if (read.status !== 'UNKNOWN' && !(read.status === 'RUNNING' && !(read.costPerHr !== null && read.costPerHr > 0))) {
      return { podId, status: read.status, costPerHr: read.costPerHr ?? 0 };
    }
  }
  /*
   * No pod id the Brain is supervising (the GPU disconnected, BRAIN_RUNPOD_MODE=off,
   * 2026-11-16 21:35Z): ask RunPod for the account's own pods, read-only. Bench
   * pods and terminated ones are not Brain's research GPU. One pod is that pod;
   * several are summed over the running ones, so the line is what the account bills.
   */
  try {
    const pods = (await listPods(apiKey)).filter((p) => !p.name?.startsWith(BENCH_PREFIX) && p.desiredStatus !== 'TERMINATED');
    if (pods.length === 0) {
      liveFailure = 'RunPod lists no pod on the account';
      return null;
    }
    const rate = (p: (typeof pods)[number]) => {
      const n = Number(p.adjustedCostPerHr ?? p.costPerHr);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const running = pods.filter((p) => p.desiredStatus === 'RUNNING');
    const shown = running.length > 0 ? running : pods;
    return {
      podId: shown.map((p) => p.id).join('+'),
      status: running.length > 0 ? 'RUNNING' : shown.map((p) => p.desiredStatus ?? 'UNKNOWN').join('+'),
      costPerHr: Math.round(shown.reduce((sum, p) => sum + rate(p), 0) * 1000) / 1000,
    };
  } catch (error) {
    liveFailure = String((error as Error)?.message ?? error).slice(0, 160);
    return null;
  }
}
let liveFailure = '';

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error('RUNPOD-REPORT: FAILED', pooler ?? error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
