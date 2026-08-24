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
 */
import type { Request, Response } from 'express';
import path from 'node:path';
import { getStorage } from '../services/storage/index.ts';
import { ObjectNotFoundError } from '../services/storage/types.ts';
import { assertSafeKey, contentTypeFor } from '../services/storage/keys.ts';

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

export async function serveStoredObject(req: Request, res: Response): Promise<void> {
  let key: string;
  try {
    key = keyForRequest(req.path);
  } catch {
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
