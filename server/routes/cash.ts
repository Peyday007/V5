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
import { getNode } from '../repos/industry.ts';
import { seedSubject, retireSubject } from '../services/industry/seed.ts';
import { industryView } from '../services/industry/view.ts';
import { isIndustryNodeKind } from '../domain/industry.ts';
import { getDeal } from '../repos/dealflow.ts';
import { observe, retire, seedParty } from '../services/dealflow/seed.ts';
import { dealDetail, dealflowView } from '../services/dealflow/view.ts';
import { isDealObservationKind, isDealPartyKind } from '../domain/dealflow.ts';
import { getPuzzleInstance, getPuzzleProduct } from '../repos/puzzle.ts';
import { defineMaster, observe as observePuzzle, retireFormat, seedFormat } from '../services/puzzle/seed.ts';
import { puzzleView } from '../services/puzzle/view.ts';
import { renderInstance } from '../services/puzzle/generate.ts';
import { formatFor } from '../services/puzzle/formats/index.ts';
import { isPuzzleDifficulty, isPuzzleObservationKind } from '../domain/puzzle.ts';
import { PUZZLE_DIFFICULTIES, PUZZLE_OBSERVATION_KINDS } from '../domain/types.ts';
import { DEAL_OBSERVATION_KINDS, DEAL_PARTY_KINDS } from '../domain/types.ts';
import { INDUSTRY_NODE_KINDS, type IndustryNodeKind } from '../domain/types.ts';
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
  contentOccurrence,
  decline,
  exhaust,
  fillCard,
  markReady,
  recordMoneyEvent,
  reoffer,
  settleSpend,
} from '../services/cash/opportunities.ts';
import { recordFurtherAction } from '../services/cash/actions.ts';
import { closeNeed, raiseNeed } from '../services/cash/needs.ts';
import { cashView } from '../services/cash/view.ts';
import { cashCapabilities, decideCashRead } from '../services/cash/access.ts';
import { sharedCashView } from '../services/cash/shared.ts';
import {
  CANONICAL_CASH_OBJECTIVE,
  CANONICAL_CASH_SUMMARY,
  findCashRoot,
  objectiveWith,
  resolveOrCreateCashRoot,
} from '../services/cash/root.ts';
import { recordCashEvent } from '../repos/cashMode.ts';
import { composeLedger, rankableOf } from '../services/cash/monetization/ledger.ts';
import {
  composeSurface,
  conditionsToEnterTop,
  filterLedger,
  type LedgerQuery,
} from '../services/cash/monetization/surface.ts';
import { explainRanking } from '../services/cash/monetization/rank.ts';
import { criteriaInOrder } from '../services/cash/monetization/movement.ts';
import {
  judgePath,
  linkPaths,
  mergePaths,
  seedPath,
  splitPath,
  unmergePath,
} from '../services/cash/monetization/decisions.ts';
import {
  commissionsFor,
  getPath,
  judgmentsFor,
  listEdges,
  pathFactsFor,
  snapshotsFor,
} from '../repos/monetization.ts';
import {
  isMonetizationEdgeKind,
  isMonetizationMethod,
  isPathJudgment,
  METHOD,
} from '../domain/monetization.ts';
import {
  MONETIZATION_EDGE_KINDS,
  MONETIZATION_METHODS,
  MONETIZATION_STATUSES,
  PATH_JUDGMENTS,
  type MonetizationMethod,
  type MonetizationStatus,
} from '../domain/types.ts';
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
      return {
        ...(await sharedCashView({ projectId })),
        capabilities: cashCapabilities({ scope: 'SHARED', projectId }),
      };
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
      /*
       * What may be *offered*, decided by the same `decideProjectAccess` this
       * route already ran. The client holds only a Brain-administrator flag,
       * and these three decisions are project `ADMIN` — so a client deriving
       * them would hide a lifecycle control from the project administrator
       * entitled to press it.
       */
      capabilities: cashCapabilities({ scope: 'FULL', projectId: project.id }),
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
        const reference = optionalString(body['reference'], 'reference') ?? null;
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
                    reference,
                    /*
                     * Derived from what was actually typed, never from a
                     * caller-supplied counter. See `contentOccurrence`: a
                     * confirm that sends the same detail and reference again
                     * reaches this same row, and one that describes something
                     * different does not.
                     */
                    requestKey: actionKey(
                      opportunity.id,
                      performed,
                      contentOccurrence(detail, reference),
                    ),
                  },
                }
              : {}),
          }),
        );
        return { opportunity: value, message };
      }
      case 'record-action': {
        /*
         * Everything a person does after execution has begun and before the
         * money is collected: a quote, an invoice, a payment accepted. Unlike
         * `execute`, there is no continuation shape here — this route exists
         * only to record something, so the action and the detail are both
         * required, and nothing about the opportunity's state moves.
         */
        const performed = requiredString(body['action'], 'action');
        const detail = requiredString(body['detail'], 'detail');
        const reference = optionalString(body['reference'], 'reference') ?? null;
        const { value, message } = taken(
          await recordFurtherAction({
            opportunityId: opportunity.id,
            actorRef: principal.id,
            action: performed,
            performedBy: 'PERSON' as const,
            detail,
            reference,
            /*
             * Derived from what was actually typed rather than a caller-
             * supplied counter — see `contentOccurrence`. This is the fix for
             * the finding that the record-action control hardcoded a literal
             * `'first'` on every confirm: a genuine second occurrence (a
             * second invoice, a different reference) now produces a different
             * key instead of silently deduping against the first one, while an
             * exact resubmission of the same detail and reference still
             * reaches the same row.
             */
            requestKey: actionKey(opportunity.id, performed, contentOccurrence(detail, reference)),
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

/* --------------------------------------------------------------------------
 * The industry map
 *
 * Reading it is any project member's: where Brain is looking, what it has
 * established, what it would ask next and why. Seeding a subject and retiring
 * one are ADMIN plus `requirePerson`, the same pair the commercial authority
 * carries — and for a related reason. `SEED` is the one node origin Brain
 * itself cannot write, because the schema requires every other origin to carry
 * the claim that established it; a machine that could name its own subjects
 * would be choosing what the economy is, which is §22's split at the table
 * that decides where everything else looks.
 *
 * Seeding spends nothing and starts nothing. It creates a row; the allocator
 * decides when the subject is asked about, the discovery grant decides whether
 * that may run, and the evidence gate decides what may be claimed.
 * ------------------------------------------------------------------------ */

cashRouter.get(
  '/projects/:projectId/cash/industries',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return industryView(project.id);
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/industries',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const name = requiredString(body['name'], 'name');
    const kindRaw = optionalString(body['kind'], 'kind');
    if (kindRaw && !isIndustryNodeKind(kindRaw)) {
      // An unknown field refuses the whole thing rather than being dropped:
      // `proposal.ts`'s rule, at the table that decides where Brain looks.
      throw badRequest(
        `"${kindRaw}" is not a kind of subject this map holds. The set is fixed in code: ` +
          `${INDUSTRY_NODE_KINDS.join(', ')}.`,
      );
    }

    const parentId = optionalString(body['parentId'], 'parentId') ?? null;
    if (parentId) {
      const parent = await getNode(parentId);
      if (!parent || parent.projectId !== project.id) {
        // The same 404 a subject that never existed gives, because a parent id
        // in somebody else's operation must not be distinguishable from an
        // invented one — invariant 23, at a foreign key.
        throw notFound('No subject with that id.');
      }
    }

    const result = await seedSubject({
      projectId: project.id,
      name,
      kind: kindRaw ? (kindRaw as IndustryNodeKind) : undefined,
      description: optionalString(body['description'], 'description') ?? null,
      parentId,
      actorRef: principal.id,
      reason: optionalString(body['reason'], 'reason') ?? null,
    });

    return {
      subject: result.node,
      created: result.created,
      message: result.created
        ? `${result.node.name} is on the map. Brain decides when to ask about it; nothing has ` +
          'been spent and no research has started.'
        : `${result.node.name} was already on the map, so nothing changed. How Brain came to ` +
          'know about it is history, and naming it again does not rewrite that.',
    };
  }),
);

cashRouter.patch(
  '/projects/:projectId/cash/industries/:nodeId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const node = await retireSubject({
      projectId: project.id,
      nodeId: pathId(req, 'nodeId'),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if (!node) throw notFound('No subject with that id.');

    return {
      subject: node,
      message:
        'Brain stops offering it and reads it as a dead end with your reason. Nothing was ' +
        'destroyed: its evidence, its children and every round ever run against it are ' +
        'exactly where they were, which is what stops it arriving again as a fresh discovery.',
    };
  }),
);

