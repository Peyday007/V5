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
import { approveObjective, submitObjective } from '../services/factory/contract.ts';
import { ensureCampaign } from '../repos/factory.ts';
import { INITIAL_LANE_TARGET } from '../services/factory/scheduler.ts';
import { campaignMetrics } from '../services/factory/metrics.ts';
import { capacity, readiness } from '../services/factory/registry.ts';
import {
  authorizeProject,
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalEnum,
  optionalString,
  optionalStringArray,
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

    const result = await submitObjective({
      projectId,
      objective: requiredString(body['objective'], 'objective'),
      expectedOutcome: requiredString(body['expectedOutcome'], 'expectedOutcome'),
      nonGoals: optionalStringArray(body['nonGoals'], 'nonGoals') ?? [],
      acceptanceConditions: conditions,
      mutationScope: optionalStringArray(body['mutationScope'], 'mutationScope'),
      submissionKey: optionalString(body['submissionKey'], 'submissionKey'),
      // Whether this campaign's result needs a release decision is a person's
      // call rather than a technical field: it says who is allowed to let the
      // work out, which is exactly the question a person is here to answer.
      deploymentPolicy: optionalEnum(
        body['deploymentPolicy'],
        FACTORY_DEPLOYMENT_POLICIES,
        'deploymentPolicy',
      ),
    });

    res.status(result.created ? 201 : 200).json({
      changeRequest: result.changeRequest,
      created: result.created,
      derived: result.derived,
    });
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
    const { campaign, created } = await ensureCampaign({
      changeRequestId: approved.id,
      projectId: approved.projectId,
      baseSha: approved.baseSha,
      integrationBranch: `factory/campaign/${approved.submissionKey.slice(0, 12)}`,
      laneTarget: INITIAL_LANE_TARGET,
      laneTargetReason: 'initial',
    });
    res.json({ changeRequest: approved, campaign, campaignCreated: created });
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
 * One campaign, in the terms a person cares about.
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
    const [units, reviews, findings, metrics, releases] = await Promise.all([
      listUnits(campaignId),
      listReviews(campaignId),
      listFindings(campaignId),
      campaignMetrics(campaignId),
      listReleases(campaignId),
    ]);

    const lastReview = reviews[reviews.length - 1] ?? null;
    res.json({
      objective: changeRequest.objective,
      expectedOutcome: changeRequest.expectedOutcome,
      stage: campaign.state,
      stageDetail: campaign.stageDetail,
      blocker: campaign.blockerKind
        ? { kind: campaign.blockerKind, detail: campaign.blockerDetail }
        : null,
      decisionWaiting:
        releases.find((release) => release.decision === 'REQUESTED') ?? null,
      campaign,
      activeWork: units
        .filter((unit) => unit.state === 'LEASED' || unit.state === 'IMPLEMENTED')
        .map((unit) => ({ unitKey: unit.unitKey, title: unit.title, state: unit.state })),
      units,
      review: lastReview,
      openFindings: findings.filter((finding) => finding.state === 'OPEN'),
      metrics,
    });
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
