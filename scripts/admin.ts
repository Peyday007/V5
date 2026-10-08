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
 *   npm run admin -- people list
 *   npm run admin -- people foundation
 *   npm run admin -- people rename <user|email> "A Name" --admin someone@example.com
 *   npm run admin -- capacity show
 *   npm run admin -- capacity adopt <user|email> <trig_…> --admin someone@example.com
 *   npm run admin -- workers list
 *   npm run admin -- workers create <name> [display name] --admin someone@example.com
 *   npm run admin -- routing show
 *   npm run admin -- routing check <worker> <bin>
 *   npm run admin -- workers disable <name> --admin someone@example.com
 *   npm run admin -- workers archive <name> --admin someone@example.com
 *   npm run admin -- research start <project> --admin someone@example.com
 *   npm run admin -- research start <project> --goal <goalId> --packet-key <key> [--bucket <id>] --admin someone@example.com
 *   npm run admin -- research goal create <project> --name "…" --max-packets N --max-fragments N --deadline ISO [--assignment "…" --layer <name|id>] --admin someone@example.com
 *   npm run admin -- research goal show <goalId>
 *   npm run admin -- research goal list <project>
 *   npm run admin -- projects list
 *   npm run admin -- projects create "A name" --admin someone@example.com
 *   npm run admin -- access grant <worker> <project> --admin someone@example.com
 *   npm run admin -- access revoke <worker> <project> --admin someone@example.com
 *   npm run admin -- queue list <project>
 *   npm run admin -- packets list <project>
 *   npm run admin -- packets approve <orchestration> --admin someone@example.com
 *   npm run admin -- packets retry-fragment <fragment> --admin someone@example.com
 *   npm run admin -- packets reissue <workItem> --admin someone@example.com
 *   npm run admin -- packets syntheses <project>
 *   npm run admin -- packets recover-synthesis <workItem> --admin someone@example.com
 *   npm run admin -- packets independence [project]
 *   npm run admin -- packets scope [project]
 *   npm run admin -- packets reaudit <orchestration> --admin someone@example.com
 *   npm run admin -- cash seed-industry <project> "<subject name>" --admin someone@example.com
 */