/* --------------------------------------------------------------------------
 * The cross-border industrial dealflow kernel
 *
 * Reading it is any project member's: both sides of the map, every deal and
 * how far it has got, what the kernel is asking and what it would ask next.
 * Seeding a party, retiring one and recording what an attempt taught are
 * ADMIN plus `requirePerson`, the same pair the industry map and the
 * commercial authority both carry — and for the industry map's reason. `SEED`
 * is the one party origin Brain itself cannot write, because the schema
 * requires every other origin to carry the claim that established it; a
 * machine that could name its own counterparties would be deciding who the
 * market is.
 *
 * The level is not asked for here. It comes from `services/identity/policy.ts`
 * like every other route's, because §17 is explicit: do not write a role check
 * into a route handler, add to the policy instead. A worker principal is
 * refused at these by level, at the reads by `requirePerson`, and at all of
 * them by principal type.
 *
 * Seeding spends nothing and starts nothing. It creates a row; the allocator
 * decides when that party is asked about, the discovery grant decides whether
 * that may run, and the evidence gate decides what may be claimed.
 *
 * Nothing on this surface contacts anybody, quotes anybody or commits
 * anything. Acting on a deal is a recorded commercial action under the
 * standing grant, on the routes that already exist for it.
 * ------------------------------------------------------------------------ */

