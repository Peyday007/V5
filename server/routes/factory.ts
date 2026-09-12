/**
 * The Software Factory over HTTP.
 *
 * Deliberately small. The normal interface is an objective, a stage, what is
 * running, the blocker if there is one, the result, and the one decision a
 * person still owns — and nothing else. Worker counts, decomposition, retries,
 * model assignment, worktree management, integration order and test selection
 * are the factory's, so none of them has a route.
 *
 * Two boundaries, and they are not the same boundary:
 *
 *   * **A campaign is project-scoped.** Every handler resolves its campaign to a
 *     project and asks `decideProjectAccess`, which is the same module every
 *     other project-scoped resource in Brain uses. A campaign a principal may
 *     not see is reported exactly as one that does not exist — the same status
 *     *and the same body* — because a body that differed would still be an
 *     oracle.
 *
 *   * **Approving is a person's act.** A worker principal is refused at the
 *     approval and release routes by principal type, not by configuration. A
 *     machine that could approve its own campaign's release would be a machine
 *     deciding what ships.
 */
import { Router } from 'express';
import type { Principal } from '../domain/types.ts';
import { FACTORY_DEPLOYMENT_POLICIES } from '../domain/factory.ts';
import { currentPrincipal } from '../services/identity/context.ts';
import {
  getCampaign,
  getChangeRequest,
  listAmendments,
  listCampaigns,
  listChangeRequests,
  listUnits,
} from '../repos/factory.ts';
import {
  answerRelease,
  getRelease,
  listArtifacts,
  listFindings,
  listReleases,
  listReviews,
  listSessions,
  listWorkers,
} from '../repos/factoryFleet.ts';
import { ContractError, approveObjective, submitObjective } from '../services/factory/contract.ts';
import { ensureCampaign } from '../repos/factory.ts';
import { INITIAL_LANE_TARGET } from '../services/factory/scheduler.ts';
import { campaignMetrics } from '../services/factory/metrics.ts';
import { capacity, readiness } from '../services/factory/registry.ts';
import { campaignBriefing } from '../services/factory/projections.ts';
import { throughputReport } from '../services/factory/throughput.ts';
import { pullRequestFor } from '../services/factory/pullRequest.ts';
import { campaignSpecFor } from '../services/factory/remote.ts';
import { onboardRepository, repositoryOnboarding } from '../services/factory/onboard.ts';
import { getUser } from '../repos/identity.ts';
import {
  authorizeProject,
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalEnum,
  optionalString,
  optionalStringArray,
  unprocessable,
  pathId,
  requiredString,
  requireProject,
} from './helpers.ts';

export const factoryRouter: Router = Router();

/**
 * A person, or nothing.
 *
 * The same 404 a missing route gives, for the same reason the rest of Brain
 * gives one: a distinguishable refusal tells a caller that the thing they may
 * not have exists.
 */
function requirePerson(): Principal {
  const principal = currentPrincipal();
  if (!principal || principal.type !== 'HUMAN') throw notFound('No such route.');
  return principal;
}

/**
 * Refuse with one answer, whatever the reason.
 *
 * `authorizeProject` already answers 404 for a project a principal may not
 * reach — but with *its* message, and a body that differs between "you may not"
 * and "it is not there" is still an oracle even when the status matches. A test
 * written as an attack found exactly that here, which is why this exists rather
 * than each handler calling the authorizer directly.
 */
async function authorizeOrDeny(
  projectId: string,
  level: 'read' | 'write',
  refusal: string,
): Promise<void> {
  try {
    await authorizeProject(projectId, level);
  } catch {
    throw notFound(refusal);
  }
}

/** A project, or the same refusal whether it is absent or forbidden. */
async function projectForFactory(projectId: string, level: 'read' | 'write'): Promise<void> {
  try {
    await requireProject(projectId);
  } catch {
    throw notFound('No such project.');
  }
  await authorizeOrDeny(projectId, level, 'No such project.');
}

