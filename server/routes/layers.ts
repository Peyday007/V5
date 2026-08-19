/**
 * Layer-level API.
 *
 * A layer is the unit of work: it accumulates versions, gets audited,
 * synthesised and frozen. These routes are the only way the UI touches that
 * lifecycle, and each one hands back the recomputed layer state so the screen
 * never shows a status the database has already moved past.
 */
import { Router } from 'express';
import type {
  DependencyCheckResult,
  Layer,
  LayerStatus,
  RunStatus,
  RunType,
} from '../domain/types.ts';
import { LAYER_STATUSES, RUN_TYPES } from '../domain/types.ts';
import { isValidVersion, normalizeVersion, synthesisVersion } from '../domain/version.ts';
import { getDb } from '../db/database.ts';
import { listAuditsByLayer } from '../repos/audits.ts';
import { listDocumentsByLayer } from '../repos/documents.ts';
import { listEventsByLayer, recordEvent } from '../repos/events.ts';
import { updateLayer } from '../repos/layers.ts';
import { createRun, listRunsByLayer, updateRun } from '../repos/runs.ts';
import { getProvider } from '../providers/index.ts';
import {
  checkCanonicalNames,
  checkRunDependencies,
  setRunDependencies,
} from '../services/dependencies.ts';
import { freezeLayer, reopenLayer } from '../services/freeze.ts';
import { buildPlan } from '../services/planner.ts';
import { compilePrompt, defaultRequiredDocuments } from '../services/promptCompiler.ts';
import {
  computeLayerState,
  deriveLayerExpectationsFromDocuments,
  recomputeProject,
  setLayerExpectations,
  setLayerManualStatus,
} from '../services/stateEngine.ts';
import { prepareSynthesis } from '../services/synthesis.ts';
import { buildAuditContext } from '../services/audit/context.ts';
import {
  asInvariantViolation,
  badRequest,
  bodyOf,
  handler,
  nullableString,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  pathId,
  projectOfLayer,
  queryOf,
  requireDocument,
  requireLayer,
  requiredEnum,
  requiredString,
} from './helpers.ts';

export const layersRouter = Router();

/** A run in one of these states still owns the layer's source packet. */
const OPEN_RUN_STATUSES = new Set<RunStatus>([
  'PLANNED',
  'READY',
  'BLOCKED',
  'RUNNING',
  'AUDIT_REQUIRED',
  'REDO_REQUIRED',
]);

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

/**
 * The dependency picture the layer screen shows: the open run's real packet when
 * one exists, otherwise a preview of what a synthesis would need right now. Both
 * answer the same question — "is this layer waiting on another document?".
 */
function layerDependencies(layer: Layer): DependencyCheckResult {
  const open = listRunsByLayer(layer.id).find((run) => OPEN_RUN_STATUSES.has(run.status));
  if (open) return checkRunDependencies(open.id);
  return checkCanonicalNames(
    layer.projectId,
    defaultRequiredDocuments(layer.projectId, layer.id, 'SYNTHESIS'),
  );
}

function versionList(value: unknown, field: string): string[] {
  const raw = optionalStringArray(value, field) ?? [];
  return raw.map((entry) => {
    if (!isValidVersion(entry)) {
      throw badRequest(
        `"${entry}" in "${field}" is not a version this project understands. ` +
          'Expected something like v1, v1G or v3.1.',
      );
    }
    return normalizeVersion(entry);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

layersRouter.get(
  '/:layerId',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    return {
      layer,
      state: computeLayerState(layer.id),
      documents: listDocumentsByLayer(layer.id),
      runs: listRunsByLayer(layer.id),
      audits: listAuditsByLayer(layer.id),
      dependencies: layerDependencies(layer),
      events: listEventsByLayer(layer.id, 100),
    };
  }),
);

layersRouter.get(
  '/:layerId/prompt',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const query = queryOf(req);
    const runType = requiredEnum<RunType>(query['runType'], RUN_TYPES, 'runType');
    const targetVersion = parseVersion(query['targetVersion'], 'targetVersion') ?? null;

    // Preview only: nothing is written, so the user can look at the prompt for a
    // run they have not decided to make yet.
    const compiled = compilePrompt({
      projectId: layer.projectId,
      layerId: layer.id,
      runType,
      targetVersion,
    });
    return {
      compiled,
      dependencies: checkCanonicalNames(layer.projectId, compiled.requiredAttachments),
    };
  }),
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

