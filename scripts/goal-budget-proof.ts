/**
 * The live GOAL_BUDGET journey, on the deployed Brain, through the real tick.
 *
 *   npm run goal-budget-proof -- open <project> --admin someone@example.com
 *   npm run goal-budget-proof -- report <project>
 *   npm run goal-budget-proof -- explain <project>
 *
 * `open` approves seven research goals once, in a fixed order, and then does
 * nothing else: every packet after that is created by the Russell tick's own
 * continuation pass, which is what is being proved.
 *
 *   - Five goals whose assignment the archive already answers, chosen by asking
 *     the same classifier the pass asks (`coverBeforeWork`, read-only) about the
 *     archive's own claims. Each must create zero packets.
 *   - One goal that genuinely needs research, opened after those five. Under
 *     the old `ORDER BY created_at LIMIT 5` it would never have been considered;
 *     it must get packet round-1 within two ticks, and round-2 by itself if
 *     round-1 leaves its assignment unresolved.
 *   - One goal with a one-fragment ceiling, which must stop at its ceiling
 *     rather than creating work past it.
 *
 * Nothing is fabricated: no row is written here except the goals themselves
 * (through `createResearchGoal`, the function both opening doors call) and
 * their identity audit. `report` reads rows only.
 *
 * Ceilings are small and money is zero by construction, so the most this can
 * spend is a handful of research packets inside the fixed subscription fleet.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { getProject, getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import { listLayers } from '../server/repos/layers.ts';
import { listUsers, recordIdentityEvent } from '../server/repos/identity.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { inventoryProject } from '../server/services/reconcile/plan.ts';
import { coverBeforeWork } from '../server/services/russell/coverage.ts';
import { sharedClaimsForProject } from '../server/services/knowledge/shared.ts';

/** Every goal this proof opens carries this prefix, so a report finds exactly them. */
export const PROOF_PREFIX = 'GOAL_BUDGET live proof';
const COVERED_GOALS = 5;

/** A question no archive in this Brain is expected to settle, so it needs research. */
const OPEN_QUESTION =
  'What per-minute rates do US general transcription services publish on their own pricing pages ' +
  'in 2026, and how wide is the published range between the cheapest and the most expensive?';

