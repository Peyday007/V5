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
import { getAudit, listAuditPasses, listPipelinePasses } from '../repos/audits.ts';
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
  requiredString,
  requireDocument,
  requireLayer,
  requireRun,
  unprocessable,
} from './helpers.ts';

export const auditsRouter = Router();

/** The shape the UI renders: headline first, reasoning behind it. */
function auditResponse(outcome: DynamicAuditOutcome) {
  const audit = outcome.audit;
  return {
    audit,
    state: outcome.layerState,
    redoRun: outcome.redoRun,
    plan: buildPlan(audit.projectId),
    pipelineId: outcome.pipelineId,
    passes: listPipelinePasses(outcome.pipelineId),
    researchCandidates: outcome.researchCandidates,
    adversarial: outcome.adversarial,
    primary: outcome.primary,
    // What each conclusion can be checked against, gap by gap.
    evidence: listAuditEvidence(audit.id),
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
function targetFromRun(runId: string): AuditTarget {
  const run = requireRun(runId);
  if (!run.layerId) {
    throw badRequest(`Run ${run.id} is not attached to a layer, so there is nothing to audit it against.`);
  }
  // Audit the work, not the audit run itself.
  const documentId = run.targetDocumentId;
  return { mode: 'SINGLE_DOCUMENT', layerId: run.layerId, documentId, runId: run.id };
}

function targetFromDocument(documentId: string): AuditTarget {
  const document = requireDocument(documentId);
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

function targetFromLayer(layerId: string): AuditTarget {
  const layer = requireLayer(layerId);
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
function auditFailureBody(error: AuditFailure) {
  return {
    error: error.message,
    detail: {
      pass: error.passKey,
      pipelineId: error.pipelineId,
      rawResponse: error.rawResponse,
      passes: listPipelinePasses(error.pipelineId),
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

function auditHandler(resolve: (req: Parameters<typeof pathId>[0]) => AuditTarget) {
  return handler(async (req) => {
    const target = resolve(req);
    try {
      return auditResponse(await runAudit(target, bodyOf(req)));
    } catch (error) {
      if (error instanceof AuditFailure) {
        // A real HttpError, not an Error dressed up as one: only the former
        // carries `detail` through the error middleware, and `detail` is where
        // "nothing was changed" and the recorded passes live.
        const body = auditFailureBody(error);
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

function streamHandler(resolve: (req: Parameters<typeof pathId>[0]) => AuditTarget) {
  return async (req: Parameters<typeof pathId>[0] & { body?: unknown }, res: Response): Promise<void> => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      const target = resolve(req);
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
      sseSend(res, 'result', auditResponse(outcome));
    } catch (error) {
      if (error instanceof AuditFailure) {
        sseSend(res, 'failed', auditFailureBody(error));
      } else {
        sseSend(res, 'failed', {
          error: error instanceof Error ? error.message : String(error),
          detail: { stateChanged: false },
        });
      }
    } finally {
      res.end();
    }
  };
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
  handler((req) => {
    const auditId = pathId(req, 'auditId');
    const audit = getAudit(auditId);
    if (!audit) throw notFound(`No audit with id ${auditId}.`);
    return {
      audit,
      passes: listAuditPasses(audit.id),
      layer: audit.layerId ? computeLayerState(audit.layerId) : null,
      documents: audit.auditedDocumentIds.map((id) => getDocument(id)).filter(Boolean),
      run: audit.runId ? getRun(audit.runId) : null,
      // The citation trail: which passage each conclusion can be checked against.
      evidence: listAuditEvidence(audit.id),
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
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const body = bodyOf(req);
    const query = requiredString(body['query'], 'query');
    const limit = optionalInteger(body['limit'], 'limit', { min: 1, max: 25 }) ?? 5;
    const documentIds = listDocumentsByLayer(layer.id)
      .filter((document) => document.status === 'COMPLETE' || document.status === 'FROZEN')
      .map((document) => document.id);
    return { layer, query, ...retrieveEvidence({ documentIds, query, limit }) };
  }),
);

auditsRouter.post(
  '/documents/:documentId/evidence',
  handler((req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    const body = bodyOf(req);
    const query = requiredString(body['query'], 'query');
    const limit = optionalInteger(body['limit'], 'limit', { min: 1, max: 25 }) ?? 5;
    return { document, query, ...retrieveEvidence({ documentIds: [document.id], query, limit }) };
  }),
);
