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
  ImportResult,
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
import type { ProviderStatus } from '../../../server/providers/types.ts';
import type { ChatTurnResult } from '../../../server/services/agent/chat.ts';

export type { ChatTurnResult, ProviderStatus, MigrationReport };

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
