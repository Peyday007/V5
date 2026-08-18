/**
 * Server bootstrap.
 *
 * The boot order is the product: migrate, seed, recompute, then serve. By the
 * time the port is open the database is at the current schema, the project tree
 * exists on disk, every layer status has been re-derived and
 * `data/runtime/project-state.json` matches — so the first request the UI makes
 * already returns the truth, and the user never has to "go update the database".
 *
 * A migration failure is the one thing that stops all of that, and it is handled
 * explicitly: instead of a dead port, a minimal app answers every `/api` request
 * with the reason it could not start.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { closeDatabase, initDatabase } from './db/database.ts';
import type { MigrationReport } from './db/migrate.ts';
import {
  DATA_ROOT,
  DB_PATH,
  IS_PRODUCTION,
  PORT,
  PROJECTS_ROOT,
  REPO_ROOT,
  ensureDataDirs,
} from './env.ts';
import { getDefaultProject, listProjects } from './repos/projects.ts';
import { errorMiddleware } from './routes/helpers.ts';
import { createApiRouter } from './routes/index.ts';
import { seedIfEmpty } from './seed.ts';
import { writeProjectState } from './services/runtimeState.ts';
import { recomputeProject } from './services/stateEngine.ts';

/**
 * `node:sqlite` prints an experimental-feature warning the moment it is loaded.
 * The user did not choose that dependency and cannot act on the warning, so this
 * one message is filtered by name AND text — every other warning, including
 * future experimental ones, still reaches the console.
 */
function suppressSqliteExperimentalWarning(): void {
  const original = process.emit.bind(process) as (
    event: string | symbol,
    ...args: unknown[]
  ) => boolean;

  const patched = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'warning') {
      const warning = args[0];
      if (
        warning instanceof Error &&
        warning.name === 'ExperimentalWarning' &&
        warning.message.includes('SQLite is an experimental feature')
      ) {
        return false;
      }
    }
    return original(event, ...args);
  };

  process.emit = patched as unknown as typeof process.emit;
}

// Installed before anything opens the database, which is the only thing that
// loads `node:sqlite` (the driver requires it lazily).
suppressSqliteExperimentalWarning();

const CLIENT_DIST = path.join(REPO_ROOT, 'client', 'dist');
const CLIENT_INDEX = path.join(CLIENT_DIST, 'index.html');

/** True for any path the SPA fallback must not swallow. */
function isServerPath(requestPath: string): boolean {
  return requestPath === '/api' || requestPath.startsWith('/api/') || requestPath.startsWith('/files');
}

function buildApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  // Prompts and pasted audit text are large; uploads go through multer instead.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use('/api', createApiRouter());

  // Read-only window onto the project tree so a stored document can be linked
  // to directly. Writes only ever happen through the import endpoints.
  app.use(
    '/files',
    express.static(PROJECTS_ROOT, {
      index: false,
      dotfiles: 'ignore',
      redirect: false,
      maxAge: 0,
    }),
  );
  app.use('/files', (req: Request, res: Response) => {
    res.status(404).json({ error: `No file at /files${req.path}.` });
  });

  if (IS_PRODUCTION) {
    const hasBuild = fs.existsSync(CLIENT_INDEX);
    if (hasBuild) {
      app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
    }
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (isServerPath(req.path)) {
        next();
        return;
      }
      if (!hasBuild) {
        res
          .status(503)
          .type('text/plain')
          .send(
            'The client has not been built yet.\n\nRun `npm run build` and start the server again.\n',
          );
        return;
      }
      // Client-side routing: any unknown page is the app itself.
      res.sendFile(CLIENT_INDEX);
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}.` });
  });
  app.use(errorMiddleware);

  return app;
}

/**
 * The migration failed, so there is no usable database — but a dead port tells
 * the user nothing. This app stays up and says exactly what went wrong.
 */
function serveMigrationFailure(error: Error): void {
  const headline = 'Brain could not start: the application failed to migrate the database.';
  const hint =
    'Applied migrations are checksum-locked. If you edited a migration that had already run, ' +
    'restore the original file and add a new server/db/migrations/NNN_name.sql instead.';

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req: Request, res: Response) => {
    res.status(500).json({
      error: `${headline} ${error.message}`,
      detail: { stage: 'MIGRATION', databasePath: DB_PATH, dataRoot: DATA_ROOT, hint },
    });
  });
  app.use((_req: Request, res: Response) => {
    res
      .status(500)
      .type('text/plain')
      .send(`${headline}\n\n${error.message}\n\n${hint}\n\nDatabase: ${DB_PATH}\nData root: ${DATA_ROOT}\n`);
  });

  const server = app.listen(PORT, () => {
    console.error(`[brain] Serving the migration error on http://localhost:${PORT} — nothing else will work.`);
  });
  server.on('error', onListenError);
}

function onListenError(error: NodeJS.ErrnoException): void {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[brain] Port ${PORT} is already in use. Stop the other process, or start Brain with a different PORT.`,
    );
  } else {
    console.error('[brain] The HTTP server failed to start:', error);
  }
  process.exit(1);
}

function logBanner(migrations: MigrationReport): void {
  const applied = migrations.applied;
  console.log('');
  console.log('  Brain is running.');
  console.log('');
  console.log(`  URL             http://localhost:${PORT}`);
  console.log(`  Driver          ${migrations.driver}`);
  console.log(`  Schema version  ${migrations.schemaVersion}`);
  console.log(`  Database        ${migrations.databasePath}`);
  console.log(`  Data root       ${DATA_ROOT}`);
  console.log(
    applied.length > 0
      ? `  Migrations      applied ${applied.length} (${applied
          .map((entry) => `${entry.version} ${entry.name}`)
          .join(', ')})`
      : `  Migrations      up to date (${migrations.alreadyApplied} already applied)`,
  );
  if (migrations.backupPath) console.log(`  Backup          ${migrations.backupPath}`);
  console.log('');
}

function installShutdown(server: Server): void {
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[brain] ${signal} received — shutting down.`);
    server.close(() => {
      try {
        closeDatabase();
      } catch {
        // Closing a database that is already closed is not worth a crash on exit.
      }
      process.exit(0);
    });
    // A held-open keep-alive connection must not stop the process exiting.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function main(): void {
  ensureDataDirs();

  let migrations: MigrationReport;
  try {
    migrations = initDatabase().migrations;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('');
    console.error('  Brain failed to migrate the database.');
    console.error('');
    console.error(`  ${failure.message}`);
    console.error('');
    console.error(`  Database  ${DB_PATH}`);
    console.error(`  Data root ${DATA_ROOT}`);
    console.error('');
    serveMigrationFailure(failure);
    return;
  }

  // First boot creates Deal Dispatch; later boots only backfill missing layers
  // and re-create the folder tree.
  seedIfEmpty();

  // Derived state is rebuilt before the first request rather than lazily, so a
  // file deleted or added while the server was down is already accounted for.
  for (const project of listProjects()) {
    recomputeProject(project.id);
    writeProjectState(project.id);
  }
  // One runtime file, so it describes the project the app opens on.
  const primary = getDefaultProject();
  if (primary) writeProjectState(primary.id);

  const server = buildApp().listen(PORT, () => logBanner(migrations));
  server.on('error', onListenError);
  installShutdown(server);
}

main();
