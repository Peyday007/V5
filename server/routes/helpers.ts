/**
 * Shared HTTP plumbing.
 *
 * Routes stay thin because every recurring concern lives here: input validation
 * that fails with a sentence the user can act on, entity lookups that answer 404
 * instead of letting SQLite throw, and one error middleware that maps domain
 * failures — an incomplete synthesis packet, an oversized upload — onto the
 * status code the client expects.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type {
  Audit,
  DenialReason,
  Document,
  DocumentChunk,
  ImportJob,
  Layer,
  Project,
  ResearchOrchestration,
  ResearchRun,
  WorkerScope,
} from '../domain/types.ts';
import { getAudit } from '../repos/audits.ts';
import { getChunk } from '../repos/extraction.ts';
import { getImportJob } from '../repos/imports.ts';
import { getOrchestration } from '../repos/research.ts';
import { getDocument } from '../repos/documents.ts';
import { getLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { getRun } from '../repos/runs.ts';
import { DependencyError } from '../services/synthesis.ts';
import {
  contextFromRequest,
  currentContext,
  currentPrincipal,
  runInRequestContext,
} from '../services/identity/context.ts';
import {
  decideBrainAdmin,
  decideProjectAccess,
  requirementFor,
  type AccessLevel,
} from '../services/identity/policy.ts';
import { recordIdentityEvent } from '../repos/identity.ts';

/** Never let these reach an id, a header or a filename. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/** An error that already knows which HTTP status it deserves. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

export function badRequest(message: string, detail?: unknown): HttpError {
  return new HttpError(400, message, detail);
}

export function notFound(message: string, detail?: unknown): HttpError {
  return new HttpError(404, message, detail);
}

export function conflict(message: string, detail?: unknown): HttpError {
  return new HttpError(409, message, detail);
}

/**
 * The request was understood and refused on its merits — an audit whose evidence
 * could not be read, for instance. The detail carries the proof that nothing
 * changed, so it must survive to the client.
 */
export function unprocessable(message: string, detail?: unknown): HttpError {
  return new HttpError(422, message, detail);
}

export type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Wrap a handler so that returning a value sends it as JSON and throwing —
 * synchronously or from a rejected promise — reaches `errorMiddleware`. Without
 * this an async throw would escape Express 4 entirely and hang the request.
 */
export function handler(fn: RouteHandler): RequestHandler {
  return (req, res, next) => {
    // Re-enter the request's own context before the route body runs.
    //
    // Not belt-and-braces: `multer` finishes from a socket-driven event, and an
    // AsyncLocalStorage store does not survive that. Without this, an
    // authenticated upload arrives at `requireProject` with no principal and is
    // told the project does not exist. Re-entering here makes every route body
    // — all eighty-four of them — run inside its request's context by
    // construction, whatever the middleware in front of it did.
    const context = contextFromRequest(req);
    const run = (): void => {
      void (async (): Promise<void> => {
        try {
          const payload: unknown = await fn(req, res, next);
          if (payload === undefined || res.headersSent) return;
          res.json(payload);
        } catch (error) {
          next(error);
        }
      })();
    };
    if (context) runInRequestContext(context, run);
    else run();
  };
}

/**
 * The same re-entry, for the handlers that cannot use `handler()`.
 *
 * Server-sent-event routes write their own response and return nothing, so they
 * are mounted as plain Express handlers — and they are exactly the routes where
 * losing the principal would matter most.
 */
export function withRequestContext(
  fn: (req: Request, res: Response) => void | Promise<void>,
): RequestHandler {
  return (req, res) => {
    const context = contextFromRequest(req);
    const run = (): void => {
      void fn(req, res);
    };
    if (context) runInRequestContext(context, run);
    else run();
  };
}

// ---------------------------------------------------------------------------
// Reading request input
// ---------------------------------------------------------------------------

/** The parsed JSON (or multipart field) body, guaranteed to be a plain object. */
export function bodyOf(req: Request): Record<string, unknown> {
  const raw: unknown = req.body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw) || Buffer.isBuffer(raw)) {
    throw badRequest('The request body must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

export function queryOf(req: Request): Record<string, unknown> {
  return req.query as unknown as Record<string, unknown>;
}

/** A path parameter, rejected early so a malformed id never reaches SQLite. */
export function pathId(req: Request, name: string): string {
  const raw = req.params[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) throw badRequest(`A ${name} is required in the URL path.`);
  if (value.length > 200 || CONTROL_CHARACTERS.test(value)) {
    throw badRequest(`"${value.slice(0, 40)}" is not a valid ${name}.`);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value, field);
  if (parsed === undefined) {
    throw badRequest(`"${field}" is required and must be a non-empty string.`);
  }
  return parsed;
}

/** Distinguishes "leave it alone" (undefined) from "clear it" (null). */
export function nullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string or null.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
  }
  throw badRequest(`"${field}" must be true or false.`);
}

