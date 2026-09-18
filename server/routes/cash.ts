/**
 * Cash Mode's door.
 *
 * Every route here resolves through `requireProject`, which is
 * `decideProjectAccess` against the authenticated principal, so absent and
 * forbidden are the same 404 **with the same body** — invariant 23 at a new
 * door, where the thing being hidden is somebody else's private operation and
 * even its existence is information.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at every write by `MISSING_SCOPE` and at the two ADMIN routes by level; this
 * refuses it by *type*, at the reads as well, because no membership
 * configuration turns a machine into a person and a sprint's money is the last
 * place to find that out. Two independent guards, because a guard on one
 * entrance is not a guard.
 *
 * There is **no cash policy module and there must never be one.** Which level
 * each of these needs is declared in `services/identity/policy.ts` beside every
 * other route, for §21's reason: a second security model is a second thing to
 * keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/cash/`; these resolve the project, hand over the principal, and
 * turn a refusal into a status.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  conflict,
  handler,
  notFound,
  optionalInteger,
  optionalNumber,
  optionalString,
  optionalStringArray,
  pathId,
  requireBrainAdmin,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import { getCashMode, listCashEventsFor, listCashModes } from '../repos/cashMode.ts';
import { listProjects } from '../repos/projects.ts';
import { currentPrincipal } from '../services/identity/context.ts';
import { visibleProjectIds } from '../services/identity/policy.ts';
import {
  createAuthority,
  getCommitment,
  liveAuthority,
  releaseCommitment,
  revokeAuthority,
} from '../repos/cashAuthority.ts';
import { getNeed, getOpportunity } from '../repos/cashPortfolio.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
  describeAuthority,
  isCommercialAction,
} from '../services/cash/authority.ts';
import { evidenceCard } from '../services/cash/card.ts';
import {
  DEFAULT_CASH_ENVELOPE,
  DEFAULT_HORIZON_DAYS,
  SELECTABLE_CASH_ENVELOPES,
  SPRINT_CURRENCIES,
  activate,
  setLifecycle,
} from '../services/cash/lifecycle.ts';
import {
  actionKey,
  advance,
  archiveOpportunity,
  beginExecution,
  capture,
  commitSpend,
  decline,
  exhaust,
  fillCard,
  markReady,
  recordMoneyEvent,
  reoffer,
  settleSpend,
} from '../services/cash/opportunities.ts';
import { closeNeed, raiseNeed } from '../services/cash/needs.ts';
import { cashView } from '../services/cash/view.ts';
import { decideCashRead } from '../services/cash/access.ts';
import { sharedCashView } from '../services/cash/shared.ts';
import {
  CANONICAL_CASH_OBJECTIVE,
  CANONICAL_CASH_SUMMARY,
  findCashRoot,
  objectiveWith,
  resolveOrCreateCashRoot,
} from '../services/cash/root.ts';
import { recordCashEvent } from '../repos/cashMode.ts';
import {
  CASH_MECHANISMS,
  CASH_MODE_STATES,
  CASH_MONEY_KINDS,
  type CashMoneyKind,
} from '../domain/types.ts';
import type { Outcome } from '../services/cash/opportunities.ts';

export const cashRouter: Router = Router();

/**
 * The three ceilings, required and never defaulted.
 *
 * Every one of them was a prefilled number the person did not choose, which is
 * the same shape as an optional `mutationScope` defaulting to the whole
 * repository: the safe answer is the one somebody has to remember and the
 * unsafe one is free. `maxConcurrent` in particular had a default of three,
 * which quietly contradicted the whole point of assembling several pieces at
 * once — it bounds what may be *executing*, and a number nobody chose is not a
 * statement about fulfilment capacity.
 */
function proposedTerms(body: Record<string, unknown>): {
  maxCommittedCents: number;
  maxPerActionCents: number;
  maxConcurrent: number;
} {
  const maxCommittedCents = optionalInteger(body['maxCommittedCents'], 'maxCommittedCents', {
    min: 0,
  });
  const maxPerActionCents = optionalInteger(body['maxPerActionCents'], 'maxPerActionCents', {
    min: 0,
  });
  const maxConcurrent = optionalInteger(body['maxConcurrent'], 'maxConcurrent', {
    min: 1,
    max: 100,
  });
  if (
    maxCommittedCents === undefined ||
    maxPerActionCents === undefined ||
    maxConcurrent === undefined
  ) {
    throw badRequest(
      '"maxCommittedCents", "maxPerActionCents" and "maxConcurrent" are all required. Money is ' +
        'the one thing in this Brain that is genuinely scarce and fulfilment capacity is real, ' +
        'so none of them has a default: a limit nobody chose is not a limit somebody set.',
    );
  }
  if (maxPerActionCents > maxCommittedCents) {
    throw badRequest(
      'A single commitment cannot be larger than everything that may be committed at once.',
    );
  }
  return { maxCommittedCents, maxPerActionCents, maxConcurrent };
}

