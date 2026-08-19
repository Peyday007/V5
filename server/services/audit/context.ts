/**
 * The audit context builder (section 17).
 *
 * One reusable builder gathers the strongest evidence available without
 * stuffing the whole project into every call. It reads the assignment (the exact
 * prompt that produced the artifact), the artifact itself, the surrounding
 * packet, prior audit findings and the live dependency state.
 *
 * When the material does not fit the budget it is NOT silently summarised away:
 * oversized documents are marked as requiring a staged extraction pass, and the
 * link back to the original content is always preserved.
 */
import type {
  Audit,
  Document,
  Layer,
  Project,
  ResearchRun,
  DependencyCheckResult,
  LayerStateSnapshot,
} from '../../domain/types.ts';
import type { AuditProfile, LayerCriteria } from '../../domain/auditProfile.ts';
import { getAuditProfile, getLayerCriteria } from '../../domain/auditProfile.ts';
import { getProject } from '../../repos/projects.ts';
import { getLayer, listLayers } from '../../repos/layers.ts';
import { getDocument, listDocumentsByLayer } from '../../repos/documents.ts';
import { getRun, listRunsByLayer } from '../../repos/runs.ts';
import { listAuditsByLayer } from '../../repos/audits.ts';
import { fileExists } from '../storage.ts';
import { getCurrentExtractionRun, listBlocks } from '../../repos/extraction.ts';
import { isAuditable } from '../documents/quality.ts';
import { checkCanonicalNames, checkRunDependencies } from '../dependencies.ts';
import { computeLayerState } from '../stateEngine.ts';
import { defaultRequiredDocuments } from '../promptCompiler.ts';
import { sortVersions } from '../../domain/version.ts';

/** Characters of artifact text a single pass may carry before staging kicks in. */
export const DEFAULT_CONTENT_BUDGET = 120_000;
/** Per-document ceiling inside a packet audit, so one giant file cannot crowd out the rest. */
export const PER_DOCUMENT_BUDGET = 40_000;

export interface ArtifactContent {
  documentId: string | null;
  canonicalName: string;
  version: string;
  documentType: string;
  status: string;
  /** Text actually available to the auditor. */
  text: string;
  /** Full extracted length, so truncation is always visible. */
  fullLength: number;
  truncated: boolean;
  /** Why there is no text: missing file, unread document, or a blocked extraction. */
  unavailableReason: string | null;
  filesystemPath: string | null;
  /** Which reading of the document this text came from. */
  extractionRunId: string | null;
  extractionStatus: string;
  pageCount: number | null;
  pagesOcr: number;
  coverageRatio: number;
  extractionWarnings: string[];
}

export interface AuditContext {
  mode: 'SINGLE_DOCUMENT' | 'LAYER_PACKET';
  project: Project;
  layer: Layer;
  layerState: LayerStateSnapshot;
  profile: AuditProfile | null;
  layerCriteria: LayerCriteria | null;
  otherLayers: { name: string; owns: string | null }[];
  /** The run whose work is being audited, when there is one. */
  run: ResearchRun | null;
  /** The exact prompt the artifact was produced from. */
  assignmentPrompt: string | null;
  requiredAttachments: string[];
  dependencies: DependencyCheckResult;
  /** The artifact(s) under audit. */
  artifacts: ArtifactContent[];
  /** Sibling documents in the layer that are not themselves under audit. */
  siblings: ArtifactContent[];
  /** Canonical documents of other layers this layer builds on. */
  parentFoundation: { layerName: string; canonicalName: string }[];
  previousAudits: Audit[];
  presentVersions: string[];
  expectedVersions: string[];
  missingVersions: string[];
  /** True when the material exceeded budget and a staged extraction is required. */
  requiresStagedExtraction: boolean;
  contentBudget: number;
  /** Proof of exactly what was read (section 14). */
  manifest: EvidenceManifest;
}

/**
 * The packet manifest: which files, versions, pages and extraction runs the
 * audit actually consumed. Without it a packet verdict is an assertion; with it
 * the user can check the auditor read what it claims to have read.
 */
export interface EvidenceManifest {
  mode: 'SINGLE_DOCUMENT' | 'LAYER_PACKET';
  layerName: string;
  generatedAt: string;
  documents: ManifestEntry[];
  totalPages: number;
  totalCharacters: number;
  /** Documents that could not be read; a required one of these blocks the audit. */
  unreadable: ManifestEntry[];
  /**
   * Documents in the layer that were deliberately left out, and why. Today that
   * is superseded versions. Naming them is what makes the manifest a complete
   * account of the layer rather than only of what was read.
   */
  excluded: { canonicalName: string; version: string; reason: string }[];
  complete: boolean;
}

export interface ManifestEntry {
  documentId: string | null;
  canonicalName: string;
  version: string;
  documentType: string;
  extractionRunId: string | null;
  extractionStatus: string;
  pages: number | null;
  pagesOcr: number;
  coverageRatio: number;
  characters: number;
  truncated: boolean;
  warnings: string[];
  unavailableReason: string | null;
}

