/**
 * Moving a Brain from a laptop to the cloud.
 *
 * The operation this performs is a copy, and the word is meant strictly. It
 * reads the local database and the local document tree, writes them into
 * Postgres and the bucket, checks that what arrived matches what left, and
 * stops. It never writes to the source, never deletes from it, and never
 * changes it in any way — the local Brain remains a working, complete Brain
 * afterwards, and stays the recoverable original until a person decides
 * otherwise. A migration that failed halfway is therefore not a disaster; it is
 * a partially populated target and an untouched source.
 *
 * Three properties make that hold up.
 *
 * It is idempotent by construction, not by bookkeeping. Every row is inserted
 * with ON CONFLICT DO NOTHING against its real primary key, and every file is
 * skipped when the target already holds those exact bytes. So resuming is
 * simply running it again: the work already done is recognised rather than
 * repeated, and no ledger has to be trusted for that to be true. The ledger
 * records what happened; it is not what keeps the operation safe.
 *
 * Identity is preserved rather than regenerated. Ids, timestamps, checksums,
 * parent links, superseded-by links, attempt numbers, redo reasons, failed
 * attempts, audit verdicts and every event row cross unchanged. A migration
 * that renumbered anything would break the one thing this platform is for:
 * that a conclusion resolves to a passage, through a chain of identifiers that
 * still means what it meant.
 *
 * Verification is a separate question from copying. Counting rows as they are
 * written proves the loop ran; it does not prove the target holds them. So the
 * verification pass reads the target back — row counts per table, a sample of
 * real relationships resolved across tables, and the sha-256 of every uploaded
 * object recomputed from the bytes the target returns.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { openSqlite } from '../db/adapters/sqlite.ts';
import { PostgresAdapter, describeConnection, verifyConnection } from '../db/adapters/postgres.ts';
import { runMigrations } from '../db/migrate.ts';
import type { Database } from '../db/types.ts';
import { DatabaseConfigurationError } from '../db/types.ts';
import type { DatabaseConfig, StorageConfig } from '../config.ts';
import { LocalStorageProvider } from './storage/local.ts';
import { SupabaseStorageProvider } from './storage/supabase.ts';
import { ObjectNotFoundError, type StorageProvider } from './storage/types.ts';

export type CloudMigrationMode = 'DRY_RUN' | 'MIGRATE' | 'VERIFY_ONLY';

export interface CloudMigrationOptions {
  /** The local SQLite file to read. Opened read-only. */
  sourceDbPath: string;
  /** The local data root the document tree hangs off. */
  sourceRoot: string;
  /**
   * Where a local target store keeps its objects.
   *
   * Only meaningful when the target storage provider is `local`, which is a
   * real case: migrating a laptop's documents onto a mounted volume while the
   * database moves to Postgres. Defaults to the source root, where the effect
   * is that every document is already in place and is reported as such rather
   * than copied onto itself.
   */
  targetRoot?: string;
  target: DatabaseConfig;
  targetStorage: StorageConfig;
  /** A project id or slug. Absent means the whole Brain. */
  project?: string | null;
  mode: CloudMigrationMode;
  batchSize?: number;
  /** Injected so the tool can be tested without a live Supabase project. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface TableReport {
  table: string;
  sourceRows: number;
  inserted: number;
  skipped: number;
  targetRows: number | null;
}

export interface FileReport {
  storageKey: string;
  documentId: string | null;
  size: number;
  checksum: string;
  status: 'COPIED' | 'ALREADY_PRESENT' | 'MISSING_AT_SOURCE' | 'FAILED' | 'WOULD_COPY';
  detail?: string;
}

export interface VerificationReport {
  rowCounts: { table: string; source: number; target: number; ok: boolean }[];
  relationships: { description: string; source: number; target: number; ok: boolean }[];
  checksums: { checked: number; matched: number; mismatched: string[]; missing: string[] };
  ok: boolean;
}

export interface CloudMigrationReport {
  runId: string;
  mode: CloudMigrationMode;
  startedAt: string;
  finishedAt: string;
  scope: { project: string | null; projectName: string | null };
  source: {
    database: string;
    documents: string;
    tables: number;
    rows: number;
    files: number;
    bytes: number;
  };
  target: { database: string; storage: string; schemaVersion: number };
  tables: TableReport[];
  files: FileReport[];
  verification: VerificationReport | null;
  problems: string[];
  ok: boolean;
}

/**
 * Tables the copy never touches, and why.
 *
 * `schema_migrations` is the target's own account of how its schema was built.
 * Overwriting it with the source's would tell the target it had run migrations
 * it has never seen — and since the two backends have separate, independently
 * numbered chains, the versions do not even mean the same thing.
 *
 * The ledger tables are this tool's own bookkeeping and belong to the target.
 */