/** A service refusal becomes a 422: the request was understood and refused. */
function taken<T>(outcome: Outcome<T>): { value: T; message: string } {
  if (!outcome.ok) throw unprocessable(outcome.reason);
  return { value: outcome.value, message: outcome.message };
}

/**
 * Resolve a Cash resource through its own project's guard, with **one** body
 * for absent and forbidden.
 *
 * The first version got the status right and the body wrong: a missing id
 * answered `No opportunity with that id.` and one belonging to somebody else
 * answered `No project with that id.`, because the refusal came from a
 * different resolver. Two different bodies on the same status is invariant 23
 * broken by the half nobody looks at — *"including the body of the refusal, not
 * only its status"* — and it is an oracle for existence: ask for an id you
 * guessed and the wording tells you whether it is real.
 *
 * The project guard still runs, so `authorizeProject` still writes its denial
 * row; only the sentence that comes back is normalized. A test asserting the
 * status alone cannot see this, which is why the HTTP suite now compares the
 * whole response.
 */
async function resolveInProject<T extends { projectId: string }>(
  found: T | null,
  missing: string,
): Promise<T> {
  if (!found) throw notFound(missing);
  try {
    await requireProject(found.projectId);
  } catch {
    throw notFound(missing);
  }
  return found;
}

async function requireOpportunity(id: string) {
  return resolveInProject(await getOpportunity(id), 'No opportunity with that id.');
}

/* --------------------------------------------------------------------------
 * Which operation
 * ------------------------------------------------------------------------ */

/**
 * The cash operations this person can actually reach.
 *
 * The section used to take whichever project the shell happened to have
 * selected — normally the first visible one — so somebody with a broad Brain
 * project *and* a private cash project could be shown, and could activate, the
 * wrong one. A sprint belongs to an operation; the operation is the thing to
 * choose, and it is chosen here rather than inherited.
 *
 * Bounded in the query by `visibleProjectIds` rather than filtered afterwards,
 * so an operation this person cannot read is not counted, let alone named.
 */
/**
 * The one Cash Mode, and what it is for.
 *
 * This replaced a listing of "operations" a person chose between. There is one
 * frontier, so there is nothing to choose: the root is resolved server-side and
 * the objective is Brain's own. See `services/cash/root.ts` for why the four
 * person-derived projects stay underneath rather than being offered here.
 *
 * It creates nothing. A person looking at an inactive page must not bring a
 * root into existence by looking at it.
 */
cashRouter.get(
  '/cash/mode',
  handler(async () => {
    requirePerson();
    const root = await findCashRoot();
    const mode = root ? await getCashMode(root.id) : null;
    return {
      /*
       * Null until somebody presses the button. The client renders the
       * canonical objective and a single control from this, and derives no
       * sentence of its own — §29's one-projection rule.
       */
      root: root ? { projectId: root.id, projectName: root.name } : null,
      mode: mode
        ? {
            projectId: mode.projectId,
            state: mode.state,
            currency: mode.currency,
            activatedAt: mode.activatedAt,
            objective: mode.objective,
          }
        : null,
      objective: { summary: CANONICAL_CASH_SUMMARY, full: CANONICAL_CASH_OBJECTIVE },
      currencies: [...SPRINT_CURRENCIES],
      /*
       * Readiness used to be sent from here, and the reason it no longer is, is
       * that it was never about Cash.
       *
       * Who has joined this Brain and how many Claude Routines it can fire are
       * **account infrastructure**: both are true of the whole Brain, both are
       * unchanged by a sprint starting or ending, and §32 already removed the
       * last thing on this surface that made either of them a gate. Rendering
       * them here made a temporary section the place a person went to
       * administer the permanent Brain, which is §30's own first sentence
       * failing — Cash Mode is a section, not the definition of Brain.
       *
       * They are on People & Capacity now, from `services/identity/people.ts`
       * and `services/fleet/capacity.ts`, which are the modules that own those
       * questions. This route sends neither, so there is no second reading of
       * either fact to disagree with the first.
       */
    };
  }),
);