cashRouter.get(
  '/projects/:projectId/cash/dealflow',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return dealflowView(project.id);
  }),
);

cashRouter.get(
  '/projects/:projectId/cash/dealflow/:dealId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const detail = await dealDetail({ projectId: project.id, dealId: pathId(req, 'dealId') });
    // The same 404 a deal that never existed gives, because a deal id in
    // somebody else's operation must not be distinguishable from an invented
    // one — invariant 23, at a foreign key.
    if (!detail) throw notFound('No deal with that id.');
    return detail;
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/dealflow/parties',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const kindRaw = requiredString(body['kind'], 'kind');
    if (!isDealPartyKind(kindRaw)) {
      // An unknown field refuses the whole thing rather than being dropped:
      // `proposal.ts`'s rule, at the table that decides who the market is.
      throw badRequest(
        `"${kindRaw}" is not a side of a transaction. The set is fixed in code: ` +
          `${DEAL_PARTY_KINDS.join(', ')}.`,
      );
    }

    const result = await seedParty({
      projectId: project.id,
      actorRef: principal.id,
      kind: kindRaw,
      name: requiredString(body['name'], 'name'),
      country: optionalString(body['country'], 'country') ?? null,
      equipmentClass: requiredString(body['equipmentClass'], 'equipmentClass'),
      note: optionalString(body['note'], 'note') ?? null,
    });

    return {
      party: result.party,
      created: result.created,
      message: result.created
        ? `${result.party.name} is on the map. Brain decides when to ask about them; nothing ` +
          'has been spent, no research has started and nobody has been contacted.'
        : `${result.party.name} was already on the map for this class, so nothing changed. ` +
          'How Brain came to know about them is history, and naming them again does not ' +
          'rewrite it.',
    };
  }),
);

cashRouter.patch(
  '/projects/:projectId/cash/dealflow/parties/:partyId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const party = await retire({
      projectId: project.id,
      actorRef: principal.id,
      partyId: pathId(req, 'partyId'),
      reason: requiredString(body['reason'], 'reason'),
    });
    if (!party) throw notFound('No party with that id.');

    return {
      party,
      message:
        'Brain stops offering them and reads them as a dead end with your reason. Nothing was ' +
        'destroyed: their evidence, their deals and every round ever run about them are ' +
        'exactly where they were, which is what stops them arriving again as a fresh ' +
        'discovery.',
    };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/dealflow/observations',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const kindRaw = requiredString(body['kind'], 'kind');
    if (!isDealObservationKind(kindRaw)) {
      throw badRequest(
        `"${kindRaw}" is not a kind of outcome this kernel records. The set is fixed in ` +
          `code: ${DEAL_OBSERVATION_KINDS.join(', ')}.`,
      );
    }

    const dealId = optionalString(body['dealId'], 'dealId') ?? null;
    if (dealId) {
      const deal = await getDeal(dealId);
      if (!deal || deal.projectId !== project.id) throw notFound('No deal with that id.');
    }

    const observation = await observe({
      projectId: project.id,
      actorRef: principal.id,
      dealId,
      kind: kindRaw,
      jurisdiction: optionalString(body['jurisdiction'], 'jurisdiction') ?? null,
      equipmentClass: optionalString(body['equipmentClass'], 'equipmentClass') ?? null,
      statement: requiredString(body['statement'], 'statement'),
    });

    return {
      observation,
      message:
        'Recorded as one observation. Whether several of these amount to a rule is derived ' +
        'when somebody reads them, with the sample size printed beside it — Brain does not ' +
        'store a generalization, because a stored rule is one nobody can see the sample ' +
        'behind. It gates nothing: no deal is refused and no question is skipped because of ' +
        'it.',
    };
  }),
);

