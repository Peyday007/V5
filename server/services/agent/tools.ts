/**
 * Agent tools (section 6).
 *
 * This module is the *only* way the chat is allowed to learn anything about the
 * project. Every tool re-reads SQLite and the filesystem on every call, and
 * returns both the raw structure (`data`) and a compact human rendering
 * (`text`) that the assistant message is assembled from. Nothing here accepts
 * remembered state as input or returns a claim it did not just verify —
 * invariants 7 and 12 live or die in this file.
 */
import path from 'node:path';
import type {
  DependencyCheckResult,
  Document,
  DocumentStatus,
  DocumentType,
  Layer,
  LayerStateSnapshot,
  PlannerItem,
  PlannerResult,
  Project,
  ReconcileReport,
  ResearchRun,
  RunStatus,
  RunType,
  StructuredAuditResult,
} from '../../domain/types.ts';
import {
  AUDIT_VERDICTS,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  RUN_STATUSES,
  RUN_TYPES,
} from '../../domain/types.ts';
import { buildCanonicalName, buildNames, normalizeName } from '../../domain/naming.ts';
import {
  extractVersionToken,
  isValidVersion,
  normalizeVersion,
  parseVersion,
  versionSortKey,
  waveForVersion,
} from '../../domain/version.ts';
import { getLatestAuditForLayer } from '../../repos/audits.ts';
import { listDependenciesForProject } from '../../repos/dependencies.ts';
import {
  createDocument,
  findDocumentByCanonicalName,
  getDocument,
  listDocuments,
  listDocumentsByLayer,
  updateDocument,
} from '../../repos/documents.ts';
import { recordEvent } from '../../repos/events.ts';
import { getLayer, getLayerBySlug, listLayers } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import {
  createRun,
  getRun,
  listActiveRuns,
  listRuns,
  listRunsByLayer,
  updateRun,
} from '../../repos/runs.ts';
import { nowIso, slugify } from '../../repos/util.ts';
import { parseAuditJson, recordAudit } from '../auditEngine.ts';
import {
  checkCanonicalNames,
  checkDocumentDependencies,
  checkRunDependencies,
  setRunDependencies,
} from '../dependencies.ts';
import { freezeLayer } from '../freeze.ts';
import { buildPlan, calculateNextAction } from '../planner.ts';
import { compilePrompt, defaultRequiredDocuments, defaultTargetVersion } from '../promptCompiler.ts';
import { scanAndReconcile } from '../reconcile.ts';
import { createRedoRun } from '../redoEngine.ts';
import {
  computeLayerState,
  recomputeLayer,
  recomputeProject,
  setLayerExpectations,
} from '../stateEngine.ts';
import { objectExists, objectSize, hashObject } from '../storage.ts';

export interface ToolContext {
  projectId: string;
}

export interface ToolResult {
  ok: boolean;
  data: unknown;
  text: string;
}

export type ToolName =
  | 'get_project_state'
  | 'get_layer_state'
  | 'list_documents'
  | 'find_document'
  | 'resolve_dependencies'
  | 'create_document'
  | 'register_document'
  | 'create_run'
  | 'update_run'
  | 'compile_prompt'
  | 'create_audit'
  | 'create_redo'
  | 'mark_layer_frozen'
  | 'calculate_next_action'
  | 'scan_and_reconcile'
  | 'set_layer_expectations'
  | 'list_runs';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  run(context: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Data payload shapes — so callers read tool output as types, not as `any`
// ---------------------------------------------------------------------------

export interface ProjectStateData {
  project: { id: string; slug: string; name: string; wave: number; status: string; northStar: string | null };
  layers: LayerStateSnapshot[];
  documentCount: number;
  activeRuns: { id: string; layerId: string | null; runType: RunType; status: RunStatus; targetVersion: string | null }[];
  missingDependencies: string[];
  inconsistencies: string[];
}

export interface LayerStateData {
  layer: { id: string; name: string; slug: string; orderIndex: number };
  snapshot: LayerStateSnapshot;
  documents: DocumentSummary[];
  latestAudit: { id: string; verdict: string; summary: string; createdAt: string } | null;
  activeRuns: { id: string; runType: RunType; status: RunStatus; targetVersion: string | null }[];
}

export interface DocumentSummary {
  id: string;
  canonicalName: string;
  version: string;
  layerId: string | null;
  documentType: DocumentType;
  status: DocumentStatus;
  filename: string | null;
  filesystemPath: string | null;
  filePresent: boolean;
}

export interface DocumentsData {
  layerId: string | null;
  count: number;
  documents: DocumentSummary[];
}

export interface FindDocumentData {
  query: string | null;
  matches: DocumentSummary[];
  dependencies: DependencyCheckResult | null;
}

export interface RunData {
  run: ResearchRun;
  dependencies: DependencyCheckResult;
  prompt: string | null;
  requiredAttachments: string[];
  expectedConversationTitle: string | null;
  expectedFilename: string | null;
}

export interface RunsData {
  layerId: string | null;
  count: number;
  runs: {
    id: string;
    layerId: string | null;
    layerName: string | null;
    runType: RunType;
    attemptNumber: number;
    status: RunStatus;
    targetVersion: string | null;
    createdAt: string;
    active: boolean;
  }[];
}

export interface NextActionData {
  nextBestAction: PlannerItem | null;
  nextBestActionText: string;
  plan: Pick<PlannerResult, 'now' | 'next' | 'later' | 'blocked'>;
}

export interface ReconcileData {
  report: ReconcileReport;
}

export interface AuditData {
  auditId: string;
  verdict: string;
  layerState: LayerStateSnapshot;
  redoRunId: string | null;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function ok(data: unknown, text: string): ToolResult {
  return { ok: true, data, text };
}

function fail(text: string, data: unknown = null): ToolResult {
  return { ok: false, data, text };
}

/** "a EXPANSION run" reads badly enough to be worth four lines. */
function article(word: string): string {
  return /^[AEIOU]/i.test(word) ? 'an' : 'a';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readString(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readStringArray(args: Args, ...keys: string[]): string[] | null {
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) {
      return unique(
        value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim()),
      );
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return unique(value.split(/\s*[,;\n]\s*/).map((entry) => entry.trim()));
    }
  }
  return null;
}

function readBoolean(args: Args, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (lower === 'true' || lower === 'yes') return true;
      if (lower === 'false' || lower === 'no') return false;
    }
  }
  return null;
}

function readNumber(args: Args, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** Coerce free text (`"expansion"`, `"more research"`) onto a known enum member. */
function readEnum<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return allowed.find((candidate) => candidate === normalized) ?? null;
}

async function requireProject(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`there is no project with id ${projectId} in the database`);
  return project;
}

/** Invariant 8/9: a document counts as having a file only if the file is there now. */
async function filePresent(document: Document): Promise<boolean> {
  return document.filesystemPath ? await objectExists(document.filesystemPath) : false;
}

async function summarizeDocument(document: Document): Promise<DocumentSummary> {
  return {
    id: document.id,
    canonicalName: document.canonicalName,
    version: document.version,
    layerId: document.layerId,
    documentType: document.documentType,
    status: document.status,
    filename: document.filename,
    filesystemPath: document.filesystemPath,
    filePresent: await filePresent(document),
  };
}

