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
import { listCandidates } from '../repos/russellCandidates.ts';
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
import type { CandidateState, MissionState, Principal } from '../domain/types.ts';
import { CANDIDATE_STATES, MISSION_STATES } from '../domain/types.ts';

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