function fail(message: string): never {
  console.error(message);
  console.log('GOAL-BUDGET-PROOF: FAILED');
  process.exit(1);
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function projectFrom(ref: string) {
  const project = (await getProject(ref)) ?? (await getProjectBySlug(ref));
  if (project) return project;
  for (const candidate of await listProjects()) console.error(`  ${candidate.id}  ${candidate.slug}  ${candidate.name}`);
  fail(`No project ${ref}.`);
}

async function open(projectRef: string): Promise<void> {
  const email = flag('admin') ?? fail('open changes something, so it needs --admin <email>.');
  const admin = (await listUsers()).find((user) => user.email === email && user.isBrainAdmin && !user.disabledAt);
  if (!admin) fail(`${email} is not an enabled Brain administrator.`);
  const project = await projectFrom(projectRef);

  const existing = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_goals WHERE project_id = ? AND purpose = 'RESEARCH_GOAL' AND name LIKE ?`,
    [project.id, `${PROOF_PREFIX}%`],
  );
  if (existing.length > 0) fail(`This project already holds ${existing.length} proof goal(s); run report instead.`);

  const layers = await listLayers(project.id);
  const layer = layers[0] ?? fail('This project has no layer to file research under.');

  // The pass's own reading of the archive, so a goal chosen as covered here is
  // covered by the same rule the pass applies.
  const inventory = await inventoryProject(project.id);
  const shared = await sharedClaimsForProject(project.id);
  const statements = [...new Set([...inventory.claims, ...shared].map((claim) => claim.claim.trim()))]
    .filter((statement) => statement.length >= 40 && statement.length <= 400);
  const covered: string[] = [];
  for (const statement of statements) {
    if (covered.length === COVERED_GOALS) break;
    const verdict = await coverBeforeWork({
      projectId: project.id,
      layerId: layer.id,
      claims: inventory.claims,
      requirements: [{ key: 'goal-assignment', statement, necessity: 'MANDATORY' }],
    });
    if (verdict.fullyAnswered) covered.push(statement);
  }
  console.log(`archive: ${inventory.documentsRead} document(s) read, ${inventory.claims.length} own + ${shared.length} shared claim(s), ${statements.length} candidate statement(s)`);
  if (covered.length < COVERED_GOALS) {
    fail(`The archive settles only ${covered.length} candidate assignment(s); the proof needs ${COVERED_GOALS}.`);
  }
  const openVerdict = await coverBeforeWork({
    projectId: project.id,
    layerId: layer.id,
    claims: inventory.claims,
    requirements: [{ key: 'goal-assignment', statement: OPEN_QUESTION, necessity: 'MANDATORY' }],
  });
  if (openVerdict.fullyAnswered) fail('The archive already answers the open question, so it proves nothing.');

  const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const plan = [
    ...covered.map((assignment, index) => ({
      name: `${PROOF_PREFIX} — covered ${index + 1}`,
      assignment,
      maxPackets: 2,
      maxFragments: 4,
    })),
    { name: `${PROOF_PREFIX} — continues`, assignment: OPEN_QUESTION, maxPackets: 2, maxFragments: 12 },
    { name: `${PROOF_PREFIX} — ceiling`, assignment: OPEN_QUESTION, maxPackets: 1, maxFragments: 1 },
  ];
  for (const goal of plan) {
    const created = await createResearchGoal({
      projectId: project.id,
      ownerUserId: admin!.id,
      createdByUserId: admin!.id,
      name: goal.name,
      maxPackets: goal.maxPackets,
      maxFragments: goal.maxFragments,
      deadline,
      researchAssignment: goal.assignment,
      researchLayerId: layer.id,
    });
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: admin!.id,
      action: 'OPEN_RESEARCH_GOAL',
      targetType: 'PROJECT',
      targetId: project.id,
      projectId: project.id,
      result: 'SUCCESS',
      metadata: { goalId: created.id, maxPackets: String(goal.maxPackets), maxFragments: String(goal.maxFragments) },
    });
    console.log(`opened ${created.id}  ${goal.name}  packets<=${goal.maxPackets} fragments<=${goal.maxFragments}`);
    // Distinct created_at, so the order the old pass would have used is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  console.log(`layer ${layer.id} (${layer.name}); deadline ${deadline}; approved once by ${admin!.id}`);
}

async function report(projectRef: string): Promise<void> {
  const project = await projectFrom(projectRef);
  const db = getDb();
  const goals = await db.all<{
    id: string; name: string; state: string; max_missions: number; max_fragments: number;
    created_at: string; research_considered_at: string | null; research_archive_marker: string | null;
  }>(
    `SELECT id, name, state, max_missions, max_fragments, created_at, research_considered_at, research_archive_marker
       FROM russell_goals WHERE project_id = ? AND purpose = 'RESEARCH_GOAL' AND name LIKE ?
      ORDER BY created_at, id`,
    [project.id, `${PROOF_PREFIX}%`],
  );
  if (goals.length === 0) fail('No proof goals in this project; run open first.');
  console.log(`now ${new Date().toISOString()}  project ${project.id}`);
  for (const goal of goals) {
    const packets = await db.all<{ id: string; goal_packet_key: string; status: string; created_at: string }>(
      'SELECT id, goal_packet_key, status, created_at FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at, id',
      [goal.id],
    );
    const fragments = await db.all<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM research_fragments f JOIN research_orchestrations o ON o.id = f.orchestration_id
        WHERE o.goal_id = ?`,
      [goal.id],
    );
    const requests = await db.all<{ state: string; resume_key: string }>(
      `SELECT state, resume_key FROM russell_human_requests WHERE resume_key LIKE ?`,
      [`goal-budget:${goal.id}:%`],
    );
    console.log(`${goal.id}  ${goal.name}  ${goal.state}`);
    console.log(`    ceilings packets=${goal.max_missions} fragments=${goal.max_fragments}  created ${goal.created_at}`);
    console.log(`    considered ${goal.research_considered_at ?? 'never'}  archive-answered ${goal.research_archive_marker ? 'yes' : 'no'}`);
    console.log(`    packets ${packets.length}  fragments ${Number(fragments[0]?.n ?? 0)}`);
    for (const packet of packets) console.log(`      ${packet.goal_packet_key}  ${packet.id}  ${packet.status}  ${packet.created_at}`);
    for (const request of requests) console.log(`    ceiling request ${request.state}  ${request.resume_key}`);
  }
  const duplicates = await db.all<{ goal_id: string; goal_packet_key: string; n: number | string }>(
    `SELECT o.goal_id, o.goal_packet_key, COUNT(*) AS n FROM research_orchestrations o
       JOIN russell_goals g ON g.id = o.goal_id
      WHERE g.project_id = ? AND g.name LIKE ?
      GROUP BY o.goal_id, o.goal_packet_key HAVING COUNT(*) > 1`,
    [project.id, `${PROOF_PREFIX}%`],
  );
  console.log(`duplicate packets: ${duplicates.length}`);
  const stops = await db.all<{ created_at: string; payload: string }>(
    `SELECT created_at, payload FROM project_events
      WHERE project_id = ? AND event_type = 'RESEARCH_GOAL_BUDGET_STOPPED' ORDER BY created_at`,
    [project.id],
  );
  for (const stop of stops) console.log(`stopped ${stop.created_at}  ${stop.payload.slice(0, 200)}`);
}

