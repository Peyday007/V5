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
import { DatabaseConfigurationError } from './db/types.ts';
import { describePersistence, persistenceConfig } from './config.ts';
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
import { recoverInterruptedExtractions } from './services/documents/extraction.ts';
import { ocrStatus } from './services/documents/ocr.ts';
import { queueUnreadDocuments } from './services/documents/queue.ts';
import { recoverInterruptedResearch } from './services/research/queue.ts';
import { recoverInterruptedImports } from './services/archive/import.ts';

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
 * There is no usable database — but a dead port tells the user nothing. This app
 * stays up and says exactly what went wrong.
 *
 * The two reasons are different problems with different fixes, so they are
 * reported differently: a configuration error means cloud mode was asked for and
 * could not be delivered, and the one thing Brain must not do about that is
 * quietly serve the local file instead.
 */
function serveMigrationFailure(error: Error): void {
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
  app.use('/api', (_req: Request, res: Response) => {
    res.status(500).json({
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
  const persistence = describePersistence(persistenceConfig());
  console.log(`  URL             http://localhost:${PORT}`);
  console.log(`  Driver          ${migrations.driver}`);
  console.log(`  Schema version  ${migrations.schemaVersion}`);
  console.log(`  Database        ${persistence.database.provider} · ${persistence.database.target}`);
  console.log(`  Documents       ${persistence.storage.provider} · ${persistence.storage.target}`);
  console.log(`  Data root       ${DATA_ROOT}`);
  console.log(
    applied.length > 0
      ? `  Migrations      applied ${applied.length} (${applied
          .map((entry) => `${entry.version} ${entry.name}`)
          .join(', ')})`
      : `  Migrations      up to date (${migrations.alreadyApplied} already applied)`,
  );
  if (migrations.backupPath) console.log(`  Backup          ${migrations.backupPath}`);

  // The capability check happens at startup, not when the first scan arrives:
  // finding out halfway through a fifty-page import that OCR was never going to
  // work is the worst moment to learn it.
  const ocr = ocrStatus();
  console.log(
    `  OCR             ${
      ocr.available
        ? `${ocr.engineVersion} + ${ocr.rendererVersion} at ${ocr.dpi} dpi (${ocr.language})`
        : 'not available - scanned pages will be reported unreadable'
    }`,
  );
  if (!ocr.available && !ocr.disabled) {
    console.log('');
    for (const step of ocr.install) console.log(`    ${step}`);
  }
  console.log('');
}

function installShutdown(server: Server): void {
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[brain] ${signal} received — shutting down.`);
    server.close(async () => {
      try {
        await closeDatabase();
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

async function main(): Promise<void> {
  ensureDataDirs();

  let migrations: MigrationReport;
  try {
    migrations = (await initDatabase()).migrations;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('');
    if (failure instanceof DatabaseConfigurationError) {
      console.error('  Brain could not use the database it was configured for.');
      console.error('');
      console.error(`  ${failure.message}`);
      if (failure.detail) console.error(`  ${failure.detail}`);
    } else {
      console.error('  Brain failed to migrate the database.');
      console.error('');
      console.error(`  ${failure.message}`);
      console.error('');
      console.error(`  Database  ${DB_PATH}`);
    }
    console.error(`  Data root ${DATA_ROOT}`);
    console.error('');
    serveMigrationFailure(failure);
    return;
  }

  // First boot creates Deal Dispatch; later boots only backfill missing layers
  // and re-create the folder tree.
  await seedIfEmpty();

  // An extraction still marked in-flight was interrupted by a crash or a
  // restart. Mark it so, before anything can mistake a half-read document for a
  // readable one, and leave it available to reprocess.
  const interrupted = await recoverInterruptedExtractions();
  if (interrupted > 0) {
    console.log(
      `  ${interrupted} extraction run(s) were interrupted by the last shutdown and are ` +
        'marked INTERRUPTED. Reprocess those documents to read them.',
    );
  }

  // Same rule for research: a job that says RESEARCHING with no process behind
  // it is a lie, so it is closed as INTERRUPTED with its completed passes and
  // accepted fragments intact. Nothing restarts on its own — research spends the
  // user's quota, so resuming is their decision.
  const interruptedResearch = await recoverInterruptedResearch();
  if (interruptedResearch > 0) {
    console.log(
      `  ${interruptedResearch} research run(s) were interrupted by the last shutdown and are ` +
        'marked INTERRUPTED. Resume them to continue from the last completed pass.',
    );
  }

  // A folder import interrupted by the shutdown is paused rather than left
  // looking live. Nothing already imported is re-read when it resumes.
  const pausedImports = await recoverInterruptedImports();
  if (pausedImports > 0) {
    console.log(
      `  ${pausedImports} archive import(s) were interrupted and are paused. Resume them to ` +
        'continue with the files that were not reached.',
    );
  }

  // Documents that have never been read are queued now, so a folder dropped in
  // while the server was down becomes auditable without anyone asking.
  const unread = await queueUnreadDocuments();
  if (unread > 0) console.log(`  reading ${unread} document(s) in the background`);

  // Derived state is rebuilt before the first request rather than lazily, so a
  // file deleted or added while the server was down is already accounted for.
  for (const project of await listProjects()) {
    await recomputeProject(project.id);
    await writeProjectState(project.id);
  }
  // One runtime file, so it describes the project the app opens on.
  const primary = await getDefaultProject();
  if (primary) await writeProjectState(primary.id);

  const server = buildApp().listen(PORT, () => logBanner(migrations));
  server.on('error', onListenError);
  installShutdown(server);
}

await main();
