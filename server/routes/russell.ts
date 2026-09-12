/**
 * The Russell API.
 *
 * Every route here is a thin wrapper over a service that already existed, with
 * the authorization that service already required — the same rule Step 7 wrote
 * for the MCP boundary, for the same reason. A surface that grows its own
 * checks is a second security model, and the second one is always weaker.
 *
 * Two boundaries meet in this file and they are not the same boundary:
 *
 *   - **A project** is guarded by `decideProjectAccess`, through
 *     `requireProject`. Nothing here reimplements it.
 *   - **A conversation** is guarded by its owner, plus — for a shared thread —
 *     read access to the project it is attached to. A thread is a person's own
 *     workspace, so a Brain administrator is not automatically entitled to it,
 *     and `conversationIsReadable` is where that lives.
 *
 * Both refuse the same way: a resource the caller may not have is reported as
 * one that does not exist, in the same words as a real miss. A 403 here would
 * let anyone enumerate other people's threads by watching which id changed the
 * status code.
 */
import { Router } from 'express';
import {
  answerHumanRequest,
  getHumanRequest,
  listCurrentKnowledge,
  listMissions,
  listOpenRequests,
} from '../repos/russellMissions.ts';
import {
  getCandidate,
  listCandidates,
  listMergeHistory,
  overrideJudgment,
  splitCandidate,
} from '../repos/russellCandidates.ts';
import {
  attachConversation,
  createConversation,
  getConversation,
  listConversationsForOwner,
  listTurns,
} from '../repos/russellConversations.ts';
import { listProbesForCandidate, listObservations } from '../repos/russellProbes.ts';
import { getCycle } from '../repos/russellCycle.ts';
import { currentPrincipal } from '../services/identity/context.ts';
import { beginTurn, conversationIsReadable, retryTurn } from '../services/russell/turn.ts';
import { withPendingDetail } from '../services/russell/pending.ts';
import { briefing, focusLayer } from '../services/russell/projections.ts';
import { homeFor } from '../services/russell/home.ts';
import { collectionsFor } from '../services/russell/collections.ts';
import { frontierFor } from '../services/russell/frontier.ts';
import { SAVED_VIEWS, SEARCH_KINDS, search, type SearchKind } from '../services/russell/search.ts';
import { explainSlowness, fleetView } from '../services/fleet/view.ts';
import {
  LAB_MODES,
  applyFinding,
  declareExperiment,
  listExperiments,
  rollbackFinding,
  runExperiment,
  type LabMode,
} from '../services/fleet/lab.ts';
import { setPolicy } from '../repos/fleet.ts';
import { MAP_LABELS, MAP_TYPES, mapFor, type MapType } from '../services/russell/maps.ts';
import { whyThisMatters, worthSurfacing } from '../services/russell/whyThisMatters.ts';
import {
  PREFERENCES,
  isPreferenceKey,
  preferencesFor,
  setPreference,
} from '../services/russell/preferences.ts';
import { dismissFrontierItem } from '../repos/russellFrontier.ts';
import {
  fileConversation,
  getCollection,
  setConversationClosed,
} from '../repos/russellCollections.ts';
import { knowsForProject, surfaceState } from '../services/russell/knows.ts';
import { groupWork, workForProject } from '../services/russell/work.ts';
import { ideaMapForProject } from '../services/russell/ideas.ts';
import { whoForProject } from '../services/russell/who.ts';
import {
  activeWorkProgress,
  buildProgress,
  projectProgress,
} from '../services/russell/progress.ts';
import { DEAL_DISPATCH_SLUG, readDealDispatch } from '../services/russell/dealDispatch.ts';
import { coverBeforeWork, explainCoverage } from '../services/russell/coverage.ts';
import {
  AUTHORITY_LIMITS,
  authorityFor,
  RESEARCH_WORK,
} from '../services/russell/authority.ts';
import { createGoal, getGoal, revokeGoal } from '../repos/russellAuthority.ts';
import { getUser } from '../repos/identity.ts';
import {
  connectSite,
  disconnectSite,
  isKnownSite,
  listConnectedSites,
  siteFor,
  siteStatus,
} from '../services/connect/sites.ts';
import { recordEvent } from '../repos/events.ts';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  nullableString,
  optionalInteger,
  optionalString,
  pathId,
  queryOf,
  requireLayerOfProject,
  requireProject,
  requiredString,
} from './helpers.ts';
import { getProjectBySlug } from '../repos/projects.ts';
import type {
  CandidatePriority,
  CandidateState,
  MissionState,
  Principal,
  RussellCandidate,
} from '../domain/types.ts';
import { CANDIDATE_PRIORITIES, CANDIDATE_STATES, MISSION_STATES } from '../domain/types.ts';

export const russellRouter = Router();

/**
 * The signed-in person, or a refusal.
 *
 * A worker has no conversations and no Needs You list — those are a person's,
 * and a worker principal reaching them would be a machine reading somebody's
 * private thread. So the refusal is by principal *type* rather than by scope:
 * there is no membership configuration that makes a worker into a person.
 */
function requirePerson(): Principal {
  const principal = currentPrincipal();
  if (!principal || principal.type !== 'HUMAN') {
    throw notFound('No such route.');
  }
  return principal;
}

/** A conversation this caller may read, or the same 404 a missing one gives. */
async function requireConversation(conversationId: string) {
  const principal = requirePerson();
  if (!(await conversationIsReadable(principal, conversationId))) {
    throw notFound('No conversation with that id.');
  }
  const conversation = await getConversation(conversationId);
  if (!conversation) throw notFound('No conversation with that id.');
  return { conversation, principal };
}

/**
 * A candidate this caller may act on, or the same 404 a missing one gives.
 *
 * Two gates, because a candidate answers to two things. The project decides
 * whether this principal may touch the project's ideas at all, at the level
 * the request's own method requires. Visibility then decides whether *this*
 * idea is one of them: a `PRIVATE` candidate belongs to the thread it came
 * from, so it is reachable only through a conversation this person can read —
 * §24's rule that a Brain administrator is not entitled to somebody's private
 * thread, applied to the idea the thread produced.
 *
 * A candidate with no project cannot be judged: there is nothing to authorize
 * against, and inventing an authority for it is how a gate becomes a
 * formality. Refused as absent, like everything else here.
 */