const NEVER_COPIED = new Set([
  'schema_migrations',
  'cloud_migration_runs',
  'cloud_migration_tables',
  'cloud_migration_files',
]);

const nowIso = () => new Date().toISOString();
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

interface ColumnInfo {
  name: string;
  pk: number;
}
interface ForeignKey {
  from: string;
  table: string;
  to: string;
}
interface TableShape {
  name: string;
  columns: string[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  hasProjectId: boolean;
}

// ---------------------------------------------------------------------------
// Reading the source's shape
// ---------------------------------------------------------------------------

async function readShapes(db: Database): Promise<Map<string, TableShape>> {
  const names = (
    await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).map((r) => r.name);

  const shapes = new Map<string, TableShape>();
  for (const name of names) {
    if (NEVER_COPIED.has(name)) continue;
    const columns = await db.all<ColumnInfo>(`PRAGMA table_info('${name}')`);
    const fks = await db.all<ForeignKey>(`PRAGMA foreign_key_list('${name}')`);
    shapes.set(name, {
      name,
      columns: columns.map((c) => c.name),
      primaryKey: columns.filter((c) => c.pk > 0).map((c) => c.name),
      foreignKeys: fks.map((f) => ({ from: f.from, table: f.table, to: f.to })),
      hasProjectId: columns.some((c) => c.name === 'project_id'),
    });
  }
  return shapes;
}

/**
 * Parents before children, as far as that is possible.
 *
 * It is not entirely possible: this schema has self-references and genuine
 * cycles — a run points at a document, a document at its parent, an
 * orchestration at the audit that produced it. So the sort is best-effort and
 * the correctness of the load does not rest on it. The load defers constraint
 * checking to the end of its transaction, which is what actually makes any
 * order safe; the sort just means the common case reads sensibly in the log.
 */
function dependencyOrder(shapes: Map<string, TableShape>): string[] {
  const ordered: string[] = [];
  const placed = new Set<string>();
  const remaining = new Set(shapes.keys());

  while (remaining.size > 0) {
    let progressed = false;
    for (const name of [...remaining].sort()) {
      const shape = shapes.get(name)!;
      const blockers = shape.foreignKeys
        .map((fk) => fk.table)
        .filter((parent) => parent !== name && remaining.has(parent));
      if (blockers.length === 0) {
        ordered.push(name);
        placed.add(name);
        remaining.delete(name);
        progressed = true;
      }
    }
    if (!progressed) {
      // A cycle. Break it at the alphabetically first member and carry on;
      // deferred constraints make the choice immaterial.
      const next = [...remaining].sort()[0]!;
      ordered.push(next);
      placed.add(next);
      remaining.delete(next);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Scoping to one project
// ---------------------------------------------------------------------------

/**
 * Which rows belong to the selected project, table by table.
 *
 * A table with `project_id` answers for itself. One without belongs to the
 * project through whichever parent it hangs off, so its selected rows are those
 * whose foreign key lands in a parent already selected. That is an OR across
 * the parents rather than an AND: a row hangs off one owner chain, and a row
 * from another project cannot have a key into this project's rows.
 *
 * Returns null when nothing is being filtered, which is the whole-Brain case
 * and the one that needs to stay fast.
 */
async function selectedIds(
  source: Database,
  shapes: Map<string, TableShape>,
  order: string[],
  projectId: string,
): Promise<Map<string, Set<string>>> {
  const selected = new Map<string, Set<string>>();

  for (const table of order) {
    const shape = shapes.get(table)!;
    const key = shape.primaryKey[0];
    if (!key) continue;

    let rows: Record<string, unknown>[] = [];
    if (table === 'projects') {
      rows = await source.all(`SELECT ${key} AS k FROM projects WHERE id = ?`, [projectId]);
    } else if (shape.hasProjectId) {
      rows = await source.all(`SELECT ${key} AS k FROM ${table} WHERE project_id = ?`, [projectId]);
    } else {
      const usable = shape.foreignKeys.filter(
        (fk) => fk.table !== table && (selected.get(fk.table)?.size ?? 0) > 0,
      );
      if (usable.length === 0) {
        // Nothing links it to a project. `provider_connections` is the real
        // case: it is the machine's own configuration rather than any
        // project's data, so a project-scoped migration leaves it alone.
        selected.set(table, new Set());
        continue;
      }
      const seen = new Set<string>();
      for (const fk of usable) {
        const parents = [...selected.get(fk.table)!];
        for (const chunk of chunked(parents, 400)) {
          const placeholders = chunk.map(() => '?').join(', ');
          const found = await source.all<{ k: string }>(
            `SELECT ${key} AS k FROM ${table} WHERE ${fk.from} IN (${placeholders})`,
            chunk,
          );
          for (const row of found) seen.add(String(row.k));
        }
      }
      selected.set(table, seen);
      continue;
    }
    selected.set(table, new Set(rows.map((r) => String(r.k))));
  }

  return selected;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

export async function runCloudMigration(
  options: CloudMigrationOptions,
): Promise<CloudMigrationReport> {
  const log = options.log ?? (() => undefined);
  const batchSize = options.batchSize ?? 200;
  const startedAt = nowIso();
  const runId = `cmg_${crypto.randomBytes(8).toString('hex')}`;
  const problems: string[] = [];

  if (options.target.provider !== 'postgres' || !options.target.connectionString) {
    throw new DatabaseConfigurationError(
      'The migration target must be Postgres.',
      'Set BRAIN_DATABASE_PROVIDER=postgres and BRAIN_DATABASE_URL to the database you are ' +
        'migrating into. There is nothing to migrate from SQLite to SQLite.',
    );
  }

  // The source is opened read-only. This is the single most important line in
  // the file: whatever happens next, the local Brain is not what is at risk.
  const source = openSqlite(options.sourceDbPath, { readOnly: true });
  const sourceStore: StorageProvider = new LocalStorageProvider(options.sourceRoot);

  const target = new PostgresAdapter({
    connectionString: options.target.connectionString,
    max: options.target.poolSize,
    // Carried through so a migration lands where the server that will read it
    // is looking. Unset in ordinary use; the test harness gives each file its
    // own schema in one database.
    schema: options.target.schema,
  });
  const targetDescription = describeConnection(options.target.connectionString);

  let targetStore: StorageProvider;
  if (options.targetStorage.provider === 'supabase') {
    targetStore = new SupabaseStorageProvider({
      url: options.targetStorage.supabaseUrl!,
      serviceRoleKey: options.targetStorage.serviceRoleKey!,
      bucket: options.targetStorage.bucket!,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } else {
    targetStore = new LocalStorageProvider(options.targetRoot ?? options.sourceRoot);
  }

  const tables: TableReport[] = [];
  const files: FileReport[] = [];
  let verification: VerificationReport | null = null;
  let schemaVersion = 0;
  let projectName: string | null = null;
  let projectId: string | null = null;

  try {
    // 1. Prove both ends before touching either.
    log('Checking the target database…');
    await verifyConnection(target);
    log(`  ${targetDescription} answered.`);

    log('Checking the target document store…');
    await targetStore.verify();
    log(`  ${targetStore.describe()} answered.`);

    // 2. Bring the target schema up to date before any row is written. A copy
    //    into a half-migrated database is a copy into the wrong shape.
    const report = await runMigrations(target, targetDescription);
    schemaVersion = report.schemaVersion;
    log(
      `  schema version ${report.schemaVersion} ` +
        `(${report.applied.length} applied now, ${report.alreadyApplied} already there).`,
    );

    // 3. Read the source's shape and decide the scope.
    const shapes = await readShapes(source);
    const order = dependencyOrder(shapes);

    if (options.project) {
      const found = await source.get<{ id: string; name: string }>(
        'SELECT id, name FROM projects WHERE id = ? OR slug = ?',
        [options.project, options.project],
      );
      if (!found) {
        throw new Error(
          `No project in the local database has the id or slug "${options.project}".`,
        );
      }
      projectId = found.id;
      projectName = found.name;
      log(`Scope: ${found.name} (${found.id}) only.`);
    } else {
      log('Scope: the whole Brain.');
    }

    const scopeIds = projectId
      ? await selectedIds(source, shapes, order, projectId)
      : null;

    // 4. Count what is there, before anything moves.
    let sourceRowTotal = 0;
    const counts = new Map<string, number>();
    for (const table of order) {
      const n = scopeIds
        ? (scopeIds.get(table)?.size ?? 0)
        : ((await source.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
      counts.set(table, n);
      sourceRowTotal += n;
    }

    const documents = await documentsInScope(source, scopeIds);
    const fileTotal = documents.length;
    const byteTotal = documents.reduce((sum, d) => sum + (d.file_size ?? 0), 0);
    log(
      `Source holds ${sourceRowTotal} row(s) across ${order.length} table(s), ` +
        `and ${fileTotal} document file(s).`,
    );

    if (options.mode === 'DRY_RUN') {
      for (const table of order) {
        tables.push({
          table,
          sourceRows: counts.get(table) ?? 0,
          inserted: 0,
          skipped: 0,
          targetRows: await countTarget(target, table),
        });
      }
      for (const document of documents) {
        const key = document.storage_key ?? document.filesystem_path;
        files.push({
          storageKey: key ?? '(none)',
          documentId: document.id,
          size: document.file_size ?? 0,
          checksum: document.file_hash ?? '',
          // Never 'COPIED'. A dry run that reported work it had not done would
          // be the one kind of dishonesty this whole tool exists to avoid.
          status: key && (await sourceStore.exists(key)) ? 'WOULD_COPY' : 'MISSING_AT_SOURCE',
          detail: 'Nothing was written: this was a dry run.',
        });
      }
      log('Dry run: nothing was written.');
    }

    if (options.mode === 'MIGRATE') {
      await recordRunStart(target, {
        runId,
        mode: options.mode,
        projectId,
        source: options.sourceDbPath,
        startedAt,
      });

      // 5. The rows, in one transaction with constraints deferred to its end.
      //    Deferring is what lets a schema with cycles load in any order at all;
      //    the constraints are still checked, just all at once at COMMIT, so a
      //    genuinely broken reference still fails the migration.
      await target.transaction(async () => {
        await target.exec('SET CONSTRAINTS ALL DEFERRED');
        for (const table of order) {
          const shape = shapes.get(table)!;
          const result = await copyTable({
            source,
            target,
            shape,
            ids: scopeIds?.get(table) ?? null,
            batchSize,
          });
          tables.push({
            table,
            sourceRows: counts.get(table) ?? 0,
            inserted: result.inserted,
            skipped: result.skipped,
            targetRows: null,
          });
          if (result.inserted > 0 || result.skipped > 0) {
            log(
              `  ${table}: ${result.inserted} inserted, ${result.skipped} already there ` +
                `(of ${counts.get(table) ?? 0}).`,
            );
          }
          await recordTable(target, runId, table, counts.get(table) ?? 0, result);
        }
      });

      // 6. The files. Outside the transaction on purpose: an upload is not
      //    transactional, and holding a database transaction open across a
      //    network copy of every document would be a long-lived lock for no
      //    guarantee.
      for (const document of documents) {
        files.push(
          await copyFile({
            source: sourceStore,
            target: targetStore,
            document,
            target_db: target,
            runId,
            log,
          }),
        );
      }
      const copied = files.filter((f) => f.status === 'COPIED');
      const already = files.filter((f) => f.status === 'ALREADY_PRESENT');
      log(
        `Files: ${copied.length} copied, ${already.length} already there, ` +
          `${files.filter((f) => f.status === 'MISSING_AT_SOURCE').length} missing at source, ` +
          `${files.filter((f) => f.status === 'FAILED').length} failed.`,
      );

      for (const file of files) {
        if (file.status === 'MISSING_AT_SOURCE') {
          problems.push(
            `${file.storageKey} is registered in the database but its bytes are not in the ` +
              'local store, so nothing could be uploaded for it. This is the same inconsistency ' +
              'SCAN & RECONCILE reports; it was not introduced by the migration.',
          );
        }
        if (file.status === 'FAILED') {
          problems.push(`${file.storageKey} could not be uploaded: ${file.detail ?? 'unknown'}`);
        }
      }
    }

    // 7. Verify by reading the target back, whatever mode this was.
    if (options.mode !== 'DRY_RUN') {
      log('Verifying what the target actually holds…');
      verification = await verifyMigration({
        source,
        target,
        targetStore,
        order,
        counts,
        documents,
        projectId,
        log,
      });
      if (!verification.ok) {
        problems.push('Verification did not pass. See the counts and checksums above.');
      }
      for (const row of tables) row.targetRows = await countTarget(target, row.table);
    }

    if (options.mode === 'VERIFY_ONLY') {
      for (const table of order) {
        if (!tables.some((t) => t.table === table)) {
          tables.push({
            table,
            sourceRows: counts.get(table) ?? 0,
            inserted: 0,
            skipped: 0,
            targetRows: await countTarget(target, table),
          });
        }
      }
    }

    const finishedAt = nowIso();
    const result: CloudMigrationReport = {
      runId,
      mode: options.mode,
      startedAt,
      finishedAt,
      scope: { project: projectId, projectName },
      source: {
        database: options.sourceDbPath,
        documents: options.sourceRoot,
        tables: order.length,
        rows: sourceRowTotal,
        files: fileTotal,
        bytes: byteTotal,
      },
      target: {
        database: targetDescription,
        storage: targetStore.describe(),
        schemaVersion,
      },
      tables,
      files,
      verification,
      problems,
      ok: problems.length === 0 && (verification?.ok ?? true),
    };

    if (options.mode === 'MIGRATE') {
      await recordRunEnd(target, runId, result);
    }
    return result;
  } catch (error) {
    if (options.mode === 'MIGRATE') {
      await recordRunEnd(target, runId, null, error).catch(() => undefined);
    }
    throw error;
  } finally {
    // The source is closed last and never written to. Nothing in this function
    // removes a local file, and nothing ever will: the local Brain stays the
    // recoverable original until a person archives it themselves.
    await target.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CopyResult {
  inserted: number;
  skipped: number;
}

async function copyTable(input: {
  source: Database;
  target: Database;
  shape: TableShape;
  ids: Set<string> | null;
  batchSize: number;
}): Promise<CopyResult> {
  const { source, target, shape, ids, batchSize } = input;
  const key = shape.primaryKey[0];
  if (!key) return { inserted: 0, skipped: 0 };

  // Ordered by rowid so the target's own `seq` — the identity column standing
  // in for rowid — is assigned in the same order. Thirty-odd queries break ties
  // on it, so a different order here would quietly reorder history.
  const rows = ids
    ? await rowsForIds(source, shape, key, [...ids], batchSize)
    : await source.all<Record<string, unknown>>(`SELECT * FROM ${shape.name} ORDER BY rowid`);

  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  const columns = shape.columns;
  const conflict = shape.primaryKey.join(', ');
  let inserted = 0;

  for (const batch of chunked(rows, batchSize)) {
    for (const row of batch) {
      // ON CONFLICT DO NOTHING is what makes a resume safe without consulting
      // any record of what a previous run did: a row already there stays as it
      // is, and is counted as skipped rather than rewritten. Nothing in the
      // target is ever overwritten by this tool.
      const result = await target.run(
        `INSERT INTO ${shape.name} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})
         ON CONFLICT (${conflict}) DO NOTHING`,
        columns.map((c) => (row[c] ?? null) as never),
      );
      inserted += result.changes > 0 ? 1 : 0;
    }
  }

  return { inserted, skipped: rows.length - inserted };
}

async function rowsForIds(
  source: Database,
  shape: TableShape,
  key: string,
  ids: string[],
  batchSize: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const chunk of chunked(ids, batchSize)) {
    const placeholders = chunk.map(() => '?').join(', ');
    out.push(
      ...(await source.all<Record<string, unknown>>(
        `SELECT * FROM ${shape.name} WHERE ${key} IN (${placeholders}) ORDER BY rowid`,
        chunk,
      )),
    );
  }
  return out;
}

async function countTarget(target: Database, table: string): Promise<number | null> {
  try {
    const row = await target.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

interface DocumentRowLite {
  id: string;
  project_id: string;
  storage_key: string | null;
  filesystem_path: string | null;
  file_hash: string | null;
  file_size: number | null;
  filename: string | null;
}

async function documentsInScope(
  source: Database,
  scopeIds: Map<string, Set<string>> | null,
): Promise<DocumentRowLite[]> {
  const all = await source.all<DocumentRowLite>(
    `SELECT id, project_id, storage_key, filesystem_path, file_hash, file_size, filename
       FROM documents
      WHERE storage_key IS NOT NULL OR filesystem_path IS NOT NULL
      ORDER BY rowid`,
  );
  if (!scopeIds) return all;
  const wanted = scopeIds.get('documents') ?? new Set<string>();
  return all.filter((d) => wanted.has(d.id));
}

async function copyFile(input: {
  source: StorageProvider;
  target: StorageProvider;
  document: DocumentRowLite;
  target_db: Database;
  runId: string;
  log: (line: string) => void;
}): Promise<FileReport> {
  const { source, target, document, runId } = input;
  const key = document.storage_key ?? document.filesystem_path;
  if (!key) {
    return {
      storageKey: '(none)',
      documentId: document.id,
      size: 0,
      checksum: '',
      status: 'MISSING_AT_SOURCE',
      detail: 'The row records no location for its bytes.',
    };
  }

  let bytes: Buffer;
  try {
    bytes = await source.get(key);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      return {
        storageKey: key,
        documentId: document.id,
        size: document.file_size ?? 0,
        checksum: document.file_hash ?? '',
        status: 'MISSING_AT_SOURCE',
        detail: 'Registered in the database, absent from the local store.',
      };
    }
    return {
      storageKey: key,
      documentId: document.id,
      size: 0,
      checksum: '',
      status: 'FAILED',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const checksum = sha256(bytes);

  // Already there, and the same bytes? Then this is a resume passing over work
  // a previous run finished, and re-uploading would only cost time. Already
  // there with different bytes is not something to paper over: it is reported,
  // and nothing is overwritten.
  const existing = await target.head(key).catch(() => null);
  if (existing) {
    if (existing.checksum === checksum) {
      await recordFile(input.target_db, runId, document.id, key, bytes.byteLength, checksum, 1);
      return {
        storageKey: key,
        documentId: document.id,
        size: bytes.byteLength,
        checksum,
        status: 'ALREADY_PRESENT',
      };
    }
    return {
      storageKey: key,
      documentId: document.id,
      size: bytes.byteLength,
      checksum,
      status: 'FAILED',
      detail:
        'An object already exists at this key in the target with different bytes. Nothing was ' +
        'overwritten. Resolve which one is the document before migrating again.',
    };
  }

  try {
    const meta = await target.put({
      key,
      body: bytes,
      originalFilename: document.filename ?? path.posix.basename(key),
    });
    if (meta.checksum !== checksum) {
      return {
        storageKey: key,
        documentId: document.id,
        size: bytes.byteLength,
        checksum,
        status: 'FAILED',
        detail: `The target reported a different checksum (${meta.checksum}).`,
      };
    }
    await recordFile(input.target_db, runId, document.id, key, bytes.byteLength, checksum, 0);
    return {
      storageKey: key,
      documentId: document.id,
      size: bytes.byteLength,
      checksum,
      status: 'COPIED',
    };
  } catch (error) {
    return {
      storageKey: key,
      documentId: document.id,
      size: bytes.byteLength,
      checksum,
      status: 'FAILED',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Read the target back and compare it with the source.
 *
 * Deliberately not "count what the loop wrote". The loop's own count proves the
 * loop ran; only a query against the target proves the target holds the rows,
 * and only rehashing the bytes the target returns proves a file arrived whole.
 */
async function verifyMigration(input: {
  source: Database;
  target: Database;
  targetStore: StorageProvider;
  order: string[];
  counts: Map<string, number>;
  documents: DocumentRowLite[];
  /** Set when the migration was scoped to one project. */
  projectId: string | null;
  log: (line: string) => void;
}): Promise<VerificationReport> {
  const { source, target, targetStore, order, counts, documents, projectId, log } = input;

  const rowCounts: VerificationReport['rowCounts'] = [];
  for (const table of order) {
    const expected = counts.get(table) ?? 0;
    const actual = (await countTarget(target, table)) ?? -1;
    // The target may legitimately hold more than a project-scoped migration
    // sent it — another project migrated earlier. Fewer is the failure.
    rowCounts.push({ table, source: expected, target: actual, ok: actual >= expected });
  }

  // A relationship is the thing a row count cannot check: that the links still
  // resolve on the other side. These are chosen to cross the joins the platform
  // actually depends on — a document to its layer, an audit to its gaps, a
  // claim to the pass that produced it, a document to its own lineage.
  const relationships: VerificationReport['relationships'] = [];
  //
  // Each probe carries the column that ties it back to a project, because a
  // project-scoped migration must be judged against that project only. Without
  // it the source side would count every project's rows and the target side one
  // project's, and a perfectly correct scoped migration would report as a
  // failure — which is exactly what it did before this was added.
  const probes: { description: string; sql: string; scope: string }[] = [
    {
      description: 'documents resolve to a layer',
      sql: `SELECT COUNT(*) AS n FROM documents d
              JOIN layers l ON l.id = d.layer_id`,
      scope: 'd.project_id',
    },
    {
      description: 'layers resolve to a project',
      sql: `SELECT COUNT(*) AS n FROM layers l
              JOIN projects p ON p.id = l.project_id`,
      scope: 'l.project_id',
    },
    {
      description: 'audit gaps resolve to their audit',
      sql: `SELECT COUNT(*) AS n FROM audit_gaps g
              JOIN audits a ON a.id = g.audit_id`,
      scope: 'a.project_id',
    },
    {
      description: 'superseded documents still point at their successor',
      sql: `SELECT COUNT(*) AS n FROM documents d
              JOIN documents s ON s.id = d.superseded_by_document_id`,
      scope: 'd.project_id',
    },
    {
      description: 'extraction runs resolve to their document',
      sql: `SELECT COUNT(*) AS n FROM extraction_runs r
              JOIN documents d ON d.id = r.document_id`,
      scope: 'r.project_id',
    },
    {
      description: 'research claims resolve to the pass that produced them',
      // Claims carry no project of their own, so the tie is through the
      // orchestration that produced them.
      sql: `SELECT COUNT(*) AS n FROM research_claims c
              JOIN research_passes p ON p.id = c.pass_id
              JOIN research_orchestrations o ON o.id = c.orchestration_id`,
      scope: 'o.project_id',
    },
    {
      description: 'a redo attempt still names its parent run',
      sql: `SELECT COUNT(*) AS n FROM research_runs r
              JOIN research_runs parent ON parent.id = r.parent_run_id`,
      scope: 'r.project_id',
    },
    {
      description: 'events resolve to their project',
      sql: `SELECT COUNT(*) AS n FROM project_events e
              JOIN projects p ON p.id = e.project_id`,
      scope: 'e.project_id',
    },
  ];

  for (const probe of probes) {
    const sql = projectId ? `${probe.sql} WHERE ${probe.scope} = ?` : probe.sql;
    const params = projectId ? [projectId] : undefined;
    const sourceCount = (await source.get<{ n: number }>(sql, params))?.n ?? 0;
    const targetCount = (await target.get<{ n: number }>(sql, params))?.n ?? 0;
    relationships.push({
      description: probe.description,
      source: sourceCount,
      target: targetCount,
      ok: targetCount >= sourceCount,
    });
  }

  // Every uploaded file, rehashed from what the target returns.
  const mismatched: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  let matched = 0;
  for (const document of documents) {
    const key = document.storage_key ?? document.filesystem_path;
    if (!key) continue;
    checked += 1;
    try {
      const bytes = await targetStore.get(key);
      if (sha256(bytes) === document.file_hash) matched += 1;
      else if (!document.file_hash) matched += 1; // nothing recorded to check against
      else mismatched.push(key);
    } catch {
      missing.push(key);
    }
  }
  log(
    `  ${matched}/${checked} file checksum(s) matched; ` +
      `${mismatched.length} mismatched, ${missing.length} absent from the target.`,
  );

  return {
    rowCounts,
    relationships,
    checksums: { checked, matched, mismatched, missing },
    ok:
      rowCounts.every((r) => r.ok) &&
      relationships.every((r) => r.ok) &&
      mismatched.length === 0 &&
      missing.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

async function recordRunStart(
  target: Database,
  input: {
    runId: string;
    mode: CloudMigrationMode;
    projectId: string | null;
    source: string;
    startedAt: string;
  },
): Promise<void> {
  await target.run(
    `INSERT INTO cloud_migration_runs (id, mode, project_id, source, started_at, status)
     VALUES (?, ?, ?, ?, ?, 'RUNNING')
     ON CONFLICT (id) DO NOTHING`,
    [input.runId, input.mode, input.projectId, input.source, input.startedAt],
  );
}

async function recordTable(
  target: Database,
  runId: string,
  table: string,
  sourceRows: number,
  result: CopyResult,
): Promise<void> {
  await target.run(
    `INSERT INTO cloud_migration_tables (run_id, table_name, source_rows, inserted, skipped, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, table_name) DO UPDATE
        SET inserted = EXCLUDED.inserted,
            skipped = EXCLUDED.skipped,
            completed_at = EXCLUDED.completed_at`,
    [runId, table, sourceRows, result.inserted, result.skipped, nowIso()],
  );
}

async function recordFile(
  target: Database,
  runId: string,
  documentId: string,
  key: string,
  size: number,
  checksum: string,
  verified: number,
): Promise<void> {
  await target.run(
    `INSERT INTO cloud_migration_files (storage_key, run_id, document_id, size, checksum, verified, copied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (storage_key) DO UPDATE
        SET run_id = EXCLUDED.run_id,
            verified = EXCLUDED.verified,
            copied_at = EXCLUDED.copied_at`,
    [key, runId, documentId, size, checksum, verified, nowIso()],
  );
}

async function recordRunEnd(
  target: Database,
  runId: string,
  report: CloudMigrationReport | null,
  error?: unknown,
): Promise<void> {
  const rows = report?.tables.reduce((n, t) => n + t.inserted, 0) ?? 0;
  const copied = report?.files.filter((f) => f.status === 'COPIED') ?? [];
  await target.run(
    `UPDATE cloud_migration_runs
        SET finished_at = ?, status = ?, rows_copied = ?, files_copied = ?, bytes_copied = ?,
            report = ?, error = ?
      WHERE id = ?`,
    [
      nowIso(),
      report ? (report.ok ? 'COMPLETE' : 'FAILED') : 'FAILED',
      rows,
      copied.length,
      copied.reduce((n, f) => n + f.size, 0),
      report ? JSON.stringify(report) : null,
      error ? (error instanceof Error ? error.message : String(error)) : null,
      runId,
    ],
  );
}
