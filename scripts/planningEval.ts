/**
 * Production planning evaluation (docs/COMPLETION-SPEC.md §114): a fresh request
 * goes in exactly as the owner would state it, and Brain's own goal machinery
 * does everything else. One request is one project and one goal, so no request's
 * openings, research or ledger leak into another's plan.
 *
 *   create --run R --case C --objective-b64 <base64 of the owner's words>
 *   create --run R --batch-b64 <base64 of a JSON list of {case, text}>
 *       Creates project "Planning evaluation R C" and the goal from the words,
 *       read by the one objective reader (`createGoal`). The goal is set by the
 *       Brain's enabled administrator — there must be exactly one — because a
 *       person-set cash goal is what starts its project's research sprint
 *       (`russell/goalSprint.ts`); the actor ref records that an evaluation run
 *       set it. Idempotent per (run, case): a second create prints the first.
 *   read --run R [--case C]
 *       Prints, per goal, a bounded JSON of what the owner would be handed: the
 *       plan reading (verdict, chosen strategy, steps, acceptance), the goal's
 *       openings with their card facts, and its research so far. Read-only.
 *   stall --run R
 *       Where each goal's research stops between a launched mission and an
 *       EVIDENCE fact: missions, packets, fragments, work items, claims, and the
 *       free lane's queue and leases Brain-wide. Read-only.
 *   retire --run R
 *       Cancels every goal of an evaluation run whose answers have already been
 *       used, through the ordinary cancel decision: research, attempts and
 *       results are all kept, `reinstate` continues them, and the run stops
 *       competing with fresh runs for the shared research queue.
 *   update --goal G --objective-b64 <words>
 *       A mid-course change in the owner's words, applied through the same
 *       writer the owner's own change uses.
 *
 * Nothing here approves, spends, contacts or sends. The request texts are not
 * in the repository: an evaluator holds them, so no implementing agent can fit
 * Brain to them.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import type { SqlParam } from '../server/db/driver.ts';
import { createProject, listProjects } from '../server/repos/projects.ts';
import { listUsers } from '../server/repos/identity.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { listWorkstreams, recordWorkstreamEvent } from '../server/repos/register.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? '';
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function fail(message: string): never {
  console.error(`PLANNING_EVAL: FAILED ${message}`);
  process.exit(1);
}
const safeId = (value: string | undefined, what: string): string => {
  if (!value || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) fail(`${what} must be 1-40 letters, digits, _ or -`);
  return value;
};
const words = (b64: string | undefined): string => {
  if (!b64) fail('--objective-b64 is required');
  const text = Buffer.from(b64, 'base64').toString('utf8').replace(/\s+/g, ' ').trim();
  if (!text) fail('the objective is empty');
  return text;
};
const projectName = (run: string, kase: string) => `Planning evaluation ${run} ${kase}`;

function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 700 ? `${value.slice(0, 700)}…` : value;
  if (Array.isArray(value)) return value.slice(0, depth > 1 ? 6 : 12).map((one) => clip(one, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 4) return '[…]';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clip(v, depth + 1)]));
  }
  return value;
}

async function create(): Promise<void> {
  const run = safeId(flag('run'), '--run');
  const batch = flag('batch-b64');
  if (batch) {
    // Several requests at once: base64 of a JSON list of {case, text}.
    const items = JSON.parse(Buffer.from(batch, 'base64').toString('utf8')) as { case: string; text: string }[];
    for (const item of items) await createOne(run, safeId(item.case, 'case'), item.text.replace(/\s+/g, ' ').trim());
    return;
  }
  await createOne(run, safeId(flag('case'), '--case'), words(flag('objective-b64')));
}

async function createOne(run: string, kase: string, objective: string): Promise<void> {
  const name = projectName(run, kase);
  const existing = (await listProjects()).find((one) => one.name === name);
  if (existing) {
    const goal = (await listWorkstreams()).find((one) => one.projectId === existing.id && !one.archivedAt);
    console.log(`EVAL ${run} ${kase} project=${existing.id} goal=${goal?.id ?? 'none'} (already created)`);
    return;
  }
  const admins = (await listUsers()).filter((user) => user.isBrainAdmin && !user.disabledAt && user.kind === 'PERSON');
  if (admins.length !== 1) fail(`an evaluation goal is set by the Brain's one enabled administrator; found ${admins.length}`);
  const admin = admins[0]!;
  const project = await createProject({ name, description: `A planning evaluation request (run ${run}, case ${kase}). Research only.` });
  const result = await createGoal({ projectId: project.id, objective, actorRef: `planning-evaluation:${run}`, userId: admin.id });
  const r = result.reading;
  console.log(`  read ${r.kind}${r.amount !== null ? ` ${r.amount} ${r.currency ?? '?'}` : ''}${r.deadline ? ` by ${r.deadline}` : ''}${r.capitalCeiling !== null ? ` capital<=${r.capitalCeiling}` : ''}${r.hoursCeiling !== null ? ` hours<=${r.hoursCeiling}` : ''}`);
  for (const u of r.unread) console.log(`  unread ${u}`);
  if (!result.ok) {
    console.log(`EVAL ${run} ${kase} project=${project.id} goal=none REFUSED ${result.reason}`);
    return;
  }
  console.log(`EVAL ${run} ${kase} project=${project.id} goal=${result.goal.id}`);
}

async function update(): Promise<void> {
  const goalId = safeId(flag('goal'), '--goal');
  const text = words(flag('objective-b64'));
  const goal = (await listWorkstreams()).find((one) => one.id === goalId);
  if (!goal) fail(`no goal ${goalId}`);
  const { readObjective } = await import('../server/services/industry/construction/intent.ts');
  const { setTargetLimits } = await import('../server/services/goals/target.ts');
  const reading = readObjective(text, new Date());
  if (!goal.target) fail('the goal has no target to change');
  const result = await setTargetLimits({
    goal,
    capitalCeilingCents: reading.capitalCeiling === null ? goal.target.capitalCeilingCents : Math.round(reading.capitalCeiling * 100),
    hoursCeiling: reading.hoursCeiling === null ? goal.target.hoursCeiling : Math.round(reading.hoursCeiling),
    // The owner's change in their own words stays on the goal beside what it had, so every
    // reader of the goal's resources (and the route proposer) sees it, not only the two figures.
    resources: [goal.target.resources, `Update: ${text}`].filter(Boolean).join(' ').slice(0, 2000),
  });
  if (!result.ok) fail(`not changed: ${result.reason}`);
  await recordWorkstreamEvent({ workstreamId: goal.id, kind: 'GOAL_TARGET_LIMITS_SET', summary: `The owner changed the limits mid-course: "${text.slice(0, 300)}"`, actorRef: 'planning-evaluation' });
  console.log(`EVAL update ${goalId}: limits now capital=${reading.capitalCeiling ?? 'unchanged'} hours=${reading.hoursCeiling ?? 'unchanged'}`);
}

async function retire(): Promise<void> {
  const run = safeId(flag('run'), '--run');
  const { cancel } = await import('../server/services/goals/decide.ts');
  const prefix = `Planning evaluation ${run} `;
  const projects = new Set((await listProjects()).filter((one) => one.name.startsWith(prefix)).map((one) => one.id));
  let done = 0;
  for (const goal of await listWorkstreams()) {
    if (!goal.projectId || !projects.has(goal.projectId)) continue;
    const result = await cancel(goal.id, `Evaluation run ${run} retired: its answers were used to develop Brain, so it no longer measures unfamiliar goals.`, `planning-evaluation:${run}`);
    if (result.ok) done += 1;
    console.log(`EVAL retire ${run} ${goal.id}: ${result.ok ? 'cancelled' : result.reason}`);
  }
  console.log(`EVAL retire ${run}: ${done} goal(s) cancelled across ${projects.size} project(s)`);
}

async function read(): Promise<void> {
  const run = safeId(flag('run'), '--run');
  const only = flag('case');
  const prefix = `Planning evaluation ${run} `;
  const projects = (await listProjects()).filter((one) => one.name.startsWith(prefix) && (!only || one.name === projectName(run, only)));
  const { readGoalPlan } = await import('../server/services/goals/plan.ts');
  const { listOpportunities } = await import('../server/repos/cashPortfolio.ts');
  const { cardFactsFor } = await import('../server/repos/cashCardFacts.ts');
  const { planningReport, planningReportLines } = await import('../server/services/goals/planningReport.ts');
  const goals = await listWorkstreams();
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const kase = project.name.slice(prefix.length);
    const goal = goals.find((one) => one.projectId === project.id && !one.archivedAt);
    if (!goal) {
      console.log(`EVAL_CASE ${kase} ${JSON.stringify({ project: project.id, goal: null })}`);
      continue;
    }
    const started = Date.now();
    const reading = await readGoalPlan({ goalId: goal.id, persist: false }).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) }));
    const openings = await listOpportunities({ projectId: project.id });
    const cards = [];
    for (const o of openings.slice(0, 15)) {
      const facts = await cardFactsFor(o.id);
      cards.push({
        id: o.id, title: o.title, mechanism: o.mechanism, state: o.state, payer: o.payer, price: o.priceCents === null ? null : o.priceCents / 100,
        channel: o.reachableChannel, signal: o.buyingSignal, fulfiller: o.fulfillmentOwner, validation: o.validationState,
        facts: facts.slice(0, 25).map((f) => ({ field: f.field, kind: f.kind, value: f.value.slice(0, 300) })),
      });
    }
    const research = await getDb().all<{ state: string; n: number }>(
      `SELECT o.status AS state, COUNT(*) AS n FROM research_orchestrations o WHERE o.project_id = ? GROUP BY o.status ORDER BY n DESC`,
      [project.id],
    );
    // What the goal's own loop recorded: route proposals and why, and the dives its openings started.
    const goalEvents = await getDb().all<{ kind: string; summary: string; created_at: string }>(
      `SELECT kind, summary, created_at FROM workstream_events WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 25`,
      [goal.id],
    );
    const cashEvents = await getDb().all<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM cash_events WHERE project_id = ? GROUP BY kind ORDER BY n DESC LIMIT 20`,
      [project.id],
    ).catch(() => []);
    /*
     * The path from an idea to a launched packet, counted for this project:
     * captured → judged (a priority) → compiled (a missionSpec) → launched (a
     * mission) → a packet. A goal whose dives started and whose research is
     * empty stopped at one of these, and this says which.
     */
    const ideas = await getDb().all<{ state: string; judged: number; spec: number; missions: number; n: number }>(
      `SELECT c.state AS state,
              CASE WHEN c.priority IS NULL THEN 0 ELSE 1 END AS judged,
              CASE WHEN c.judgment LIKE '%"missionSpec"%' THEN 1 ELSE 0 END AS spec,
              CASE WHEN EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id) THEN 1 ELSE 0 END AS missions,
              COUNT(*) AS n
         FROM russell_candidates c WHERE c.project_id = ?
        GROUP BY 1, 2, 3, 4 ORDER BY n DESC`,
      [project.id],
    ).catch(() => []);
    const missions = await getDb().all<{ state: string; n: number }>(
      `SELECT state, COUNT(*) AS n FROM russell_missions WHERE project_id = ? GROUP BY state ORDER BY n DESC`,
      [project.id],
    ).catch(() => []);
    // Each deep dive's idea, and when it was judged and launched — the latency the goal waits on.
    const dives = await getDb().all<{ id: string; state: string; priority: string | null; created_at: string; updated_at: string; mission_at: string | null; packet_at: string | null }>(
      `SELECT c.id, c.state, c.priority, c.created_at, c.updated_at,
              (SELECT MIN(m.created_at) FROM russell_missions m WHERE m.candidate_id = c.id) AS mission_at,
              (SELECT MIN(o.created_at) FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE m.candidate_id = c.id) AS packet_at
         FROM russell_candidates c
        WHERE c.id IN (SELECT op.candidate_id FROM cash_opportunities op WHERE op.project_id = ? AND op.candidate_id IS NOT NULL)
        ORDER BY c.created_at`,
      [project.id],
    ).catch(() => []);
    // The unjudged ideas, by goal tier and by what raised them (a dive, a need, a round, other).
    const { goalFirstSql: tierSql } = await import('../server/services/goals/goalWork.ts');
    const unjudged = await getDb().all<{ tier: number; kind: string; n: number; oldest: string }>(
      `SELECT ${tierSql('c')} AS tier,
              CASE WHEN c.id IN (SELECT op.candidate_id FROM cash_opportunities op WHERE op.candidate_id IS NOT NULL) THEN 'dive'
                   WHEN c.id IN (SELECT nd.candidate_id FROM cash_needs nd WHERE nd.candidate_id IS NOT NULL) THEN 'need'
                   WHEN c.id IN (SELECT rd.candidate_id FROM cash_discovery_rounds rd WHERE rd.candidate_id IS NOT NULL) THEN 'round'
                   ELSE 'other' END AS kind,
              COUNT(*) AS n, MIN(c.created_at) AS oldest
         FROM russell_candidates c
        WHERE c.project_id = ? AND c.priority IS NULL AND c.state <> 'MERGED'
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [project.id],
    ).catch((error: unknown) => [{ error: String((error as Error)?.message ?? error) }]);
    const plan = reading && !('error' in reading) ? reading : null;
    const report = plan ? planningReportLines(planningReport(plan as never, goal.dueAt ?? null)) : [];
    const out = {
      project: project.id, goal: goal.id, objective: goal.intent || goal.title, resources: goal.target?.resources ?? null, limits: goal.target ? { capitalCeilingCents: goal.target.capitalCeilingCents, hoursCeiling: goal.target.hoursCeiling } : null, createdAt: goal.createdAt, readMs: Date.now() - started,
      error: reading && 'error' in reading ? reading.error : null,
      report,
      plan: plan
        ? clip({
            verdict: plan.verdict, summary: plan.summary, chosen: plan.chosen, refusal: plan.refusal, bestReach: plan.bestReach,
            acceptance: plan.acceptance, strategies: plan.strategies, nextTest: plan.nextTest, considered: plan.considered,
            marketTests: plan.marketTests, sales: plan.sales, executionPolicy: plan.executionPolicy,
            steps: (plan as unknown as Record<string, unknown>)['steps'] ?? (plan as unknown as Record<string, unknown>)['planSteps'] ?? null,
          })
        : null,
      openings: cards,
      research,
      ideas,
      missions,
      dives,
      unjudged,
      goalEvents: goalEvents.map((e) => ({ at: e.created_at, kind: e.kind, summary: e.summary.slice(0, 300) })),
      cashEvents,
    };
    console.log(`EVAL_CASE ${kase} ${JSON.stringify(out)}`);
  }
  /*
   * The Brain-wide queues every goal's ideas wait in: how many ideas are
   * unjudged (all, and in a live goal's tier), how many are launchable, and
   * how old the oldest of each is. Counts and timestamps only.
   */
  const { goalIdeaSql } = await import('../server/services/goals/goalWork.ts');
  const queue = await getDb().get<Record<string, unknown>>(
    `SELECT
        (SELECT COUNT(*) FROM russell_candidates c WHERE c.priority IS NULL AND c.state <> 'MERGED' AND c.project_id IS NOT NULL) AS unjudged,
        (SELECT COUNT(*) FROM russell_candidates c WHERE c.priority IS NULL AND c.state <> 'MERGED' AND c.project_id IS NOT NULL AND ${goalIdeaSql('c')}) AS unjudged_goal,
        (SELECT MIN(c.created_at) FROM russell_candidates c WHERE c.priority IS NULL AND c.state <> 'MERGED' AND c.project_id IS NOT NULL AND ${goalIdeaSql('c')}) AS oldest_unjudged_goal,
        (SELECT COUNT(*) FROM russell_candidates c WHERE c.state = 'QUEUED' AND c.judgment LIKE '%"missionSpec"%' AND NOT EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id)) AS compiled_never_launched,
        (SELECT COUNT(*) FROM russell_candidates c WHERE c.state = 'QUEUED' AND c.judgment LIKE '%"missionSpec"%' AND NOT EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id) AND ${goalIdeaSql('c')}) AS compiled_never_launched_goal`,
  ).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) }));
  console.log(`EVAL_QUEUE ${JSON.stringify(queue)}`);
  // Launch and judging throughput, Brain-wide, per ten minutes over the last three hours.
  const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const launched = await getDb().all<{ at: string; n: number }>(
    `SELECT SUBSTR(created_at, 1, 15) AS at, COUNT(*) AS n FROM russell_missions WHERE created_at >= ? GROUP BY 1 ORDER BY 1`,
    [since],
  ).catch(() => []);
  console.log(`EVAL_LAUNCHES ${JSON.stringify(launched)}`);
  // Ideas judged, approximated by a judged idea's last update, and the live goal tier's share of them.
  const judged = await getDb().all<{ at: string; n: number; goal: number }>(
    `SELECT SUBSTR(c.updated_at, 1, 15) AS at, COUNT(*) AS n,
            SUM(CASE WHEN ${goalIdeaSql('c')} THEN 1 ELSE 0 END) AS goal
       FROM russell_candidates c WHERE c.priority IS NOT NULL AND c.updated_at >= ? GROUP BY 1 ORDER BY 1`,
    [since],
  ).catch(() => []);
  console.log(`EVAL_JUDGED ${JSON.stringify(judged)}`);
  // Who holds the live goal tier's unjudged backlog: per project, count and oldest.
  const holders = await getDb().all<{ project_id: string; n: number; oldest: string }>(
    `SELECT c.project_id, COUNT(*) AS n, MIN(c.created_at) AS oldest FROM russell_candidates c
      WHERE c.priority IS NULL AND c.state <> 'MERGED' AND c.project_id IS NOT NULL AND ${goalIdeaSql('c')}
      GROUP BY c.project_id ORDER BY n DESC LIMIT 30`,
  ).catch(() => []);
  console.log(`EVAL_GOAL_BACKLOG ${JSON.stringify(holders)}`);
  const cycle = await getDb().get<Record<string, unknown>>(`SELECT * FROM russell_cycle LIMIT 1`).catch(() => null);
  console.log(`EVAL_CYCLE ${JSON.stringify(cycle)}`);
  console.log(`EVAL_READ ${run} ${projects.length} case(s)`);
}

/**
 * stall --run R: where an evaluation goal's research stops between a launched
 * mission and an EVIDENCE fact — per goal, its missions, packets, fragments,
 * work items (by type and state, with owning bin) and claims; Brain-wide, who
 * holds the free lane and what it finished lately. Counts and timestamps only.
 */
async function stall(): Promise<void> {
  const run = safeId(flag('run'), '--run');
  // `--run all` reads every evaluation run's goals together.
  const like = run === 'all' ? 'Planning evaluation %' : `Planning evaluation ${run} %`;
  const q = async (label: string, sql: string, params: SqlParam[] = []): Promise<void> => {
    const rows = await getDb().all<Record<string, unknown>>(sql, params).catch((error: unknown) => [{ error: String((error as Error)?.message ?? error).slice(0, 300) }]);
    console.log(`STALL ${label} ${JSON.stringify(rows)}`);
  };
  const ev = `SELECT id FROM projects WHERE name LIKE ?`;
  await q('missions', `SELECT state, waiting_on, terminal_reason, COUNT(*) AS n, MIN(created_at) AS first, MAX(updated_at) AS last FROM russell_missions WHERE project_id IN (${ev}) GROUP BY state, waiting_on, terminal_reason ORDER BY n DESC LIMIT 30`, [like]);
  await q('packets', `SELECT status, current_pass, provider, COUNT(*) AS n, MIN(created_at) AS first, MAX(heartbeat_at) AS beat, MAX(updated_at) AS last FROM research_orchestrations WHERE project_id IN (${ev}) GROUP BY status, current_pass, provider ORDER BY n DESC`, [like]);
  await q('fragments', `SELECT status, block_cause, COUNT(*) AS n, MIN(created_at) AS first, MAX(updated_at) AS last, MIN(next_retry_at) AS retry FROM research_fragments WHERE project_id IN (${ev}) GROUP BY status, block_cause ORDER BY n DESC`, [like]);
  await q('fragment_blocks', `SELECT SUBSTR(COALESCE(blocked_reason, ''), 1, 240) AS reason, COUNT(*) AS n FROM research_fragments WHERE project_id IN (${ev}) AND blocked_reason IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 10`, [like]);
  await q('items', `SELECT w.work_type, w.state, w.failure_category, (SELECT b.purpose FROM bins b WHERE b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id) ORDER BY b.created_at DESC LIMIT 1) AS purpose, COUNT(*) AS n, MIN(w.priority) AS pmin, MAX(w.priority) AS pmax, MIN(w.available_at) AS avail, MAX(w.attempt_count) AS attempts, MIN(w.created_at) AS first, MAX(w.updated_at) AS last FROM work_items w WHERE w.project_id IN (${ev}) GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 40`, [like]);
  await q('item_failures', `SELECT w.work_type, SUBSTR(COALESCE(w.result_summary, w.cancelled_reason, ''), 1, 240) AS why, COUNT(*) AS n FROM work_items w WHERE w.project_id IN (${ev}) AND w.state IN ('FAILED', 'CANCELLED') GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`, [like]);
  await q('item_workers', `SELECT w.work_type, w.state, k.name AS worker, COUNT(*) AS n FROM work_items w LEFT JOIN workers k ON k.id = w.worker_id WHERE w.project_id IN (${ev}) AND w.worker_id IS NOT NULL GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20`, [like]);
  await q('bins', `SELECT b.purpose, b.state, b.kind, COUNT(*) AS n FROM bins b WHERE b.project_id IN (${ev}) GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20`, [like]);
  await q('claims', `SELECT c.accepted, c.validation_state, COUNT(*) AS n, MAX(c.created_at) AS last FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id IN (${ev}) GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`, [like]);
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
  // Brain-wide: the free lane's claimable research, who holds its leases, and what finished lately — evaluation vs everything else.
  const cls = `CASE WHEN w.project_id IN (${ev}) THEN 'eval' WHEN w.project_id IN (SELECT id FROM projects WHERE name LIKE 'Planning evaluation %') THEN 'eval_other' ELSE 'other' END`;
  const types = `('RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT')`;
  await q('queued_all', `SELECT ${cls} AS cls, w.work_type, COUNT(*) AS n, MAX(w.priority) AS pmax, MIN(w.priority) AS pmin, MIN(w.available_at) AS oldest FROM work_items w WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts AND w.work_type IN ${types} GROUP BY 1, 2 ORDER BY 1, 2`, [like, now]);
  await q('queued_future', `SELECT ${cls} AS cls, w.work_type, COUNT(*) AS n, MIN(w.available_at) AS next FROM work_items w WHERE w.state = 'QUEUED' AND w.available_at > ? AND w.work_type IN ${types} GROUP BY 1, 2 ORDER BY 1, 2`, [like, now]);
  await q('queued_exhausted', `SELECT ${cls} AS cls, w.work_type, COUNT(*) AS n FROM work_items w WHERE w.state = 'QUEUED' AND w.attempt_count >= w.max_attempts AND w.work_type IN ${types} GROUP BY 1, 2 ORDER BY 1, 2`, [like]);
  await q('leased', `SELECT ${cls} AS cls, w.work_type, k.name AS worker, COUNT(*) AS n, MIN(w.leased_at) AS oldest FROM work_items w LEFT JOIN workers k ON k.id = w.worker_id WHERE w.state = 'LEASED' AND w.work_type IN ${types} GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 30`, [like]);
  await q('finished_3h', `SELECT ${cls} AS cls, w.work_type, w.state, COUNT(*) AS n FROM work_items w WHERE w.completed_at >= ? AND w.work_type IN ${types} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [like, since]);
  await q('priority_hist', `SELECT ${cls} AS cls, w.priority, COUNT(*) AS n FROM work_items w WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.work_type IN ${types} GROUP BY 1, 2 ORDER BY 2 DESC, 1 LIMIT 40`, [like, now]);
  await q('claims_3h', `SELECT CASE WHEN o.project_id IN (${ev}) THEN 'eval' ELSE 'other' END AS cls, c.accepted, COUNT(*) AS n FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE c.created_at >= ? GROUP BY 1, 2`, [like, since]);
  const runOf = `SUBSTR(p.name, 21, 8)`;
  await q('by_run_items', `SELECT ${runOf} AS run, w.work_type, w.state, COUNT(*) AS n, MIN(w.created_at) AS first, MAX(w.completed_at) AS done FROM work_items w JOIN projects p ON p.id = w.project_id WHERE p.name LIKE 'Planning evaluation %' AND w.work_type IN ${types} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
  await q('by_run_claims', `SELECT ${runOf} AS run, c.accepted, COALESCE(c.validation_state, '') AS vs, COUNT(*) AS n, MAX(c.created_at) AS last FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id JOIN projects p ON p.id = o.project_id WHERE p.name LIKE 'Planning evaluation %' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
  await q('by_run_packets', `SELECT ${runOf} AS run, o.status, COUNT(*) AS n, MAX(o.completed_at) AS done FROM research_orchestrations o JOIN projects p ON p.id = o.project_id WHERE p.name LIKE 'Planning evaluation %' GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('by_run_fragments', `SELECT ${runOf} AS run, f.status, COUNT(*) AS n FROM research_fragments f JOIN projects p ON p.id = f.project_id WHERE p.name LIKE 'Planning evaluation %' GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('by_run_missions', `SELECT ${runOf} AS run, m.state, COUNT(*) AS n, MAX(m.writeback_at) AS wb FROM russell_missions m JOIN projects p ON p.id = m.project_id WHERE p.name LIKE 'Planning evaluation %' GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('rejections', `SELECT SUBSTR(COALESCE(c.rejection_reason, ''), 1, 160) AS why, COUNT(*) AS n FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id JOIN projects p ON p.id = o.project_id WHERE p.name LIKE 'Planning evaluation %' AND c.accepted = 0 GROUP BY 1 ORDER BY n DESC LIMIT 10`);
  // What the lane did per hour today, eval vs not: fragments finished and leased-then-expired.
  await q('lane_hourly', `SELECT SUBSTR(w.completed_at, 1, 13) AS hour, CASE WHEN p.name LIKE 'Planning evaluation %' THEN 'eval' ELSE 'other' END AS cls, w.work_type, w.state, COUNT(*) AS n FROM work_items w JOIN projects p ON p.id = w.project_id WHERE w.completed_at >= ? AND w.work_type IN ${types} GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`, [new Date(Date.now() - 10 * 3_600_000).toISOString()]);
  // Parked packets (NEEDS_HUMAN): why, whether a fragment or only claims were accepted, gap policy, grant, cards.
  const evp = `o.project_id IN (SELECT id FROM projects WHERE name LIKE ?)`;
  await q('parks', `SELECT SUBSTR(COALESCE(o.failure_reason, ''), 1, 200) AS why, o.current_pass AS pass, COALESCE(o.unresolved_gap_policy, '-') AS gap,
      CASE WHEN EXISTS (SELECT 1 FROM research_fragments f WHERE f.orchestration_id = o.id AND f.status = 'ACCEPTED') THEN 1 ELSE 0 END AS acc_frag,
      CASE WHEN EXISTS (SELECT 1 FROM research_claims c WHERE c.orchestration_id = o.id AND c.accepted = 1) THEN 1 ELSE 0 END AS acc_claim,
      CASE WHEN EXISTS (SELECT 1 FROM russell_goals g WHERE g.project_id = o.project_id AND g.purpose = 'STANDING' AND g.state = 'ACTIVE') THEN 1 ELSE 0 END AS grant_live,
      CASE WHEN EXISTS (SELECT 1 FROM russell_missions m JOIN russell_human_requests r ON r.mission_id = m.id WHERE m.orchestration_id = o.id AND r.state IN ('OPEN', 'ANSWERED')) THEN 1 ELSE 0 END AS card,
      (SELECT m.state FROM russell_missions m WHERE m.orchestration_id = o.id ORDER BY m.created_at DESC LIMIT 1) AS mission,
      COUNT(*) AS n, MIN(o.updated_at) AS oldest, MAX(o.updated_at) AS newest
     FROM research_orchestrations o WHERE o.status = 'NEEDS_HUMAN' AND ${evp} GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 ORDER BY n DESC LIMIT 25`, [like]);
  // Blocked fragments: the lanes declared and the lanes their accepted / rejected claims named.
  await q('blocked_lanes', `SELECT f.block_cause AS cause, SUBSTR(COALESCE(f.required_evidence, ''), 1, 160) AS required, f.evidence_lane AS lane,
      (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id AND c.accepted = 1) AS acc,
      (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id) AS claims,
      (SELECT MIN(c.evidence_lane) || ' .. ' || MAX(c.evidence_lane) FROM research_claims c WHERE c.fragment_id = f.id) AS claim_lanes
     FROM research_fragments f WHERE f.status = 'BLOCKED' AND f.project_id IN (SELECT id FROM projects WHERE name LIKE ?) ORDER BY f.updated_at DESC LIMIT 25`, [like]);
  await q('blocked_summary', `SELECT f.block_cause AS cause,
      CASE WHEN EXISTS (SELECT 1 FROM research_claims c WHERE c.fragment_id = f.id AND c.accepted = 1) THEN 1 ELSE 0 END AS has_acc,
      CASE WHEN EXISTS (SELECT 1 FROM research_claims c WHERE c.fragment_id = f.id) THEN 1 ELSE 0 END AS has_claims,
      (SELECT o.status FROM research_orchestrations o WHERE o.id = f.orchestration_id) AS packet,
      COUNT(*) AS n FROM research_fragments f WHERE f.status = 'BLOCKED' AND f.project_id IN (SELECT id FROM projects WHERE name LIKE ?) GROUP BY 1, 2, 3, 4 ORDER BY n DESC`, [like]);
  // Packets finished with gaps: their mission, the idea, the opening it dives, and the card facts it filed.
  await q('filed', `SELECT o.id, o.status, o.completed_at, o.document_id IS NOT NULL AS doc, m.state AS mission, m.writeback_at, m.candidate_id,
      (SELECT op.id FROM cash_opportunities op WHERE op.candidate_id = m.candidate_id LIMIT 1) AS dive_of,
      (SELECT op.id FROM cash_opportunities op WHERE op.validation_orchestration_id = o.id LIMIT 1) AS validates,
      (SELECT nd.id FROM cash_needs nd WHERE nd.candidate_id = m.candidate_id LIMIT 1) AS need,
      (SELECT COUNT(*) FROM cash_card_facts cf WHERE cf.claim_id IN (SELECT c.id FROM research_claims c WHERE c.orchestration_id = o.id)) AS facts_from_claims,
      (SELECT COUNT(*) FROM research_claims c WHERE c.orchestration_id = o.id AND c.accepted = 1) AS acc
     FROM research_orchestrations o LEFT JOIN russell_missions m ON m.orchestration_id = o.id
    WHERE o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND ${evp} ORDER BY o.completed_at DESC LIMIT 20`, [like]);
  /*
   * The claim → card fact → plan chain, per filed packet (read-only): which accepted
   * claims became which card facts and of which kind, which became construction
   * facts (a goal price question's route into the plan), and what each claim was.
   */
  const filedSql = `SELECT o.id FROM research_orchestrations o WHERE o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND ${evp}`;
  await q('chain_facts', `SELECT c.orchestration_id AS orc, cf.opportunity_id AS op, cf.field, cf.kind, cf.decided_by AS by_, cf.need_id AS need, cf.claim_id AS claim, cf.updated_at AS at
     FROM cash_card_facts cf JOIN research_claims c ON c.id = cf.claim_id WHERE c.orchestration_id IN (${filedSql}) ORDER BY 1, 2, 3 LIMIT 80`, [like]);
  await q('chain_claims', `SELECT c.orchestration_id AS orc, COALESCE(c.evidence_lane, '-') AS lane, COALESCE(c.claim_type, '-') AS type, COALESCE(c.structural_subject, '-') AS subj,
      CASE WHEN c.structural_amount_cents IS NULL THEN 0 ELSE 1 END AS amount, CASE WHEN c.source_url IS NULL THEN 0 ELSE 1 END AS src, CASE WHEN c.source_date IS NULL THEN 0 ELSE 1 END AS dated,
      (SELECT f.status FROM research_fragments f WHERE f.id = c.fragment_id) AS frag,
      (SELECT COUNT(*) FROM cash_card_facts cf WHERE cf.claim_id = c.id) AS card,
      (SELECT COUNT(*) FROM construction_facts x WHERE x.source_claim_id = c.id) AS cons,
      COUNT(*) AS n
     FROM research_claims c WHERE c.accepted = 1 AND c.orchestration_id IN (${filedSql}) GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ORDER BY 1, 2 LIMIT 120`, [like]);
  await q('chain_cons', `SELECT c.orchestration_id AS orc, x.fact_key, x.segment, x.status, x.low, x.high, x.created_at FROM construction_facts x JOIN research_claims c ON c.id = x.source_claim_id WHERE c.orchestration_id IN (${filedSql}) ORDER BY 1 LIMIT 40`, [like]);
  await q('chain_needs', `SELECT o.id AS orc, m.candidate_id AS cand, nd.id AS need, nd.request_key AS rk, nd.state, nd.opportunity_id AS op, SUBSTR(COALESCE(nd.resolution, ''), 1, 160) AS res,
      SUBSTR(k.title, 1, 140) AS title, SUBSTR(k.statement, 1, 160) AS stmt, (SELECT COUNT(*) FROM industry_nodes n WHERE n.project_id = o.project_id AND n.kind = 'BUYER_TYPE' AND n.retired_at IS NULL) AS buyer_types
     FROM research_orchestrations o JOIN russell_missions m ON m.orchestration_id = o.id LEFT JOIN cash_needs nd ON nd.candidate_id = m.candidate_id LEFT JOIN russell_candidates k ON k.id = m.candidate_id
    WHERE o.id IN (${filedSql}) ORDER BY 1 LIMIT 40`, [like]);
  await q('chain_claim_text', `SELECT c.orchestration_id AS orc, c.id, c.evidence_lane AS lane, c.claim_type AS type, c.structural_subject AS subj, c.structural_amount_cents AS cents, SUBSTR(COALESCE(c.structural_qualifier, ''), 1, 80) AS qual, SUBSTR(c.claim, 1, 200) AS claim
     FROM research_claims c WHERE c.accepted = 1 AND c.orchestration_id IN (${filedSql}) AND NOT EXISTS (SELECT 1 FROM cash_card_facts cf WHERE cf.claim_id = c.id) ORDER BY 1, 3 LIMIT 60`, [like]);
  // The workflow's `case` input carries the opening for `stall`.
  const opening = flag('opening') ?? flag('case');
  if (opening && /^cop_[a-f0-9]{1,40}$/.test(opening)) {
    await q('chain_opening', `SELECT op.*, p.name AS project_name FROM cash_opportunities op JOIN projects p ON p.id = op.project_id WHERE op.id = ?`, [opening]);
    await q('chain_opening_facts', `SELECT field, kind, claim_id, need_id, decided_by, created_at, updated_at, SUBSTR(value, 1, 140) AS value FROM cash_card_facts WHERE opportunity_id = ? ORDER BY updated_at`, [opening]);
    await q('chain_opening_events', `SELECT kind, created_at, SUBSTR(summary, 1, 160) AS summary FROM cash_events WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 30`, [opening]);
    const ws = await getDb().get<{ id: string }>(`SELECT w.id FROM workstreams w JOIN cash_opportunities op ON op.project_id = w.project_id WHERE op.id = ? AND w.archived_at IS NULL ORDER BY w.created_at LIMIT 1`, [opening]).catch(() => null);
    if (ws) {
      await q('chain_readings', `SELECT created_at, verdict, chosen_strategy, digest, LENGTH(strategies) AS slen, CASE WHEN strategies LIKE ? THEN 1 ELSE 0 END AS names_op FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 25`, [`%${opening}%`, ws.id]);
      try {
        const { readGoalPlan } = await import('../server/services/goals/plan.ts');
        const reading = await readGoalPlan({ goalId: ws.id, persist: false });
        const mine = reading?.considered.find((one) => one.opportunityId === opening) ?? null;
        console.log(`STALL chain_live ${JSON.stringify({ goal: ws.id, verdict: reading?.verdict, chosen: reading?.chosen ?? null, considered: reading?.considered.length, opening: mine, steps: clip((reading as unknown as Record<string, unknown> | null)?.['steps'] ?? null) })}`);
      } catch (error) {
        console.log(`STALL chain_live ${JSON.stringify({ error: String((error as Error)?.message ?? error).slice(0, 300) })}`);
      }
    }
  }
  await statedPriceProbe(like);
  await q('evidence_facts', `SELECT cf.kind, cf.field, COUNT(*) AS n FROM cash_card_facts cf JOIN cash_opportunities op ON op.id = cf.opportunity_id WHERE op.project_id IN (SELECT id FROM projects WHERE name LIKE ?) GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`, [like]);
  await q('needs', `SELECT nd.state, COUNT(*) AS n FROM cash_needs nd WHERE nd.project_id IN (SELECT id FROM projects WHERE name LIKE ?) GROUP BY 1`, [like]);
  // What `answerUnaskedParks` selects Brain-wide (its own WHERE, without the grace), in its order, and what it decided lately.
  const unasked = `o.status = 'NEEDS_HUMAN' AND (o.unresolved_gap_policy IS NULL OR o.unresolved_gap_policy <> 'RECORD_GAPS')
        AND EXISTS (SELECT 1 FROM research_fragments f WHERE f.orchestration_id = o.id AND f.status = 'ACCEPTED')
        AND NOT EXISTS (SELECT 1 FROM russell_missions m JOIN russell_human_requests r ON r.mission_id = m.id WHERE m.orchestration_id = o.id AND r.state IN ('OPEN', 'ANSWERED'))
        AND EXISTS (SELECT 1 FROM russell_goals g WHERE g.project_id = o.project_id AND g.purpose = 'STANDING' AND g.state = 'ACTIVE' AND (g.expires_at IS NULL OR g.expires_at > ?))`;
  await q('unasked_all', `SELECT CASE WHEN o.project_id IN (SELECT id FROM projects WHERE name LIKE 'Planning evaluation %') THEN 'eval' ELSE 'other' END AS cls, COUNT(*) AS n, MIN(o.updated_at) AS oldest, MAX(o.updated_at) AS newest FROM research_orchestrations o WHERE ${unasked} GROUP BY 1`, [now]);
  await q('unasked_head', `SELECT o.id, o.updated_at, o.current_pass, o.verdict, SUBSTR(COALESCE(o.failure_reason, ''), 1, 140) AS why FROM research_orchestrations o WHERE ${unasked} ORDER BY o.updated_at ASC, o.id ASC LIMIT 8`, [now]);
  await q('routine_decisions_24h', `SELECT SUBSTR(e.created_at, 1, 13) AS hour, COUNT(*) AS n FROM project_events e WHERE e.event_type = 'RUSSELL_ROUTINE_DECISION' AND e.created_at >= ? GROUP BY 1 ORDER BY 1`, [new Date(Date.now() - 24 * 3_600_000).toISOString()]);
  await q('gap_authorized_24h', `SELECT COUNT(*) AS n, MAX(o.unresolved_gap_authorized_at) AS last FROM research_orchestrations o WHERE o.unresolved_gap_authorized_at >= ?`, [new Date(Date.now() - 24 * 3_600_000).toISOString()]);
  await q('cycle', `SELECT generation, state, last_ran_at, SUBSTR(COALESCE(last_error, ''), 1, 600) AS last_error FROM russell_cycle LIMIT 1`);
  await q('filed_needs', `SELECT nd.id, nd.state, nd.request_key, nd.opportunity_id, nd.updated_at FROM cash_needs nd WHERE nd.candidate_id IN (SELECT m.candidate_id FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND ${evp})`, [like]);
  // What `parkStoppedMissions` selects (its WHERE and ORDER), and the head of its window.
  await q('park_window', `SELECT m.state, COALESCE(o.unresolved_gap_policy, '-') AS gap, CASE WHEN o.project_id IN (SELECT id FROM projects WHERE name LIKE 'Planning evaluation %') THEN 'eval' ELSE 'other' END AS cls,
      CASE WHEN EXISTS (SELECT 1 FROM research_fragments f WHERE f.orchestration_id = o.id AND f.status = 'ACCEPTED') THEN 1 ELSE 0 END AS acc_frag,
      COUNT(*) AS n, MIN(m.updated_at) AS oldest, MAX(m.updated_at) AS newest
     FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id
    WHERE m.state IN ('PLANNED','LAUNCHING','RUNNING','WAITING','NEEDS_HUMAN') AND o.status = 'NEEDS_HUMAN' GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`);
  await q('park_head', `SELECT m.id, m.state, m.updated_at, COALESCE(o.unresolved_gap_policy, '-') AS gap, o.current_pass, SUBSTR(COALESCE(o.failure_reason, ''), 1, 120) AS why
     FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id
    WHERE m.state IN ('PLANNED','LAUNCHING','RUNNING','WAITING','NEEDS_HUMAN') AND o.status = 'NEEDS_HUMAN'
    ORDER BY CASE WHEN m.state = 'NEEDS_HUMAN' THEN 1 ELSE 0 END, m.updated_at LIMIT 6`);
  await q('park_events_6h', `SELECT e.event_type, COUNT(*) AS n, MAX(e.created_at) AS last FROM project_events e WHERE e.created_at >= ? AND e.event_type IN ('RUSSELL_MISSION_FAILED', 'RUSSELL_MISSION_PARKED', 'RUSSELL_ROUTINE_DECISION', 'RUSSELL_HUMAN_REQUESTED') GROUP BY 1`, [new Date(Date.now() - 6 * 3_600_000).toISOString()]);
  // Judge parks (PATCH / MORE_RESEARCH): what `assessJudgeRound` says of each, and the resume pass's room.
  try {
    const judge = await import('../server/services/research/judgeRound.ts');
    const readings = await judge.judgeParkReadings();
    const evalIds = new Set((await getDb().all<{ id: string }>(`SELECT o.id FROM research_orchestrations o WHERE o.status = 'NEEDS_HUMAN' AND ${evp}`, [like])).map((r) => r.id));
    const tally = new Map<string, number>();
    for (const { orchestration, assessed } of readings) {
      const why = assessed.kind === 'PERSON' || assessed.kind === 'CONTINUED_ELSEWHERE' ? assessed.reason.slice(0, 90) : assessed.kind === 'RESUME' ? `round ${assessed.round} followUps=${assessed.followUps.length} corrections=${assessed.corrections.length}` : '';
      const key = `${evalIds.has(orchestration.id) ? 'eval' : 'other'}|${orchestration.unresolvedGapPolicy ?? '-'}|${assessed.kind}|${why}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    console.log(`STALL judge_parks ${JSON.stringify([...tally].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n))}`);
    console.log(`STALL judge_cap ${JSON.stringify({ cap: await judge.liveJudgeRoundCap() })}`);
  } catch (error) {
    console.log(`STALL judge_parks ${JSON.stringify([{ error: String((error as Error)?.message ?? error).slice(0, 300) }])}`);
  }
  await q('judge_resumed', `SELECT o.status, COALESCE(o.current_pass, '-') AS pass, COUNT(*) AS n, MIN(e.created_at) AS first_resume, MAX(e.created_at) AS last_resume
     FROM project_events e JOIN research_orchestrations o ON e.payload LIKE '%' || o.id || '%'
    WHERE e.event_type = 'RESEARCH_ROUND_RESUMED' AND e.created_at >= ? GROUP BY 1, 2 ORDER BY n DESC`, [new Date(Date.now() - 7 * 24 * 3_600_000).toISOString()]);
  await q('judge_resumed_daily', `SELECT SUBSTR(e.created_at, 1, 10) AS day, COUNT(*) AS n FROM project_events e WHERE e.event_type = 'RESEARCH_ROUND_RESUMED' AND e.created_at >= ? GROUP BY 1 ORDER BY 1`, [new Date(Date.now() - 7 * 24 * 3_600_000).toISOString()]);
  await q('capacity', `SELECT model, target, stable_high, updated_at, SUBSTR(reason, 1, 200) AS reason FROM free_lane_capacity ORDER BY model`);
}

/**
 * The price a goal price answer states per a named unit, as branch
 * fix/price-question-filing reads it (`statedUnitPrice`, which the serving
 * revision does not have yet): USD figures, a range's unit applying to both
 * ends, an open upper end (`$250+`), only figures per a unit the text names,
 * only the first unit. A copy for measurement only; tests compare it.
 */
export function probeStatedUnitPrice(text: string): { low: number; high: number; unit: string } | null {
  const num = String.raw`\d[\d.,]*\d|\d`;
  const stop = '(?:for|at|in|on|with|and|or|to|of|from|by|when|if|per|plus|including|excluding|is|are|was|were|over|the|a|an|across|during|within|after|before|under|than|as|that|which|this|these|those|depending|based|vs|versus|via)\\b';
  const unitRe = new RegExp(String.raw`^\s*(?:\/\s*|per\s+|an?\s+|each\s+|for\s+(?:each|every|one|a|an)\s+)((?!${stop})[a-z][\w-]*(?:\s+(?!${stop})[a-z][\w-]*){0,2})`, 'i');
  const rangeRe = new RegExp(String.raw`^\s*(?:to|through|-|–|—)\s*(?:USD|US\$|\$)?\s?(?:${num})(?:\s?(?:USD|US\$|\$)\b)?\+?`, 'i');
  const found: { cents: number; unit: string }[] = [];
  const seen = new Set<number>();
  for (const re of [new RegExp(String.raw`(?:\bUSD\b|US\$|\$)\s?(${num})`, 'gi'), new RegExp(String.raw`(${num})\s?\bUSD\b`, 'gi')]) {
    for (const m of text.matchAll(re)) {
      const raw = (m[1] ?? '').replace(/,/g, '');
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) continue;
      const cents = Math.round(Number(raw) * 100);
      let rest = text.slice(m.index + m[0].length);
      if (/^[%kKmMbB]/.test(rest) || /^\s*(?:thousand|million|billion|bn|mn|mm|m|k)\b/i.test(rest) || cents <= 0 || seen.has(cents)) continue;
      if (/\p{L}$/u.test(text.slice(Math.max(0, m.index - 1), m.index)) && !/^USD/i.test(m[0])) continue;
      seen.add(cents);
      if (rest.startsWith('+')) rest = rest.slice(1);
      const range = rangeRe.exec(rest);
      const unit = unitRe.exec(range ? rest.slice(range[0].length) : rest)?.[1]?.toLowerCase();
      if (unit && !/^(?:words?|characters?|chars?|pages?|lines?|hours?|hrs?|hr|minutes?|mins?)$/.test(unit.split(' ')[0]!)) found.push({ cents, unit });
    }
  }
  found.sort((a, b) => a.cents - b.cents);
  const first = found[0]?.unit;
  if (!first) return null;
  const same = found.filter((one) => one.unit === first).map((one) => one.cents);
  return { low: Math.min(...same) / 100, high: Math.max(...same) / 100, unit: first };
}

