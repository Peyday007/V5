/**
 * The owner's hourly operations report (owner, 2026-11-13): "Give me full visibility into how
 * Brain is progressing toward a credible plan to generate $10,000 within 30 days using no more
 * than $3,000 in starting capital … an actionable operating report, not a collection of vague
 * status messages."
 *
 * Pure. Every number comes from `OpsWindow` readings the service takes from existing rows; a
 * value nobody measured is `null` and printed as "not measured" with what would measure it —
 * never estimated. Bottlenecks, scaling calls and the time to a plan are decided by rules over
 * those numbers, so the same rows always give the same report, and a call the rows cannot
 * support says INSUFFICIENT EVIDENCE instead of guessing.
 */

/* ------------------------------------------------------------------------- */
/* What one hour holds                                                        */
/* ------------------------------------------------------------------------- */

export interface QueueReading {
  queued: number;
  running: number;
  blocked: number;
  completed: number;
  failed: number;
  /** Minutes the oldest waiting item has waited; null when nothing waits. */
  oldestWaitMin: number | null;
  avgWaitMin: number | null;
}

export interface PlanReadingFacts {
  goalId: string;
  goalTitle: string;
  readAt: string | null;
  verdict: string | null;
  acceptance: string | null;
  candidate: string | null;
  /** Share of worlds reaching the target, and whether that is a probability or only coverage. */
  reach: number | null;
  reachBasis: string | null;
  lowerBound: number | null;
  required: number | null;
  settledP50: number | null;
  shortfalls: string[];
  binding: string | null;
  targetCents: number | null;
  remainingCents: number | null;
  collectedCents: number | null;
  daysLeft: number | null;
  capitalCeilingCents: number | null;
  nextTest: { test: string; by: string; blocker: string | null } | null;
  personBlockers: string[];
}

export interface OpsWindow {
  start: string;
  end: string;
  hermes: {
    runsStarted: number;
    runsDone: number;
    runsFailed: number;
    models: string[];
    toolCalls: number;
    toolCallsFailed: number;
    toolsByName: Record<string, { ok: number; failed: number }>;
    /** Minutes of finished runs: the time Hermes spent, all of it, from its start and finish. */
    runMinutes: number;
    /** Minutes of runs that failed without one successful Brain tool call: lost to model, context or infrastructure. */
    lostMinutes: number;
    failureReasons: Record<string, number>;
    decisions: number;
    decisionsByKind: Record<string, number>;
    challenged: number;
    actionsExecuted: number;
    commissioned: number;
    reprioritized: number;
    strategyChanges: number;
    outcomesResolved: number;
    outcomesNotResolved: number;
    verifications: number;
    lessons: number;
    goalsInspected: number;
    problemsIdentified: number;
    /** Engineering outcomes Factory reported back (any status but still building). */
    outcomesReceived: number;
    /** Tools that failed two or more times this hour. */
    repeatedToolFailures: Record<string, number>;
  };
  pipeline: {
    opportunitiesDiscovered: number;
    opportunitiesQualified: number;
    researchCompleted: number;
    researchFailed: number;
    strategiesConstructed: number;
    evaluationsCompleted: number;
    evaluationsFailed: number;
    evidenceValidated: number;
    planReadings: number;
    plansAccepted: number;
    /** Opportunities moved to execution or delivery this hour. */
    executionStarted: number;
    leadsPrepared: number;
    repliesReceived: number;
  };
  queues: {
    research: QueueReading;
    coding: QueueReading;
    factoryUnits: QueueReading;
    otherWork: QueueReading;
  };
  factory: {
    campaignsActive: number;
    campaignsBlocked: number;
    campaignsCompleted: number;
    workers: { name: string; modelClass: string; availability: string; maxConcurrency: number; leased: number; rateLimited: boolean }[];
    /** Units waiting, by the model class they require. */
    waitingByClass: Record<string, number>;
  };
  models: {
    researchJobsByModel: Record<string, { done: number; failed: number; avgSeconds: number | null }>;
    cheapCallsByModel: Record<string, { ok: number; failed: number }>;
  };
  money: {
    collectedCents: number;
    spentCents: number;
    spendHeldMicros: number | null;
    spendCeilingMicros: number | null;
  };
  incidents: { kind: string; count: number }[];
  integrationFailures: { integration: string; count: number }[];
}

/* ------------------------------------------------------------------------- */
/* Rules                                                                      */
/* ------------------------------------------------------------------------- */

export interface Bottleneck {
  key: string;
  problem: string;
  evidence: string;
  cause: string;
  affects: string;
  impact: string;
  intervention: string;
  hermesActing: string;
  ownerNeeded: boolean;
  /** Higher first. */
  weight: number;
  /** What resolving it would buy, or why the rows cannot say. */
  estimate: string;
}