async function documentLine(document: Document): Promise<string> {
  const version = document.version.padEnd(6, ' ');
  const file = document.filesystemPath
    ? await filePresent(document)
      ? (document.filename ?? path.posix.basename(document.filesystemPath))
      : `${document.filename ?? document.filesystemPath} — FILE MISSING FROM DISK`
    : 'no file registered';
  return `  ${version} ${document.canonicalName} · ${document.documentType}/${document.status} · ${file}`;
}

function renderSnapshot(snapshot: LayerStateSnapshot): string {
  const lines = [
    `${snapshot.layerName} — ${snapshot.status}${snapshot.statusSource === 'MANUAL' ? ' (pinned by hand)' : ''}`,
    `  Why       : ${snapshot.reason}`,
    `  Documents : ${snapshot.documentsComplete} / ${snapshot.documentsExpected} complete`,
    `  Present   : ${snapshot.presentVersions.length > 0 ? snapshot.presentVersions.join(', ') : 'none'}`,
  ];
  if (snapshot.missingVersions.length > 0) {
    // Canonical names, not bare versions: "Discovery Logic v1G" is the thing the
    // user searches for, imports and talks about.
    lines.push(
      `  Missing   : ${snapshot.missingVersions
        .map((version) => buildCanonicalName(snapshot.layerName, version))
        .join(', ')}`,
    );
  }
  if (snapshot.canonicalName) lines.push(`  Canonical : ${snapshot.canonicalName}`);
  if (snapshot.latestAuditVerdict) lines.push(`  Last audit: ${snapshot.latestAuditVerdict}`);
  if (snapshot.missingDependencies.length > 0) {
    lines.push(`  Blocked on: ${snapshot.missingDependencies.join(', ')}`);
  }
  if (snapshot.inconsistentDocuments.length > 0) {
    lines.push(`  INCONSISTENT (row exists, file gone): ${snapshot.inconsistentDocuments.join(', ')}`);
  }
  if (snapshot.activeRunIds.length > 0) {
    lines.push(`  Active runs: ${snapshot.activeRunIds.join(', ')}`);
  }
  lines.push(`  Next      : ${snapshot.nextAction}`);
  return lines.join('\n');
}

function renderDependencies(result: DependencyCheckResult): string {
  const lines = [`Source packet: ${result.summary}`];
  for (const item of result.items) {
    const mark = item.present ? '[x]' : item.fileMissing ? '[!]' : '[ ]';
    const detail = item.present
      ? (item.status ?? 'present')
      : item.fileMissing
        ? 'registered but its file is missing from disk'
        : item.status
          ? `registered as ${item.status}, not usable yet`
          : 'not registered';
    lines.push(`  ${mark} ${item.canonicalName} — ${detail}${item.required ? '' : ' (optional)'}`);
  }
  if (result.items.length === 0) lines.push('  (no dependencies are declared)');
  if (result.missing.length > 0) lines.push(`Missing: ${result.missing.join(', ')}`);
  if (result.inconsistent.length > 0) {
    lines.push(`Inconsistent (row exists, file gone): ${result.inconsistent.join(', ')}`);
  }
  return lines.join('\n');
}

function renderRunHeader(run: ResearchRun, layerName: string | null): string {
  return (
    `${run.runType} run ${run.id} · ${layerName ?? 'no layer'} · attempt ${run.attemptNumber} · ` +
    `status ${run.status}${run.targetVersion ? ` · target ${run.targetVersion}` : ''}`
  );
}

/** The copy-and-paste block: this is the MVP delivery path, so it is verbatim. */
function renderPromptBlock(run: ResearchRun): string[] {
  const lines: string[] = [];
  lines.push(
    `Required attachments (${run.requiredAttachments.length}):`,
    ...(run.requiredAttachments.length > 0
      ? run.requiredAttachments.map((name) => `  - ${name}`)
      : ['  - none']),
    `Expected conversation title: ${run.expectedConversationTitle ?? 'not set'}`,
    `Expected filename          : ${run.expectedFilename ?? 'not set'}`,
  );
  if (run.prompt) {
    lines.push('', '--- COPY PROMPT (everything between the markers) ---', run.prompt, '--- END PROMPT ---');
  }
  return lines;
}

async function layerNameFor(layerId: string | null): Promise<string | null> {
  if (!layerId) return null;
  return (await getLayer(layerId))?.name ?? null;
}

async function knownLayersLine(projectId: string): Promise<string> {
  const names = (await listLayers(projectId)).map((layer) => layer.name);
  return names.length > 0
    ? `Layers in this project: ${names.join(', ')}.`
    : 'This project has no layers.';
}

// ---------------------------------------------------------------------------
// Fuzzy layer reference resolution
// ---------------------------------------------------------------------------

/** Words that carry no identifying information in a layer reference. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'my', 'our', 'this', 'that',
  'layer', 'layers', 'please', 'status', 'state', 'about', 'is', 'are', 'do', 'does', 'run',
  'audit', 'freeze', 'redo', 'prompt', 'generate', 'compile', 'next', 'now', 'it', 'me', 'what',
]);

/** Crude singularisation so "playbooks" and "playbook" are the same token. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokenize(value: string): string[] {
  return normalizeName(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 0)
    .map(stem);
}

function flatten(value: string): string {
  return ` ${tokenize(value).join(' ')} `;
}

/**
 * Resolve a fuzzy layer reference out of chat text: "Discovery", "discovery
 * logic", "DISCOVERY LOGIC" and "Routing rate limit ran out." all land on the
 * right layer, while "logic" (three layers share it) resolves to nothing.
 *
 * Scoring is inverse-document-frequency over the project's own layer names, so
 * a token unique to one layer is decisive and a token every layer shares is
 * almost worthless. A tie returns null: guessing is worse than asking.
 */
export async function resolveLayerReference(projectId: string, text: string): Promise<Layer | null> {
  const layers = await listLayers(projectId);
  if (layers.length === 0) return null;

  const raw = text.trim();
  if (raw.length === 0) return null;

  // Exact identifiers win outright.
  const byId = layers.find((layer) => layer.id === raw);
  if (byId) return byId;
  const slug = slugify(raw);
  const bySlug = layers.find((layer) => layer.slug === slug);
  if (bySlug) return bySlug;

  const haystack = new Set(tokenize(raw));
  if (haystack.size === 0) return null;
  const flatText = flatten(raw);

  const frequency = new Map<string, number>();
  for (const layer of layers) {
    for (const token of new Set(tokenize(layer.name))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  const scored = layers
    .map((layer) => {
      const tokens = [...new Set(tokenize(layer.name))].filter((token) => !STOP_WORDS.has(token));
      let score = 0;
      for (const token of tokens) {
        if (!haystack.has(token)) continue;
        score += 1 / (frequency.get(token) ?? 1);
      }
      // A full-name mention is unambiguous no matter how common its words are.
      if (score > 0 && flatText.includes(flatten(layer.name))) score += 1;
      return { layer, score };
    })
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best || best.score < 0.75) return null;
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score >= best.score - 1e-9) return null;
  return best.layer;
}

/** Pull a layer out of tool arguments: explicit id, slug, or fuzzy free text. */
async function resolveLayerArgument(
  projectId: string,
  args: Args,
): Promise<{ layer: Layer | null; reference: string | null }> {
  const id = readString(args, 'layerId', 'layer_id');
  if (id) {
    const byId = await getLayer(id);
    if (byId && byId.projectId === projectId) return { layer: byId, reference: id };
    const bySlug = await getLayerBySlug(projectId, slugify(id));
    if (bySlug) return { layer: bySlug, reference: id };
    return { layer: await resolveLayerReference(projectId, id), reference: id };
  }
  const text = readString(
    args,
    'layer',
    'layerName',
    'layer_name',
    'layerSlug',
    'layer_slug',
    'name',
    'text',
    'query',
  );
  if (!text) return { layer: null, reference: null };
  const bySlug = await getLayerBySlug(projectId, slugify(text));
  if (bySlug) return { layer: bySlug, reference: text };
  return { layer: await resolveLayerReference(projectId, text), reference: text };
}

