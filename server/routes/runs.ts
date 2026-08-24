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
import {
  documentTypeForRun,
  registerRunArtifact,
  targetVersionForRun,
} from '../services/runArtifacts.ts';
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

async function auditsForRun(run: ResearchRun): Promise<Audit[]> {
  const all = run.layerId ? await listAuditsByLayer(run.layerId) : await listAuditsByProject(run.projectId);
  return all.filter((audit) => audit.runId === run.id);
}

/** The version this run is producing, falling back to what its type would target. */
// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

runsRouter.get(
  '/:runId',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    return {
      run,
      layer: run.layerId ? await requireLayer(run.layerId) : null,
      dependencies: await checkRunDependencies(run.id),
      audits: await auditsForRun(run),
      lineage: await getRunLineage(run.id),
    };
  }),
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

runsRouter.patch(
  '/:runId',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
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
      await updateRun(run.id, {
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

    // Invariant 3 and 5: overwriting a failed run's recorded output or its
    // failure reason is a correction to history, so it needs its own entry even
    // when the status did not move.
    const rewroteRecord =
      ('resultText' in body && updated.resultText !== run.resultText) ||
      ('failureReason' in body && updated.failureReason !== run.failureReason);
    if (rewroteRecord) {
      await recordEvent({
        projectId: run.projectId,
        layerId: run.layerId,
        entityType: 'RUN',
        entityId: run.id,
        eventType: 'USER_CORRECTION',
        payload: {
          ...('resultText' in body
            ? { resultText: { fromLength: run.resultText?.length ?? 0, toLength: updated.resultText?.length ?? 0 } }
            : {}),
          ...('failureReason' in body
            ? { failureReason: { from: run.failureReason, to: updated.failureReason } }
            : {}),
        },
      });
    }

    if (status && status !== run.status) {
      await recordEvent({
        projectId: run.projectId,
        layerId: run.layerId,
        entityType: 'RUN',
        entityId: run.id,
        eventType: 'USER_CORRECTION',
        payload: { field: 'status', from: run.status, to: status },
      });
    }

    await recomputeProject(run.projectId);
    return { run: await requireRun(updated.id), plan: await buildPlan(run.projectId) };
  }),
);

/** Statuses whose recorded prompt is still a working draft rather than history. */
const RECOMPILABLE_RUN_STATUSES = new Set<RunStatus>(['PLANNED', 'READY', 'BLOCKED']);

