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
import { closeDatabase, initDatabase, activeDatabaseConfig } from './db/database.ts';
import { DatabaseConfigurationError } from './db/types.ts';
import { describePersistence, persistenceConfig } from './config.ts';
import type { MigrationReport } from './db/migrate.ts';
import {
  DATA_ROOT,
  DB_PATH,
  IS_PRODUCTION,
  PORT,
  REPO_ROOT,
  ensureDataDirs,
} from './env.ts';
import { getDefaultProject, listProjects } from './repos/projects.ts';
import { errorMiddleware, withRequestContext } from './routes/helpers.ts';
import { createApiRouter } from './routes/index.ts';
import { seedIfEmpty } from './seed.ts';
import { initStorage, activeStorageConfig } from './services/storage/index.ts';
import { StorageConfigurationError } from './services/storage/types.ts';
import { serveStoredObject } from './routes/files.ts';
import { accessGate, accessGateConfig, describeAccessGate, AccessGateError, type AccessGateConfig } from './routes/access.ts';
import { requestContext, requireAuthentication } from './routes/guard.ts';
import { MCP_PATH, mcpRouter } from './mcp/endpoint.ts';
import { OAUTH_BASE, oauthRouter, wellKnownRouter } from './routes/oauth.ts';
import { OPERATOR_BASE, operatorRouter } from './routes/operator.ts';
import { authRouter } from './routes/auth.ts';
import { bootstrapFirstAdmin, hasAnyAccount } from './services/identity/bootstrap.ts';
import { writeProjectState } from './services/runtimeState.ts';
import { recomputeProject } from './services/stateEngine.ts';
import { recoverInterruptedExtractions } from './services/documents/extraction.ts';
import { ocrStatus } from './services/documents/ocr.ts';
import { queueUnreadDocuments } from './services/documents/queue.ts';
import { recoverInterruptedResearch } from './services/research/queue.ts';
import { resumePulledPackets } from './services/research/packetRunner.ts';
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
  return (
    requestPath === '/api' ||
    requestPath.startsWith('/api/') ||
    requestPath.startsWith('/files') ||
    // Without this the SPA fallback would answer a stray GET /mcp with the
    // client bundle, and a dual-era client probing the endpoint would read HTML
    // where it expected either a JSON-RPC error or a 405.
    requestPath === '/mcp' ||
    requestPath.startsWith('/mcp/') ||
    requestPath.startsWith('/oauth/') ||
    requestPath.startsWith('/.well-known/') ||
    requestPath === '/operator' ||
    requestPath.startsWith('/operator/')
  );
}

function buildApp(gate: AccessGateConfig): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer, which is where any deployed Brain lives. Without
  // this `req.protocol` reads http on a site served over https, and every
  // client address is the balancer's.
  app.set('trust proxy', 1);

  /**
   * Liveness, before the gate and before anything else.
   *
   * A hosting platform must be able to ask "is this process up?" without
   * holding a secret. The answer is a fixed string: it names no project, no
   * configuration and no version, so answering it to the whole internet gives
   * nothing away. Readiness — did the database answer, did the bucket answer —
   * is `/api/health`, and that is behind the gate because it says where this
   * Brain's data lives.
   */
  app.get('/healthz', (_req: Request, res: Response) => {
    res.type('text/plain').send('ok');
  });

  // The optional outer layer. Since Step 4 this is no longer what protects the
  // Brain — every API route and every document byte is behind real
  // authentication below — and it is off unless somebody sets a token. It stays
  // supported because a second, cruder lock in front of a deployment is a
  // reasonable thing to want, and because removing it would silently open any
  // installation that had been relying on it.
  app.use(accessGate(gate));

  // Every request gets a correlation id and a place to hang its principal,
  // before anything can try to read one. Ahead of the body parsers, so that a
  // request refused for its *size* still has an id in the log.
  app.use(requestContext());

  // The MCP endpoint, mounted before the application-wide body parser so that
  // it can enforce its own, much smaller, limit. It is deliberately outside
  // `/api`: it authenticates itself, bearer only, and answers a different
  // protocol.
  app.use(MCP_PATH, mcpRouter());

  // How a client discovers where to authenticate. Unauthenticated by
  // necessity — a caller with no token has to be able to find out how to get
  // one — and disclosing nothing but the endpoints already being served.
  app.use('/.well-known', wellKnownRouter(MCP_PATH));

  // The authorization server. Its own body parsers, because the token endpoint
  // is form-encoded by specification and the consent screen posts a form, while
  // dynamic client registration is JSON.
  app.use(
    OAUTH_BASE,
    express.json({ limit: '64kb' }),
    express.urlencoded({ extended: false, limit: '64kb' }),
    oauthRouter(),
  );

  // The operator console. Behind its own Brain-administrator check, and
  // deliberately server-rendered: it is the surface you need when the client
  // bundle is broken or access has to be repaired, so it must not depend on
  // the front-end having built.
  app.use(
    OPERATOR_BASE,
    express.urlencoded({ extended: false, limit: '64kb' }),
    operatorRouter(),
  );

  // Prompts and pasted audit text are large; uploads go through multer instead.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // The real gate. Mounted on both the API and the documents, because the bytes
  // are the thing most worth protecting and serving them from a route that
  // merely looked safe is exactly how that gets missed.
  app.use('/api', requireAuthentication());
  app.use('/files', requireAuthentication());

  app.use('/api', authRouter);
  app.use('/api', createApiRouter());

  // Read-only window onto the stored documents so one can be linked to directly.
  //
  // This used to be `express.static(PROJECTS_ROOT)`, which is exactly as correct
  // as the assumption that a document is a file on this machine. It goes through
  // the storage layer instead, so the same URL works whether the bytes are on
  // disk or in a bucket — and so the bucket is never addressed by the client.
  // Writes only ever happen through the import endpoints.
  app.use('/files', withRequestContext(serveStoredObject));

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