async function requireCandidate(candidateId: string): Promise<RussellCandidate> {
  const principal = requirePerson();
  const candidate = await getCandidate(candidateId);
  if (!candidate || !candidate.projectId) throw notFound('No idea with that id.');
  await requireProject(candidate.projectId);
  if (candidate.visibility === 'PRIVATE') {
    if (
      !candidate.conversationId ||
      !(await conversationIsReadable(principal, candidate.conversationId))
    ) {
      throw notFound('No idea with that id.');
    }
  }
  return candidate;
}

/* --------------------------------------------------------------------------
 * Conversations
 * ------------------------------------------------------------------------ */

russellRouter.get(
  '/conversations',
  handler(async (req) => {
    const principal = requirePerson();
    const limit = optionalInteger(queryOf(req)['limit'], 'limit', { min: 1, max: 200 }) ?? 50;
    // Scoped by owner in the query rather than filtered afterwards. A listing
    // that fetched everything and removed rows is one forgotten filter from a
    // disclosure, and the count alone is information.
    return { conversations: await listConversationsForOwner(principal.id, limit) };
  }),
);

russellRouter.post(
  '/conversations',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const projectId = optionalString(body['projectId'], 'projectId');
    // An explicitly named project goes through the ordinary project gate, so a
    // person cannot open a thread against something they may not read and have
    // Russell ground answers in it.
    if (projectId) await requireProject(projectId);
    return createConversation({
      ownerUserId: principal.id,
      title: optionalString(body['title'], 'title') ?? 'New conversation',
      projectId: projectId ?? null,
      visibility: body['visibility'] === 'SHARED' ? 'SHARED' : 'PRIVATE',
    });
  }),
);

russellRouter.get(
  '/conversations/:conversationId',
  handler(async (req) => {
    const { conversation } = await requireConversation(pathId(req, 'conversationId'));
    const limit = optionalInteger(queryOf(req)['limit'], 'limit', { min: 1, max: 200 }) ?? 100;
    /*
     * The pending explanation is derived here rather than stored, because what
     * a turn is waiting for changes after the row is written and the row does
     * not. See `services/russell/pending.ts` — a caption that cannot become
     * wrong is not an explanation.
     */
    return {
      conversation,
      turns: await withPendingDetail(await listTurns(conversation.id, limit)),
    };
  }),
);

/**
 * Say something.
 *
 * Answers 202 rather than 200, and returns the pending turn rather than an
 * answer, because there is not one yet: the reply is carried by the fleet. The
 * interface shows the pending turn with its reason, which is the truth, instead
 * of an optimistic bubble that has to be corrected when the worker disagrees.
 */
russellRouter.post(
  '/conversations/:conversationId/turns',
  handler(async (req, res) => {
    const { conversation, principal } = await requireConversation(pathId(req, 'conversationId'));
    if (conversation.ownerUserId !== principal.id) {
      // Readable is not writable. A shared thread can be read by the project's
      // members and is still one person's conversation.
      throw notFound('No conversation with that id.');
    }
    const content = requiredString(bodyOf(req)['content'], 'content');
    const started = await beginTurn({ principal, conversationId: conversation.id, content });
    if (!started.ok) throw badRequest(started.reason);
    res.status(202);
    /*
     * The pending turn goes back with the same derived explanation the read
     * path adds, so the first thing a person sees and the thing they see on the
     * next poll are produced by one function. Two sentences for one condition
     * is how an interface starts disagreeing with itself.
     */
    const [pending] = started.pendingMessage
      ? await withPendingDetail([started.pendingMessage])
      : [null];
    return {
      userMessage: started.userMessage,
      pending: pending ?? started.pendingMessage,
      attachedProjectId: started.attachedProjectId,
      // Deliberately not the bin id. A person has no use for it and it names an
      // internal resource they may not address.
      dispatched: started.binId !== null,
    };
  }),
);

/**
 * Have another go at a turn that failed.
 *
 * The supported recovery, and it did not exist. `resolveMessage` is a
 * compare-and-swap on `PENDING`, so a settled turn can never be re-settled;
 * nothing re-opened one; and the only path back was the sentence the failure
 * shows a person — *ask me again* — which means retyping the question. That is
 * the right remedy when the question was the problem and the wrong one when
 * Brain refused its own worker over a rule the worker was never told, which is
 * exactly what happened on 2026-09-05.
 *
 * Owner-only, on the same 404 as everything else here: a thread is one
 * person's, and a reader of a shared thread may not spend the fleet on it.
 *
 * Deliberately takes no body. A retry that accepted text would be a way to ask
 * something different while calling it the same question; the service walks
 * back to what the person actually said instead.
 */
russellRouter.post(
  '/conversations/:conversationId/turns/:messageId/retry',
  handler(async (req, res) => {
    const { conversation, principal } = await requireConversation(pathId(req, 'conversationId'));
    if (conversation.ownerUserId !== principal.id) {
      throw notFound('No conversation with that id.');
    }
    const again = await retryTurn({ principal, messageId: pathId(req, 'messageId') });
    if (!again.ok) throw badRequest(again.reason);
    res.status(202);
    const [pending] = again.pendingMessage
      ? await withPendingDetail([again.pendingMessage])
      : [null];
    return {
      pending: pending ?? again.pendingMessage,
      attempt: again.attempt,
      dispatched: again.binId !== null,
    };
  }),
);

/**
 * Correct where a thread is filed.
 *
 * The acceptance asks that a person be able to say "this is not about that
 * project", that the correction be recorded, and that it inform a later
 * equivalent routing decision. `routeMessage` already reads corrections and
 * weighs them above a name match — but nothing could *write* one, so the whole
 * mechanism was reachable only from a test. A rule the interface cannot express
 * is a rule the product does not have.
 *
 * Owner-only, because a thread is one person's workspace, and the project is
 * re-authorized against that person: a correction must not become a way to
 * attach a conversation to something the corrector cannot read. `null` detaches,
 * which is the honest option when somebody knows it is filed wrongly and not
 * where it belongs.
 */
russellRouter.post(
  '/conversations/:conversationId/project',
  handler(async (req) => {
    const { conversation, principal } = await requireConversation(pathId(req, 'conversationId'));
    if (conversation.ownerUserId !== principal.id) {
      throw notFound('No conversation with that id.');
    }
    const body = bodyOf(req);
    const projectId = nullableString(body['projectId'], 'projectId') ?? null;
    if (projectId) await requireProject(projectId);

    await attachConversation({
      conversationId: conversation.id,
      projectId,
      // `USER`, which is the vocabulary `listCorrections` reads: an automatic
      // attachment agreeing with itself is not evidence of anything, so only a
      // person's own decision counts as a correction. Set here and never taken
      // from the body.
      source: 'USER',
      confidence: null,
      reason: optionalString(body['reason'], 'reason') ?? 'a person filed this somewhere else',
      actorUserId: principal.id,
    });
    return (await getConversation(conversation.id))!;
  }),
);

