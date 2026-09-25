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
import { FACTORY_MCP_PATH, MCP_PATH } from '../../mcp/endpoint.ts';
import { REPOSITORY_ENVELOPE_ID, decideRepository, listRepositoryGrants } from './repositoryEnvelope.ts';
import type { RepositoryGrant } from './repositoryEnvelope.ts';
import {
  createWorker,
  getUser,
  getWorkerByName,
  getWorkerRouting,
  listUsers,
  grantMembership,
  listMembershipsForPrincipal,
  recordIdentityEvent,
  setWorkerRouting,
  setWorkerStatus,
} from '../../repos/identity.ts';
import { capacityReading } from '../fleet/capacity.ts';
import { listRoutines } from '../../repos/fleet.ts';
import { listBins } from '../../repos/bins.ts';
import { decideBinRouting, repositoryIdOf } from '../bins/routing.ts';
import { workerRoutingFor } from '../bins/service.ts';
import { fleetSnapshot, type FleetSnapshot } from '../dispatch/candidates.ts';
import {
  repositoryProbeWork,
  surfaceEligibility,
  type SurfaceDispatch,
} from '../dispatch/surfaceEligibility.ts';
import {
  createInvitation,
  listInvitationsForWorker,
  revokeInvitationForWorker,
  revokeRotatingInvitationsForWorker,
} from '../../repos/invitations.ts';
import { getProjectRepository, setProjectRepository } from '../../repos/factory.ts';
import { ScopeError, describeBoundary, directoriesOf, scopeFromDeclaration } from './projectScope.ts';
import type { ScopeDeclaration } from './projectScope.ts';
import { generateInvitationToken } from '../identity/secrets.ts';
import { FACTORY_WORKER_SCOPES } from '../../domain/types.ts';
import type { Bin, Principal, User, WorkerInvitation, WorkerScope } from '../../domain/types.ts';
import { personName } from '../../domain/personName.ts';
import { peopleReading, type MemberState } from '../identity/people.ts';
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
  /** Brain's half is done; no Routine is configured for this worker yet. */
  | 'AWAITING_SURFACE'
  /**
   * Routines are configured for this worker and the dispatcher would fire none
   * of them — a missing deployment secret, a missing capability, a surface or
   * account out of routing. Every one names the operator write that answers it.
   */
  | 'NO_USABLE_SURFACE'
  /**
   * A surface passes every dimension an operator controls and is refused only
   * for capacity — a provider cooldown, a target reached, a paused fleet. It
   * resumes by itself; nothing about the registration is wrong.
   */
  | 'WAITING_FOR_CAPACITY'
  /** The dispatcher would fire at least one surface for this repository's work now. */
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
  surfaces: {
    routineName: string;
    accountName: string;
    /** Configured, as the fleet row says it: ENABLED, DRAINING, QUARANTINED… */
    state: string;
    /**
     * What the dispatcher would do with this repository's work on this surface
     * now — read from `routeBin` through `surfaceEligibility`, never restated.
     */
    dispatch: SurfaceDispatch;
    /** The router's decision about this surface, and its remedy, in one sentence. */
    dispatchReason: string;
    /** History: a completed fire → arrive → assign → finish chain. Not capacity. */
    proven: boolean;
  }[];
  /**
   * Distinct Claude accounts behind the surfaces that can take this work —
   * eligible now, or waiting only on capacity.
   *
   * The number a reader is actually after, and never the length of `surfaces`.
   * A configured surface the dispatcher will not fire is not an account serving
   * anything, however it is registered.
   */
  accountsServing: number;
  /** Surfaces the dispatcher would fire for this work now. */
  eligibleSurfaces: number;
  /**
   * How many configured surfaces have a completed fire → arrive → assign →
   * finish chain. History, not capacity: a proven surface that has since been
   * taken out of routing still counts here and still counts for nothing above.
   */
  provenSurfaces: number;
  /** One sentence, composed by the server, saying which of the readiness answers this is and why. */
  summary: string;
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
  return (await repositoryOnboardingWithSnapshot(projectId)).repositories;
}