/**
 * What the archive says about each proof goal now, through the pass's own
 * reading. `inventoryProject` is the pass's first step and is idempotent; the
 * verdict itself writes nothing.
 */
async function explain(projectRef: string): Promise<void> {
  const project = await projectFrom(projectRef);
  const goals = await getDb().all<{ id: string; name: string; research_assignment: string; research_layer_id: string }>(
    `SELECT id, name, research_assignment, research_layer_id FROM russell_goals
      WHERE project_id = ? AND purpose = 'RESEARCH_GOAL' AND name LIKE ? ORDER BY created_at, id`,
    [project.id, `${PROOF_PREFIX}%`],
  );
  const inventory = await inventoryProject(project.id);
  for (const goal of goals) {
    const verdict = await coverBeforeWork({
      projectId: project.id,
      layerId: goal.research_layer_id,
      claims: inventory.claims,
      requirements: [{ key: 'goal-assignment', statement: goal.research_assignment, necessity: 'MANDATORY' }],
    });
    const one = verdict.verdicts[0];
    console.log(`${goal.id}  ${goal.name}  fullyAnswered=${verdict.fullyAnswered}  status=${one?.status}`);
    console.log(`    assignment ${goal.research_assignment.slice(0, 160)}`);
    for (const reason of one?.reasons ?? []) console.log(`    reason ${String(reason).slice(0, 300)}`);
    console.log(`    claims ${(one?.claimIds ?? []).slice(0, 8).join(' ')}`);
  }
}

async function main(): Promise<void> {
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '1';
  await initDatabase();
  const [command, projectRef] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith('--') && !all[index - 1]?.startsWith('--'));
  if (!projectRef) fail('Usage: goal-budget-proof (open|report|explain) <project> [--admin email]');
  if (command === 'open') await open(projectRef);
  else if (command === 'report') await report(projectRef);
  else if (command === 'explain') await explain(projectRef);
  else fail(`Unknown command ${command}.`);
  console.log('GOAL-BUDGET-PROOF: OK');
}

main()
  .catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
  .finally(() => void closeDatabase());
