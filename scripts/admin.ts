/**
 * `npm run admin` — emergency administration, on a terminal rather than a page.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and why it is not a website
 * ---------------------------------------------------------------------------
 *
 * The operator console held two different kinds of thing and treated them as
 * one. Some were decisions a person makes about their own project — what
 * Russell may spend, whether to approve a plan, whether to connect a site —
 * and those belong on the surface they already use; they are in Needs You and
 * Connected sites now. The rest were **internal machinery**: hand-queueing a
 * work item, starting a packet by id, reissuing a verification that finished
 * without performing, archiving an identity. Those are not a workflow, and a
 * browser page for them is a standing invitation to operate the inside of the
 * Brain by hand.
 *
 * So they moved here. Reaching this shell is the authentication — the same
 * reasoning `verify-hosted.ts` and `authorize-gap-policy.ts` already run on —
 * and `--admin` is the attribution, resolved against the database rather than
 * trusted, because an audit row with no author answers nothing later.
 *
 * **It issues no site credential.** Connecting a site is a person's decision
 * and it lives in Connected sites, which shows the secret once to somebody
 * signed in. A terminal that could mint one would be the console again, with
 * fewer witnesses.
 *
 *   npm run admin -- workers list
 *   npm run admin -- workers disable <name> --admin someone@example.com
 *   npm run admin -- workers archive <name> --admin someone@example.com
 *   npm run admin -- projects list
 *   npm run admin -- projects create "A name" --admin someone@example.com
 *   npm run admin -- access grant <worker> <project> --admin someone@example.com
 *   npm run admin -- access revoke <worker> <project> --admin someone@example.com
 *   npm run admin -- queue list <project>
 *   npm run admin -- packets list <project>
 *   npm run admin -- packets approve <orchestration> --admin someone@example.com
 *   npm run admin -- packets retry-fragment <fragment> --admin someone@example.com
 *   npm run admin -- packets reissue <workItem> --admin someone@example.com
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import {
  archiveWorker,
  getUserByEmail,
  getWorkerByName,
  grantMembership,
  listMembershipsForPrincipal,
  listUsers,
  listWorkers,
  recordIdentityEvent,
  revokeMembership,
  setWorkerStatus,
} from '../server/repos/identity.ts';
import { createProject, getProject, getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { listOrchestrationsByProject, currentFragments } from '../server/repos/research.ts';
import { approvePlan } from '../server/services/research/packetRunner.ts';
import { reissueMissingVerification, retryFragment } from '../server/services/research/reissue.ts';
import { CONNECTOR_SCOPES } from '../server/domain/types.ts';
import type { User } from '../server/domain/types.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function words(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value.startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(value);
  }
  return out;
}

function fail(message: string): never {
  console.error(message);
  console.log('ADMIN: FAIL');
  process.exitCode = 1;
  throw new Halt();
}

class Halt extends Error {}

/** A write needs somebody's name on it. A read does not. */
async function administrator(): Promise<User> {
  const email = flag('admin');
  const enabled = (await listUsers()).filter((user) => user.isBrainAdmin && !user.disabledAt);
  if (!email) {
    console.error('This changes something, so it needs --admin <email> to record it against.');
    console.error(
      enabled.length === 0
        ? '  This Brain has no enabled administrator.'
        : `  Enabled administrators: ${enabled.map((user) => user.email).join(', ')}`,
    );
    fail('No administrator was named.');
  }
  const user = await getUserByEmail(email);
  if (!user || !user.isBrainAdmin || user.disabledAt) {
    console.error(`${email} is not an enabled administrator of this Brain.`);
    console.error(
      enabled.length === 0
        ? '  This Brain has no enabled administrator.'
        : `  Enabled administrators: ${enabled.map((u) => u.email).join(', ')}`,
    );
    fail('The change needs a real administrator on it.');
  }
  return user;
}

async function projectFrom(ref: string) {
  const project = (await getProject(ref)) ?? (await getProjectBySlug(ref));
  if (!project) {
    console.error(`No project ${ref}. This Brain holds:`);
    for (const candidate of await listProjects()) {
      console.error(`  ${candidate.id}  ${candidate.slug}  ${candidate.name}`);
    }
    fail('No such project.');
  }
  return project;
}

async function workerFrom(ref: string) {
  const worker = await getWorkerByName(ref);
  if (!worker) {
    console.error(`No worker ${ref}. This Brain holds:`);
    for (const candidate of await listWorkers({ includeArchived: true })) {
      console.error(`  ${candidate.name}  ${candidate.status}`);
    }
    fail('No such worker.');
  }
  return worker;
}

const HELP = `Usage: npm run admin -- <area> <command> [...] [--admin someone@example.com]

  workers   list | disable <name> | enable <name> | archive <name>
  projects  list | create <name>
  access    show <worker> | grant <worker> <project> | revoke <worker> <project>
  queue     list <project>
  packets   list <project> | approve <orchestration>
            retry-fragment <fragment> | reissue <workItem>

Connecting a site is not here. It is a person's decision and it lives in
Russell, under Connected sites, which is the only place a site credential is
ever shown.`;