const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 1000) / 10}%`);
const usd = (cents: number | null): string => (cents === null ? '—' : Number.isNaN(cents) ? 'n/a' : `$${Math.round(cents / 100).toLocaleString('en-US')}`);

/**
 * The constraints holding a qualifying plan back, strongest first. The plan's own shortfalls are
 * the critical path and always lead; everything else is ranked by how much it holds the work
 * that would clear them.
 */
export function bottlenecks(now: OpsWindow, plan: PlanReadingFacts | null, persistence: Record<string, number> = {}): Bottleneck[] {
  const out: Bottleneck[] = [];
  const h = now.hermes;
  if (plan && plan.acceptance !== 'ACCEPTED') {
    const first = plan.shortfalls[0] ?? 'no plan meets the 90% acceptance bar';
    out.push({
      key: `plan:${(plan.binding ?? first).slice(0, 40)}`,
      problem: `No qualifying plan: ${plan.acceptance ?? 'no reading'}${plan.reach !== null ? `, best candidate reaches the target in ${pct(plan.reach)} of worlds (${plan.reachBasis === 'PROBABILITY' ? 'a probability' : 'coverage, not a probability'})` : ''}.`,
      evidence: `Plan reading ${plan.readAt ?? '—'}: ${plan.shortfalls.slice(0, 3).join('; ') || 'no shortfalls recorded'}.`,
      cause: plan.binding ? `The binding factor is ${plan.binding}.` : first,
      affects: 'Plan acceptance — the whole critical path.',
      impact: `The goal stays at ${usd(plan.collectedCents)} collected of ${usd(plan.targetCents)}.`,
      intervention: plan.binding
        ? `Evidence or construction that moves ${plan.binding}; Brain's reconstruction already ranks it first.`
        : 'Close the first listed shortfall with evidence, not with more candidate plans.',
      hermesActing: h.decisions > 0 || h.commissioned > 0 ? `yes — ${h.decisions} decision(s), ${h.commissioned} commission(s) this hour` : 'no action recorded this hour',
      ownerNeeded: plan.personBlockers.length > 0,
      weight: 100,
      estimate: plan.reachBasis === 'PROBABILITY' && plan.lowerBound !== null && plan.required !== null
        ? `Closing it is worth up to ${pct(plan.required - plan.lowerBound)} of lower bound — the gap to acceptance.`
        : 'Not quantifiable yet: the reach is coverage, so the effect of any one input is unmeasured until it rests on evidence (Brain\'s research priority ranks the inputs by how far they could move the plan).',
    });
  }
  if (h.runsStarted > 0 && h.runsFailed / h.runsStarted >= 0.5) {
    const top = Object.entries(h.failureReasons).sort((a, b) => b[1] - a[1])[0];
    out.push({
      key: `hermes:failing:${top?.[0] ?? 'unknown'}`,
      problem: `Hermes failed ${h.runsFailed} of ${h.runsStarted} run(s).`,
      evidence: `Failure reasons: ${Object.entries(h.failureReasons).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none recorded'}; ${Math.round(h.lostMinutes)} min lost without one successful tool call.`,
      cause: top ? `Mostly ${top[0]}.` : 'Runs end without a recorded reason.',
      affects: 'Every decision, commission and verification Hermes would make.',
      impact: 'The operator does not direct the goal while its runs fail.',
      intervention: top?.[0] === 'model' ? 'Route Hermes to the model with the better tool-call record (model router), or reduce context per run.' : top?.[0] === 'brain' ? "Fix Brain's tool latency under load before adding model capacity." : 'Read the failed runs\' errors and fix the most frequent one.',
      hermesActing: 'the standing director commissions blocking engineering after two failed runs',
      ownerNeeded: false,
      weight: 80,
      estimate: `Recovers ${Math.round(h.lostMinutes)} min of operator time an hour and ${h.runsFailed} run(s) of decisions.`,
    });
  } else if (h.runsDone > 0 && h.actionsExecuted === 0 && h.decisions === 0) {
    out.push({
      key: 'hermes:inactive',
      problem: `Hermes completed ${h.runsDone} run(s) and executed no action.`,
      evidence: `${h.toolCalls} tool call(s), ${h.decisions} decision(s), ${h.actionsExecuted} acting call(s).`,
      cause: 'It read state and changed nothing — either nothing was actionable or its brief did not lead it to act.',
      affects: 'Direction of the goal.',
      impact: 'Thinking without acting does not move the plan.',
      intervention: 'The brief now opens with this report\'s bottlenecks so the next run acts on them.',
      hermesActing: 'no',
      ownerNeeded: false,
      weight: 60,
      estimate: 'Unquantified: an action is worth what its outcome measures, and none was taken.',
    });
  }
  const f = now.queues.factoryUnits;
  const idleWorkers = now.factory.workers.filter((w) => w.availability === 'AVAILABLE' && !w.rateLimited && w.leased < w.maxConcurrency);
  if (f.queued > 0 && (f.oldestWaitMin ?? 0) >= 60) {
    const scheduling = idleWorkers.length > 0;
    out.push({
      key: scheduling ? 'factory:scheduling' : 'factory:capacity',
      problem: `${f.queued} Factory unit(s) waiting, the oldest ${Math.round(f.oldestWaitMin ?? 0)} min.`,
      evidence: `${idleWorkers.length} worker(s) with free slots; waiting by class: ${Object.entries(now.factory.waitingByClass).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}.`,
      cause: scheduling ? 'Work waits beside free workers: routing or eligibility, not capacity.' : 'Every capable worker is busy, paused or rate-limited.',
      affects: 'Engineering Hermes commissions, and anything waiting on it.',
      impact: 'Fixes reach production later.',
      intervention: scheduling ? 'Fix the routing or eligibility rule that refuses the free workers; more workers would not help.' : 'One more worker of the scarce class, tested on the waiting units first.',
      hermesActing: now.hermes.reprioritized > 0 ? `reprioritized ${now.hermes.reprioritized} time(s)` : 'no',
      ownerNeeded: false,
      weight: 50,
      estimate: `Up to ${f.queued} unit(s) started ${Math.round(f.oldestWaitMin ?? 0)} min sooner.`,
    });
  }
  const r = now.queues.research;
  if (r.failed > 0 && r.failed >= r.completed) {
    out.push({
      key: 'research:failing',
      problem: `Research failed ${r.failed} time(s) against ${r.completed} completed.`,
      evidence: `Research queue: ${r.queued} waiting (oldest ${r.oldestWaitMin === null ? '—' : `${Math.round(r.oldestWaitMin)} min`}).`,
      cause: 'Failures outnumber completions: the work is not producing evidence.',
      affects: 'Evidence the plan needs to be accepted.',
      impact: 'Acceptance cannot rise without evidence.',
      intervention: 'Read the failure categories and repair the commonest before adding research capacity.',
      hermesActing: 'see decisions',
      ownerNeeded: false,
      weight: 40,
      estimate: `Up to ${r.failed} more evidence item(s) an hour at the current attempt rate.`,
    });
  } else if (r.queued > 0 && (r.oldestWaitMin ?? 0) >= 120 && r.running === 0) {
    out.push({
      key: 'research:stalled',
      problem: `${r.queued} research item(s) waiting with none running, the oldest ${Math.round(r.oldestWaitMin ?? 0)} min.`,
      evidence: `Completed ${r.completed}, failed ${r.failed} this hour.`,
      cause: 'No research surface is taking work.',
      affects: 'Evidence for the plan.',
      impact: 'Acceptance cannot rise without evidence.',
      intervention: 'Continue idle capacity (brain_operator_continue_idle); check the fleet accounts are not refused.',
      hermesActing: now.hermes.toolsByName['brain_operator_continue_idle'] ? 'yes, continued idle capacity' : 'no',
      ownerNeeded: false,
      weight: 35,
      estimate: `${r.queued} research item(s) started instead of waiting.`,
    });
  }
  for (const i of now.integrationFailures.filter((x) => x.count >= 3)) {
    out.push({
      key: `integration:${i.integration}`,
      problem: `${i.integration} failed ${i.count} time(s) this hour.`,
      evidence: 'integration_events rows.',
      cause: 'An integration Brain depends on is refusing or unreachable.',
      affects: `Work that uses ${i.integration}.`,
      impact: 'Stalls whichever stage depends on it.',
      intervention: `Check ${i.integration}'s credential and health probe.`,
      hermesActing: 'see brain_operator_integrations',
      ownerNeeded: false,
      weight: 30,
      estimate: `${i.count} failed call(s) an hour avoided.`,
    });
  }
  // A bottleneck that survived three or more reports: the diagnosis, not just the fix, is suspect.
  for (const b of out) {
    const seen = persistence[b.key] ?? 0;
    if (seen >= 3) b.intervention = `Survived ${seen} reports unchanged — reconsider the diagnosis rather than repeating it. ${b.intervention}`;
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}