/**
 * Read-only: the OPEN goal price needs (Brain-wide and evaluation) whose idea's
 * research holds an accepted, sourced, undeclared answer with no construction
 * fact that the branch reader prices — under the same refusals the back-fill
 * applies (money paid to them, a non-purchase payment, a wrong-way price, a
 * population that is no buyer population). What the fix would answer.
 */
async function statedPriceProbe(like: string): Promise<void> {
  try {
    const { goalPriceQuestionOf } = await import('../server/services/goals/goalWork.ts');
    const { claimPaysPopulation } = await import('../server/services/industry/expand.ts');
    const { isNonPurchasePayment, wrongWayPrice } = await import('../server/domain/paymentNature.ts');
    const { namesABuyerPopulation } = await import('../server/domain/industry.ts');
    const rows = await getDb().all<{ need: string; project_id: string; eval: number; title: string; statement: string; claim_id: string | null; claim: string | null }>(
      `SELECT nd.id AS need, nd.project_id, CASE WHEN nd.project_id IN (SELECT id FROM projects WHERE name LIKE ?) THEN 1 ELSE 0 END AS eval, k.title, k.statement, c.id AS claim_id, c.claim
         FROM cash_needs nd JOIN russell_candidates k ON k.id = nd.candidate_id
         LEFT JOIN russell_missions m ON m.candidate_id = k.id
         LEFT JOIN research_claims c ON c.orchestration_id = m.orchestration_id AND c.accepted = 1 AND c.source_url IS NOT NULL
              AND NOT (COALESCE(c.structural_finding, '') = 'UNIT_ECONOMIC' AND c.structural_amount_cents IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM construction_facts f WHERE f.source_claim_id = c.id)
        WHERE nd.state = 'OPEN' AND nd.request_key LIKE 'goal-price-%'`,
      [like],
    );
    const needs = new Map<string, { eval: number; claims: number; answered: string | null; refused: Record<string, number> }>();
    for (const row of rows) {
      const one = needs.get(row.need) ?? { eval: row.eval, claims: 0, answered: null, refused: {} };
      needs.set(row.need, one);
      if (!row.claim_id || !row.claim) continue;
      one.claims += 1;
      const asked = goalPriceQuestionOf({ title: row.title, statement: row.statement });
      const price = probeStatedUnitPrice(row.claim);
      const why = !asked ? 'not a price question' : !price ? 'no price per a named unit' : claimPaysPopulation(row.claim, asked.buyer) ? 'paid to them' : isNonPurchasePayment(row.claim) ? 'non-purchase' : wrongWayPrice(row.claim, asked.buyer) ? 'wrong way' : !namesABuyerPopulation(asked.buyer) ? 'no buyer population' : null;
      if (why) one.refused[why] = (one.refused[why] ?? 0) + 1;
      else one.answered ??= `${row.claim_id}: USD ${price!.low}–${price!.high} per ${price!.unit}`;
    }
    const sum = (evalOnly: boolean) => {
      const list = [...needs.values()].filter((one) => !evalOnly || one.eval === 1);
      return { open: list.length, withClaims: list.filter((one) => one.claims > 0).length, wouldAnswer: list.filter((one) => one.answered).length };
    };
    console.log(`STALL stated_price_needs ${JSON.stringify({ all: sum(false), eval: sum(true) })}`);
    console.log(`STALL stated_price_detail ${JSON.stringify([...needs].filter(([, one]) => one.answered).slice(0, 40).map(([need, one]) => ({ need, ...one })))}`);
  } catch (error) {
    console.log(`STALL stated_price_needs ${JSON.stringify({ error: String((error as Error)?.message ?? error).slice(0, 300) })}`);
  }
}