/* --------------------------------------------------------------------------
 * What Russell is doing
 * ------------------------------------------------------------------------ */

/**
 * Russell's home, in one read.
 *
 * A single projection rather than five calls a client stitches together, for
 * the reason §6 gives directly: two surfaces inferring their own status is how
 * a person ends up reading two different answers about one project. The
 * briefing route below is unchanged and still serves the four sentences on
 * their own, because callers already read it and removing a field is a change
 * nobody asked for.
 *
 * `homeFor` returns null for a caller with no read access, which becomes the
 * same 404 a missing project gives — the refusal names nothing, at this door as
 * at every other.
 */
russellRouter.get(
  '/projects/:projectId/home',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const view = await homeFor({
      principal: currentPrincipal(),
      projectId: project.id,
      projectName: project.name,
      includePrivate: false,
    });
    if (!view) throw notFound('No project with that id.');
    return { home: view, project: { id: project.id, name: project.name } };
  }),
);

/* --------------------------------------------------------------------------
 * Maps, preferences, and why this matters
 * ------------------------------------------------------------------------ */

/**
 * One of the six specialized maps, over the authoritative graph.
 *
 * A map draws only relationships that are recorded. Where a project holds
 * nothing of that kind the map comes back empty *with the reason*, which is the
 * honest output — inventing edges to make a diagram look finished is an
 * invented citation one altitude down.
 */
russellRouter.get(
  '/projects/:projectId/maps/:type',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const type = pathId(req, 'type').toUpperCase();
    if (!(MAP_TYPES as readonly string[]).includes(type)) {
      throw notFound('There is no map of that kind.');
    }
    return {
      map: await mapFor({
        type: type as MapType,
        projectId: project.id,
        projectName: project.name,
        includePrivate: false,
      }),
      types: MAP_TYPES.map((key) => ({ key, label: MAP_LABELS[key] })),
    };
  }),
);

/**
 * Why this matters — a private, non-gamified reading of what has happened.
 *
 * Returns nothing at all when nothing has. A quiet screen is the honest one,
 * and an encouraging screen over an empty project is what makes a person stop
 * believing the rest of the product.
 */
russellRouter.get(
  '/projects/:projectId/why-this-matters',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const view = await whyThisMatters({
      projectId: project.id,
      projectName: project.name,
      includePrivate: false,
    });
    return { whyThisMatters: worthSurfacing(view) ? view : null };
  }),
);

/**
 * This person's own preferences.
 *
 * The user comes from the authenticated principal, never from the body or the
 * path: a preference route that took a user id would be a way to change
 * somebody else's screen. Every key is presentational by construction — nothing
 * here can change a fact, an evidence standard, or what anybody may do.
 */
russellRouter.get(
  '/preferences',
  handler(async () => {
    const principal = requirePerson();
    return { preferences: await preferencesFor(principal.id), declared: PREFERENCES };
  }),
);

russellRouter.patch(
  '/preferences',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const key = requiredString(body['key'], 'key');
    if (!isPreferenceKey(key)) throw badRequest('That is not a preference Brain keeps.');
    const outcome = await setPreference({ userId: principal.id, key, value: body['value'] });
    if (!outcome.ok) throw badRequest(outcome.reason);
    return { preferences: await preferencesFor(principal.id) };
  }),
);

/* --------------------------------------------------------------------------
 * Fleet and the Capability Lab
 * ------------------------------------------------------------------------ */

/**
 * How much usable Brain power exists, where it is going, and what should change.
 *
 * Technical depth is decided from the caller's actual rights rather than from a
 * query parameter: raw worker, token and session identifiers are technical
 * detail (§14), so they come back only for a caller `decideProjectAccess`
 * already admits at ADMIN. A parameter would let anybody ask for them.
 */
russellRouter.get(
  '/projects/:projectId/fleet',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const who = await whoForProject({ principal, projectId: project.id });
    if (!who) throw notFound('No project with that id.');
    return {
      fleet: await fleetView({
        includeTechnical: who.depth === 'OPERATOR',
        projectId: project.id,
      }),
    };
  }),
);

/**
 * Why one piece of work took as long as it did.
 *
 * The chain is Brain's own recorded events. Nothing here consults a clock to
 * decide what happened, and nothing consults a worker's account of itself.
 */
russellRouter.get(
  '/projects/:projectId/fleet/slow/:binId',
  handler(async (req) => {
    requirePerson();
    await requireProject(pathId(req, 'projectId'));
    return { explanation: await explainSlowness(pathId(req, 'binId')) };
  }),
);

/**
 * Change how much may run at once, durably and reversibly.
 *
 * An INSERT into `fleet_policy`, which is versioned, attributed and reasoned —
 * so this needs no deployment and the previous value is still there to revert
 * to. It changes *allocation*, never the right to perform a new kind of work:
 * nothing here widens a scope, grants a capability or authorizes spending.
 */
russellRouter.post(
  '/projects/:projectId/fleet/policy',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const who = await whoForProject({ principal, projectId: project.id });
    if (!who || who.depth !== 'OPERATOR') throw notFound('No project with that id.');
    const body = bodyOf(req);
    const target = optionalInteger(body['target'], 'target', { min: 0, max: 1000 });
    if (target === undefined) throw badRequest('A target is required.');
    const reason = (optionalString(body['reason'], 'reason') ?? '').trim();
    if (reason.length === 0) {
      throw badRequest('Say why the fleet target is changing; a change with no reason cannot be reviewed later.');
    }
    const policy = await setPolicy({
      scope: 'FLEET',
      target,
      paused: body['paused'] === true,
      actor: principal.displayName,
      reason,
    });
    return { policy: { id: policy.id, version: policy.version, target: policy.target } };
  }),
);

/** Everything the lab has been asked to find out, and what it found. */
russellRouter.get(
  '/projects/:projectId/lab',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { experiments: await listExperiments(project.id), modes: LAB_MODES };
  }),
);

