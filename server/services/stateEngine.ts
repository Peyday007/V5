/**
 * Automatic project-state engine (section 4).
 *
 * The whole product promise lives here: the event that changes reality updates
 * the database, so the user only ever has to REFRESH. Every service calls
 * `recomputeProject` (or `recomputeLayer`) after it changes anything, and layer
 * status is *derived* from documents, runs, audits, dependencies and the
 * filesystem — never remembered from a chat transcript (invariants 7 and 12).
 *
 * Status is derived by a fixed, ordered rule list; the first rule that matches
 * wins and its `reason` is the sentence the UI shows. A human may pin a status
 * (`status_source = MANUAL`), in which case the pinned value is returned but the
 * derived value is still computed and reported so the divergence is visible.
 */
import type {
  AuditVerdict,
  DependencyCheckItem,
  Document,
  Layer,
  LayerStateSnapshot,
  LayerStatus,
  ResearchRun,
  RunStatus,
  VersionPolicy,
} from '../domain/types.ts';
import { DEFAULT_VERSION_POLICY } from '../domain/types.ts';
import { buildCanonicalName } from '../domain/naming.ts';
import {
  maxVersion,
  nextExpansionVersion,
  normalizeVersion,
  sortVersions,
  synthesisVersion,
  waveForVersion,
} from '../domain/version.ts';
import { getDb } from '../db/database.ts';
import { getLatestAuditForDocument, getLatestAuditForLayer } from '../repos/audits.ts';
import { listDocuments, listDocumentsByLayer, updateDocument } from '../repos/documents.ts';
import { listEventsByLayer, recordEvent } from '../repos/events.ts';
import { getLayer, listLayers, updateLayer, type UpdateLayerInput } from '../repos/layers.ts';
import { getProject, updateProject } from '../repos/projects.ts';
import { listRunsByLayer } from '../repos/runs.ts';
import {
  checkCanonicalNames,
  checkDocumentDependencies,
  checkRunDependencies,
  documentPresence,
  refreshProjectDependencies,
} from './dependencies.ts';
import { fileExists } from './storage.ts';
import { writeProjectState } from './runtimeState.ts';

/** Runs that still owe the project something, and therefore shape layer state. */
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'PLANNED',
  'READY',
  'RUNNING',
  'BLOCKED',
  'AUDIT_REQUIRED',
  'REDO_REQUIRED',
]);

/** Verdicts that send the layer back for more work rather than forward. */
const MORE_RESEARCH_VERDICTS: ReadonlySet<AuditVerdict> = new Set<AuditVerdict>([
  'REDO',
  'MORE_RESEARCH',
  'PATCH',
]);

interface DerivedStatus {
  status: LayerStatus;
  reason: string;
  nextAction: string;
  nextVersion: string | null;
}

