/**
 * What a request answers when an error escapes its handler.
 *
 * Express 4 does not await a handler, so every async route body in this
 * repository runs as a fire-and-forget promise — and a rejection nobody
 * catches is, on Node 22, the end of the process. Production, 2026-09-24 at
 * 02:25:29Z: the database pool timed out inside `POST /oauth/token`, the
 * rejection escaped, and the Brain exited with code 1 in the middle of a
 * deploy's post-restart verification. One slow query in one route took every
 * other request down with it, and the machine then rebooted into a bucket
 * answering 544.
 *
 * An error escaping a request is a failure of *that* request. It is answered
 * as unavailable — `503`, because every condition that reaches here is one
 * the caller may retry — and logged. Nothing about the answer names what
 * failed (§17: an error inside authentication must not explain how the check
 * works), and nothing about it is a pass: a request whose authorization threw
 * is refused.
 */
import type { Response } from 'express';

/** The body every escaped failure answers with. OAuth's own code for it. */
export const ESCAPED_FAILURE_BODY = { error: 'temporarily_unavailable' } as const;

export function answerEscapedFailure(res: Response, where: string): (error: unknown) => void {
  return (error: unknown): void => {
    // eslint-disable-next-line no-console
    console.error(`[brain] ${where} failed:`, error);
    if (res.headersSent) {
      // The response had begun; the only honest thing left is to end it.
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(503).json(ESCAPED_FAILURE_BODY);
  };
}