async function unresolvedLayer(projectId: string, reference: string | null): Promise<ToolResult> {
  const detail = reference
    ? `"${reference}" does not identify exactly one layer in this project.`
    : 'no layer was named.';
  return fail(`Could not resolve a layer: ${detail} ${await knownLayersLine(projectId)}`, {
    reference,
    layers: (await listLayers(projectId)).map((layer) => ({ id: layer.id, name: layer.name })),
  });
}

function inferDocumentType(project: Project, version: string): DocumentType {
  const normalized = normalizeVersion(version);
  if (normalized === normalizeVersion(project.versionPolicy.synthesisVersion)) return 'SYNTHESIS';
  if (normalized === normalizeVersion(project.versionPolicy.foundationVersion)) return 'FOUNDATION';
  return parseVersion(normalized).branchIndex > 0 ? 'EXPANSION' : 'REFERENCE';
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getProjectState: ToolDefinition = {
  name: 'get_project_state',
  description:
    'Re-derive and return the whole project: every layer status with its reason, document counts, ' +
    'active runs, missing dependencies and inconsistent documents. Reads SQLite and the filesystem.',
  async run(context) {
    const project = await requireProject(context.projectId);
    // Files first, then dependencies, then layer status: the live truth.
    const layers = await recomputeProject(project.id);
    const documents = await listDocuments(project.id);
    const runs = await listActiveRuns(project.id);
    const missingDependencies = unique(layers.flatMap((layer) => layer.missingDependencies));
    const inconsistencies = unique(layers.flatMap((layer) => layer.inconsistentDocuments));

    const data: ProjectStateData = {
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        wave: project.currentWave,
        status: project.status,
        northStar: project.northStar,
      },
      layers,
      documentCount: documents.length,
      activeRuns: runs.map((run) => ({
        id: run.id,
        layerId: run.layerId,
        runType: run.runType,
        status: run.status,
        targetVersion: run.targetVersion,
      })),
      missingDependencies,
      inconsistencies,
    };

    const lines = [
      `Project ${project.name} (${project.slug}) — wave ${project.currentWave}, ${project.status}, ` +
        `${layers.length} layers, ${documents.length} registered documents, ${runs.length} active runs.`,
      'Layers:',
      ...layers.map(
        (layer, index) =>
          `  ${index + 1}. ${layer.layerName} — ${layer.status}` +
          `${layer.currentVersion ? ` · at ${layer.currentVersion}` : ''}` +
          ` · ${layer.documentsComplete}/${layer.documentsExpected} complete` +
          `${
            layer.missingVersions.length > 0
              ? ` · missing ${layer.missingVersions
                  .map((version) => buildCanonicalName(layer.layerName, version))
                  .join(', ')}`
              : ''
          }`,
      ),
      `Missing dependencies: ${missingDependencies.length > 0 ? missingDependencies.join(', ') : 'none'}`,
      `Inconsistent documents (row exists, file gone): ${inconsistencies.length > 0 ? inconsistencies.join(', ') : 'none'}`,
    ];
    return ok(data, lines.join('\n'));
  },
};

const getLayerState: ToolDefinition = {
  name: 'get_layer_state',
  description:
    'Re-derive one layer: status and the rule that produced it, expected vs present versions, its ' +
    'documents with live file presence, its latest audit and its active runs.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer) return unresolvedLayer(project.id, reference);

    const snapshot = await recomputeLayer(layer.id);
    const documents = await listDocumentsByLayer(layer.id);
    const audit = await getLatestAuditForLayer(layer.id);
    const runs = (await listRunsByLayer(layer.id)).filter((run) =>
      ['PLANNED', 'READY', 'RUNNING', 'BLOCKED', 'AUDIT_REQUIRED', 'REDO_REQUIRED'].includes(run.status),
    );

    const data: LayerStateData = {
      layer: { id: layer.id, name: layer.name, slug: layer.slug, orderIndex: layer.orderIndex },
      snapshot,
      documents: await Promise.all(documents.map(summarizeDocument)),
      latestAudit: audit
        ? { id: audit.id, verdict: audit.verdict, summary: audit.summary, createdAt: audit.createdAt }
        : null,
      activeRuns: runs.map((run) => ({
        id: run.id,
        runType: run.runType,
        status: run.status,
        targetVersion: run.targetVersion,
      })),
    };

    const lines = [renderSnapshot(snapshot)];
    lines.push(
      documents.length > 0
        ? `Documents (${documents.length}):`
        : 'Documents: none are registered for this layer.',
    );
    lines.push(...(await Promise.all(documents.map(documentLine))));
    if (audit) {
      lines.push(`Latest audit: ${audit.verdict} on ${audit.createdAt} — ${audit.summary}`);
    } else {
      lines.push('Latest audit: none has been recorded for this layer.');
    }
    if (runs.length > 0) {
      lines.push('Open runs:');
      lines.push(...runs.map((run) => `  ${renderRunHeader(run, layer.name)}`));
    }
    return ok(data, lines.join('\n'));
  },
};

const listDocumentsTool: ToolDefinition = {
  name: 'list_documents',
  description:
    'List registered documents for the project or one layer, with their version, type, status and ' +
    'whether the physical file is actually on disk right now.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer && reference) return unresolvedLayer(project.id, reference);

    const status = readEnum(readString(args, 'status'), DOCUMENT_STATUSES);
    const documentType = readEnum(readString(args, 'documentType', 'document_type', 'type'), DOCUMENT_TYPES);
    const versionArg = readString(args, 'version');
    const version = versionArg ? normalizeVersion(versionArg) : null;
    const missingOnly = readBoolean(args, 'missingOnly', 'missing_only', 'inconsistentOnly') === true;

    let documents = layer ? await listDocumentsByLayer(layer.id) : await listDocuments(project.id);
    if (status) documents = documents.filter((document) => document.status === status);
    if (documentType) documents = documents.filter((document) => document.documentType === documentType);
    if (version) documents = documents.filter((document) => normalizeVersion(document.version) === version);
    if (missingOnly) {
      // `filePresent` reads the store, so this cannot be a `.filter` predicate:
      // a promise is always truthy and the filter would keep every document.
      const presence = await Promise.all(documents.map((document) => filePresent(document)));
      documents = documents.filter((_, i) => !presence[i]);
    }

    const scope = layer ? layer.name : project.name;
    const filters = [
      status ? `status ${status}` : null,
      documentType ? `type ${documentType}` : null,
      version ? `version ${version}` : null,
      missingOnly ? 'file missing from disk' : null,
    ].filter((entry): entry is string => entry !== null);
    const filterText = filters.length > 0 ? ` matching ${filters.join(', ')}` : '';

    const data: DocumentsData = {
      layerId: layer?.id ?? null,
      count: documents.length,
      documents: await Promise.all(documents.map(summarizeDocument)),
    };

    if (documents.length === 0) {
      return ok(
        data,
        `No documents are registered for ${scope}${filterText}. The database has no such record — ` +
          'nothing exists until it is imported and registered.',
      );
    }

    const lines = [`${documents.length} document(s) registered for ${scope}${filterText}:`];
    lines.push(...(await Promise.all(documents.map(documentLine))));
    if (layer) {
      const snapshot = await computeLayerState(layer.id);
      lines.push(`Layer status: ${snapshot.status} — ${snapshot.reason}`);
    }
    return ok(data, lines.join('\n'));
  },
};

