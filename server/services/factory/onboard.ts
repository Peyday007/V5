/**
 * Onboarding a repository: the identity, the scope, the routing, and the one
 * step that is not Brain's to take.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * §27 says authorizing a repository is three things, and that any one of them
 * missing authorizes nothing:
 *
 *   1. a grant in `repositoryEnvelope.ts` — in code, reviewed, because nobody
 *      supplies the limits their own work is judged against;
 *   2. a worker registered to be handed `FACTORY` work **for that repository**;
 *   3. push access where that worker runs.
 *
 * The first is a change somebody merges. The third is granted on the surface the
 * worker runs on and Brain holds no credential for it, by design. The second was
 * a `worker_routing` row an operator had to compose by hand on a terminal — and a
 * membership, and a scope set, and an identity to hang them on, each of which has
 * a wrong answer that fails silently. `connectSite` learned this already: a
 * connected site given the research scope set is refused by every route with the
 * same 404 a missing project gives, and tells nobody anything.
 *
 * So this is the same shape as Connected sites, for the same reason. Brain makes
 * or reuses the identity, applies a **fixed** scope set, writes the routing row
 * from the grant rather than from anything a caller sent, and reports what it did
 * and what is left. Nothing is asked that has a wrong answer.
 *
 * ---------------------------------------------------------------------------
 * What it deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * **It issues no credential.** A factory worker reaches Brain through the Cowork
 * connector, which authenticates with OAuth (§22) — so what it needs is not a
 * secret to paste but a way for the consent screen to name it. That is a worker
 * invitation: single-use, expiring, and worthless on its own. It cannot read,
 * cannot call a tool and cannot obtain a token; all it does is make the browser
 * that opens it able to approve **that one worker**, and a signed-in person still
 * has to approve. Minting a `brnw_` bearer here would be handing out a live
 * credential for a door this worker does not use.
 *
 * **It cannot register the surface**, and that is the honest boundary rather than
 * an omission. A fire surface is a Routine in somebody's Cowork account with its
 * own per-Routine token, and a connector authenticated as this worker. Brain can
 * say precisely what is missing and can notice the moment it arrives; it cannot
 * create it, and a Brain that could mint its own workers or choose their
 * permissions would be exactly what §22's split forbids.
 *
 * **It widens nothing.** The grant it reads is the envelope's, matched by id; a
 * repository that is not in the envelope cannot be onboarded here however the
 * request is spelled.
 */
import { REPOSITORY_ENVELOPE_ID, decideRepository, listRepositoryGrants } from './repositoryEnvelope.ts';
import type { RepositoryGrant } from './repositoryEnvelope.ts';
import {
  createWorker,
  getWorkerByName,
  getWorkerRouting,
  grantMembership,
  listMembershipsForPrincipal,
  recordIdentityEvent,
  setWorkerRouting,
  setWorkerStatus,
} from '../../repos/identity.ts';
import { listRoutines } from '../../repos/fleet.ts';
import { listBins } from '../../repos/bins.ts';
import { repositoryIdOf } from '../bins/routing.ts';
import { createInvitation, revokeInvitationsForWorker } from '../../repos/invitations.ts';
import { generateInvitationToken } from '../identity/secrets.ts';
import { FACTORY_WORKER_SCOPES } from '../../domain/types.ts';
import type { User, WorkerScope } from '../../domain/types.ts';

/**
 * The capabilities a factory surface must declare to be fired for this work.
 *
 * Both, because the stages that push are the ones that cannot be skipped: a fleet
 * whose only factory surface can read but not push produces a campaign that plans
 * and then reports an honest blocker forever. Declaring both here means the fire
 * router never chooses such a surface in the first place.
 */
export const FACTORY_ROUTING_CAPABILITIES: readonly string[] = ['repository', 'repository-write'];

