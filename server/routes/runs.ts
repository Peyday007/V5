/**
 * Research-run API.
 *
 * A run is the record of one attempt: the exact prompt that was issued, the
 * packet it required, what came back, and what the audit made of it. Nothing
 * here ever edits a previous attempt — completing, failing, auditing and redoing
 * all move forward and leave the history intact (invariants 5 and 10).
 */
import { Router } from 'express';
import type {
  Audit,
  AuditVerdict,
  Document,
  DocumentType,
  ResearchRun,
  RunStatus,
  RunType,
  StructuredAuditResult,
} from '../domain/types.ts';
import { AUDIT_VERDICTS, DOCUMENT_TYPES, RUN_STATUSES } from '../domain/types.ts';
import { buildNames } from '../domain/naming.ts';
import { isValidVersion, normalizeVersion, versionSortKey, waveForVersion } from '../domain/version.ts';
import { getDb } from '../db/database.ts';
import { getLatestAuditForRun, listAuditsByLayer, listAuditsByProject } from '../repos/audits.ts';
import {
  createDocument,
  findDocumentByCanonicalName,
  getDocument,
  updateDocument,
} from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getRun, getRunLineage, updateRun } from '../repos/runs.ts';
import { nowIso } from '../repos/util.ts';
import { getProvider } from '../providers/index.ts';
import { parseAuditJson, recordAudit } from '../services/auditEngine.ts';
import { checkRunDependencies, setRunDependencies } from '../services/dependencies.ts';
import { importFile } from '../services/importer.ts';
import { buildPlan } from '../services/planner.ts';
import { compilePrompt, defaultTargetVersion } from '../services/promptCompiler.ts';
import { createRedoRun } from '../services/redoEngine.ts';
import { computeLayerState, recomputeProject } from '../services/stateEngine.ts';
import {
  asInvariantViolation,
  badRequest,
  bodyOf,
  conflict,
  handler,
  layerOfRun,
  nullableString,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  pathId,
  projectOfLayer,
  requireDocument,
  requireLayer,
  requireRun,
  requiredEnum,
  requiredString,
  uploadOneFile,
  uploadedFile,
} from './helpers.ts';

export const runsRouter = Router();

/** Statuses from which "the artifact came back" means the run is finished. */
const PENDING_RUN_STATUSES = new Set<RunStatus>(['PLANNED', 'READY', 'BLOCKED', 'RUNNING']);

/** The kind of artifact each run type produces. */
const DOCUMENT_TYPE_BY_RUN_TYPE: Record<RunType, DocumentType> = {
  FOUNDATION: 'FOUNDATION',
  EXPANSION: 'EXPANSION',
  PATCH: 'PATCH',
  AUDIT: 'AUDIT',
  SYNTHESIS: 'SYNTHESIS',
  REDO: 'EXPANSION',
  CROSS_LAYER_AUDIT: 'AUDIT',
};

/** A redo produces whatever its original attempt was trying to produce. */
function documentTypeForRun(run: ResearchRun): DocumentType {
  let current: ResearchRun | null = run;
  for (let hops = 0; current !== null && hops < 20; hops += 1) {
    if (current.runType !== 'REDO') return DOCUMENT_TYPE_BY_RUN_TYPE[current.runType];
    current = current.parentRunId ? getRun(current.parentRunId) : null;
  }
  return DOCUMENT_TYPE_BY_RUN_TYPE.REDO;
}

function parseVersion(value: unknown, field: string): string | undefined {
  const raw = optionalString(value, field);
  if (raw === undefined) return undefined;
  if (!isValidVersion(raw)) {
    throw badRequest(
      `"${raw}" is not a version this project understands. Expected something like v1, v1G or v3.1.`,
    );
  }
  return normalizeVersion(raw);
}

function auditsForRun(run: ResearchRun): Audit[] {
  const all = run.layerId ? listAuditsByLayer(run.layerId) : listAuditsByProject(run.projectId);
  return all.filter((audit) => audit.runId === run.id);
}

/** The version this run is producing, falling back to what its type would target. */
function targetVersionForRun(run: ResearchRun, layerId: string, projectId: string): string {
  const declared = run.targetVersion?.trim();
  if (declared && isValidVersion(declared)) return normalizeVersion(declared);
  return normalizeVersion(defaultTargetVersion(projectId, layerId, run.runType));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

runsRouter.get(
  '/:runId',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    return {
      run,
      layer: run.layerId ? requireLayer(run.layerId) : null,
      dependencies: checkRunDependencies(run.id),
      audits: auditsForRun(run),
      lineage: getRunLineage(run.id),
    };
  }),
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