const findDocument: ToolDefinition = {
  name: 'find_document',
  description:
    'Look a document up by canonical name, by layer + version, or by a fuzzy fragment. Returns ' +
    'nothing when nothing matches — the answer is then "there is no such document".',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer } = await resolveLayerArgument(project.id, args);
    const query = readString(
      args,
      'canonicalName',
      'canonical_name',
      'name',
      'document',
      'title',
      'query',
      'text',
    );
    const versionArg = readString(args, 'version');
    const version = versionArg
      ? normalizeVersion(versionArg)
      : query
        ? extractVersionToken(query)
        : null;

    const found: Document[] = [];

    if (layer && version) {
      const exact = await findDocumentByCanonicalName(project.id, buildCanonicalName(layer.name, version));
      if (exact) found.push(exact);
    }
    if (found.length === 0 && query) {
      const exact = await findDocumentByCanonicalName(project.id, query);
      if (exact) found.push(exact);
    }
    if (found.length === 0) {
      const pool = layer ? await listDocumentsByLayer(layer.id) : await listDocuments(project.id);
      const needle = query ? normalizeName(query) : '';
      const byName = needle
        ? pool.filter((document) => {
            const name = normalizeName(document.canonicalName);
            return name.includes(needle) || needle.includes(name);
          })
        : [];
      const byVersion = version
        ? pool.filter((document) => normalizeVersion(document.version) === version)
        : [];
      const merged = byName.length > 0 ? byName : byVersion;
      found.push(...merged);
    }

    const matches = [...new Map(found.map((document) => [document.id, document])).values()];
    const first = matches[0];
    const data: FindDocumentData = {
      query: query ?? version,
      matches: await Promise.all(matches.map(summarizeDocument)),
      dependencies: null,
    };

    if (matches.length === 0) {
      const described = query ?? version ?? (layer ? layer.name : project.name);
      return fail(
        `There is no document matching "${described}" in the database. It has not been created or ` +
          'imported, so nothing about it can be reported.',
        data,
      );
    }

    if (matches.length === 1 && first) {
      const dependencies = await checkDocumentDependencies(first.id);
      data.dependencies = dependencies.items.length > 0 ? dependencies : null;
      const lines = [
        `Found 1 document:`,
        await documentLine(first),
        `  Layer     : ${await layerNameFor(first.layerId) ?? 'unfiled'}`,
        `  Registered: ${first.importedAt ?? first.createdAt}`,
        `  File      : ${
          first.filesystemPath
            ? await filePresent(first)
              ? `${first.filesystemPath} (present, ${first.fileSize ?? 'unknown'} bytes)`
              : `${first.filesystemPath} (INCONSISTENT — the row exists but the file is gone)`
            : 'none registered'
        }`,
      ];
      if (data.dependencies) lines.push(renderDependencies(data.dependencies));
      return ok(data, lines.join('\n'));
    }

    return ok(
      data,
      [`Found ${matches.length} documents:`, ...matches.map(documentLine)].join('\n'),
    );
  },
};

const resolveDependencies: ToolDefinition = {
  name: 'resolve_dependencies',
  description:
    'Check a source packet against live state: by run, by document, by explicit canonical names, ' +
    'by layer + run type, or across the whole project. Reports `6 / 7 READY` and what is missing.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const runId = readString(args, 'runId', 'run_id');
    const documentId = readString(args, 'documentId', 'document_id');
    const names = readStringArray(args, 'canonicalNames', 'canonical_names', 'documents', 'names');
    const { layer } = await resolveLayerArgument(project.id, args);
    const runType = readEnum(readString(args, 'runType', 'run_type'), RUN_TYPES);

    let result: DependencyCheckResult;
    let scope: string;

    if (runId) {
      const run = await getRun(runId);
      if (!run || run.projectId !== project.id) {
        return fail(`There is no run ${runId} in this project.`, { runId });
      }
      result = await checkRunDependencies(run.id);
      scope = `run ${run.id} (${run.runType}${run.targetVersion ? ` → ${run.targetVersion}` : ''})`;
    } else if (documentId) {
      const document = await getDocument(documentId);
      if (!document || document.projectId !== project.id) {
        return fail(`There is no document ${documentId} in this project.`, { documentId });
      }
      result = await checkDocumentDependencies(document.id);
      scope = document.canonicalName;
    } else if (names && names.length > 0) {
      result = await checkCanonicalNames(project.id, names);
      scope = 'the named documents';
    } else if (layer && runType) {
      result = await checkCanonicalNames(
        project.id,
        await defaultRequiredDocuments(project.id, layer.id, runType),
      );
      scope = `a ${runType} run on ${layer.name}`;
    } else {
      const declared = unique(
        (await listDependenciesForProject(project.id)).map((dependency) => dependency.requiredCanonicalName),
      );
      result = await checkCanonicalNames(project.id, declared);
      scope = `every dependency declared in ${project.name}`;
    }

    return ok(result, [`Dependencies for ${scope}:`, renderDependencies(result)].join('\n'));
  },
};

const createDocumentTool: ToolDefinition = {
  name: 'create_document',
  description:
    'Create the record for a document the project expects to exist (status EXPECTED). It carries ' +
    'no file: a record is a promise, registration is what makes it real.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer) return unresolvedLayer(project.id, reference);

    const versionArg = readString(args, 'version', 'targetVersion', 'target_version');
    if (!versionArg || !isValidVersion(versionArg)) {
      return fail(
        `"${versionArg ?? 'no version'}" is not a version this project understands. Use forms like v1, v1G or v3.1.`,
        { version: versionArg },
      );
    }
    const version = normalizeVersion(versionArg);
    const names = buildNames(layer.name, version);

    const existing = await findDocumentByCanonicalName(project.id, names.canonicalName);
    if (existing) {
      return fail(
        `${names.canonicalName} already exists (${existing.documentType}/${existing.status}). Nothing was created.`,
        await summarizeDocument(existing),
      );
    }

    const documentType =
      readEnum(readString(args, 'documentType', 'document_type', 'type'), DOCUMENT_TYPES) ??
      inferDocumentType(project, version);
    const status = readEnum(readString(args, 'status'), DOCUMENT_STATUSES) ?? 'EXPECTED';

    const document = await createDocument({
      projectId: project.id,
      layerId: layer.id,
      canonicalName: names.canonicalName,
      version,
      versionSort: versionSortKey(version),
      wave: waveForVersion(version, project.versionPolicy),
      documentType,
      status,
      conversationTitle: names.conversationTitle,
      notes: readString(args, 'notes'),
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
        status,
        expectedFilename: names.filename,
        source: 'chat',
      },
    });
    const snapshot = await recomputeLayer(layer.id);

    return ok(
      { document: await summarizeDocument(document), snapshot, expectedFilename: names.filename },
      [
        `Created the record ${document.canonicalName} (${documentType}, ${status}) on ${layer.name}.`,
        `No file is attached yet. When the report exists, import it as "${names.filename}".`,
        renderSnapshot(snapshot),
      ].join('\n'),
    );
  },
};