layersRouter.patch(
  '/:layerId',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const body = bodyOf(req);

    const name = optionalString(body['name'], 'name');
    const notes = 'notes' in body ? nullableString(body['notes'], 'notes') : undefined;
    const parked = optionalBoolean(body['parked'], 'parked');
    const parkedNote = 'parkedNote' in body ? nullableString(body['parkedNote'], 'parkedNote') : undefined;

    if (name !== undefined || notes !== undefined || parked !== undefined || parkedNote !== undefined) {
      updateLayer(layer.id, { name, notes, parked, parkedNote });
      // Invariant 3: renaming a layer changes every canonical name derived from
      // it, and parking one removes it from the plan. Both belong in the history.
      recordEvent({
        projectId: layer.projectId,
        layerId: layer.id,
        entityType: 'LAYER',
        entityId: layer.id,
        eventType: 'USER_CORRECTION',
        payload: {
          ...(name !== undefined ? { name: { from: layer.name, to: name } } : {}),
          ...(notes !== undefined ? { notes: { from: layer.notes, to: notes } } : {}),
          ...(parked !== undefined ? { parked: { from: layer.parked, to: parked } } : {}),
          ...(parkedNote !== undefined ? { parkedNote: { from: layer.parkedNote, to: parkedNote } } : {}),
        },
      });
    }

    if ('expectedVersions' in body) {
      setLayerExpectations(layer.id, versionList(body['expectedVersions'], 'expectedVersions'));
    }

    if ('manualStatus' in body) {
      const raw = body['manualStatus'];
      if (raw === null || raw === '') {
        // Releasing the pin hands the layer back to the derivation rules.
        setLayerManualStatus(layer.id, null);
      } else {
        const status = requiredEnum<LayerStatus>(raw, LAYER_STATUSES, 'manualStatus');
        // Invariant 6: freezing is a claim that a canonical artifact exists, and
        // POST /freeze refuses without one. Pinning the status would have been a
        // way around that guard, persisting FROZEN on a layer with no documents.
        if (status === 'FROZEN') {
          throw badRequest(
            'A layer cannot be pinned to FROZEN. Freeze it through POST /api/layers/:layerId/freeze, ' +
              'which checks that a canonical document actually exists.',
          );
        }
        setLayerManualStatus(
          layer.id,
          status,
          optionalString(body['manualStatusReason'], 'manualStatusReason'),
        );
      }
    } else if ('manualStatusReason' in body) {
      updateLayer(layer.id, {
        manualStatusReason: nullableString(body['manualStatusReason'], 'manualStatusReason') ?? null,
      });
    }

    recomputeProject(layer.projectId);
    return {
      layer: requireLayer(layer.id),
      state: computeLayerState(layer.id),
      plan: buildPlan(layer.projectId),
    };
  }),
);

/**
 * The packet manifest, before the audit runs.
 *
 * Section 17: flag missing or blocked siblings BEFORE starting, so the user is
 * not told at the end that the layer verdict was impossible all along.
 */
layersRouter.get(
  '/:layerId/packet-manifest',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const context = buildAuditContext({ mode: 'LAYER_PACKET', layerId: layer.id });
    return {
      layer,
      manifest: context.manifest,
      dependencies: context.dependencies,
      auditable: context.manifest.complete && context.artifacts.length > 0,
    };
  }),
);

layersRouter.post(
  '/:layerId/expectations/derive',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    deriveLayerExpectationsFromDocuments(layer.id);
    recomputeProject(layer.projectId);
    return {
      layer: requireLayer(layer.id),
      state: computeLayerState(layer.id),
      plan: buildPlan(layer.projectId),
    };
  }),
);

layersRouter.post(
  '/:layerId/freeze',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const body = bodyOf(req);
    const canonicalDocumentId = optionalString(body['canonicalDocumentId'], 'canonicalDocumentId');
    if (canonicalDocumentId) {
      const document = requireDocument(canonicalDocumentId);
      if (document.layerId !== layer.id) {
        throw badRequest(`"${document.canonicalName}" belongs to a different layer.`);
      }
    }

    asInvariantViolation(() => freezeLayer(layer.id, canonicalDocumentId ?? null));
    recomputeProject(layer.projectId);
    return { state: computeLayerState(layer.id), plan: buildPlan(layer.projectId) };
  }),
);

layersRouter.post(
  '/:layerId/reopen',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const reason = requiredString(bodyOf(req)['reason'], 'reason');

    asInvariantViolation(() => reopenLayer(layer.id, reason));
    recomputeProject(layer.projectId);
    return { state: computeLayerState(layer.id), plan: buildPlan(layer.projectId) };
  }),
);