export function optionalInteger(
  value: unknown,
  field: string,
  range: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed)) throw badRequest(`"${field}" must be a whole number.`);
  if (range.min !== undefined && parsed < range.min) {
    throw badRequest(`"${field}" must be at least ${range.min}.`);
  }
  if (range.max !== undefined && parsed > range.max) {
    throw badRequest(`"${field}" must be at most ${range.max}.`);
  }
  return parsed;
}

export function optionalNumber(
  value: unknown,
  field: string,
  range: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) throw badRequest(`"${field}" must be a number.`);
  if (range.min !== undefined && parsed < range.min) {
    throw badRequest(`"${field}" must be at least ${range.min}.`);
  }
  if (range.max !== undefined && parsed > range.max) {
    throw badRequest(`"${field}" must be at most ${range.max}.`);
  }
  return parsed;
}

/** Accepts a JSON array or a comma-separated string, so query strings work too. */
export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw: unknown[] | null = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;
  if (!raw) throw badRequest(`"${field}" must be an array of strings.`);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw badRequest(`"${field}" must contain only strings.`);
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw badRequest(`"${field}" must be one of: ${allowed.join(', ')}.`);
  }
  const normalized = value.trim().toUpperCase();
  const match = allowed.find((candidate) => candidate.toUpperCase() === normalized);
  if (!match) {
    throw badRequest(`"${value}" is not a valid ${field}. Expected one of: ${allowed.join(', ')}.`);
  }
  return match;
}

export function requiredEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const parsed = optionalEnum(value, allowed, field);
  if (parsed === undefined) {
    throw badRequest(`"${field}" is required. Expected one of: ${allowed.join(', ')}.`);
  }
  return parsed;
}

