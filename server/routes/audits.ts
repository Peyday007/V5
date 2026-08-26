/**
 * Dynamic audit API (sections 21-22).
 *
 * One button, one round trip: build the context, run the three passes, validate,
 * record the verdict, recompute state, and hand back the concise answer the user
 * actually reads — verdict, how many research runs remain, and the exact next
 * action — with the reasoning available behind it.
 *
 * The streaming variant emits a progress event per pass so the UI can show
 * "Pass 2/3" honestly rather than animating a guess.
 */
import { Router } from 'express';
import type { Response } from 'express';
import type { AuditMode } from '../domain/types.ts';
import { listAuditPasses, listPipelinePasses } from '../repos/audits.ts';
import { getDocument, listDocumentsByLayer } from '../repos/documents.ts';
import { listAuditEvidence } from '../repos/extraction.ts';
import { retrieveEvidence } from '../services/documents/retrieval.ts';
import { getRun } from '../repos/runs.ts';
import { buildPlan } from '../services/planner.ts';
import { computeLayerState } from '../services/stateEngine.ts';
import {
  AuditFailure,
  runDynamicAudit,
  type AuditProgress,
  type DynamicAuditOutcome,
} from '../services/audit/pipeline.ts';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalInteger,
  optionalString,
  pathId,
  requireAudit,
  requireDocument,
  requireLayer,
  requireRun,
  requiredString,
  unprocessable,
  withRequestContext,
} from './helpers.ts';

export const auditsRouter = Router();

/** The shape the UI renders: headline first, reasoning behind it. */
async function auditResponse(outcome: DynamicAuditOutcome) {
  const audit = outcome.audit;
  return {
    audit,
    state: outcome.layerState,
    redoRun: outcome.redoRun,
    plan: await buildPlan(audit.projectId),
    pipelineId: outcome.pipelineId,
    passes: await listPipelinePasses(outcome.pipelineId),
    researchCandidates: outcome.researchCandidates,
    adversarial: outcome.adversarial,
    primary: outcome.primary,
    // What each conclusion can be checked against, gap by gap.
    evidence: await listAuditEvidence(audit.id),
    manifest: outcome.context.manifest,
    headline: {
      verdict: audit.verdict,
      moreResearchRuns: audit.foundationalGapCount + audit.targetedResearchRunsRequired,
      nextAction: audit.nextAction,
      summary: audit.summary,
    },
  };
}

interface AuditTarget {
  mode: AuditMode;
  layerId: string;
  documentId: string | null;
  runId: string | null;
}

/** Resolve what is being audited from the route that was called. */
async function targetFromRun(runId: string): Promise<AuditTarget> {
  const run = await requireRun(runId);
  if (!run.layerId) {
    throw badRequest(`Run ${run.id} is not attached to a layer, so there is nothing to audit it against.`);
  }
  // Audit the work, not the audit run itself.
  const documentId = run.targetDocumentId;
  return { mode: 'SINGLE_DOCUMENT', layerId: run.layerId, documentId, runId: run.id };
}

async function targetFromDocument(documentId: string): Promise<AuditTarget> {
  const document = await requireDocument(documentId);
  if (!document.layerId) {
    throw badRequest(`${document.canonicalName} is not filed under a layer, so it cannot be audited.`);
  }
  return {
    mode: 'SINGLE_DOCUMENT',
    layerId: document.layerId,
    documentId: document.id,
    runId: document.sourceRunId,
  };
}

async function targetFromLayer(layerId: string): Promise<AuditTarget> {
  const layer = await requireLayer(layerId);
  return { mode: 'LAYER_PACKET', layerId: layer.id, documentId: null, runId: null };
}

function providerOptions(body: Record<string, unknown>): { providerName: string | null; model: string | null } {
  return {
    providerName: optionalString(body['provider'], 'provider') ?? null,
    model: optionalString(body['model'], 'model') ?? null,
  };
}

/**
 * A failed audit is a 422, not a 500: the platform worked correctly and the
 * model did not. The project is untouched, and the recorded passes say why.
 */
async function auditFailureBody(error: AuditFailure) {
  return {
    error: error.message,
    detail: {
      pass: error.passKey,
      pipelineId: error.pipelineId,
      rawResponse: error.rawResponse,
      passes: await listPipelinePasses(error.pipelineId),
      stateChanged: false,
    },
  };
}

function runAudit(target: AuditTarget, body: Record<string, unknown>): Promise<DynamicAuditOutcome> {
  const { providerName, model } = providerOptions(body);
  return runDynamicAudit({
    mode: target.mode,
    layerId: target.layerId,
    documentId: target.documentId,
    runId: target.runId,
    providerName,
    model,
  });
}