/**
 * Where this Brain is, from the request rather than from configuration.
 *
 * The same derivation `oauth.ts` uses for the issuer, and for the same reason:
 * one image runs locally, in CI and in production, and an invitation link that
 * named the wrong host would be a link nobody could open. A forwarded scheme is
 * honoured because the deployment terminates TLS in front of the app.
 */
function originOf(req: { protocol: string; get(name: string): string | undefined }): string {
  const host = req.get('host') ?? '';
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded === 'http' || forwarded === 'https' ? forwarded : req.protocol;
  return `${scheme}://${host}`;
}

/** Resolve a campaign and authorize the project it actually belongs to. */
async function campaignFor(campaignId: string, level: 'READ' | 'WRITE') {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw notFound('No such campaign.');
  await authorizeOrDeny(
    campaign.projectId,
    level === 'READ' ? 'read' : 'write',
    'No such campaign.',
  );
  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  if (!changeRequest) throw notFound('No such campaign.');
  return { campaign, changeRequest };
}

/* ------------------------------------------------------------------------- */
/* Submitting and approving                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Submit an objective.
 *
 * Idempotent by the ask itself: two submissions of the same objective in the
 * same project collide on one change request, so a person pressing the button
 * twice, a retried request and a redelivered event all produce one campaign.
 */
factoryRouter.post(
  '/projects/:projectId/factory/change-requests',
  handler(async (req, res) => {
    requirePerson();
    const projectId = pathId(req, 'projectId');
    await projectForFactory(projectId, 'write');

    const body = bodyOf(req);
    const rawConditions = body['acceptanceConditions'];
    if (rawConditions !== undefined && !Array.isArray(rawConditions)) {
      throw badRequest('`acceptanceConditions` is a list.');
    }
    const conditions = ((rawConditions ?? []) as unknown[]).map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw badRequest(`Acceptance condition ${index + 1} is not an object.`);
      }
      const record = entry as Record<string, unknown>;
      return {
        statement: requiredString(record['statement'], `acceptanceConditions[${index}].statement`),
        verification: requiredString(
          record['verification'],
          `acceptanceConditions[${index}].verification`,
        ),
        mandatory: record['mandatory'] !== false,
      };
    });

    /*
     * A contract refusal is a 422, not a 500.
     *
     * `submitObjective` refuses for reasons that are about this request or about
     * what this Brain can do — an objective too short to say anything, a
     * condition with no verification, no repository checkout to pin against.
     * Every one of them is an answer, and a 500 tells the caller the opposite:
     * that something broke and retrying might work. The message is the service's
     * own, which is written to name a remedy and never a path.
     */
    const result = await submitObjective({
      projectId,
      objective: requiredString(body['objective'], 'objective'),
      expectedOutcome: requiredString(body['expectedOutcome'], 'expectedOutcome'),
      nonGoals: optionalStringArray(body['nonGoals'], 'nonGoals') ?? [],
      acceptanceConditions: conditions,
      mutationScope: optionalStringArray(body['mutationScope'], 'mutationScope'),
      submissionKey: optionalString(body['submissionKey'], 'submissionKey'),
      /*
       * The repository, as a remote rather than a path.
       *
       * This is what lets a Brain with no checkout accept an objective: the pin,
       * the default branch and the repository's own verification commands are read
       * through the forge. A path is deliberately *not* accepted from a caller —
       * §18's rule that a request never chooses a location — and a remote is not a
       * location on this machine.
       */
      repositoryRemote: optionalString(body['repository'], 'repository'),
      baseBranch: optionalString(body['baseBranch'], 'baseBranch'),
      // Whether this campaign's result needs a release decision is a person's
      // call rather than a technical field: it says who is allowed to let the
      // work out, which is exactly the question a person is here to answer.
      deploymentPolicy: optionalEnum(
        body['deploymentPolicy'],
        FACTORY_DEPLOYMENT_POLICIES,
        'deploymentPolicy',
      ),
    }).catch((error: unknown) => {
      if (error instanceof ContractError) throw unprocessable(error.message, error.detail);
      throw error;
    });

    res.status(result.created ? 201 : 200).json({
      changeRequest: result.changeRequest,
      created: result.created,
      derived: result.derived,
    });
  }),
);