runsRouter.patch(
  '/:runId',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const body = bodyOf(req);

    const status = optionalEnum<RunStatus>(body['status'], RUN_STATUSES, 'status');
    const provider = 'provider' in body ? nullableString(body['provider'], 'provider') : undefined;
    if (provider) {
      try {
        getProvider(provider);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    const now = nowIso();
    const updated =
      updateRun(run.id, {
        status,
        provider,
        model: 'model' in body ? nullableString(body['model'], 'model') : undefined,
        resultText: 'resultText' in body ? nullableString(body['resultText'], 'resultText') : undefined,
        failureReason:
          'failureReason' in body ? nullableString(body['failureReason'], 'failureReason') : undefined,
        // Keep the timestamps honest when a status is set by hand, so the run
        // history still reads as a sequence of events.
        startedAt: status === 'RUNNING' && !run.startedAt ? now : undefined,
        completedAt: status === 'COMPLETE' && !run.completedAt ? now : undefined,
        failedAt: status === 'FAILED' && !run.failedAt ? now : undefined,
      }) ?? run;

    if (status && status !== run.status) {
      recordEvent({
        projectId: run.projectId,
        layerId: run.layerId,
        entityType: 'RUN',
        entityId: run.id,
        eventType: 'USER_CORRECTION',
        payload: { field: 'status', from: run.status, to: status },
      });
    }

    recomputeProject(run.projectId);
    return { run: requireRun(updated.id), plan: buildPlan(run.projectId) };
  }),
);

runsRouter.post(
  '/:runId/prompt',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const layer = layerOfRun(run);
    const project = projectOfLayer(layer);
    const body = bodyOf(req);

    // A redo carries its parent's audit and text forward, so recompiling one
    // rebuilds the corrected prompt rather than the original.
    const parentAudit = run.parentRunId ? getLatestAuditForRun(run.parentRunId) : null;

    const compiled = compilePrompt({
      projectId: project.id,
      layerId: layer.id,
      runType: run.runType,
      targetVersion: run.targetVersion,
      requiredDocuments: optionalStringArray(body['requiredDocuments'], 'requiredDocuments') ?? null,
      objective: nullableString(body['objective'], 'objective') ?? null,
      scope: nullableString(body['scope'], 'scope') ?? null,
      researchQuestions: optionalStringArray(body['researchQuestions'], 'researchQuestions') ?? null,
      auditId: parentAudit?.id ?? null,
      previousRunId: run.parentRunId,
    });

    const dependencies = getDb().transaction(() => {
      updateRun(run.id, {
        targetVersion: compiled.targetVersion,
        prompt: compiled.prompt,
        promptSections: compiled.sections,
        requiredAttachments: compiled.requiredAttachments,
        expectedConversationTitle: compiled.expectedConversationTitle,
        expectedFilename: compiled.expectedFilename,
      });
      setRunDependencies(run.id, compiled.requiredAttachments, {
        dependencyType:
          run.runType === 'AUDIT' || run.runType === 'CROSS_LAYER_AUDIT' ? 'AUDIT_INPUT' : 'SOURCE_PACKET',
      });
      const check = checkRunDependencies(run.id);
      // Only a run that has not started yet may be re-flagged READY/BLOCKED.
      if (run.status === 'PLANNED' || run.status === 'READY' || run.status === 'BLOCKED') {
        updateRun(run.id, { status: check.ready ? 'READY' : 'BLOCKED' });
      }
      recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'RUN',
        entityId: run.id,
        eventType: 'RUN_PROMPT_COMPILED',
        payload: {
          recompiled: true,
          sections: compiled.sections.map((section) => section.key),
          requiredAttachments: compiled.requiredAttachments,
          dependencies: check.summary,
        },
      });
      return check;
    });

    recomputeProject(project.id);
    return { run: requireRun(run.id), compiled, dependencies };
  }),
);

runsRouter.post(
  '/:runId/start',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));

    // Invariant 4: a synthesis never starts on an incomplete packet unless the
    // user recorded an explicit override when it was prepared.
    if (run.runType === 'SYNTHESIS' && !run.dependencyOverride) {
      const check = checkRunDependencies(run.id);
      if (!check.ready) {
        throw conflict(
          `This synthesis cannot start: its source packet is ${check.summary}. ` +
            `Missing: ${check.missing.join(', ') || 'none'}.`,
          check,
        );
      }
    }

    const now = nowIso();
    updateRun(run.id, { status: 'RUNNING', startedAt: run.startedAt ?? now });
    recordEvent({
      projectId: run.projectId,
      layerId: run.layerId,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_STARTED',
      payload: { runType: run.runType, targetVersion: run.targetVersion, startedAt: now },
    });

    recomputeProject(run.projectId);
    return { run: requireRun(run.id), plan: buildPlan(run.projectId) };
  }),
);