/* --------------------------------------------------------------------------
 * The puzzle products and production kernel
 *
 * Reading is any project member's, the same as every other kernel here.
 * Writing is four things and every one of them is a decision no research can
 * make: naming a kind of puzzle, setting up a system to generate it, recording
 * what actually happened when something was attempted, and turning a
 * monetization route down.
 *
 * Nothing on this surface contacts anybody, submits anything, lists anything
 * or commits anything. Acting on a product is a recorded commercial action
 * under the standing grant, on the routes that already exist for it — and
 * `requirePerson` refuses a worker principal at every one of these by type,
 * because a machine that could set up its own puzzle systems and then record
 * that they sold would be writing its own evidence.
 * ------------------------------------------------------------------------ */

cashRouter.get(
  '/projects/:projectId/cash/puzzles',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return puzzleView(project.id);
  }),
);

cashRouter.get(
  '/projects/:projectId/cash/puzzles/instances/:instanceId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const instance = await getPuzzleInstance(pathId(req, 'instanceId'));
    // The same 404 a puzzle that never existed gives, because an id in
    // somebody else's operation must not be distinguishable from an invented
    // one — invariant 23, at a foreign key.
    if (!instance || instance.projectId !== project.id) {
      throw notFound('No puzzle with that id.');
    }

    /*
     * Rendered rather than read back, which is the whole of "the
     * specification is the storage": the grid, the solution and the answer key
     * are produced together from the master and the seed every time they are
     * wanted, so there is no copy of any of them for a later change to make
     * disagree with the other two.
     *
     * `reproduced` is the check that says so. A false there means the
     * generator has changed underneath a stored row, which is exactly what
     * `generator_version` exists to prevent and exactly what somebody needs to
     * be told if it happens anyway.
     */
    const rendered = await renderInstance(instance);
    if ('error' in rendered) {
      return {
        instance,
        artifact: null,
        reproduced: false,
        message: `This puzzle could not be re-rendered: ${rendered.error}`,
      };
    }
    return {
      instance,
      artifact: rendered.artifact,
      reproduced: rendered.reproduced,
      message: rendered.reproduced
        ? 'Rendered from its specification, and it hashes to what was recorded when it was ' +
          'validated.'
        : 'Rendered from its specification, and it does NOT hash to what was recorded. The ' +
          'generator has changed underneath this row, so what is shown is not what was ' +
          'checked. A repair is a new generator version and a new system, never an edit here.',
    };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/puzzles/formats',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const result = await seedFormat({
      projectId: project.id,
      actorRef: principal.id,
      name: requiredString(body['name'], 'name'),
      note: optionalString(body['note'], 'note') ?? null,
    });

    const implementation = formatFor(result.format.formatKey);
    return {
      format: result.format,
      created: result.created,
      /*
       * Whether this repository can actually make one, said at the moment it
       * is named rather than discovered when nothing ever gets generated.
       */
      generates: implementation?.render != null,
      validates: implementation != null,
      message: result.created
        ? `${result.format.name} is on the map. ` +
          (implementation?.render
            ? 'Brain can generate and check this one, so a system for it is set up on the next ' +
              'tick and nothing further is needed from you.'
            : implementation
              ? 'Brain can check this one and cannot write one: its content is editorial work ' +
                'with no correctness criterion, so there is a validator and deliberately no ' +
                'generator.'
              : 'Nothing here generates or checks it yet, so Brain will research who buys it ' +
                'and leave the making to a code change somebody reviews. That is the honest ' +
                'order: whether a generator is worth writing depends on whether anybody pays ' +
                'for the output.')
        : `${result.format.name} was already on the map, so nothing changed. How Brain came to ` +
          'know about it is history, and naming it again does not rewrite it.',
    };
  }),
);

