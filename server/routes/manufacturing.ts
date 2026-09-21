/**
 * The manufacturing programme's door.
 *
 * Every route here resolves through `requireProject`, which is
 * `decideProjectAccess` against the authenticated principal, so absent and
 * forbidden are the same 404 **with the same body** — invariant 23 at a new
 * door. Nothing here composes a second 404 sentence of its own; the one that
 * tried is the first thing below, and why it stopped is written there.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at every write by level, because `services/identity/policy.ts` puts all four
 * at ADMIN; this refuses it by *type*, at the reads as well, because no
 * membership configuration turns a machine into a person. Two independent
 * guards, because a guard on one entrance is not a guard.
 *
 * There is **no manufacturing policy module and there must never be one.**
 * Which level each of these needs is declared in `services/identity/policy.ts`
 * beside every other route, for §21's reason: a second security model is a
 * second thing to keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/manufacturing/`; these resolve the project, hand over the
 * principal, and turn a refusal into a status.
 *
 * **There is no route here that builds, buys, tools or enters anything**, and
 * that is not an omission to be filled in later. Everything this kernel does is
 * read published sources and record what a person decides; producing a machine
 * is a decision with a factory on the end of it, and it has no API.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import {
  MACHINE_CATEGORY_KINDS,
  PROGRAMME_DECISION_TOPICS,
  type MachineCategoryKind,
  type ProgrammeDecisionTopic,
} from '../domain/types.ts';
import { moveProgramme, startProgramme } from '../services/manufacturing/program.ts';
import {
  declareHeld,
  ledger,
  reopenDecision,
  resolveDecision,
  retireCategoryDecision,
  seedCategory,
  setAsideAcquisition,
  withdrawHeld,
} from '../services/manufacturing/declare.ts';
import { programmeView } from '../services/manufacturing/view.ts';

export const manufacturingRouter = Router();

/* --------------------------------------------------------------------------
 * Reading
 *
 * The default READ level, so every member of the project can see the ladder,
 * what each category is missing, and what Brain would ask next. Reading
 * performs no effect: no round is opened, no category created and no capability
 * held, which the tests assert against the rows rather than trusting to this
 * sentence.
 * ------------------------------------------------------------------------ */

/**
 * There is exactly **one** 404 at this door, and it is `requireProject`'s.
 *
 * It used to be two. A project the caller may not have answered
 * `No project with that id.`, and a project they *may* have with no programme
 * on it answered `This project has no manufacturing programme.` — same status,
 * different body, which is invariant 23 broken by the half nobody looks at:
 * *"including the body of the refusal, not only its status"*. The hosted gate
 * compares the two bodies rather than the two statuses, and reported it on
 * every deploy.
 *
 * The tempting repair is to make the second refusal say the first one's
 * sentence. That is worse, and worth writing down rather than discovering
 * again: a member opening their own project would be told it does not exist,
 * and the screen behind that 404 is the one offering to **start** a
 * programme — so a project somebody may not touch would render a Start button
 * that can only ever be refused (§35: a control that cannot succeed should not
 * be offered).
 *
 * So the third body is removed rather than disguised. *A project you may read
 * has no programme* is not a refusal at all — it is an ordinary answer to
 * somebody entitled to it — and it answers 200 with `programme: null`. What is
 * left is one refusal, thrown by the resolver every other route shares, so the
 * two cannot drift apart again: there is no second sentence here to keep in
 * step with `authorizeProject`'s.
 *
 * The envelope is deliberate rather than a bare `null` body. `{ programme:
 * null }` says *there is none*; a bare `null` is indistinguishable from a body
 * that failed to parse.
 */
manufacturingRouter.get(
  '/projects/:projectId/manufacturing',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { programme: await programmeView(project.id) };
  }),
);

manufacturingRouter.get(
  '/projects/:projectId/manufacturing/capabilities',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { capabilities: await ledger(project.id) };
  }),
);

/* --------------------------------------------------------------------------
 * Starting and moving a programme
 * ------------------------------------------------------------------------ */