/**
 * The repositories this factory may be pointed at.
 *
 * Read straight from the envelope in code, which is why it is safe to serve: it
 * contains no credential, and it cannot be extended by anything that happens over
 * HTTP. A person needs it to submit an objective at all — naming a repository by
 * hand and being refused is a worse way to learn the list than being given it.
 *
 * Project-scoped on purpose. The grants are global, but the question "what may I
 * submit here" belongs to somebody who may already write to this project, and a
 * route that answered it to anyone would be describing the factory's reach to
 * callers with no business knowing it.
 */
factoryRouter.get(
  '/projects/:projectId/factory/repositories',
  handler(async (req, res) => {
    const projectId = pathId(req, 'projectId');
    await projectForFactory(projectId, 'write');
    /*
     * The grants, and what each one's onboarding actually looks like right now.
     *
     * The list alone answered "what may I submit here" and left the more useful
     * question — "and would anything execute it" — to a terminal. A surface that
     * offers a repository it cannot run is the shape §24 keeps finding: a state
     * that says waiting when the honest answer is that somebody has to act.
     */
    res.json({ repositories: await repositoryOnboarding(projectId) });
  }),
);

/**
 * Register a worker for one authorized repository.
 *
 * ADMIN, by the policy table, because it is a membership grant and a routing
 * scope — the same authority as connecting a site, and named there for the same
 * reason. `requirePerson` as well as the level: a worker principal is refused by
 * type, so no membership configuration lets a machine register itself for
 * repository work.
 *
 * Nothing is asked. The grant is the one in the path, the project is the one
 * being onboarded, the scope set and the families are constants, and the
 * repository comes from the envelope rather than from the request — so there is
 * no field here whose wrong value would fail silently.
 *
 * The response carries the invitation link once. It is not stored in a form it
 * can be recovered from, does not appear in the identity event, and is in no
 * later read of this route.
 */
factoryRouter.post(
  '/projects/:projectId/factory/repositories/:grantId/onboard',
  handler(async (req, res) => {
    const principal = requirePerson();
    const projectId = pathId(req, 'projectId');
    await projectForFactory(projectId, 'write');
    const actor = await getUser(principal.id);
    if (!actor || actor.disabledAt) throw notFound('No such route.');

    const outcome = await onboardRepository({
      projectId,
      grantId: pathId(req, 'grantId'),
      actor,
      origin: originOf(req),
    });
    if (!outcome.ok) {
      res.status(422).json({ error: 'NOT_AUTHORIZED_REPOSITORY', message: outcome.reason });
      return;
    }
    res.json(outcome.result);
  }),
);

factoryRouter.get(
  '/projects/:projectId/factory/change-requests',
  handler(async (req, res) => {
    const projectId = pathId(req, 'projectId');
    await projectForFactory(projectId, 'read');
    res.json({ changeRequests: await listChangeRequests(projectId) });
  }),
);

/**
 * The first of a person's two actions.
 *
 * A worker principal is refused here by type. Nothing about a membership
 * configuration turns a machine into the person who approves an objective.
 */
