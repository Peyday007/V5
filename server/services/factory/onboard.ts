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
import { fleetSnapshot, routingRefusalByRoutine } from '../dispatch/candidates.ts';
import { FACTORY_MCP_PATH, MCP_PATH } from '../../mcp/endpoint.ts';
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
import { capacityReading } from '../fleet/capacity.ts';
import { listRoutines } from '../../repos/fleet.ts';
import { listBins } from '../../repos/bins.ts';
import { repositoryIdOf } from '../bins/routing.ts';
import { createInvitation, revokeInvitationsForWorker } from '../../repos/invitations.ts';
import { getProjectRepository, setProjectRepository } from '../../repos/factory.ts';
import { ScopeError, describeBoundary, directoriesOf, scopeFromDeclaration } from './projectScope.ts';
import type { ScopeDeclaration } from './projectScope.ts';
import { generateInvitationToken } from '../identity/secrets.ts';
import { FACTORY_WORKER_SCOPES } from '../../domain/types.ts';
import type { User, WorkerScope } from '../../domain/types.ts';
import type { FactoryScopeKind } from '../../domain/factory.ts';
import {
  contributedCapacity,
  contributedForRepository,
} from '../capacity/contribution.ts';

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
  /**
   * Enabled Routines whose worker is this one — one entry each, never a secret.
   *
   * Structured rather than a list of names, because a list of names cannot be
   * counted. "Running on Factory Brain A, B and C" reads as three Claude
   * accounts, and three Routines on one subscription produce exactly that
   * sentence — §23's account-versus-Routine distinction collapsed on the one
   * screen a person uses to decide whether the fleet is big enough. A second
   * Routine on an account doubles how fast Brain can *start* sessions and
   * changes nothing about how much that account may *do*.
   *
   * `proven` is the four-row chain, read through `capacityReading` rather than
   * derived here: it is already the single reader of `proveSurface` for
   * `/people`, and a second one would eventually disagree with it about whether
   * a surface works. Registered and enabled is not proven — that is the
   * CONFIGURED-masquerading-as-VERIFIED refusal `fleet verify-surface`,
   * `verify-pool` and `capacity.ts` all already make, and this card did not.
   */
  surfaces: { routineName: string; accountName: string; proven: boolean }[];
  /**
   * Distinct Claude accounts behind those surfaces.
   *
   * The number a reader is actually after, and never the length of `surfaces`.
   */
  accountsServing: number;
  /** How many of them have a completed fire → arrive → assign → finish chain. */
  provenSurfaces: number;
  /**
   * Member-contributed Claude connections this repository could actually use.
   *
   * A person connecting their own Claude account registers a fleet Routine, and
   * the factory fires Routines — so their capacity is visible to this pool
   * through the fleet it already reads. What it is **not** is automatically
   * usable here: §27's rule is that no worker without an explicit
   * `worker_routing` row may ever be handed repository work, and that row is
   * written by onboarding a repository, which is a person's decision at ADMIN.
   *
   * So this names the connections that are *both* verified capacity — the four
   * -row proof chain closed, a live authorization, an enabled surface bound to
   * that member's own worker, and the deployment credential present — and
   * routed to this repository for this family. An unverified, lapsed, revoked
   * or misbound one can never appear in it, and neither can one nobody has
   * authorized for this repository.
   */
  contributedSurfaces: { displayName: string; workerName: string; routineName: string | null }[];
  /**
   * The endpoint path a factory connector is pointed at, as a constant.
   *
   * A path rather than a URL, because Brain does not know its own public
   * address without a request and a guessed one is worse than none: the surface
   * that renders this is served from that address and can say it exactly. It
   * authorizes nothing — see `FACTORY_MCP_PATH`.
   */
  connectorPath: string;
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
  /**
   * What this project may change in it, and whether anybody has said.
   *
   * `null` means the question has not been answered for this project, which is
   * a different fact from "the whole repository" and is the one
   * `submitObjective` refuses on. See `projectScope.ts`.
   */
  boundary: {
    scopeKind: FactoryScopeKind;
    directories: string[];
    sentence: string;
  } | null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/*
 * The two steps Brain cannot take, in the order they have to happen, and worded
 * so that neither has a value left to invent.
 *
 * The ordering in the first one still matters: the invitation sets a cookie in
 * the browser that opens it, and that cookie is what lets the consent screen
 * name *this* worker.
 *
 * **The URL matters for a reason that is nothing to do with authority.** Claude
 * keys its connector registry by URL and refuses a second connector at one an
 * existing connector already holds, so a Brain whose research connector is at
 * `/mcp` cannot have a factory connector there too. `FACTORY_MCP_PATH` is the
 * same endpoint under a second name, and it decides nothing: the credential the
 * connection ends up holding is what says which worker this is.
 *
 * **And the old wording was wrong about the list.** It said a chooser meant the
 * link had not been opened in that browser. It does not: `/oauth/authorize`
 * checks for a signed-in administrator *before* it looks for an invitation, so
 * anybody signed in to this Brain gets the chooser with or without one — which
 * is the ordinary case for the person who just pressed Onboard. The chooser
 * names the held invitation and preselects its worker, and connecting from
 * there is correct and does not spend the invitation. Sending that person back
 * to re-open a link that was working is the shape this file keeps having to
 * correct: a remedy for a condition that was never true.
 *
 * The second names both capabilities rather than "the capabilities", because a
 * surface that can read but not push produces a campaign that plans and then
 * reports an honest blocker for ever.
 */