/** Also return the exact snapshot used by readiness, for Build's allocation preview. */
export async function repositoryOnboardingWithSnapshot(projectId: string): Promise<{
  repositories: RepositoryOnboarding[];
  snapshot: FleetSnapshot;
}> {
  const inputs = await fleetInputs();
  const out: RepositoryOnboarding[] = [];
  for (const grant of listRepositoryGrants()) {
    out.push(await describeGrant(projectId, grant, inputs));
  }
  return { repositories: out, snapshot: inputs.snapshot };
}

/**
 * Everything `describeGrant` reads about the fleet, read once.
 *
 * Each of these walks every Routine (or every member's connection) and the
 * answer cannot differ between two repositories on one page, so asking inside
 * the loop would be that walk multiplied by the number of authorized
 * repositories for nothing.
 *
 * `snapshot` is `fleetSnapshot()` — the identical read the dispatch tick
 * performs — and it is what every surface's eligibility is judged against, so
 * this card and the dispatcher are reading one set of numbers.
 */
interface FleetInputs {
  routines: Awaited<ReturnType<typeof listRoutines>>;
  contributed: Awaited<ReturnType<typeof contributedCapacity>>;
  capacity: Awaited<ReturnType<typeof capacityReading>>;
  snapshot: FleetSnapshot;
  now: string;
}

async function fleetInputs(): Promise<FleetInputs> {
  const now = new Date();
  return {
    routines: await listRoutines(),
    contributed: await contributedCapacity(),
    capacity: await capacityReading(),
    snapshot: await fleetSnapshot(now),
    now: now.toISOString(),
  };
}

/**
 * The work a campaign in this repository would put in front of the fleet —
 * `repositoryProbeWork` with the capabilities the pushing stages require.
 */