export type Call = 'YES' | 'NO' | 'INSUFFICIENT EVIDENCE';
export interface ScalingCall {
  call: Call;
  why: string;
}

/** The five scaling questions, answered only as far as the rows allow. */
export function scalingDecisions(now: OpsWindow, plan: PlanReadingFacts | null): Record<'agents' | 'model' | 'gpu' | 'research' | 'capital', ScalingCall> {
  const f = now.queues.factoryUnits;
  const workers = now.factory.workers.filter((w) => w.availability === 'AVAILABLE');
  const free = workers.filter((w) => !w.rateLimited && w.leased < w.maxConcurrency).length;
  const agents: ScalingCall =
    f.queued === 0
      ? { call: 'NO', why: 'No Factory work is waiting; another agent would idle.' }
      : free > 0
        ? { call: 'NO', why: `${f.queued} unit(s) wait beside ${free} worker(s) with free slots — the limit is routing or eligibility, not agents.` }
        : (f.oldestWaitMin ?? 0) >= 60
          ? { call: 'YES', why: `Resource: one coding worker of class ${Object.entries(now.factory.waitingByClass).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'ANY'}. Why: ${f.queued} unit(s) waiting ${Math.round(f.oldestWaitMin ?? 0)} min with all ${workers.length} worker(s) saturated (${workers.reduce((s, w) => s + w.leased, 0)}/${workers.reduce((s, w) => s + w.maxConcurrency, 0)} slots leased). Expected: the waiting units start up to ${Math.round(f.oldestWaitMin ?? 0)} min sooner. Cost: one account's subscription — not recorded in Brain, so unquantified here. Confidence: medium (queue age is measured; unit duration is not). Smallest test: one worker of that class for one day, measured on these units' wait.` }
          : { call: 'INSUFFICIENT EVIDENCE', why: 'Workers are saturated but the queue is under an hour old.' };
  const h = now.hermes;
  const modelFailures = (h.failureReasons['model'] ?? 0) + (h.failureReasons['context'] ?? 0);
  const model: ScalingCall =
    h.runsStarted === 0
      ? { call: 'INSUFFICIENT EVIDENCE', why: 'Hermes did not run this hour.' }
      : modelFailures >= 2 && modelFailures >= h.runsFailed / 2
        ? { call: 'YES', why: `Resource: the next model up in Hermes' router. Why: ${modelFailures} of ${h.runsFailed} failed run(s) failed on the model itself (context or malformed tool calls; rate limits are availability and not counted). Capacity: ${h.runsStarted} run(s), ${h.toolCalls - h.toolCallsFailed}/${h.toolCalls} tool calls ok. Expected: those runs complete and act. Cost: router pricing per run — not recorded per call in Brain. Confidence: low-medium. Smallest test: route the next three runs to the stronger model and compare tool-call success.` }
        : h.runsFailed > 0
          ? { call: 'NO', why: `Hermes' failures are ${Object.keys(h.failureReasons).join(', ') || 'unrecorded'}, not the model's reasoning; a stronger model would fail the same way.` }
          : { call: 'NO', why: `${h.runsDone} run(s) completed with ${h.toolCalls - h.toolCallsFailed}/${h.toolCalls} tool calls succeeding; the plan's shortfall is evidence, not reasoning.` };
  const cheap = Object.values(now.models.cheapCallsByModel).reduce((s, x) => ({ ok: s.ok + x.ok, failed: s.failed + x.failed }), { ok: 0, failed: 0 });
  const gpu: ScalingCall =
    cheap.ok + cheap.failed === 0
      ? { call: 'INSUFFICIENT EVIDENCE', why: 'No cheap-lane (GPU) calls were recorded this hour, so its saturation is unmeasured.' }
      : { call: 'NO', why: `The GPU lane served ${cheap.ok + cheap.failed} call(s) (${cheap.failed} failed); nothing in the rows shows work waiting on it.` };
  const r = now.queues.research;
  const evidenceShort = (plan?.shortfalls ?? []).some((s) => /evidence|probability|coverage|unknown|measured/i.test(s));
  const research: ScalingCall =
    !evidenceShort
      ? { call: 'NO', why: "The plan's shortfalls are not evidence shortfalls." }
      : r.queued > 0 && r.running > 0 && (r.oldestWaitMin ?? 0) >= 60
        ? { call: 'YES', why: `Resource: one more research surface (a Claude routine account). Why: evidence is the binding shortfall and ${r.queued} item(s) have waited up to ${Math.round(r.oldestWaitMin ?? 0)} min behind ${r.running} running. Expected: those items start sooner and the plan's evidence arrives earlier. Cost: one account's subscription — not recorded in Brain. Confidence: medium. Smallest test: one more surface for a day, measured by fragments accepted.` }
        : r.failed >= r.completed && r.failed > 0
          ? { call: 'NO', why: 'Research is failing more than completing; more of it would fail the same way.' }
          : { call: 'NO', why: `Research is not queueing (${r.queued} waiting, ${r.running} running): capacity is not the limit.` };
  const capitalShort = plan?.binding?.toLowerCase().includes('capital') || (plan?.shortfalls ?? []).some((s) => /capital/i.test(s));
  const capital: ScalingCall = capitalShort
    ? { call: 'INSUFFICIENT EVIDENCE', why: `The plan names capital as a constraint, but the $3,000 limit is yours; Brain will not propose exceeding it without a plan that clears acceptance at the higher figure.` }
    : { call: 'NO', why: 'Capital is not a binding shortfall in the latest plan reading; more money would not move acceptance.' };
  return { agents, model, gpu, research, capital };
}

