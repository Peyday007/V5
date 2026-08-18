/**
 * Boot and capability reporting.
 *
 * `/api/health` is the first thing the UI calls and the first thing a human
 * curls: it answers "did the schema migrate, which driver am I on, where is my
 * data, and which AI providers are usable right now" in one response, so a
 * misconfigured install is diagnosable without reading logs.
 */
import { Router } from 'express';
import { getDb, getMigrationReport } from '../db/database.ts';
import { getSchemaVersion } from '../db/migrate.ts';
import { DATA_ROOT, DB_PATH } from '../env.ts';
import { defaultProviderName, listProviderStatuses } from '../providers/index.ts';
import { handler } from './helpers.ts';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  handler(() => {
    const migrations = getMigrationReport();
    const db = getDb();
    return {
      ok: true,
      schemaVersion: migrations?.schemaVersion ?? getSchemaVersion(db),
      driver: migrations?.driver ?? db.kind,
      databasePath: migrations?.databasePath ?? DB_PATH,
      dataRoot: DATA_ROOT,
      migrations,
      providers: listProviderStatuses(),
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