runsRouter.post(
  '/:runId/complete',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const body = bodyOf(req);
    const resultText = 'resultText' in body ? nullableString(body['resultText'], 'resultText') : undefined;

    const rawRegister = body['register'];
    const register =
      rawRegister === true ? {} : rawRegister === false ? undefined : optionalRecord(rawRegister, 'register');

    let document: Document | null = null;
    if (register) {
      const layer = layerOfRun(run);
      const project = projectOfLayer(layer);
      const version =
        parseVersion(register['version'], 'register.version') ??
        targetVersionForRun(run, layer.id, project.id);
      const documentType =
        optionalEnum<DocumentType>(register['documentType'], DOCUMENT_TYPES, 'register.documentType') ??
        documentTypeForRun(run);

      if (resultText && resultText.length > 0) {
        // The returned text is the artifact: store it so the document has a real
        // file, rather than a row that claims a document nobody can open.
        const names = buildNames(layer.name, version, '.md');
        const imported = importFile({
          projectId: project.id,
          originalFilename: names.filename,
          contents: Buffer.from(resultText, 'utf8'),
          layerId: layer.id,
          version,
          documentType,
          notes: `Captured from run ${run.id}.`,
        });
        if (!imported.documentId) throw conflict(imported.message, imported);
        document =
          updateDocument(imported.documentId, { sourceRunId: run.id, status: 'COMPLETE' }) ??
          requireDocument(imported.documentId);
      } else {
        // No text yet: register the expectation so the layer can say exactly
        // which document it is waiting for.
        const names = buildNames(layer.name, version);
        const existing = findDocumentByCanonicalName(project.id, names.canonicalName);
        if (existing) {
          document = updateDocument(existing.id, { documentType, sourceRunId: run.id }) ?? existing;
        } else {
          document = createDocument({
            projectId: project.id,
            layerId: layer.id,
            canonicalName: names.canonicalName,
            version,
            versionSort: versionSortKey(version),
            wave: waveForVersion(version, project.versionPolicy),
            documentType,
            status: 'EXPECTED',
            conversationTitle: names.conversationTitle,
            sourceRunId: run.id,
            notes: `Expected artifact of run ${run.id}.`,
          });
          recordEvent({
            projectId: project.id,
            layerId: layer.id,
            entityType: 'DOCUMENT',
            entityId: document.id,
            eventType: 'DOCUMENT_CREATED',
            payload: {
              canonicalName: document.canonicalName,
              version,
              documentType,
              status: 'EXPECTED',
              runId: run.id,
            },
          });
        }
      }
    }

    const completedAt = nowIso();
    updateRun(run.id, {
      status: 'COMPLETE',
      resultText,
      completedAt,
      targetDocumentId: document ? document.id : undefined,
    });
    recordEvent({
      projectId: run.projectId,
      layerId: run.layerId,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_COMPLETED',
      payload: {
        runType: run.runType,
        targetVersion: run.targetVersion,
        documentId: document?.id ?? null,
        canonicalName: document?.canonicalName ?? null,
        completedAt,
      },
    });

    recomputeProject(run.projectId);
    return {
      run: requireRun(run.id),
      document: document ? getDocument(document.id) : null,
      plan: buildPlan(run.projectId),
    };
  }),
);

runsRouter.post(
  '/:runId/fail',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const failureReason = requiredString(bodyOf(req)['failureReason'], 'failureReason');

    const failedAt = nowIso();
    // The prompt, the packet and any partial result stay exactly as they are:
    // a failed attempt is evidence, not garbage (invariant 5).
    updateRun(run.id, { status: 'FAILED', failureReason, failedAt });
    recordEvent({
      projectId: run.projectId,
      layerId: run.layerId,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_FAILED',
      payload: { runType: run.runType, failureReason, failedAt },
    });

    recomputeProject(run.projectId);
    return { run: requireRun(run.id), plan: buildPlan(run.projectId) };
  }),
);