interface LayerDerivation {
  snapshot: LayerStateSnapshot;
  /** Persisted by `recomputeLayer`; not part of the public snapshot shape. */
  canonicalDocumentId: string | null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** `Run Discovery Logic v1G.` — the platform's one phrasing for "produce this". */
function runSentence(layerName: string, version: string): string {
  return `Run ${buildCanonicalName(layerName, version)}.`;
}

function describeTarget(layerName: string, run: ResearchRun): string {
  return run.targetVersion ? buildCanonicalName(layerName, run.targetVersion) : layerName;
}

/** `EXPANSION` -> `an expansion`, so reasons read as sentences rather than enums. */
function describeRunType(runType: string): string {
  const words = runType.toLowerCase().replace(/_/g, ' ');
  return `${'aeiou'.includes(words.charAt(0)) ? 'an' : 'a'} ${words}`;
}

/**
 * The ordered rule list from section 4. First match wins; every branch also
 * answers "what should I do next?" so the planner never has to guess.
 */
function deriveStatus(input: {
  layer: Layer;
  policy: VersionPolicy;
  documents: Document[];
  presentDocuments: Document[];
  runs: ResearchRun[];
  activeRuns: ResearchRun[];
  expectedVersions: string[];
  missingVersions: string[];
  currentVersion: string | null;
  missingDependencyItems: DependencyCheckItem[];
  /** How many documents a MISSING_DEPENDENCY/BLOCKED audit actually named. */
  auditNamedDocumentCount: number;
  /** Set while a reopen is still the most recent thing to happen to the layer. */
  reopenedPending: boolean;
  frozenCanonical: Document | null;
  latestVerdict: AuditVerdict | null;
  latestAuditNextVersion: string | null;
}): DerivedStatus {
  const {
    layer,
    policy,
    documents,
    presentDocuments,
    runs,
    activeRuns,
    expectedVersions,
    missingVersions,
    currentVersion,
    missingDependencyItems,
    auditNamedDocumentCount,
    reopenedPending,
    frozenCanonical,
    latestVerdict,
    latestAuditNextVersion,
  } = input;

  const layerName = layer.name;
  const allVersions = documents.map((document) => document.version);
  const nextExpansion = nextExpansionVersion(allVersions, policy);

  // 1. Parked layers are deliberately out of the plan.
  if (layer.parked) {
    return {
      status: 'PARKED',
      reason: layer.parkedNote
        ? `Layer is parked: ${layer.parkedNote}`
        : 'Layer is parked and excluded from the plan.',
      nextAction: `Unpark ${layerName} when you are ready to resume it.`,
      nextVersion: null,
    };
  }

  // 2. A frozen canonical artifact ends the layer's lifecycle (invariant 6).
  if (frozenCanonical) {
    return {
      status: 'FROZEN',
      reason: `Canonical document ${frozenCanonical.canonicalName} is frozen.`,
      nextAction: `Nothing to do — ${layerName} is frozen at ${frozenCanonical.version}.`,
      nextVersion: null,
    };
  }

  // 2b. A reopen that nothing has happened since. Derived, not pinned: it lapses
  // by itself the moment a run, an audit or a new document arrives, so the
  // derivation engine is never switched off (section 4).
  if (reopenedPending) {
    return {
      status: 'REOPENED',
      reason: `${layerName} was reopened and no research has happened since.`,
      nextAction: `Decide what ${layerName} needs now that it is reopened.`,
      nextVersion: nextExpansion,
    };
  }

  // 3. A synthesis in flight outranks everything else that is merely pending.
  const synthesisRun = runs.find(
    (run) => run.runType === 'SYNTHESIS' && run.status === 'RUNNING',
  );
  if (synthesisRun) {
    const version = synthesisRun.targetVersion ?? synthesisVersion(policy);
    return {
      status: 'SYNTHESIS_RUNNING',
      reason: `Synthesis run for ${buildCanonicalName(layerName, version)} is in progress.`,
      nextAction: `Wait for ${buildCanonicalName(layerName, version)} to finish, then import the report.`,
      nextVersion: version,
    };
  }

  // 4. Freezing is always a human decision, so "ready to freeze" is a ready state.
  if (latestVerdict === 'READY_TO_FREEZE') {
    const version = latestAuditNextVersion ?? currentVersion ?? synthesisVersion(policy);
    return {
      status: 'SYNTHESIS_READY',
      reason: `The latest audit found ${layerName} ready to freeze.`,
      nextAction: `Freeze ${layerName} at ${version}.`,
      nextVersion: version,
    };
  }

  // 5. Audit cleared the expansion wave — synthesis is the next artifact.
  if (latestVerdict === 'READY_FOR_SYNTHESIS') {
    const version = latestAuditNextVersion ?? synthesisVersion(policy);
    return {
      status: 'SYNTHESIS_READY',
      reason: `The latest audit cleared ${layerName} for synthesis.`,
      nextAction: runSentence(layerName, version),
      nextVersion: version,
    };
  }

  // 6. The audit sent work back.
  if (latestVerdict && MORE_RESEARCH_VERDICTS.has(latestVerdict)) {
    const version = latestAuditNextVersion ?? nextExpansion;
    return {
      status: 'MORE_RESEARCH_REQUIRED',
      reason: `The latest audit returned ${latestVerdict}; more research is required.`,
      nextAction: runSentence(layerName, version),
      nextVersion: version,
    };
  }

  // 7. Missing inputs (invariant 4): never let synthesis proceed on a hole.
  // A blocking verdict names the documents it wants. Once every one of them has
  // arrived the layer must move on by itself — spec section 18: uploading the
  // missing dependency is what unblocks the work, not re-running the audit. A
  // verdict that named nothing has no automatic resolution, so it keeps blocking
  // until a human acts.
  const blockedByAudit =
    (latestVerdict === 'MISSING_DEPENDENCY' || latestVerdict === 'BLOCKED') &&
    (auditNamedDocumentCount === 0 || missingDependencyItems.length > 0);
  if (blockedByAudit || missingDependencyItems.length > 0) {
    const names = unique(missingDependencyItems.map((item) => item.canonicalName));
    const first = missingDependencyItems[0] ?? null;
    const reason =
      names.length > 0
        ? `${names.length} required ${names.length === 1 ? 'document is' : 'documents are'} missing: ${names.join(', ')}.`
        : `The latest audit reported ${latestVerdict} for ${layerName}.`;
    let nextAction = `Resolve what is blocking ${layerName}.`;
    if (first) {
      if (first.fileMissing) nextAction = `Restore the file for ${first.canonicalName}.`;
      else if (first.documentId) nextAction = `Finish ${first.canonicalName}.`;
      else nextAction = `Run ${first.canonicalName}.`;
    }
    return {
      status: 'BLOCKED',
      reason,
      nextAction,
      nextVersion: activeRuns.find((run) => run.targetVersion)?.targetVersion ?? null,
    };
  }

  // 8. Something is genuinely executing.
  const runningRun = runs.find((run) => run.status === 'RUNNING');
  if (runningRun) {
    const target = describeTarget(layerName, runningRun);
    return {
      status: 'RESEARCHING',
      reason: `There is ${describeRunType(runningRun.runType)} run in progress for ${target}.`,
      nextAction: `Wait for ${target} to finish, then import the report.`,
      nextVersion: runningRun.targetVersion,
    };
  }

  // 9. Finished, complete, and nobody has inspected it yet.
  const unaudited = presentDocuments.find(
    (document) => getLatestAuditForDocument(document.id) === null,
  );
  if (unaudited && missingVersions.length === 0) {
    return {
      status: 'AUDIT_READY',
      reason: `${unaudited.canonicalName} is complete and has not been audited.`,
      nextAction: `Audit ${unaudited.canonicalName}.`,
      nextVersion: unaudited.version,
    };
  }

  // 10. An audit is under way or a completed run is waiting for its verdict.
  const auditingRun = runs.find(
    (run) => (run.runType === 'AUDIT' && run.status === 'RUNNING') || run.status === 'AUDIT_REQUIRED',
  );
  if (auditingRun) {
    const target = describeTarget(layerName, auditingRun);
    return {
      status: 'AUDITING',
      reason:
        auditingRun.status === 'RUNNING'
          ? `An audit run for ${target} is in progress.`
          : `${target} is waiting for its audit result.`,
      nextAction: `Record the audit result for ${target}.`,
      nextVersion: auditingRun.targetVersion,
    };
  }

  // 11. The layer declared what it expects and has not got there yet.
  const firstMissing = missingVersions[0];
  if (firstMissing) {
    return {
      status: 'INCOMPLETE',
      reason: `${missingVersions.length} of ${expectedVersions.length} expected versions are still missing.`,
      nextAction: runSentence(layerName, firstMissing),
      nextVersion: firstMissing,
    };
  }

  // 12. Nothing exists yet — start the foundation.
  if (documents.length === 0) {
    const version = normalizeVersion(policy.foundationVersion);
    return {
      status: 'NOT_STARTED',
      reason: 'No documents have been registered for this layer yet.',
      nextAction: runSentence(layerName, version),
      nextVersion: version,
    };
  }

  // 13. Work in progress with nothing blocking it: widen the expansion wave.
  return {
    status: 'RESEARCHING',
    reason: `${presentDocuments.length} document${presentDocuments.length === 1 ? '' : 's'} complete; nothing blocks further expansion.`,
    nextAction: runSentence(layerName, nextExpansion),
    nextVersion: nextExpansion,
  };
}

/** Everything `computeLayerState` needs, gathered from the database + disk. */
function deriveLayer(layerId: string): LayerDerivation {
  const layer = getLayer(layerId);
  if (!layer) throw new Error(`Cannot compute layer state: unknown layer ${layerId}`);
  const project = getProject(layer.projectId);
  const policy: VersionPolicy = project?.versionPolicy ?? DEFAULT_VERSION_POLICY;

  const documents = listDocumentsByLayer(layerId);
  const runs = listRunsByLayer(layerId);
  const activeRuns = runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));

  // One stat per document: the filesystem is consulted, not assumed.
  const presence = new Map(documents.map((document) => [document.id, documentPresence(document)]));
  const presentDocuments = documents.filter((document) => presence.get(document.id)?.present === true);
  const inconsistentDocuments = documents
    .filter((document) => presence.get(document.id)?.fileMissing === true)
    .map((document) => document.canonicalName);

  const presentVersions = sortVersions(
    unique(presentDocuments.map((document) => normalizeVersion(document.version))),
  );
  const expectedVersions = sortVersions(
    unique(layer.expectedVersions.map((version) => normalizeVersion(version))),
  );
  const missingVersions = expectedVersions.filter((version) => !presentVersions.includes(version));

  // A layer that has documents must never read as 0 / 0: with no declared
  // expectations the present documents become their own denominator.
  const documentsExpected = expectedVersions.length > 0 ? expectedVersions.length : presentDocuments.length;
  const documentsComplete =
    expectedVersions.length > 0 ? expectedVersions.length - missingVersions.length : presentDocuments.length;

  const currentVersion = maxVersion(presentVersions);

  // Prefer the recorded canonical document while it is still canonical, so a
  // deliberate human choice survives recomputation.
  const canonicalDocument =
    documents.find(
      (document) => document.id === layer.canonicalDocumentId && (document.isCanonical || document.frozen),
    ) ??
    documents.find((document) => document.isCanonical) ??
    null;
  const frozenCanonical =
    documents.find(
      (document) =>
        document.frozen && (document.isCanonical || document.id === layer.canonicalDocumentId),
    ) ?? null;

  // Missing inputs come from the work that is still owed: active runs and
  // documents that have not been produced yet. An explicit human override
  // (invariant 4) removes a run from the blocking set.
  const missingDependencyItems: DependencyCheckItem[] = [];
  const seenMissing = new Set<string>();
  const collect = (items: DependencyCheckItem[]): void => {
    for (const item of items) {
      if (!item.required || item.present) continue;
      const key = item.canonicalName.toLowerCase();
      if (seenMissing.has(key)) continue;
      seenMissing.add(key);
      missingDependencyItems.push(item);
    }
  };
  for (const run of activeRuns) {
    if (run.dependencyOverride) continue;
    collect(checkRunDependencies(run.id).items);
  }
  for (const document of documents) {
    if (document.status === 'COMPLETE' || document.status === 'FROZEN' || document.status === 'SUPERSEDED') {
      continue;
    }
    collect(checkDocumentDependencies(document.id).items);
  }

  const latestAudit = getLatestAuditForLayer(layerId);
  // An audit that declared the layer blocked names the documents it wanted.
  // They are re-checked against reality rather than trusted, so a document that
  // has since been imported does not keep the layer blocked.
  let auditNamedDocumentCount = 0;
  if (latestAudit && (latestAudit.verdict === 'MISSING_DEPENDENCY' || latestAudit.verdict === 'BLOCKED')) {
    const named = unique(
      latestAudit.findings
        .filter((finding) => finding.findingType === 'MISSING_DOCUMENT')
        .map((finding) => finding.content.trim())
        .filter((content) => content.length > 0),
    );
    auditNamedDocumentCount = named.length;
    if (named.length > 0) collect(checkCanonicalNames(layer.projectId, named).items);
  }

  // A reopen stands only until real work resumes. Comparing it against the
  // newest run, audit and document means the state clears itself rather than
  // needing a human to unpin it.
  const reopenedAt =
    listEventsByLayer(layerId, 50).find((event) => event.eventType === 'LAYER_REOPENED')?.createdAt ??
    null;
  const latestActivityAt = [
    ...runs.map((run) => run.createdAt),
    ...(latestAudit ? [latestAudit.createdAt] : []),
    ...documents.map((document) => document.createdAt),
  ].reduce<string | null>((max, at) => (max === null || at > max ? at : max), null);
  const reopenedPending =
    reopenedAt !== null && (latestActivityAt === null || reopenedAt > latestActivityAt);

  const derived = deriveStatus({
    layer,
    policy,
    documents,
    presentDocuments,
    runs,
    activeRuns,
    expectedVersions,
    missingVersions,
    currentVersion,
    missingDependencyItems,
    auditNamedDocumentCount,
    reopenedPending,
    frozenCanonical,
    latestVerdict: latestAudit?.verdict ?? null,
    latestAuditNextVersion: latestAudit?.nextVersion ?? null,
  });

  // A pinned status wins, but the derived answer is still reported so the UI can
  // show the divergence instead of hiding it.
  const pinned = layer.statusSource === 'MANUAL' ? layer.manualStatus : null;
  const status = pinned ?? derived.status;
  const reason = pinned
    ? `Status is pinned manually to ${pinned}${layer.manualStatusReason ? ` (${layer.manualStatusReason})` : ''}. Derived status would be ${derived.status}: ${derived.reason}`
    : derived.reason;

  const currentDocument =
    presentDocuments.find((document) => normalizeVersion(document.version) === currentVersion) ?? null;

  const snapshot: LayerStateSnapshot = {
    layerId: layer.id,
    layerName: layer.name,
    status,
    statusSource: layer.statusSource,
    reason,
    currentVersion,
    canonicalName:
      frozenCanonical?.canonicalName ??
      canonicalDocument?.canonicalName ??
      currentDocument?.canonicalName ??
      null,
    expectedVersions,
    presentVersions,
    missingVersions,
    documentsComplete,
    documentsExpected,
    activeRunIds: activeRuns.map((run) => run.id),
    missingDependencies: missingDependencyItems.map((item) => item.canonicalName),
    inconsistentDocuments,
    latestAuditVerdict: latestAudit?.verdict ?? null,
    frozen: status === 'FROZEN',
    parked: layer.parked,
    nextAction: derived.nextAction,
    nextVersion: derived.nextVersion,
  };

  return { snapshot, canonicalDocumentId: canonicalDocument?.id ?? frozenCanonical?.id ?? null };
}