factoryRouter.post(
  '/factory/change-requests/:changeRequestId/approve',
  handler(async (req, res) => {
    const principal = requirePerson();
    const changeRequestId = pathId(req, 'changeRequestId');
    const changeRequest = await getChangeRequest(changeRequestId);
    if (!changeRequest) throw notFound('No such change request.');
    await authorizeOrDeny(changeRequest.projectId, 'write', 'No such change request.');

    const result = await approveObjective({
      changeRequestId,
      via: 'PERSON',
      userId: principal.id,
    });
    if (!result.ok) throw badRequest(result.reason ?? 'The objective could not be approved.');

    // Approving the objective is what starts the campaign. One campaign per
    // change request, decided by the database, so a second approval — or a
    // retried request — joins the campaign that exists instead of forking it.
    const approved = result.changeRequest;
    /*
     * How this campaign runs, and whether it continues a pull request somebody is
     * already reading — both derived from the contract and the forge rather than
     * chosen here, so this route and the operator command cannot disagree about
     * the same campaign.
     */
    const spec = await campaignSpecFor(approved);
    const { campaign, created } = await ensureCampaign({
      changeRequestId: approved.id,
      projectId: approved.projectId,
      baseSha: approved.baseSha,
      laneTarget: INITIAL_LANE_TARGET,
      laneTargetReason: 'initial',
      executionMode: spec.executionMode,
      integrationBranch: spec.integrationBranch,
      pullRequest: spec.pullRequest,
    });
    res.json({
      changeRequest: approved,
      campaign,
      campaignCreated: created,
      execution: { mode: spec.executionMode, note: spec.note },
    });
  }),
);

factoryRouter.get(
  '/factory/change-requests/:changeRequestId',
  handler(async (req, res) => {
    const changeRequestId = pathId(req, 'changeRequestId');
    const changeRequest = await getChangeRequest(changeRequestId);
    if (!changeRequest) throw notFound('No such change request.');
    await authorizeOrDeny(changeRequest.projectId, 'read', 'No such change request.');
    res.json({
      changeRequest,
      amendments: await listAmendments(changeRequestId),
    });
  }),
);

/* ------------------------------------------------------------------------- */
/* Watching a campaign                                                        */
/* ------------------------------------------------------------------------- */

factoryRouter.get(
  '/projects/:projectId/factory/campaigns',
  handler(async (req, res) => {
    const projectId = pathId(req, 'projectId');
    await projectForFactory(projectId, 'read');
    res.json({ campaigns: await listCampaigns(projectId) });
  }),
);

/**
 * One campaign, in the terms a person cares about — derived from
 * `campaignBriefing` rather than re-derived inline, so this route and the
 * dedicated briefing route below can never disagree about the same campaign.
 *
 * Objective, stage, what is actually running, the blocker if there is one, the
 * result, and the decision if one is waiting. The unit list is included because
 * "meaningful active work" is what the units say it is — but nothing here is a
 * control panel for them.
 */
factoryRouter.get(
  '/factory/campaigns/:campaignId',
  handler(async (req, res) => {
    const campaignId = pathId(req, 'campaignId');
    const { campaign, changeRequest } = await campaignFor(campaignId, 'READ');
    const [units, reviews, findings, metrics, releases, briefing] = await Promise.all([
      listUnits(campaignId),
      listReviews(campaignId),
      listFindings(campaignId),
      campaignMetrics(campaignId),
      listReleases(campaignId),
      campaignBriefing(campaignId),
    ]);

    const lastReview = reviews[reviews.length - 1] ?? null;
    res.json({
      objective: changeRequest.objective,
      expectedOutcome: changeRequest.expectedOutcome,
      stage: campaign.state,
      stageDetail: campaign.stageDetail,
      blocker: briefing?.blocker ?? null,
      decisionWaiting:
        releases.find((release) => release.decision === 'REQUESTED') ?? null,
      campaign,
      activeWork: briefing?.activeWork.units ?? [],
      units,
      review: lastReview,
      openFindings: findings.filter((finding) => finding.state === 'OPEN'),
      metrics,
    });
  }),
);

/** The briefing: objective, stage, active work, blocker and result, nothing invented. */
factoryRouter.get(
  '/factory/campaigns/:campaignId/briefing',
  handler(async (req, res) => {
    const campaignId = pathId(req, 'campaignId');
    await campaignFor(campaignId, 'READ');
    res.json(await campaignBriefing(campaignId));
  }),
);

