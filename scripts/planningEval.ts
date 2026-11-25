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
 *   update --goal G --objective-b64 <words>
 *       A mid-course change in the owner's words, applied through the same
 *       writer the owner's own change uses.
 *
 * Nothing here approves, spends, contacts or sends. The request texts are not
 * in the repository: an evaluator holds them, so no implementing agent can fit
 * Brain to them.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
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
    };
    console.log(`EVAL_CASE ${kase} ${JSON.stringify(out)}`);
  }
  console.log(`EVAL_READ ${run} ${projects.length} case(s)`);
}

await initDatabase();
try {
  if (command === 'create') await create();
  else if (command === 'read') await read();
  else if (command === 'update') await update();
  else fail('command must be create | read | update');
  console.log('PLANNING_EVAL: OK');
} finally {
  await closeDatabase();
}