const registerDocument: ToolDefinition = {
  name: 'register_document',
  description:
    'Attach a file that already sits under the data root to a document record, hashing and sizing ' +
    'it, or mark an already-filed document COMPLETE. A file on disk is never registered by accident.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const documentId = readString(args, 'documentId', 'document_id');
    const canonicalName = readString(args, 'canonicalName', 'canonical_name', 'name', 'document');

    const document = documentId
      ? await getDocument(documentId)
      : canonicalName
        ? await findDocumentByCanonicalName(project.id, canonicalName)
        : null;
    if (!document || document.projectId !== project.id) {
      return fail(
        `There is no document record for ${documentId ?? canonicalName ?? 'the document you named'} ` +
          'in this project. Create the record first, or import the file through IMPORT.',
        { documentId, canonicalName },
      );
    }

    const relativePath = readString(args, 'filesystemPath', 'filesystem_path', 'path', 'relativePath');
    const status = readEnum(readString(args, 'status'), DOCUMENT_STATUSES) ?? 'COMPLETE';

    if (relativePath) {
      const normalizedPath = relativePath.replace(/^\.\/+/, '').split(path.sep).join('/');
      if (!await objectExists(normalizedPath)) {
        return fail(
          `No file exists at "${normalizedPath}" under the data root, so nothing was registered. ` +
            'Run scan_and_reconcile to see what is actually on disk.',
          { path: normalizedPath },
        );
      }
      const updated = await updateDocument(document.id, {
        filesystemPath: normalizedPath,
        filename: readString(args, 'filename') ?? path.posix.basename(normalizedPath),
        fileSize: await objectSize(normalizedPath),
        fileHash: await hashObject(normalizedPath),
        fileMissing: false,
        status,
        importedAt: document.importedAt ?? nowIso(),
      });
      await recordEvent({
        projectId: project.id,
        layerId: document.layerId,
        entityType: 'DOCUMENT',
        entityId: document.id,
        eventType: 'DOCUMENT_IMPORTED',
        payload: { canonicalName: document.canonicalName, path: normalizedPath, status, source: 'chat' },
      });
      if (status === 'COMPLETE' || status === 'FROZEN') {
        await recordEvent({
          projectId: project.id,
          layerId: document.layerId,
          entityType: 'DOCUMENT',
          entityId: document.id,
          eventType: 'DOCUMENT_COMPLETED',
          payload: { canonicalName: document.canonicalName, status },
        });
      }
      await recomputeProject(project.id);
      const fresh = await getDocument(document.id) ?? updated ?? document;
      return ok(
        { document: await summarizeDocument(fresh) },
        [
          `Registered ${fresh.canonicalName} against ${normalizedPath} (${fresh.fileSize ?? 0} bytes) and set it ${fresh.status}.`,
          await documentLine(fresh),
        ].join('\n'),
      );
    }

    if (!await filePresent(document)) {
      return fail(
        `${document.canonicalName} has no file on disk, so it cannot be marked ${status}. ` +
          'Give a path under the data root, or import the file first.',
        await summarizeDocument(document),
      );
    }
    await updateDocument(document.id, { status, fileMissing: false });
    await recordEvent({
      projectId: project.id,
      layerId: document.layerId,
      entityType: 'DOCUMENT',
      entityId: document.id,
      eventType: 'DOCUMENT_COMPLETED',
      payload: { canonicalName: document.canonicalName, status, source: 'chat' },
    });
    await recomputeProject(project.id);
    const fresh = await getDocument(document.id) ?? document;
    return ok(
      { document: await summarizeDocument(fresh) },
      [`${fresh.canonicalName} is now ${fresh.status}.`, await documentLine(fresh)].join('\n'),
    );
  },
};

/** Shared by create_run and compile_prompt: compile, persist, attach the packet. */
async function compileOntoRun(
  project: Project,
  layer: Layer,
  runType: RunType,
  args: Args,
  existing: ResearchRun | null,
): Promise<RunData> {
  const targetVersion =
    readString(args, 'targetVersion', 'target_version', 'version') ??
    existing?.targetVersion ??
    await defaultTargetVersion(project.id, layer.id, runType);
  const requiredDocuments =
    readStringArray(args, 'requiredDocuments', 'required_documents', 'requiredAttachments') ??
    await defaultRequiredDocuments(project.id, layer.id, runType);

  const compiled = await compilePrompt({
    projectId: project.id,
    layerId: layer.id,
    runType,
    targetVersion,
    requiredDocuments,
    auditId: readString(args, 'auditId', 'audit_id'),
    previousRunId: readString(args, 'previousRunId', 'previous_run_id'),
    objective: readString(args, 'objective'),
    scope: readString(args, 'scope'),
    researchQuestions: readStringArray(args, 'researchQuestions', 'research_questions'),
  });

  const run =
    existing ??
    await createRun({
      projectId: project.id,
      layerId: layer.id,
      targetVersion: compiled.targetVersion,
      runType,
      status: 'PLANNED',
      provider: readString(args, 'provider'),
      model: readString(args, 'model'),
      conversationId: readString(args, 'conversationId', 'conversation_id'),
    });

  await updateRun(run.id, {
    targetVersion: compiled.targetVersion,
    prompt: compiled.prompt,
    promptSections: compiled.sections,
    requiredAttachments: compiled.requiredAttachments,
    expectedConversationTitle: compiled.expectedConversationTitle,
    expectedFilename: compiled.expectedFilename,
  });
  await setRunDependencies(run.id, compiled.requiredAttachments);
  const dependencies = await checkRunDependencies(run.id);
  // A synthesis with nothing to consolidate is not "ready", it is premature —
  // invariant 4 in the direction the dependency checker cannot see.
  const emptySynthesis = runType === 'SYNTHESIS' && dependencies.items.length === 0;
  await updateRun(run.id, { status: dependencies.ready && !emptySynthesis ? 'READY' : 'BLOCKED' });

  if (!existing) {
    await recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_CREATED',
      payload: {
        runType,
        targetVersion: compiled.targetVersion,
        dependencies: dependencies.summary,
        source: 'chat',
      },
    });
  }
  // Invariant 10: the exact prompt and its attachment list are recorded.
  await recordEvent({
    projectId: project.id,
    layerId: layer.id,
    entityType: 'RUN',
    entityId: run.id,
    eventType: 'RUN_PROMPT_COMPILED',
    payload: {
      runType,
      targetVersion: compiled.targetVersion,
      requiredAttachments: compiled.requiredAttachments,
      expectedConversationTitle: compiled.expectedConversationTitle,
      expectedFilename: compiled.expectedFilename,
      promptLength: compiled.prompt.length,
      source: 'chat',
    },
  });
  await recomputeLayer(layer.id);

  const fresh = await getRun(run.id) ?? run;
  return {
    run: fresh,
    dependencies,
    prompt: fresh.prompt,
    requiredAttachments: fresh.requiredAttachments,
    expectedConversationTitle: fresh.expectedConversationTitle,
    expectedFilename: fresh.expectedFilename,
  };
}

function renderRunData(data: RunData, layerName: string, lead: string): string {
  const lines = [lead, renderRunHeader(data.run, layerName), renderDependencies(data.dependencies)];
  if (data.run.status === 'BLOCKED') {
    lines.push(
      data.dependencies.items.length === 0
        ? 'This run is BLOCKED: there is nothing registered for it to consume yet. The prompt is ' +
          'recorded, but do not run it until the source documents exist.'
        : 'This run is BLOCKED: its source packet is incomplete. Complete the packet, or override ' +
          'deliberately, before running the prompt.',
    );
  }
  lines.push(...renderPromptBlock(data.run));
  return lines.join('\n');
}