/** Pure derivation — reads the database and the filesystem, writes nothing. */
export function computeLayerState(layerId: string): LayerStateSnapshot {
  return deriveLayer(layerId).snapshot;
}

/**
 * Derive, persist onto the layer row, and log `LAYER_STATUS_CHANGED` only when
 * the status actually moved — invariant 3 asks for an event per important
 * action, not an event per page refresh.
 */
export function recomputeLayer(layerId: string): LayerStateSnapshot {
  const db = getDb();
  return db.transaction(() => {
    const before = getLayer(layerId);
    if (!before) throw new Error(`Cannot recompute layer: unknown layer ${layerId}`);
    const { snapshot, canonicalDocumentId } = deriveLayer(layerId);

    // A layer's wave is simply where its furthest document sits: v1 is wave 1,
    // sibling expansions wave 2, the canonical synthesis wave 3.
    const policy = getProject(before.projectId)?.versionPolicy ?? DEFAULT_VERSION_POLICY;
    const currentWave = snapshot.currentVersion
      ? Math.max(1, waveForVersion(snapshot.currentVersion, policy))
      : 1;

    const patch: UpdateLayerInput = {};
    if (before.status !== snapshot.status) patch.status = snapshot.status;
    if (before.currentVersion !== snapshot.currentVersion) patch.currentVersion = snapshot.currentVersion;
    if (before.canonicalDocumentId !== canonicalDocumentId) patch.canonicalDocumentId = canonicalDocumentId;
    if (before.currentWave !== currentWave) patch.currentWave = currentWave;
    if (Object.keys(patch).length > 0) updateLayer(layerId, patch);

    if (before.status !== snapshot.status) {
      recordEvent({
        projectId: before.projectId,
        layerId,
        entityType: 'LAYER',
        entityId: layerId,
        eventType: 'LAYER_STATUS_CHANGED',
        payload: {
          from: before.status,
          to: snapshot.status,
          statusSource: snapshot.statusSource,
          reason: snapshot.reason,
          currentVersion: snapshot.currentVersion,
        },
      });
    }
    return snapshot;
  });
}