/** `owner/name`, the id `worker_routing` and `services/bins/routing.ts` compare on. */
export function repositoryIdOfRemote(remote: string): string | null {
  const trimmed = remote.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(trimmed);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * The worker name a grant onboards to.
 *
 * Derived from the grant id rather than chosen, so onboarding the same repository
 * twice repairs one identity instead of accumulating them — and so the name in
 * `fleet show`, in a routing row and on an audit event is the same string a person
 * reads on the card.
 */
export function factoryWorkerName(grantId: string): string {
  return `factory-${grantId}`.slice(0, 60);
}

export type RepositoryReadiness =
  /** No identity, no routing row: nothing could execute this repository. */
  | 'NOT_ONBOARDED'
  /** Brain's half is done; no enabled Routine resolves to this worker yet. */
  | 'AWAITING_SURFACE'
  /** A worker is registered for it and an enabled Routine is bound to that worker. */
  | 'READY';

export interface RepositoryOnboarding {
  grantId: string;
  remote: string;
  repositoryId: string | null;
  description: string;
  defaultBranch: string;
  mayOpenPullRequest: boolean;
  workerName: string;
  workerId: string | null;
  /** True when the membership on this project carries exactly the fixed set. */
  scopesCorrect: boolean;
  routedFamilies: string[];
  routedRepositories: string[];
  /** Enabled Routines whose worker is this one. Names only; never a secret. */
  surfaces: string[];
  readiness: RepositoryReadiness;
  /** What a person still has to do, in the order they have to do it. */
  remaining: string[];
  /**
   * Stages already waiting on this, which resume by themselves afterwards.
   *
   * Counted from rows rather than promised: a bin that is `READY` for this
   * repository and whose current-generation intent is deferred on a refusal an
   * operator resolves is, precisely, work the missing surface is holding up.
   * It is what makes the remaining steps worth taking today rather than an
   * abstract setup task, and it is why `rearmSurfaceDeferredIntents` exists —
   * nobody has to come back and start any of it again.
   */
  waiting: number;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

const CONNECTOR_STEP =
  'In Claude, add a second connector to this Brain’s /mcp endpoint and open the ' +
  'invitation link first, so the consent screen offers this worker and no other.';
const SURFACE_STEP =
  'In Cowork, create a Routine that uses that connector with the repository attached, then ' +
  'register it: `fleet register-routine --account <name> --ref <trig_…> --secret <SECRET_NAME> ' +
  '--capabilities repository,repository-write`. Brain fires the Routine and never holds the ' +
  'repository’s own credential.';

/**
 * What each authorized repository's onboarding currently looks like.
 *
 * Derived on the read path from identity, routing and fleet rows — never stored,
 * for the reason §25 gives about the connect projection: a stored readiness is a
 * fact about when it was written, and the question a person is asking is about
 * now.
 */
export async function repositoryOnboarding(projectId: string): Promise<RepositoryOnboarding[]> {
  const routines = await listRoutines();
  const out: RepositoryOnboarding[] = [];
  for (const grant of listRepositoryGrants()) {
    out.push(await describeGrant(projectId, grant, routines));
  }
  return out;
}

/**
 * How much work is already waiting on this repository's surface.
 *
 * Counted from rows rather than promised, and counted the simple way on
 * purpose: routing keys on the repository the bin's manifest names (§27), so
 * while this grant has no surface, a `READY` bin naming it is work that nothing
 * can be handed. Whether its intent happens to be deferred, unattempted or
 * newly superseded is a fact about the last tick rather than about the person's
 * question, and reading it would make the number flicker between refreshes.
 *
 * It is only ever asked of a grant that is *not* `READY`, which is what makes
 * that reasoning hold.
 */
async function waitingFor(projectId: string, repositoryId: string | null): Promise<number> {
  if (!repositoryId) return 0;
  const bins = await listBins({ projectId, states: ['READY'], limit: 200 });
  return bins.filter((bin) => repositoryIdOf(bin) === repositoryId).length;
}

async function describeGrant(
  projectId: string,
  grant: RepositoryGrant,
  routines: Awaited<ReturnType<typeof listRoutines>>,
): Promise<RepositoryOnboarding> {
  const workerName = factoryWorkerName(grant.id);
  const worker = await getWorkerByName(workerName);
  const repositoryId = repositoryIdOfRemote(grant.remote);

  let scopesCorrect = false;
  let routedFamilies: string[] = [];
  let routedRepositories: string[] = [];
  let surfaces: string[] = [];

  if (worker && !worker.archived) {
    const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
    const here = memberships.find((m) => m.projectId === projectId && m.active);
    scopesCorrect = here ? sameSet(here.scopes, FACTORY_WORKER_SCOPES) : false;
    const routing = await getWorkerRouting(worker.id);
    routedFamilies = routing?.families ?? [];
    routedRepositories = routing?.repositories ?? [];
    surfaces = routines
      .filter((routine) => routine.workerId === worker.id && routine.state === 'ENABLED')
      .map((routine) => routine.name);
  }

  const registered =
    worker !== null &&
    !worker.archived &&
    scopesCorrect &&
    routedFamilies.includes('FACTORY') &&
    repositoryId !== null &&
    routedRepositories.includes(repositoryId);

  const readiness: RepositoryReadiness = !registered
    ? 'NOT_ONBOARDED'
    : surfaces.length === 0
      ? 'AWAITING_SURFACE'
      : 'READY';

  const remaining: string[] = [];
  if (!registered) {
    remaining.push('Onboard this repository, which registers a worker for it and issues one invitation.');
  }
  if (registered && surfaces.length === 0) {
    remaining.push(CONNECTOR_STEP, SURFACE_STEP);
  }

  return {
    grantId: grant.id,
    remote: grant.remote,
    repositoryId,
    description: grant.description,
    defaultBranch: grant.defaultBranch,
    mayOpenPullRequest: grant.mayOpenPullRequest,
    workerName,
    workerId: worker?.id ?? null,
    scopesCorrect,
    routedFamilies,
    routedRepositories,
    surfaces,
    readiness,
    remaining,
    waiting: readiness === 'READY' ? 0 : await waitingFor(projectId, repositoryId),
  };
}

export interface OnboardResult {
  onboarding: RepositoryOnboarding;
  /** Shown once. It authorizes nothing on its own — see the header. */
  invitationUrl: string;
  invitationExpiresAt: string;
  createdIdentity: boolean;
  repairedScopes: boolean;
}

export type OnboardRefusal =
  | { ok: false; reason: string }
  | { ok: true; result: OnboardResult };

/**
 * Register a worker for one authorized repository, and issue its invitation.
 *
 * Idempotent by identity: onboarding the same grant twice reuses the worker,
 * rewrites the membership and the routing row from the constants, and replaces the
 * invitation rather than adding a second one — so this is a **repair** and a
 * **rotation** as much as a setup, which is `connectSite`'s reasoning and the same
 * property: there is never more than one live invitation to reason about.
 */
export async function onboardRepository(input: {
  projectId: string;
  grantId: string;
  actor: User;
  origin: string;
}): Promise<OnboardRefusal> {
  const grant = listRepositoryGrants().find((candidate) => candidate.id === input.grantId);
  if (!grant) {
    // The same refusal an unauthorized remote gets, and for the same reason:
    // naming which grants exist would tell a caller what it may not have.
    return {
      ok: false,
      reason:
        'That is not a repository this factory is authorized to work in. Authorizing one is a ' +
        'reviewed change to the envelope in code, deliberately, so that nobody can widen what ' +
        'the factory may touch by making a request.',
    };
  }
  // Belt and braces: the envelope is asked again on the remote, so a grant id that
  // ever stopped agreeing with its own remote refuses rather than onboards.
  const decision = decideRepository(grant.remote);
  if (!decision.ok || !decision.grant) {
    return { ok: false, reason: decision.reason ?? 'That repository is not authorized.' };
  }
  const repositoryId = repositoryIdOfRemote(grant.remote);
  if (!repositoryId) {
    return {
      ok: false,
      reason: `The grant's remote (${grant.remote}) is not an owner/name this router can compare on.`,
    };
  }

  const workerName = factoryWorkerName(grant.id);
  const existing = await getWorkerByName(workerName);
  if (existing?.archived) {
    // Archiving is terminal by design, and resurrecting an identity somebody
    // retired would make every audit row naming it ambiguous.
    return {
      ok: false,
      reason:
        `The identity for this repository (${workerName}) was archived, which is terminal. ` +
        'Authorize the repository under a new grant id, so its history stays unambiguous.',
    };
  }

  const before = await describeGrant(input.projectId, grant, await listRoutines());

  const worker =
    existing ??
    (await createWorker({
      name: workerName,
      displayName: `Factory · ${repositoryId}`,
      workerType: 'MCP',
      description: `Executes Software Factory campaigns for ${repositoryId}.`,
      createdByType: 'HUMAN',
      createdById: input.actor.id,
    }));
  if (existing && existing.disabledAt) await setWorkerStatus(worker.id, 'ACTIVE');

  await grantMembership({
    projectId: input.projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: [...FACTORY_WORKER_SCOPES] as WorkerScope[],
    grantedByType: 'HUMAN',
    grantedById: input.actor.id,
  });

  await setWorkerRouting({
    workerId: worker.id,
    families: ['FACTORY'],
    repositories: [repositoryId],
    capabilities: [...FACTORY_ROUTING_CAPABILITIES],
    reason:
      `Registered for ${repositoryId} only. Not research, not Russell, and no other repository: ` +
      'an explicit row is exhaustive, so this identity can be handed nothing else.',
    setBy: `factory-onboarding:${input.actor.id}`,
  });

  const revokedInvitations = await revokeInvitationsForWorker(worker.id);
  const token = generateInvitationToken();
  const invitation = await createInvitation({
    workerId: worker.id,
    tokenPrefix: token.prefix,
    tokenDigest: token.digest,
    createdByUserId: input.actor.id,
    note: `Connecting the factory surface for ${repositoryId}.`,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actor.id,
    action: 'ONBOARD_FACTORY_REPOSITORY',
    targetType: 'WORKER',
    targetId: worker.id,
    projectId: input.projectId,
    result: 'SUCCESS',
    // The grant, the scope set, the routing and the invitation *id*. Never the
    // invitation token, and never anything it could be reconstructed from.
    metadata: {
      grantId: grant.id,
      envelopeId: REPOSITORY_ENVELOPE_ID,
      repositoryId,
      scopes: [...FACTORY_WORKER_SCOPES],
      families: ['FACTORY'],
      capabilities: [...FACTORY_ROUTING_CAPABILITIES],
      invitationId: invitation.id,
      revokedInvitations,
      createdIdentity: existing === null,
    },
  });

  const onboarding = await describeGrant(input.projectId, grant, await listRoutines());
  return {
    ok: true,
    result: {
      onboarding,
      invitationUrl: `${input.origin.replace(/\/+$/, '')}/oauth/invite/${token.plaintext}`,
      invitationExpiresAt: invitation.expiresAt,
      createdIdentity: existing === null,
      repairedScopes: before.workerId !== null && !before.scopesCorrect,
    },
  };
}
