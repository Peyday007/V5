/**
 * Serving a stored document over HTTP.
 *
 * The rule this file exists to keep: a URL names a document Brain has
 * registered, never a location in a store. What arrives is a path under
 * `/files`; what leaves is a stream from the storage layer. Nothing in between
 * lets the caller choose where to read from.
 *
 * Three things follow from that, and all three are load-bearing.
 *
 * The request path is confined before it is used. It is turned into a key under
 * `projects/<slug>/documents/`, and anything that escapes that prefix — `..`, an
 * absolute path, a null byte — is refused rather than normalised into something
 * that happens to be safe. In local mode the store confines it a second time
 * against the resolved path, because a symlink can satisfy a string test and
 * not a filesystem one.
 *
 * The bucket is never exposed. In cloud mode the bytes are fetched by the
 * server and streamed on; no signed URL, no redirect, no bucket hostname in a
 * response. Whether Brain is cloud-backed is not something a document link
 * should reveal, and a client that could address the bucket directly would be
 * outside every check above.
 *
 * A missing object is a 404 and nothing more. The store's own wording could
 * name a path or a bucket, so it is not passed through.
 *
 * And since Step 4, the fourth thing: **the project in the path is resolved and
 * the caller's access to it is checked before a single byte is read.** This is
 * the route that hands over the actual research — the PDFs, the transcripts, the
 * reports — and it is addressed by a project *slug* rather than by an id, which
 * makes it the one place where guessing a readable name would otherwise be
 * enough. A caller who may not have the project gets the same 404 as a caller
 * who asked for a file that was never there.
 */
import type { Request, Response } from 'express';
import path from 'node:path';
import { getStorage } from '../services/storage/index.ts';
import { ObjectNotFoundError } from '../services/storage/types.ts';
import { assertSafeKey, contentTypeFor } from '../services/storage/keys.ts';
import { getProjectBySlug } from '../repos/projects.ts';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { recordIdentityEvent } from '../repos/identity.ts';

/**
 * Map a `/files/...` request onto a document key.
 *
 * `/files` was historically mounted on the projects folder, so the path begins
 * at the project slug. That URL shape is kept — links already exist — and
 * turned into the store's own `projects/<slug>/...` key here.
 */
function keyForRequest(requestPath: string): string {
  const decoded = decodeURIComponent(requestPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const key = `projects/${decoded}`;
  assertSafeKey(key);
  // Being a safe key is not enough: `projects/<slug>/documents/` is the only
  // part of the store this endpoint may read. The database, the runtime
  // snapshot and the backups are all keys too.
  const segments = key.split('/');
  if (segments.length < 4 || segments[2] !== 'documents') {
    throw new ObjectNotFoundError(key);
  }
  return key;
}

/** The project slug is the second segment of the key: `projects/<slug>/documents/…`. */
function slugForKey(key: string): string | null {
  return key.split('/')[1] ?? null;
}

/**
 * May the caller read documents belonging to the project this key names?
 *
 * Read-level, and for a worker that means the `documents:read` scope — a worker
 * granted only `project:read` can see that a document exists without being
 * handed its contents.
 */
async function mayReadDocuments(key: string): Promise<boolean> {
  const slug = slugForKey(key);
  if (!slug) return false;
  const project = await getProjectBySlug(slug);
  if (!project) return false;

  const decision = decideProjectAccess(currentPrincipal(), project.id, 'READ', 'documents:read');
  if (decision.allowed) return true;

  const context = currentContext();
  const principal = context?.principal ?? null;
  try {
    await recordIdentityEvent({
      actorType: principal ? principal.type : 'ANONYMOUS',
      actorId: principal?.id ?? null,
      credentialId: principal?.credentialId ?? null,
      action: 'AUTHORIZE_FILE',
      targetType: 'FILE',
      targetId: key,
      projectId: project.id,
      result: 'DENIED',
      reason: decision.reason,
      requestId: context?.requestId ?? null,
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    /* an unwritable audit does not change the refusal */
  }
  return false;
}

export async function serveStoredObject(req: Request, res: Response): Promise<void> {
  let key: string;
  try {
    key = keyForRequest(req.path);
  } catch {
    res.status(404).json({ error: `No file at /files${req.path}.` });
    return;
  }

  // Before the storage layer is touched at all: an unauthorized read must not
  // even reach the bucket, or its latency and its errors become a side channel
  // for whether a document exists.
  if (!await mayReadDocuments(key)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: `No file at /files${req.path}.` });
    return;
  }

  try {
    const object = await getStorage().openRead(key);
    res.setHeader('Content-Type', object.contentType || contentTypeFor(key));
    res.setHeader('Content-Length', String(object.size));
    // Inline so a PDF opens in the viewer, with the filename quoted so a comma
    // or a space in a canonical name cannot break out of the header value.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${path.basename(key).replace(/["\\]/g, '')}"`,
    );
    // A document can be superseded or reprocessed in place, and a cached copy
    // of the old bytes behind a URL that now means something else is the kind
    // of quiet inconsistency this platform exists to prevent.
    res.setHeader('Cache-Control', 'no-store');
    // Never let a stored document be framed or sniffed into something else.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    object.stream.on('error', () => {
      // The headers are already sent by now, so there is no status left to set.
      // Destroying the response is what tells the client the body is incomplete
      // rather than letting it read a truncated document as a whole one.
      res.destroy();
    });
    object.stream.pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: `No file at /files${req.path}.` });
      return;
    }
    // The store's own message can name a path or a bucket. The operator gets it
    // in the log; the client gets the fact that it failed.
    console.error('Failed to serve a stored document:', error);
    res.status(500).json({ error: 'That document could not be read from storage.' });
  }
}