/**
 * Stat every registered artifact and flip `documents.file_missing` in both
 * directions. Invariants 8 and 9: the database is never allowed to keep
 * claiming a file that is not there, and a file that comes back is healed
 * automatically rather than needing a manual fix.
 */
export function recomputeDocumentFileState(projectId: string): {
  missing: string[];
  restored: string[];
} {
  const db = getDb();
  return db.transaction(() => {
    const missing: string[] = [];
    const restored: string[] = [];
    for (const document of listDocuments(projectId)) {
      // No recorded path means nothing was ever stored for this row (an
      // expected document); there is no file to have lost.
      if (!document.filesystemPath) continue;
      const onDisk = fileExists(document.filesystemPath);
      if (!onDisk && !document.fileMissing) {
        updateDocument(document.id, { fileMissing: true });
        recordEvent({
          projectId,
          layerId: document.layerId,
          entityType: 'DOCUMENT',
          entityId: document.id,
          eventType: 'DOCUMENT_FILE_MISSING',
          payload: { canonicalName: document.canonicalName, path: document.filesystemPath },
        });
        missing.push(document.canonicalName);
      } else if (onDisk && document.fileMissing) {
        updateDocument(document.id, { fileMissing: false });
        recordEvent({
          projectId,
          layerId: document.layerId,
          entityType: 'DOCUMENT',
          entityId: document.id,
          eventType: 'DOCUMENT_FILE_RESTORED',
          payload: { canonicalName: document.canonicalName, path: document.filesystemPath },
        });
        restored.push(document.canonicalName);
      }
    }
    return { missing, restored };
  });
}