function auditHandler(resolve: (req: Parameters<typeof pathId>[0]) => Promise<AuditTarget>) {
  return handler(async (req) => {
    const target = await resolve(req);
    try {
      return auditResponse(await runAudit(target, bodyOf(req)));
    } catch (error) {
      if (error instanceof AuditFailure) {
        // A real HttpError, not an Error dressed up as one: only the former
        // carries `detail` through the error middleware, and `detail` is where
        // "nothing was changed" and the recorded passes live.
        const body = await auditFailureBody(error);
        throw unprocessable(body.error, body.detail);
      }
      throw error;
    }
  });
}

auditsRouter.post(
  '/runs/:runId/dynamic-audit',
  auditHandler((req) => targetFromRun(pathId(req, 'runId'))),
);

auditsRouter.post(
  '/documents/:documentId/dynamic-audit',
  auditHandler((req) => targetFromDocument(pathId(req, 'documentId'))),
);

auditsRouter.post(
  '/layers/:layerId/packet-audit',
  auditHandler((req) => targetFromLayer(pathId(req, 'layerId'))),
);

// ---------------------------------------------------------------------------
// Streaming variant — one event per pass, so "Pass 2/3" is a fact
// ---------------------------------------------------------------------------

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamHandler(resolve: (req: Parameters<typeof pathId>[0]) => Promise<AuditTarget>) {
  return withRequestContext(async (req, res: Response): Promise<void> => {
    // Resolve — and therefore authorize — *before* the stream is opened.
    //
    // Once `text/event-stream` headers are written there is no status code left
    // to send, and every refusal after that point would have to be delivered as
    // a 200 carrying a `failed` event. A caller with no right to this layer must
    // get a refusal, not a subscription that immediately apologises. This is the
    // whole of what "protect the stream for its entire connection setup" means.
    let target: AuditTarget;
    try {
      target = await resolve(req);
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : 'That audit could not be started.',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { providerName, model } = providerOptions(body);
      const outcome = await runDynamicAudit({
        mode: target.mode,
        layerId: target.layerId,
        documentId: target.documentId,
        runId: target.runId,
        providerName,
        model,
        onProgress: (progress: AuditProgress) => sseSend(res, 'progress', progress),
      });
      sseSend(res, 'result', await auditResponse(outcome));
    } catch (error) {
      if (error instanceof AuditFailure) {
        sseSend(res, 'failed', await auditFailureBody(error));
      } else {
        sseSend(res, 'failed', {
          error: error instanceof Error ? error.message : String(error),
          detail: { stateChanged: false },
        });
      }
    } finally {
      res.end();
    }
  });
}

auditsRouter.post(
  '/runs/:runId/dynamic-audit/stream',
  streamHandler((req) => targetFromRun(pathId(req, 'runId'))),
);
auditsRouter.post(
  '/documents/:documentId/dynamic-audit/stream',
  streamHandler((req) => targetFromDocument(pathId(req, 'documentId'))),
);
auditsRouter.post(
  '/layers/:layerId/packet-audit/stream',
  streamHandler((req) => targetFromLayer(pathId(req, 'layerId'))),
);

// ---------------------------------------------------------------------------
// Reading an audit back
// ---------------------------------------------------------------------------

auditsRouter.get(
  '/audits/:auditId',
  handler(async (req) => {
    // Addressed by its own id with no project in the path, so the lineage
    // resolver is what keeps a guessed id from being a way in.
    const audit = await requireAudit(pathId(req, 'auditId'));
    return {
      audit,
      passes: await listAuditPasses(audit.id),
      layer: audit.layerId ? await computeLayerState(audit.layerId) : null,
      documents: audit.auditedDocumentIds.map((id) => getDocument(id)).filter(Boolean),
      run: audit.runId ? await getRun(audit.runId) : null,
      // The citation trail: which passage each conclusion can be checked against.
      evidence: await listAuditEvidence(audit.id),
    };
  }),
);

/**
 * Ask the evidence a question (section 13).
 *
 * The answer distinguishes "the documents do not say this" from "those documents
 * were never read" — a distinction the auditor cannot make for itself, and the
 * one that decides whether a gap is real.
 */
auditsRouter.post(
  '/layers/:layerId/evidence',
  handler(async (req) => {
    const layer = await requireLayer(pathId(req, 'layerId'));
    const body = bodyOf(req);
    const query = requiredString(body['query'], 'query');
    const limit = optionalInteger(body['limit'], 'limit', { min: 1, max: 25 }) ?? 5;
    const documentIds = (await listDocumentsByLayer(layer.id))
      .filter((document) => document.status === 'COMPLETE' || document.status === 'FROZEN')
      .map((document) => document.id);
    return { layer, query, ...await retrieveEvidence({ documentIds, query, limit }) };
  }),
);

auditsRouter.post(
  '/documents/:documentId/evidence',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    const body = bodyOf(req);
    const query = requiredString(body['query'], 'query');
    const limit = optionalInteger(body['limit'], 'limit', { min: 1, max: 25 }) ?? 5;
    return { document, query, ...await retrieveEvidence({ documentIds: [document.id], query, limit }) };
  }),
);
