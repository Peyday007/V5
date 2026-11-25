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

console.log(`SERVING_REVISION ${process.env['BRAIN_REVISION'] ?? '<unstamped>'}`);
await initDatabase();
try {
  if (command === 'create') await create();
  else if (command === 'read') await read();
  else if (command === 'update') await update();
  else if (command === 'stall') await stall();
  else fail('command must be create | read | update | stall');
  console.log('PLANNING_EVAL: OK');
} finally {
  await closeDatabase();
}