/** Depth guard: the runtime-state writer reads derived state and must not recurse. */
let recomputeDepth = 0;

/**
 * The one entry point after any meaningful change. Order matters: the
 * filesystem is the outer truth, dependencies resolve against it, layer status
 * derives from the resolved dependencies, and only then is the derived runtime
 * snapshot written for the UI.
 */
export function recomputeProject(projectId: string): LayerStateSnapshot[] {
  recomputeDepth += 1;
  try {
    const db = getDb();
    const snapshots = db.transaction(() => {
      recomputeDocumentFileState(projectId);
      refreshProjectDependencies(projectId);
      const results = listLayers(projectId).map((layer) => recomputeLayer(layer.id));

      // The project's wave is the furthest any layer has reached, so the header
      // advances on its own instead of being edited by hand.
      const project = getProject(projectId);
      if (project) {
        const wave = listLayers(projectId).reduce((max, layer) => Math.max(max, layer.currentWave), 1);
        if (project.currentWave !== wave) updateProject(projectId, { currentWave: wave });
      }
      return results;
    });
    if (recomputeDepth === 1) {
      try {
        writeProjectState(projectId);
      } catch {
        // project-state.json is a derived cache; SQLite stays authoritative, so
        // a read-only or missing runtime directory must never fail a recompute.
      }
    }
    return snapshots;
  } finally {
    recomputeDepth -= 1;
  }
}