/**
 * Start it. One click, no configuration.
 *
 * No project: there is one frontier and the server resolves where it lives,
 * adopting research that already exists rather than stranding it. No objective:
 * the canonical one is in code, because a person asked to describe the mandate
 * in a text box silently narrows it by whatever they leave out, and nobody can
 * see the omission afterwards.
 *
 * `constraints` is optional and **additive** — `objectiveWith` appends it under
 * a heading that says which half is the standing mandate and which is this
 * week's steer. It cannot remove anything.
 *
 * It authorizes no spending. The commercial grant below is a separate decision
 * and this route cannot make one.
 */
cashRouter.post(
  '/cash/activate',
  handler(async (req) => {
    const principal = requirePerson();
    /*
     * And a Brain administrator, explicitly.
     *
     * The project-scoped cash routes reach ADMIN through `requireProject`, and
     * this one has no project to be scoped by — it may *create* the root. So
     * the level is asked for directly rather than inherited, because a route
     * that creates a project and starts the shared frontier is not something
     * every signed-in person should be able to press.
     */
    await requireBrainAdmin();
    const body = bodyOf(req);

    /*
     * One Cash Mode in the whole Brain. Checked before a root is created, so a
     * second press cannot leave an empty project behind.
     */
    const already = await findCashRoot();
    if (already && (await getCashMode(already.id))) {
      const mode = (await getCashMode(already.id))!;
      return { mode, changed: false, message: `Cash Mode has been running since ${mode.activatedAt}.` };
    }

    /*
     * Readiness is reported and does not gate.
     *
     * The four-of-four count was the owner's decision to wait for everybody
     * rather than a property of the system, and it has been withdrawn. The
     * counts are still derived and still shown — a person starting below them
     * can see exactly who cannot sign in yet and which surfaces are unproven —
     * but they stop nothing, and the remaining members and Routines join
     * afterwards through the paths they always did.
     *
     * Nothing else about this route moved. `requirePerson` and
     * `requireBrainAdmin` above are unchanged, the one-Cash-Mode check is
     * unchanged, and **being able to start is still not being authorized to
     * spend**: the standing commercial grant of §30 is a separate decision
     * this route cannot make.
     */
    const root = await resolveOrCreateCashRoot();
    const outcome = await activate({
      projectId: root.id,
      ownerUserId: principal.id,
      actorUserId: principal.id,
      objective: objectiveWith(optionalString(body['constraints'], 'constraints')),
      currency: optionalString(body['currency'], 'currency'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { mode: outcome.mode, changed: outcome.changed, message: outcome.message };
  }),
);

/* --------------------------------------------------------------------------
 * The section itself
 * ------------------------------------------------------------------------ */

/**
 * One person's whole private Cash section, in one read.
 *
 * §29's rule: one projection answers every surface. The client renders this and
 * derives nothing of its own, so two screens cannot disagree about one sprint.
 */
cashRouter.get(
  '/projects/:projectId/cash',
  handler(async (req) => {
    requirePerson();
    const projectId = pathId(req, 'projectId');

    /*
     * Two readers of one section, and the seam is here rather than in the page.
     *
     * An ordinary enrolled member opening `/cash` was told *"there is nothing
     * here for you to see"* — the §23 refusal, correct in its own terms and
     * answering the wrong question. The shared frontier is a project, so
     * `requireProject` asked whether this person was a member of it, and the
     * answer for everybody but the owner and a Brain administrator was no.
     *
     * `decideCashRead` is the correction, and it is deliberately *not* a
     * special case in the client: the payload changes, so there is no shape of
     * this bug a screen could paper over. FULL is `decideProjectAccess` and
     * nothing else; SHARED is a strictly smaller projection built by
     * `services/cash/shared.ts`; NONE falls through to the identical refusal,
     * in the identical words, that an outsider and a missing project both get.
     */
    const decision = await decideCashRead(projectId);
    if (decision.scope === 'SHARED') {
      return await sharedCashView({ projectId });
    }
    if (decision.scope === 'NONE') {
      /*
       * Through `requireProject` rather than by throwing here, so absent,
       * forbidden and *not a person* are one refusal with one body and one
       * audit row — the same one every other project-scoped route produces.
       */
      await requireProject(projectId);
    }

    const project = await requireProject(projectId);
    const view = await cashView({ projectId: project.id });
    return {
      scope: 'FULL' as const,
      ...view,
      // The contract travels down with the view rather than being restated in
      // the client, so what a person is offered and what the server accepts are
      // one object — §24's manifest lesson.
      vocabulary: {
        mechanisms: CASH_MECHANISMS,
        moneyKinds: CASH_MONEY_KINDS,
        commercialActions: COMMERCIAL_ACTIONS,
        neverAuthorizable: ALWAYS_PROHIBITED_COMMERCIAL,
        lifecycleStates: CASH_MODE_STATES,
        envelopes: SELECTABLE_CASH_ENVELOPES,
        defaultEnvelope: DEFAULT_CASH_ENVELOPE,
        defaultHorizonDays: DEFAULT_HORIZON_DAYS,
        currencies: SPRINT_CURRENCIES,
      },
    };
  }),
);

/**
 * Activate the section, or move its lifecycle.
 *
 * ADMIN, which is the level a membership change already carries, because
 * turning a sprint on for a project is a decision *about* the operation rather
 * than work inside it. A worker is refused by level and again by type.
 */
cashRouter.post(
  '/projects/:projectId/cash/mode',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const to = optionalString(body['state'], 'state');
    if (to !== undefined) {
      if (!(CASH_MODE_STATES as readonly string[]).includes(to)) {
        throw badRequest(`"state" must be one of: ${CASH_MODE_STATES.join(', ')}.`);
      }
      const outcome = await setLifecycle({
        projectId: project.id,
        to: to as (typeof CASH_MODE_STATES)[number],
        actorUserId: principal.id,
        reason: requiredString(body['reason'], 'reason'),
      });
      if (!outcome.ok) throw unprocessable(outcome.reason);
      return { mode: outcome.mode, changed: outcome.changed, message: outcome.message };
    }

    const outcome = await activate({
      projectId: project.id,
      // Whose sprint this is. Defaults to the person activating it; naming
      // somebody else is how an administrator sets a project up for its owner.
      ownerUserId: optionalString(body['ownerUserId'], 'ownerUserId') ?? principal.id,
      actorUserId: principal.id,
      objective: objectiveWith(optionalString(body['constraints'], 'constraints')),
      horizonDays: optionalInteger(body['horizonDays'], 'horizonDays', { min: 1, max: 365 }),
      envelopeId: optionalString(body['envelopeId'], 'envelopeId'),
      currency: optionalString(body['currency'], 'currency'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { mode: outcome.mode, changed: outcome.changed, message: outcome.message };
  }),
);

/* --------------------------------------------------------------------------
 * The commercial authority
 *
 * The one decision Brain cannot make for itself and cannot proceed without.
 * ADMIN plus `requirePerson`, which is a *stronger* pair than the deleted
 * operator console's administrator-plus-same-origin: a worker principal is
 * refused here by type, and a machine that could grant itself a spending
 * ceiling is exactly what §22's split forbids.
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/authority',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const mode = await getCashMode(project.id);
    if (!mode) {
      throw unprocessable(
        'Activate Cash Mode for this project first. A spending ceiling with no sprint to spend ' +
          'it in is a permission nobody asked for.',
      );
    }

    const existing = await liveAuthority(project.id);
    if (existing) {
      throw conflict(
        'A commercial authority is already live here. Two would make "the limits you set" ' +
          'ambiguous, so change one by withdrawing it and making a new one deliberately. ' +
          'Withdrawing keeps every commitment and every money record.',
      );
    }

    const actions = optionalStringArray(body['allowedActions'], 'allowedActions') ?? [];
    if (actions.length === 0) {
      throw badRequest(
        `"allowedActions" needs at least one of: ${COMMERCIAL_ACTIONS.join(', ')}. A grant that ` +
          'authorizes nothing is not a grant.',
      );
    }
    for (const action of actions) {
      if (isCommercialAction(action)) continue;
      // An unknown field refuses the whole grant rather than being dropped:
      // `proposal.ts`'s rule, at the surface that spends money.
      throw badRequest(
        `"${action}" is not a commercial action this Brain knows how to authorize. The set is ` +
          `fixed in code: ${COMMERCIAL_ACTIONS.join(', ')}.`,
      );
    }

    const terms = proposedTerms(body);

    const authority = await createAuthority({
      projectId: project.id,
      ownerUserId: mode.ownerUserId,
      createdByUserId: principal.id,
      name: optionalString(body['name'], 'name') ?? 'Cash Mode commercial authority',
      allowedActions: actions,
      // Unioned in rather than trusted to the caller, so a grant written by a
      // script or a future screen cannot omit one by forgetting.
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: terms.maxCommittedCents,
      maxPerActionCents: terms.maxPerActionCents,
      maxConcurrent: terms.maxConcurrent,
      // The sprint's, never the caller's: a grant in another currency could
      // never authorize anything this sprint spends.
      currency: mode.currency,
      expiresAt: optionalString(body['expiresAt'], 'expiresAt') ?? null,
    });

    await recordCashEvent({
      projectId: project.id,
      kind: 'CASH_AUTHORITY_GRANTED',
      actorRef: principal.id,
      summary: 'A standing commercial authority was granted.',
      detail: {
        allowedActions: actions,
        maxCommittedCents: authority.maxCommittedCents,
        maxPerActionCents: authority.maxPerActionCents,
        maxConcurrent: authority.maxConcurrent,
        currency: authority.currency,
        expiresAt: authority.expiresAt,
      },
    });

    return { authority, lines: describeAuthority(authority) };
  }),
);

/**
 * What this grant would authorize, in the server's own words, before anybody
 * approves it.
 *
 * The card used to arrive prefilled — $1,000 committed, $250 per action, three
 * opportunities, every commercial action ticked — with **Approve** visible and
 * the actual terms folded away under *Change details*. That is the defect §27
 * records about `mutationScope`, one subject along: the widest reach was the
 * one somebody had to remember to narrow, and the terms a person was agreeing
 * to were the ones they had not been shown.
 *
 * So there are no defaults, and this is what makes that workable: the numbers
 * are typed, this returns the exact sentences that would govern them, and
 * Approve posts the same numbers. It **writes nothing** — reading what a
 * permission would mean must never be a way to grant it.
 */
cashRouter.post(
  '/projects/:projectId/cash/authority/preview',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const mode = await getCashMode(project.id);
    if (!mode) throw unprocessable('Cash Mode has not been activated for this project.');

    const body = bodyOf(req);
    const actions = optionalStringArray(body['allowedActions'], 'allowedActions') ?? [];
    for (const action of actions) {
      if (isCommercialAction(action)) continue;
      throw badRequest(`"${action}" is not a commercial action this Brain knows how to authorize.`);
    }
    const terms = proposedTerms(body);

    const at = new Date().toISOString();
    return {
      lines: describeAuthority({
        id: 'preview',
        projectId: project.id,
        ownerUserId: mode.ownerUserId,
        name: 'preview',
        policyVersion: 1,
        allowedActions: actions,
        prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
        maxCommittedCents: terms.maxCommittedCents,
        maxPerActionCents: terms.maxPerActionCents,
        maxConcurrent: terms.maxConcurrent,
        currency: mode.currency,
        startsAt: at,
        expiresAt: optionalString(body['expiresAt'], 'expiresAt') ?? null,
        state: 'ACTIVE',
        revokedAt: null,
        revokedByUserId: null,
        revokedReason: null,
        createdByUserId: mode.ownerUserId,
        createdAt: at,
        updatedAt: at,
      }),
    };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/authority/:authorityId/withdraw',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const authorityId = pathId(req, 'authorityId');
    const reason = requiredString(bodyOf(req)['reason'], 'reason');

    const live = await liveAuthority(project.id);
    if (!live || live.id !== authorityId) {
      // Not "that grant belongs to another project": a grant this caller cannot
      // reach is one that does not exist, in the same words.
      throw notFound('No commercial authority with that id.');
    }

    const revoked = await revokeAuthority({ authorityId, actorUserId: principal.id, reason });
    if (!revoked) throw conflict('That authority has already been withdrawn.');

    await recordCashEvent({
      projectId: project.id,
      kind: 'CASH_AUTHORITY_WITHDRAWN',
      actorRef: principal.id,
      summary: 'The standing commercial authority was withdrawn.',
      detail: { reason, authorityId },
    });
    return {
      withdrawn: true,
      message:
        'Withdrawn. Every commitment, money entry and opportunity is exactly as it was; what ' +
        'stops is new commercial action.',
    };
  }),
);

/* --------------------------------------------------------------------------
 * The portfolio
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/opportunities',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const mode = await getCashMode(project.id);
    const { value, message } = taken(
      await capture({
        projectId: project.id,
        actorRef: principal.id,
        ownerUserId: mode?.ownerUserId ?? principal.id,
        title: requiredString(body['title'], 'title'),
        mechanism: requiredString(body['mechanism'], 'mechanism'),
        currency: optionalString(body['currency'], 'currency') ?? 'USD',
        industry: optionalString(body['industry'], 'industry') ?? null,
        source: optionalString(body['source'], 'source') ?? null,
        candidateId: optionalString(body['candidateId'], 'candidateId') ?? null,
        externalRecordId: optionalString(body['externalRecordId'], 'externalRecordId') ?? null,
        expiresAt: optionalString(body['expiresAt'], 'expiresAt') ?? null,
        expiryReason: optionalString(body['expiryReason'], 'expiryReason') ?? null,
        dependsOnId: optionalString(body['dependsOnId'], 'dependsOnId') ?? null,
        duplicateOfId: optionalString(body['duplicateOfId'], 'duplicateOfId') ?? null,
        requiredCapabilities:
          optionalStringArray(body['requiredCapabilities'], 'requiredCapabilities') ?? [],
        nextAction: optionalString(body['nextAction'], 'nextAction') ?? null,
        stopRule: optionalString(body['stopRule'], 'stopRule') ?? null,
      }),
    );
    return { opportunity: value, card: evidenceCard(value), message };
  }),
);

cashRouter.get(
  '/cash/opportunities/:opportunityId',
  handler(async (req) => {
    requirePerson();
    const opportunity = await requireOpportunity(pathId(req, 'opportunityId'));
    return {
      opportunity,
      card: evidenceCard(opportunity),
      history: await listCashEventsFor(opportunity.id, 50),
    };
  }),
);

cashRouter.patch(
  '/cash/opportunities/:opportunityId',
  handler(async (req) => {
    const principal = requirePerson();
    const opportunity = await requireOpportunity(pathId(req, 'opportunityId'));
    const { value, message } = taken(
      await fillCard({
        opportunityId: opportunity.id,
        actorRef: principal.id,
        patch: bodyOf(req),
      }),
    );
    return { opportunity: value, card: evidenceCard(value), message };
  }),
);

/**
 * Every lifecycle move an opportunity has, behind one route.
 *
 * One route rather than seven because they share the whole of their guard —
 * resolve, authorize, hand to the service — and differ only in which named
 * transition runs. The `action` is matched exactly against a closed set; an
 * unknown one is refused rather than being treated as the nearest match.
 */
cashRouter.post(
  '/cash/opportunities/:opportunityId/:action',
  handler(async (req) => {
    const principal = requirePerson();
    const opportunity = await requireOpportunity(pathId(req, 'opportunityId'));
    const action = pathId(req, 'action');
    const body = bodyOf(req);

    switch (action) {
      case 'ready': {
        const { value, message } = taken(
          await markReady({ opportunityId: opportunity.id, actorRef: principal.id }),
        );
        return { opportunity: value, message };
      }
      case 'execute': {
        /*
         * Executing means something happened, so the call says what.
         *
         * `action` and `detail` are what a person did — contacted the buyer,
         * sent the quote — and the key is built from the opportunity and that
         * action rather than from anything the caller sent, so a retry after a
         * lost response records the same thing once. Omitting them is allowed
         * and advances the piece only when an action is already on the record,
         * which is how a resumed transition works without inventing evidence.
         */
        const performed = optionalString(body['action'], 'action');
        const detail = optionalString(body['detail'], 'detail');
        const { value, message } = taken(
          await beginExecution({
            opportunityId: opportunity.id,
            actorRef: principal.id,
            ...(performed && detail
              ? {
                  firstAction: {
                    action: performed,
                    performedBy: 'PERSON' as const,
                    detail,
                    reference: optionalString(body['reference'], 'reference') ?? null,
                    requestKey: actionKey(
                      opportunity.id,
                      performed,
                      optionalString(body['occurrence'], 'occurrence') ?? 'first',
                    ),
                  },
                }
              : {}),
          }),
        );
        return { opportunity: value, message };
      }
      case 'deliver':
      case 'collect': {
        const { value, message } = taken(
          await advance({
            opportunityId: opportunity.id,
            to: action === 'deliver' ? 'DELIVERING' : 'COLLECTED',
            actorRef: principal.id,
            outcome: optionalString(body['outcome'], 'outcome') ?? null,
          }),
        );
        return { opportunity: value, message };
      }
      case 'decline': {
        const { value, message } = taken(
          await decline({
            opportunityId: opportunity.id,
            actorUserId: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      case 'reoffer': {
        // Both ends are authorized: the source through `requireOpportunity`
        // above, the destination here. A person who may read one operation may
        // not push work into another they have no part in.
        const toProject = await requireProject(requiredString(body['toProjectId'], 'toProjectId'));
        const destination = await getCashMode(toProject.id);
        if (!destination) {
          throw unprocessable('That operation is not running Cash Mode, so it takes no openings.');
        }
        const { value, message } = taken(
          await reoffer({
            opportunityId: opportunity.id,
            toProjectId: toProject.id,
            toOwnerUserId: destination.ownerUserId,
            actorUserId: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      case 'exhaust': {
        const { value, message } = taken(
          await exhaust({
            opportunityId: opportunity.id,
            actorRef: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      case 'archive': {
        const { value, message } = taken(
          await archiveOpportunity({
            opportunityId: opportunity.id,
            actorRef: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      default:
        throw notFound('No such route.');
    }
  }),
);

/* --------------------------------------------------------------------------
 * Money
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/money',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const kind = requiredString(body['kind'], 'kind');
    if (!(CASH_MONEY_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`"kind" must be one of: ${CASH_MONEY_KINDS.join(', ')}.`);
    }
    const amountCents = optionalInteger(body['amountCents'], 'amountCents', { min: 1 });
    if (amountCents === undefined) throw badRequest('"amountCents" is required.');

    const mode = await getCashMode(project.id);
    if (!mode) throw unprocessable('Cash Mode has not been activated for this project.');

    /*
     * The sprint decides, and a caller who said otherwise is told.
     *
     * The currency was pinned to the mode and the body's was *ignored*, which
     * is right about who decides and wrong about what a caller is owed: a
     * request stating USD against a euro sprint was accepted and recorded as
     * euros, so the reply said success about a figure that meant something
     * else. §20 settles this shape for idempotency keys — a key in the query
     * is refused rather than ignored, because ignoring it leaves the caller
     * believing they have a property they do not — and it is the same rule
     * here with money on the other side of it.
     */
    const stated = optionalString(body['currency'], 'currency');
    if (stated && stated !== mode.currency) {
      throw unprocessable(
        `This sprint keeps its money in ${mode.currency} and this entry says ${stated}. Brain ` +
          'does not choose an exchange rate, and a figure that added the two would be a number ' +
          'nobody can use wearing a label that says it was checked.',
      );
    }

    const { value, message } = taken(
      await recordMoneyEvent({
        projectId: project.id,
        opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
        kind: kind as CashMoneyKind,
        amountCents,
        // The sprint's, never the caller's: a request that could choose the
        // currency could put a figure into a total that is labelled in another.
        currency: mode.currency,
        verifiedReference: optionalString(body['verifiedReference'], 'verifiedReference') ?? null,
        fundsAvailableAt: optionalString(body['fundsAvailableAt'], 'fundsAvailableAt') ?? null,
        occurredAt: optionalString(body['occurredAt'], 'occurredAt'),
        note: optionalString(body['note'], 'note') ?? null,
        idempotencyKey: requiredString(body['idempotencyKey'], 'idempotencyKey'),
        actorRef: principal.id,
      }),
    );
    return { entry: value, message };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/commitments',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const amountCents = optionalInteger(body['amountCents'], 'amountCents', { min: 1 });
    if (amountCents === undefined) throw badRequest('"amountCents" is required.');

    const { value, message } = taken(
      await commitSpend({
        projectId: project.id,
        opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
        action: requiredString(body['action'], 'action'),
        amountCents,
        purpose: requiredString(body['purpose'], 'purpose'),
        expectedResult: requiredString(body['expectedResult'], 'expectedResult'),
        stopCondition: requiredString(body['stopCondition'], 'stopCondition'),
        // The key is the caller's, and it names *this* decision. It never
        // reaches the scope: which project and which grant a commitment lands
        // against come from the authenticated request, so a key is not a way to
        // spend somebody else's ceiling.
        idempotencyKey: requiredString(body['idempotencyKey'], 'idempotencyKey'),
        actorRef: principal.id,
      }),
    );
    return { commitment: value, message };
  }),
);

/**
 * A commitment is finished: the spend happened, or it is not going to.
 *
 * Both are a person's statement about the world. Nothing here frees a hold on a
 * timer — §20's rule that a timeout is not evidence, at the one table where
 * being wrong hands back money that may already have gone.
 */
cashRouter.post(
  '/cash/commitments/:commitmentId/:action',
  handler(async (req) => {
    const principal = requirePerson();
    const commitment = await resolveInProject(
      await getCommitment(pathId(req, 'commitmentId')),
      'No commitment with that id.',
    );
    const action = pathId(req, 'action');

    if (action === 'settle') {
      /*
       * What was actually spent, required rather than assumed.
       *
       * Settling used to take no amount and write no cost, which made
       * deployable cash *rise* when money left the account. The spend is the
       * fact; the hold was only ever a reservation against it.
       */
      const spentCents = optionalInteger(bodyOf(req)['spentCents'], 'spentCents', { min: 0 });
      if (spentCents === undefined) {
        throw badRequest(
          '"spentCents" is required: settling a hold records what the money actually bought. ' +
            'Pass 0 and the hold is released instead, which "release" says more plainly.',
        );
      }
      const { value, message } = taken(
        await settleSpend({
          commitmentId: commitment.id,
          spentCents,
          actorRef: principal.id,
          note: optionalString(bodyOf(req)['note'], 'note') ?? null,
        }),
      );
      return { commitment: value, settled: true, message };
    }
    if (action === 'release') {
      const reason = requiredString(bodyOf(req)['reason'], 'reason');
      if (!(await releaseCommitment({ commitmentId: commitment.id, reason }))) {
        throw conflict(`That commitment is already ${commitment.state.toLowerCase()}.`);
      }
      await recordCashEvent({
        projectId: commitment.projectId,
        opportunityId: commitment.opportunityId,
        kind: 'CASH_COMMITMENT_RELEASED',
        actorRef: principal.id,
        summary: 'A commitment was released without being spent.',
        detail: { commitmentId: commitment.id, reason },
      });
      return { released: true, message: 'Released. Nothing was spent.' };
    }
    throw notFound('No such route.');
  }),
);

/* --------------------------------------------------------------------------
 * Needs
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/needs',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const { value, message } = taken(
      await raiseNeed({
        projectId: project.id,
        opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
        actorRef: principal.id,
        blockedAction: requiredString(body['blockedAction'], 'blockedAction'),
        whyItMatters: requiredString(body['whyItMatters'], 'whyItMatters'),
        recommendedPath: requiredString(body['recommendedPath'], 'recommendedPath'),
        expectedCostCents:
          optionalNumber(body['expectedCostCents'], 'expectedCostCents', { min: 0 }) ?? null,
        setupEffort: requiredString(body['setupEffort'], 'setupEffort'),
        nextStep: requiredString(body['nextStep'], 'nextStep'),
        completionCondition: requiredString(body['completionCondition'], 'completionCondition'),
      }),
    );
    return { need: value, message };
  }),
);

cashRouter.post(
  '/cash/needs/:needId/close',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const to = optionalString(body['to'], 'to') ?? 'RESOLVED';
    if (to !== 'RESOLVED' && to !== 'WITHDRAWN') {
      throw badRequest('"to" is RESOLVED or WITHDRAWN.');
    }
    // Resolved through the need's own project, so a guessed id and one
    // belonging to somebody else are refused with the same body.
    const need = await resolveInProject(
      await getNeed(pathId(req, 'needId')),
      'No need with that id.',
    );
    /*
     * A person does not resolve a need, because every need is Brain's own.
     *
     * Both callers of `raiseNeed` pass `actorRef: BRAIN`: one for an
     * integration Brain does not have, one for a `BRAIN_RESEARCH` field whose
     * own recorded reason says Brain looks it up rather than asking. So a
     * person answering *"what did you do"* here was attesting to work they had
     * not done, and `closeNeed` recorded it as `PERSON_SUBSTITUTE` — a
     * Brain-owned requirement marked satisfied on a sentence.
     *
     * Removing the form was not enough by itself: a control nothing renders is
     * still reachable by anything that can post, and the rule is about what may
     * be recorded rather than about what is drawn. Brain still resolves them
     * from rows — `reconcileCapabilityNeeds` closes one the moment its
     * capability reads `PRESENT`, having checked rather than been told — and
     * that path does not come through here.
     *
     * `WITHDRAWN` stays open to a person: saying a thing is no longer required
     * is a decision about what to want, not a claim about what happened.
     *
     * **After the need is resolved, not before, and the parity test caught
     * that.** Refusing first answered `400` for an id nobody owns while a
     * missing one still answered `404` — so the pair told a caller which
     * ids exist, which is invariant 23's oracle arriving through a guard
     * written to close a different hole. A guessed id and an invented one
     * are still one answer; this refusal is only ever reached by somebody
     * who could already read the need.
     */
    if (to === 'RESOLVED') {
      throw badRequest(
        'A need is resolved by Brain, from the rows its capability is made of, rather than by ' +
          'a person saying it is done. If an integration or connection is what is missing, the ' +
          'named action for it is on People & capacity. Withdrawing a need that is no longer ' +
          'required is still yours.',
      );
    }

    const { value, message } = taken(
      await closeNeed({
        needId: need.id,
        to,
        resolution: requiredString(body['resolution'], 'resolution'),
        actorUserId: principal.id,
        /*
         * What is being done instead, when the condition does not hold.
         *
         * Without one, a resolution whose completion condition fails is
         * refused: a written explanation is not a working integration, and
         * the piece it was blocking would go straight back to waiting on
         * something that had not happened. With one, Brain records
         * `PERSON_SUBSTITUTE` — a different fact, which reads as one.
         */
        substitute: optionalString(body['substitute'], 'substitute') ?? null,
      }),
    );
    return { need: value, message };
  }),
);
