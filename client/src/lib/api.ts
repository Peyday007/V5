/**
 * The single door between the UI and the server.
 *
 * Every screen in Brain answers "what is true right now?", so no component is
 * allowed to hold remembered state: it calls one of these functions and renders
 * what comes back. Domain types are imported type-only from the server so the
 * two halves of the app can never drift, and nothing from the server is bundled.
 */
import type { MigrationReport } from '../../../server/db/migrate.ts';
import type {
  Audit,
  CompiledPrompt,
  Conversation,
  DependencyCheckResult,
  Document,
  DocumentScope,
  DocumentSegment,
  ImportResult,
  LinkStatus,
  LinkType,
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  ResearchPass,
  SegmentLayerLink,
  Layer,
  LayerStateSnapshot,
  Message,
  PlannerItem,
  PlannerResult,
  Project,
  ProjectEvent,
  ReconcileReport,
  ResearchRun,
} from '../../../server/domain/types.ts';
import type { IngestionReport } from '../../../server/services/sources/ingest.ts';
import type { GateResult } from '../../../server/services/research/gate.ts';
import type { LedgerSummary } from '../../../server/services/research/sources.ts';
import type { ProviderStatus } from '../../../server/providers/types.ts';
import type { ChatTurnResult } from '../../../server/services/agent/chat.ts';

export type { ChatTurnResult, ProviderStatus, MigrationReport, IngestionReport };
export type { ResearchOrchestration, ResearchFragment, ResearchPass, ResearchClaim };
export type { GateResult, LedgerSummary };
export type { DocumentSegment, SegmentLayerLink, LinkStatus, LinkType, DocumentScope };

// ---------------------------------------------------------------------------
// Response shapes (the exact bodies documented in the HTTP contract)
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  schemaVersion: number;
  driver: string;
  databasePath: string;
  dataRoot: string;
  migrations: MigrationReport | null;
  providers: ProviderStatus[];
  /** Present only when the server booted into a broken state. */
  error?: string | null;
  detail?: unknown;
}

export interface ProjectDetailResponse {
  project: Project;
  layers: Layer[];
  state: LayerStateSnapshot[];
  plan: PlannerResult;
}

export interface LayerDetailResponse {
  layer: Layer;
  state: LayerStateSnapshot;
  documents: Document[];
  runs: ResearchRun[];
  audits: Audit[];
  dependencies: DependencyCheckResult;
  events: ProjectEvent[];
}

export interface RunDetailResponse {
  run: ResearchRun;
  layer: Layer | null;
  dependencies: DependencyCheckResult;
  audits: Audit[];
  lineage: ResearchRun[];
}

/** Aliases matching the contract's short names; the `*Response` names exist so a
 *  component called `LayerDetail` can import its own payload type without a clash. */
export type ProjectDetail = ProjectDetailResponse;
export type LayerDetail = LayerDetailResponse;
export type RunDetail = RunDetailResponse;

export interface ImportMeta {
  layerId?: string;
  version?: string;
  documentType?: string;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A failed HTTP call, carrying the status and whatever the server said. */
export class ApiError extends Error {
  readonly status: number;
  /** The server's `detail` payload — e.g. the DependencyCheckResult behind a 409. */
  readonly detail: unknown;
  /** The whole error envelope, for the rare caller that needs more than `detail`. */
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    // Errors are `{ error, detail? }`. Callers want the detail itself; handing
    // them the envelope makes every structured-error branch silently dead.
    this.detail =
      body && typeof body === 'object' && 'detail' in body
        ? (body as { detail: unknown }).detail
        : body;
  }
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 400);
  return fallback;
}

