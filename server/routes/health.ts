/**
 * Boot and capability reporting.
 *
 * `/api/health` is the first thing the UI calls and the first thing a human
 * curls: it answers "did the schema migrate, which driver am I on, where is my
 * data, and which AI providers are usable right now" in one response, so a
 * misconfigured install is diagnosable without reading logs.
 */
import { Router } from 'express';
import { getDb, getMigrationReport, activeDatabaseConfig } from '../db/database.ts';
import { getStorage, activeStorageConfig } from '../services/storage/index.ts';
import { getSchemaVersion } from '../db/migrate.ts';
import { DATA_ROOT, DB_PATH } from '../env.ts';
import { defaultProviderName, listProviderStatuses } from '../providers/index.ts';
import { ocrStatus } from '../services/documents/ocr.ts';
import { antigravityStatus, recheckAntigravity } from '../providers/antigravity/runtime.ts';
import { handler } from './helpers.ts';
import { currentPrincipal } from '../services/identity/context.ts';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  handler(async () => {
    const migrations = getMigrationReport();
    const db = getDb();

    // Since Step 4 this answer depends on who is asking.
    //
    // Everything below names where this Brain's data lives — the database host,
    // the bucket, the data root, the local paths of the OCR binaries. That is
    // exactly what an operator needs and exactly what a project member has no
    // business knowing about the installation they happen to have access to. So
    // an administrator gets the full readiness report and everybody else gets
    // the two facts the interface actually renders: is it up, and can it read a
    // scanned page.
    const principal = currentPrincipal();
    const isAdmin = principal?.type === 'HUMAN' && principal.isBrainAdmin;
    if (!isAdmin) {
      return {
        ok: true,
        schemaVersion: migrations?.schemaVersion ?? (await getSchemaVersion(db)),
        providers: listProviderStatuses(),
        ocr: ocrStatus(),
      };
    }

    return {
      ok: true,
      schemaVersion: migrations?.schemaVersion ?? await getSchemaVersion(db),
      driver: migrations?.driver ?? db.kind,
      databasePath: migrations?.databasePath ?? DB_PATH,
      dataRoot: DATA_ROOT,
      // Where this instance's state actually lives, so "is this one cloud-backed"
      // is answerable without reading the logs of the machine it runs on.
      //
      // Descriptions only: the database is a host and a database name, the store
      // is a host and a bucket. Neither the connection string nor the service-role
      // key is here, and neither may ever be — this response goes to the browser.
      persistence: {
        database: activeDatabaseConfig()?.provider ?? 'sqlite',
        databaseTarget: migrations?.databasePath ?? DB_PATH,
        storage: activeStorageConfig()?.provider ?? getStorage().kind,
        storageTarget: getStorage().describe(),
      },
      migrations,
      providers: listProviderStatuses(),
      // Whether scanned pages can be read here, and if not, the exact one-time
      // step that fixes it.
      ocr: ocrStatus(),
    };
  }),
);

healthRouter.get(
  '/providers',
  handler(() => ({
    providers: listProviderStatuses(),
    default: defaultProviderName(),
  })),
);

/**
 * What research automation can do on this machine, for the status chip and the
 * setup card (section 1).
 *
 * Only the status contract crosses to the browser. The probe also learns local
 * paths and raw CLI output, and neither is any of the browser's business.
 */
healthRouter.get(
  '/providers/status',
  handler(() => ({
    status: antigravityStatus().status,
    default: defaultProviderName(),
  })),
);

/**
 * Check connection. Re-probes rather than answering from the cached result,
 * because the user pressing this has usually just changed something.
 */
healthRouter.post(
  '/providers/status/check',
  handler(() => ({
    status: recheckAntigravity().status,
    default: defaultProviderName(),
  })),
);