/**
 * Declare an experiment.
 *
 * Declaring is not running, and a pressure mode with an incomplete envelope is
 * *stored* as refused rather than rejected — the refusal is evidence of what
 * was asked for and why it was not allowed, which a thrown error would lose.
 */
russellRouter.post(
  '/projects/:projectId/lab',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const mode = requiredString(body['mode'], 'mode');
    if (!(LAB_MODES as readonly string[]).includes(mode)) {
      throw badRequest('That is not a test this lab knows how to run.');
    }
    const envelope = body['envelope'];
    return {
      experiment: await declareExperiment({
        projectId: project.id,
        mode: mode as LabMode,
        title: requiredString(body['title'], 'title'),
        envelope: (typeof envelope === 'object' && envelope !== null
          ? envelope
          : {
              ceiling: 0,
              durationMinutes: 0,
              stopConditions: [],
              cleanup: '',
              rollback: '',
              workloadClass: 'UNKNOWN',
              workKind: 'SYNTHETIC',
            }) as never,
        manifest: (typeof body['manifest'] === 'object' && body['manifest'] !== null
          ? body['manifest']
          : {}) as Record<string, unknown>,
        actor: principal.displayName,
      }),
    };
  }),
);

/**
 * Run one.
 *
 * `pressureAuthorized` is read from the *route*, not from the experiment's own
 * row: an experiment that carried its own authorization would be supplying the
 * limits it is judged against. A person at ADMIN saying so in the request is
 * the authorization, and a pressure mode without it settles as refused with
 * nothing spent.
 */
russellRouter.post(
  '/projects/:projectId/lab/:experimentId/run',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const who = await whoForProject({ principal, projectId: project.id });
    const authorized =
      who?.depth === 'OPERATOR' && bodyOf(req)['authorizePressure'] === true;
    return {
      experiment: await runExperiment({
        id: pathId(req, 'experimentId'),
        pressureAuthorized: authorized,
      }),
    };
  }),
);

/** Turn a finding into policy, reversibly. */
russellRouter.post(
  '/projects/:projectId/lab/:experimentId/apply',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const who = await whoForProject({ principal, projectId: project.id });
    if (!who || who.depth !== 'OPERATOR') throw notFound('No project with that id.');
    const body = bodyOf(req);
    const reason = (optionalString(body['reason'], 'reason') ?? '').trim();
    if (reason.length === 0) throw badRequest('Say why this finding is being applied.');
    return {
      experiment: await applyFinding({
        experimentId: pathId(req, 'experimentId'),
        target: optionalInteger(body['target'], 'target', { min: 0, max: 1000 }) ?? 1,
        actor: principal.displayName,
        reason,
      }),
    };
  }),
);

/** Undo one, by writing the previous value forward rather than deleting. */
russellRouter.post(
  '/projects/:projectId/lab/:experimentId/rollback',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const who = await whoForProject({ principal, projectId: project.id });
    if (!who || who.depth !== 'OPERATOR') throw notFound('No project with that id.');
    const reason = (optionalString(bodyOf(req)['reason'], 'reason') ?? '').trim();
    if (reason.length === 0) throw badRequest('Say why this is being rolled back.');
    return {
      experiment: await rollbackFinding({
        experimentId: pathId(req, 'experimentId'),
        actor: principal.displayName,
        reason,
      }),
    };
  }),
);

/* --------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------ */

/**
 * One search, over everything this person may see.
 *
 * Scope is decided inside the service from the authenticated principal, never
 * from anything the caller sent — there is no `projectId` parameter here on
 * purpose, because a search that took one would be a way to ask whether a
 * project exists. A query the caller has no access to simply returns nothing,
 * which is the same answer a genuine miss gives.
 */
russellRouter.get(
  '/search',
  handler(async (req) => {
    const principal = requirePerson();
    const query = optionalString(queryOf(req)['q'], 'q') ?? '';
    const kinds = optionalString(queryOf(req)['kinds'], 'kinds');
    const wanted = kinds
      ? kinds
          .split(',')
          .map((kind) => kind.trim().toUpperCase())
          .filter((kind): kind is SearchKind => (SEARCH_KINDS as readonly string[]).includes(kind))
      : undefined;
    return {
      results: await search({ principal, query, kinds: wanted }),
      // The saved views travel with the response so the client renders the
      // server's own set rather than keeping a second copy that drifts.
      savedViews: SAVED_VIEWS,
    };
  }),
);

/* --------------------------------------------------------------------------
 * The Discovery Frontier
 * ------------------------------------------------------------------------ */

/**
 * Where this project's understanding runs out.
 *
 * Refreshed on the read path, so what a person sees is what is true now rather
 * than what was true the last time something happened to run. Private knowledge
 * stays the owner's: the API view is the shared one, so two people reading the
 * same project see the same frontier.
 */
russellRouter.get(
  '/projects/:projectId/frontier',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return {
      frontier: await frontierFor({
        projectId: project.id,
        projectName: project.name,
        includePrivate: false,
      }),
    };
  }),
);

/**
 * A person saying an area is deliberately not required — or taking it back.
 *
 * A reason is required in both directions, because a scope decision with no
 * stated reason is indistinguishable from somebody tidying the screen. It is
 * reversible for the same reason every other escalation here has an answering
 * transition: a judgment about scope is exactly the kind that changes.
 */
russellRouter.patch(
  '/projects/:projectId/frontier/:itemId',
  handler(async (req) => {
    const principal = requirePerson();
    // The access level comes from the request method — a PATCH already
    // requires WRITE through `requirementForCurrentRequest`, so asking for it
    // again here would be a second place to get it wrong.
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const dismissed = body['dismissed'] === true;
    const reason = (optionalString(body['reason'], 'reason') ?? '').trim();
    if (reason.length === 0) {
      throw badRequest('Say why this area is or is not required.');
    }
    const changed = await dismissFrontierItem({
      id: pathId(req, 'itemId'),
      projectId: project.id,
      userId: principal.id,
      reason,
      dismissed,
    });
    if (!changed) throw notFound('No frontier item with that id.');
    return { ok: true, dismissed };
  }),
);

/* --------------------------------------------------------------------------
 * Collections
 * ------------------------------------------------------------------------ */

/**
 * A person's threads, organized and ranked.
 *
 * Scoped to the authenticated person throughout — the collections, the threads
 * inside them, and the filing routes below all read `principal.id` rather than
 * anything the caller sent. A collection holds private conversations, so a
 * route that took an owner from the body would be a way to read somebody
 * else's thinking.
 *
 * `projectId` is optional and supplies the starters only. It goes through the
 * ordinary project gate, so naming a project you may not read refuses here
 * exactly as it does everywhere else.
 */