/**
 * The auditable text of a document, taken from its validated extraction run.
 *
 * The extraction pipeline has already decided whether this document can be read
 * at all; the audit never re-derives that judgement, and never falls back to
 * scraping bytes. A document that is not READY is evidence the auditor does not
 * have, and it says so.
 */
function readDocumentText(document: Document, budget: number): ArtifactContent {
  const run = getCurrentExtractionRun(document.id);
  const base = {
    documentId: document.id,
    canonicalName: document.canonicalName,
    version: document.version,
    documentType: document.documentType,
    status: document.status,
    filesystemPath: document.filesystemPath,
    extractionRunId: run?.id ?? null,
    extractionStatus: run?.status ?? document.extractionStatus,
    pageCount: run?.pagesExpected ?? document.pageCount ?? null,
    pagesOcr: run?.pagesOcr ?? 0,
    coverageRatio: run?.coverageRatio ?? 0,
    extractionWarnings: run?.warnings ?? [],
  };

  if (!document.filesystemPath || !fileExists(document.filesystemPath)) {
    return {
      ...base,
      text: '',
      fullLength: 0,
      truncated: false,
      unavailableReason: document.filesystemPath
        ? 'The registered file is missing from disk.'
        : 'No file has been registered for this document.',
    };
  }

  if (!run) {
    return {
      ...base,
      text: '',
      fullLength: 0,
      truncated: false,
      unavailableReason:
        'This document has not been read yet — no extraction run exists. ' +
        'It will be queued automatically; reprocess it if it stays unread.',
    };
  }

  if (!isAuditable(run.status)) {
    return {
      ...base,
      text: '',
      fullLength: 0,
      truncated: false,
      // Section 16: no readable content is BLOCKED, never a verdict.
      unavailableReason:
        run.blockedReason ??
        `The document could not be read (extraction ${run.status}). The audit cannot judge ` +
          'content it has not seen.',
    };
  }

  const blocks = listBlocks(run.id).filter(
    (block) => block.blockType !== 'PAGE_HEADER' && block.blockType !== 'PAGE_FOOTER',
  );
  // Page markers travel with the text so the auditor can cite a page number.
  const parts: string[] = [];
  let lastPage = -1;
  for (const block of blocks) {
    if (block.pageNumber !== lastPage) {
      parts.push(`\n[page ${block.pageNumber}]`);
      lastPage = block.pageNumber;
    }
    parts.push(block.normalizedText);
  }
  const text = parts.join('\n').trim();

  return {
    ...base,
    text: text.length > budget ? text.slice(0, budget) : text,
    fullLength: text.length,
    truncated: text.length > budget,
    unavailableReason: null,
  };
}

function toArtifact(document: Document, budget: number): ArtifactContent {
  return readDocumentText(document, budget);
}

export interface BuildAuditContextInput {
  mode: 'SINGLE_DOCUMENT' | 'LAYER_PACKET';
  layerId: string;
  /** Single-document mode: the artifact under audit. */
  documentId?: string | null;
  /** The run that produced it, when known — carries the exact assignment. */
  runId?: string | null;
  contentBudget?: number;
}

/**
 * Assemble everything an audit is allowed to see. Pure: it reads state, records
 * nothing, and never consults a provider.
 */