runsRouter.post(
  '/:runId/prompt',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    const layer = await layerOfRun(run);
    const project = await projectOfLayer(layer);
    const body = bodyOf(req);

    // A redo carries its parent's audit and text forward, so recompiling one
    // rebuilds the corrected prompt rather than the original.
    const parentAudit = run.parentRunId ? await getLatestAuditForRun(run.parentRunId) : null;

    const compiled = await compilePrompt({
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

    const dependencies = await getDb().transaction(async () => {
      // Invariants 5 and 10: a started run's prompt is the record of what was
      // actually sent, and it is the only copy. Recompiling over a FAILED or
      // COMPLETE run would destroy the evidence a redo is supposed to preserve.
      if (!RECOMPILABLE_RUN_STATUSES.has(run.status)) {
        throw conflict(
          `Run ${run.id} is ${run.status}, so its recorded prompt is history and cannot be ` +
            `rewritten. Create a redo instead — it carries the corrected prompt and keeps this ` +
            `attempt intact.`,
          { runId: run.id, status: run.status },
        );
      }

      await updateRun(run.id, {
        targetVersion: compiled.targetVersion,
        prompt: compiled.prompt,
        promptSections: compiled.sections,
        requiredAttachments: compiled.requiredAttachments,
        expectedConversationTitle: compiled.expectedConversationTitle,
        expectedFilename: compiled.expectedFilename,
      });
      await setRunDependencies(run.id, compiled.requiredAttachments, {
        dependencyType:
          run.runType === 'AUDIT' || run.runType === 'CROSS_LAYER_AUDIT' ? 'AUDIT_INPUT' : 'SOURCE_PACKET',
      });
      const check = await checkRunDependencies(run.id);
      await updateRun(run.id, { status: check.ready ? 'READY' : 'BLOCKED' });
      await recordEvent({
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

    await recomputeProject(project.id);
    return { run: await requireRun(run.id), compiled, dependencies };
  }),
);

/**
 * Invariant 4, enforced at every door into a synthesis rather than only at
 * `/start`. Finishing a run registers the canonical v3.1 artifact and makes the
 * layer freezable, so completing one on a packet the platform knows is
 * incomplete is the same violation as starting it — just later and harder to see.
 */
async function assertSynthesisPacketComplete(run: ResearchRun, verb: string): Promise<void> {
  if (run.runType !== 'SYNTHESIS' || run.dependencyOverride) return;
  const check = await checkRunDependencies(run.id);
  if (check.ready) return;
  throw conflict(
    `This synthesis cannot ${verb}: its source packet is ${check.summary}. ` +
      `Missing: ${check.missing.join(', ') || 'none'}. ` +
      `Import the missing documents, or re-create the synthesis with an explicit override.`,
    check,
  );
}

runsRouter.post(
  '/:runId/start',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    await assertSynthesisPacketComplete(run, 'start');

    const now = nowIso();
    await updateRun(run.id, { status: 'RUNNING', startedAt: run.startedAt ?? now });
    await recordEvent({
      projectId: run.projectId,
      layerId: run.layerId,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_STARTED',
      payload: { runType: run.runType, targetVersion: run.targetVersion, startedAt: now },
    });

    await recomputeProject(run.projectId);
    return { run: await requireRun(run.id), plan: await buildPlan(run.projectId) };
  }),
);

runsRouter.post(
  '/:runId/complete',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    await assertSynthesisPacketComplete(run, 'be completed');
    const body = bodyOf(req);
    const resultText = 'resultText' in body ? nullableString(body['resultText'], 'resultText') : undefined;

    const rawRegister = body['register'];
    const register =
      rawRegister === true ? {} : rawRegister === false ? undefined : optionalRecord(rawRegister, 'register');

    let document: Document | null = null;
    if (register) {
      const layer = await layerOfRun(run);
      const project = await projectOfLayer(layer);
      const version =
        parseVersion(register['version'], 'register.version') ??
        await targetVersionForRun(run, layer.id, project.id);
      const documentType =
        optionalEnum<DocumentType>(register['documentType'], DOCUMENT_TYPES, 'register.documentType') ??
        await documentTypeForRun(run);

      if (resultText && resultText.length > 0) {
        // The returned text is the artifact: store it so the document has a real
        // file, rather than a row that claims a document nobody can open.
        const names = buildNames(layer.name, version, '.md');
        const imported = await importFile({
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
          await updateDocument(imported.documentId, { sourceRunId: run.id, status: 'COMPLETE' }) ??
          await requireDocument(imported.documentId);
      } else {
        // No text yet: register the expectation so the layer can say exactly
        // which document it is waiting for.
        const names = buildNames(layer.name, version);
        const existing = await findDocumentByCanonicalName(project.id, names.canonicalName);
        if (existing) {
          document = await updateDocument(existing.id, { documentType, sourceRunId: run.id }) ?? existing;
        } else {
          document = await createDocument({
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
          await recordEvent({
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
    await updateRun(run.id, {
      status: 'COMPLETE',
      resultText,
      completedAt,
      targetDocumentId: document ? document.id : undefined,
    });
    await recordEvent({
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

    await recomputeProject(run.projectId);
    return {
      run: await requireRun(run.id),
      document: document ? await getDocument(document.id) : null,
      plan: await buildPlan(run.projectId),
    };
  }),
);

runsRouter.post(
  '/:runId/fail',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    const failureReason = requiredString(bodyOf(req)['failureReason'], 'failureReason');

    const failedAt = nowIso();
    // The prompt, the packet and any partial result stay exactly as they are:
    // a failed attempt is evidence, not garbage (invariant 5).
    await updateRun(run.id, { status: 'FAILED', failureReason, failedAt });
    await recordEvent({
      projectId: run.projectId,
      layerId: run.layerId,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_FAILED',
      payload: { runType: run.runType, failureReason, failedAt },
    });

    await recomputeProject(run.projectId);
    return { run: await requireRun(run.id), plan: await buildPlan(run.projectId) };
  }),
);

runsRouter.post(
  '/:runId/result-file',
  uploadOneFile,
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    await assertSynthesisPacketComplete(run, 'register its result');
    const layer = await layerOfRun(run);
    const project = await projectOfLayer(layer);
    const file = uploadedFile(req);
    if (file.buffer.byteLength === 0) {
      throw badRequest('The uploaded file is empty, so there is nothing to register.');
    }

    // The same filing path staged research uses: the platform owns the filename
    // (invariant 4), and one registration completes the run either way.
    const filed = await registerRunArtifact({
      run,
      layer,
      project,
      originalFilename: file.originalname,
      contents: file.buffer,
    });
    if (!filed.imported.documentId) throw conflict(filed.imported.message, filed.imported);

    return {
      run: await requireRun(run.id),
      document: await getDocument(filed.imported.documentId),
      plan: await buildPlan(project.id),
    };
  }),
);

runsRouter.post(
  '/:runId/audit',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    const layer = await layerOfRun(run);
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

    const outcome = await asInvariantViolation(() =>
      recordAudit({
        projectId: run.projectId,
        layerId: layer.id,
        runId: run.id,
        auditedDocumentId: run.targetDocumentId,
        result,
        source: text ? 'PASTED_TEXT' : 'MANUAL',
      }),
    );

    await recomputeProject(run.projectId);
    return {
      audit: outcome.audit,
      state: await computeLayerState(layer.id),
      redoRun: outcome.redoRun,
      plan: await buildPlan(run.projectId),
    };
  }),
);

runsRouter.post(
  '/:runId/redo',
  handler(async (req) => {
    const run = await requireRun(pathId(req, 'runId'));
    const reason = requiredString(bodyOf(req)['reason'], 'reason');
    const audit = await getLatestAuditForRun(run.id);

    // A new attempt, never an edit of the old one.
    const redo = await asInvariantViolation(() =>
      createRedoRun({
        parentRunId: run.id,
        auditId: audit?.id ?? null,
        reason,
        automatic: false,
      }),
    );

    await recomputeProject(run.projectId);
    return { run: await requireRun(redo.id), plan: await buildPlan(run.projectId) };
  }),
);