russellRouter.get(
  '/collections',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = optionalString(queryOf(req)['projectId'], 'projectId');
    const project = projectId ? await requireProject(projectId) : null;
    return {
      collections: await collectionsFor({
        ownerUserId: principal.id,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
      }),
    };
  }),
);

/**
 * Move a thread, or take it out of every collection.
 *
 * Always `USER`, because this route is only ever reached by a person choosing.
 * The automatic pass writes `AUTOMATIC` and is guarded so it can never
 * overwrite what happens here — that guard is in the statement, in
 * `fileConversation`, rather than in this handler.
 */
russellRouter.patch(
  '/conversations/:conversationId/collection',
  handler(async (req) => {
    const principal = requirePerson();
    const { conversation } = await requireConversation(pathId(req, 'conversationId'));
    if (conversation.ownerUserId !== principal.id) {
      // Readable is not writable: a shared thread is still one person's.
      throw notFound('No conversation with that id.');
    }
    const body = bodyOf(req);
    const collectionId = optionalString(body['collectionId'], 'collectionId') ?? null;
    if (collectionId) {
      const collection = await getCollection(collectionId);
      // A collection somebody else owns is reported as one that does not
      // exist, so this cannot be used to discover what other people have.
      if (!collection || collection.ownerUserId !== principal.id) {
        throw notFound('No collection with that id.');
      }
    }
    const moved = await fileConversation({
      conversationId: conversation.id,
      ownerUserId: principal.id,
      collectionId,
      actor: 'USER',
    });
    if (!moved) throw notFound('No conversation with that id.');
    return { ok: true };
  }),
);

/** Say a thread is finished, or that it is not. A fact, never a derivation. */
russellRouter.patch(
  '/conversations/:conversationId/closed',
  handler(async (req) => {
    const principal = requirePerson();
    const { conversation } = await requireConversation(pathId(req, 'conversationId'));
    if (conversation.ownerUserId !== principal.id) {
      throw notFound('No conversation with that id.');
    }
    const closed = bodyOf(req)['closed'] === true;
    const changed = await setConversationClosed({
      conversationId: conversation.id,
      ownerUserId: principal.id,
      closed,
    });
    if (!changed) throw notFound('No conversation with that id.');
    return { ok: true, closed };
  }),
);

russellRouter.get(
  '/projects/:projectId/briefing',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const [brief, focus, cycle] = await Promise.all([
      // Private knowledge is the owner's; a briefing served over the API shows
      // the shared view, so two people reading the same project see the same
      // sentence.
      briefing({ projectId: project.id, projectName: project.name, includePrivate: false }),
      focusLayer(project.id),
      getCycle(),
    ]);
    return {
      briefing: brief,
      focusLayer: focus,
      // The loop's own state, so a screen can say "Russell is paused" rather
      // than showing a stalled briefing and letting a person guess.
      cycle: cycle ? { state: cycle.state, pausedReason: cycle.pauseReason } : null,
    };
  }),
);

/**
 * Everything being worked on, grouped, and labelled by where it came from.
 *
 * `missions` is still returned, unchanged, because callers already read it and
 * removing a field is a change nobody asked for. `work` is what a surface
 * should render: it also carries the research packets and bins that existed
 * before Russell did, which is the whole reason Work could show nothing while
 * the Brain was plainly busy.
 *
 * `technical=1` opens the verifier's scopes, the fixtures and the conversation
 * machinery. It is a query parameter rather than a separate route so that the
 * technical view is the same projection deliberately opened — and it widens
 * nothing, because everything it reveals is inside a project this caller has
 * already been authorized for.
 */
russellRouter.get(
  '/projects/:projectId/work',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const query = queryOf(req);
    const limit = optionalInteger(query['limit'], 'limit', { min: 1, max: 200 }) ?? 100;
    const includeTechnical = query['technical'] === '1' || query['technical'] === 'true';
    const [missions, work] = await Promise.all([
      listMissions({
        projectId: project.id,
        states: enumList(query['state'], MISSION_STATES) as MissionState[],
        limit,
      }),
      workForProject({ projectId: project.id, includeTechnical, limit }),
    ]);
    return {
      missions,
      work: {
        ...surfaceState({ items: work.entries }),
        groups: groupWork(work.entries),
        includesTechnical: includeTechnical,
        // Named rather than silently dropped: "nothing here" reads very
        // differently once you know four rows were held back on purpose.
        technicalHidden: work.technicalHidden,
      },
    };
  }),
);

/**
 * The shape of the project: site, major ideas, ordinary ideas, and their edges.
 *
 * One projection, read by the Ideas list and by the constellation, so the map
 * cannot show something the list denies — and so the map's accessible fallback
 * is not a second description of the same thing.
 */
russellRouter.get(
  '/projects/:projectId/ideas',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const map = await ideaMapForProject({
      projectId: project.id,
      viewerUserId: principal.id,
      includePrivate: false,
    });
    if (!map) throw notFound('No project with that id.');
    return { map: { ...map, nodes: map.nodes }, state: surfaceState({ items: map.nodes }) };
  }),
);

/**
 * Who is here, and what can run.
 *
 * The depth is decided inside the service from the same policy every other
 * route uses. A caller who may not read the project gets the same 404 a missing
 * one gives, in the same words.
 */
russellRouter.get(
  '/projects/:projectId/who',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const who = await whoForProject({ principal, projectId: project.id });
    if (!who) throw notFound('No project with that id.');
    return who;
  }),
);

/**
 * How far along things are — the project, the work in flight, and the Brain.
 *
 * All three from one shared projection, so the number on this screen is the
 * number on every other one.
 */
russellRouter.get(
  '/projects/:projectId/progress',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const [project_, work] = await Promise.all([
      projectProgress({ projectId: project.id, projectName: project.name }),
      activeWorkProgress(project.id),
    ]);
    return { project: project_, work, build: buildProgress() };
  }),
);

russellRouter.get(
  '/projects/:projectId/candidates',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const query = queryOf(req);
    return {
      candidates: await listCandidates({
        projectId: project.id,
        states: enumList(query['state'], CANDIDATE_STATES) as CandidateState[],
        limit: optionalInteger(query['limit'], 'limit', { min: 1, max: 200 }) ?? 100,
      }),
    };
  }),
);