/** The factory's own throughput, with an evidence class on every number. */
factoryRouter.get(
  '/factory/campaigns/:campaignId/throughput',
  handler(async (req, res) => {
    const campaignId = pathId(req, 'campaignId');
    await campaignFor(campaignId, 'READ');
    res.json(await throughputReport(campaignId));
  }),
);

/** The reviewable artifact's title and body, from rows — never published from here. */
factoryRouter.get(
  '/factory/campaigns/:campaignId/pull-request',
  handler(async (req, res) => {
    const campaignId = pathId(req, 'campaignId');
    await campaignFor(campaignId, 'READ');
    res.json((await pullRequestFor(campaignId)) ?? { title: null, body: null });
  }),
);

factoryRouter.get(
  '/factory/campaigns/:campaignId/evidence',
  handler(async (req, res) => {
    const campaignId = pathId(req, 'campaignId');
    await campaignFor(campaignId, 'READ');
    const [sessions, artifacts, reviews, findings] = await Promise.all([
      listSessions(campaignId),
      listArtifacts(campaignId),
      listReviews(campaignId),
      listFindings(campaignId),
    ]);
    res.json({
      // Sessions carry token counts and identities, never a credential: the row
      // holds a digest at most, and no projection recovers a value from one.
      sessions,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        createdAt: artifact.createdAt,
      })),
      reviews,
      findings,
    });
  }),
);

/* ------------------------------------------------------------------------- */
/* The release decision                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The second of a person's two actions.
 *
 * Guarded on `REQUESTED`, so a second press changes nothing rather than
 * re-stamping somebody else's decision, and refused to a worker by principal
 * type.
 */
factoryRouter.post(
  '/factory/campaigns/:campaignId/release',
  handler(async (req, res) => {
    const principal = requirePerson();
    const campaignId = pathId(req, 'campaignId');
    await campaignFor(campaignId, 'WRITE');

    const body = bodyOf(req);
    const decision = requiredString(body['decision'], 'decision');
    if (decision !== 'APPROVED' && decision !== 'REFUSED') {
      throw badRequest('`decision` is APPROVED or REFUSED.');
    }
    const release = await getRelease(campaignId, 'CONTROL_PLANE');
    if (!release) throw notFound('No release is waiting on this campaign.');

    const answered = await answerRelease(
      release.id,
      decision,
      principal.id,
      optionalString(body['reason'], 'reason') ?? '',
    );
    res.json({
      answered,
      release: await getRelease(campaignId, 'CONTROL_PLANE'),
    });
  }),
);

/* ------------------------------------------------------------------------- */
/* The fleet                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * What the factory can currently run.
 *
 * Registration is not here on purpose. Adding a worker means granting a surface
 * somewhere a person controls, and the row is the second half of that grant —
 * so it is an operator action, through the factory's own tool, rather than an
 * HTTP route a campaign could reach.
 */
factoryRouter.get(
  '/factory/fleet',
  handler(async (_req, res) => {
    requirePerson();
    const workers = await listWorkers();
    const snapshot = await capacity();
    const ready = await readiness();
    res.json({
      ready: ready.ready,
      reason: ready.reason,
      capacity: {
        available: snapshot.available,
        registered: snapshot.registered,
        rateLimited: snapshot.rateLimited,
        quarantined: snapshot.quarantined,
        paused: snapshot.paused,
        ceilingEvidence: snapshot.ceilingEvidence,
      },
      workers: workers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        kind: worker.kind,
        accountRef: worker.accountRef,
        model: worker.model,
        modelClass: worker.modelClass,
        capabilities: worker.capabilities,
        maxConcurrency: worker.maxConcurrency,
        availability: worker.availability,
        rateLimitedUntil: worker.rateLimitedUntil,
        consecutiveFailures: worker.consecutiveFailures,
        // Whether a credential was recorded, never anything about its value.
        credentialRef: worker.credentialRef,
        credentialRecorded: worker.credentialDigest !== null,
      })),
    });
  }),
);