export function optionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`"${field}" must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Entity lookups — and the point at which authorization happens
// ---------------------------------------------------------------------------
//
// These four functions were already called by every route that addresses a
// project-scoped resource, which is what makes them the right place to decide
// whether the caller may have it. The alternative — a check written into each
// of eighty-four handlers — is eighty-four chances to forget one, and the one
// that gets forgotten is not discovered by anybody friendly.
//
// **A resource the caller may not have is reported as one that does not
// exist.** Not 403, not "forbidden": the same 404, with the same sentence, as
// an id that was never real. A distinguishable refusal is an oracle — feed it
// ids until one of them answers differently and you have enumerated a Brain you
// have no access to. The audit records the difference; the caller does not
// learn it.

/**
 * What this request needs, derived from its own method and path.
 *
 * Read from the request context rather than passed in, so that a handler cannot
 * accidentally ask for a weaker check than the route it belongs to implies.
 */
function requirementForCurrentRequest(): { level: AccessLevel; scope?: WorkerScope } {
  const context = currentContext();
  if (!context) {
    // No context means this is not running inside a request — boot, a queue, a
    // test calling a repository directly. Those have no principal, and the
    // check below will refuse. ADMIN is the strictest thing to ask for, so a
    // missing context can never be the reason something was allowed.
    return { level: 'ADMIN' };
  }
  return requirementFor(context.method, context.path);
}

async function auditAccessDenial(projectId: string, reason: string): Promise<void> {
  const context = currentContext();
  const principal = context?.principal ?? null;
  try {
    await recordIdentityEvent({
      actorType: principal ? principal.type : 'ANONYMOUS',
      actorId: principal?.id ?? null,
      credentialId: principal?.credentialId ?? null,
      action: 'AUTHORIZE',
      targetType: 'ROUTE',
      targetId: context ? `${context.method} ${context.path}` : null,
      projectId,
      result: 'DENIED',
      reason: reason as DenialReason,
      requestId: context?.requestId ?? null,
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    /* an unwritable audit must not change the decision it was recording */
  }
}

/**
 * The single gate. Everything below funnels through it.
 *
 * `notFound` rather than a 403, for the reason at the top of this section.
 */
export async function authorizeProject(projectId: string, label: string): Promise<void> {
  const requirement = requirementForCurrentRequest();
  const decision = decideProjectAccess(
    currentPrincipal(),
    projectId,
    requirement.level,
    requirement.scope,
  );
  if (decision.allowed) return;
  await auditAccessDenial(projectId, decision.reason ?? 'NOT_A_MEMBER');
  throw notFound(`No ${label} with that id.`);
}

/** Brain-wide administration — users, workers, credentials, provider setup. */
export async function requireBrainAdmin(): Promise<void> {
  const decision = decideBrainAdmin(currentPrincipal());
  if (decision.allowed) return;
  const context = currentContext();
  const principal = context?.principal ?? null;
  try {
    await recordIdentityEvent({
      actorType: principal ? principal.type : 'ANONYMOUS',
      actorId: principal?.id ?? null,
      credentialId: principal?.credentialId ?? null,
      action: 'AUTHORIZE_ADMIN',
      targetType: 'ROUTE',
      targetId: context ? `${context.method} ${context.path}` : null,
      result: 'DENIED',
      reason: decision.reason,
      requestId: context?.requestId ?? null,
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    /* see above */
  }
  throw notFound('No such route.');
}

/**
 * The same check as middleware, for a whole router.
 *
 * `handler()` is for routes that return a body; a guard returns nothing and has
 * to call `next()`, so it cannot be expressed as one without the request
 * hanging when the guard passes.
 */
export function brainAdminOnly(): RequestHandler {
  return (_req, _res, next) => {
    void requireBrainAdmin().then(
      () => next(),
      (error: unknown) => next(error),
    );
  };
}

export async function requireProject(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw notFound(`No project with id "${projectId}".`);
  await authorizeProject(project.id, 'project');
  return project;
}

export async function requireLayer(layerId: string): Promise<Layer> {
  const layer = await getLayer(layerId);
  if (!layer) throw notFound(`No layer with id "${layerId}".`);
  await authorizeProject(layer.projectId, 'layer');
  return layer;
}

export async function requireRun(runId: string): Promise<ResearchRun> {
  const run = await getRun(runId);
  if (!run) throw notFound(`No research run with id "${runId}".`);
  await authorizeProject(run.projectId, 'research run');
  return run;
}

export async function requireDocument(documentId: string): Promise<Document> {
  const document = await getDocument(documentId);
  if (!document) throw notFound(`No document with id "${documentId}".`);
  await authorizeProject(document.projectId, 'document');
  return document;
}

/** A layer id supplied in a body must belong to the project being addressed. */
export async function requireLayerOfProject(layerId: string, projectId: string): Promise<Layer> {
  const layer = await requireLayer(layerId);
  if (layer.projectId !== projectId) {
    throw badRequest(`Layer "${layer.name}" belongs to a different project.`);
  }
  return layer;
}

/** The project a layer belongs to — a missing one means the database is corrupt. */
export async function projectOfLayer(layer: Layer): Promise<Project> {
  const project = await getProject(layer.projectId);
  if (!project) {
    throw new HttpError(
      500,
      `Layer "${layer.name}" references project ${layer.projectId}, which does not exist.`,
    );
  }
  return project;
}

/** Runs without a layer cannot target a document, so most actions refuse them. */
export async function layerOfRun(run: ResearchRun): Promise<Layer> {
  if (!run.layerId) {
    throw badRequest(
      `Run ${run.id} is not attached to a layer, so it has no target document or prompt context.`,
    );
  }
  return await requireLayer(run.layerId);
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** Research reports are documents, not videos: 50 MB is generous and bounded. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 25;

// Memory storage: the importer hashes the buffer and writes the file into the
// project tree itself, so a temp file on disk would only be a second copy to
// clean up.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MAX_UPLOAD_FILES,
    fields: 24,
    fieldSize: 1024 * 1024,
  },
});

/** `files` — the repeatable field the import endpoint accepts. */
export const uploadManyFiles: RequestHandler = upload.array('files', MAX_UPLOAD_FILES);
/** `file` — the single artifact a completed run returns. */
export const uploadOneFile: RequestHandler = upload.single('file');

export function uploadedFiles(req: Request, field = 'files'): Express.Multer.File[] {
  const files = req.files;
  if (Array.isArray(files)) return files;
  if (files && typeof files === 'object') {
    const named = (files as Record<string, Express.Multer.File[] | undefined>)[field];
    if (Array.isArray(named)) return named;
  }
  return [];
}

export function uploadedFile(req: Request, field = 'file'): Express.Multer.File {
  const file = req.file;
  if (!file) {
    throw badRequest(
      `No file was uploaded. Send it as multipart/form-data under the field name "${field}".`,
    );
  }
  return file;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

interface MappedError {
  status: number;
  error: string;
  detail?: unknown;
}

function readableSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function mapError(error: unknown): MappedError {
  if (error instanceof HttpError) {
    return { status: error.status, error: error.message, detail: error.detail };
  }

  // An incomplete source packet is an invariant violation (invariant 4), not a
  // server fault: 409 plus the full check result so the UI can list what is
  // missing without a second round trip.
  if (error instanceof DependencyError) {
    return { status: 409, error: error.message, detail: error.result };
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than the ${readableSize(MAX_UPLOAD_BYTES)} upload limit.`
        : error.code === 'LIMIT_FILE_COUNT'
          ? `Too many files in one upload — the limit is ${MAX_UPLOAD_FILES}.`
          : error.code === 'LIMIT_UNEXPECTED_FILE'
            ? `Unexpected upload field "${error.field ?? 'unknown'}".`
            : error.message;
    return {
      status: 400,
      error: message,
      detail: { code: error.code, field: error.field ?? null },
    };
  }

  const candidate = (error ?? null) as {
    name?: unknown;
    message?: unknown;
    result?: unknown;
    status?: unknown;
    statusCode?: unknown;
  } | null;

  // Same shape, different module instance (tsx and vitest can load a module
  // twice); the invariant is what matters, not object identity.
  if (
    candidate &&
    candidate.name === 'DependencyError' &&
    typeof candidate.result === 'object' &&
    candidate.result !== null
  ) {
    return {
      status: 409,
      error:
        typeof candidate.message === 'string' ? candidate.message : 'The source packet is incomplete.',
      detail: candidate.result,
    };
  }

  if (error instanceof SyntaxError && candidate && typeof candidate.status === 'number') {
    return { status: 400, error: 'The request body is not valid JSON.' };
  }

  const rawStatus =
    typeof candidate?.status === 'number'
      ? candidate.status
      : typeof candidate?.statusCode === 'number'
        ? candidate.statusCode
        : null;
  const status = rawStatus !== null && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'The server hit an unexpected error.';
  return { status, error: message };
}