/**
 * What Russell decided about one idea, and how it got there.
 *
 * The merge history is part of the answer rather than a separate screen,
 * because a candidate that reads "captured once" while three questions folded
 * into it is describing itself wrongly. It is also the only way a person can
 * see that a merge happened at all — and therefore the only way they can know
 * there is something to undo.
 */
russellRouter.get(
  '/candidates/:candidateId',
  handler(async (req) => {
    const candidate = await requireCandidate(pathId(req, 'candidateId'));
    return { candidate, merges: await listMergeHistory(candidate.id) };
  }),
);

/**
 * A person disagrees with Russell.
 *
 * `overrideJudgment` has existed since Phase 1 and has been called by nobody,
 * so condition 5's second half — that an override *supersedes* rather than
 * erases — was a property of a function no request could reach. This is the
 * production caller.
 *
 * It changes a recommendation and nothing else. The priority is matched
 * against the enum exactly, the state against its own, and neither the budget,
 * the authority, the evidence gate nor the audit separation is reachable from
 * here: an override can say "do this sooner", never "do this without the
 * checks". The previous decision is kept by the repository in
 * `superseded_decision`, which is what makes "Russell thought this was
 * premature and I overruled it" a readable fact a year later.
 */
russellRouter.post(
  '/candidates/:candidateId/judgment',
  handler(async (req) => {
    const principal = requirePerson();
    const candidate = await requireCandidate(pathId(req, 'candidateId'));
    const body = bodyOf(req);

    const priority = requiredString(body['priority'], 'priority');
    if (!CANDIDATE_PRIORITIES.includes(priority as CandidatePriority)) {
      throw badRequest('That is not a priority this Brain recognises.');
    }
    const state = requiredString(body['state'], 'state');
    if (!CANDIDATE_STATES.includes(state as CandidateState)) {
      throw badRequest('That is not a state an idea can be put into.');
    }
    /*
     * `MERGED` is not a state a person may assign here.
     *
     * A merge is a relationship between two rows — it needs a canonical to
     * point at — and setting the state alone would produce an idea marked as
     * folded into nothing, which every downstream query treats as invisible.
     * A merge is made at capture, by the fingerprint or by a worker's claim
     * held to the floor; the only direction a person moves it from here is
     * apart, which is the split below.
     */
    if (state === 'MERGED') {
      throw badRequest('Use the merge and split operations to change what an idea folds into.');
    }
    const reason = requiredString(body['reason'], 'reason');

    const ok = await overrideJudgment({
      candidateId: candidate.id,
      // From the authenticated principal. A body field naming an actor is not
      // read, here or anywhere else.
      actorUserId: principal.id,
      priority: priority as CandidatePriority,
      state: state as CandidateState,
      reason,
    });
    if (!ok) {
      // The guard is `state <> 'MERGED'`, so this is an idea that folded into
      // another one while the person was typing. Reported as what it is: the
      // canonical is the thing to judge now.
      throw badRequest('That idea has been folded into another one, so judge that one instead.');
    }
    return { candidate: await getCandidate(candidate.id) };
  }),
);

/**
 * Undo a merge.
 *
 * Necessary rather than decorative, and it became necessary in this same
 * change: until now every merge was a `FINGERPRINT` match, which is exact and
 * effectively never wrong. A `SEMANTIC` merge is a worker's judgement held to
 * a floor, and a judgement that can be wrong needs a way back — otherwise
 * automatic deduplication is a mechanism for quietly losing somebody's idea.
 *
 * The split restores both identities and keeps the merge row, so what happened
 * stays readable.
 */
russellRouter.post(
  '/candidates/:candidateId/split',
  handler(async (req) => {
    const principal = requirePerson();
    const candidate = await requireCandidate(pathId(req, 'candidateId'));
    const reason = requiredString(bodyOf(req)['reason'], 'reason');
    const ok = await splitCandidate({
      candidateId: candidate.id,
      reason,
      actorUserId: principal.id,
    });
    if (!ok) throw badRequest('That idea is not folded into another one.');
    return { candidate: await getCandidate(candidate.id) };
  }),
);

russellRouter.get(
  '/candidates/:candidateId/probes',
  handler(async (req) => {
    const candidateId = pathId(req, 'candidateId');
    const probes = await listProbesForCandidate(candidateId);
    // A probe carries its project, so the project gate decides. A candidate
    // with no probes yields nothing, which is the same answer a candidate the
    // caller may not see gives — and that is the point.
    const first = probes[0];
    if (!first) return { probes: [] };
    if (first.projectId) await requireProject(first.projectId);
    return {
      probes: await Promise.all(
        probes.map(async (probe) => ({ ...probe, observations: await listObservations(probe.id) })),
      ),
    };
  }),
);

russellRouter.get(
  '/projects/:projectId/knowledge',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const limit = optionalInteger(queryOf(req)['limit'], 'limit', { min: 1, max: 200 }) ?? 100;
    /*
     * Two readings of the same question, and the second one is the reason this
     * route changed.
     *
     * `knowledge` is what Russell has captured since Step 12A. `knows` is that
     * *plus* the research the Brain already did — every claim Steps 9 to 11
     * filed, projected rather than copied, carrying its own evidence chain and
     * its own epistemic status. Without it a person opened Knows, saw almost
     * nothing, and concluded the Brain knew nothing while the archive held the
     * material that had already answered their question.
     *
     * Both are returned. The first is kept because callers already read it and
     * removing a field is a change nobody asked for; the second is what a
     * surface should render.
     */
    const [knowledge, knows] = await Promise.all([
      listCurrentKnowledge({
        projectId: project.id,
        // Private knowledge never leaves through this route. It is scoped to
        // the person who made it and there is no query parameter that widens
        // it — a flag a caller could set is not a boundary.
        includePrivate: false,
        limit,
      }),
      knowsForProject({ projectId: project.id, includePrivate: false, limit }),
    ]);
    return { knowledge, knows: surfaceState({ items: knows }) };
  }),
);

/**
 * The connected system, as Russell honestly sees it.
 *
 * Addressed by slug rather than by id because it is one named project — the
 * one Russell reports on by default — and a person's link to it should not
 * carry an opaque identifier. A caller who may not read that project gets the
 * same answer as one asking before it exists: the unavailable view, which
 * discloses nothing about which of the two is true.
 */