/**
 * trace --run R --case C: the information flow of one evaluation goal, read
 * only — the pages its research found and read (the free lane's per-item
 * measures), the claims extracted and accepted, the EVIDENCE that reached its
 * openings, what its route asks were shown, the findings a route ask would be
 * shown now (verbatim) and the links its plan still lacks. Brain-wide: the
 * searches sent in the last day, by provider and outcome.
 */
async function trace(): Promise<void> {
  const run = safeId(flag('run'), '--run');
  const kase = safeId(flag('case'), '--case');
  const project = (await listProjects()).find((one) => one.name === projectName(run, kase));
  if (!project) fail(`no project for ${run} ${kase}`);
  const goal = (await listWorkstreams()).find((one) => one.projectId === project.id && !one.archivedAt);
  const out = (label: string, value: unknown) => console.log(`TRACE ${label} ${JSON.stringify(value)}`);
  const q = (sql: string, params: SqlParam[]): Promise<Record<string, unknown>[]> => getDb().all<Record<string, unknown>>(sql, params).catch((error: unknown) => [{ error: String((error as Error)?.message ?? error).slice(0, 300) }] as Record<string, unknown>[]);
  out('goal', { project: project.id, goal: goal?.id ?? null, createdAt: goal?.createdAt ?? null });
  // 1–2. Pages: every free-lane research item this project ran, with what it searched and read.
  const items = await q(`SELECT outcome, reason, measures, at FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND project_id = ? ORDER BY at`, [project.id]);
  const tally = { items: items.length, submitted: 0, failed: 0, released: 0, searched: 0, readFromSearch: 0, readFromModel: 0, itemsWithDiscovery: 0 };
  const reasons = new Map<string, number>();
  for (const row of items) {
    const outcome = String(row['outcome'] ?? '');
    if (outcome === 'SUBMITTED') tally.submitted += 1;
    else if (outcome.startsWith('RELEASED')) tally.released += 1;
    else tally.failed += 1;
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(String(row['measures'] ?? '{}')) as Record<string, unknown>;
    } catch {
      m = {};
    }
    const d = m['discovery'] as { searched?: number; readFromSearch?: number; readFromModel?: number } | undefined;
    if (d) {
      tally.itemsWithDiscovery += 1;
      tally.searched += d.searched ?? 0;
      tally.readFromSearch += d.readFromSearch ?? 0;
      tally.readFromModel += d.readFromModel ?? 0;
    }
    if (outcome !== 'SUBMITTED') {
      const why = String(row['reason'] ?? '').replace(/^model [^:]+: /, '').replace(/\d+/g, 'N').slice(0, 140);
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
  }
  out('pages', tally);
  out('item_failures', [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([why, n]) => ({ why, n })));
  // Routines and other workers' submissions on this project, by type.
  out('work_items', await q(`SELECT work_type, state, COUNT(*) AS n FROM work_items WHERE project_id = ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`, [project.id]));
  out('fragments', await q(`SELECT status, block_cause, COUNT(*) AS n FROM research_fragments WHERE project_id = ? GROUP BY 1, 2 ORDER BY n DESC`, [project.id]));
  // 3–4. Claims extracted, and those the gate accepted, with their sources.
  out('claims', await q(`SELECT c.accepted, COALESCE(c.retrieval_state, 'RETRIEVED') AS retrieval, COUNT(*) AS n, COUNT(DISTINCT c.source_url) AS sources FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? GROUP BY 1, 2 ORDER BY n DESC`, [project.id]));
  out('claims_by_lane', await q(`SELECT c.evidence_lane AS lane, c.accepted, COUNT(*) AS n FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`, [project.id]));
  out('claims_rejected_sample', await q(`SELECT c.evidence_lane AS lane, SUBSTR(c.claim, 1, 200) AS claim, c.source_url AS url, SUBSTR(COALESCE(c.validation_state, ''), 1, 40) AS state FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 0 ORDER BY c.created_at DESC LIMIT 8`, [project.id]));
  out('claims_accepted', await q(`SELECT c.id, c.evidence_lane AS lane, SUBSTR(c.claim, 1, 240) AS claim, c.source_url AS url, c.source_date AS date FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 ORDER BY c.created_at DESC LIMIT 40`, [project.id]));
  // 5. What reached the openings: card facts by kind, and every EVIDENCE fact with the claim it rests on.
  out('card_facts', await q(`SELECT f.kind, COUNT(*) AS n FROM cash_card_facts f WHERE f.project_id = ? GROUP BY 1`, [project.id]));
  out('evidence_facts', await q(`SELECT f.opportunity_id AS opening, f.field, SUBSTR(f.value, 1, 200) AS value, f.claim_id AS claim FROM cash_card_facts f WHERE f.project_id = ? AND f.kind = 'EVIDENCE' ORDER BY f.created_at`, [project.id]));
  // 6. What the route asks were shown, and what one would be shown now, verbatim.
  if (goal) {
    const asks = await q(`SELECT created_at AS at, summary, detail FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_ROUTES_PROPOSED' ORDER BY created_at`, [goal.id]);
    out('route_asks', asks.map((row) => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(String(row['detail'] ?? '{}')) as Record<string, unknown>;
      } catch {
        d = {};
      }
      return { at: row['at'], stage: d['stage'] ?? null, findingsSeen: d['findingsSeen'] ?? null, findingsShown: d['findingsShown'] ?? null, outcome: d['outcome'] ?? null, summary: String(row['summary'] ?? '').slice(0, 200) };
    }));
    const proposal = await import('../server/services/goals/routeProposal.ts');
    const { projectEvidenceClaims } = await import('../server/repos/research.ts');
    const findingsOf = (proposal as Record<string, unknown>)['findingsOf'] as ((claims: unknown[]) => { ref: string; lane: string | null; text: string; source: string; date: string | null }[]) | undefined;
    if (findingsOf) out('findings_now', findingsOf(await projectEvidenceClaims(project.id, 200)).map((one) => `${one.ref} [${one.lane}] ${one.text} (${one.source}, ${one.date ?? ''})`));
    // 7. The plan's own reading: what its best strategy still lacks.
    const { readGoalPlan } = await import('../server/services/goals/plan.ts');
    const reading = await readGoalPlan({ goalId: goal.id, persist: false }).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) }));
    if (reading && !('error' in reading)) {
      const r = reading as unknown as { verdict: string; chosen: string | null; strategies: { key: string; label: string; verdict: string; links: { link: string; ok: boolean; basis: string }[] }[] };
      const best = r.strategies.find((one) => one.key === r.chosen) ?? r.strategies[0];
      out('plan', { verdict: r.verdict, chosen: best?.label ?? null, missing: (best?.links ?? []).filter((one) => !one.ok).map((one) => `${one.link}: ${one.basis.slice(0, 140)}`) });
    } else out('plan', reading);
  }
  out('searches_24h', await q(`SELECT provider, outcome, COUNT(*) AS n FROM bin_events WHERE event_type = 'SOURCE_SEARCH' AND at > ? GROUP BY 1, 2 ORDER BY n DESC`, [new Date(Date.now() - 86_400_000).toISOString()]));
}