export function factoryProbeWork(projectId: string, remote: string): Bin {
  return repositoryProbeWork({ projectId, remote, requiredCapabilities: FACTORY_ROUTING_CAPABILITIES });
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
  inputs: FleetInputs,
): Promise<RepositoryOnboarding> {
  const { routines, contributed, capacity, snapshot, now } = inputs;
  const workerName = factoryWorkerName(grant.id);
  const worker = await getWorkerByName(workerName);
  const repositoryId = repositoryIdOfRemote(grant.remote);
  const work = factoryProbeWork(projectId, grant.remote);

  let scopesCorrect = false;
  let routedFamilies: string[] = [];
  let routedRepositories: string[] = [];
  /**
   * Whether an arriving session of this worker would be *handed* this work —
   * the assigner's decision, `decideBinRouting`, over the worker's own rows.
   * The fire and the hand-over are two readers of one routing boundary; the
   * card asks both, so it cannot read ready over a worker the assigner refuses.
   */
  let admission: { ok: boolean; reason?: string } = { ok: false };
  let surfaces: RepositoryOnboarding['surfaces'] = [];
  /** The same list with the account id kept, which only the count needs. */
  let live: (RepositoryOnboarding['surfaces'][number] & { accountId: string })[] = [];

  if (worker && !worker.archived) {
    const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
    const here = memberships.find((m) => m.projectId === projectId && m.active);
    scopesCorrect = here ? sameSet(here.scopes, FACTORY_WORKER_SCOPES) : false;
    const routing = await getWorkerRouting(worker.id);
    routedFamilies = routing?.families ?? [];
    routedRepositories = routing?.repositories ?? [];

    const principal = { type: 'WORKER', id: worker.id, memberships } as unknown as Principal;
    admission = decideBinRouting({
      bin: work,
      principal,
      routing: await workerRoutingFor(worker.id, principal),
    });

    /*
     * A surface the fleet has no reading for is reported as unproven rather
     * than skipped. `capacityReading` leaves out the verification identities
     * and separates retired Routines, so an absent entry means "the fleet does
     * not count this as live capacity" — which is not the same fact as a
     * completed chain, and must never be rounded into one.
     *
     * Every configured Routine is listed, not only the enabled ones. The card
     * used to filter to `ENABLED` and call the rest nothing, so a quarantined
     * surface vanished instead of saying what took it out. A RETIRED one is
     * history rather than configuration and is left out: retiring is how a
     * surface is removed on purpose.
     */
    const health = new Map(capacity.surfaces.map((one) => [one.routineId, one]));
    live = routines
      .filter((routine) => routine.workerId === worker.id && routine.state !== 'RETIRED')
      .map((routine) => {
        const eligibility = surfaceEligibility({ routine, work, snapshot, now });
        return {
          routineName: routine.name,
          // The id, so the count below is on identity rather than on a label.
          // A surface the fleet has no reading for keys on its own Routine id,
          // so it is never silently merged with another.
          accountId: health.get(routine.id)?.accountId ?? `unattributed:${routine.id}`,
          accountName: health.get(routine.id)?.accountName ?? '—',
          state: routine.state,
          dispatch: eligibility.dispatch,
          dispatchReason: eligibility.reason,
          proven: health.get(routine.id)?.proven === true,
        };
      });
    surfaces = live.map(({ accountId: _accountId, ...surface }) => surface);
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
    admission.ok &&
    /*
     * The boundary is part of being onboarded rather than a later step.
     *
     * Without it `submitObjective` refuses, so a card that read READY while no
     * objective could be submitted would be the state §24 keeps having to
     * correct: waiting on something nobody is being asked for.
     */
    boundaryRow !== null;

  const eligible = surfaces.filter((one) => one.dispatch === 'ELIGIBLE');
  const waitingOnCapacity = surfaces.filter((one) => one.dispatch === 'WAITING');

  const readiness: RepositoryReadiness = !registered
    ? 'NOT_ONBOARDED'
    : surfaces.length === 0
      ? 'AWAITING_SURFACE'
      : eligible.length > 0
        ? 'READY'
        : waitingOnCapacity.length > 0
          ? 'WAITING_FOR_CAPACITY'
          : 'NO_USABLE_SURFACE';

  const remaining: string[] = [];
  if (!registered) {
    remaining.push(
      worker && !worker.archived && !admission.ok && admission.reason
        ? `Onboard this repository again, which repairs its worker: ${admission.reason}`
        : 'Onboard this repository, which registers a worker for it and issues one invitation.',
    );
  }
  if (registered && surfaces.length === 0) {
    remaining.push(connectorStep(workerName), SURFACE_STEP);
  }
  if (readiness === 'NO_USABLE_SURFACE') {
    for (const surface of surfaces) remaining.push(`${surface.routineName}: ${surface.dispatchReason}`);
  }

  const usable = live.filter((one) => one.dispatch !== 'UNUSABLE');
  const proven = surfaces.filter((one) => one.proven).length;
  const summary = summaryFor({
    readiness,
    workerName,
    configured: surfaces.length,
    eligible: eligible.length,
    proven,
    waitingOnCapacity: waitingOnCapacity.map((one) => `${one.routineName}: ${one.dispatchReason}`),
  });

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
    accountsServing: new Set(usable.map((one) => one.accountId)).size,
    eligibleSurfaces: eligible.length,
    provenSurfaces: proven,
    summary,
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

/**
 * The one sentence the card leads with, composed here so the Build card, the
 * repository picker and anything else that shows readiness say the same thing.
 */
function summaryFor(input: {
  readiness: RepositoryReadiness;
  workerName: string;
  configured: number;
  eligible: number;
  proven: number;
  waitingOnCapacity: string[];
}): string {
  const provenClause =
    input.proven === 0
      ? 'none has completed work Brain sent it yet, so it is configured rather than proven'
      : `${input.proven} of ${input.configured} ${input.proven === 1 ? 'has' : 'have'} completed work Brain sent ${input.proven === 1 ? 'it' : 'them'} before`;
  switch (input.readiness) {
    case 'NOT_ONBOARDED':
      return 'No Factory worker is registered for this repository in this project, so nothing can execute work here.';
    case 'AWAITING_SURFACE':
      return `${input.workerName} is registered and no Factory surface is configured for it yet, so nothing can execute work here.`;
    case 'NO_USABLE_SURFACE':
      return (
        `${input.configured} Factory ${input.configured === 1 ? 'surface is' : 'surfaces are'} configured ` +
        'and the dispatcher would fire none of them, so nothing can execute work here until the steps ' +
        'below are done. Work submitted now waits and resumes by itself.'
      );
    case 'WAITING_FOR_CAPACITY':
      return (
        'Every usable Factory surface is busy or asked to wait, which resolves by itself — nothing about ' +
        `the registration is wrong. ${input.waitingOnCapacity.join(' ')}`
      );
    case 'READY':
      return (
        `The dispatcher would fire ${input.eligible} of ${input.configured} configured Factory ` +
        `${input.configured === 1 ? 'surface' : 'surfaces'} for this repository now; ${provenClause}.`
      );
  }
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
 * property: there is never more than one live *onboarding* invitation to reason
 * about. The member-bound links `issueFactoryInvitation` issues for a pool are a
 * different kind and are left alone (`095_worker_invitation_members.sql`).
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

  const before = await describeGrant(input.projectId, grant, await fleetInputs());

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

  /*
   * Onboarding's own link only. The links issued beside it for a pool of
   * accounts (`issueFactoryInvitation`) each belong to somebody who may not
   * have opened theirs yet, and repairing the worker must not withdraw them.
   */
  const revokedInvitations = await revokeRotatingInvitationsForWorker(worker.id);
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

  const onboarding = await describeGrant(input.projectId, grant, await fleetInputs());
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

/* -------------------------------------------------------------------------- */
/*  More accounts for a worker that is already onboarded                        */
/* -------------------------------------------------------------------------- */

/**
 * What an administrator sees about one issued link, after it was shown once.
 *
 * Never the token, never its prefix: a list somebody can read again is exactly
 * where a secret must not be. `status` is derived from the row on every read.
 */
export interface FactoryInvitationView {
  id: string;
  kind: WorkerInvitation['kind'];
  /** The member it was issued for, or null for onboarding's unbound link. */
  intendedUserId: string | null;
  intendedName: string | null;
  issuedByName: string | null;
  createdAt: string;
  expiresAt: string;
  status: 'WAITING' | 'CONNECTED' | 'EXPIRED' | 'WITHDRAWN';
  /** When it was spent or withdrawn. */
  endedAt: string | null;
}

/** A Brain member a link may be issued for. Real people only; never a fixture. */
export interface InvitableMember {
  userId: string;
  name: string;
}

export interface FactoryInvitations {
  grantId: string;
  workerName: string;
  /** False when the repository is not onboarded on this project, and nothing may be issued. */
  mayIssue: boolean;
  /** Why not, when `mayIssue` is false. */
  refusal: string | null;
  members: InvitableMember[];
  invitations: FactoryInvitationView[];
}

export interface IssuedFactoryInvitation {
  invitation: FactoryInvitationView;
  /** Shown once. Stored only as a digest. */
  invitationUrl: string;
}

function invitationStatus(one: WorkerInvitation, now: string): FactoryInvitationView['status'] {
  if (one.redeemedAt) return 'CONNECTED';
  if (one.revokedAt) return 'WITHDRAWN';
  if (one.expiresAt <= now) return 'EXPIRED';
  return 'WAITING';
}

/**
 * Whether a grant's worker is onboarded on this project, read from the rows
 * that make it so — the same five facts `describeGrant` calls `registered`.
 *
 * Asked before a link is issued rather than inferred from the card, because a
 * link for a worker whose routing or boundary is missing would connect an
 * account to something that can be handed no work.
 */
async function onboardedWorker(
  projectId: string,
  grantId: string,
): Promise<
  | { ok: true; grant: RepositoryGrant; repositoryId: string; workerId: string; workerName: string }
  | { ok: false; reason: string; workerName: string }
> {
  const workerName = factoryWorkerName(grantId);
  const grant = listRepositoryGrants().find((candidate) => candidate.id === grantId);
  const repositoryId = grant ? repositoryIdOfRemote(grant.remote) : null;
  if (!grant || !repositoryId || !decideRepository(grant.remote).ok) {
    return {
      ok: false,
      workerName,
      reason: 'That is not a repository this factory is authorized to work in.',
    };
  }
  const worker = await getWorkerByName(workerName);
  const notYet =
    'This repository is not onboarded on this project yet. Onboard it first — that is where ' +
    'what this project may change is decided — and then more accounts can be invited.';
  if (!worker || worker.archived) return { ok: false, workerName, reason: notYet };
  if (worker.disabled) {
    return {
      ok: false,
      workerName,
      reason: `The worker ${workerName} is disabled, so a link for it would connect nothing.`,
    };
  }
  const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
  const here = memberships.find((m) => m.projectId === projectId && m.active);
  const routing = await getWorkerRouting(worker.id);
  const boundary = await getProjectRepository(projectId, grant.id);
  if (
    !here ||
    !sameSet(here.scopes, FACTORY_WORKER_SCOPES) ||
    !(routing?.families ?? []).includes('FACTORY') ||
    !(routing?.repositories ?? []).includes(repositoryId) ||
    !boundary
  ) {
    return { ok: false, workerName, reason: notYet };
  }
  return { ok: true, grant, repositoryId, workerId: worker.id, workerName };
}

async function invitableMembers(): Promise<InvitableMember[]> {
  return (await listUsers())
    .filter((user) => user.kind === 'PERSON' && !user.disabled)
    .map((user) => ({ userId: user.id, name: personName(user) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function viewsFor(workerId: string): Promise<FactoryInvitationView[]> {
  const now = new Date().toISOString();
  const names = new Map<string, string>();
  const nameOf = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    if (!names.has(id)) {
      const user = await getUser(id);
      names.set(id, user ? personName(user) : 'a removed account');
    }
    return names.get(id) ?? null;
  };
  const out: FactoryInvitationView[] = [];
  for (const one of await listInvitationsForWorker(workerId)) {
    out.push({
      id: one.id,
      kind: one.kind,
      intendedUserId: one.intendedUserId,
      intendedName: await nameOf(one.intendedUserId),
      issuedByName: await nameOf(one.createdByUserId),
      createdAt: one.createdAt,
      expiresAt: one.expiresAt,
      status: invitationStatus(one, now),
      endedAt: one.redeemedAt ?? one.revokedAt,
    });
  }
  return out;
}

/** The links issued for a grant's worker, and who they may be issued for. */
export async function factoryInvitations(
  projectId: string,
  grantId: string,
): Promise<FactoryInvitations> {
  const worker = await onboardedWorker(projectId, grantId);
  if (!worker.ok) {
    return {
      grantId,
      workerName: worker.workerName,
      mayIssue: false,
      refusal: worker.reason,
      members: [],
      invitations: [],
    };
  }
  return {
    grantId,
    workerName: worker.workerName,
    mayIssue: true,
    refusal: null,
    members: await invitableMembers(),
    invitations: await viewsFor(worker.workerId),
  };
}

/**
 * Why a link bound to a member in each state could not be spent, or null where
 * it could.
 *
 * A `Record` over the whole union rather than a list of the bad ones, so a
 * member state added later is a compile error until somebody says whether a
 * bound link would work for it — the same shape `REFUSAL_WAIT` has in the
 * dispatch router, and for the same reason: two sets that must be total
 * between them are how a case falls into the permissive branch by default.
 *
 * Each sentence names the control that answers it, because the administrator
 * reading this refusal is already on the page that carries it.
 */
const CANNOT_SPEND_A_BOUND_LINK: Record<MemberState, string | null> = {
  READY: null,
  // Holds a live link that ends in a PIN, so they have a way in. Refusing here
  // would be about the order two links are opened in rather than about whether
  // this person can connect at all.
  INVITED: null,
  NEEDS_A_NEW_LINK:
    'That member holds a passkey and no PIN, and the sign-in screen no longer takes a device — ' +
    'so they cannot sign in, and a link bound to them cannot be spent. Issue them a recovery ' +
    'link from People & capacity first; redeeming it ends in them setting a PIN. Nothing ' +
    'already issued is withdrawn by this refusal.',
  NOT_INVITED:
    'That member holds no credential of any kind, so they cannot sign in and a link bound to ' +
    'them cannot be spent. Issue them an enrollment link from People & capacity first; ' +
    'redeeming it ends in them setting a PIN. Nothing already issued is withdrawn by this ' +
    'refusal.',
  NAME_IS_AMBIGUOUS:
    'Two live accounts answer to that member’s sign-in name, so the sign-in screen cannot ' +
    'resolve them and a link bound to them cannot be spent. Rename one of them from People & ' +
    'capacity first. Nothing already issued is withdrawn by this refusal.',
};

/**
 * Issue one more link for an already-onboarded factory worker, for one member.
 *
 * This is the commissioning path for a pool: several Claude accounts, one
 * logical worker (§23). It changes **nothing** about the worker — no identity is
 * created, no membership, scope, routing row or boundary is written, and no
 * other invitation is touched, so issuing a link for one friend cannot withdraw
 * the link another friend has not opened yet, and cannot disturb an
 * authorization anybody already holds. The only row it writes is the invitation
 * itself, plus the audit event naming its id.
 *
 * The member is chosen by the administrator from real accounts and is required:
 * the consent screen then spends the link only for a browser signed in as that
 * member, so a forwarded link cannot connect a stranger's Claude account in a
 * friend's name. Nothing here infers who a link is for.
 */
export async function issueFactoryInvitation(input: {
  projectId: string;
  grantId: string;
  intendedUserId: string;
  actor: User;
  origin: string;
}): Promise<{ ok: false; reason: string } | { ok: true; result: IssuedFactoryInvitation }> {
  const worker = await onboardedWorker(input.projectId, input.grantId);
  if (!worker.ok) return { ok: false, reason: worker.reason };

  const member = await getUser(input.intendedUserId);
  if (!member || member.kind !== 'PERSON' || member.disabled) {
    return {
      ok: false,
      reason: 'Choose the Brain member this link is for, from the people who have joined.',
    };
  }

  /*
   * A member who cannot sign in cannot spend a link bound to them.
   *
   * `memberCheck` in `routes/oauth.ts` refuses a bound invitation for any
   * browser not signed in as the member it names, so the link is dead from the
   * moment it is written — and what that person meets is a sign-in screen
   * asking for a six-digit PIN, which is the one thing they do not have. §24's
   * escalation with no answering transition, created at issue time, and the
   * administrator who could have fixed it was told the issue succeeded.
   *
   * Production had three such members when this was written: two holding a
   * passkey and no PIN, one holding no credential at all. The sign-in screen
   * stopped accepting a device when the PIN landed, so a member who enrolled
   * before that quietly stopped having a way in, and nothing on this path
   * looked.
   *
   * The reading is `peopleReading`'s rather than a second derivation of the
   * same fact. That module already decides what each state means and names the
   * remedy, `foundation.ts` reports it, and the People page renders the control
   * that answers it — a copy here would eventually disagree with the screen the
   * administrator is looking at while they read this sentence.
   *
   * `INVITED` is deliberately allowed: that member holds a live link which ends
   * in a PIN, so they have a way in and this refusal would be about timing
   * rather than about capability.
   */
  const reading = (await peopleReading(null)).people.find((one) => one.userId === member.id);
  const cannotSpend = reading ? CANNOT_SPEND_A_BOUND_LINK[reading.state] : null;
  if (cannotSpend) return { ok: false, reason: cannotSpend };

  const token = generateInvitationToken();
  const invitation = await createInvitation({
    workerId: worker.workerId,
    tokenPrefix: token.prefix,
    tokenDigest: token.digest,
    createdByUserId: input.actor.id,
    kind: 'ADDITIONAL',
    intendedUserId: member.id,
    note: `Another Claude account for ${worker.repositoryId}, for ${personName(member)}.`,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actor.id,
    action: 'ISSUE_FACTORY_INVITATION',
    targetType: 'WORKER',
    targetId: worker.workerId,
    projectId: input.projectId,
    result: 'SUCCESS',
    // The invitation *id* and the member it is for. Never the token.
    metadata: {
      grantId: worker.grant.id,
      repositoryId: worker.repositoryId,
      invitationId: invitation.id,
      intendedUserId: member.id,
      expiresAt: invitation.expiresAt,
    },
  });

  const view = (await viewsFor(worker.workerId)).find((one) => one.id === invitation.id);
  if (!view) throw new Error('The invitation disappeared immediately after being written.');
  return {
    ok: true,
    result: {
      invitation: view,
      invitationUrl: `${input.origin.replace(/\/+$/, '')}/oauth/invite/${token.plaintext}`,
    },
  };
}

/** Withdraw one unused link for this grant's worker, and no other. */
export async function withdrawFactoryInvitation(input: {
  projectId: string;
  grantId: string;
  invitationId: string;
  actor: User;
}): Promise<boolean> {
  const worker = await onboardedWorker(input.projectId, input.grantId);
  if (!worker.ok) return false;
  const withdrawn = await revokeInvitationForWorker(input.invitationId, worker.workerId);
  if (withdrawn) {
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: input.actor.id,
      action: 'WITHDRAW_FACTORY_INVITATION',
      targetType: 'WORKER',
      targetId: worker.workerId,
      projectId: input.projectId,
      result: 'SUCCESS',
      metadata: { grantId: worker.grant.id, invitationId: input.invitationId },
    });
  }
  return withdrawn;
}
