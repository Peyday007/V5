/**
 * What a Brain that could not boot answers, while it asks again.
 *
 * Kept apart from `index.ts` so the answers can be tested without booting.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { DatabaseConfigurationError } from './db/types.ts';
import { CREDENTIAL_NOT_CHECKED, RETRY_AFTER_SECONDS } from './routes/unavailable.ts';
import { TRANSPORT_REFUSED } from './mcp/protocol.ts';

export function bootFailureApp(
  error: Error,
  options: { retrying?: boolean; databasePath: string; dataRoot: string },
): express.Express {
  const DB_PATH = options.databasePath;
  const DATA_ROOT = options.dataRoot;
  const configuration = error instanceof DatabaseConfigurationError;
  const headline = configuration
    ? 'Brain could not start: its persistence configuration is not usable.'
    : 'Brain could not start: the application failed to migrate the database.';
  const hint = configuration
    ? `${error.detail} Nothing was written locally, and nothing fell back.`
    : 'Applied migrations are checksum-locked. If you edited a migration that had already run, ' +
      'restore the original file and add a new server/db/migrations/NNN_name.sql instead.';

  const app = express();
  app.disable('x-powered-by');
  /*
   * While the boot is being asked again (`bootRetry.ts`), this is a Brain that
   * is restarting rather than one that is broken, and every caller is told so
   * in the words it understands: 503 and `Retry-After`, never a 500. A
   * connector refreshing at `/oauth/token` gets RFC 6749's
   * `temporarily_unavailable` rather than a page of text it would have to read
   * as a failed grant, and an MCP client gets the same retryable JSON-RPC
   * answer the door gives when the database does not answer — the credential
   * was not judged, so nothing may read it as refused.
   */
  const status = options.retrying ? 503 : 500;
  if (options.retrying) {
    app.use((_req: Request, res: Response, next: () => void) => {
      res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    app.use('/oauth/token', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'temporarily_unavailable', error_description: CREDENTIAL_NOT_CHECKED });
    });
    app.use('/mcp', (_req: Request, res: Response) => {
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: TRANSPORT_REFUSED, message: CREDENTIAL_NOT_CHECKED, data: { retryable: true, category: 'INFRA_RETRYABLE' } },
      });
    });
  }
  app.use('/api', (_req: Request, res: Response) => {
    res.status(status).json({
      ...(options.retrying ? { retryable: true } : {}),
      error: `${headline} ${error.message}`,
      detail: {
        stage: configuration ? 'CONFIGURATION' : 'MIGRATION',
        // Never the connection string: the point of the diagnostic is what to
        // fix, and the value contains a password.
        databasePath: configuration ? '(configured elsewhere)' : DB_PATH,
        dataRoot: DATA_ROOT,
        hint,
      },
    });
  });
  app.use((_req: Request, res: Response) => {
    res
      .status(status)
      .type('text/plain')
      .send(`${headline}\n\n${error.message}\n\n${hint}\n\nDatabase: ${DB_PATH}\nData root: ${DATA_ROOT}\n`);
  });

  return app;
}
