/**
 * Staged research over HTTP.
 *
 * Starting a job returns immediately with the orchestration; the work happens on
 * the queue and the browser watches it over SSE. That split is deliberate: a
 * research assignment takes minutes to hours, and a request that waited for it
 * would time out somewhere in between and leave the user with no idea whether
 * their quota had been spent.
 *
 * Two readiness questions are answered separately, because they have different
 * answers and different remedies: whether the orchestration engine can run
 * (always), and whether the research worker on this machine can actually execute
 * a job (ask the probe). Collapsing them would be the "it says connected" lie
 * this whole checkpoint exists to avoid.
 */
import { Router } from 'express';
import type { Response } from 'express';
import { getProvider, listProviderStatuses } from '../providers/index.ts';
import { antigravityStatus } from '../providers/antigravity/runtime.ts';
import { getDocument } from '../repos/documents.ts';
import { getAudit } from '../repos/audits.ts';
import { getRun } from '../repos/runs.ts';
import {
  getOrchestration,
  getOrchestrationLineage,
  listClaims,
  listFragments,
  listOrchestrationsByLayer,
  listOrchestrationsByProject,
  listPasses,
  currentFragments,
} from '../repos/research.ts';
import { buildPlan } from '../services/planner.ts';
import {
  cancelArchiveImport,
  importReport,
  resumeArchiveImport,
  retryFailedFiles,
} from '../services/archive/import.ts';
import { summarize } from '../services/research/sources.ts';
import { startResearch } from '../services/research/orchestrator.ts';
import {
  cancelResearch,
  enqueueResearch,
  isRunning,
  onResearchProgress,
  researchQueueDepth,
  resumeResearch,
} from '../services/research/queue.ts';
import { applyReviewDecisions, buildReview } from '../services/research/review.ts';
import { progressSnapshot } from '../services/research/progress.ts';
import { listJobs } from '../repos/jobs.ts';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  pathId,
  requireLayer,
  requiredString,
} from './helpers.ts';

/** A body field that has to be an object before it can be read as one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const researchRouter = Router();

/** Everything one research job is, in the shape the UI renders. */
function orchestrationView(orchestrationId: string) {
  const orchestration = getOrchestration(orchestrationId);
  if (!orchestration) throw notFound(`No research run with id ${orchestrationId}.`);

  const fragments = listFragments(orchestration.id);
  const live = currentFragments(orchestration.id);
  const claims = listClaims(orchestration.id);
  const passes = listPasses(orchestration.id);

  const byStatus: Record<string, number> = {};
  for (const fragment of live) byStatus[fragment.status] = (byStatus[fragment.status] ?? 0) + 1;

  return {
    orchestration,
    running: isRunning(orchestration.id),
    fragments: live,
    // Every attempt, so the failure history is visible rather than implied.
    attempts: fragments,
    passes,
    claims,
    ledger: summarize(claims),
    fragmentsByStatus: byStatus,
    synthesisReady:
      live.length > 0 && live.every((fragment) =>
        ['ACCEPTED', 'REJECTED', 'CANCELLED', 'NEEDS_HUMAN'].includes(fragment.status),
      ) && live.some((fragment) => fragment.status === 'ACCEPTED'),
    document: orchestration.documentId ? getDocument(orchestration.documentId) : null,
    audit: orchestration.auditId ? getAudit(orchestration.auditId) : null,
    run: getRun(orchestration.runId),
    lineage: getOrchestrationLineage(orchestration.id),
    jobs: listJobs(orchestration.id),
    // The whole picture, read from persisted state rather than accumulated in
    // the browser: a panel that survives a refresh, a reconnect and a restart.
    progress: progressSnapshot(orchestration.id),
  };
}

/**
 * Can research actually run here?
 *
 * The orchestration engine and the worker are reported separately, and the
 * worker's answer comes from the live probe rather than from a stored flag.
 */
researchRouter.get(
  '/research/readiness',
  handler(() => {
    const probe = antigravityStatus();
    return {
      orchestration: {
        ready: true,
        queueDepth: researchQueueDepth(),
        detail:
          'The staged research engine is available: fragments, evidence gate, synthesis and audit ' +
          'all run locally against whichever provider is selected.',
      },
      worker: probe.status,
      providers: listProviderStatuses(),
    };
  }),
);

researchRouter.get(
  '/layers/:layerId/research',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    return { orchestrations: listOrchestrationsByLayer(layer.id) };
  }),
);

researchRouter.get(
  '/projects/:projectId/research',
  handler((req) => ({
    orchestrations: listOrchestrationsByProject(pathId(req, 'projectId')),
    queueDepth: researchQueueDepth(),
  })),
);