/**
 * probe --run R --case C [--batch-b64 facts]: one route ask for an evaluation
 * goal through Brain's own proposer code and production models, writing
 * nothing. Without facts it is shown the findings production holds (A); with
 * facts — sourced claims only, never a route — it is shown those through the
 * same findings interface (B). Prints the prompt's findings, each model's
 * reply and the routes the proposer's own parser and critic keep.
 */
async function probe(): Promise<void> {
  const run = safeId(flag('run'), '--run');
  const kase = safeId(flag('case'), '--case');
  const factsB64 = flag('batch-b64');
  const project = (await listProjects()).find((one) => one.name === projectName(run, kase));
  if (!project) fail(`no project for ${run} ${kase}`);
  const goal = (await listWorkstreams()).find((one) => one.projectId === project.id && !one.archivedAt);
  if (!goal) fail('no goal');
  const out = (label: string, value: unknown) => console.log(`PROBE ${label} ${JSON.stringify(value)}`);
  const P = (await import('../server/services/goals/routeProposal.ts')) as unknown as Record<string, (...args: unknown[]) => unknown>;
  const { readTarget } = await import('../server/services/goals/target.ts');
  const target = await readTarget(goal, new Date());
  if (!target) fail('no target');
  let supplied: unknown[] | null = null;
  if (factsB64) {
    const facts = JSON.parse(Buffer.from(factsB64, 'base64').toString('utf8')) as { claim: string; sourceUrl: string; sourceTitle?: string; sourceDate?: string | null; lane?: string }[];
    supplied = facts.map((one, i) => ({ id: `probe_${i + 1}`, claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: one.sourceTitle ?? null, sourcePublisher: null, sourceDate: one.sourceDate ?? null, evidenceLane: one.lane ?? null, retrievedAt: new Date().toISOString() }));
  }
  const deps = supplied ? { claims: async () => supplied } : {};
  const read = (await P['routeContext']!(goal, target, [], deps)) as { ctx: Record<string, unknown>; routes: unknown[] } | null;
  if (!read) fail('no context');
  const ctx = read.ctx;
  ctx['today'] = new Date().toISOString().slice(0, 10);
  const findings = (ctx['findings'] as unknown[] | undefined) ?? [];
  const scout = findings.length < 3;
  out('mode', { supplied: !!supplied, findings: findings.length, stage: scout ? 'SCOUT' : 'ROUTE' });
  out('findings', findings);
  const { modelsFor } = await import('../server/services/operator/run.ts');
  const { challengerModels } = await import('../server/services/operator/decisions.ts');
  const { chatFor } = await import('../server/services/cheap/modelBench.ts');
  const models = challengerModels(await modelsFor());
  out('models', models.map((m) => m.label));
  /*
   * Diagnostic variants, one variable at a time (passed in the `goal` input):
   * `hours0` states the zero owner hours the objective's words give; `labour`
   * lets offered labour use no stated skill; `clean` drops what earlier asks
   * held, scouted or refuted, so the facts are not anchored on old guesses.
   */
  const mode = flag('goal') ?? '';
  if (mode.includes('hours0')) {
    ctx['hoursLimit'] = 0;
    ctx['hoursPerWeek'] = null;
  }
  if (mode.includes('clean')) {
    ctx['held'] = [];
    ctx['scouted'] = [];
    ctx['refuted'] = [];
  }
  out('variant', mode || 'none');
  let prompt = String(scout ? P['directionPrompt']!(ctx) : P['routePrompt']!(ctx));
  // The fix on claude/owner-labour-consistency (operatingModelSentenceFor), applied to a deployed prompt's text.
  const { OPERATING_MODEL_SENTENCE } = await import('../server/domain/operatingModel.ts');
  const labour = ctx['ownerLabour'] as { offered?: boolean; evidence?: string } | null | undefined;
  const consistent = (text: string): string => {
    const at = text.indexOf(OPERATING_MODEL_SENTENCE);
    const tail = 'count every one of those hours.';
    const end = text.indexOf(tail, at);
    if (!labour?.offered || at < 0 || end <= at) return text;
    return (
      text.slice(0, at) +
      `For this goal the owner offered their own work ("${labour.evidence}"), so the standing rule that the owner does no physical work does not apply to it: ` +
      'routes the owner personally performs — in person, deliveries, shifts, gigs and services included — are allowed, inside their stated hours, ' +
      'using the skills and assets their words state or work that needs no particular skill, licence or equipment they did not state. ' +
      'Set performer OWNER and count every one of those hours. Work can also be done by an independent supplier or subcontractor that this operation coordinates, ' +
      'and AI and software should do as much of the remaining work as possible.' +
      text.slice(end + tail.length)
    );
  };
  const fixed = mode.includes('fixed');
  if (mode.includes('consistent') || fixed) {
    const before = prompt;
    prompt = consistent(prompt);
    out('consistent', prompt !== before ? 'applied' : { offered: !!labour?.offered });
  }
  // `fixed` also applies the branch's hours rule (one sale must fit: parsed against one sale's worth of target) and the critic's combining sentence.
  const parseCtx = fixed ? { ...ctx, remaining: 1 } : ctx;
  const criticText = (text: string): string =>
    fixed
      ? consistent(text).replace("for a product that would fit any request. Then rank", "for a product that would fit any request. The plan combines the routes you keep and holds their hours, capital and money together, so never drop a route only because it alone collects part of the money still needed; judge whether it pays inside the window. Then rank")
      : text;
  if (mode.includes('labour')) prompt = prompt.replace('using only the skills and assets their words state and inside their stated hours', 'using the skills and assets their words state, or work that needs none, inside their stated hours');
  const system = "You are Brain's commercial strategist. You read the owner first and propose whole, concrete routes to money built from what they have, inside their limits. Answer with exactly one JSON object.";
  for (const model of models) {
    const chat = chatFor({ label: model.label, url: model.baseUrl, key: model.apiKey, model: model.model, usdPerHour: null }, fetch, 240_000);
    const r = await chat([{ role: 'system', content: system }, { role: 'user', content: prompt }], undefined, 4000);
    out('reply', { model: model.label, error: r.error ?? null, ms: r.ms, content: String(r.content ?? '').slice(0, 9000) });
    if (r.error || !r.content) continue;
    const parsed = scout ? P['parseDirections']!(r.content, ctx) : P['parseRoutes']!(P['routesJson']!(r.content), parseCtx);
    out('parsed', parsed);
    if (!scout) {
      const routes = (parsed as { routes: unknown[] }).routes;
      // As production does, the critique is asked of each model in turn until one is readable.
      let done = false;
      for (const judge of [model, ...models.filter((one) => one !== model)]) {
        const judgeChat = chatFor({ label: judge.label, url: judge.baseUrl, key: judge.apiKey, model: judge.model, usdPerHour: null }, fetch, 240_000);
        const critic = await judgeChat([{ role: 'system', content: "You are Brain's sceptical commercial reviewer. You judge whether each proposed route can really put money in this owner's hand inside their limits, repair what a changed field fixes, drop the rest and rank the survivors. Answer with exactly one JSON object." }, { role: 'user', content: criticText(String(P['critiquePrompt']!(ctx, routes, P['ownerProfileOf']!(r.content)))) }], undefined, 3000);
        const critique = critic.content ? P['critiqueJson']!(critic.content, routes.length) : null;
        if (!critique) {
          out('critique_unreadable', { model: judge.label, error: critic.error ?? null, chars: String(critic.content ?? '').length });
          continue;
        }
        out('critique', { model: judge.label, ...P['applyCritique']!(routes, critique, parseCtx) });
        done = true;
        break;
      }
      if (!done) out('critique', { error: 'unreadable from every model' });
    }
    break;
  }
}

