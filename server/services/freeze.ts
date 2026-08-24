/**
 * Freeze semantics (section 15).
 *
 * Invariant 6: a layer is never frozen without a canonical artifact. Freezing
 * is the moment a layer stops being a pile of research and becomes one
 * document the rest of the project may depend on, so the platform refuses to
 * do it on a promise — the artifact must exist, be finished, and still be on
 * disk.
 *
 * Superseded documents are never deleted. They stay as provenance: the reason
 * the canonical document says what it says.
 */
import type { Document, LayerStateSnapshot, VersionPolicy } from '../domain/types.ts';
import { DEFAULT_VERSION_POLICY } from '../domain/types.ts';
import { buildCanonicalName } from '../domain/naming.ts';
import { compareVersions, normalizeVersion, synthesisVersion } from '../domain/version.ts';
import { getDb } from '../db/database.ts';
import { getDocument, listDocumentsByLayer, updateDocument } from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getLayer, updateLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { checkCanonicalNames } from './dependencies.ts';
import { computeLayerState, recomputeProject } from './stateEngine.ts';

/** Document types that a canonical artifact replaces. Audits and reference material are not research output. */
const SUPERSEDABLE_TYPES = new Set(['FOUNDATION', 'EXPANSION', 'PATCH', 'SYNTHESIS', 'CANONICAL']);

/** Older than the canonical document: by version, then by creation time. */
function isEarlierThan(document: Document, canonical: Document): boolean {
  const byVersion = compareVersions(document.version, canonical.version);
  if (byVersion !== 0) return byVersion < 0;
  return document.createdAt < canonical.createdAt;
}

async function snapshotFor(projectId: string, layerId: string): Promise<LayerStateSnapshot> {
  const snapshots = await recomputeProject(projectId);
  return snapshots.find((snapshot) => snapshot.layerId === layerId) ?? await computeLayerState(layerId);
}

/**
 * Freeze a layer on one canonical artifact.
 *
 * The artifact is the explicitly named document, or else the layer's synthesis
 * document. If neither exists the freeze is refused with a message that names
 * the document the layer is waiting for, because "no canonical artifact" is
 * useless to a user who wants to know what to do next.
 */
export async function freezeLayer(layerId: string, canonicalDocumentId?: string | null): Promise<LayerStateSnapshot> {
  const layer = await getLayer(layerId);
  if (!layer) throw new Error(`Cannot freeze: unknown layer ${layerId}`);
  const project = await getProject(layer.projectId);
  if (!project) throw new Error(`Cannot freeze ${layer.name}: unknown project ${layer.projectId}`);
  const policy: VersionPolicy = project.versionPolicy ?? DEFAULT_VERSION_POLICY;

  const documents = await listDocumentsByLayer(layerId);
  const expectedCanonicalVersion = normalizeVersion(synthesisVersion(policy));

  let canonical: Document | null = null;
  if (canonicalDocumentId) {
    const explicit = await getDocument(canonicalDocumentId);
    if (!explicit) {
      throw new Error(`Cannot freeze ${layer.name}: document ${canonicalDocumentId} does not exist.`);
    }
    if (explicit.layerId !== layerId) {
      throw new Error(
        `Cannot freeze ${layer.name}: ${explicit.canonicalName} belongs to a different layer.`,
      );
    }
    canonical = explicit;
  } else {
    canonical =
      documents.find(
        (document) => normalizeVersion(document.version) === expectedCanonicalVersion,
      ) ?? null;
  }

  if (!canonical) {
    throw new Error(
      `Cannot freeze ${layer.name}: there is no canonical artifact. ` +
        `Expected ${buildCanonicalName(layer.name, expectedCanonicalVersion)} to exist — ` +
        'run the synthesis and import its report, or name the document to freeze explicitly.',
    );
  }

  // The row is not the artifact: the file has to be there too (invariants 8, 9).
  const presence = await checkCanonicalNames(layer.projectId, [canonical.canonicalName]);
  const item = presence.items[0];
  if (!item || !item.present) {
    const detail = item?.fileMissing
      ? 'its file is missing from disk'
      : `its status is ${canonical.status}`;
    throw new Error(
      `Cannot freeze ${layer.name}: ${canonical.canonicalName} is not a usable artifact (${detail}). ` +
        'Import the finished document before freezing.',
    );
  }

  const target = canonical;
  const db = getDb();
  await db.transaction(async () => {
    await updateDocument(target.id, { isCanonical: true, frozen: true, status: 'FROZEN' });

    const replaced: string[] = [];
    for (const document of documents) {
      if (document.id === target.id) continue;
      if (!SUPERSEDABLE_TYPES.has(document.documentType)) continue;
      if (!isEarlierThan(document, target)) continue;
      if (document.status === 'SUPERSEDED' && !document.isCanonical && !document.frozen) continue;

      // History is provenance: the row is kept, relabelled, and pointed at its
      // successor. Nothing is ever deleted here.
      await updateDocument(document.id, {
        status: 'SUPERSEDED',
        supersededByDocumentId: target.id,
        isCanonical: false,
        frozen: false,
      });
      await recordEvent({
        projectId: layer.projectId,
        layerId,
        entityType: 'DOCUMENT',
        entityId: document.id,
        eventType: 'DOCUMENT_SUPERSEDED',
        payload: {
          canonicalName: document.canonicalName,
          supersededBy: target.canonicalName,
          supersededByDocumentId: target.id,
        },
      });
      replaced.push(document.canonicalName);
    }

    // A freeze is a decision about reality, so any manual pin is released and
    // the derived engine is allowed to agree with it.
    await updateLayer(layerId, {
      canonicalDocumentId: target.id,
      currentVersion: target.version,
      status: 'FROZEN',
      statusSource: 'DERIVED',
      manualStatus: null,
      manualStatusReason: null,
    });

    await recordEvent({
      projectId: layer.projectId,
      layerId,
      entityType: 'LAYER',
      entityId: layerId,
      eventType: 'LAYER_FROZEN',
      payload: {
        canonicalDocumentId: target.id,
        canonicalName: target.canonicalName,
        version: target.version,
        supersededDocuments: replaced,
        explicit: Boolean(canonicalDocumentId),
      },
    });
  });

  // Freezing publishes an artifact the rest of the project may depend on, so the
  // recompute is what unblocks other layers waiting on this document.
  return snapshotFor(layer.projectId, layerId);
}