cashRouter.patch(
  '/projects/:projectId/cash/puzzles/formats/:formatId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const format = await retireFormat({
      projectId: project.id,
      actorRef: principal.id,
      formatId: pathId(req, 'formatId'),
      reason: requiredString(body['reason'], 'reason'),
    });
    if (!format) throw notFound('No format with that id.');

    return {
      format,
      message:
        'Brain stops asking about it and reads it as a dead end with your reason. Nothing was ' +
        'destroyed: its systems, every puzzle they made, every product compiled from them and ' +
        'every round ever run about it are exactly where they were, which is what stops it ' +
        'arriving again as a fresh discovery.',
    };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/puzzles/systems',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const difficultyRaw = optionalString(body['difficulty'], 'difficulty') ?? 'MEDIUM';
    if (!isPuzzleDifficulty(difficultyRaw)) {
      throw badRequest(
        `"${difficultyRaw}" is not a difficulty band. The set is fixed in code: ` +
          `${PUZZLE_DIFFICULTIES.join(', ')}.`,
      );
    }

    /*
     * The parameters travel as given and each format refuses the ones it does
     * not implement. A parameter nobody implements is a refusal rather than a
     * field silently ignored, because a silently ignored one produces a system
     * that makes something nobody asked for.
     */
    const parameters: Record<string, string | number> = {};
    const raw = body['parameters'];
    if (raw !== undefined) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw badRequest('"parameters" must be an object of names to values.');
      }
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw badRequest(`parameters.${key} must be a string or a number.`);
        }
        parameters[key] = value;
      }
    }

    const result = await defineMaster({
      projectId: project.id,
      actorRef: principal.id,
      title: requiredString(body['title'], 'title'),
      formatName: requiredString(body['format'], 'format'),
      corpusId: requiredString(body['corpusId'], 'corpusId'),
      difficulty: difficultyRaw,
      parameters,
    });
    if ('refused' in result) throw unprocessable(result.refused);

    return {
      master: result.master,
      message:
        `${result.master.title} is set up. Puzzles are made on the tick, and every one of them ` +
        'is checked from its printed form before it is recorded — nothing that fails is ' +
        'stored as usable, and a batch whose failures cross a third stops rather than drawing ' +
        'seeds until enough happen to pass.',
    };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/puzzles/observations',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const kindRaw = requiredString(body['kind'], 'kind');
    if (!isPuzzleObservationKind(kindRaw)) {
      throw badRequest(
        `"${kindRaw}" is not a kind of outcome this kernel records. The set is fixed in ` +
          `code: ${PUZZLE_OBSERVATION_KINDS.join(', ')}.`,
      );
    }

    const productId = optionalString(body['productId'], 'productId') ?? null;
    if (productId) {
      const product = await getPuzzleProduct(productId);
      if (!product || product.projectId !== project.id) {
        throw notFound('No product with that id.');
      }
    }

    const result = await observePuzzle({
      projectId: project.id,
      actorRef: principal.id,
      kind: kindRaw,
      formatName: optionalString(body['format'], 'format') ?? null,
      productId,
      monetizationRoute: optionalString(body['route'], 'route') ?? null,
      statement: requiredString(body['statement'], 'statement'),
    });
    if ('refused' in result) throw unprocessable(result.refused);

    return {
      observation: result.observation,
      message:
        kindRaw === 'HUMAN_EDIT_PASSED'
          ? 'Recorded. This is the one thing that can move a format to SELLABLE: there is no ' +
            'flag anywhere that stands in for a person having read what the machine made.'
          : kindRaw === 'ROUTE_REJECTED'
            ? 'Recorded. The route stays in the ledger with your reason rather than ' +
              'disappearing, which is what stops it being proposed again next week.'
            : 'Recorded as one observation. Whether several amount to a rule is derived when ' +
              'somebody reads them, with the sample size printed beside it — Brain stores no ' +
              'generalization, because a stored rule is one nobody can see the sample behind. ' +
              'It gates nothing: no product is refused and no question is skipped because of it.',
    };
  }),
);

/* --------------------------------------------------------------------------
 * The monetization possibility ledger
 *
 * Reading it is any project member's, through the same `decideCashRead` seam
 * the section itself uses: the possibility space of a discovery is *discovery*,
 * so a member reads it in names and counts on the shared frontier, and the
 * owner reads it with the figures on. There is no separate read route for the
 * space — it travels with the section, so the two can never disagree about it.
 *
 * What is here is what a page cannot carry: the two comparisons a person asks
 * for by name, and the four decisions only a person makes. Every one of the
 * four is `requirePerson` plus `requireProject`, and a worker is refused by
 * type at all of them — §22's rule at the table that decides what is worth
 * doing, where a machine that could invalidate a possibility could quietly
 * narrow the space nobody else is looking at.
 * ------------------------------------------------------------------------ */

/**
 * Why is this one below that one, and what would move it.
 *
 * Both answers come from the same lexicographic order the page ranks on, so
 * there is no second opinion here: the first criterion two paths differ on
 * **is** why one is above the other, and the chain of criteria a path is behind
 * on is the whole of what would have to become true.
 *
 * It reads and writes nothing.
 */
