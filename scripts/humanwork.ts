/**
 * Work done through people, on a terminal.
 *
 *   npm run humanwork -- show [--project <id|slug>]
 *   npm run humanwork -- connect-capacity --project <id|slug> --member <user id>
 *                        [--due YYYY-MM-DD] --admin <email>
 *
 * `show` is read-only: it prints every piece of human work — the headline
 * Russell says, the stage, whether the person agreed and how that is known,
 * the next action and who owes it, what blocks it, each acceptance condition
 * with how it was judged, and money — and opens nothing.
 *
 * `connect-capacity` runs the reviewed `CONNECT_CLAUDE_CAPACITY` recipe: it
 * records on the labor map that a person produces the task (and why), opens
 * the work, records the member as the candidate, prepares no-charge terms and
 * puts the engagement decision in **Needs You**. It decides nothing: approving
 * is an administrator's answer on that card, and nothing here contacts anybody.
 * Reaching the shell is the authentication (§26); `--admin` is the attribution,
 * resolved against the database.
 *
 * Prints `HUMANWORK: OK` only where nothing failed, for `factory.yml`'s reason.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { getProject, getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import { getUserByEmail, listUsers } from '../server/repos/identity.ts';
import { humanWorkView } from '../server/services/humanwork/view.ts';
import { connectClaudeCapacity } from '../server/services/humanwork/recipes.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'show';
function flag(name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith('--') ? args[index + 1]! : null;
}

function fail(message: string): never {
  console.error(`HUMANWORK REFUSED ${message}`);
  process.exit(1);
}

async function projectFrom(ref: string) {
  const project = (await getProject(ref)) ?? (await getProjectBySlug(ref));
  if (!project) fail(`no project ${ref}`);
  return project;
}

async function admin() {
  const email = flag('admin');
  if (!email) fail('this changes something, so it needs --admin <email> to record it against');
  const user = await getUserByEmail(email);
  if (!user || !user.isBrainAdmin || user.disabledAt) fail(`${email} is not an enabled administrator of this Brain`);
  return user;
}

async function show(): Promise<void> {
  const only = flag('project');
  const projects = only ? [await projectFrom(only)] : await listProjects();
  let orders = 0;
  for (const project of projects) {
    const view = await humanWorkView(project.id);
    if (view.orders.length === 0) continue;
    console.log('');
    console.log(`HUMAN WORK — ${project.name} (${project.id})`);
    for (const line of view.briefing) console.log(`  RUSSELL  ${line}`);
    for (const one of view.orders) {
      orders += 1;
      console.log('');
      console.log(`  ${one.order.id}  ${one.stage}  ${one.order.title}`);
      console.log(`    task ${one.order.taskId}  allocation ${one.order.allocationId}  reason ${one.order.necessityReason}`);
      console.log(`    why a person: ${one.order.whyPerson}`);
      console.log(`    agreement: ${one.agreement}`);
      for (const { candidate, qualification } of one.candidates) {
        console.log(`    candidate ${candidate.id} ${candidate.relationship}${candidate.userId ? ` user=${candidate.userId}` : ''}: ${qualification.summary}`);
        for (const doubt of candidate.uncertainties) console.log(`      uncertain: ${doubt}`);
      }
      if (one.engagement) {
        const e = one.engagement;
        console.log(`    engagement ${e.id} ${e.state} funding=${e.funding ?? '—'} approvedBy=${e.approvedByUserId ?? '—'} card=${e.decisionRequestId ?? '—'}${one.decisionRequest ? ` (${one.decisionRequest.state})` : ''}`);
      }
      if (one.nextAction) console.log(`    NEXT (${one.nextAction.who}): ${one.nextAction.text}`);
      for (const blocker of one.blockers) console.log(`    BLOCKED (${blocker.who}): ${blocker.statement} -> ${blocker.remedy}`);
      for (const condition of one.conditions) {
        console.log(`    [${condition.verdict}] ${condition.key}: ${condition.statement} — ${condition.because}${condition.judgedBy ? ` (judged by ${condition.judgedBy})` : ''}`);
      }
      if (one.obligations) console.log(`    money: ${one.obligations.sentence}${one.obligations.hours !== null ? ` hours=${one.obligations.hours}` : ' hours=not recorded'}`);
      console.log(`    timing: engaged=${one.timing.engagedAt ?? '—'} accepted=${one.timing.acceptedAt ?? '—'} hours=${one.timing.hoursEngagedToAccepted ?? '—'}${one.timing.overdue.length ? ` overdue: ${one.timing.overdue.join('; ')}` : ''}`);
      for (const event of one.events.slice(-12)) console.log(`      ${event.createdAt}  ${event.kind.padEnd(22)} ${event.actor.padEnd(8)} ${event.summary}`);
    }
  }
  console.log('');
  console.log(`HUMANWORK: OK orders=${orders}${orders === 0 ? ' — no work here has been given to a person' : ''}`);
}

async function connectCapacity(): Promise<void> {
  const by = await admin();
  const project = await projectFrom(flag('project') ?? fail('--project is required'));
  const memberId = flag('member') ?? fail('--member <user id> is required');
  const members = await listUsers();
  if (!members.some((user) => user.id === memberId)) fail(`no user ${memberId}`);
  const result = await connectClaudeCapacity({
    projectId: project.id,
    memberUserId: memberId,
    actorRef: by.id,
    dueBy: flag('due'),
  });
  if (!result.ok) fail(result.reason);
  console.log(`order      ${result.value.order.id}`);
  console.log(`engagement ${result.value.engagement?.id ?? '—'} ${result.value.engagement?.state ?? ''}`);
  console.log(`decision   ${result.value.decision?.id ?? '—'} (Needs You, for an administrator of ${project.name})`);
  for (const note of result.value.notes) console.log(`note       ${note}`);
  console.log('Recorded against the named administrator, through the shell. Nothing was approved and nobody was contacted.');
  await show();
}

async function main(): Promise<void> {
  await initDatabase();
  if (command === 'show') return show();
  if (command === 'connect-capacity') return connectCapacity();
  process.exitCode = 1;
  console.error(`HUMANWORK REFUSED "${command}" is not a command. Commands: show, connect-capacity`);
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error(`HUMANWORK: FAILED ${pooler ?? String(error?.stack ?? error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