export function buildAuditContext(input: BuildAuditContextInput): AuditContext {
  const layer = getLayer(input.layerId);
  if (!layer) throw new Error(`Cannot audit: unknown layer ${input.layerId}`);
  const project = getProject(layer.projectId);
  if (!project) throw new Error(`Cannot audit: unknown project ${layer.projectId}`);

  const budget = input.contentBudget ?? DEFAULT_CONTENT_BUDGET;
  const profile = getAuditProfile(project.slug);
  const layerCriteria = profile ? getLayerCriteria(profile, layer.slug) : null;
  const layerState = computeLayerState(layer.id);
  const layerDocuments = listDocumentsByLayer(layer.id);

  // Which documents are under audit, and which are merely context.
  let artifactDocuments: Document[];
  if (input.mode === 'SINGLE_DOCUMENT') {
    const document = input.documentId ? getDocument(input.documentId) : null;
    if (!document) throw new Error('Cannot audit: no document was identified for a single-document audit.');
    artifactDocuments = [document];
  } else {
    // The packet is what the layer currently stands on. A superseded document is
    // provenance, not evidence: feeding a replaced version to the auditor makes
    // it judge wording the layer has already moved past, and doubles the packet
    // for no gain. They are listed on the manifest instead, so the exclusion is
    // visible rather than silent.
    artifactDocuments = layerDocuments.filter(
      (document) => document.status === 'COMPLETE' || document.status === 'FROZEN',
    );
  }
  const supersededDocuments =
    input.mode === 'LAYER_PACKET'
      ? layerDocuments.filter((document) => document.status === 'SUPERSEDED')
      : [];

  const artifactIds = new Set(artifactDocuments.map((document) => document.id));
  const perDocumentBudget =
    input.mode === 'LAYER_PACKET'
      ? Math.max(4_000, Math.min(PER_DOCUMENT_BUDGET, Math.floor(budget / Math.max(1, artifactDocuments.length))))
      : budget;

  const artifacts = artifactDocuments.map((document) => toArtifact(document, perDocumentBudget));
  const siblings =
    input.mode === 'SINGLE_DOCUMENT'
      ? layerDocuments
          .filter((document) => !artifactIds.has(document.id))
          .map((document) => toArtifact(document, Math.min(8_000, perDocumentBudget)))
      : [];

  const run = input.runId ? getRun(input.runId) : sourceRunFor(artifactDocuments);
  const assignmentPrompt = run?.prompt ?? null;
  const requiredAttachments = run?.requiredAttachments ?? [];

  const dependencies = run
    ? checkRunDependencies(run.id)
    : checkCanonicalNames(
        project.id,
        input.mode === 'LAYER_PACKET'
          ? defaultRequiredDocuments(project.id, layer.id, 'SYNTHESIS')
          : layerState.expectedVersions.map((version) => `${layer.name} ${version}`),
      );

  // Canonical documents of the other layers: the foundation this layer builds on.
  const parentFoundation = listLayers(project.id)
    .filter((other) => other.id !== layer.id && other.canonicalDocumentId)
    .flatMap((other) => {
      const canonical = other.canonicalDocumentId ? getDocument(other.canonicalDocumentId) : null;
      return canonical ? [{ layerName: other.name, canonicalName: canonical.canonicalName }] : [];
    });

  const otherLayers = listLayers(project.id)
    .filter((other) => other.id !== layer.id)
    .map((other) => ({
      name: other.name,
      owns: profile ? (getLayerCriteria(profile, other.slug)?.owns ?? null) : null,
    }));

  const presentVersions = sortVersions(
    layerDocuments
      .filter((document) => document.status === 'COMPLETE' || document.status === 'FROZEN')
      .map((document) => document.version),
  );

  const requiresStagedExtraction =
    artifacts.some((artifact) => artifact.truncated) ||
    artifacts.reduce((total, artifact) => total + artifact.fullLength, 0) > budget;

  const manifest = buildManifest(input.mode, layer.name, artifacts, supersededDocuments);

  return {
    mode: input.mode,
    project,
    layer,
    layerState,
    profile,
    layerCriteria,
    otherLayers,
    run,
    assignmentPrompt,
    requiredAttachments,
    dependencies,
    artifacts,
    siblings,
    parentFoundation,
    previousAudits: listAuditsByLayer(layer.id).slice(0, 5),
    presentVersions,
    expectedVersions: layerState.expectedVersions,
    missingVersions: layerState.missingVersions,
    requiresStagedExtraction,
    contentBudget: budget,
    manifest,
  };
}

function manifestEntry(artifact: ArtifactContent): ManifestEntry {
  return {
    documentId: artifact.documentId,
    canonicalName: artifact.canonicalName,
    version: artifact.version,
    documentType: artifact.documentType,
    extractionRunId: artifact.extractionRunId,
    extractionStatus: artifact.extractionStatus,
    pages: artifact.pageCount,
    pagesOcr: artifact.pagesOcr,
    coverageRatio: artifact.coverageRatio,
    characters: artifact.text.length,
    truncated: artifact.truncated,
    warnings: artifact.extractionWarnings,
    unavailableReason: artifact.unavailableReason,
  };
}

function buildManifest(
  mode: 'SINGLE_DOCUMENT' | 'LAYER_PACKET',
  layerName: string,
  artifacts: ArtifactContent[],
  superseded: Document[],
): EvidenceManifest {
  const documents = artifacts.map(manifestEntry);
  const unreadable = documents.filter((entry) => entry.unavailableReason !== null);
  return {
    mode,
    layerName,
    generatedAt: new Date().toISOString(),
    documents,
    totalPages: documents.reduce((total, entry) => total + (entry.pages ?? 0), 0),
    totalCharacters: documents.reduce((total, entry) => total + entry.characters, 0),
    unreadable,
    excluded: superseded.map((document) => ({
      canonicalName: document.canonicalName,
      version: document.version,
      reason: 'Superseded by a later version; kept as provenance, not read as evidence.',
    })),
    // A packet with an unreadable member is not a complete reading of the layer.
    complete: unreadable.length === 0 && documents.length > 0,
  };
}

/** The run that produced an artifact, so its exact assignment can be read back. */
function sourceRunFor(documents: Document[]): ResearchRun | null {
  for (const document of documents) {
    if (document.sourceRunId) {
      const run = getRun(document.sourceRunId);
      if (run) return run;
    }
  }
  const layerId = documents[0]?.layerId;
  if (!layerId) return null;
  return listRunsByLayer(layerId).find((run) => Boolean(run.prompt)) ?? null;
}

/** Artifacts the auditor cannot read. A blocked audit, never a passing one. */
export function unreadableArtifacts(context: AuditContext): ArtifactContent[] {
  return context.artifacts.filter((artifact) => artifact.unavailableReason !== null);
}