/**
 * Perform one API call. Non-2xx responses become `ApiError` so callers never
 * have to inspect `response.ok`, and a dead server becomes a readable message
 * instead of an unhandled `TypeError: Failed to fetch`.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  const body = init?.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && body !== null && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    throw new ApiError(
      `Cannot reach the Brain server (${path}). Is it running on the configured port?`,
      0,
      cause,
    );
  }

  const text = await response.text();
  const payload = parseBody(text);

  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText || 'Request failed'} (${path})`;
    throw new ApiError(messageFromBody(payload, fallback), response.status, payload);
  }

  return payload as T;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const Api = {
  /** Boot probe: schema version, driver, data root, migration report, providers. */
  health(): Promise<HealthResponse> {
    return api<HealthResponse>('/api/health');
  },

  projects(): Promise<{ projects: Project[] }> {
    return api<{ projects: Project[] }>('/api/projects');
  },

  /** Project, layers, derived layer state and the plan in one round trip. */
  project(projectId: string): Promise<ProjectDetail> {
    return api<ProjectDetail>(`/api/projects/${enc(projectId)}`);
  },

  plan(projectId: string): Promise<{ plan: PlannerResult }> {
    return api<{ plan: PlannerResult }>(`/api/projects/${enc(projectId)}/plan`);
  },

  nextAction(projectId: string): Promise<{ action: PlannerItem | null; text: string }> {
    return api<{ action: PlannerItem | null; text: string }>(
      `/api/projects/${enc(projectId)}/next-action`,
    );
  },

  /** Every registered document in the project, layer-scoped and project-wide alike. */
  projectDocuments(projectId: string): Promise<{ documents: Document[] }> {
    return api<{ documents: Document[] }>(`/api/projects/${enc(projectId)}/documents`);
  },

  events(projectId: string, limit?: number): Promise<{ events: ProjectEvent[] }> {
    return api<{ events: ProjectEvent[] }>(
      `/api/projects/${enc(projectId)}/events${query({ limit })}`,
    );
  },

  recompute(projectId: string): Promise<{ plan: PlannerResult }> {
    return post<{ plan: PlannerResult }>(`/api/projects/${enc(projectId)}/recompute`);
  },

  /** Compare the database against the project folder (invariants 8 and 9). */
  reconcile(projectId: string): Promise<{ report: ReconcileReport }> {
    return post<{ report: ReconcileReport }>(`/api/projects/${enc(projectId)}/reconcile`);
  },

  reconcileFix(
    projectId: string,
    body: unknown,
  ): Promise<{ ok: boolean; message: string; report: ReconcileReport }> {
    return post<{ ok: boolean; message: string; report: ReconcileReport }>(
      `/api/projects/${enc(projectId)}/reconcile/fix`,
      body,
    );
  },

  /** Multipart upload; the server stores every original and infers metadata. */
  importFiles(
    projectId: string,
    files: File[],
    meta?: ImportMeta,
  ): Promise<{ results: ImportResult[] }> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    if (meta?.layerId) form.append('layerId', meta.layerId);
    if (meta?.version) form.append('version', meta.version);
    if (meta?.documentType) form.append('documentType', meta.documentType);
    return api<{ results: ImportResult[] }>(`/api/projects/${enc(projectId)}/import`, {
      method: 'POST',
      body: form,
    });
  },

  resolveImport(projectId: string, body: unknown): Promise<{ result: ImportResult }> {
    return post<{ result: ImportResult }>(`/api/projects/${enc(projectId)}/import/resolve`, body);
  },

  layer(layerId: string): Promise<LayerDetail> {
    return api<LayerDetail>(`/api/layers/${enc(layerId)}`);
  },

  patchLayer(layerId: string, body: unknown): Promise<unknown> {
    return api<unknown>(`/api/layers/${enc(layerId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  /** Set expected versions to the versions actually on disk (post bulk import). */
  deriveExpectations(layerId: string): Promise<unknown> {
    return post<unknown>(`/api/layers/${enc(layerId)}/expectations/derive`);
  },

  freeze(layerId: string, canonicalDocumentId?: string): Promise<unknown> {
    return post<unknown>(`/api/layers/${enc(layerId)}/freeze`, { canonicalDocumentId });
  },

  reopen(layerId: string, reason: string): Promise<unknown> {
    return post<unknown>(`/api/layers/${enc(layerId)}/reopen`, { reason });
  },

  synthesis(layerId: string, body?: unknown): Promise<unknown> {
    return post<unknown>(`/api/layers/${enc(layerId)}/synthesis`, body ?? {});
  },

  /** Preview only — compiles a prompt without persisting a run. */
  promptPreview(
    layerId: string,
    runType: string,
    targetVersion?: string,
  ): Promise<{ compiled: CompiledPrompt; dependencies: DependencyCheckResult }> {
    return api<{ compiled: CompiledPrompt; dependencies: DependencyCheckResult }>(
      `/api/layers/${enc(layerId)}/prompt${query({ runType, targetVersion })}`,
    );
  },

  createRun(layerId: string, body: unknown): Promise<unknown> {
    return post<unknown>(`/api/layers/${enc(layerId)}/runs`, body);
  },

  run(runId: string): Promise<RunDetail> {
    return api<RunDetail>(`/api/runs/${enc(runId)}`);
  },

  startRun(runId: string): Promise<unknown> {
    return post<unknown>(`/api/runs/${enc(runId)}/start`);
  },

  completeRun(runId: string, body: unknown): Promise<unknown> {
    return post<unknown>(`/api/runs/${enc(runId)}/complete`, body);
  },

  failRun(runId: string, reason: string): Promise<unknown> {
    return post<unknown>(`/api/runs/${enc(runId)}/fail`, { failureReason: reason });
  },

  auditRun(runId: string, body: unknown): Promise<unknown> {
    return post<unknown>(`/api/runs/${enc(runId)}/audit`, body);
  },

  /** Never destroys the failed attempt — the server creates a new child run. */
  redoRun(runId: string, reason: string): Promise<unknown> {
    return post<unknown>(`/api/runs/${enc(runId)}/redo`, { reason });
  },

  uploadRunResult(runId: string, file: File): Promise<unknown> {
    const form = new FormData();
    form.append('file', file, file.name);
    return api<unknown>(`/api/runs/${enc(runId)}/result-file`, { method: 'POST', body: form });
  },

  chatHistory(projectId: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    return api<{ conversation: Conversation; messages: Message[] }>(
      `/api/chat${query({ projectId })}`,
    );
  },

  sendChat(projectId: string, content: string): Promise<ChatTurnResult> {
    return post<ChatTurnResult>('/api/chat', { projectId, content });
  },

  /** Streamed inline by the server; 404 when the physical file is gone. */
  documentFileUrl(documentId: string): string {
    return `/api/documents/${enc(documentId)}/file`;
  },

  /** One-click dynamic audit of a single research artifact. */
  dynamicAuditDocument(documentId: string, body: unknown = {}): Promise<DynamicAuditResponse> {
    return api(`/api/documents/${enc(documentId)}/dynamic-audit`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  dynamicAuditRun(runId: string, body: unknown = {}): Promise<DynamicAuditResponse> {
    return api(`/api/runs/${enc(runId)}/dynamic-audit`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** The Wave-3 question: is this layer's whole packet ready? */
  packetAudit(layerId: string, body: unknown = {}): Promise<DynamicAuditResponse> {
    return api(`/api/layers/${enc(layerId)}/packet-audit`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** What a packet audit would read, before it runs. */
  packetManifest(layerId: string): Promise<PacketManifestView> {
    return api(`/api/layers/${enc(layerId)}/packet-manifest`);
  },

  /** How much of a document Brain has actually managed to read. */
  extraction(documentId: string): Promise<ExtractionView> {
    return api(`/api/documents/${enc(documentId)}/extraction`);
  },

  extractedText(documentId: string): Promise<ExtractedTextView> {
    return api(`/api/documents/${enc(documentId)}/text`);
  },

  reprocess(documentId: string): Promise<ExtractionView> {
    return api(`/api/documents/${enc(documentId)}/reprocess`, { method: 'POST' });
  },

  /** Import a project-wide source and read it in one step. */
  importProjectSource(
    projectId: string,
    files: File[],
    scope: DocumentScope = 'PROJECT_MASTER_TRANSCRIPT',
  ): Promise<{ results: { import: ImportResult; report: IngestionReport | null }[] }> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    form.append('scope', scope);
    return api(`/api/projects/${enc(projectId)}/import-source`, { method: 'POST', body: form });
  },

  /** Read a file that was stored before this existed and never registered. */
  reprocessUnfiled(
    projectId: string,
    relativePath: string,
    scope: DocumentScope = 'PROJECT_MASTER_TRANSCRIPT',
  ): Promise<{ import: ImportResult; report: IngestionReport | null }> {
    return post(`/api/projects/${enc(projectId)}/reprocess-unfiled`, { relativePath, scope });
  },

  /** What a file was found to be about, and which parts of the project it touches. */
  ingestion(documentId: string): Promise<IngestionView> {
    return api(`/api/documents/${enc(documentId)}/ingestion`);
  },

  /** Read a source again: extract, segment, classify, propose. Decisions survive. */
  ingest(
    documentId: string,
    body?: { scope?: DocumentScope; force?: boolean },
  ): Promise<{ document: Document; report: IngestionReport }> {
    return post(`/api/documents/${enc(documentId)}/ingest`, body ?? {});
  },

  /** Accept, redirect or exclude one proposed link. */
  decideLink(
    documentId: string,
    linkId: string,
    body: { status: LinkStatus; linkType?: LinkType; layerId?: string; version?: string | null },
  ): Promise<{ link: SegmentLayerLink; links: SegmentLayerLink[] }> {
    return api(`/api/documents/${enc(documentId)}/links/${enc(linkId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  /** Whether research can run here: the engine and the worker, answered separately. */
  researchReadiness(): Promise<ResearchReadiness> {
    return api('/api/research/readiness');
  },

  /** Start a staged research assignment. Returns as soon as it is queued. */
  startResearch(
    layerId: string,
    body: { assignment: string; title?: string; provider?: string; model?: string },
  ): Promise<ResearchView> {
    return post(`/api/layers/${enc(layerId)}/research`, body);
  },

  layerResearch(layerId: string): Promise<{ orchestrations: ResearchOrchestration[] }> {
    return api(`/api/layers/${enc(layerId)}/research`);
  },

  research(orchestrationId: string): Promise<ResearchView> {
    return api(`/api/research/${enc(orchestrationId)}`);
  },

  cancelResearch(orchestrationId: string, reason?: string): Promise<ResearchView> {
    return post(`/api/research/${enc(orchestrationId)}/cancel`, { reason });
  },

  resumeResearch(orchestrationId: string): Promise<ResearchView> {
    return post(`/api/research/${enc(orchestrationId)}/resume`, {});
  },

  /** Follow a citation back to the passage it rests on. */
  citation(chunkId: string): Promise<CitationView> {
    return api(`/api/documents/chunks/${enc(chunkId)}`);
  },

  /** What research automation can do here, and the action that re-checks it. */
  researchStatus(): Promise<{ status: ResearchProviderStatusView; default: string }> {
    return api('/api/providers/status');
  },

  checkResearchConnection(): Promise<{ status: ResearchProviderStatusView; default: string }> {
    return api('/api/providers/status/check', { method: 'POST' });
  },

  /** Ask the evidence a question and get passages with page anchors back. */
  searchLayerEvidence(layerId: string, query: string): Promise<EvidenceSearchView> {
    return api(`/api/layers/${enc(layerId)}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  },

  searchDocumentEvidence(documentId: string, query: string): Promise<EvidenceSearchView> {
    return api(`/api/documents/${enc(documentId)}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  },

  /** The structured index over a document, and the action that derives it. */
  findings(documentId: string): Promise<FindingsView> {
    return api(`/api/documents/${enc(documentId)}/findings`);
  },

  extractFindings(documentId: string, provider?: string | null): Promise<FindingsResultView> {
    return api(`/api/documents/${enc(documentId)}/findings`, {
      method: 'POST',
      body: JSON.stringify(provider ? { provider } : {}),
    });
  },
};

// ---------------------------------------------------------------------------
// Document understanding
// ---------------------------------------------------------------------------

export interface ExtractionQualityView {
  status: string;
  pagesExpected: number;
  pagesReadable: number;
  pagesOcr: number;
  pagesFailed: number[];
  characterCount: number;
  warnings: string[];
  coverageRatio: number;
  pipelineVersion: string;
  blockedReason: string | null;
}

export interface ExtractionRunView {
  id: string;
  status: string;
  detectedFormat: string | null;
  pagesExpected: number;
  pagesReadable: number;
  pagesOcr: number;
  coverageRatio: number;
  warnings: string[];
  blockedReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** What OCR did to one page: the picture it read, and how sure it was. */
export interface OcrPageView {
  page: number;
  ok: boolean;
  imageHash: string | null;
  width: number | null;
  height: number | null;
  dpi: number | null;
  confidence: number | null;
  durationMs: number | null;
  blocks: number;
  characters: number;
  warnings: string[];
}

export interface OcrStatusView {
  available: boolean;
  engine: string;
  engineVersion: string | null;
  recognizerPath: string | null;
  recognizerSource: string | null;
  renderer: string | null;
  rendererVersion: string | null;
  rendererPath: string | null;
  reason: string;
  install: string[];
  dpi: number;
  language: string;
  timeoutMs: number;
  disabled: boolean;
}

export interface ExtractionView {
  document: Document;
  run: ExtractionRunView | null;
  history: ExtractionRunView[];
  quality: ExtractionQualityView | null;
  ocrPages: OcrPageView[];
  ocrEngine: string | null;
  ocrEngineVersion: string | null;
  ocrRendererVersion: string | null;
  ocr: OcrStatusView;
}

/** The last ingestion of one source, with everything a reviewer needs on screen. */
export interface IngestionView {
  document: Document;
  report: IngestionReport | null;
  segments: DocumentSegment[];
  links: SegmentLayerLink[];
}

/** One research assignment, everything about it, in one payload. */
export interface ResearchView {
  orchestration: ResearchOrchestration;
  running: boolean;
  /** Newest attempt per fragment — what the queue and the synthesis act on. */
  fragments: ResearchFragment[];
  /** Every attempt, including the failed ones: the repair history. */
  attempts: ResearchFragment[];
  passes: ResearchPass[];
  claims: ResearchClaim[];
  ledger: LedgerSummary;
  fragmentsByStatus: Record<string, number>;
  synthesisReady: boolean;
  document: Document | null;
  audit: Audit | null;
  run: ResearchRun | null;
  lineage: ResearchOrchestration[];
  plan?: PlannerResult;
}

export interface ResearchReadiness {
  orchestration: { ready: boolean; queueDepth: number; detail: string };
  worker: {
    provider: string;
    installed: boolean;
    authenticated: boolean;
    automationReady: boolean;
    version: string | null;
    model: string | null;
    quotaState: string;
    lastCheckedAt: string;
    message: string;
  };
  providers: ProviderStatus[];
}

export interface ExtractedTextView {
  document: Document;
  run: ExtractionRunView;
  pages: { pageNumber: number; blocks: { blockType: string; text: string; method: string }[] }[];
}

/**
 * What research automation can do on this machine (section 1).
 *
 * Four separate facts on purpose: each one maps to a different thing the user
 * would have to do next, so collapsing them into "available" would throw away
 * exactly the part that makes the setup card useful.
 */
export interface ResearchProviderStatusView {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  automationReady: boolean;
  version: string | null;
  model: string | null;
  quotaState: 'available' | 'limited' | 'exhausted' | 'unknown';
  lastCheckedAt: string;
  message: string;
}

export interface DocumentFindingView {
  id: string;
  extractionRunId: string;
  documentId: string;
  chunkId: string | null;
  findingType: string;
  ordinal: number;
  content: string;
  evidencePage: number | null;
  evidenceQuote: string;
  confidence: number | null;
  source: string;
  createdAt: string;
}

export interface FindingsView {
  document: Document;
  extractionRunId: string | null;
  findings: DocumentFindingView[];
}

export interface FindingsResultView {
  documentId: string;
  extractionRunId: string;
  provider: string;
  chunksRead: number;
  chunksSkipped: number;
  findings: DocumentFindingView[];
  rejected: { chunkIndex: number; content: string; reason: string }[];
}

export interface ManifestEntryView {
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

export interface PacketManifestView {
  layer: Layer;
  manifest: {
    mode: string;
    layerName: string;
    generatedAt: string;
    documents: ManifestEntryView[];
    totalPages: number;
    totalCharacters: number;
    unreadable: ManifestEntryView[];
    excluded: { canonicalName: string; version: string; reason: string }[];
    complete: boolean;
  };
  dependencies: DependencyCheckResult;
  auditable: boolean;
}

export interface CitationView {
  chunk: { id: string; pageStart: number; pageEnd: number; headingPath: string[] };
  document: Document;
  blocks: { pageNumber: number; blockType: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Dynamic audit
// ---------------------------------------------------------------------------

export interface AuditHeadline {
  verdict: string;
  moreResearchRuns: number;
  nextAction: string;
  summary: string;
}

export interface AuditPassView {
  id: string;
  passKey: string;
  ordinal: number;
  provider: string | null;
  model: string | null;
  prompt: string;
  rawResponse: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
}

export interface ResearchCandidateView {
  layerId: string;
  layerName: string;
  title: string;
  researchQuestion: string;
  expectedContribution: string | null;
  classification: string;
}

export interface DynamicAuditResponse {
  audit: Audit;
  state: LayerStateSnapshot;
  plan: PlannerResult;
  pipelineId: string;
  passes: AuditPassView[];
  researchCandidates: ResearchCandidateView[];
  adversarial: { attacks: { attack: string; material: boolean; reasoning: string }[]; strongestReasonNotToAdvance: string };
  primary: {
    assignmentSatisfied: string;
    requirementFindings: string[];
    structuralFindings: string[];
    boundaryFindings: string[];
    consistencyFindings: { relation: string; detail: string }[];
    notes: string;
  };
  headline: AuditHeadline;
  /** The citation trail: which passage each conclusion can be checked against. */
  evidence: AuditEvidenceView[];
}

export interface AuditEvidenceView {
  id: string;
  auditId: string;
  gapId: string | null;
  documentId: string | null;
  extractionRunId: string | null;
  chunkId: string | null;
  documentLabel: string;
  pageNumber: number | null;
  quote: string;
  createdAt: string;
}

export interface EvidenceSearchView {
  query: string;
  passages: {
    documentId: string;
    documentLabel: string;
    extractionRunId: string;
    chunkId: string;
    pageStart: number;
    pageEnd: number;
    headingPath: string[];
    quote: string;
    score: number;
    fromOcr: boolean;
  }[];
  searched: { documentId: string; documentLabel: string; chunkCount: number }[];
  unreadable: { documentId: string; documentLabel: string; reason: string }[];
}

export type AuditStreamEvent =
  | { type: 'progress'; passKey: string; index: number; total: number; label: string }
  | { type: 'result'; result: DynamicAuditResponse }
  | { type: 'failed'; error: string; detail: unknown };

/**
 * Stream an audit, emitting one event per pass.
 *
 * The passes genuinely take time against a real provider, so the progress the
 * user sees is the server's actual position rather than an animation.
 */
export async function streamAudit(
  path: string,
  onEvent: (event: AuditStreamEvent) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.body) throw new ApiError('The audit stream returned no body.', response.status, null);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const eventName = /^event: (.+)$/m.exec(frame)?.[1]?.trim();
      const dataLine = /^data: (.*)$/m.exec(frame)?.[1];
      if (eventName && dataLine) {
        const payload: unknown = JSON.parse(dataLine);
        if (eventName === 'progress') {
          onEvent({ type: 'progress', ...(payload as { passKey: string; index: number; total: number; label: string }) });
        } else if (eventName === 'result') {
          onEvent({ type: 'result', result: payload as DynamicAuditResponse });
        } else if (eventName === 'failed') {
          const failure = payload as { error: string; detail: unknown };
          onEvent({ type: 'failed', error: failure.error, detail: failure.detail });
        }
      }
      split = buffer.indexOf('\n\n');
    }
  }
}

export const auditStreamPaths = {
  document: (documentId: string): string => `/api/documents/${enc(documentId)}/dynamic-audit/stream`,
  run: (runId: string): string => `/api/runs/${enc(runId)}/dynamic-audit/stream`,
  packet: (layerId: string): string => `/api/layers/${enc(layerId)}/packet-audit/stream`,
};

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

function legacyCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

/**
 * COPY PROMPT is the MVP workflow, so copying must work even though the app is
 * served over plain http on localhost, where `navigator.clipboard` is often
 * unavailable. Falls back to the old textarea + execCommand trick.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or an insecure context — fall through to the fallback.
  }
  return legacyCopy(text);
}