/**
 * Pin (or release) a layer status by hand. The derived status keeps being
 * computed underneath so the UI can show "you pinned FROZEN, the data says
 * BLOCKED".
 */
export function setLayerManualStatus(
  layerId: string,
  status: LayerStatus | null,
  reason?: string,
): LayerStateSnapshot {
  const db = getDb();
  return db.transaction(() => {
    const before = getLayer(layerId);
    if (!before) throw new Error(`Cannot set manual status: unknown layer ${layerId}`);
    updateLayer(layerId, {
      statusSource: status ? 'MANUAL' : 'DERIVED',
      manualStatus: status,
      manualStatusReason: status ? (reason ?? null) : null,
    });
    recordEvent({
      projectId: before.projectId,
      layerId,
      entityType: 'LAYER',
      entityId: layerId,
      eventType: 'USER_CORRECTION',
      payload: {
        field: 'status',
        from: before.status,
        manualStatus: status,
        released: status === null,
        reason: reason ?? null,
      },
    });
    return recomputeLayer(layerId);
  });
}

/**
 * Declare which versions a layer owes, e.g. `["v1","v1B","v1C"]`. This is what
 * turns a vague "keep researching" into `6 / 7` and a concrete next version.
 */
export function setLayerExpectations(layerId: string, expectedVersions: string[]): LayerStateSnapshot {
  const db = getDb();
  return db.transaction(() => {
    const before = getLayer(layerId);
    if (!before) throw new Error(`Cannot set expectations: unknown layer ${layerId}`);
    const normalized = sortVersions(unique(expectedVersions.map((version) => normalizeVersion(version))));
    updateLayer(layerId, { expectedVersions: normalized });
    recordEvent({
      projectId: before.projectId,
      layerId,
      entityType: 'LAYER',
      entityId: layerId,
      eventType: 'LAYER_EXPECTATIONS_CHANGED',
      payload: { from: before.expectedVersions, to: normalized },
    });
    return recomputeLayer(layerId);
  });
}

/**
 * Adopt reality as the expectation: used straight after a bulk import, when the
 * documents on disk are the best statement of what the layer actually contains.
 */
export function deriveLayerExpectationsFromDocuments(layerId: string): LayerStateSnapshot {
  const present = listDocumentsByLayer(layerId)
    .filter((document) => documentPresence(document).present)
    .map((document) => document.version);
  return setLayerExpectations(layerId, present);
}