/**
 * capacity: what research capacity Brain actually has and uses, read only.
 * Search providers and their ceilings (the configured value, never a key),
 * Firecrawl's own credit balance (its usage endpoint bills nothing), what was
 * searched and read over the last week, how often a ceiling was hit, and what
 * research is queued, blocked, accepted or never delivered.
 */
async function capacity(): Promise<void> {
  const out = (label: string, value: unknown) => console.log(`CAPACITY ${label} ${JSON.stringify(value)}`);
  const q = (sql: string, params: SqlParam[] = []): Promise<Record<string, unknown>[]> => getDb().all<Record<string, unknown>>(sql, params).catch((error: unknown) => [{ error: String((error as Error)?.message ?? error).slice(0, 300) }] as Record<string, unknown>[]);
  const ks = await import('../server/services/sources/keyedSearch.ts');
  out('providers', ks.KEYED_SEARCH_PROVIDERS.map((p) => ({ id: p.id, ceiling: ks.dailySearchCeiling(p, process.env), ceilingSetInEnv: /^\d+$/.test((process.env[p.ceilingEnv] ?? '').trim()), keyPresent: !!(process.env[p.id === 'firecrawl' ? 'FIRECRAWL_API_KEY' : 'BRAIN_SEARCH_API_KEY'] ?? '').trim() })));
  const key = (process.env['FIRECRAWL_API_KEY'] ?? '').trim();
  if (key) {
    for (const path of ['/v1/team/credit-usage', '/v2/team/credit-usage']) {
      try {
        const res = await fetch(`https://api.firecrawl.dev${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        out('firecrawl_credits', { path, status: res.status, body: text.slice(0, 400) });
        if (res.ok) break;
      } catch (error) {
        out('firecrawl_credits', { path, error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    }
  }
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  out('searches_by_day', await q(`SELECT SUBSTR(at, 1, 10) AS day, provider, outcome, COUNT(*) AS n FROM bin_events WHERE event_type = 'SOURCE_SEARCH' AND at > ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [week]));
  out('firecrawl_ceiling_first_hit', await q(`SELECT SUBSTR(at, 1, 10) AS day, MIN(at) AS first, COUNT(*) AS n FROM bin_events WHERE event_type = 'SOURCE_SEARCH' AND provider = 'firecrawl' AND outcome = 'CEILING' AND at > ? GROUP BY 1 ORDER BY 1`, [week]));
  const items = await q(`SELECT outcome, reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at > ?`, [day]);
  const t = { items: items.length, submitted: 0, other: 0, searched: 0, readFromSearch: 0, readFromModel: 0 };
  const why = new Map<string, number>();
  for (const row of items) {
    if (row['outcome'] === 'SUBMITTED') t.submitted += 1;
    else {
      t.other += 1;
      const w = String(row['reason'] ?? '').replace(/^model [^:]+: /, '').replace(/\{[^}]*\}/g, '{…}').replace(/\d+/g, 'N').slice(0, 90);
      why.set(w, (why.get(w) ?? 0) + 1);
    }
    try {
      const d = (JSON.parse(String(row['measures'] ?? '{}')) as { discovery?: { searched?: number; readFromSearch?: number; readFromModel?: number } }).discovery;
      if (d) {
        t.searched += d.searched ?? 0;
        t.readFromSearch += d.readFromSearch ?? 0;
        t.readFromModel += d.readFromModel ?? 0;
      }
    } catch {
      // unreadable measures: counted as an item, not as pages
    }
  }
  out('free_lane_24h', t);
  out('free_lane_24h_failures', [...why].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w, n]) => ({ why: w, n })));
  out('claims_by_day', await q(`SELECT SUBSTR(created_at, 1, 10) AS day, accepted, COUNT(*) AS n FROM research_claims WHERE created_at > ? GROUP BY 1, 2 ORDER BY 1, 2`, [week]));
  out('fragments_all', await q(`SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest FROM research_fragments GROUP BY 1 ORDER BY n DESC`));
  out('fragments_eval', await q(`SELECT status, block_cause, COUNT(*) AS n, MIN(created_at) AS oldest FROM research_fragments WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Planning evaluation %') GROUP BY 1, 2 ORDER BY n DESC`));
  const evalSql = `CASE WHEN project_id IN (SELECT id FROM projects WHERE name LIKE 'Planning evaluation %') THEN 'eval' ELSE 'other' END`;
  out('work_waiting', await q(`SELECT ${evalSql} AS kind, work_type, state, COUNT(*) AS n, MIN(priority) AS pmin, MAX(priority) AS pmax, ROUND(AVG(priority), 1) AS pavg, MIN(created_at) AS oldest, SUM(CASE WHEN available_at > ? THEN 1 ELSE 0 END) AS deferred, SUM(CASE WHEN attempt_count >= max_attempts THEN 1 ELSE 0 END) AS exhausted FROM work_items WHERE state IN ('QUEUED', 'LEASED') GROUP BY 1, 2, 3 ORDER BY 1, n DESC`, [new Date().toISOString()]));
  out('work_done_24h', await q(`SELECT ${evalSql} AS kind, work_type, state, COUNT(*) AS n, ROUND(AVG(priority), 1) AS pavg FROM work_items WHERE updated_at > ? AND state NOT IN ('QUEUED', 'LEASED') GROUP BY 1, 2, 3 ORDER BY 1, n DESC`, [day]));
  out('eval_fragments_by_run', await q(`SELECT SUBSTR(p.name, 1, 40) AS run, f.status, COUNT(*) AS n FROM research_fragments f JOIN projects p ON p.id = f.project_id WHERE p.name LIKE 'Planning evaluation %' GROUP BY 1, 2 ORDER BY 1, 2`));
  out('eval_queue_by_run', await q(`SELECT SUBSTR(p.name, 21, 9) AS run, CASE WHEN w.cancelled_at IS NOT NULL THEN 'cancelled' WHEN w.paused_at IS NOT NULL THEN 'paused' WHEN w.id IS NULL THEN 'no goal' ELSE 'live' END AS goal, b.state AS bin, wi.state, COUNT(*) AS n, MIN(wi.created_at) AS oldest FROM work_items wi JOIN projects p ON p.id = wi.project_id LEFT JOIN workstreams w ON w.project_id = p.id AND w.archived_at IS NULL LEFT JOIN bins b ON b.id = wi.bin_id WHERE p.name LIKE 'Planning evaluation %' AND wi.state IN ('QUEUED', 'LEASED') GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`));
  out('fragments_done_24h', await q(`SELECT status, COUNT(*) AS n FROM research_fragments WHERE updated_at > ? AND status IN ('ACCEPTED', 'BLOCKED', 'REJECTED', 'NOTHING_SURVIVED') GROUP BY 1`, [day]));
}

console.log(`SERVING_REVISION ${process.env['BRAIN_REVISION'] ?? '<unstamped>'}`);
await initDatabase();
try {
  if (command === 'create') await create();
  else if (command === 'read') await read();
  else if (command === 'update') await update();
  else if (command === 'stall') await stall();
  else if (command === 'retire') await retire();
  else if (command === 'trace') await trace();
  else if (command === 'probe') await probe();
  else if (command === 'capacity') await capacity();
  else fail('command must be create | read | update | stall');
  console.log('PLANNING_EVAL: OK');
} finally {
  await closeDatabase();
}