/**
 * When a qualifying plan might arrive. Only from a reach that is a probability and is rising
 * across readings; anything else is an unknown with its reason.
 */
export function timeToPlan(history: { at: string; reach: number | null; basis: string | null; lowerBound: number | null }[], required: number | null): { eta: string | null; why: string } {
  const prob = history.filter((h) => h.basis === 'PROBABILITY' && h.lowerBound !== null);
  if (required === null) return { eta: null, why: 'No acceptance bar recorded on the plan.' };
  if (prob.length < 2) {
    return {
      eta: null,
      why: 'Cannot be estimated: the plan has no repeated reading whose reach is a probability (its reach is coverage of assumed inputs). What would resolve it: measured conversion and price evidence for the leading combination, which turns coverage into a probability; Brain\'s research and the operator are directed at that shortfall.',
    };
  }
  const first = prob[0]!;
  const last = prob[prob.length - 1]!;
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000;
  const gain = (last.lowerBound ?? 0) - (first.lowerBound ?? 0);
  if (hours <= 0 || gain <= 0) {
    return { eta: null, why: `Cannot be estimated: the lower bound has not risen over ${Math.round(hours)} h of probability readings (${pct(first.lowerBound)} → ${pct(last.lowerBound)}). The trend, not more plans, is what would make an ETA meaningful.` };
  }
  const remaining = required - (last.lowerBound ?? 0);
  const etaHours = remaining / (gain / hours);
  return { eta: `~${Math.round(etaHours)} h at the last ${Math.round(hours)} h's rate`, why: `Lower bound ${pct(first.lowerBound)} → ${pct(last.lowerBound)}; ${pct(remaining)} to go. A rate, not a promise: it assumes the evidence keeps arriving as it has.` };
}

/* ------------------------------------------------------------------------- */
/* The report                                                                 */
/* ------------------------------------------------------------------------- */

export interface ReportInput {
  hourEnding: string;
  now: OpsWindow;
  /** The hour before, from its own recorded report when there is one; null when nothing measured it. */
  prev: OpsWindow | null;
  /** Per-hour averages of the pipeline over the earlier reports recorded in the last day. */
  baseline: { hours: number; pipeline: OpsWindow['pipeline'] } | null;
  /** Measurements that could not be read for this report (shown as n/a, never as zero). */
  partial: string[];
  /** Set when the report was produced after its hour, recovering a missed one. */
  recoveredAt?: string | null;
  plan: PlanReadingFacts | null;
  planPrev: PlanReadingFacts | null;
  planHistory: { at: string; reach: number | null; basis: string | null; lowerBound: number | null }[];
  hermesSummary: string | null;
  openEngineering: { title: string; status: string }[];
  persistence: Record<string, number>;
  /** The previous report's bottleneck keys, to say which were resolved and which persist. */
  lastKeys: string[];
  ownerOpportunities: string[];
  unmeasured: string[];
}