layersRouter.post(
  '/:layerId/synthesis',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const body = bodyOf(req);
    const override = optionalBoolean(body['override'], 'override') ?? false;
    const overrideReason = nullableString(body['overrideReason'], 'overrideReason') ?? null;

    // An incomplete packet throws DependencyError, which the error middleware
    // turns into 409 + the full check result (invariant 4).
    const prepared = asInvariantViolation(() =>
      prepareSynthesis({ layerId: layer.id, override, overrideReason }),
    );

    recomputeProject(layer.projectId);
    return {
      run: prepared.run,
      document: prepared.document,
      dependencies: prepared.dependencies,
      compiled: prepared.compiled,
      plan: buildPlan(layer.projectId),
    };
  }),
);

layersRouter.post(
  '/:layerId/runs',
  handler((req) => {
    const layer = requireLayer(pathId(req, 'layerId'));
    const project = projectOfLayer(layer);
    const body = bodyOf(req);

    const runType = requiredEnum<RunType>(body['runType'], RUN_TYPES, 'runType');
    const targetVersion = parseVersion(body['targetVersion'], 'targetVersion') ?? null;
    const requiredDocuments = optionalStringArray(body['requiredDocuments'], 'requiredDocuments') ?? null;
    const objective = nullableString(body['objective'], 'objective') ?? null;
    const scope = nullableString(body['scope'], 'scope') ?? null;
    const researchQuestions = optionalStringArray(body['researchQuestions'], 'researchQuestions') ?? null;
    const model = optionalString(body['model'], 'model') ?? null;

    const providerName = optionalString(body['provider'], 'provider') ?? null;
    if (providerName) {
      try {
        getProvider(providerName);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    // Synthesis has its own guarantees — the expected document, the validated
    // packet, the override record — so it is never created by the generic path.
    if (runType === 'SYNTHESIS') {
      // The canonical synthesis version is fixed by project policy — section 8:
      // "Do not invent v3.2 automatically." Silently ignoring a different
      // targetVersion would hand back a run for a document the user did not ask
      // for, so say so instead.
      const policyVersion = synthesisVersion(project.versionPolicy);
      if (targetVersion && normalizeVersion(targetVersion) !== policyVersion) {
        throw badRequest(
          `This project's canonical synthesis version is ${policyVersion}, so a synthesis run ` +
            `cannot target ${normalizeVersion(targetVersion)}. Change the project's version policy ` +
            `if that is really what you want.`,
        );
      }
      const prepared = prepareSynthesis({ layerId: layer.id, override: false, overrideReason: null });
      const run =
        providerName || model
          ? (updateRun(prepared.run.id, { provider: providerName, model }) ?? prepared.run)
          : prepared.run;
      recomputeProject(layer.projectId);
      return {
        run,
        compiled: prepared.compiled,
        dependencies: prepared.dependencies,
        plan: buildPlan(layer.projectId),
      };
    }

    const compiled = compilePrompt({
      projectId: project.id,
      layerId: layer.id,
      runType,
      targetVersion,
      requiredDocuments,
      objective,
      scope,
      researchQuestions,
    });

    const created = getDb().transaction(() => {
      // The prompt and its attachment list are stored with the run at creation
      // time, so what was asked for is always recoverable (invariant 10).
      const run = createRun({
        projectId: project.id,
        layerId: layer.id,
        runType,
        targetVersion: compiled.targetVersion,
        status: 'PLANNED',
        provider: providerName,
        model,
        prompt: compiled.prompt,
        promptSections: compiled.sections,
        requiredAttachments: compiled.requiredAttachments,
        expectedConversationTitle: compiled.expectedConversationTitle,
        expectedFilename: compiled.expectedFilename,
      });

      setRunDependencies(run.id, compiled.requiredAttachments, {
        dependencyType: runType === 'AUDIT' || runType === 'CROSS_LAYER_AUDIT' ? 'AUDIT_INPUT' : 'SOURCE_PACKET',
      });
      const dependencies = checkRunDependencies(run.id);
      const status: RunStatus = dependencies.ready ? 'READY' : 'BLOCKED';
      const stored = updateRun(run.id, { status }) ?? run;

      recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'RUN',
        entityId: stored.id,
        eventType: 'RUN_CREATED',
        payload: {
          runType,
          targetVersion: compiled.targetVersion,
          targetCanonicalName: compiled.targetCanonicalName,
          status,
          dependencies: dependencies.summary,
        },
      });
      recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'RUN',
        entityId: stored.id,
        eventType: 'RUN_PROMPT_COMPILED',
        payload: {
          sections: compiled.sections.map((section) => section.key),
          requiredAttachments: compiled.requiredAttachments,
          expectedConversationTitle: compiled.expectedConversationTitle,
          expectedFilename: compiled.expectedFilename,
        },
      });

      return { run: stored, dependencies };
    });

    recomputeProject(project.id);
    return {
      run: created.run,
      compiled,
      dependencies: created.dependencies,
      plan: buildPlan(project.id),
    };
  }),
);