runsRouter.post(
  '/:runId/result-file',
  uploadOneFile,
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const layer = layerOfRun(run);
    const project = projectOfLayer(layer);
    const file = uploadedFile(req);
    if (file.buffer.byteLength === 0) {
      throw badRequest('The uploaded file is empty, so there is nothing to register.');
    }

    const version = targetVersionForRun(run, layer.id, project.id);
    const documentType = documentTypeForRun(run);

    // The importer owns the filename (section 10): whatever the model called its
    // download, the stored file is named by the platform.
    const imported = importFile({
      projectId: project.id,
      originalFilename: file.originalname,
      contents: file.buffer,
      layerId: layer.id,
      version,
      documentType,
      notes: `Returned by run ${run.id}.`,
    });
    if (!imported.documentId) throw conflict(imported.message, imported);
    const document =
      updateDocument(imported.documentId, { sourceRunId: run.id, status: 'COMPLETE' }) ??
      requireDocument(imported.documentId);

    const finishes = PENDING_RUN_STATUSES.has(run.status);
    const completedAt = nowIso();
    updateRun(run.id, {
      targetDocumentId: document.id,
      status: finishes ? 'COMPLETE' : undefined,
      completedAt: finishes ? completedAt : undefined,
    });
    if (finishes) {
      recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'RUN',
        entityId: run.id,
        eventType: 'RUN_COMPLETED',
        payload: {
          runType: run.runType,
          documentId: document.id,
          canonicalName: document.canonicalName,
          storedPath: imported.storedPath,
          completedAt,
        },
      });
    }

    recomputeProject(project.id);
    return {
      run: requireRun(run.id),
      document: getDocument(document.id),
      plan: buildPlan(project.id),
    };
  }),
);

runsRouter.post(
  '/:runId/audit',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const layer = layerOfRun(run);
    const body = bodyOf(req);

    // `text` is the raw model output; the structured record is what gets stored
    // either way, because prose alone is not an audit result (invariant 11).
    const text = optionalString(body['text'], 'text');
    const parsed = text ? parseAuditJson(text) : null;
    const rawVerdict = body['verdict'];
    const verdict =
      rawVerdict === undefined || rawVerdict === null || rawVerdict === ''
        ? (parsed?.verdict ?? null)
        : requiredEnum<AuditVerdict>(rawVerdict, AUDIT_VERDICTS, 'verdict');

    if (!verdict) {
      throw badRequest(
        text
          ? 'No structured audit result could be read from that text. Paste the JSON block the audit ' +
              'prompt asks for, or send "verdict" explicitly.'
          : `"verdict" is required. Expected one of: ${AUDIT_VERDICTS.join(', ')}.`,
      );
    }

    const result: Partial<StructuredAuditResult> & { verdict: AuditVerdict } = {
      ...(parsed ?? {}),
      verdict,
    };

    const summary = optionalString(body['summary'], 'summary');
    if (summary !== undefined) result.summary = summary;
    const failures = optionalStringArray(body['failures'], 'failures');
    if (failures !== undefined) result.failures = failures;
    const missingDocuments = optionalStringArray(body['missingDocuments'], 'missingDocuments');
    if (missingDocuments !== undefined) result.missingDocuments = missingDocuments;
    const requiredResearchRuns = optionalStringArray(body['requiredResearchRuns'], 'requiredResearchRuns');
    if (requiredResearchRuns !== undefined) result.requiredResearchRuns = requiredResearchRuns;
    const requiredPatches = optionalStringArray(body['requiredPatches'], 'requiredPatches');
    if (requiredPatches !== undefined) result.requiredPatches = requiredPatches;
    const synthesisRequired = optionalBoolean(body['synthesisRequired'], 'synthesisRequired');
    if (synthesisRequired !== undefined) result.synthesisRequired = synthesisRequired;
    const freezeEligible = optionalBoolean(body['freezeEligible'], 'freezeEligible');
    if (freezeEligible !== undefined) result.freezeEligible = freezeEligible;
    const nextVersion = parseVersion(body['nextVersion'], 'nextVersion');
    if (nextVersion !== undefined) result.nextVersion = nextVersion;
    const nextAction = optionalString(body['nextAction'], 'nextAction');
    if (nextAction !== undefined) result.nextAction = nextAction;
    const confidence = optionalNumber(body['confidence'], 'confidence', { min: 0, max: 1 });
    if (confidence !== undefined) result.confidence = confidence;

    const outcome = asInvariantViolation(() =>
      recordAudit({
        projectId: run.projectId,
        layerId: layer.id,
        runId: run.id,
        auditedDocumentId: run.targetDocumentId,
        result,
        source: text ? 'PASTED_TEXT' : 'MANUAL',
      }),
    );

    recomputeProject(run.projectId);
    return {
      audit: outcome.audit,
      state: computeLayerState(layer.id),
      redoRun: outcome.redoRun,
      plan: buildPlan(run.projectId),
    };
  }),
);

runsRouter.post(
  '/:runId/redo',
  handler((req) => {
    const run = requireRun(pathId(req, 'runId'));
    const reason = requiredString(bodyOf(req)['reason'], 'reason');
    const audit = getLatestAuditForRun(run.id);

    // A new attempt, never an edit of the old one.
    const redo = asInvariantViolation(() =>
      createRedoRun({
        parentRunId: run.id,
        auditId: audit?.id ?? null,
        reason,
        automatic: false,
      }),
    );

    recomputeProject(run.projectId);
    return { run: requireRun(redo.id), plan: buildPlan(run.projectId) };
  }),
);
