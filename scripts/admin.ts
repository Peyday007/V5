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
 *   npm run admin -- routing show
 *   npm run admin -- routing check <worker> <bin>
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
 *   npm run admin -- packets independence [project]
 *   npm run admin -- packets reaudit <orchestration> --admin someone@example.com
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import {
  requestIntegrityReaudit,
  scanAuthorReviewerOverlap,
} from '../server/services/audit/integrityReaudit.ts';
import {
  archiveWorker,
  clearWorkerRouting,
  getUserByEmail,
  getWorkerRouting,
  listWorkerRouting,
  setWorkerRouting,
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
import {
  WORKLOAD_FAMILIES,
  decideBinRouting,
  familyOf,
  repositoryIdOf,
} from '../server/services/bins/routing.ts';
import type { Principal, User } from '../server/domain/types.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/**
 * A comma-separated flag as a list, with blanks dropped.
 *
 * Its own helper so `--families ''` and an absent flag are the same empty list:
 * "set this worker to serve nothing" has to be spelled deliberately, and
 * `routing retire` is the command that spells it.
 */
function list(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
  routing   show | check <worker> <bin>
            set <worker> --families A,B [--repositories o/r,...]
                   [--capabilities a,b] --reason "why"
            clear <worker> | retire <worker> --reason "why"
  projects  list | create <name>
  access    show <worker> | grant <worker> <project> | revoke <worker> <project>
  queue     list <project>
  packets   list <project> | approve <orchestration>
            independence [project] | reaudit <orchestration>
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
        // The id as well as the name: every other operator surface — `fleet show`,
        // a dispatch row, a ledger entry — names a worker by id, and a listing you
        // cannot join to those is a listing you have to guess against.
        console.log(
          `  ${worker.name.padEnd(28)} ${worker.id}  ${worker.status.padEnd(10)} ` +
            `${memberships.length} project(s)`,
        );
      }
      break;
    }
    /*
     * What a worker may be handed. See `services/bins/routing.ts`.
     *
     * Here rather than on a surface, because it is not a decision about somebody's
     * own project — it is internal machinery, and §26's rule is that machinery
     * belongs on a terminal where reaching the shell is the authentication. The
     * `--admin` attribution is resolved against the database rather than trusted,
     * and every change lands in `identity_events` with both values, because a
     * boundary nobody can later explain is indistinguishable from one that
     * widened itself.
     */
    case 'routing show': {
      const rows = await listWorkerRouting();
      const byId = new Map((await listWorkers({ includeArchived: true })).map((w) => [w.id, w]));
      if (rows.length === 0) {
        console.log('  no worker has an explicit routing scope');
      }
      for (const row of rows) {
        const worker = byId.get(row.workerId);
        const families = row.families.length > 0 ? row.families.join(',') : '(none — serves nothing)';
        console.log(
          `  ${(worker?.name ?? row.workerId).padEnd(28)} ${row.workerId}  families=[${families}] ` +
            `repositories=[${row.repositories.join(',')}] ` +
            `capabilities=[${row.capabilities.join(',')}]`,
        );
        console.log(`      ${row.reason}  (set by ${row.setBy})`);
      }
      /*
       * And the workers with no row, because "nothing is listed" and "nothing is
       * scoped" read the same otherwise — and a worker with no row is not
       * unrestricted, it serves what its scopes imply and no repository work.
       */
      const explicit = new Set(rows.map((row) => row.workerId));
      const implicit = [...byId.values()].filter((w) => !explicit.has(w.id) && w.status === 'ACTIVE');
      if (implicit.length > 0) {
        console.log('  derived (no explicit row — scopes imply the family, never repository work):');
        for (const worker of implicit) console.log(`      ${worker.name.padEnd(28)} ${worker.id}`);
      }
      break;
    }
    /*
     * Would this worker be handed this bin? A projection, and it says so: it reads
     * the worker's current memberships and routing row and asks the same function
     * the admission hook asks, so the answer is about production rows rather than
     * about a guess — but it authenticates nothing and claims nothing, and a real
     * claim is still decided inside the claim loop at the time it is made.
     */
    case 'routing check': {
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const binId = rest[1] ?? fail('Name a bin.');
      const { getBin } = await import('../server/repos/bins.ts');
      const bin = await getBin(binId);
      if (!bin) fail(`No bin ${binId}.`);
      const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
      const principal = {
        type: 'WORKER',
        id: worker.id,
        handle: worker.name,
        displayName: worker.name,
        isBrainAdmin: false,
        mustChangePassword: false,
        credentialId: null,
        authMethod: 'WORKER_BEARER',
        memberships,
        requestId: 'admin-routing-check',
      } as unknown as Principal;
      // The same reader the admission hook uses, so this cannot describe a scope
      // the claim would not apply.
      const { workerRoutingFor } = await import('../server/services/bins/service.ts');
      const routing = await workerRoutingFor(worker.id, principal);
      const decision = decideBinRouting({ bin, principal, routing });
      console.log(`  bin        ${bin.id}  ${bin.kind}  ${bin.state}  class=${bin.workloadClass ?? '—'}`);
      console.log(`  family     ${familyOf(bin)}  repository=${repositoryIdOf(bin) ?? '—'}`);
      console.log(`  worker     ${worker.name}  ${routing.explicit ? 'explicit' : 'derived'} ` +
        `families=[${routing.families.join(',')}] repositories=[${routing.repositories.join(',')}]`);
      console.log(`  decision   ${decision.ok ? 'WOULD BE HANDED IT' : decision.refusal}`);
      // A refusal names itself; an admission has nothing to explain beyond the
      // scope it was judged against, so that is what is printed.
      console.log(`  reason     ${decision.reason ?? routing.reason}`);
      break;
    }
    case 'routing set': {
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const families = list(flag('families'));
      const repositories = list(flag('repositories'));
      const capabilities = list(flag('capabilities'));
      const reason = flag('reason') ?? fail('Pass --reason: a scope with no recorded why is one nobody can explain later.');
      const unknown = families.filter((family) => !(WORKLOAD_FAMILIES as readonly string[]).includes(family));
      if (unknown.length > 0) {
        fail(`Unknown workload famil${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. One of: ${WORKLOAD_FAMILIES.join(', ')}.`);
      }
      /*
       * Repository work needs a repository. A FACTORY family with an empty list is
       * a worker that can be offered software work and authorized for none of it,
       * which is a scope that reads as a grant and behaves as a refusal.
       */
      if (families.includes('FACTORY') && repositories.length === 0) {
        fail('FACTORY work needs at least one --repositories <owner/name>; a family with no repository authorizes nothing.');
      }
      const before = await getWorkerRouting(worker.id);
      await setWorkerRouting({
        workerId: worker.id,
        families,
        repositories,
        capabilities,
        reason,
        setBy: `admin:${actor.id}`,
      });
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'SET_WORKER_ROUTING',
        targetType: 'WORKER',
        targetId: worker.id,
        result: 'SUCCESS',
        // Both values, because a boundary you cannot see the previous state of is
        // one nobody can say was narrowed or widened.
        metadata: {
          before: before
            ? { families: before.families, repositories: before.repositories, capabilities: before.capabilities }
            : null,
          after: { families, repositories, capabilities },
          reason,
        },
      });
      console.log(
        `  ${worker.name} now serves [${families.join(',') || '(nothing)'}]` +
          `${repositories.length > 0 ? ` for [${repositories.join(',')}]` : ''}.`,
      );
      break;
    }
    case 'routing retire': {
      /*
       * Retirement is a scope, not a deletion. An explicit row listing no family
       * is the only configuration in this system that means "serves nothing", and
       * it is the one that makes a retired surface unable to claim work while
       * every row it ever wrote stays attributable to it.
       */
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const reason = flag('reason') ?? fail('Pass --reason: why this surface is out of active dispatch.');
      const before = await getWorkerRouting(worker.id);
      await setWorkerRouting({
        workerId: worker.id,
        families: [],
        repositories: [],
        capabilities: [],
        reason,
        setBy: `admin:${actor.id}`,
      });
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'RETIRE_WORKER_ROUTING',
        targetType: 'WORKER',
        targetId: worker.id,
        result: 'SUCCESS',
        metadata: { before: before ? before.families : null, after: [], reason },
      });
      console.log(`  ${worker.name} is retired from active dispatch: it may be handed nothing.`);
      break;
    }
    case 'routing clear': {
      const actor = await administrator();
      const worker = await workerFrom(rest[0] ?? fail('Name a worker.'));
      const removed = await clearWorkerRouting(worker.id);
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'CLEAR_WORKER_ROUTING',
        targetType: 'WORKER',
        targetId: worker.id,
        result: removed ? 'SUCCESS' : 'FAILED',
      });
      console.log(
        removed
          ? `  ${worker.name} is back to the derived default: what its scopes imply, and no repository work.`
          : `  ${worker.name} had no explicit routing scope.`,
      );
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
    /*
     * The scope report, and it is read-only on purpose.
     *
     * "Which other packets have this problem" is a question a person asks
     * before deciding anything, and a command that answered it by reopening
     * what it found would be making that decision for them. It opens nothing.
     */
    case 'packets independence': {
      const project = rest[0] ? await projectFrom(rest[0]) : null;
      const findings = (await scanAuthorReviewerOverlap(500)).filter(
        (finding) => !project || finding.projectId === project.id,
      );
      if (findings.length === 0) {
        console.log('  No packet has a reviewer that shared a session with its author.');
        console.log('  (Packets with no completed audit or no completed synthesis are not');
        console.log('   in scope: there is nothing to compare.)');
        break;
      }
      for (const finding of findings) {
        console.log(
          `  ${finding.orchestrationId}  ${finding.status.padEnd(16)}` +
            `  reopen=${finding.reopenState ?? '—'}`,
        );
        if (finding.conflicted.length > 0) {
          console.log(`      AUTHOR REVIEWED: ${finding.conflicted.join(', ')}`);
        }
        if (finding.unattributed) {
          console.log(
            '      UNATTRIBUTED: a reviewer or the author recorded no session, so this one ' +
              'cannot be told either way',
          );
        }
      }
      console.log(
        `  ${findings.length} packet(s) need a decision. ` +
          'Reopening one is `packets reaudit <orchestration> --admin <email>`.',
      );
      break;
    }
    case 'packets reaudit': {
      const actor = await administrator();
      const id = rest[0] ?? fail('Name an orchestration.');
      const outcome = await requestIntegrityReaudit({
        orchestrationId: id,
        personId: actor.id,
      });
      console.log(`  ok        ${outcome.ok}`);
      console.log(`  created   ${outcome.created}`);
      if (outcome.refusal) console.log(`  refusal   ${outcome.refusal}`);
      console.log(`  detail    ${outcome.detail}`);
      if (outcome.reopen) {
        console.log(`  reopen    ${outcome.reopen.id}  ${outcome.reopen.state}`);
        console.log(`  document  ${outcome.reopen.documentVersion}  ${outcome.reopen.documentHash}`);
        console.log(`  rerun     ${outcome.reopen.rolesRerun.join(', ') || '—'}`);
        console.log(
          `  carried   ${outcome.reopen.rolesCarried.map((role) => role.role).join(', ') || '—'}`,
        );
        console.log(`  supersedes ${outcome.reopen.supersededAuditId ?? '—'}`);
      }
      if (outcome.binId) console.log(`  bin       ${outcome.binId}`);
      if (!outcome.ok) fail(outcome.detail);
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