/**
 * Start an assignment.
 *
 * Returns as soon as the job is queued. The provider is checked first, so an
 * unusable worker is refused here with the reason rather than failing three
 * minutes later inside a pass.
 */
researchRouter.post(
  '/layers/:layerId/research',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const body = bodyOf(req);
    const assignment = requiredString(body['assignment'], 'assignment');
    const title = optionalString(body['title'], 'title');
    const providerName = optionalString(body['provider'], 'provider');
    const model = optionalString(body['model'], 'model');
    const targetVersion = optionalString(body['targetVersion'], 'targetVersion');

    const provider = getProvider(providerName);
    const status = provider.getStatus();
    if (!status.capabilities.research || !status.available) {
      throw badRequest(`${provider.name} cannot run research right now: ${status.reason}`);
    }
    if (status.placeholder) {
      // Refused here rather than three passes in: the run would fail anyway, and
      // the useful thing to say is what the user has to set up, not that some
      // pass returned unparseable text.
      throw badRequest(
        `${provider.name} returns placeholder content, not research, so a staged research run ` +
          'against it would produce a report with invented citations. Connect a research worker ' +
          'and select it, or use COPY PROMPT and run the assignment yourself.',
      );
    }

    // Research costs the user's allowance and their afternoon, so the default
    // is to plan it, show the plan, and wait. Passing review: false is a
    // deliberate choice to skip that, not an accident of omission.
    const requireApproval = optionalBoolean(body['review'], 'review') ?? true;

    const orchestration = startResearch({
      layerId: layer.id,
      assignment,
      requireApproval,
      ...(title ? { title } : {}),
      ...(providerName ? { providerName } : {}),
      ...(model ? { model } : {}),
      ...(targetVersion ? { targetVersion } : {}),
    });
    void enqueueResearch(orchestration.id);

    return { ...orchestrationView(orchestration.id), plan: buildPlan(layer.projectId) };
  }),
);

researchRouter.get(
  '/research/:orchestrationId',
  handler((req) => orchestrationView(pathId(req, 'orchestrationId'))),
);

/**
 * What Brain proposes to do, before anything is spent doing it.
 *
 * The goal as it was understood, what the archive already answers, what is
 * stale or contradicted, the genuine gaps, the fragments planned for them and
 * the jobs they would be bundled into.
 */
researchRouter.get(
  '/research/:orchestrationId/review',
  handler((req) => {
    const orchestrationId = pathId(req, 'orchestrationId');
    if (!getOrchestration(orchestrationId)) {
      throw notFound(`No research run with id ${orchestrationId}.`);
    }
    return buildReview(orchestrationId);
  }),
);

/**
 * Approve the plan, or change it.
 *
 * Corrections are applied first and the plan is re-derived around them, so what
 * is approved is what will actually run. Approving is what releases the run;
 * until then nothing has been spent.
 */
researchRouter.post(
  '/research/:orchestrationId/review',
  handler((req) => {
    const orchestrationId = pathId(req, 'orchestrationId');
    const orchestration = getOrchestration(orchestrationId);
    if (!orchestration) throw notFound(`No research run with id ${orchestrationId}.`);
    const body = bodyOf(req);

    const outcome = applyReviewDecisions(orchestrationId, {
      ...(isRecord(body['boundary']) ? { boundary: body['boundary'] as never } : {}),
      ...(Array.isArray(body['addRequirements'])
        ? { addRequirements: body['addRequirements'] as never }
        : {}),
      ...(optionalStringArray(body['removeFragments'], 'removeFragments')
        ? { removeFragments: optionalStringArray(body['removeFragments'], 'removeFragments')! }
        : {}),
      ...(optionalStringArray(body['supersedeClaims'], 'supersedeClaims')
        ? { supersedeClaims: optionalStringArray(body['supersedeClaims'], 'supersedeClaims')! }
        : {}),
      ...(optionalStringArray(body['forceReverify'], 'forceReverify')
        ? { forceReverify: optionalStringArray(body['forceReverify'], 'forceReverify')! }
        : {}),
      ...(optionalBoolean(body['approve'], 'approve') === undefined
        ? {}
        : { approve: optionalBoolean(body['approve'], 'approve')! }),
      ...(optionalBoolean(body['autoApprove'], 'autoApprove') === undefined
        ? {}
        : { autoApprove: optionalBoolean(body['autoApprove'], 'autoApprove')! }),
      ...(optionalString(body['note'], 'note') ? { note: optionalString(body['note'], 'note')! } : {}),
    });

    // Approval is what starts the work. Everything else only changes the plan.
    const approved = getOrchestration(orchestrationId);
    if (approved && approved.approvedAt !== null && approved.status === 'AWAITING_APPROVAL') {
      void enqueueResearch(orchestrationId);
    }
    return outcome;
  }),
);

