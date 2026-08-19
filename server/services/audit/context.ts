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
import fs from 'node:fs';
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
import { absolutePathFor, fileExists } from '../storage.ts';
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
  /** Full byte length on disk, so truncation is always visible. */
  fullLength: number;
  truncated: boolean;
  /** Why there is no text: missing file, unreadable binary, or nothing registered. */
  unavailableReason: string | null;
  filesystemPath: string | null;
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
}

function readDocumentText(document: Document, budget: number): ArtifactContent {
  const base = {
    documentId: document.id,
    canonicalName: document.canonicalName,
    version: document.version,
    documentType: document.documentType,
    status: document.status,
    filesystemPath: document.filesystemPath,
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

  let raw: Buffer;
  try {
    raw = fs.readFileSync(absolutePathFor(document.filesystemPath));
  } catch (error) {
    return {
      ...base,
      text: '',
      fullLength: 0,
      truncated: false,
      unavailableReason: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const text = extractReadableText(raw);
  if (text.trim().length === 0) {
    return {
      ...base,
      text: '',
      fullLength: raw.byteLength,
      truncated: false,
      // A PDF whose text cannot be extracted is a blocked audit, not a pass:
      // judging an artifact nobody can read would be inventing a verdict.
      unavailableReason:
        'No readable text could be extracted from this file (it is probably a scanned or ' +
        'image-only PDF). The audit cannot judge content it cannot read.',
    };
  }

  return {
    ...base,
    text: text.length > budget ? text.slice(0, budget) : text,
    fullLength: text.length,
    truncated: text.length > budget,
    unavailableReason: null,
  };
}

/**
 * Pull readable text out of a stored artifact.
 *
 * Plain text and Markdown come through as-is. For PDFs this recovers the text
 * that sits uncompressed in content streams — enough for the auditor to work
 * with, and honest about failing when there is nothing recoverable. Full PDF
 * text extraction is a known gap, not a silent one.
 */
export function extractReadableText(raw: Buffer): string {
  const head = raw.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') return raw.toString('utf8');

  const latin = raw.toString('latin1');
  const chunks: string[] = [];
  // Text-showing operators: (literal) Tj / TJ arrays.
  const showText = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|'|")/g;
  let match = showText.exec(latin);
  while (match !== null) {
    const body = match[1];
    if (body) chunks.push(body.replace(/\\([()\\])/g, '$1'));
    match = showText.exec(latin);
  }
  if (chunks.length > 0) return chunks.join(' ').replace(/\s+/g, ' ').trim();

  // Nothing extractable — usually a compressed stream. Say so rather than guess.
  return '';
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
    // The packet is everything the layer has actually completed.
    artifactDocuments = layerDocuments.filter(
      (document) => document.status === 'COMPLETE' || document.status === 'FROZEN' || document.status === 'SUPERSEDED',
    );
  }

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