import { startPacket } from '../server/services/research/startPacket.ts';
import type { GoalBudgetStatus } from '../server/repos/russellAuthority.ts';
import {
  createResearchGoal,
  getGoal,
  goalBudgetStatus,
} from '../server/repos/russellAuthority.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { CASH_LAYER_NAME } from '../server/services/cash/lifecycle.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { createLayer, listLayers } from '../server/repos/layers.ts';
import { binForOrchestration, createBin } from '../server/repos/bins.ts';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import {
  requestIntegrityReaudit,
  scanAuthorReviewerOverlap,
} from '../server/services/audit/integrityReaudit.ts';
import { scopeIndependence } from '../server/services/audit/independenceScope.ts';
import {
  decisionsForRevision,
  digestRenderSet,
  recordDesignDecision,
  standingDecision,
  type DesignDecision,
} from '../server/repos/designApprovals.ts';
import {
  archiveWorker,
  clearWorkerRouting,
  getUser,
  getUserByEmail,
  getWorkerRouting,
  listWorkerRouting,
  setWorkerRouting,
  createWorker,
  getWorkerByName,
  grantMembership,
  listMembershipsForPrincipal,
  listUsers,
  renameUser,
  signInNameTaken,
  listWorkers,
  listIdentityEvents,
  recordIdentityEvent,
  revokeMembership,
  setWorkerStatus,
} from '../server/repos/identity.ts';
import { createProject, getProject, getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { foundationReading } from '../server/services/identity/foundation.ts';
import { countLivePasskeys } from '../server/repos/passkeys.ts';
import { listOrchestrationsByProject, currentFragments } from '../server/repos/research.ts';
import { approvePlan } from '../server/services/research/packetRunner.ts';
import { reissueMissingVerification, retryFragment } from '../server/services/research/reissue.ts';
import { CONNECTOR_SCOPES, IDENTITY_RESULTS, type IdentityResult } from '../server/domain/types.ts';
import {
  WORKLOAD_FAMILIES,
  decideBinRouting,
  familyOf,
  repositoryIdOf,
} from '../server/services/bins/routing.ts';
import type { Principal, User } from '../server/domain/types.ts';
import {
  assessProjectSyntheses,
  recoverFailedSynthesis,
} from '../server/services/research/synthesisRecovery.ts';
import { workerIdentity } from '../server/services/identity/authenticate.ts';
import { resolveWorkerRef } from '../server/services/identity/workerRef.ts';
import { refuseAddressAsName } from '../server/domain/personName.ts';
import { adoptSurface } from '../server/services/capacity/adopt.ts';
import { issueFactoryInvitation, repositoryOnboarding } from '../server/services/factory/onboard.ts';
import { listConnections } from '../server/repos/capacityConnections.ts';

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

async function printGoalBudget(status: GoalBudgetStatus): Promise<void> {
  const author = await getUser(status.authorizedBy);
  console.log(`  ${status.goalId}  ${status.name}  [${status.state}]`);
  console.log(`    packets     ${Math.max(status.packets.used, status.packets.reserved)} of ${status.packets.ceiling}`);
  console.log(`    fragments   ${status.fragments.committed} of ${status.fragments.ceiling}`);
  console.log(`    deadline    ${status.deadline ?? 'none'}`);
  console.log(`    authorized  ${author?.displayName ?? status.authorizedBy}  (${status.authorizedBy})`);
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

/**
 * The one place this script turns what somebody typed into a worker row.
 *
 * It resolves through `services/identity/workerRef.ts`, which accepts the two
 * identifiers `workers list` actually prints — the label and the id — as well
 * as the `workers.name` handle that used to be the only one. The defect it
 * closes is small and was expensive: an operator read `worker-05  wkr_…` off
 * the listing, typed either into `access grant`, and was told **No such
 * worker** by a refusal that then offered a third spelling the listing had
 * never shown them.
 *
 * So the refusal lists candidates the way the listing does, and for the same
 * reason the resolver exists at all: a listing and the command that consumes
 * it must not disagree about what a thing is called.
 */
async function workerFrom(ref: string) {
  const resolved = await resolveWorkerRef(ref);
  if (resolved.kind === 'FOUND') return resolved.worker;

  if (resolved.kind === 'AMBIGUOUS') {
    console.error(`"${ref}" names more than one worker:`);
    for (const candidate of resolved.matches) {
      console.error(`  ${workerIdentity(candidate).padEnd(12)} ${candidate.id}  ${candidate.name}`);
    }
    // Refused rather than chosen between: picking either would be a confident
    // answer to the wrong question, with every row reading healthy.
    fail('Ambiguous worker reference. Use the id.');
  }

  console.error(`No worker ${ref}. This Brain holds:`);
  for (const candidate of await listWorkers({ includeArchived: true })) {
    console.error(
      `  ${workerIdentity(candidate).padEnd(12)} ${candidate.id}  ${candidate.status.padEnd(10)} ` +
        `${candidate.name}`,
    );
  }
  fail('No such worker.');
}

/** The checkout this command is running from — how it finds the render set. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const HELP = `Usage: npm run admin -- <area> <command> [...] [--admin someone@example.com]

  people    list | foundation | rename <user|email> "<name>"
  capacity  show | adopt <user|email> <trig_…>
  factory   invite <project> <user|email>
  workers   list | disable <name> | enable <name> | archive <name>
  routing   show | check <worker> <bin>
            set <worker> --families A,B [--repositories o/r,...]
                   [--capabilities a,b] --reason "why"
            clear <worker> | retire <worker> --reason "why"
  connectors show | derive | attach <brnc_…> <trig_…>
             reconnect <cnr_…|trig_…> <user|email>
             probe <trig_…> [--no-wait] | probe-status <trig_…|crp_…>
             repoint-worker <cnr_…> <to-worker>
  projects  list | create <name>
  access    show <worker> | grant <worker> <project> | revoke <worker> <project>
  queue     list <project>
  design    show | approve | reject | withdraw   (reads docs/evidence/step12b-renders)
  packets   list <project> | approve <orchestration>
            independence [project] | scope [project] | reaudit <orchestration>
            retry-fragment <fragment> | reissue <workItem>
  identity  events [--actor <id>] [--project <id>] [--action <ACTION>]
                    [--result SUCCESS|DENIED|FAILED] [--limit <n>]
                    (§17's append-only audit; read-only, needs no --admin)

Connecting a site is not here. It is a person's decision and it lives in
Russell, under Connected sites, which is the only place a site credential is
ever shown.`;

/** Every field of a recovery probe's outcome, so nobody joins rows by hand. */
async function printProbe(probe: import('../server/repos/recoveryProbes.ts').RecoveryProbe): Promise<void> {
  const { getRoutine, getAccount } = await import('../server/repos/fleet.ts');
  const { getConnector } = await import('../server/repos/connectors.ts');
  const routine = await getRoutine(probe.routineId);
  const account = await getAccount(probe.accountId);
  const connector = probe.connectorId ? await getConnector(probe.connectorId) : null;
  console.log(`RECOVERY PROBE ${probe.id}`);
  console.log(`  routine           ${routine ? `${routine.name} ${routine.routineRef}` : probe.routineId}`);
  console.log(`  account           ${account ? `${account.name} (${account.id})` : probe.accountId}`);
  console.log(`  state             ${probe.state}`);
  console.log(`  recovery fire     ${probe.firedAt ? `${probe.binId ?? '—'} at ${probe.firedAt}` : '—'}`);
  // The provider session is the probe's proof; it is not printed while the
  // probe is live, so a log line cannot be the way somebody else presents it.
  const live = probe.state === 'FIRING' || probe.state === 'FIRED';
  console.log(`  provider session  ${live ? (probe.providerSession ? '(withheld while the probe is live)' : '—') : (probe.providerSession ?? '—')}`);
  console.log(`  arrived           ${probe.arrivedAt ?? '—'}`);
  console.log(`  oauth client      ${probe.clientId ?? '—'}`);
  console.log(`  logical connector ${connector ? `${connector.id} ${connector.resource} worker=${connector.workerId ?? '—'}` : (probe.connectorId ?? '—')}`);
  console.log(`  health            ${probe.health ?? '—'}`);
  console.log(`  surface state     ${routine ? `${routine.state}${routine.connectorId ? ` connector=${routine.connectorId}` : ' (unattributed)'}` : '—'}`);
  console.log(`  outcome           ${probe.outcome ?? 'waiting for the session'}`);
  console.log(`  human action      ${probe.nextAction ?? (probe.state === 'FIRED' ? 'none yet — still waiting' : 'none')}`);
  console.log(`  window closes     ${probe.expiresAt}`);
}

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
    /*
     * What a connector's OAuth journey actually did, read from rows.
     *
     * A connector that "stopped working" is a statement by the client; the
     * authorization server wrote down every step it took — the registration,
     * the consent, the code, the token exchange, the refresh, and every
     * refused bearer at /mcp — in `identity_events` and the three oauth tables.
     * This prints them for a window, oldest first, so the first failed
     * operation is findable by following the client and worker ids. Read-only.
     * Ids, times and categories only: no digest, no prefix, no address.
     */
    case 'oauth trace': {
      const hours = Math.min(Math.max(Number(rest[0] ?? '24') || 24, 1), 168);
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const db = getDb();
      const names = new Map((await listWorkers({ includeArchived: true })).map((w) => [w.id, workerIdentity(w)]));
      const who = (id: unknown): string => (typeof id === 'string' ? `${names.get(id) ?? '?'}(${id})` : '—');
      console.log(`OAUTH TRACE since ${since}`);
      console.log('');
      console.log('  clients registered');
      for (const row of await db.all<Record<string, unknown>>(
        `SELECT client_id, client_name, redirect_uris, token_auth_method, created_at, disabled_at
           FROM oauth_clients WHERE created_at >= ? ORDER BY created_at`,
        [since],
      )) {
        console.log(
          `    ${row['created_at']}  ${row['client_id']}  "${row['client_name']}"  ${row['token_auth_method']}  ` +
            `redirect=${row['redirect_uris']}${row['disabled_at'] ? `  disabled ${row['disabled_at']}` : ''}`,
        );
      }
      console.log('  worker invitations');
      for (const row of await db.all<Record<string, unknown>>(
        `SELECT id, worker_id, kind, intended_user_id, created_at, expires_at, redeemed_at, revoked_at
           FROM worker_invitations
          WHERE created_at >= ? OR redeemed_at >= ? OR revoked_at >= ? OR expires_at >= ?
          ORDER BY created_at`,
        [since, since, since, since],
      )) {
        console.log(
          `    ${row['created_at']}  ${row['id']}  ${who(row['worker_id'])}  ${row['kind']}  ` +
            `member=${row['intended_user_id'] ?? '—'}  expires=${row['expires_at']}  ` +
            `redeemed=${row['redeemed_at'] ?? '—'}  revoked=${row['revoked_at'] ?? '—'}`,
        );
      }
      console.log('  authorization codes');
      for (const row of await db.all<Record<string, unknown>>(
        `SELECT id, client_id, worker_id, approved_by_user_id, resource, created_at, expires_at, redeemed_at
           FROM oauth_authorization_codes WHERE created_at >= ? ORDER BY created_at`,
        [since],
      )) {
        console.log(
          `    ${row['created_at']}  ${row['id']}  client=${row['client_id']}  ${who(row['worker_id'])}  ` +
            `approver=${row['approved_by_user_id']}  resource=${row['resource'] ?? '—'}  ` +
            `redeemed=${row['redeemed_at'] ?? '—'}`,
        );
      }
      console.log('  tokens created or used');
      for (const row of await db.all<Record<string, unknown>>(
        `SELECT id, kind, client_id, worker_id, resource, created_at, expires_at, last_used_at, revoked_at, parent_token_id
           FROM oauth_tokens WHERE created_at >= ? OR last_used_at >= ? OR revoked_at >= ?
          ORDER BY created_at LIMIT 400`,
        [since, since, since],
      )) {
        console.log(
          `    ${row['created_at']}  ${row['id']}  ${row['kind']}  client=${row['client_id']}  ${who(row['worker_id'])}  ` +
            `resource=${row['resource'] ?? '—'}  expires=${row['expires_at']}  used=${row['last_used_at'] ?? '—'}  ` +
            `revoked=${row['revoked_at'] ?? '—'}  parent=${row['parent_token_id'] ?? '—'}`,
        );
      }
      console.log('  events');
      for (const row of await db.all<Record<string, unknown>>(
        `SELECT created_at, action, result, reason, actor_type, actor_id, target_id, metadata, user_agent
           FROM identity_events
          WHERE created_at >= ?
            AND (action LIKE 'OAUTH%' OR action = 'MCP_AUTHENTICATE' OR action LIKE '%INVITATION%')
          ORDER BY created_at LIMIT 400`,
        [since],
      )) {
        console.log(
          `    ${row['created_at']}  ${row['action']} ${row['result']}${row['reason'] ? ` ${row['reason']}` : ''}  ` +
            `actor=${row['actor_type']}:${row['actor_id'] ?? '—'}  target=${row['target_id'] ?? '—'}  ` +
            `meta=${row['metadata']}  ua=${String(row['user_agent'] ?? '—').slice(0, 60)}`,
        );
      }
      break;
    }
    case 'workers list': {
      for (const worker of await listWorkers({ includeArchived: true })) {
        const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
        // The id as well as the name: every other operator surface — `fleet show`,
        // a dispatch row, a ledger entry — names a worker by id, and a listing you
        // cannot join to those is a listing you have to guess against.
        console.log(
          `  ${workerIdentity(worker).padEnd(12)} ${worker.id}  ${worker.status.padEnd(10)} ` +
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
          `  ${(worker ? workerIdentity(worker) : row.workerId).padEnd(12)} ${row.workerId}  families=[${families}] ` +
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
        for (const worker of implicit) {
          console.log(`      ${workerIdentity(worker).padEnd(12)} ${worker.id}`);
        }
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
        handle: workerIdentity(worker),
        displayName: workerIdentity(worker),
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
      console.log(`  worker     ${workerIdentity(worker)}  ${routing.explicit ? 'explicit' : 'derived'} ` +
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
        `  ${workerIdentity(worker)} now serves [${families.join(',') || '(nothing)'}]` +
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
      console.log(`  ${workerIdentity(worker)} is retired from active dispatch: it may be handed nothing.`);
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
          ? `  ${workerIdentity(worker)} is back to the derived default: what its scopes imply, and no repository work.`
          : `  ${workerIdentity(worker)} had no explicit routing scope.`,
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
      console.log(`  ${workerIdentity(worker)} is now ${status}.`);
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
      console.log(`  ${workerIdentity(worker)} is archived. Its rows and its audit history stay.`);
      break;
    }
    /*
     * Every identity this Brain holds, and what each one is.
     *
     * Read-only, and it exists because *"trace every row and explain what each
     * represents"* had no answer that did not involve shipping a scratch query
     * runner into the container — which is exactly the thing that is easy to get
     * wrong. It prints the declared kind beside the display name, so the
     * question "why is Hosted verification not on the People page" resolves to a
     * column rather than to somebody's memory.
     *
     * It changes nothing: no disable, no archive, no membership. Those have
     * their own commands or belong nowhere.
     */
    case 'people list': {
      for (const user of await listUsers()) {
        const state = user.disabledAt ? 'DISABLED' : user.isBrainAdmin ? 'ADMIN' : 'MEMBER';
        const passkeys = await countLivePasskeys(user.id);
        // What the page derives `READY` from, printed the same way it derives
        // it, and in the same order: the PIN the sign-in screen asks for, the
        // password `/recovery` takes, then a device, which reaches neither. A
        // timestamp is evidence a credential exists and says nothing about it.
        const signIn =
          user.pinUpdatedAt !== null
            ? 'pin'
            : user.passwordUpdatedAt !== null
              ? 'password'
              : passkeys > 0
                ? 'device'
                : 'none';
        console.log(
          `  ${user.id}  ${user.kind.padEnd(7)} ${state.padEnd(8)} ` +
            `passkeys=${passkeys} signs-in=${signIn.padEnd(8)} ${user.displayName}` +
            (user.email ? `  <${user.email}>` : '  <no address — passkey only>'),
        );
      }
      console.log('');
      console.log('  kind=PERSON is somebody; kind=SYSTEM is machinery proving itself.');
      console.log('  Only PERSON rows, not disabled, reach the People & capacity page.');
      console.log('  signs-in=none is a slot nobody has filled.');
      console.log('  signs-in=pin and signs-in=password are ways in; the screen asks for a PIN.');
      console.log('  signs-in=device holds a passkey the sign-in screen no longer offers:');
      console.log('  that person needs a new link, which People has a control for.');
      break;
    }
    /*
     * The foundation matrix: every intended human account against every
     * dimension, with the one next action and who performs it.
     *
     * `people list` answers *what does this row hold*; this answers *is this
     * person set up, and if not what is the single thing that would fix it* —
     * which is the question the other readings are collectively for and which
     * none of them could answer alone. It reads and changes nothing.
     */
    case 'people foundation': {
      const reading = await foundationReading();
      for (const account of reading.accounts) {
        console.log('');
        console.log(
          `  ${account.displayName}${account.isBrainAdmin ? '  (Brain administrator)' : ''}  ` +
            `— ${account.verdict}`,
        );
        for (const finding of account.findings) {
          console.log(`    ${finding.verdict.padEnd(15)} ${finding.dimension}`);
          console.log(`      ${finding.because}`);
          if (finding.nextAction) {
            console.log(`      -> ${finding.nextAction}  [${finding.owner}]`);
          }
        }
      }
      console.log('');
      console.log(
        `  ${reading.passing} of ${reading.accounts.length} account(s) satisfy every dimension ` +
          `that applies to them; ${reading.blocked} are short of at least one.`,
      );
      console.log('  NOT_APPLICABLE is not PASS: it is a dimension this account has not reached.');
      if (reading.unattributed.length > 0) {
        console.log('');
        console.log(`  ${reading.unattributed.length} surface(s) run under an identity no account owns:`);
        for (const one of reading.unattributed) {
          console.log(
            `    ${one.routineName}  worker=${one.workerLabel ?? one.workerId}` +
              `${one.enabled ? '  ENABLED' : ''}`,
          );
          console.log(`      ${one.because}`);
          console.log(`      -> ${one.nextAction}`);
        }
      } else {
        console.log('  No surface runs under an identity no account owns.');
      }
      break;
    }
    /*
     * Saying what somebody is called.
     *
     * The repair for an account whose `display_name` is an address — which the
     * first administrator's always was, because `bootstrap.ts` had nothing else
     * to work from. `personName` keeps such a row readable; this is what makes
     * it unnecessary, and it is the only path in this repository that sets a
     * person's name after their account exists.
     *
     * It changes the name and nothing else: not the address, not the
     * administration flag, not a membership, not a credential. A person is
     * still reached, contacted and authenticated exactly as they were.
     *
     * On a terminal because reaching the shell is the authentication (§26), and
     * `--admin` is the attribution, resolved against `users` rather than
     * trusted — an audit row with no author answers nothing later.
     */
    case 'people rename': {
      const actor = await administrator();
      const target = rest[0] ?? fail('Name the user id or address to rename.');
      const name = rest.slice(1).join(' ').trim() || fail('Give the name to show them as.');
      refuseAddressAsName(name);
      const user = (await listUsers()).find((one) => one.id === target || one.email === target);
      if (!user) fail(`No user with id or address ${target}.`);
      /*
       * And it must not be a name somebody else already signs in with.
       *
       * This is §46's guard, asked here because there are two surfaces onto
       * one column: this and `POST /api/admin/users/:userId/display-name`. A
       * member enrolled from a link holds no address, so their display name is
       * the only thing they can type at the door — and two live accounts
       * answering to one name lock **both** of them out, with the same
       * sentence a wrong PIN gets, because invariant 23 is doing its job.
       *
       * Without it this command was the way round the route: an administrator
       * correcting a name on a terminal could create the exact condition the
       * browser refuses, and the People page would then report two people as
       * unable to sign in with no record of what did it.
       */
      if (await signInNameTaken(name, { exceptUserId: user.id })) {
        fail(
          `Somebody else already signs in as "${name}". Pick one that tells them apart — the ` +
            'name is how a member without an address gets in.',
        );
      }
      const before = user.displayName;
      await renameUser(user.id, name);
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'RENAME_USER',
        targetType: 'USER',
        targetId: user.id,
        result: 'SUCCESS',
        // The names, because a rename with no before and after is a change
        // nobody can check afterwards. Neither is a credential.
        metadata: { from: before, to: name },
      });
      console.log(`  ${user.id} is shown as "${name}" (was "${before}").`);
      console.log('  The address, the administration flag and every membership are unchanged.');
      break;
    }
    /*
     * Recording that a surface this Brain already fires is somebody's.
     *
     * The repair for the split brain migration 084 describes: four Routines
     * registered on a terminal long before `capacity_connections` existed,
     * firing every day, and a People page telling their owner that their
     * Claude account was not connected because it looked the worker up by a
     * name Brain would have minted.
     *
     * It creates no account, Routine, worker, credential or token, and it
     * cannot promote a connection to healthy — that stays `reconcile`'s, from
     * the four-row chain. Every refusal names what to do instead.
     */
    case 'capacity adopt': {
      const actor = await administrator();
      const who = rest[0] ?? fail('Name the user id or address whose connection this is.');
      const ref = rest[1] ?? fail('Name the Routine reference (trig_…) being adopted.');
      const person = (await listUsers()).find((one) => one.id === who || one.email === who);
      if (!person) fail(`No user with id or address ${who}.`);
      const outcome = await adoptSurface({
        userId: person.id,
        routineRef: ref,
        actorUserId: actor.id,
        // Reaching this shell is the authentication; the channel says so rather
        // than claiming the stronger, browser-authenticated one (§23).
        channel: 'SHELL',
      });
      if (!outcome.ok) fail(outcome.reason);
      console.log(
        `  ${person.displayName}: ${outcome.connection.routineName} (${outcome.connection.triggerRef})` +
          `${outcome.alreadyAdopted ? ' — already recorded, nothing changed' : ''}`,
      );
      console.log(`  state ${outcome.connection.state}. Healthy is the four-row chain, read on the next view.`);
      break;
    }
    /*
     * One more Claude account for a Factory worker, bound to the member who
     * will connect it — the same `issueFactoryInvitation` Build calls.
     *
     * The link is deliberately **not printed**. This output lands in a
     * workflow log, and an invitation token there is a credential in a log
     * (§17). It is not needed either: `/oauth/authorize` honours exactly one
     * live invitation bound to the member the browser is signed in as
     * (`boundToSignedInMember`), so the member reconnects from Claude while
     * signed in to this Brain and the consent screen finds it. Every guard is
     * the service's: a member who cannot sign in is refused, nothing else is
     * written, and every other link stays as it was.
     */
    case 'factory invite': {
      const actor = await administrator();
      const project = await projectFrom(rest[0] ?? fail('Name the project.'));
      const who = rest[1] ?? fail('Name the user id or address the link is for.');
      // The grant is whichever repository this project onboarded a worker for;
      // more than one is a choice this command will not make for anybody.
      const onboarded = (await repositoryOnboarding(project.id)).filter((one) => one.workerId);
      if (onboarded.length !== 1) {
        fail(
          onboarded.length === 0
            ? 'This project has no onboarded repository to invite an account to.'
            : `This project has ${onboarded.length} onboarded repositories ` +
                `(${onboarded.map((one) => one.grantId).join(', ')}); use Build to choose one.`,
        );
      }
      const grantId = onboarded[0]!.grantId;
      const person = (await listUsers()).find((one) => one.id === who || one.email === who);
      if (!person) fail(`No user with id or address ${who}.`);
      const outcome = await issueFactoryInvitation({
        projectId: project.id,
        grantId,
        intendedUserId: person.id,
        actor,
        origin: 'https://invalid.local',
      });
      if (!outcome.ok) fail(outcome.reason);
      const view = outcome.result.invitation;
      console.log(`  issued ${view.id} for ${person.displayName} (${person.id})`);
      console.log(`  expires ${view.expiresAt}. The link itself is not printed.`);
      console.log('  To spend it: sign in to this Brain in the browser Claude uses, then');
      console.log('  reconnect the connector from Claude. Consent finds this invitation.');
      break;
    }
    /*
     * The one operator read of every logical connector — one Claude account at
     * one Brain endpoint — and its canonical health, from
     * `services/fleet/connectorHealth.ts`. This replaces reading OAuth rows by
     * hand every time something breaks. Ids, times and categories only: no
     * token, no digest, no prefix.
     */
    case 'connectors show': {
      const { allConnectorHealth } = await import('../server/services/fleet/connectorHealth.ts');
      const { listRoutines, listAccounts } = await import('../server/repos/fleet.ts');
      const { listClients } = await import('../server/repos/oauth.ts');
      const { listConnectorClients } = await import('../server/repos/connectors.ts');
      const accounts = new Map((await listAccounts()).map((a) => [a.id, a.name]));
      const routines = await listRoutines();
      const names = new Map((await listWorkers({ includeArchived: true })).map((w) => [w.id, workerIdentity(w)]));
      const lastCheckIn = async (routineIds: string[]): Promise<string | null> => {
        if (routineIds.length === 0) return null;
        const row = await getDb().get<{ at: string | null }>(
          `SELECT MAX(observed_at) AS at FROM worker_sessions WHERE routine_id IN (${routineIds.map(() => '?').join(', ')})`,
          routineIds,
        );
        return row?.at ?? null;
      };
      const noShows = async (routineIds: string[]): Promise<number> => {
        if (routineIds.length === 0) return 0;
        const row = await getDb().get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'DISPATCH_NO_SHOW'
            AND routine_id IN (${routineIds.map(() => '?').join(', ')})
            AND at > COALESCE((SELECT MAX(observed_at) FROM worker_sessions WHERE routine_id IN (${routineIds.map(() => '?').join(', ')})), '')`,
          [...routineIds, ...routineIds],
        );
        return Number(row?.n ?? 0);
      };
      for (const health of await allConnectorHealth()) {
        const mine = routines.filter((r) => r.connectorId === health.connectorId);
        const ids = mine.map((r) => r.id);
        console.log(`CONNECTOR ${health.connectorId}`);
        console.log(`  account   ${accounts.get(health.accountId) ?? '?'} (${health.accountId})`);
        console.log(`  endpoint  ${health.resource}`);
        console.log(`  worker    ${health.workerId ? `${names.get(health.workerId) ?? '?'}(${health.workerId})` : '—'}`);
        console.log(`  routines  ${mine.map((r) => `${r.name} ${r.routineRef} ${r.state}`).join('; ') || '—'}`);
        console.log(`  HEALTH    ${health.state} ${health.reason}${health.humanActionRequired ? '  — HUMAN ACTION REQUIRED' : ''}`);
        console.log(`  why       ${health.detail}`);
        console.log(`  client    current=${health.currentClientId ?? '—'} all=${health.clientIds.join(',') || '—'}`);
        console.log(
          `  times     registered=${health.lastRegistrationAt ?? '—'} grant=${health.lastGrantAt ?? '—'} ` +
            `refresh=${health.lastRefreshAt ?? '—'} recovered=${health.lastRecoveredRefreshAt ?? '—'} ` +
            `access-use=${health.lastAccessUseAt ?? '—'}`,
        );
        console.log(
          `  refusal   ${health.lastRefusal ? `${health.lastRefusal.reason} at ${health.lastRefusal.at}` : '—'}`,
        );
        const fired = mine.map((r) => r.lastFiredAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
        console.log(
          `  activity  last-fire=${fired ?? '—'} last-check-in=${(await lastCheckIn(ids)) ?? '—'} ` +
            `real-no-shows=${await noShows(ids)} auth-no-shows-since-anomaly=${health.authNoShowsSinceAnomaly}`,
        );
      }
      const attached = new Set((await listConnectorClients()).map((c) => c.clientId));
      const unbound = routines.filter((r) => r.state !== 'RETIRED' && !r.connectorId);
      const orphans = (await listClients()).filter((c) => !attached.has(c.clientId) && c.disabledAt === null);
      console.log('');
      console.log(`UNATTRIBUTED routines=${unbound.length} clients=${orphans.length}`);
      for (const r of unbound) console.log(`  routine ${r.routineRef} ${r.name} ${r.state} account=${accounts.get(r.accountId) ?? r.accountId}`);
      console.log('  A Routine binds to its connector from an observed arrival; where that cannot be proven,');
      console.log('  `connectors attach <brnc_…> <trig_…>` is the one explicit binding.');
      break;
    }
    /*
     * The explicit binding, for a connector Brain could not attribute from
     * evidence: this OAuth client is the connector this Routine uses. The
     * connector is (the Routine's account, the client's endpoint).
     */
    case 'connectors attach': {
      const actor = await administrator();
      const clientId = rest[0] ?? fail('Name the OAuth client (brnc_…).');
      const ref = rest[1] ?? fail('Name the Routine (trig_…) that uses it.');
      const { getRoutineByRef } = await import('../server/repos/fleet.ts');
      const { attachClient, bindRoutineConnector, connectorClient, endpointOf, ensureConnector, getConnector } =
        await import('../server/repos/connectors.ts');
      const routine = await getRoutineByRef(ref);
      if (!routine) fail(`No Routine registered as ${ref}.`);
      const token = await getDb().get<{ resource: string | null; worker_id: string }>(
        'SELECT resource, worker_id FROM oauth_tokens WHERE client_id = ? ORDER BY created_at DESC LIMIT 1',
        [clientId],
      );
      const existing = await connectorClient(clientId);
      const connector = existing
        ? await getConnector(existing.connectorId)
        : await ensureConnector({
            accountId: routine.accountId,
            resource: endpointOf(token?.resource ?? null),
            workerId: token?.worker_id ?? routine.workerId,
          });
      if (!connector) fail('The connector could not be resolved.');
      if (connector.accountId !== routine.accountId) {
        fail(`${clientId} is already ${connector.id} in another account; a client is not re-pointed.`);
      }
      const outcome = existing
        ? 'ALREADY'
        : await attachClient({ clientId, connectorId: connector.id, source: 'OPERATOR', evidence: `attached by ${actor.id}` });
      const bound = routine.connectorId === connector.id || (await bindRoutineConnector(routine.id, connector.id));
      console.log(`  ${clientId} -> ${connector.id} (${outcome}); ${ref} -> ${connector.id} (${bound ? 'bound' : `already bound to ${routine.connectorId}`})`);
      break;
    }
    case 'connectors derive': {
      await administrator();
      const { reconcileConnectorBindings } = await import('../server/services/fleet/connectorBinding.ts');
      const result = await reconcileConnectorBindings();
      console.log(`  attached=${result.attached} routines-bound=${result.routinesBound} ambiguous=${result.ambiguous.join(',') || '—'}`);
      break;
    }
    /*
     * One bound reconnect, for a connector proven to need consent.
     *
     * Everything Brain can prepare is prepared: the invitation names the
     * worker, the member and the logical connector, so the consent screen
     * offers that worker and nothing else, and whatever OAuth client Claude
     * presents is attached to the same connector — same Routines, no trigger,
     * secret or Routine recreated. The link is not printed (§17): the member
     * reconnects from Claude while signed in to this Brain, and consent finds
     * the one live invitation bound to them. Older reconnect links for this
     * connector are withdrawn, because two live links would leave the worker a
     * guess.
     */
    case 'connectors reconnect': {
      const actor = await administrator();
      const target = rest[0] ?? fail('Name the connector (cnr_…) or one of its Routines (trig_…).');
      const who = rest[1] ?? fail('Name the user id or address of the person whose Claude account this is.');
      const { getRoutineByRef } = await import('../server/repos/fleet.ts');
      const { getConnector } = await import('../server/repos/connectors.ts');
      const { connectorHealth } = await import('../server/services/fleet/connectorHealth.ts');
      const { createInvitation, liveInvitationsForMember, revokeInvitation } = await import('../server/repos/invitations.ts');
      const { generateInvitationToken } = await import('../server/services/identity/secrets.ts');
      const connectorId = target.startsWith('trig_') ? (await getRoutineByRef(target))?.connectorId ?? null : target;
      const connector = connectorId ? await getConnector(connectorId) : null;
      if (!connector) fail(`No connector for ${target}. Attribute it first: \`connectors attach <brnc_…> <trig_…>\`.`);
      if (!connector.workerId) fail(`${connector.id} has no worker observed yet; nothing can be bound.`);
      const person = (await listUsers()).find((one) => one.id === who || one.email === who);
      if (!person) fail(`No user with id or address ${who}.`);
      const health = await connectorHealth(connector.id);
      console.log(`  ${connector.id} is ${health?.state ?? '?'} ${health?.reason ?? ''}`);
      if (health && !health.humanActionRequired) {
        console.log('  It does not need consent: Brain will recover it without a person. Issuing anyway, as asked.');
      }
      const live = await liveInvitationsForMember(person.id);
      for (const old of live.filter((one) => one.connectorId === connector.id)) await revokeInvitation(old.id);
      const others = live.filter((one) => one.connectorId !== connector.id);
      const token = generateInvitationToken();
      const invitation = await createInvitation({
        workerId: connector.workerId,
        tokenPrefix: token.prefix,
        tokenDigest: token.digest,
        createdByUserId: actor.id,
        kind: 'ADDITIONAL',
        intendedUserId: person.id,
        connectorId: connector.id,
        note: `reconnect ${connector.id}`,
      });
      console.log(`  issued ${invitation.id} for ${person.displayName} (${person.id}), worker ${connector.workerId}, expires ${invitation.expiresAt}.`);
      console.log('  The link itself is not printed. The one human action: sign in to this Brain in the browser');
      console.log('  Claude uses, reconnect the connector from Claude, and approve the worker already chosen.');
      if (others.length > 0) {
        console.log(
          `  NOTE ${person.displayName} holds ${others.length} other live invitation(s) (${others.map((o) => o.id).join(', ')}); ` +
            'consent finds a bound invitation only when exactly one is live — withdraw the others first.',
        );
      }
      break;
    }
    /*
     * The recovery probe (services/fleet/recoveryProbe.ts): one controlled
     * fire at one quarantined or unattributed Routine, outside routing, whose
     * session is recognised by the provider session the fire returned. It
     * replaces both bad choices — guessing an OAuth client, or re-enabling a
     * surface blind — with a proof Brain obtains itself. It waits for the
     * outcome and prints the whole chain, so nobody correlates rows by hand.
     */
    case 'connectors probe': {
      const actor = await administrator();
      const ref = rest[0] ?? fail('Name the Routine (trig_…) to probe.');
      const { startRecoveryProbe, settleRecoveryProbeNow, RecoveryProbeRefused, RECOVERY_PROBE_WINDOW_MS } =
        await import('../server/services/fleet/recoveryProbe.ts');
      const { getRecoveryProbe } = await import('../server/repos/recoveryProbes.ts');
      let probe;
      try {
        probe = await startRecoveryProbe({ routineRef: ref, requestedById: actor.id, authorityChannel: 'SHELL' });
      } catch (error) {
        if (error instanceof RecoveryProbeRefused) fail(error.message);
        throw error;
      }
      console.log(`  probe ${probe.id} for ${ref}: ${probe.state}`);
      if (probe.state === 'FIRED' && !rest.includes('--no-wait')) {
        // Wait for the session, settling as the tick would. Eight minutes, inside
        // the workflow's ten: a session that can authenticate arrives in one or
        // two. If it has not settled by then the tick keeps settling it until
        // the window closes, and `connectors probe-status` reads the outcome.
        const deadline = Date.now() + Math.min(RECOVERY_PROBE_WINDOW_MS, 8 * 60_000);
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          const current = await getRecoveryProbe(probe.id);
          if (!current || current.state !== 'FIRED') break;
          await settleRecoveryProbeNow(current);
        }
      }
      await printProbe((await getRecoveryProbe(probe.id))!);
      break;
    }
    case 'connectors repoint-worker': {
      const actor = await administrator();
      const connectorId = rest[0] ?? fail('Name the connector (cnr_…).');
      const to = rest[1] ?? fail('Name the worker it should authorize as.');
      const { repointConnectorWorker, getConnector } = await import('../server/repos/connectors.ts');
      const { getWorker } = await import('../server/repos/identity.ts');
      const { forgetRoutingHealth } = await import('../server/services/fleet/connectorHealth.ts');
      const before = await getConnector(connectorId);
      if (!before) fail(`No connector ${connectorId}.`);
      if (!(await getWorker(to))) fail(`No worker ${to}.`);
      // Guarded on the value just read, so a concurrent change is refused rather than overwritten.
      if (!(await repointConnectorWorker({ connectorId, from: before.workerId, to }))) {
        fail(`${connectorId} changed while this ran; nothing was changed. Read it again.`);
      }
      forgetRoutingHealth();
      console.log(`  ${connectorId} now authorizes as ${to} (was ${before.workerId ?? 'none'}); recorded against ${actor.id}.`);
      break;
    }
    case 'connectors probe-status': {
      const target = rest[0] ?? fail('Name the Routine (trig_…) or the probe (crp_…).');
      const { getRecoveryProbe, latestRecoveryProbeFor } = await import('../server/repos/recoveryProbes.ts');
      const { getRoutineByRef } = await import('../server/repos/fleet.ts');
      const probe = target.startsWith('crp_')
        ? await getRecoveryProbe(target)
        : await (async () => {
            const routine = await getRoutineByRef(target);
            return routine ? latestRecoveryProbeFor(routine.id) : null;
          })();
      if (!probe) fail(`No recovery probe for ${target}.`);
      await printProbe(probe);
      break;
    }
    case 'capacity show': {
      for (const one of await listConnections()) {
        const person = (await listUsers()).find((user) => user.id === one.userId);
        console.log(
          `  ${one.userId}  ${String(person?.displayName ?? '—').padEnd(24)} ${one.state.padEnd(22)} ` +
            `routine=${one.routineId ?? '—'} worker=${one.workerId ?? '—'} ref=${one.triggerRef ?? '—'}`,
        );
      }
      console.log('');
      console.log('  worker=— is a connection whose surface Brain has not been told about.');
      console.log('  `capacity adopt <user> <trig_…>` is what records one.');
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
    /*
     * Creating a worker identity, which had no terminal path at all.
     *
     * `POST /api/admin/workers` was the only one, and
     * `docs/workers/CONNECTING-A-WORKER.md` step 1 said to use `npm run admin`
     * while describing the form fields of the operator console §26 deleted. So
     * the documented first step of connecting a worker named a command that did
     * not exist and a screen that no longer did, and the real path was a raw
     * HTTP POST with an administrator's session cookie. A four-project fleet
     * needs four of these before anything else can be set up.
     *
     * **It issues no credential**, which is why it belongs here at all. §26
     * keeps site credentials off the terminal because the secret is shown once
     * in a browser to somebody signed in. Nothing of that kind happens here: a
     * worker identity is a row, and the credential that later speaks for it is
     * minted by the OAuth consent screen, in a browser, on a human's approval.
     * A worker created here and never connected can do nothing whatsoever.
     *
     * The name rule is the route's, character for character, because two
     * entrances disagreeing about what a valid name is would be discovered by
     * whichever one somebody used second.
     */
    case 'workers create': {
      const actor = await administrator();
      const name = (rest[0] ?? fail('Name the worker.')).trim();
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) {
        fail('A worker name is 2-64 characters of lowercase letters, digits, dot, dash or underscore.');
      }
      if (await getWorkerByName(name)) fail(`A worker called "${name}" already exists.`);
      const displayName = rest.slice(1).join(' ').trim() || name;
      const worker = await createWorker({
        name,
        displayName,
        workerType: 'GENERIC',
        description: null,
        createdByType: 'HUMAN',
        createdById: actor.id,
      });
      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'CREATE_WORKER',
        targetType: 'WORKER',
        targetId: worker.id,
        projectId: null,
        result: 'SUCCESS',
        // The label is the identity; the handle is what was typed, kept as history.
        metadata: { name: workerIdentity(worker), legacyName: worker.name },
      });
      console.log(`  ${worker.id}  ${workerIdentity(worker)}  (legacy handle ${worker.name})`);
      console.log('  It is a member of no project and holds no credential yet.');
      break;
    }
    /*
     * Starting the sprint's discovery research by hand.
     *
     * §26 already lists "starting a packet by hand" as an `npm run admin`
     * operation, and it was the one item on that list with no command behind
     * it: `startPacket` had exactly two callers, Russell's mission launcher and
     * a Step 10 command hardcoded to one project and one Michigan licensing
     * question. So the operation the architecture says belongs on a terminal
     * could not be performed from one.
     *
     * **It authorizes nothing that was not already authorized.** The envelope is
     * named, never supplied — `RUSSELL_CASH_DISCOVERY_V1` lives in code, was
     * reviewed, and `startPacket` refuses an id nothing defines rather than
     * treating "no rules matched" as "everything is allowed". That is §16's
     * whole property: nobody supplies the limits their own plan is judged
     * against. The envelope permits published sources only, across any market,
     * with no spending, no paid API, no contact with any person or
     * organisation, no advertising and no publishing. Acting on what is found
     * is a commercial grant a person makes, and this cannot make one.
     *
     * **It invents no questions.** The assignments are `SEARCH_BUCKETS`, the
     * same reviewed in-code table the sprint's own discovery opens, so a
     * terminal start and an activated sprint ask the identical things. A
     * command that composed its own research questions would be the second
     * orchestration system this repository keeps refusing to grow.
     *
     * **It is not activation and does not pretend to be.** A cash sprint's
     * `ACTIVE` row, and the commercial authority beside it, are the two
     * decisions §30 reserves to a person, and neither is reachable from here.
     * What this does is start the research those decisions would have started,
     * under limits a person already set, so the archive is being filled while
     * the two decisions are outstanding. Activating later reuses this layer
     * rather than creating a second, because it is named from the same
     * constant.
     */
    case 'research goal': {
      const sub = rest[0] ?? fail('Say what to do with a research goal: create, show or list.');
      if (sub === 'create') {
        const actor = await administrator();
        const project = await projectFrom(rest[1] ?? fail('Name a project.'));
        const name = flag('name') ?? fail('Pass --name.');
        const maxPackets = Number(flag('max-packets') ?? fail('Pass --max-packets N.'));
        const maxFragments = Number(flag('max-fragments') ?? fail('Pass --max-fragments N.'));
        // The ledger needs a real deadline and the route requires one, so the terminal does too:
        // a ceiling nobody chose is not one the person set.
        const deadline = flag('deadline') ?? fail('Pass --deadline ISO: a research goal needs a date it ends.');
        // With an assignment and a layer, Brain continues the goal by itself on
        // the tick; without them a person starts each packet with research start.
        const assignment = flag('assignment') ?? null;
        const layerRef = flag('layer');
        const layer = layerRef
          ? (await listLayers(project.id)).find((one) => one.id === layerRef || one.name === layerRef) ??
            fail(`No layer "${layerRef}" in this project.`)
          : null;
        let goalId: string;
        try {
          goalId = (
            await createResearchGoal({
              projectId: project.id,
              ownerUserId: actor.id,
              createdByUserId: actor.id,
              name,
              maxPackets,
              maxFragments,
              deadline,
              researchAssignment: assignment,
              researchLayerId: layer?.id ?? null,
            })
          ).id;
        } catch (error) {
          fail(error instanceof Error ? error.message : 'The research goal could not be opened.');
        }
        await recordIdentityEvent({
          actorType: 'HUMAN',
          actorId: actor.id,
          action: 'OPEN_RESEARCH_GOAL',
          targetType: 'PROJECT',
          targetId: project.id,
          projectId: project.id,
          result: 'SUCCESS',
          metadata: { goalId, maxPackets: String(maxPackets), maxFragments: String(maxFragments) },
        });
        const status = await goalBudgetStatus(goalId);
        if (status) await printGoalBudget(status);
        break;
      }
      if (sub === 'show') {
        const status = await goalBudgetStatus(rest[1] ?? fail('Name a research goal id.'));
        if (!status) fail('No research goal with that id.');
        await printGoalBudget(status);
        break;
      }
      if (sub === 'list') {
        const project = await projectFrom(rest[1] ?? fail('Name a project.'));
        const ids = await getDb().all<{ id: string }>(
          `SELECT id FROM russell_goals WHERE project_id = ? AND purpose = 'RESEARCH_GOAL'
            ORDER BY created_at DESC, rowid DESC`,
          [project.id],
        );
        if (ids.length === 0) console.log('  This project holds no research goals.');
        for (const row of ids) {
          const status = await goalBudgetStatus(row.id);
          if (status) await printGoalBudget(status);
        }
        break;
      }
      fail(`"${sub}" is not a research goal command: create, show or list.`);
    }
    case 'research start': {
      const actor = await administrator();
      const project = await projectFrom(rest[0] ?? fail('Name a project.'));

      const goalRef = flag('goal');
      if (goalRef) {
        /*
         * One packet under a goal's budget. `startPacket` decides whether
         * GOAL_BUDGET is a mode it will act on; if it refuses, that refusal is
         * printed as it was said and the hold lapses and refunds by itself. The
         * reservation is taken before the packet exists, keyed by the caller's
         * own key, so a retry replays the same charge.
         */
        const packetKey = flag('packet-key') ?? fail('Pass --packet-key: the charge needs a key a retry can repeat.');
        const goal = await getGoal(goalRef);
        if (!goal || goal.projectId !== project.id || goal.purpose !== 'RESEARCH_GOAL') {
          fail('No research goal with that id in this project.');
        }
        const bucket =
          SEARCH_BUCKETS.find((one) => one.id === flag('bucket')) ??
          (flag('bucket') ? fail(`No discovery bucket "${flag('bucket')}".`) : SEARCH_BUCKETS[0]) ??
          fail('This build defines no discovery bucket.');
        const layers = await listLayers(project.id);
        const layer =
          layers.find((one) => one.name === CASH_LAYER_NAME) ??
          (await createLayer({ projectId: project.id, name: CASH_LAYER_NAME, orderIndex: layers.length }));
        const cashEnvelope = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1');
        if (!cashEnvelope?.assignmentTemplate) {
          fail('RUSSELL_CASH_DISCOVERY_V1 defines no assignment template in this build.');
        }
        // startPacket reserves, binds and settles the charge itself, keyed by packetKey.
        try {
          const packet = await startPacket({
            projectId: project.id,
            layerId: layer.id,
            title: bucket.title,
            assignment: cashEnvelope.assignmentTemplate
              .replace('{JURISDICTION}', cashEnvelope.jurisdiction)
              .replace('{QUESTION}', bucket.question),
            approval: {
              mode: 'GOAL_BUDGET',
              goalId: goal.id,
              packetKey,
              budget: {
                maxPackets: goal.maxMissions,
                maxFragments: goal.maxFragments,
                deadline: goal.expiresAt,
                externalSpendCents: 0,
                paidOveragesEnabled: false,
              },
            },
            startedBy: { kind: 'PERSON', id: actor.id },
          });
          console.log(`  started    ${bucket.id}  ${packet.orchestration.id}  under goal ${goal.id}`);
        } catch (error) {
          if (error instanceof Halt) throw error;
          fail(error instanceof Error ? error.message : String(error));
        }
        break;
      }

      const layers = await listLayers(project.id);
      const layer =
        layers.find((one) => one.name === CASH_LAYER_NAME) ??
        (await createLayer({
          projectId: project.id,
          name: CASH_LAYER_NAME,
          orderIndex: layers.length,
        }));
      console.log(`  layer      ${layer.name}  ${layer.id}`);

      /*
       * Idempotent by the packet's own title on this project, so re-running
       * after a crash, a timeout or a lost response starts nothing twice. A
       * flag would be set by a tick that then died; rows cannot be.
       */
      /*
       * One bin shape, built by both paths.
       *
       * A repaired bin and a fresh one must be the same thing or the repair is
       * a second, subtly different kind of work item — the "rule applied by one
       * of two readers" this repository keeps recording. So the construction
       * lives here and both callers go through it.
       */
      /*
       * Read once, from the envelope, before anything is started. An envelope
       * that has lost its template is a refusal rather than a guess: filling a
       * template that is not there would produce an assignment nothing
       * authorizes.
       */
      const cashEnvelope = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1');
      if (!cashEnvelope?.assignmentTemplate) {
        fail('RUSSELL_CASH_DISCOVERY_V1 defines no assignment template in this build.');
      }
      const cashAssignment = cashEnvelope.assignmentTemplate.replace(
        '{JURISDICTION}',
        cashEnvelope.jurisdiction,
      );

      const binFor = async (orchestrationId: string, bucket: (typeof SEARCH_BUCKETS)[number]) =>
        createBin({
          projectId: project.id,
          layerId: layer.id,
          kind: 'RESEARCH_PACKET',
          title: bucket.title,
          objective:
            'Carry this bounded discovery question from an approved plan to gated, sourced ' +
            'claims, and stop. Read published sources only.',
          rationale: `Cash Mode discovery bucket ${bucket.id}, started from a terminal.`,
          manifest: {
            objective: 'Drain this research packet to its own terminal state.',
            why:
              'One bounded question about where money is currently available, answered from ' +
              'published sources. Every control it passes through is the existing one.',
            lineage: {
              projectId: project.id,
              layerId: layer.id,
              goal: bucket.question,
              orchestrationId,
            },
            units: [],
            /*
             * Left to the fragment rather than restated here. The envelope
             * already bounds the source types and `planFitsEnvelope` refuses a
             * fragment that declares none, so a narrower list here would be a
             * second set of limits nobody reviewed.
             */
            acceptableSources: [],
            excludedSources: [],
            evidence: [
              'Each claim carrying its canonical source URL, its publisher and the date it was ' +
                'published or observed, or recorded as unresolved with the search that failed',
            ],
            outputs: ['Gated, sourced claims against this question'],
            authorizedActions: [
              'brain_claim_work and the research tools, for work items belonging to this packet',
            ],
            prohibitedActions: [
              'buying anything, or paying for access to any source',
              'contacting any person or organisation',
              'advertising, publishing or listing anything',
              'any work item outside this orchestration',
              'enabling paid overage',
            ],
            budgetUnits: 1,
            retry: { maxAttempts: 3, backoffSeconds: 60 },
            stoppingConditions: ['The packet reaches its own terminal state'],
          },
          completionContract: 'RESEARCH_PACKET_V1',
          orchestrationId,
          createdByType: 'SYSTEM',
          createdById: `admin:${actor.email}`,
          ready: true,
          priority: 8,
          maxAttempts: 5,
        });

      /*
       * Only a packet that is still *live* blocks a restart.
       *
       * A packet parked at NEEDS_HUMAN because its plan fell outside the
       * envelope is a recorded refusal, not work in progress: it will never
       * move on its own, and treating it as "already started" would make the
       * first malformed attempt permanent. It keeps its row, its fragments and
       * the reason it stopped — §5, nothing is destroyed — and a corrected
       * packet starts beside it.
       *
       * `FAILED` and `CANCELLED` are here for the same reason. `COMPLETE` is
       * deliberately not: a question that has been answered is answered.
       */
      const DEAD = new Set(['NEEDS_HUMAN', 'FAILED', 'CANCELLED']);
      const existing = new Map(
        (await listOrchestrationsByProject(project.id))
          .filter((one: { status: string }) => !DEAD.has(one.status))
          .map((one: { title: string; id: string }) => [one.title, one.id] as const),
      );

      let started = 0;
      let repaired = 0;
      for (const bucket of SEARCH_BUCKETS) {
        /*
         * Idempotent by the *effect*, not by whether this ran before.
         *
         * A per-bucket skip is the shape §27 already had to correct once: it
         * reads "this was started" and concludes there is nothing to do, which
         * is only true while the two artefacts are made together. The first
         * version of this command made the packet and not the bin, so ten
         * packets exist in production with no bin — and a skip keyed on the
         * bucket would step over exactly the rows that need repairing, for
         * ever, while reporting success.
         *
         * So each artefact is asked about separately: a packet that exists is
         * reused, and a bin is built for it if it has none.
         */
        const alreadyId = existing.get(bucket.title);
        if (alreadyId) {
          if (await binForOrchestration(alreadyId)) {
            console.log(`  skipped    ${bucket.id} — packet and bin already there`);
            continue;
          }
          const bin = await binFor(alreadyId, bucket);
          repaired += 1;
          console.log(`  repaired   ${bucket.id}  ${alreadyId}  bin ${bin.id}`);
          continue;
        }
        const packet = await startPacket({
          projectId: project.id,
          layerId: layer.id,
          title: bucket.title,
          /*
           * The envelope's own authorized assignment with the question filled
           * in — never the bare question.
           *
           * `planFitsEnvelope` compares the assignment against
           * `assignmentTemplate` and refuses anything else, in those words:
           * *everything except the question is fixed in code — the scope, the
           * evidence standard, the completion standard and the exclusions — and
           * changing any of it needs a person.* Passing the bare question meant
           * ten packets planned correctly and then parked at NEEDS_HUMAN,
           * because a plan whose assignment is not the authorized one cannot be
           * auto-approved however reasonable it looks. That is the envelope
           * doing its job, and the defect was mine.
           *
           * Filled here from the envelope rather than restated, so this command
           * cannot drift from the text it is judged against.
           */
          assignment: cashAssignment.replace('{QUESTION}', bucket.question),
          approval: {
            mode: 'AUTO_WITHIN_ENVELOPE',
            envelopeId: 'RUSSELL_CASH_DISCOVERY_V1',
            authorizedBy: `admin:${actor.email}`,
          },
          startedBy: { kind: 'PERSON', id: actor.id },
        });
        /*
         * And the bin, in the same breath.
         *
         * `startPacket` queues the planning work; it does not make Brain *fire*
         * anybody for it. A packet's work reaches a worker inside a bin, so a
         * packet with queued items and no bin is work nothing will ever be sent
         * for — the rows all read healthy and the fleet stays idle. §23 records
         * this exact defect on the reopened audit round: a transition that
         * creates work must also enqueue it, and that one did not.
         *
         * Ahead of nothing and behind the packet, so there is no window where a
         * fire exists and the work does not. Idempotent for the same reason the
         * packet is: the title check above skips a bucket already started, so
         * neither is made twice.
         */
        const bin = await binFor(packet.orchestration.id, bucket);
        started += 1;
        console.log(`  started    ${bucket.id}  ${packet.orchestration.id}  bin ${bin.id}`);
      }

      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'START_RESEARCH',
        targetType: 'PROJECT',
        targetId: project.id,
        projectId: project.id,
        result: 'SUCCESS',
        metadata: {
          started: String(started),
          repaired: String(repaired),
          envelope: 'RUSSELL_CASH_DISCOVERY_V1',
        },
      });
      console.log(
        `  ${started} started, ${repaired} bin(s) repaired, ` +
          `${SEARCH_BUCKETS.length - started - repaired} already complete.`,
      );
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
      console.log(`  ${workerIdentity(worker)} researches for ${project.name}.`);
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
      console.log(changed ? `  ${workerIdentity(worker)} no longer reaches ${project.name}.` : '  Nothing to revoke.');
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
    /*
     * The same rows, triaged — and read-only for the same reason.
     *
     * `packets independence` names every packet whose reviewer shared a session
     * with its author; against production that is 117, which reads as 117
     * approvals and is not one. This separates what was demonstrated from what
     * was never attributed, from what is already being re-run, from what is
     * history — and then says, per packet, whether the conclusion is still in
     * use and what depends on it.
     *
     * It needs no `--admin` because it changes nothing: no reopen, no bin, no
     * row. §23 — the scan reports and does not act.
     */
    /*
     * The design decision, recorded by the person who made it.
     *
     * §24's design gate wanted a recorded visual, mobile and interaction
     * approval and got a markdown table. This is the row version, and it is on
     * a terminal for §26's reason: reaching the shell is the authentication and
     * `--admin` is the attribution, resolved against the database rather than
     * trusted. The browser route beside it (`POST /api/russell/design/decisions`)
     * is the same write behind a real session.
     *
     * **Nothing else may write it**, and `tests/step12bProduct.test.ts` asserts
     * that this file is the only script that does. The acceptance reporter
     * reads it and has no path that records one, because a reporter that could
     * record the approval it is waiting for would be approving its own work.
     */
    case 'design show':
    case 'design approve':
    case 'design reject':
    case 'design withdraw': {
      const dir = path.join(REPO_ROOT, 'docs', 'evidence', 'step12b-renders');
      const indexPath = path.join(dir, 'index.json');
      if (!fs.existsSync(indexPath)) {
        fail(
          `No render set at ${path.relative(REPO_ROOT, indexPath)}. There is nothing to decide ` +
            'about yet — produce the renders and run `npm run design:manifest` first.',
        );
      }
      const declared = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        screen: string;
        width: number;
        file: string;
      }[];
      const missing = declared.filter((entry) => !fs.existsSync(path.join(dir, entry.file)));
      if (missing.length > 0) {
        fail(
          `The index declares ${missing.length} render(s) that are not on disk. A decision bound ` +
            'to this set would name bytes that do not exist.',
        );
      }
      const { digest, count } = digestRenderSet(
        declared.map((entry) => ({
          path: entry.file,
          width: entry.width,
          screen: entry.screen,
          bytes: fs.readFileSync(path.join(dir, entry.file)),
        })),
      );
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      const dirty =
        execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
          .trim().length > 0;

      console.log(`  revision  ${revision}${dirty ? '  (TREE DIRTY)' : ''}`);
      console.log(`  renders   ${count}`);
      for (const entry of declared) {
        console.log(`    ${entry.screen.padEnd(26)} ${String(entry.width).padStart(5)}px  ${entry.file}`);
      }
      console.log(`  digest    ${digest}`);

      if (command === 'show') {
        const standing = await standingDecision(revision, digest);
        console.log(
          `  standing  ${standing ? `${standing.decision} by ${standing.approvedByUserId} at ${standing.createdAt}` : 'none for this revision and render set'}`,
        );
        for (const entry of await decisionsForRevision(revision)) {
          console.log(
            `    ${entry.createdAt}  ${entry.decision.padEnd(9)} ${entry.approvedByUserId}` +
              `  ${entry.renderSetDigest.slice(0, 12)}…${entry.note ? `  "${entry.note}"` : ''}`,
          );
        }
        break;
      }

      /*
       * A decision that is not the owner's is not a decision. `administrator()`
       * resolves `--admin` against `users` and refuses anybody who is not an
       * enabled administrator — attribution, which §23 is careful to say is not
       * the same act as authentication. Reaching this shell is what
       * authenticated it.
       */
      const actor = await administrator();
      if (dirty) {
        fail(
          'The tree is dirty, so this decision could only be bound to a revision that exists ' +
            'nowhere. Commit, re-run `npm run design:manifest`, then decide.',
        );
      }
      /*
       * The verb a person types, mapped to the vocabulary the table stores.
       *
       * This was `command.toUpperCase() as DesignDecision`, and the cast is
       * what made it wrong rather than broken: `approve` upper-cases to
       * `APPROVE`, which is not one of `APPROVED | REJECTED | WITHDRAWN`, and
       * the assertion told the compiler not to check. It would have written a
       * value no reader recognises — and because gate O asks
       * `decision !== 'APPROVED'`, a correctly-intended approval would have
       * read back as a *rejection*. An explicit map cannot drift: adding a verb
       * without a decision is a compile error, which is the property a cast
       * throws away.
       */
      const DECISION_FOR: Record<'approve' | 'reject' | 'withdraw', DesignDecision> = {
        approve: 'APPROVED',
        reject: 'REJECTED',
        withdraw: 'WITHDRAWN',
      };
      const decision = DECISION_FOR[command as 'approve' | 'reject' | 'withdraw'];
      const recorded = await recordDesignDecision({
        revision,
        renderSetDigest: digest,
        renderCount: count,
        manifestPath: path.relative(REPO_ROOT, path.join(dir, 'manifest.json')),
        decision,
        approvedByUserId: actor.id,
        note: rest.join(' ') || null,
      });
      console.log(`  recorded  ${recorded.decision} ${recorded.id} by ${actor.email}`);
      console.log('  Appended, never replacing: an earlier decision keeps its row.');
      break;
    }
    /*
     * Putting a subject on the industry map, from the terminal.
     *
     * §38 makes `SEED` the one node origin Brain may never write: the schema
     * requires every other origin to carry the gated claim that established
     * it, so a machine cannot name its own subjects. That invariant is about
     * *Brain*, not about which door a person uses, and it is untouched here —
     * `administrator()` resolves a real enabled Brain administrator out of
     * `users` and refuses otherwise, which is the same authority
     * `decideProjectAccess` at ADMIN asks for on the Cash surface.
     *
     * **Attribution is not authentication**, which §23 records at length. What
     * this establishes is that such a person exists and may authorize this;
     * reaching the shell is what authenticated it, and on this repository that
     * shell is reached by a GitHub Actions job holding the deployment
     * credential. Recording it as a browser approval would be undetectable
     * afterwards, so the event says `TERMINAL` and names the administrator it
     * carries the authority of.
     *
     * It spends nothing and starts nothing. A seed is a row; the allocator
     * decides when the subject is asked about, the discovery grant decides
     * whether that may run, and the evidence gate decides what may be claimed.
     */
    case 'cash seed-industry': {
      const actor = await administrator();
      const project = await projectFrom(rest[0] ?? fail('Name the project.'));
      const name = rest.slice(1).join(' ').trim() || fail('Name the subject to seed.');

      const result = await seedSubject({
        projectId: project.id,
        name,
        actorRef: actor.id,
        reason: `Seeded from the terminal by ${actor.email ?? actor.id}, on a recorded instruction.`,
      });

      await recordIdentityEvent({
        actorType: 'HUMAN',
        actorId: actor.id,
        action: 'UPDATE_PROJECT',
        targetType: 'PROJECT',
        targetId: project.id,
        projectId: project.id,
        result: 'SUCCESS',
      });

      console.log(
        `  ${result.node.id}  ${result.node.name}  [${result.node.kind}/${result.node.origin}]` +
          `  ${result.created ? 'seeded' : 'already on the map'}`,
      );
      // The verdict line is `main`'s own, at column zero, which is what the
      // workflow greps for. This says what happened; it never claims the word.
      console.log(
        result.created
          ? '  Brain decides when to ask about it. Nothing was spent and no research started.'
          : '  It was already on the map, so nothing changed.',
      );
      break;
    }
    case 'packets scope': {
      const project = rest[0] ? await projectFrom(rest[0]) : null;
      const { summary, findings } = await scopeIndependence({ projectId: project?.id ?? null });

      // Printed strongest statement first rather than alphabetically, because
      // that is the order the list has to be read in to be useful.
      const order = [
        'DEMONSTRATED',
        'RECOVERING',
        'UNATTRIBUTED',
        'SUPERSEDED_HISTORY',
        'CLEAN',
      ] as const;
      console.log(`  scanned   ${summary.scanned} packet(s)`);
      for (const status of order) {
        console.log(`  ${status.padEnd(20)} ${summary.byStatus[status]}`);
      }
      console.log(
        `  not clean ${summary.notClean}: ${summary.inUse} still in use, ` +
          `${summary.historical} historical`,
      );
      console.log('');
      console.log(`  ${summary.headline}`);

      if (findings.length === 0) {
        console.log('  Nothing to triage.');
        break;
      }

      console.log('');
      for (const finding of findings) {
        console.log(
          `  ${finding.orchestrationId}  ${finding.status.padEnd(20)}` +
            `${finding.inUse ? 'IN USE    ' : 'historical'}  ${finding.packetStatus}`,
        );
        console.log(`      why:  ${finding.statusReason}`);
        if (finding.conflictedRoles.length > 0) {
          console.log(`      AUTHOR REVIEWED: ${finding.conflictedRoles.join(', ')}`);
        }
        if (finding.unattributedRoles.length > 0 || finding.authorUnattributed) {
          const missing = finding.authorUnattributed
            ? ['the author', ...finding.unattributedRoles]
            : finding.unattributedRoles;
          console.log(`      no session recorded for: ${missing.join(', ')} (unknown, not a finding)`);
        }
        for (const evidence of finding.use) {
          console.log(`      in use: ${evidence.kind} ${evidence.rowId} — ${evidence.detail}`);
        }
        if (finding.notInUseReason) console.log(`      not in use: ${finding.notInUseReason}`);
        for (const dependent of finding.dependents.slice(0, 10)) {
          console.log(
            `      depends: ${dependent.kind} ${dependent.id}` +
              `${dependent.orchestrationId ? ` (${dependent.orchestrationId})` : ''} — ${dependent.label}`,
          );
        }
        if (finding.dependents.length > 10) {
          console.log(`      depends: and ${finding.dependents.length - 10} more`);
        }
      }

      console.log('');
      if (summary.decisions.length === 0) {
        console.log('  No decision is waiting on a person here.');
      } else {
        console.log('  The decisions, and nothing else on this list, are:');
        for (const id of summary.decisions) {
          console.log(`    ${id}  —  packets reaudit ${id} --admin someone@example.com`);
        }
      }
      console.log(
        '  An UNATTRIBUTED packet is not one of them: its remedy is recovering the ' +
          'attribution, never an approval.',
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
    /*
     * The two halves of the synthesis recovery: read the packet, then act on
     * one named item.
     *
     * A list and a targeted action rather than a sweep, for
     * `findStrandedVerifications`' reason — a sweep is how a narrow recovery
     * becomes a general one. Both verdicts come from the same assessment, so
     * what this prints about a packet is what the action would do to it.
     */
    case 'packets syntheses': {
      const project = await projectFrom(rest[0] ?? fail(`Name a project.`));
      const rows = await assessProjectSyntheses(project.id);
      console.log(`SYNTHESES (${rows.length} stopped)`);
      for (const row of rows) {
        console.log(
          `  ${row.workItemId}  ${row.workItemState}  attempts ${row.attempts}` +
            `  packet ${row.orchestrationId ?? '—'} ${row.packetStatus ?? '—'}`,
        );
        console.log(
          `      claims ${row.citableClaims} citable  document ${row.documentId ?? 'NONE'}` +
            `  bin ${row.binId ?? '—'} ${row.binState ?? '—'} ${row.binAttempts ?? ''}` +
            `  mission ${row.missionState ?? '—'}`,
        );
        console.log(`      ${row.eligible ? 'ELIGIBLE' : `REFUSED ${row.refusal}`} — ${row.reason}`);
      }
      break;
    }

    case 'packets recover-synthesis': {
      const actor = await administrator();
      const id = rest[0] ?? fail('Name a synthesis work item.');
      const outcome = await recoverFailedSynthesis({
        workItemId: id,
        actor: { type: 'HUMAN', id: actor.id },
        reason: flag('reason') ?? 'Recovered after the filing path was repaired.',
      });
      console.log(`  ${JSON.stringify(outcome)}`);
      if (!outcome.ok) fail(outcome.reason);
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

    /*
     * §17's audit, read rather than reconstructed: `identity_events` is
     * append-only, and this is the one terminal reader of it. A read, so it
     * needs no `--admin` — the same rule `people list` and `workers list`
     * already follow.
     *
     * What is printed is exactly what the repository's own `IdentityEvent`
     * shape stores minus what §17 forbids: `credentialId`, `metadata`,
     * `userAgent` and `remoteAddr` never cross into this terminal, because an
     * identity event may hold identifiers, prefixes and categories and must
     * never hold anything that reads like a credential.
     */
    case 'identity events': {
      const resultFlag = flag('result');
      let result: IdentityResult | undefined;
      if (resultFlag !== null) {
        const normalized = resultFlag.trim().toUpperCase();
        const match = IDENTITY_RESULTS.find((candidate) => candidate === normalized);
        if (!match) {
          fail(
            `"${resultFlag}" is not a valid result. Expected one of: ${IDENTITY_RESULTS.join(', ')}.`,
          );
        }
        result = match;
      }
      let limit = 200;
      const limitFlag = flag('limit');
      if (limitFlag !== null) {
        const parsed = Number(limitFlag.trim());
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
          fail(`"${limitFlag}" is not a valid limit. It must be a whole number between 1 and 1000.`);
        }
        limit = parsed;
      }
      const actorId = flag('actor');
      const projectId = flag('project');
      const action = flag('action');
      const events = await listIdentityEvents({
        ...(actorId ? { actorId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(action ? { action } : {}),
        ...(result ? { result } : {}),
        limit,
      });
      for (const event of events) {
        console.log(
          `  ${event.createdAt}  actor=${event.actorType}:${event.actorId ?? '—'}  ` +
            `action=${event.action}  result=${event.result}` +
            (event.reason ? `  reason=${event.reason}` : '') +
            (event.targetType ? `  target=${event.targetType}:${event.targetId ?? '—'}` : '') +
            (event.projectId ? `  project=${event.projectId}` : ''),
        );
      }
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