interface IdentityBanner {
  accounts: boolean;
  bootstrapped: string | null;
  /** An account that had never been used was reset from the deployment secret. */
  bootstrapReset: string | null;
  bootstrapNote: string | null;
}

function logBanner(
  migrations: MigrationReport,
  gate: AccessGateConfig,
  identity: IdentityBanner,
): void {
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
  console.log(
    `  Sign-in         ${
      identity.accounts
        ? 'application accounts (email and password, server-side sessions)'
        : 'NO ACCOUNTS — nobody can sign in to this Brain yet'
    }`,
  );
  console.log(`  Outer gate      ${describeAccessGate(gate)}`);
  console.log(`  Data root       ${DATA_ROOT}`);
  console.log(
    applied.length > 0
      ? `  Migrations      applied ${applied.length} (${applied
          .map((entry) => `${entry.version} ${entry.name}`)
          .join(', ')})`
      : `  Migrations      up to date (${migrations.alreadyApplied} already applied)`,
  );
  if (migrations.backupPath) console.log(`  Backup          ${migrations.backupPath}`);
  if (identity.bootstrapped) {
    console.log('');
    console.log(`    Created the first Brain administrator: ${identity.bootstrapped}`);
    console.log('    It must choose a new password before it can do anything else.');
    console.log('    Remove BRAIN_BOOTSTRAP_ADMIN_PASSWORD from this deployment now.');
  } else if (identity.bootstrapReset) {
    console.log('');
    console.log(`    Reset the password for ${identity.bootstrapReset}.`);
    console.log('    That account had been created but never used, so the deployment secret');
    console.log('    replaced its password. Every session it held has been ended.');
    console.log('');
    console.log('    Sign in with it now, then REMOVE BRAIN_BOOTSTRAP_ADMIN_PASSWORD and');
    console.log('    BRAIN_BOOTSTRAP_ADMIN_EMAIL: a password that lives in a deployment');
    console.log('    secret is a password two systems know.');
  } else if (identity.bootstrapNote) {
    console.log('');
    console.log(`    Bootstrap administrator not created: ${identity.bootstrapNote}`);
  }
  if (!identity.accounts) {
    console.log('');
    console.log('    This Brain has no accounts, so nobody can sign in. Create the first one by');
    console.log('    setting BRAIN_BOOTSTRAP_ADMIN_EMAIL and BRAIN_BOOTSTRAP_ADMIN_PASSWORD and');
    console.log('    restarting; both are read once, into an empty Brain, and never again.');
  }

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

  // The document store opens before the database, because it is the cheaper
  // failure to discover: a bucket that cannot be reached is a boot Brain must
  // not complete, and finding that out after migrating is finding it out late.
  //
  // `verify()` runs a real operation. Having SUPABASE_URL set is not the same
  // fact as the bucket answering, and only one of those may be reported.
  try {
    await initStorage();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('');
    console.error('  Brain could not use the document storage it was configured for.');
    console.error('');
    console.error(`  ${failure.message}`);
    if (failure instanceof StorageConfigurationError && failure.detail) {
      console.error(`  ${failure.detail}`);
    }
    console.error('');
    console.error(
      '  Nothing was written to local disk instead: cloud storage does not fall back, because ' +
        'documents saved to this machine by a server reporting itself as cloud-backed are ' +
        'documents nobody else can open.',
    );
    console.error('');
    serveMigrationFailure(failure);
    return;
  }

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

  // The gate, decided the moment cloud persistence is a proven fact and before
  // any of the work below. A deployment missing its token should cost a failed
  // boot in seconds — which somebody notices — rather than an open Brain.
  let gate: AccessGateConfig;
  try {
    gate = accessGateConfig({
      cloud:
        activeDatabaseConfig()?.provider === 'postgres' ||
        activeStorageConfig()?.provider === 'supabase',
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('');
    console.error('  Brain will not start unprotected.');
    console.error('');
    console.error(`  ${failure.message}`);
    if (failure instanceof AccessGateError && failure.detail) {
      console.error(`  ${failure.detail}`);
    }
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

  // Worker-driven packets resume differently, and the difference is the point.
  // A push-model research run needs a process to continue it, so an interrupted
  // one is closed and left for a person. A pulled packet's next step is a
  // function of its rows, so re-deriving it *is* resuming it — and if the
  // shutdown happened between a completion and the enqueue that should have
  // followed, this is what closes that gap.
  //
  // Nothing is spent by this. It queues work; a worker still has to claim it,
  // and a plan a person has not approved stays exactly where it is.
  const resumed = await resumePulledPackets();
  if (resumed > 0) {
    console.log(`  ${resumed} worker-driven research packet(s) picked back up from their rows`);
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

  // The first administrator, if this Brain has never had one. Runs before the
  // port opens, so an installation that cannot be signed into says so in the
  // boot log rather than at the first person who tries.
  const bootstrap = await bootstrapFirstAdmin();
  const identity: IdentityBanner = {
    accounts: await hasAnyAccount(),
    bootstrapped: bootstrap.created ? bootstrap.email : null,
    bootstrapReset: bootstrap.reset ? bootstrap.email : null,
    bootstrapNote: bootstrap.created || bootstrap.reset ? null : bootstrap.reason,
  };

  const server = buildApp(gate).listen(PORT, () => logBanner(migrations, gate, identity));
  server.on('error', onListenError);
  installShutdown(server);
}

await main();