const createRunTool: ToolDefinition = {
  name: 'create_run',
  description:
    'Create a research/audit/synthesis/redo run for a layer, compile and persist its prompt and ' +
    'required attachments, attach its dependency rows, and set it READY or BLOCKED accordingly.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer) return unresolvedLayer(project.id, reference);

    const runType = readEnum(readString(args, 'runType', 'run_type', 'type'), RUN_TYPES);
    if (!runType) {
      return fail(
        `"${readString(args, 'runType', 'run_type', 'type') ?? 'no run type'}" is not a run type. ` +
          `Known run types: ${RUN_TYPES.join(', ')}.`,
      );
    }
    if (runType === 'REDO') {
      return fail(
        'A redo is never created from scratch: it is chained to the attempt it replaces. Use create_redo.',
      );
    }

    const data = await compileOntoRun(project, layer, runType, args, null);
    return ok(
      data,
      renderRunData(data, layer.name, `Created ${article(runType)} ${runType} run on ${layer.name}.`),
    );
  },
};

const updateRunTool: ToolDefinition = {
  name: 'update_run',
  description:
    'Move a run through its lifecycle — RUNNING, COMPLETE, FAILED, AUDIT_REQUIRED, APPROVED — ' +
    'stamping the matching timestamp, recording the event and re-deriving the layer.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const runId = readString(args, 'runId', 'run_id', 'id');
    if (!runId) return fail('No run id was given, so no run could be updated.');
    const run = await getRun(runId);
    if (!run || run.projectId !== project.id) {
      return fail(`There is no run ${runId} in this project.`, { runId });
    }

    const statusArg = readString(args, 'status');
    const status = readEnum(statusArg, RUN_STATUSES);
    if (statusArg && !status) {
      return fail(`"${statusArg}" is not a run status. Known statuses: ${RUN_STATUSES.join(', ')}.`);
    }

    const failureReason = readString(args, 'failureReason', 'failure_reason', 'reason');
    const resultText = readString(args, 'resultText', 'result_text', 'result');
    const timestamp = nowIso();

    const updated = await updateRun(run.id, {
      status: status ?? undefined,
      resultText: resultText ?? undefined,
      provider: readString(args, 'provider') ?? undefined,
      model: readString(args, 'model') ?? undefined,
      externalResponseId: readString(args, 'externalResponseId', 'external_response_id') ?? undefined,
      failureReason: status === 'FAILED' ? (failureReason ?? 'No reason was given.') : undefined,
      startedAt: status === 'RUNNING' && !run.startedAt ? timestamp : undefined,
      completedAt: status === 'COMPLETE' || status === 'APPROVED' ? timestamp : undefined,
      failedAt: status === 'FAILED' ? timestamp : undefined,
    });
    if (!updated) return fail(`Run ${run.id} could not be updated.`, { runId: run.id });

    if (status && status !== run.status) {
      const eventType =
        status === 'RUNNING'
          ? 'RUN_STARTED'
          : status === 'FAILED'
            ? 'RUN_FAILED'
            : status === 'COMPLETE' || status === 'APPROVED'
              ? 'RUN_COMPLETED'
              : null;
      if (eventType) {
        await recordEvent({
          projectId: project.id,
          layerId: run.layerId,
          entityType: 'RUN',
          entityId: run.id,
          eventType,
          payload: { from: run.status, to: status, reason: failureReason, source: 'chat' },
        });
      }
    }
    if (run.layerId) await recomputeLayer(run.layerId);

    const layerName = await layerNameFor(updated.layerId);
    const lines = [
      status && status !== run.status
        ? `Run ${updated.id} moved ${run.status} → ${updated.status}.`
        : `Run ${updated.id} updated; status is ${updated.status}.`,
      renderRunHeader(updated, layerName),
    ];
    if (updated.failureReason) lines.push(`  Failure reason: ${updated.failureReason}`);
    if (updated.layerId) lines.push(renderSnapshot(await computeLayerState(updated.layerId)));
    return ok({ run: updated }, lines.join('\n'));
  },
};

const compilePromptTool: ToolDefinition = {
  name: 'compile_prompt',
  description:
    'Compile the prompt for a run type on a layer. With a run id the prompt is recompiled and ' +
    'stored on that run; without one a run is created so the exact prompt is always recorded.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const runId = readString(args, 'runId', 'run_id');

    if (runId) {
      const run = await getRun(runId);
      if (!run || run.projectId !== project.id) {
        return fail(`There is no run ${runId} in this project.`, { runId });
      }
      if (!run.layerId) {
        return fail(`Run ${run.id} is not attached to a layer, so no prompt can be compiled for it.`);
      }
      const layer = await getLayer(run.layerId);
      if (!layer) return fail(`Run ${run.id} points at a layer that no longer exists.`);
      const runType = readEnum(readString(args, 'runType', 'run_type', 'type'), RUN_TYPES) ?? run.runType;
      const data = await compileOntoRun(project, layer, runType, args, run);
      return ok(
        data,
        renderRunData(data, layer.name, `Recompiled the ${runType} prompt for run ${run.id}.`),
      );
    }

    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer) return unresolvedLayer(project.id, reference);
    const runType = readEnum(readString(args, 'runType', 'run_type', 'type'), RUN_TYPES);
    if (!runType) {
      return fail(`No run type was given. Known run types: ${RUN_TYPES.join(', ')}.`);
    }
    const data = await compileOntoRun(project, layer, runType, args, null);
    return ok(
      data,
      renderRunData(data, layer.name, `Compiled ${article(runType)} ${runType} prompt for ${layer.name}.`),
    );
  },
};