cashRouter.get(
  '/projects/:projectId/cash/monetization/compare',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const ledger = await composeLedger({ projectId: project.id });

    const a = optionalString(req.query['a'], 'a');
    const b = optionalString(req.query['b'], 'b');
    if (!a) throw badRequest('Name the possibility to explain, as "a".');

    const left = ledger.entries.find((one) => one.path.id === a);
    if (!left) throw notFound('No possibility with that id.');

    if (b) {
      const right = ledger.entries.find((one) => one.path.id === b);
      if (!right) throw notFound('No possibility with that id.');
      return {
        criteria: criteriaInOrder(),
        comparison: explainRanking(rankableOf(left), rankableOf(right)),
      };
    }

    return {
      criteria: criteriaInOrder(),
      toEnterTop: conditionsToEnterTop(ledger, left.path.id),
    };
  }),
);

/**
 * The operator's own questions, answered from the retained ledger.
 *
 * "Everything under five thousand", "everything that could pay inside a week",
 * "everything discovered this week", "everything that moved today". Each one
 * reads rows that are already there rather than reconstructing a possibility
 * space nobody kept, which is what the brief means by answering from retained
 * state.
 *
 * **An unknown never passes a bound.** A path with no established capital
 * requirement is not in the answer to *under five thousand*, because it is not
 * known to be under five thousand — the favourable assumption would put an
 * uncosted possibility in front of somebody who asked for cheap ones.
 */
cashRouter.get(
  '/projects/:projectId/cash/monetization',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const ledger = await composeLedger({ projectId: project.id });

    const statuses = optionalStringArray(req.query['status'], 'status');
    for (const one of statuses ?? []) {
      if (!(MONETIZATION_STATUSES as readonly string[]).includes(one)) {
        throw badRequest(`"status" must be one of: ${MONETIZATION_STATUSES.join(', ')}.`);
      }
    }
    const methods = optionalStringArray(req.query['method'], 'method');
    for (const one of methods ?? []) {
      if (!isMonetizationMethod(one)) {
        throw badRequest('That is not a monetization method this Brain has a word for.');
      }
    }

    const query: LedgerQuery = {
      maxCapitalCents: optionalInteger(req.query['maxCapitalCents'], 'maxCapitalCents', { min: 0 }),
      maxDaysToCash: optionalInteger(req.query['maxDaysToCash'], 'maxDaysToCash', { min: 0 }),
      discoveredSince: optionalString(req.query['discoveredSince'], 'discoveredSince'),
      movedSince: optionalString(req.query['movedSince'], 'movedSince'),
      statuses: statuses as MonetizationStatus[] | undefined,
      methods: methods as MonetizationMethod[] | undefined,
      subjectId: optionalString(req.query['subjectId'], 'subjectId'),
    };

    const matched = filterLedger(ledger.entries, query);
    return {
      /*
       * The surface is composed over the **whole** ledger and the filter is
       * reported beside it, rather than the five being recomputed over the
       * matches. "Show me everything under five thousand" is a question about
       * the space; it is not an instruction to re-rank the world as though the
       * rest of it did not exist, and a top five computed over a filtered
       * ledger would quietly mean something different on every request.
       */
      surface: composeSurface({ ledger }),
      filter: { query, matchedPathIds: matched.map((one) => one.path.id) },
      vocabulary: {
        methods: MONETIZATION_METHODS.map((method) => ({
          id: method,
          label: METHOD[method].label,
          what: METHOD[method].what,
        })),
        statuses: MONETIZATION_STATUSES,
        judgments: PATH_JUDGMENTS,
        criteria: criteriaInOrder(),
      },
    };
  }),
);