/** The single place an exception becomes a JSON response. */
export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const mapped = mapError(error);
  if (mapped.status >= 500) {
    console.error('[brain] unhandled API error:', error);
  }
  const body: { error: string; detail?: unknown } = { error: mapped.error };
  if (mapped.detail !== undefined) body.detail = mapped.detail;
  res.status(mapped.status).json(body);
}

/**
 * Services signal invariant violations — freezing without a canonical artifact,
 * redoing past the automatic cap — by throwing. Those are decisions the user can
 * act on, so they become 409s carrying the original sentence, never an
 * anonymous 500.
 */
export function asInvariantViolation<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DependencyError) throw error;
    throw conflict(error instanceof Error ? error.message : String(error));
  }
}

/** Unmatched API paths answer JSON, so the client never has to parse HTML. */
export function apiNotFound(req: Request, res: Response): void {
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}.` });
}

// ---------------------------------------------------------------------------
// Resources addressed by their own id, and the lineage that authorizes them
// ---------------------------------------------------------------------------
//
// An audit, a research orchestration, an import job and a text chunk are each
// reachable by an id of their own, without a project or a layer anywhere in the
// URL. That is exactly the shape the direct-object rule exists for: guessing
// `/api/audits/aud_…` must not be a way around a membership check just because
// the path does not happen to mention a project.
//
// Each of these traces the resource back to the project that owns it and then
// asks the same question the four resolvers above ask. A chunk goes through its
// document, because a chunk knows which document it came from and nothing else.

export async function requireAudit(auditId: string): Promise<Audit> {
  const audit = await getAudit(auditId);
  if (!audit) throw notFound(`No audit with id "${auditId}".`);
  await authorizeProject(audit.projectId, 'audit');
  return audit;
}

export async function requireOrchestration(
  orchestrationId: string,
): Promise<ResearchOrchestration> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) throw notFound(`No research run with id "${orchestrationId}".`);
  await authorizeProject(orchestration.projectId, 'research run');
  return orchestration;
}

export async function requireImportJob(jobId: string): Promise<ImportJob> {
  const job = await getImportJob(jobId);
  if (!job) throw notFound(`No import job with id "${jobId}".`);
  await authorizeProject(job.projectId, 'import job');
  return job;
}

export async function requireChunk(chunkId: string): Promise<DocumentChunk> {
  const chunk = await getChunk(chunkId);
  if (!chunk) throw notFound(`No chunk with id "${chunkId}".`);
  // Through the document, which is the only thing a chunk knows about.
  await requireDocument(chunk.documentId);
  return chunk;
}