const createAuditTool: ToolDefinition = {
  name: 'create_audit',
  description:
    'Record a structured audit (verdict plus failures, missing documents, required runs and ' +
    'patches), apply its consequences, and re-derive the layer. Accepts raw model JSON.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const runId = readString(args, 'runId', 'run_id');
    const documentId = readString(args, 'documentId', 'document_id', 'auditedDocumentId');
    const run = runId ? await getRun(runId) : null;
    if (runId && (!run || run.projectId !== project.id)) {
      return fail(`There is no run ${runId} in this project.`, { runId });
    }
    const document = documentId ? await getDocument(documentId) : null;
    if (documentId && (!document || document.projectId !== project.id)) {
      return fail(`There is no document ${documentId} in this project.`, { documentId });
    }

    const { layer: referenced, reference } = await resolveLayerArgument(project.id, args);
    const layerId = referenced?.id ?? run?.layerId ?? document?.layerId ?? null;
    if (!layerId) return unresolvedLayer(project.id, reference);
    const layer = await getLayer(layerId);
    if (!layer) return unresolvedLayer(project.id, reference);

    const rawText = readString(args, 'json', 'text', 'raw', 'modelOutput', 'model_output');
    const parsed: StructuredAuditResult | null = rawText ? parseAuditJson(rawText) : null;
    if (rawText && !parsed) {
      return fail(
        'No structured audit object could be read out of that text. An audit is never stored as ' +
          'prose alone, so nothing was recorded.',
      );
    }

    const verdict = readEnum(readString(args, 'verdict'), AUDIT_VERDICTS) ?? parsed?.verdict ?? null;
    if (!verdict) {
      return fail(
        `No audit verdict was given. Known verdicts: ${AUDIT_VERDICTS.join(', ')}.`,
      );
    }

    const outcome = await recordAudit({
      projectId: project.id,
      layerId: layer.id,
      runId: run?.id ?? null,
      auditedDocumentId: document?.id ?? run?.targetDocumentId ?? null,
      result: {
        ...(parsed ?? {}),
        verdict,
        summary: readString(args, 'summary') ?? parsed?.summary ?? '',
        failures: readStringArray(args, 'failures') ?? parsed?.failures ?? [],
        missingDocuments:
          readStringArray(args, 'missingDocuments', 'missing_documents') ?? parsed?.missingDocuments ?? [],
        requiredResearchRuns:
          readStringArray(args, 'requiredResearchRuns', 'required_research_runs') ??
          parsed?.requiredResearchRuns ??
          [],
        requiredPatches:
          readStringArray(args, 'requiredPatches', 'required_patches') ?? parsed?.requiredPatches ?? [],
        nextAction: readString(args, 'nextAction', 'next_action') ?? parsed?.nextAction ?? '',
        nextVersion: readString(args, 'nextVersion', 'next_version') ?? parsed?.nextVersion ?? null,
        synthesisRequired:
          readBoolean(args, 'synthesisRequired', 'synthesis_required') ?? parsed?.synthesisRequired ?? undefined,
        freezeEligible:
          readBoolean(args, 'freezeEligible', 'freeze_eligible') ?? parsed?.freezeEligible ?? undefined,
        confidence: readNumber(args, 'confidence') ?? parsed?.confidence ?? null,
      },
      source: readString(args, 'source') ?? 'CHAT',
    });

    const data: AuditData = {
      auditId: outcome.audit.id,
      verdict: outcome.audit.verdict,
      layerState: outcome.layerState,
      redoRunId: outcome.redoRun?.id ?? null,
    };

    const lines = [
      `Recorded audit ${outcome.audit.id} on ${layer.name}: ${outcome.audit.verdict}.`,
      `Summary: ${outcome.audit.summary}`,
    ];
    const grouped = new Map<string, string[]>();
    for (const finding of outcome.audit.findings) {
      grouped.set(finding.findingType, [...(grouped.get(finding.findingType) ?? []), finding.content]);
    }
    for (const [type, contents] of grouped) {
      lines.push(`${type}:`);
      lines.push(...contents.map((content) => `  - ${content}`));
    }
    if (outcome.audit.nextAction) lines.push(`Next action: ${outcome.audit.nextAction}`);
    if (outcome.redoRun) {
      lines.push(
        `An automatic redo was created: ${renderRunHeader(outcome.redoRun, layer.name)}. ` +
          'The failed attempt is untouched.',
      );
    }
    lines.push(renderSnapshot(outcome.layerState));
    return ok(data, lines.join('\n'));
  },
};

const createRedoTool: ToolDefinition = {
  name: 'create_redo',
  description:
    'Chain a corrected attempt to a run: new run row, incremented attempt number, same source ' +
    'packet, prompt recompiled with the audit findings. The failed attempt is never touched.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const runId = readString(args, 'runId', 'run_id');
    const { layer } = await resolveLayerArgument(project.id, args);
    const versionArg = readString(args, 'version', 'targetVersion', 'target_version');
    const version = versionArg ? normalizeVersion(versionArg) : null;

    let parent = runId ? await getRun(runId) : null;
    if (runId && (!parent || parent.projectId !== project.id)) {
      return fail(`There is no run ${runId} in this project.`, { runId });
    }

    if (!parent) {
      const pool = (layer ? await listRunsByLayer(layer.id) : await listRuns(project.id)).filter(
        (candidate) => candidate.projectId === project.id,
      );
      const matching = version
        ? pool.filter(
            (candidate) =>
              candidate.targetVersion !== null &&
              normalizeVersion(candidate.targetVersion) === version,
          )
        : pool.filter((candidate) =>
            ['REDO_REQUIRED', 'FAILED', 'AUDIT_REQUIRED', 'COMPLETE'].includes(candidate.status),
          );
      parent = matching[0] ?? null;
      if (!parent) {
        const known = unique(
          pool
            .map((candidate) => candidate.targetVersion)
            .filter((entry): entry is string => entry !== null),
        );
        return fail(
          `There is no research run recorded${version ? ` with target version ${version}` : ''}` +
            `${layer ? ` on ${layer.name}` : ''}, so there is nothing to redo. ` +
            (known.length > 0
              ? `Runs exist for: ${known.join(', ')}.`
              : 'No runs exist in that scope at all.'),
          { version, layerId: layer?.id ?? null },
        );
      }
    }

    const reason =
      readString(args, 'reason', 'redoReason', 'redo_reason') ??
      `Redo of ${parent.targetVersion ?? parent.runType} requested from chat.`;
    const redo = await createRedoRun({
      parentRunId: parent.id,
      auditId: readString(args, 'auditId', 'audit_id'),
      reason,
      automatic: readBoolean(args, 'automatic') === true,
    });
    const dependencies = await checkRunDependencies(redo.id);
    const layerName = await layerNameFor(redo.layerId);
    const parentRun = await getRun(parent.id);

    const data: RunData = {
      run: redo,
      dependencies,
      prompt: redo.prompt,
      requiredAttachments: redo.requiredAttachments,
      expectedConversationTitle: redo.expectedConversationTitle,
      expectedFilename: redo.expectedFilename,
    };
    const lines = [
      `Created redo ${redo.id} as attempt ${redo.attemptNumber} of ${redo.targetVersion ?? 'the same target'}.`,
      `Reason: ${reason}`,
      `The original attempt ${parent.id} is untouched (status ${parentRun?.status ?? parent.status}).`,
      renderRunHeader(redo, layerName),
      renderDependencies(dependencies),
      ...renderPromptBlock(redo),
    ];
    return ok(data, lines.join('\n'));
  },
};

const markLayerFrozen: ToolDefinition = {
  name: 'mark_layer_frozen',
  description:
    'Freeze a layer on its canonical artifact, superseding the earlier documents. Refused when no ' +
    'canonical artifact exists or its file is missing.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer) return unresolvedLayer(project.id, reference);
    const canonicalDocumentId = readString(args, 'canonicalDocumentId', 'canonical_document_id', 'documentId');

    try {
      const snapshot = await freezeLayer(layer.id, canonicalDocumentId);
      return ok(
        { snapshot },
        [
          `${layer.name} is now ${snapshot.status}${snapshot.canonicalName ? ` on ${snapshot.canonicalName}` : ''}.`,
          renderSnapshot(snapshot),
        ].join('\n'),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`${layer.name} was not frozen. ${message}`, {
        layerId: layer.id,
        snapshot: await computeLayerState(layer.id),
      });
    }
  },
};