/**
 * Reopen a frozen layer. The freeze is lifted, but nothing is erased: the
 * canonical document keeps its identity and every superseded document keeps its
 * history. The status is pinned to REOPENED with the stated reason, because
 * REOPENED is a human decision that no derivation rule can produce.
 */
export async function reopenLayer(layerId: string, reason: string): Promise<LayerStateSnapshot> {
  const layer = await getLayer(layerId);
  if (!layer) throw new Error(`Cannot reopen: unknown layer ${layerId}`);
  const reasonText = (reason ?? '').trim() || 'Reopened without a stated reason.';

  const db = getDb();
  await db.transaction(async () => {
    // Freezing marks the provenance SUPERSEDED and the canonical document
    // FROZEN. Reopening has to undo both, or the layer's own source packet stays
    // unusable and it can never be re-synthesised — the packet would report
    // "1 / 4 READY" for documents that are registered and sitting on disk.
    const canonicalId = layer.canonicalDocumentId;
    const thawed: string[] = [];
    for (const document of await listDocumentsByLayer(layerId)) {
      const wasFrozen = document.frozen || document.status === 'FROZEN';
      // Exactly the documents this freeze pushed aside — identified by the
      // successor link the freeze wrote — not every superseded row in the layer.
      const supersededByThisFreeze =
        document.status === 'SUPERSEDED' &&
        canonicalId !== null &&
        document.supersededByDocumentId === canonicalId;
      if (!wasFrozen && !supersededByThisFreeze) continue;
      await updateDocument(document.id, {
        status: 'COMPLETE',
        ...(wasFrozen ? { frozen: false, isCanonical: false } : {}),
        ...(supersededByThisFreeze ? { supersededByDocumentId: null } : {}),
      });
      thawed.push(document.canonicalName);
    }

    // Status stays DERIVED. Pinning it would freeze the derivation engine on
    // REOPENED for good, masking every later audit and blockage, and the UI has
    // no control to release a pin. REOPENED is derived instead, and lapses by
    // itself as soon as real work resumes.
    await updateLayer(layerId, {
      status: 'REOPENED',
      statusSource: 'DERIVED',
      manualStatus: null,
      manualStatusReason: null,
      canonicalDocumentId: null,
    });

    await recordEvent({
      projectId: layer.projectId,
      layerId,
      entityType: 'LAYER',
      entityId: layerId,
      eventType: 'LAYER_REOPENED',
      payload: {
        reason: reasonText,
        canonicalDocumentId: layer.canonicalDocumentId,
        unfrozenDocuments: thawed,
      },
    });
  });

  return snapshotFor(layer.projectId, layerId);
}