russellRouter.get(
  '/deal-dispatch',
  handler(async () => {
    const project = await getProjectBySlug(DEAL_DISPATCH_SLUG);
    if (project) await requireProject(project.id);
    return readDealDispatch();
  }),
);

/* --------------------------------------------------------------------------
 * Needs You
 * ------------------------------------------------------------------------ */

russellRouter.get(
  '/projects/:projectId/needs-you',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { requests: await listOpenRequests(project.id) };
  }),
);

/**
 * Answer one open decision.
 *
 * A write, so it needs write access to the project rather than read — which
 * `requireProject` decides from the route's own requirement, not from anything
 * this handler asserts. The answer is recorded against the person from the
 * authenticated principal; a body field naming an actor is not read.
 */
russellRouter.post(
  '/needs-you/:requestId/answer',
  handler(async (req) => {
    const principal = requirePerson();
    const request = await getHumanRequest(pathId(req, 'requestId'));
    if (!request) throw notFound('No request with that id.');
    if (request.projectId) await requireProject(request.projectId);

    const body = bodyOf(req);
    const outcome = await answerHumanRequest({
      requestId: request.id,
      actorUserId: principal.id,
      choice: requiredString(body['choice'], 'choice'),
      reason: optionalString(body['reason'], 'reason') ?? null,
    });
    if (!outcome.ok) {
      // An already-answered request is not an error the caller can fix by
      // retrying, and it is not a 404 either — they may read it, it is simply
      // settled. Reported as what it is.
      throw badRequest(outcome.reason);
    }
    return outcome.request;
  }),
);

/* --------------------------------------------------------------------------
 * What Russell may do on its own
 * ------------------------------------------------------------------------ */

/**
 * The decision a person makes about their own project, on the surface they
 * already use.
 *
 * It was on the operator console, and that was a mistake I made rather than a
 * design anybody chose. §22's rule that the console holds the button is about
 * **machines** — "a machine that could create its own work could also create
 * work nobody asked for" — and reading it as applying to the person who owns
 * the project sent the one decision Russell most obviously needs from them out
 * of Russell and into the administration surface §24 had already taken off the
 * normal route.
 *
 * **Nothing about the authorization moved with it.** The gate is
 * `requirePerson` plus `requireProject`, which is `decideProjectAccess` at the
 * level this request's own method requires — the same two checks every other
 * write on this router goes through. A worker principal is refused by type: no
 * membership configuration turns a machine into a person, and a machine that
 * could grant itself authority is precisely what §22 was protecting against.
 * That protection is stronger here than it was on the console, because it is
 * the same check the rest of the surface is already tested for.
 */
russellRouter.get(
  '/projects/:projectId/authority',
  handler(async (req) => {
    /*
     * `requirePerson` on the read as well as the writes.
     *
     * The first version had it only on the writes, and a test caught what that
     * cost: a worker holding `project:read` could fetch this, which names the
     * person who granted it by display name and enumerates what the project is
     * willing to spend. Neither is a machine's business, and the asymmetry was
     * not a considered decision — it was an omission that read as one.
     */
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return authorityFor({ projectId: project.id });
  }),
);

/**
 * Grant it.
 *
 * Every limit is read strictly and refused rather than defaulted. This is the
 * one form in the product where a quietly wrong number spends a subscription,
 * so a missing field, a fraction, a negative or an over-large value refuses the
 * whole request — the same rule `validateProposal` applies to a worker, applied
 * to a person, and for the same reason: a value nobody chose is not a decision.
 *
 * `ownerUserId` and `createdByUserId` both come from the authenticated
 * principal. There is no body field either could be read from, here or in
 * `createGoal`, which is what makes "who authorized this" answerable a year
 * later rather than merely recorded.
 */
russellRouter.post(
  '/projects/:projectId/authority',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const name = requiredString(body['name'], 'name');
    if (name.length > 200) {
      throw badRequest('Keep the description of what this authorizes under 200 characters.');
    }

    /*
     * A live grant is not replaced silently.
     *
     * Two active grants on one project would make "the limits you set" an
     * ambiguous phrase and `checkAuthority`'s choice of which one applies an
     * accident of ordering. Withdrawing is a separate, deliberate act.
     */
    const existing = await authorityFor({ projectId: project.id });
    if (existing.grant) {
      throw badRequest(
        'This project already has a standing authority. Withdraw it first if you want to change the limits.',
      );
    }

    const limits: Record<string, number> = {};
    for (const limit of AUTHORITY_LIMITS) {
      const raw = body[limit.key];
      const value = typeof raw === 'number' ? raw : Number.NaN;
      if (!Number.isInteger(value) || value < 0 || value > limit.max) {
        throw badRequest(
          `"${limit.label}" must be a whole number from 0 to ${limit.max}.`,
        );
      }
      limits[limit.key] = value;
    }
    const expiresAt = nullableString(body['expiresAt'], 'expiresAt') ?? null;
    if (expiresAt !== null) {
      const parsed = Date.parse(expiresAt);
      if (Number.isNaN(parsed)) throw badRequest('That is not a date this Brain can read.');
      if (parsed <= Date.now()) throw badRequest('An expiry in the past would grant nothing.');
    }

    const goal = await createGoal({
      projectId: project.id,
      // From the principal. Never a field — not here, and not in createGoal.
      ownerUserId: principal.id,
      createdByUserId: principal.id,
      name,
      // One class, named by the constant rather than taken from the request.
      // A grant that could name its own class of work is a grant that could
      // authorize something this screen never described.
      allowedWork: [RESEARCH_WORK],
      maxConcurrent: limits['maxConcurrent']!,
      /*
       * The three cumulative columns are not asked for and not set.
       *
       * They were lifetime quotas — reaching one stopped Russell until
       * somebody topped it up — and a subscription that is already paid for
       * does not run out that way. The policy says so explicitly rather than
       * carrying a large number that would read as a limit and one day be
       * one: under UNCAPPED `ceilingsFor` returns null for these and
       * `reserve` skips a null ceiling, so 0 here caps nothing. The
       * reservations themselves are still written and still counted.
       */
      workPolicy: 'UNCAPPED',
      maxMissions: 0,
      maxFragments: 0,
      maxProbes: 0,
      expiresAt,
    });

    await recordEvent({
      projectId: project.id,
      entityType: 'RUSSELL_GOAL',
      entityId: goal.id,
      eventType: 'RUSSELL_AUTHORITY_GRANTED',
      payload: {
        name: goal.name,
        workPolicy: goal.workPolicy,
        maxConcurrent: goal.maxConcurrent,
        expiresAt: goal.expiresAt,
        grantedByUserId: principal.id,
        surface: 'RUSSELL',
      },
    });

    return authorityFor({ projectId: project.id });
  }),
);