async function main(): Promise<void> {
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();

  const [area, command, ...rest] = words();
  if (!area || !command) {
    console.log(HELP);
    console.log('ADMIN: OK');
    return;
  }

  switch (`${area} ${command}`) {
    case 'workers list': {
      for (const worker of await listWorkers({ includeArchived: true })) {
        const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
        console.log(
          `  ${worker.name.padEnd(28)} ${worker.status.padEnd(10)} ${memberships.length} project(s)`,
        );
      }
      break;
    }
    case 'workers disable':
    case 'workers enable': {
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const status = command === 'disable' ? 'DISABLED' : 'ACTIVE';
      await setWorkerStatus(worker.id, status);
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: command === 'disable' ? 'DISABLE_WORKER' : 'ENABLE_WORKER',
        targetType: 'WORKER',
        targetId: worker.id,
        result: 'SUCCESS',
      });
      console.log(`  ${worker.name} is now ${status}.`);
      break;
    }
    case 'workers archive': {
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      await archiveWorker(worker.id);
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'ARCHIVE_WORKER',
        targetType: 'WORKER',
        targetId: worker.id,
        result: 'SUCCESS',
      });
      console.log(`  ${worker.name} is archived. Its rows and its audit history stay.`);
      break;
    }
    case 'projects list': {
      for (const project of await listProjects()) {
        console.log(`  ${project.id}  ${project.slug.padEnd(24)} ${project.name}`);
      }
      break;
    }
    case 'projects create': {
      const actor = await administrator();
      const name = rest.join(' ').trim() || fail('Name the project.');
      const project = await createProject({ name });
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'CREATE_PROJECT',
        targetType: 'PROJECT',
        targetId: project.id,
        projectId: project.id,
        result: 'SUCCESS',
      });
      console.log(`  ${project.id}  ${project.slug}  ${project.name}`);
      break;
    }
    case 'access show': {
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      for (const membership of await listMembershipsForPrincipal('WORKER', worker.id)) {
        const project = await getProject(membership.projectId);
        console.log(
          `  ${(project?.name ?? membership.projectId).padEnd(28)} ${membership.scopes.join(', ')}`,
        );
      }
      break;
    }
    case 'access grant': {
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const project = await projectFrom(rest[1] ?? fail('Name a project.'));
      /*
       * The research set only. A connected site's set is applied by
       * `connectSite`, from the constant, and is deliberately not reachable
       * from here: the whole point of moving that journey was that the choice
       * between two scope sets had a silent wrong answer.
       */
      await grantMembership({
        projectId: project.id,
        principalType: 'WORKER',
        principalId: worker.id,
        role: null,
        scopes: [...CONNECTOR_SCOPES],
        grantedByType: 'HUMAN',
        grantedById: actor.id,
      });
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'GRANT_MEMBERSHIP',
        targetType: 'WORKER',
        targetId: worker.id,
        projectId: project.id,
        result: 'SUCCESS',
        metadata: { scopes: [...CONNECTOR_SCOPES].join(','), kind: 'RESEARCH' },
      });
      console.log(`  ${worker.name} researches for ${project.name}.`);
      break;
    }
    case 'access revoke': {
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const project = await projectFrom(rest[1] ?? fail('Name a project.'));
      const changed = await revokeMembership(project.id, 'WORKER', worker.id);
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'REVOKE_MEMBERSHIP',
        targetType: 'WORKER',
        targetId: worker.id,
        projectId: project.id,
        result: 'SUCCESS',
      });
      console.log(changed ? `  ${worker.name} no longer reaches ${project.name}.` : '  Nothing to revoke.');
      break;
    }
    case 'queue list': {
      const project = await projectFrom(rest[0] ?? fail('Name a project.'));
      for (const item of await listWorkItems(project.id, { limit: 100 })) {
        console.log(
          `  ${item.id}  ${item.workType.padEnd(24)} ${item.state.padEnd(12)} attempts ${item.attemptCount}`,
        );
      }
      break;
    }
    case 'packets list': {
      const project = await projectFrom(rest[0] ?? fail('Name a project.'));
      for (const orchestration of await listOrchestrationsByProject(project.id)) {
        const fragments = await currentFragments(orchestration.id);
        console.log(
          `  ${orchestration.id}  ${orchestration.status.padEnd(16)} ${fragments.length} fragment(s)`,
        );
      }
      break;
    }
    case 'packets approve': {
      const actor = await administrator();
      const id = rest[0] ?? fail('Name an orchestration.');
      const result = await approvePlan({ orchestrationId: id, approvedByUserId: actor.id });
      console.log(`  ${JSON.stringify(result)}`);
      break;
    }
    case 'packets retry-fragment': {
      const actor = await administrator();
      const id = rest[0] ?? fail('Name a fragment.');
      const result = await retryFragment({
        fragmentId: id,
        reason: flag('reason') ?? 'Retried by an administrator from the terminal.',
        actor: { type: 'HUMAN', id: actor.id },
        advance: true,
      });
      console.log(`  ${JSON.stringify(result)}`);
      break;
    }
    case 'packets reissue': {
      const actor = await administrator();
      const id = rest[0] ?? fail('Name a work item.');
      const result = await reissueMissingVerification({
        workItemId: id,
        actor: { type: 'HUMAN', id: actor.id },
      });
      console.log(`  ${JSON.stringify(result)}`);
      break;
    }
    default:
      console.log(HELP);
      fail(`Unknown command: ${area} ${command}`);
  }

  console.log('ADMIN: OK');
}

main()
  .catch((error: unknown) => {
    if (error instanceof Halt) return;
    console.error(error instanceof Error ? error.message : String(error));
    console.log('ADMIN: FAIL');
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