/** One possibility, with its whole movement history. */
cashRouter.get(
  '/cash/monetization/paths/:pathId',
  handler(async (req) => {
    requirePerson();
    const path = await resolveInProject(
      await getPath(pathId(req, 'pathId')),
      'No possibility with that id.',
    );
    const ledger = await composeLedger({ projectId: path.projectId });
    const entry = ledger.entries.find((one) => one.path.id === path.id);
    if (!entry) throw notFound('No possibility with that id.');
    return {
      entry,
      /** Every position it has held, oldest first. Nothing is ever removed. */
      history: await snapshotsFor(path.id),
      toEnterTop: conditionsToEnterTop(ledger, path.id),
      /*
       * Everything about this possibility that the ledger derives and the list
       * has no room for.
       *
       * An audit of the shipped ledger found each of these written and read by
       * nobody — `origin`, `source_claim_id`, `split_from_id`,
       * `last_evaluated_at`, a fact's `basis`, `assumptions` and `uncertainty`,
       * a judgement's actor and channel, a snapshot's `criterion`, and every
       * asking Brain has ever made about it. §22 is explicit that
       * simplification happens by **presentation** rather than by information
       * destruction, and a column nothing can read is destruction with extra
       * steps. This is where the presentation puts them.
       */
      provenance: {
        origin: path.origin,
        sourceClaimId: path.sourceClaimId,
        splitFromId: path.splitFromId,
        mergedIntoId: path.mergedIntoId,
        lastEvaluatedAt: path.lastEvaluatedAt,
      },
      /** Every recorded answer with where it came from and what it rests on. */
      facts: await pathFactsFor(path.id),
      /** Every judgement anybody recorded, oldest first. Never deleted. */
      judgments: await judgmentsFor(path.id),
      /*
       * And every relation somebody recorded about it, with whose statement it
       * is.
       *
       * `entry.edges` is the derived graph plus the recorded rows flattened
       * together, and `risksFor` reads it for its sentences — so a recorded
       * edge's `decided_by_id` was written from the authenticated principal by
       * a live route and read by nothing at all, which is the same audit
       * finding as the judgement's channel one table along. A relation a
       * person recorded is a statement about this situation rather than about
       * shapes of transaction (§21's `source` column), and the person is half
       * of what makes it that. Recorded rows only: a derived edge has no
       * author, and inventing a line saying so would be the opposite mistake.
       */
      relations: (await listEdges(path.projectId))
        .filter((edge) => edge.fromPathId === path.id || edge.toPathId === path.id)
        .map((edge) => ({
          fromPathId: edge.fromPathId,
          toPathId: edge.toPathId,
          kind: edge.kind,
          rationale: edge.rationale,
          source: edge.source,
          sourceClaimId: edge.sourceClaimId,
          decidedById: edge.decidedById,
          createdAt: edge.createdAt,
        })),
      /** Every question Brain has asked about it, and what came of each. */
      questions: await commissionsFor(path.id),
    };
  }),
);

/**
 * Name a possibility the enumeration could not produce.
 *
 * `SEED` is the one origin Brain may never write, so this is the only way one
 * gets into the ledger without a claim behind it. It spends nothing and starts
 * nothing: it writes a row, and every gate downstream still decides.
 */
cashRouter.post(
  '/projects/:projectId/cash/monetization/paths',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const method = requiredString(body['method'], 'method');
    if (!isMonetizationMethod(method)) {
      throw badRequest(
        'That is not a monetization method this Brain has a word for. Adding one is a code ' +
          'change somebody reviews, which is where "is this a distinct way of being paid" gets ' +
          'asked.',
      );
    }

    const outcome = await seedPath({
      projectId: project.id,
      method,
      opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
      industryNodeId: optionalString(body['industryNodeId'], 'industryNodeId') ?? null,
      title: optionalString(body['title'], 'title') ?? null,
      thesis: optionalString(body['thesis'], 'thesis') ?? null,
      seededByUserId: principal.id,
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);

    return {
      path: outcome.value.path,
      message: outcome.value.created
        ? 'It is in the ledger with every question still open, and it ranks where its answers ' +
          'put it.'
        : 'That shape of transaction was already in the ledger for this discovery, so nothing ' +
          'was duplicated.',
    };
  }),
);

/**
 * Record what a person decided about a possibility.
 *
 * Four judgements and not one of them sets a status: `WATCH`, `INVALIDATE` and
 * `ARCHIVE` are the three things no derivation could establish, and `REVIVE` is
 * the answering transition for the last two — because an escalation with no way
 * out is stuck rather than waiting. Everything else about where a path stands
 * is read from rows, so there is no shape of this route that marks something
 * healthy over evidence that says otherwise.
 *
 * The reason is required, and that is not ceremony: a possibility put away with
 * no reason is one nobody can reconsider when the thing that made it wrong
 * stops being true.
 */