function connectorStep(workerName: string): string {
  return (
    'Open the invitation link below in the browser you will authorise from — first, before ' +
    'anything else — then in Claude add a connector whose URL is this Brain’s address ' +
    `followed by ${FACTORY_MCP_PATH}, and press Connect. That path is deliberately not the ` +
    `research connector’s ${MCP_PATH}: Claude will not hold two connectors at one URL, and ` +
    'the path itself grants nothing — the worker you approve is what decides what the ' +
    `connection can do. Approve as ${workerName}. If you are signed in to Brain you will be ` +
    'offered a list with that worker already chosen, which is correct — it is not a sign ' +
    'the link was opened in the wrong browser.'
  );
}
const SURFACE_STEP =
  'In Cowork, create a Routine with this repository attached and that connector — and only ' +
  'that connector — enabled, with an API trigger and no schedule. Put its trigger token in the ' +
  'deployment secrets, then run Fleet: `register-routine --account <name> --ref <trig_…> ' +
  '--secret <SECRET_NAME> --capabilities repository,repository-write`, `bind-worker --ref ' +
  '<trig_…> --worker <this worker>`, and `verify-surface --ref <trig_…>`. Brain fires the ' +
  'Routine and never holds the repository’s own credential. ' +
  'The full walkthrough is docs/workers/CONNECTING-THE-FACTORY-WORKER.md.';

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
  // Read once for the whole list. It walks every member's connection, and the
  // answer cannot differ between two repositories on one page.
  const contributed = await contributedCapacity();
  /*
   * And the fleet's own reading of which surfaces have actually run, once, for
   * the same reason: it walks every Routine's sessions and bins, and the answer
   * cannot differ between two repositories on one page.
   */
  const capacity = await capacityReading();
  const out: RepositoryOnboarding[] = [];
  for (const grant of listRepositoryGrants()) {
    out.push(await describeGrant(projectId, grant, routines, contributed, capacity));
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
  /*
   * Read once by the caller and passed down, rather than read per grant.
   *
   * It walks every member's connection and the rows behind it, so asking it
   * inside the loop would be that walk multiplied by the number of authorized
   * repositories — for an answer that cannot differ between them.
   */
  contributed: Awaited<ReturnType<typeof contributedCapacity>>,
  /** The fleet's own per-surface reading, read once by the caller. */
  capacity: Awaited<ReturnType<typeof capacityReading>>,
): Promise<RepositoryOnboarding> {
  const workerName = factoryWorkerName(grant.id);
  const worker = await getWorkerByName(workerName);
  const repositoryId = repositoryIdOfRemote(grant.remote);

  let scopesCorrect = false;
  let routedFamilies: string[] = [];
  let routedRepositories: string[] = [];
  let surfaces: RepositoryOnboarding['surfaces'] = [];
  /** The same list with the account id kept, which only the count needs. */
  let live: (RepositoryOnboarding['surfaces'][number] & { accountId: string })[] = [];
  /** Why the router refuses each bound surface; `null` for one it would fire. */
  let refusals = new Map<string, string | null>();

  if (worker && !worker.archived) {
    const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
    const here = memberships.find((m) => m.projectId === projectId && m.active);
    scopesCorrect = here ? sameSet(here.scopes, FACTORY_WORKER_SCOPES) : false;
    const routing = await getWorkerRouting(worker.id);
    routedFamilies = routing?.families ?? [];
    routedRepositories = routing?.repositories ?? [];
    /*
     * A surface the fleet has no reading for is reported as unproven rather
     * than skipped. `capacityReading` leaves out the verification identities
     * and separates retired Routines, so an absent entry means "the fleet does
     * not count this as live capacity" — which is not the same fact as a
     * completed chain, and must never be rounded into one.
     */
    const health = new Map(capacity.surfaces.map((one) => [one.routineId, one]));
    const bound = routines.filter((routine) => routine.workerId === worker.id && routine.state === 'ENABLED');
    refusals = routingRefusalByRoutine(await fleetSnapshot(), bound.map((one) => one.id));
    live = bound
      .map((routine) => ({
        routineName: routine.name,
        // The id, so the count below is on identity rather than on a label.
        // Names are unique — `register-account` refuses a duplicate — and a
        // count keyed on one would still be a count that two renames could
        // change. A surface the fleet has no reading for keys on its own
        // Routine name, so it is never silently merged with another.
        accountId: health.get(routine.id)?.accountId ?? `unattributed:${routine.id}`,
        accountName: health.get(routine.id)?.accountName ?? '—',
        proven: health.get(routine.id)?.proven === true,
      }));
    surfaces = live.map(({ routineName, accountName, proven }) => ({
      routineName,
      accountName,
      proven,
    }));
  }

  const boundaryRow = await getProjectRepository(projectId, grant.id);
  const forThisOne = contributedForRepository(contributed, repositoryId);

  const registered =
    worker !== null &&
    !worker.archived &&
    scopesCorrect &&
    routedFamilies.includes('FACTORY') &&
    repositoryId !== null &&
    routedRepositories.includes(repositoryId) &&
    /*
     * The boundary is part of being onboarded rather than a later step.
     *
     * Without it `submitObjective` refuses, so a card that read READY while no
     * objective could be submitted would be the state §24 keeps having to
     * correct: waiting on something nobody is being asked for.
     */
    boundaryRow !== null;

  /*
   * READY means the dispatcher would fire one of these surfaces — the router's
   * answer (§23), not the Routine's state column. A disabled worker keeps its
   * memberships and its Routine keeps reading ENABLED; an account can be
   * unavailable; a secret can be missing. None of those is ready, and a card
   * reading READY over them tells a person their submission will run.
   */
  const routable = [...refusals.values()].filter((one) => one === null).length;
  const readiness: RepositoryReadiness = !registered
    ? 'NOT_ONBOARDED'
    : routable === 0
      ? 'AWAITING_SURFACE'
      : 'READY';

  const remaining: string[] = [];
  if (!registered) {
    remaining.push('Onboard this repository, which registers a worker for it and issues one invitation.');
  }
  if (registered && surfaces.length === 0) {
    remaining.push(connectorStep(workerName), SURFACE_STEP);
  }
  if (registered && surfaces.length > 0 && routable === 0) {
    const why = [...new Set([...refusals.values()].filter((one): one is string => one !== null))].join('; ');
    remaining.push(
      `A surface is registered for this worker and the dispatcher would not fire it (${why}). ` +
        'A Brain administrator corrects that condition; nothing has to be registered again.',
    );
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
    accountsServing: new Set(live.map((one) => one.accountId)).size,
    provenSurfaces: surfaces.filter((one) => one.proven).length,
    contributedSurfaces: forThisOne.map((one) => ({
      displayName: one.displayName,
      workerName: one.workerName,
      routineName: one.routineName,
    })),
    connectorPath: FACTORY_MCP_PATH,
    readiness,
    remaining,
    waiting: readiness === 'READY' ? 0 : await waitingFor(projectId, repositoryId),
    boundary: boundaryRow
      ? {
          scopeKind: boundaryRow.scopeKind,
          directories: directoriesOf(boundaryRow.pathScope),
          sentence: describeBoundary(boundaryRow),
        }
      : null,
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
  /**
   * What this project may change in it. **Required, with no default.**
   *
   * The whole repository is an ordinary answer and it has to be *given*: the
   * defect this closes is that the widest scope used to be what you got by
   * saying nothing. There is no overload of this function without it, for the
   * same reason `validateProposal` has none without a principal.
   */
  scope: ScopeDeclaration;
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

  /*
   * The boundary is checked before anything is created, because the cheapest
   * place to refuse is before a row exists — and because a refusal here is
   * about what a person typed rather than about the state of the fleet.
   */
  let pathScope: string[];
  try {
    pathScope = scopeFromDeclaration(input.scope);
  } catch (error: unknown) {
    if (error instanceof ScopeError) return { ok: false, reason: error.message };
    throw error;
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

  const before = await describeGrant(
    input.projectId,
    grant,
    await listRoutines(),
    await contributedCapacity(),
    await capacityReading(),
  );

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

  /*
   * The boundary, written in the same action as the routing row and from the
   * same grant. Two rows that must agree about the same repository, written
   * together rather than by two people at two times.
   */
  const boundary = await setProjectRepository({
    projectId: input.projectId,
    grantId: grant.id,
    repositoryId,
    scopeKind: input.scope.kind as FactoryScopeKind,
    pathScope,
    reason:
      input.scope.kind === 'WHOLE_REPOSITORY'
        ? `This project owns the whole of ${repositoryId}.`
        : `This project owns ${directoriesOf(pathScope).join(', ')} in ${repositoryId} and nothing else in it.`,
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
      scopeKind: boundary.scopeKind,
      pathScope: boundary.pathScope,
      invitationId: invitation.id,
      revokedInvitations,
      createdIdentity: existing === null,
    },
  });

  const onboarding = await describeGrant(
    input.projectId,
    grant,
    await listRoutines(),
    await contributedCapacity(),
    await capacityReading(),
  );
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