manufacturingRouter.post(
  '/projects/:projectId/manufacturing',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await startProgramme({
      projectId: project.id,
      // The programme belongs to whoever is named as its owner, defaulting to
      // the person starting it. Both come from the authenticated principal or
      // from a field a person supplied, and neither decides anything about
      // authorization: `requireProject` has already settled that.
      ownerUserId: optionalString(body['ownerUserId'], 'ownerUserId') ?? principal.id,
      actorUserId: principal.id,
      objective: requiredString(body['objective'], 'objective'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { program: outcome.program, created: outcome.created };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const to = requiredString(body['state'], 'state');
    if (to !== 'ACTIVE' && to !== 'PAUSED' && to !== 'ARCHIVED') {
      throw badRequest('"state" must be ACTIVE, PAUSED or ARCHIVED.');
    }
    const outcome = await moveProgramme({
      projectId: project.id,
      actorUserId: principal.id,
      to,
      reason: optionalString(body['reason'], 'reason') ?? null,
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { program: outcome.program, changed: outcome.changed };
  }),
);

/* --------------------------------------------------------------------------
 * Naming a category, and retiring one
 *
 * `SEED` is the one category origin Brain itself may never write: a machine
 * that could name its own categories would be deciding what this company is.
 * Retiring is the one verdict no derivation could reach, and it destroys
 * nothing — the category keeps its id, its evidence and every round ever run
 * against it.
 * ------------------------------------------------------------------------ */

manufacturingRouter.post(
  '/projects/:projectId/manufacturing/categories',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const kindRaw = optionalString(body['kind'], 'kind');
    if (kindRaw && !(MACHINE_CATEGORY_KINDS as readonly string[]).includes(kindRaw)) {
      throw badRequest(`"kind" must be one of: ${MACHINE_CATEGORY_KINDS.join(', ')}.`);
    }

    const outcome = await seedCategory({
      projectId: project.id,
      name: requiredString(body['name'], 'name'),
      kind: (kindRaw as MachineCategoryKind | undefined) ?? undefined,
      description: optionalString(body['description'], 'description') ?? null,
      parentId: optionalString(body['parentId'], 'parentId') ?? null,
      actorRef: principal.id,
      reason: optionalString(body['reason'], 'reason') ?? null,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { category: outcome.category, created: outcome.created };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing/categories/:categoryId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await retireCategoryDecision({
      projectId: project.id,
      categoryId: pathId(req, 'categoryId'),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { category: outcome };
  }),
);

/* --------------------------------------------------------------------------
 * What this company can actually do
 *
 * The most consequential write in this kernel, and the one no research path can
 * reach. A capability a product *teaches* is not a capability this company
 * *holds*; everything downstream — what is enterable, what is missing, what to
 * build next — turns on the difference, and only a person can establish it.
 * ------------------------------------------------------------------------ */

manufacturingRouter.post(
  '/projects/:projectId/manufacturing/capabilities',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    /*
     * The note is read as optional here and required by the service, which is
     * deliberate rather than lax.
     *
     * `requiredString` refuses an empty one with *"note" is required and must
     * be a non-empty string* — true, and useless about why. `declareHeld` says
     * what a note is for: *say what was hired, bought, built or delivered; a
     * capability held for no stated reason is indistinguishable afterwards from
     * one somebody guessed.* That is the sentence a person should read at the
     * one control that records the most consequential fact in this kernel, so
     * the route stops pre-empting the rule and lets the rule speak.
     *
     * Nothing is weakened: the service refuses either way, and the refusal is
     * still the server's rather than the screen's.
     */
    const outcome = await declareHeld({
      projectId: project.id,
      capabilityId: optionalString(body['capabilityId'], 'capabilityId') ?? null,
      name: optionalString(body['name'], 'name') ?? null,
      note: optionalString(body['note'], 'note') ?? '',
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { capability: outcome.capability, changed: outcome.changed };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing/capabilities/:capabilityId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await withdrawHeld({
      projectId: project.id,
      capabilityId: pathId(req, 'capabilityId'),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { capability: outcome };
  }),
);

/* --------------------------------------------------------------------------
 * Acquisition candidates
 *
 * One verb, and that is the whole surface: a person may set one aside.
 *
 * There is deliberately no route that approaches a firm, requests information
 * from one, values one, proposes terms, records an offer or marks one as being
 * pursued — and that is a property of there being no such route and no column
 * to write into rather than a rule somebody is following. The directive asks
 * Brain to *identify* acquisition opportunities; every effect that follows
 * from one is a commercial action a person authorizes separately (§30), and
 * nothing in this kernel reaches one.
 * ------------------------------------------------------------------------ */

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing/acquisitions/:candidateId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await setAsideAcquisition({
      projectId: project.id,
      candidateId: pathId(req, 'candidateId'),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { candidate: outcome };
  }),
);

/* --------------------------------------------------------------------------
 * The questions this kernel cannot answer
 *
 * A person answers one in their own words, or unanswers one they had. Both are
 * guarded single-shot transitions in the repository, so two requests produce
 * one decision.
 *
 * `topic` is matched against a closed set rather than read as free text, for
 * `PREFERENCES`' reason: a topic somebody could invent by posting is one
 * nobody reviewed the criteria for, and the criteria are what make a decision
 * answerable at all.
 * ------------------------------------------------------------------------ */

function topicOf(raw: string): ProgrammeDecisionTopic {
  if (!(PROGRAMME_DECISION_TOPICS as readonly string[]).includes(raw)) {
    throw badRequest(`"topic" must be one of: ${PROGRAMME_DECISION_TOPICS.join(', ')}.`);
  }
  return raw as ProgrammeDecisionTopic;
}

manufacturingRouter.post(
  '/projects/:projectId/manufacturing/decisions/:topic',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    /*
     * Read as optional here and required by the service, for the reason the
     * capability note is.
     *
     * `requiredString` would refuse an empty answer with *"resolution" is
     * required* — true, and useless about why. `resolveDecision` says what an
     * answer is: the words you would say, because an empty one reads
     * afterwards as a decision taken with nothing behind it. Nothing is
     * weakened; the service refuses either way.
     */
    const outcome = await resolveDecision({
      projectId: project.id,
      topic: topicOf(pathId(req, 'topic')),
      resolution: optionalString(body['resolution'], 'resolution') ?? '',
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { decision: outcome };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing/decisions/:topic',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await reopenDecision({
      projectId: project.id,
      topic: topicOf(pathId(req, 'topic')),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { decision: outcome };
  }),
);