/** One fragment in full: its brief, its attempts, its claims and its verdict. */
researchRouter.get(
  '/research/:orchestrationId/fragments/:fragmentId',
  handler((req) => {
    const orchestrationId = pathId(req, 'orchestrationId');
    const fragmentId = pathId(req, 'fragmentId');
    const fragment = listFragments(orchestrationId).find((entry) => entry.id === fragmentId);
    if (!fragment) throw notFound(`No fragment ${fragmentId} in this research run.`);
    const claims = listClaims(orchestrationId).filter((claim) => claim.fragmentId === fragment.id);
    return {
      fragment,
      attempts: listFragments(orchestrationId).filter(
        (entry) => entry.fragmentKey === fragment.fragmentKey,
      ),
      claims,
      ledger: summarize(claims),
      passes: listPasses(orchestrationId).filter((pass) => pass.fragmentId === fragment.id),
    };
  }),
);

researchRouter.post(
  '/research/:orchestrationId/cancel',
  handler((req) => {
    const orchestrationId = pathId(req, 'orchestrationId');
    const reason = optionalString(bodyOf(req)['reason'], 'reason') ?? 'Cancelled from the browser.';
    const cancelled = cancelResearch(orchestrationId, reason);
    if (!cancelled) throw notFound(`No research run with id ${orchestrationId}.`);
    return orchestrationView(orchestrationId);
  }),
);

/** Continue an interrupted or repairable job without re-running completed work. */
researchRouter.post(
  '/research/:orchestrationId/resume',
  handler((req) => {
    const orchestrationId = pathId(req, 'orchestrationId');
    const orchestration = getOrchestration(orchestrationId);
    if (!orchestration) throw notFound(`No research run with id ${orchestrationId}.`);
    void resumeResearch(orchestrationId);
    return orchestrationView(orchestrationId);
  }),
);

// ---------------------------------------------------------------------------
// Archive imports
//
// Mounted here rather than under /projects because the job outlives the request
// that started it: it is addressed by its own id from then on.
// ---------------------------------------------------------------------------

researchRouter.get(
  '/imports/:jobId',
  handler((req) => {
    const report = importReport(pathId(req, 'jobId'));
    if (!report) throw notFound(`No import job with id ${pathId(req, 'jobId')}.`);
    return report;
  }),
);

researchRouter.post(
  '/imports/:jobId/resume',
  handler((req) => {
    const jobId = pathId(req, 'jobId');
    const report = importReport(jobId);
    if (!report) throw notFound(`No import job with id ${jobId}.`);
    void resumeArchiveImport(jobId);
    return importReport(jobId);
  }),
);

researchRouter.post(
  '/imports/:jobId/cancel',
  handler((req) => {
    const jobId = pathId(req, 'jobId');
    const reason = optionalString(bodyOf(req)['reason'], 'reason') ?? 'Cancelled from the browser.';
    const cancelled = cancelArchiveImport(jobId, reason);
    if (!cancelled) throw notFound(`No import job with id ${jobId}.`);
    return importReport(jobId);
  }),
);

/** Try the files that failed, and only those. */
researchRouter.post(
  '/imports/:jobId/retry',
  handler((req) => {
    const jobId = pathId(req, 'jobId');
    const report = importReport(jobId);
    if (!report) throw notFound(`No import job with id ${jobId}.`);
    void retryFailedFiles(jobId);
    return importReport(jobId);
  }),
);

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Live progress for one job.
 *
 * The current state is sent immediately on connect, so a browser that arrives
 * late — or reconnects — sees where the work is rather than waiting for the next
 * pass to start.
 */
researchRouter.get('/research/:orchestrationId/stream', (req, res: Response) => {
  const orchestrationId = String(req.params['orchestrationId'] ?? '');
  const orchestration = getOrchestration(orchestrationId);
  if (!orchestration) {
    res.status(404).json({ error: `No research run with id ${orchestrationId}.` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseSend(res, 'state', orchestrationView(orchestrationId));

  const unsubscribe = onResearchProgress(orchestrationId, (progress) => {
    sseSend(res, 'progress', progress);
    // The state travels with each step: the panel stays correct without polling.
    sseSend(res, 'state', orchestrationView(orchestrationId));
  });

  // A long research job outlives most proxies' idle timeouts.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});