const calculateNextActionTool: ToolDefinition = {
  name: 'calculate_next_action',
  description:
    'Re-derive every layer and return the single next best action, plus the NOW / NEXT / LATER / ' +
    'BLOCKED plan. Deterministic and derived only from the database and the filesystem.',
  async run(context) {
    const project = await requireProject(context.projectId);
    const nextBestAction = await calculateNextAction(project.id);
    const plan = await buildPlan(project.id);

    const data: NextActionData = {
      nextBestAction,
      nextBestActionText: plan.nextBestActionText,
      plan: { now: plan.now, next: plan.next, later: plan.later, blocked: plan.blocked },
    };

    const lines = [`NEXT BEST ACTION: ${plan.nextBestActionText}`];
    if (nextBestAction) {
      lines.push(
        `  Layer : ${nextBestAction.layerName} (${nextBestAction.status})`,
        `  Why   : ${nextBestAction.detail}`,
      );
      if (nextBestAction.targetVersion) lines.push(`  Target: ${nextBestAction.targetVersion}`);
      if (nextBestAction.missing.length > 0) {
        lines.push(`  Missing: ${nextBestAction.missing.join(', ')}`);
      }
    }
    if (plan.next.length > 0) {
      lines.push('Then:');
      lines.push(...plan.next.slice(0, 3).map((item) => `  - ${item.title} (${item.layerName})`));
    }
    if (plan.blocked.length > 0) {
      lines.push('Blocked:');
      lines.push(
        ...plan.blocked.map(
          (item) =>
            `  - ${item.layerName}: ${item.title}` +
            `${item.missing.length > 0 ? ` — missing ${item.missing.join(', ')}` : ''}`,
        ),
      );
    }
    if (plan.later.length > 0) {
      lines.push(`Later: ${plan.later.map((item) => item.layerName).join(', ')}`);
    }
    return ok(data, lines.join('\n'));
  },
};

const scanAndReconcileTool: ToolDefinition = {
  name: 'scan_and_reconcile',
  description:
    'Walk the project folder, compare it with the database, and report unregistered files, ' +
    'missing physical files, changed checksums and orphaned records. Never deletes anything.',
  async run(context) {
    const project = await requireProject(context.projectId);
    const report = await scanAndReconcile(project.id);
    const data: ReconcileData = { report };

    const lines = [
      `Scanned ${report.scannedFiles} file(s) against ${report.registeredDocuments} registered ` +
        `document(s) in ${project.name}. State is ${report.healthy ? 'consistent' : 'INCONSISTENT'}.`,
    ];
    if (report.issues.length === 0) {
      lines.push('No issues: every registered document has its file, and every file is registered.');
    } else {
      const byKind = new Map<string, typeof report.issues>();
      for (const issue of report.issues) {
        byKind.set(issue.kind, [...(byKind.get(issue.kind) ?? []), issue]);
      }
      for (const [kind, issues] of byKind) {
        lines.push(`${kind} (${issues.length}):`);
        for (const issue of issues) {
          lines.push(
            `  - ${issue.path ?? issue.canonicalName ?? issue.documentId ?? 'unknown'}: ${issue.detail}` +
              `${issue.fixable ? ` → ${issue.suggestedFix}` : ''}`,
          );
        }
      }
    }
    return ok(data, lines.join('\n'));
  },
};

const setLayerExpectationsTool: ToolDefinition = {
  name: 'set_layer_expectations',
  description:
    'Declare which versions a layer owes, e.g. ["v1","v1B","v1C"]. This is what turns "keep ' +
    'researching" into a countable 6 / 7 and a concrete next version.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer) return unresolvedLayer(project.id, reference);

    const versions = readStringArray(
      args,
      'expectedVersions',
      'expected_versions',
      'versions',
      'expected',
    );
    if (!versions || versions.length === 0) {
      return fail('No versions were given, so the expectations were left unchanged.');
    }
    const invalid = versions.filter((version) => !isValidVersion(version));
    if (invalid.length > 0) {
      return fail(
        `These are not versions this project understands: ${invalid.join(', ')}. Use forms like v1, v1G or v3.1.`,
        { invalid },
      );
    }

    const snapshot = await setLayerExpectations(
      layer.id,
      versions.map((version) => normalizeVersion(version)),
    );
    return ok(
      { snapshot },
      [
        `${layer.name} now expects ${snapshot.expectedVersions.join(', ')}.`,
        renderSnapshot(snapshot),
      ].join('\n'),
    );
  },
};

const listRunsTool: ToolDefinition = {
  name: 'list_runs',
  description:
    'List research runs for the project or one layer, newest first, with their type, attempt ' +
    'number, status and target version.',
  async run(context, args) {
    const project = await requireProject(context.projectId);
    const { layer, reference } = await resolveLayerArgument(project.id, args);
    if (!layer && reference) return unresolvedLayer(project.id, reference);

    const statusArg = readString(args, 'status');
    const status = readEnum(statusArg, RUN_STATUSES);
    if (statusArg && !status) {
      return fail(`"${statusArg}" is not a run status. Known statuses: ${RUN_STATUSES.join(', ')}.`);
    }
    const activeOnly = readBoolean(args, 'activeOnly', 'active_only', 'active') === true;
    const limit = Math.max(1, Math.min(readNumber(args, 'limit') ?? 15, 100));

    const activeIds = new Set((await listActiveRuns(project.id)).map((run) => run.id));
    let runs = layer ? await listRunsByLayer(layer.id) : await listRuns(project.id);
    if (status) runs = runs.filter((run) => run.status === status);
    if (activeOnly) runs = runs.filter((run) => activeIds.has(run.id));
    const limited = runs.slice(0, limit);

    const data: RunsData = {
      layerId: layer?.id ?? null,
      count: runs.length,
      runs: await Promise.all(
        limited.map(async (run) => ({
          id: run.id,
          layerId: run.layerId,
          layerName: await layerNameFor(run.layerId),
          runType: run.runType,
          attemptNumber: run.attemptNumber,
          status: run.status,
          targetVersion: run.targetVersion,
          createdAt: run.createdAt,
          active: activeIds.has(run.id),
        })),
      ),
    };

    const scope = layer ? layer.name : project.name;
    if (runs.length === 0) {
      return ok(
        data,
        `No runs are recorded for ${scope}${status ? ` with status ${status}` : ''}${activeOnly ? ' that are still open' : ''}.`,
      );
    }
    const lines = [
      `${runs.length} run(s) recorded for ${scope}${status ? ` with status ${status}` : ''}` +
        `${runs.length > limited.length ? `, showing the ${limited.length} newest` : ''}:`,
      ...limited.map(
        async (run) =>
          `  ${run.id} · ${run.runType} · attempt ${run.attemptNumber} · ${run.status}` +
          `${run.targetVersion ? ` · ${run.targetVersion}` : ''} · ${await layerNameFor(run.layerId) ?? 'no layer'}` +
          ` · created ${run.createdAt}`,
      ),
    ];
    return ok(data, lines.join('\n'));
  },
};

export const TOOLS: Record<ToolName, ToolDefinition> = {
  get_project_state: getProjectState,
  get_layer_state: getLayerState,
  list_documents: listDocumentsTool,
  find_document: findDocument,
  resolve_dependencies: resolveDependencies,
  create_document: createDocumentTool,
  register_document: registerDocument,
  create_run: createRunTool,
  update_run: updateRunTool,
  compile_prompt: compilePromptTool,
  create_audit: createAuditTool,
  create_redo: createRedoTool,
  mark_layer_frozen: markLayerFrozen,
  calculate_next_action: calculateNextActionTool,
  scan_and_reconcile: scanAndReconcileTool,
  set_layer_expectations: setLayerExpectationsTool,
  list_runs: listRunsTool,
};

/**
 * Execute a tool. Failures come back as a `ToolResult` rather than an exception
 * so a chat turn always has something honest to say instead of dying.
 */
export async function runTool(
  name: ToolName,
  context: ToolContext,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const definition: ToolDefinition | undefined = TOOLS[name];
  if (!definition) {
    return fail(`There is no tool named "${name}".`, { tool: name });
  }
  try {
    return await definition.run(context, args ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`The ${name} tool could not complete: ${message}`, { tool: name, error: message });
  }
}