/** A measured number, or n/a when it could not be read — never a zero standing in for one. */
const num = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? 'n/a' : String(n));
const delta = (a: number, b: number | null | undefined): string => {
  if (Number.isNaN(a)) return 'n/a';
  if (b === null || b === undefined || Number.isNaN(b)) return `${a} (no previous hour measured)`;
  return a === b ? `${a} (=)` : `${a} (${a > b ? '+' : ''}${a - b})`;
};
const perHour = (n: number | undefined): string => (n === undefined || Number.isNaN(n) ? 'n/a' : (Math.round(n * 10) / 10).toString());

function queueLine(name: string, q: QueueReading, p: QueueReading | undefined): string {
  return `${name}: done ${delta(q.completed, p?.completed)}, failed ${num(q.failed)}, running ${q.running}, queued ${q.queued}, blocked ${q.blocked}, oldest wait ${q.oldestWaitMin === null ? '—' : `${Math.round(q.oldestWaitMin)} min`}, average ${q.avgWaitMin === null ? '—' : `${Math.round(q.avgWaitMin)} min`}`;
}

export function renderReport(r: ReportInput): { subject: string; text: string; bottleneckKeys: string[] } {
  const { now, prev, baseline, plan } = r;
  const h = now.hermes;
  const top = bottlenecks(now, plan, r.persistence);
  const scale = scalingDecisions(now, plan);
  const eta = timeToPlan(r.planHistory, plan?.required ?? null);
  const accepted = plan?.acceptance === 'ACCEPTED';
  const reachMoved = plan && r.planPrev && plan.reach !== null && r.planPrev.reach !== null && plan.reach !== r.planPrev.reach;
  const improvement = reachMoved
    ? `Best plan reach ${pct(r.planPrev!.reach)} → ${pct(plan!.reach)}.`
    : h.outcomesResolved > 0
      ? `${h.outcomesResolved} engineering change(s) measured as improvements.`
      : prev && now.pipeline.researchCompleted > prev.pipeline.researchCompleted
        ? `Research completed ${now.pipeline.researchCompleted} (previous hour ${prev.pipeline.researchCompleted}).`
        : 'None measured this hour.';
  const why = !reachMoved && !accepted
    ? ` Plan reach did not move because ${plan?.binding ? `its binding factor (${plan.binding}) received no new evidence` : (plan?.shortfalls[0] ?? 'no new plan reading was taken')}.`
    : '';
  const L: string[] = [];
  L.push('BRAIN — $10K PLAN OPERATIONS REPORT', `Hour ending: ${r.hourEnding}`);
  if (r.partial.length) L.push(`PARTIAL REPORT — not readable this hour: ${r.partial.join('; ')}. Those figures show as n/a, never as zero.`);
  if (r.recoveredAt) L.push(`Recovered at ${r.recoveredAt} after the hour was missed; queue and worker snapshots are as of then.`);
  L.push('');
  // The first section is the elimination of bottlenecks (owner, 2026-11-13): what limits the plan,
  // what was removed, what is being worked on now, and what Hermes started by itself.
  const eliminated = r.lastKeys.filter((k) => !top.some((b) => b.key === k));
  const running = r.openEngineering.filter((e) => !['RESOLVED', 'NOT_RESOLVED', 'CANCELLED'].includes(e.status));
  const q = now.queues;
  const yes = (Object.entries({ agents: scale.agents, 'stronger model': scale.model, compute: scale.gpu, research: scale.research, capital: scale.capital }) as [string, { call: string }][])
    .filter(([, v]) => v.call === 'YES').map(([k]) => k);
  L.push('$10K PLAN — ACTIVE BOTTLENECK ELIMINATION');
  L.push(`Plan readiness: ${accepted ? 'QUALIFYING PLAN EXISTS' : `not qualified — ${plan?.acceptance ?? 'no plan reading'}${plan?.reach !== null && plan?.reach !== undefined ? `, best reach ${pct(plan.reach)} (${plan.reachBasis === 'PROBABILITY' ? 'probability' : 'coverage'}; needs ${pct(plan.required)} lower bound)` : ''}`}`);
  L.push(`Main remaining constraint: ${top[0] ? `${top[0].problem} — ${top[0].intervention}` : 'none identified from the rows'}`);
  L.push(`Constraints eliminated this hour: ${eliminated.length ? eliminated.join(', ') : 'none'}.`);
  L.push(`Work being performed right now: research ${num(q.research.running)} running / ${num(q.research.queued)} queued; Factory ${num(q.factoryUnits.running)} unit(s) running / ${num(q.factoryUnits.queued)} queued; coding agents ${num(q.coding.running)} running.`);
  L.push(`Independent fixes running simultaneously: ${running.length ? running.map((e) => `${e.title} (${e.status})`).join('; ') : 'none open'}.`);
  L.push(`Resource or intelligence bottlenecks: ${top.slice(1).map((b) => b.problem).join(' | ') || 'none beyond the main constraint'}.`);
  L.push(`Initiated by Hermes without being asked: ${num(h.commissioned)} engineering commission(s), ${num(h.actionsExecuted)} action(s) executed, ${num(h.reprioritized)} reprioritization(s), ${num(h.strategyChanges)} strategy change(s).`);
  L.push(`What actually improved: ${improvement}${why}`);
  L.push(`Would agents, compute or capital accelerate it: ${yes.length ? `YES — ${yes.join(', ')} (see SCALING DECISIONS)` : 'no measured case this hour (see SCALING DECISIONS)'}.`);
  L.push(`Remaining time to a qualifying plan: ${eta.eta ?? 'not defensibly estimable'} — ${eta.why}`);
  L.push(`Collected ${usd(plan?.collectedCents ?? now.money.collectedCents)} of ${usd(plan?.targetCents ?? null)} (expected revenue is not collected revenue); ${plan?.daysLeft ?? '—'} days left.`);
  L.push('');
  L.push('$10K PLAN DEVELOPMENT');
  if (plan) {
    L.push(`Qualifying plan: ${accepted ? 'YES' : 'NO'} (${plan.verdict ?? '—'}). Best evidence-backed candidate: ${plan.candidate ?? 'none'}.`);
    L.push(`Expected settled (median, not collected): ${plan.settledP50 === null ? '—' : `$${Math.round(plan.settledP50).toLocaleString('en-US')}`}; collected ${usd(plan.collectedCents)}; remaining ${usd(plan.remainingCents)}; deadline in ${plan.daysLeft ?? '—'} days; starting-capital limit ${usd(plan.capitalCeilingCents !== null ? Math.min(plan.capitalCeilingCents, 300_000) : 300_000)}.`);
    L.push(`Confidence: reach ${pct(plan.reach)} as ${plan.reachBasis === 'PROBABILITY' ? 'a probability' : 'coverage of assumed inputs, not a probability'}${plan.lowerBound !== null ? `, lower bound ${pct(plan.lowerBound)}` : ''}; required ${pct(plan.required)}.`);
    L.push(`Failed acceptance conditions: ${plan.shortfalls.length ? plan.shortfalls.slice(0, 5).join(' | ') : 'none recorded'}.`);
    L.push(`Since last report: ${r.planPrev ? `reach ${pct(r.planPrev.reach)} → ${pct(plan.reach)}, verdict ${r.planPrev.verdict ?? '—'} → ${plan.verdict ?? '—'}` : 'no earlier reading'}.`);
    L.push(`Next action for acceptance: ${plan.nextTest ? `${plan.nextTest.test} (${plan.nextTest.by}${plan.nextTest.blocker ? `: ${plan.nextTest.blocker}` : ''})` : 'none recorded'}.`);
  } else L.push('No plan reading exists for the goal.');
  const p = now.pipeline;
  const pp = prev?.pipeline;
  const b = baseline?.pipeline;
  L.push(`Pipeline (this hour, vs previous; [per-hour baseline over ${baseline ? `${baseline.hours} earlier report(s)` : 'no earlier reports yet'}]): discovered ${delta(p.opportunitiesDiscovered, pp?.opportunitiesDiscovered)} [${perHour(b?.opportunitiesDiscovered)}] → qualified ${delta(p.opportunitiesQualified, pp?.opportunitiesQualified)} [${perHour(b?.opportunitiesQualified)}] → research done ${delta(p.researchCompleted, pp?.researchCompleted)} [${perHour(b?.researchCompleted)}] (failed ${p.researchFailed}) → strategies constructed ${delta(p.strategiesConstructed, pp?.strategiesConstructed)} → economic evaluations ${delta(p.evaluationsCompleted, pp?.evaluationsCompleted)} (failed ${p.evaluationsFailed}) → evidence validated ${delta(p.evidenceValidated, pp?.evidenceValidated)} → plans accepted ${p.plansAccepted}.`);
  L.push('');
  L.push('HERMES PERFORMANCE');
  L.push(`Runs / actions / real outcomes: ${h.runsStarted} started, ${h.runsDone} done, ${h.runsFailed} failed / ${h.actionsExecuted} executed / ${h.outcomesResolved} improved (A thought: ${h.runsDone} runs → B decided: ${h.decisions} (${h.challenged} challenged) → C executed: ${h.actionsExecuted} → D improved: ${h.outcomesResolved}).`);
  L.push(`Models: ${h.models.join(', ') || '—'}. Tool calls ${h.toolCalls - h.toolCallsFailed} ok / ${h.toolCallsFailed} failed. Time: ${Math.round(h.runMinutes)} min in runs, ${Math.round(h.lostMinutes)} min lost to failures (${Object.entries(h.failureReasons).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}); reasoning vs executing time is not instrumented per call.`);
  L.push(`Goals inspected ${h.goalsInspected}; problems identified ${h.problemsIdentified}; improvements received from Factory ${h.outcomesReceived}; repeated failures: ${Object.entries(h.repeatedToolFailures).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}.`);
  L.push(`Decisions by kind: ${Object.entries(h.decisionsByKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. Commissioned ${h.commissioned}, reprioritized ${h.reprioritized}, strategy changes ${h.strategyChanges}, verifications ${h.verifications}, lessons ${h.lessons}.`);
  L.push(`What Hermes improved: ${h.outcomesResolved > 0 ? `${h.outcomesResolved} engineering change(s) measured as improved` : 'nothing measured as improved this hour'}.`);
  L.push(`What Hermes failed to accomplish: ${h.outcomesNotResolved > 0 ? `${h.outcomesNotResolved} change(s) delivered without effect` : h.runsFailed > 0 ? `${h.runsFailed} run(s) ended without acting` : 'nothing recorded'}.`);
  L.push(`Why: ${h.runsFailed > 0 ? Object.entries(h.failureReasons).map(([k, v]) => `${k} ×${v}`).join(', ') : h.actionsExecuted === 0 ? 'it acted on nothing this hour' : 'see decisions above'}.`);
  L.push(`Last run summary: ${(r.hermesSummary ?? 'none').replace(/\s+/g, ' ').slice(0, 400)}`);
  L.push('');
  L.push('PIPELINE PERFORMANCE');
  L.push(`Discovery: ${p.opportunitiesDiscovered} discovered, ${p.opportunitiesQualified} qualified.`);
  L.push(queueLine('Research', now.queues.research, prev?.queues.research));
  L.push(`Planning: ${p.evaluationsCompleted} evaluation(s), ${p.planReadings} plan reading(s).`);
  L.push(`Validation: ${p.evidenceValidated} evidence item(s) validated; commercial validation: ${p.opportunitiesQualified} opportunit(ies) reached READY or beyond.`);
  L.push(`Execution: ${p.executionStarted} opportunit(ies) moved into execution; collected ${usd(now.money.collectedCents)}; spent ${usd(now.money.spentCents)}.`);
  L.push(`Customer acquisition: ${delta(p.leadsPrepared, pp?.leadsPrepared)} lead(s) prepared, ${delta(p.repliesReceived, pp?.repliesReceived)} repl(ies) received.`);
  L.push(`Goal-advancing this hour: ${p.evidenceValidated} evidence validated, ${p.plansAccepted} plan(s) accepted, ${usd(now.money.collectedCents)} collected${reachMoved ? ', plan reach moved' : ', plan reach unchanged'}. Activity without goal effect: ${h.runsFailed} failed run(s), ${h.toolCallsFailed} failed tool call(s), ${p.researchFailed} failed research, ${p.evaluationsFailed} failed evaluation(s).`);
  L.push(queueLine('Factory', now.queues.factoryUnits, prev?.queues.factoryUnits) + `; campaigns active ${now.factory.campaignsActive}, blocked ${now.factory.campaignsBlocked}, completed ${now.factory.campaignsCompleted}`);
  L.push(queueLine('Coding agents', now.queues.coding, prev?.queues.coding));
  L.push(queueLine('Other Brain work', now.queues.otherWork, prev?.queues.otherWork));
  L.push('');
  L.push('RESOURCE UTILIZATION');
  L.push(`Models: ${Object.entries(now.models.researchJobsByModel).map(([m, v]) => `${m} ${v.done} done/${v.failed} failed${v.avgSeconds !== null ? ` ~${Math.round(v.avgSeconds)}s` : ''}`).join('; ') || 'no research model jobs'}.`);
  L.push(`GPU (cheap lane): ${Object.entries(now.models.cheapCallsByModel).map(([m, v]) => `${m} ${v.ok} ok/${v.failed} failed`).join('; ') || 'no calls recorded'}.`);
  L.push(`Factory workers: ${now.factory.workers.map((w) => `${w.name} [${w.modelClass}] ${w.leased}/${w.maxConcurrency}${w.availability !== 'AVAILABLE' ? ` ${w.availability}` : ''}${w.rateLimited ? ' rate-limited' : ''}`).join('; ') || 'none registered'}.`);
  L.push(`Research capacity: ${now.queues.research.running} running, ${now.queues.research.queued} queued.`);
  L.push(`Budget: ${now.money.spendCeilingMicros === null ? 'no spend ceiling recorded' : `held $${((now.money.spendHeldMicros ?? 0) / 1e6).toFixed(2)} of $${(now.money.spendCeilingMicros / 1e6).toFixed(2)} this period`}.`);
  L.push(`Idle or constrained: ${now.factory.workers.filter((w) => w.availability === 'AVAILABLE' && w.leased === 0).map((w) => `${w.name} idle`).concat(now.factory.workers.filter((w) => w.rateLimited || w.availability !== 'AVAILABLE').map((w) => `${w.name} unavailable`)).join('; ') || 'none'}. Incidents: ${now.incidents.map((i) => `${i.kind} ×${i.count}`).join(', ') || 'none'}.`);
  L.push('');
  L.push('MODEL ADEQUACY');
  const research = Object.values(now.models.researchJobsByModel).reduce((s, x) => ({ done: s.done + x.done, failed: s.failed + x.failed }), { done: 0, failed: 0 });
  const cheapAll = Object.values(now.models.cheapCallsByModel).reduce((s, x) => ({ ok: s.ok + x.ok, failed: s.failed + x.failed }), { ok: 0, failed: 0 });
  L.push(`Tool-call reliability (Hermes): ${h.toolCalls ? pct((h.toolCalls - h.toolCallsFailed) / h.toolCalls) : '—'} of ${h.toolCalls}. Context failures: ${h.failureReasons['context'] ?? 0}; rate limits: ${h.failureReasons['rate_limit'] ?? 0}; other model errors: ${h.failureReasons['model'] ?? 0}.`);
  L.push(`Task completion: research jobs ${research.done} done / ${research.failed} failed; research fragments accepted ${p.evidenceValidated} vs rejected ${p.researchFailed}; cheap lane ${cheapAll.ok} ok / ${cheapAll.failed} failed. Latency: ${Object.entries(now.models.researchJobsByModel).filter(([, v]) => v.avgSeconds !== null).map(([m, v]) => `${m} ~${Math.round(v.avgSeconds!)}s`).join(', ') || 'not recorded this hour'}.`);
  L.push(`Reasoning errors: not instrumented separately from failed tasks. Tokens and cost: not instrumented per call. Availability: ${now.integrationFailures.map((i) => `${i.integration} failed ${i.count}×`).join(', ') || 'no integration failures recorded'}.`);
  L.push(`Stronger model? ${scale.model.call} — ${scale.model.why}`);
  L.push(`Cheaper model? ${cheapAll.ok > 0 && cheapAll.failed / Math.max(1, cheapAll.ok + cheapAll.failed) < 0.05 ? `the cheap lane completes ${pct(cheapAll.ok / (cheapAll.ok + cheapAll.failed))} of its calls; repeated reading and classification already run there` : 'insufficient evidence this hour'}.`);
  L.push('');
  L.push('ENGINEERING CAPACITY');
  const fq = now.queues.factoryUnits;
  const allWorkers = now.factory.workers.filter((w) => w.availability === 'AVAILABLE');
  const freeSlots = allWorkers.reduce((s, w) => s + (w.rateLimited ? 0 : Math.max(0, w.maxConcurrency - w.leased)), 0);
  const scarce = Object.entries(now.factory.waitingByClass).filter(([cls]) => !allWorkers.some((w) => (w.modelClass === cls || cls === 'ANY') && !w.rateLimited && w.leased < w.maxConcurrency)).map(([cls, n]) => `${cls} (${n} waiting, no free worker)`);
  L.push(`Eligible work waiting: ${fq.queued} unit(s), oldest ${fq.oldestWaitMin === null ? '—' : `${Math.round(fq.oldestWaitMin)} min`}; running ${fq.running}; blocked ${fq.blocked}.`);
  L.push(`Scarce capabilities: ${scarce.join(', ') || 'none'}. Underutilized: ${allWorkers.filter((w) => w.leased === 0 && !w.rateLimited).map((w) => w.name).join(', ') || 'none'} (${freeSlots} free slot(s)).`);
  L.push(`Routing: ${fq.queued > 0 && freeSlots > 0 ? 'work waits beside free slots — routing or eligibility is refusing them; scheduling is the inefficiency, not capacity' : fq.queued > 0 ? 'every eligible worker is busy; routing is not the cause' : 'nothing waiting'}.`);
  L.push(`More parallel workers: ${scale.agents.call} — ${scale.agents.why} Dividing work differently: not measurable from the rows (unit sizes are not recorded against durations). Claude Code capacity as the limit: ${allWorkers.some((w) => w.modelClass === 'STRONGEST') ? (allWorkers.filter((w) => w.modelClass === 'STRONGEST').every((w) => w.leased >= w.maxConcurrency) && (now.factory.waitingByClass['STRONGEST'] ?? 0) > 0 ? 'yes — STRONGEST workers are full with STRONGEST work waiting' : 'no — STRONGEST workers have room or nothing STRONGEST waits') : 'no STRONGEST worker registered'}. Cheaper agents: ${(now.factory.waitingByClass['FAST'] ?? 0) > 0 ? `${now.factory.waitingByClass['FAST']} FAST unit(s) wait and could go to cheaper agents` : 'no FAST work waiting for them'}.`);
  L.push('');
  L.push('INTERVENTION TRACKING');
  const nowKeys = new Set(top.map((b) => b.key));
  const resolved = r.lastKeys.filter((k) => !nowKeys.has(k));
  const persisting = r.lastKeys.filter((k) => nowKeys.has(k));
  L.push(`Since the last report: resolved ${resolved.length ? resolved.join(', ') : 'none'}; persisting ${persisting.length ? persisting.map((k) => `${k} (${r.persistence[k] ?? 1} report(s))`).join(', ') : 'none'}; new ${top.filter((b) => !r.lastKeys.includes(b.key)).map((b) => b.key).join(', ') || 'none'}.`);
  L.push('');
  L.push('TOP 3 BOTTLENECKS');
  if (!top.length) L.push('None the rows identify.');
  top.forEach((b, i) => {
    L.push(`${i + 1}. ${b.problem} → Cause: ${b.cause} → Evidence: ${b.evidence} → Impact: ${b.impact} Affects: ${b.affects} → Best intervention: ${b.intervention} → Estimated improvement: ${b.estimate} (Hermes acting: ${b.hermesActing}; owner needed: ${b.ownerNeeded ? 'yes' : 'no'})`);
  });
  L.push('');
  L.push('SCALING DECISIONS');
  L.push(`MORE AGENTS: ${scale.agents.call} — ${scale.agents.why}`);
  L.push(`STRONGER MODEL: ${scale.model.call} — ${scale.model.why}`);
  L.push(`MORE GPU CAPACITY: ${scale.gpu.call} — ${scale.gpu.why}`);
  L.push(`MORE RESEARCH CAPACITY: ${scale.research.call} — ${scale.research.why}`);
  L.push(`MORE FINANCIAL CAPITAL: ${scale.capital.call} — ${scale.capital.why}`);
  L.push(`Critical path / resources first: ${top[0] ? top[0].intervention : 'the plan\'s first shortfall'}`);
  L.push('');
  L.push("HERMES' NEXT ACTIONS");
  L.push(`What it will do: act on bottleneck 1${top[1] ? ' then 2' : ''} (this report is in its next brief); open engineering: ${r.openEngineering.map((e) => `${e.title} [${e.status}]`).join('; ') || 'none'}.`);
  L.push(`What it expects to change: ${top[0] ? top[0].cause : '—'}`);
  L.push(`How success will be measured: the next report's plan reach and failed-condition list, and whether bottleneck 1 is still present.`);
  L.push('');
  L.push('OWNER OPPORTUNITIES');
  L.push(r.ownerOpportunities.length ? r.ownerOpportunities.map((o) => `- ${o}`).join('\n') : 'NONE.');
  if (r.unmeasured.length) {
    L.push('');
    L.push(`Not instrumented (stated, not estimated): ${r.unmeasured.join('; ')}.`);
  }
  const subject = `BRAIN — $10K PLAN OPERATIONS REPORT — ${r.hourEnding}`;
  // A number that could not be read is NaN through the arithmetic above; it reads as n/a.
  return { subject, text: L.join('\n').replace(/\bNaN\b/g, 'n/a').slice(0, 14_000), bottleneckKeys: top.map((x) => x.key) };
}