/**
 * Withdraw it.
 *
 * A reason is required for the same reason a judgment needs one: a decision
 * nobody can explain later is one nobody can review. Revocation lands on the
 * next check rather than at some sweep — every launch, provider call, writeback
 * and resume revalidates — and accepted work is untouched, because stopping new
 * work and corrupting finished work are different things.
 */
russellRouter.post(
  '/projects/:projectId/authority/:goalId/revoke',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const goal = await getGoal(pathId(req, 'goalId'));
    // A grant belonging to another project is refused as absent, like every
    // other cross-scope reference on this router.
    if (!goal || goal.projectId !== project.id) throw notFound('No authority with that id.');

    const reason = requiredString(bodyOf(req)['reason'], 'reason');
    const ok = await revokeGoal({ goalId: goal.id, actorUserId: principal.id, reason });
    if (!ok) throw badRequest('That authority has already ended.');

    await recordEvent({
      projectId: project.id,
      entityType: 'RUSSELL_GOAL',
      entityId: goal.id,
      eventType: 'RUSSELL_AUTHORITY_REVOKED',
      payload: { reason, revokedByUserId: principal.id, surface: 'RUSSELL' },
    });

    return authorityFor({ projectId: project.id });
  }),
);

/* --------------------------------------------------------------------------
 * Why Russell did or did not start something
 * ------------------------------------------------------------------------ */

/**
 * Would this be new work, or does the project already answer it?
 *
 * A POST because the question is a set of requirements rather than a string,
 * and because the answer is the thing that decides whether anything is spent —
 * invariant 13, exposed so a person can ask it before Russell does. It creates
 * nothing: `coverBeforeWork` is a pure read over accepted claims.
 */
russellRouter.post(
  '/projects/:projectId/coverage',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const layerId = requiredString(body['layerId'], 'layerId');
    await requireLayerOfProject(layerId, project.id);

    const raw = body['requirements'];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw badRequest('"requirements" must be a non-empty array.');
    }
    const requirements = raw.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      return {
        key: requiredString(item['key'], `requirements[${index}].key`),
        statement: requiredString(item['statement'], `requirements[${index}].statement`),
      };
    });

    const coverage = await coverBeforeWork({ projectId: project.id, layerId, requirements });
    return { coverage, explanation: explainCoverage(coverage) };
  }),
);

/* --------------------------------------------------------------------------
 * Connected sites
 * ------------------------------------------------------------------------ */

/**
 * The address this person is looking at, offered back to them as the value the
 * site should hold.
 *
 * §18 says a request never *chooses* a location, and this does not: nothing
 * reads it back, no storage key is built from it, and no decision anywhere
 * depends on it. It is the suggestion a person would otherwise copy out of
 * their own address bar, which is exactly the value they need and exactly the
 * one this request already proves they can reach.
 */
function brainUrlFrom(req: { protocol: string; get(name: string): string | undefined }): string | null {
  const host = req.get('host');
  if (!host) return null;
  const scheme = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
  if (scheme !== 'http' && scheme !== 'https') return null;
  return `${scheme}://${host}`;
}

/** A site this Brain knows, or the same 404 an unknown route gives. */
function requireSite(req: { params: Record<string, string> }) {
  const raw = req.params['site'] ?? '';
  if (!isKnownSite(raw)) throw notFound('No site with that name.');
  return siteFor(raw);
}

/**
 * The person acting, as a row rather than as a principal.
 *
 * Everything below attributes an identity change to somebody, and an audit row
 * with no author answers nothing later. The id comes from the authenticated
 * principal and from no field.
 */
async function actingPerson() {
  const principal = requirePerson();
  const user = await getUser(principal.id);
  if (!user || user.disabledAt) throw notFound('No such route.');
  return user;
}

/**
 * What every site Brain knows is doing on this project.
 *
 * `requirePerson` on the read as well as the writes, for the reason the
 * authority read gives: this enumerates identities and says what each one may
 * reach, and neither is a machine's business.
 */
russellRouter.get(
  '/projects/:projectId/sites',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { sites: await listConnectedSites(project.id) };
  }),
);

russellRouter.get(
  '/projects/:projectId/sites/:site',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const site = requireSite(req);
    return await siteStatus(project.id, site.system);
  }),
);

/**
 * Connect it, or rotate what it holds. One action, and the same one.
 *
 * There is no worker to name, no scope to choose and no project to pick: the
 * site is the one in the path, the project is the one being connected, and the
 * scope set is a constant. That is the whole point — the choice this replaced
 * had a wrong answer that failed silently, and a decision already settled is
 * not a decision to put in front of somebody.
 *
 * The response carries the credential once. It is not stored in a form it can
 * be recovered from, does not appear in the identity event, and is not in any
 * later read of this route.
 */
russellRouter.post(
  '/projects/:projectId/sites/:site/connect',
  handler(async (req) => {
    const actor = await actingPerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const site = requireSite(req);
    return await connectSite({
      projectId: project.id,
      system: site.system,
      actor,
      brainUrl: brainUrlFrom(req as never),
    });
  }),
);

/**
 * Take it away.
 *
 * Revoking rather than deleting: the worker, the membership, every credential
 * digest and every record the site delivered all keep their rows. What changes
 * is that nothing it presents authenticates.
 */
russellRouter.post(
  '/projects/:projectId/sites/:site/disconnect',
  handler(async (req) => {
    const actor = await actingPerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const site = requireSite(req);
    const body = bodyOf(req);
    return await disconnectSite({
      projectId: project.id,
      system: site.system,
      actor,
      reason: nullableString(body['reason'], 'reason') ?? null,
    });
  }),
);

/**
 * A repeated query parameter, filtered to a known enum.
 *
 * An unrecognised value is dropped rather than refused, because a stale link
 * with an old state name should show a person their work rather than an error —
 * and because the values reach a parameterised `IN`, so the filter is about
 * meaning rather than about safety.
 */
function enumList(value: unknown, allowed: readonly string[]): string[] | undefined {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const kept = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => allowed.includes(entry));
  return kept.length > 0 ? kept : undefined;
}