cashRouter.post(
  '/cash/monetization/paths/:pathId/judgment',
  handler(async (req) => {
    const principal = requirePerson();
    const path = await resolveInProject(
      await getPath(pathId(req, 'pathId')),
      'No possibility with that id.',
    );
    const body = bodyOf(req);
    const judgment = requiredString(body['judgment'], 'judgment');
    if (!isPathJudgment(judgment)) {
      throw badRequest(`"judgment" is one of: ${PATH_JUDGMENTS.join(', ')}.`);
    }

    const outcome = await judgePath({
      projectId: path.projectId,
      pathId: path.id,
      judgment,
      reason: requiredString(body['reason'], 'reason'),
      decidedByUserId: principal.id,
      /*
       * The stronger channel, asserted only here because only here is it true:
       * this call carries an authenticated browser principal that
       * `requirePerson` resolved from server rows. Everything else defaults to
       * the weaker value, because Brain cannot check a channel and must never
       * assume the stronger one.
       */
      channel: 'BROWSER_SESSION',
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);

    return {
      judgment: outcome.value,
      message:
        judgment === 'REVIVE'
          ? 'It is live again, and the judgement that put it away stays on its record.'
          : 'Recorded. Nothing was deleted: the possibility, its answers and its whole ranking ' +
            'history are exactly where they were, and it comes back the moment somebody revives ' +
            'it.',
    };
  }),
);

/** Say that two possibilities are one, or that one is several. Both reversible. */
cashRouter.post(
  '/cash/monetization/paths/:pathId/lineage',
  handler(async (req) => {
    const principal = requirePerson();
    const path = await resolveInProject(
      await getPath(pathId(req, 'pathId')),
      'No possibility with that id.',
    );
    const body = bodyOf(req);
    const action = requiredString(body['action'], 'action');

    if (action === 'MERGE') {
      const outcome = await mergePaths({
        projectId: path.projectId,
        absorbedId: path.id,
        survivorId: requiredString(body['into'], 'into'),
        reason: requiredString(body['reason'], 'reason'),
        decidedByUserId: principal.id,
      });
      if (!outcome.ok) throw unprocessable(outcome.reason);
      return {
        path: outcome.value.absorbed,
        message:
          'It points at the one that carries it now. Its answers, its judgements and its whole ' +
          'ranking history are untouched, and un-merging it is one field.',
      };
    }

    if (action === 'UNMERGE') {
      const outcome = await unmergePath({
        projectId: path.projectId,
        pathId: path.id,
        decidedByUserId: principal.id,
      });
      if (!outcome.ok) throw unprocessable(outcome.reason);
      return { path: outcome.value, message: 'It is a separate possibility again.' };
    }

    if (action === 'SPLIT') {
      const raw = Array.isArray(body['into']) ? body['into'] : [];
      const into: { method: MonetizationMethod; title?: string | null; thesis?: string | null }[] =
        [];
      for (const one of raw) {
        const shape = (one ?? {}) as Record<string, unknown>;
        const method = requiredString(shape['method'], 'into[].method');
        if (!isMonetizationMethod(method)) {
          throw badRequest('That is not a monetization method this Brain has a word for.');
        }
        into.push({
          method,
          title: optionalString(shape['title'], 'into[].title') ?? null,
          thesis: optionalString(shape['thesis'], 'into[].thesis') ?? null,
        });
      }
      const outcome = await splitPath({
        projectId: path.projectId,
        pathId: path.id,
        into,
        reason: requiredString(body['reason'], 'reason'),
        decidedByUserId: principal.id,
      });
      if (!outcome.ok) throw unprocessable(outcome.reason);
      return {
        paths: outcome.value,
        message:
          'Each one names the possibility it came out of, and the one it came out of is exactly ' +
          'as it was — whether it is still worth pursuing alongside them is a question the ' +
          'ledger answers rather than something this decided for you.',
      };
    }

    if (action === 'LINK') {
      /*
       * The one thing here that can make a possibility blocked by another, and
       * the reason it is a person's: a *derived* requirement is a statement
       * about two methods and blocks nothing, because letting it would put a
       * fresh ledger entirely into a state nobody established. A recorded one
       * is a statement about this situation with somebody behind it.
       */
      const kind = requiredString(body['kind'], 'kind');
      if (!isMonetizationEdgeKind(kind)) {
        throw badRequest(`"kind" is one of: ${MONETIZATION_EDGE_KINDS.join(', ')}.`);
      }
      const outcome = await linkPaths({
        projectId: path.projectId,
        fromPathId: path.id,
        toPathId: requiredString(body['to'], 'to'),
        kind,
        rationale: requiredString(body['rationale'], 'rationale'),
        decidedByUserId: principal.id,
      });
      if (!outcome.ok) throw unprocessable(outcome.reason);
      return {
        created: outcome.value.created,
        message: outcome.value.created
          ? 'Recorded, and it reads as yours rather than as something the method table says.'
          : 'That relation was already recorded between these two.',
      };
    }

    throw badRequest('"action" is MERGE, UNMERGE, SPLIT or LINK.');
  }),
);
