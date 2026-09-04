/**
 * Moving a Brain into the cloud, and the promises that migration makes.
 *
 * These run only when BRAIN_TEST_DATABASE_URL supplies a Postgres to migrate
 * into, because there is nothing worth asserting about a migration that never
 * reached a database. What is asserted is what the tool claims about itself:
 *
 *   - a dry run writes nothing, and says so rather than reporting work;
 *   - the source is not modified, at all, ever, including on failure;
 *   - running it twice inserts nothing the second time;
 *   - ids, timestamps, checksums and lineage cross unchanged;
 *   - verification reads the target back rather than trusting the loop;
 *   - a file already in the target with different bytes is refused, not
 *     overwritten.
 *
 * The last one is the reason the whole tool can be safely re-run: nothing it
 * does is destructive, so the recovery for any failure is to fix the cause and
 * run it again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openSqlite } from '../server/db/adapters/sqlite.ts';
import { runMigrations } from '../server/db/migrate.ts';
import { runCloudMigration } from '../server/services/cloudMigration.ts';
import { LocalStorageProvider } from '../server/services/storage/local.ts';
import type { DatabaseConfig, StorageConfig } from '../server/config.ts';

const POSTGRES_URL = (process.env.BRAIN_TEST_DATABASE_URL ?? '').trim() || null;
const onPostgres = POSTGRES_URL ? describe : describe.skip;

const LOCAL_STORAGE: StorageConfig = {
  provider: 'local',
  supabaseUrl: null,
  serviceRoleKey: null,
  bucket: null,
};

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let root: string;
let sourceRoot: string;
let targetRoot: string;
let sourceDbPath: string;
let schema: string;
let target: DatabaseConfig;

/**
 * Hash the local tree, so "unchanged" can be asserted rather than hoped.
 *
 * `-wal` and `-shm` are excluded, and the reason is worth being exact about.
 * Opening a WAL-mode SQLite database creates those two sidecars even for a
 * read-only connection, and leaves them behind on close. They are SQLite's own
 * scratch: the `-shm` is a shared-memory index and the `-wal` left by a reader
 * is zero bytes. No data of Brain's lives in either, and any connection
 * recreates them.
 *
 * What must not change is the content — `brain.db` itself and every document
 * byte — and that is what this hashes. The test below also asserts `brain.db`
 * is byte-identical on its own, so the exclusion here cannot hide a write to
 * the database.
 */
function treeFingerprint(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!/\.db-(wal|shm)$/.test(entry.name)) {
        parts.push(`${path.relative(dir, full)}:${sha256(fs.readFileSync(full))}`);
      }
    }
  };
  walk(dir);
  return sha256(Buffer.from(parts.join('\n')));
}

/**
 * A small but real Brain: a project, layers, two documents with bytes on disk,
 * a superseded lineage link, an audit with a gap, and events.
 *
 * Written through the schema rather than through the services, because what is
 * under test is the copy, and a fixture that used the whole import pipeline
 * would be testing the pipeline as well.
 */
async function buildSourceBrain(
  options: { slug?: string; name?: string; suffix?: string } = {},
): Promise<{ projectId: string; documentIds: string[] }> {
  const db = openSqlite(sourceDbPath);
  await runMigrations(db, sourceDbPath);

  const store = new LocalStorageProvider(sourceRoot);
  const at = '2026-03-01T09:00:00.000Z';
  const slug = options.slug ?? 'probe';
  const suffix = options.suffix ?? '';
  const projectId = `prj_migration_probe${suffix}`;
  const layerId = `lyr_migration_probe${suffix}`;

  await db.run(
    `INSERT INTO projects (id, slug, name, description, north_star, version_policy, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '{}', ?, ?)`,
    [projectId, slug, options.name ?? 'Probe', at, at],
  );
  await db.run(
    `INSERT INTO layers (id, project_id, slug, name, order_index, status, status_source,
       current_wave, expected_versions, parked, parked_note, notes, created_at, updated_at)
     VALUES (?, ?, 'world-model', 'World Model', 0, 'NOT_STARTED', 'DERIVED', 1, '[]', 0, NULL, NULL, ?, ?)`,
    [layerId, projectId, at, at],
  );

  const documentIds: string[] = [];
  for (const [index, version] of ['v1', 'v2'].entries()) {
    const documentId = `doc_probe${suffix}_${version}`;
    const bytes = Buffer.from(`the contents of World Model ${version}, at length`.repeat(20));
    const key = `projects/${slug}/documents/world-model/World Model ${version}.pdf`;
    await store.put({ key, body: bytes, contentType: 'application/pdf' });

    await db.run(
      `INSERT INTO documents (id, project_id, layer_id, canonical_name, version, version_sort, wave,
         document_type, status, filename, filesystem_path, storage_key, storage_provider,
         file_size, file_hash, conversation_title, created_at, updated_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'FOUNDATION', ?, ?, ?, ?, 'LOCAL', ?, ?, NULL, ?, ?, ?)`,
      [
        documentId,
        projectId,
        layerId,
        `World Model ${version}`,
        version,
        String(index + 1).padStart(6, '0'),
        index === 0 ? 'SUPERSEDED' : 'COMPLETE',
        `World Model ${version}.pdf`,
        key,
        key,
        bytes.byteLength,
        sha256(bytes),
        at,
        at,
        at,
      ],
    );
    documentIds.push(documentId);
  }

  // Lineage: v1 was superseded by v2. This link is what must survive.
  await db.run('UPDATE documents SET superseded_by_document_id = ? WHERE id = ?', [
    documentIds[1],
    documentIds[0],
  ]);
  await db.run('UPDATE documents SET parent_document_id = ? WHERE id = ?', [
    documentIds[0],
    documentIds[1],
  ]);

  const auditId = `aud_probe${suffix}`;
  await db.run(
    `INSERT INTO audits (id, project_id, layer_id, audited_document_id, verdict, summary,
       freeze_eligible, source, raw, created_at, mode)
     VALUES (?, ?, ?, ?, 'READY_FOR_SYNTHESIS', 'Coverage is complete.', 1, 'MANUAL', '{}', ?, 'SINGLE_DOCUMENT')`,
    [auditId, projectId, layerId, documentIds[1], at],
  );
  await db.run(
    `INSERT INTO audit_gaps (id, audit_id, ordinal, classification, title, detail,
       justification, source_pass, created_at)
     VALUES (?, ?, 0, 'MINOR', 'One loose end', 'detail', 'because', 'JUDGE', ?)`,
    [`gap_probe${suffix}`, auditId, at],
  );
  for (const [index, type] of ['PROJECT_CREATED', 'DOCUMENT_IMPORTED', 'AUDIT_RECORDED'].entries()) {
    await db.run(
      `INSERT INTO project_events (id, project_id, entity_type, entity_id, event_type, payload, created_at)
       VALUES (?, ?, 'PROJECT', ?, ?, '{}', ?)`,
      [`evt_probe${suffix}_${index}`, projectId, projectId, type, at],
    );
  }

  await db.close();
  return { projectId, documentIds };
}

async function freshSchema(): Promise<void> {
  const pg = await import('pg');
  const admin = new pg.default.Client({ connectionString: POSTGRES_URL! });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
}

async function queryTarget<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pg = await import('pg');
  const client = new pg.default.Client({
    connectionString: POSTGRES_URL!,
    options: `-c search_path=${schema}`,
  });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

function migrate(overrides: Partial<Parameters<typeof runCloudMigration>[0]> = {}) {
  return runCloudMigration({
    sourceDbPath,
    sourceRoot,
    targetRoot,
    target,
    targetStorage: LOCAL_STORAGE,
    mode: 'MIGRATE',
    ...overrides,
  });
}

onPostgres('migrating a Brain into the cloud', () => {
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-migrate-'));
    sourceRoot = path.join(root, 'source');
    targetRoot = path.join(root, 'target');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(targetRoot, { recursive: true });
    sourceDbPath = path.join(sourceRoot, 'brain.db');
    schema = 'brain_migration_probe';
    target = { provider: 'postgres', connectionString: POSTGRES_URL!, poolSize: 4, schema };
    await freshSchema();
    await buildSourceBrain();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a dry run writes nothing and does not report work it did not do', async () => {
    const before = treeFingerprint(sourceRoot);
    const report = await migrate({ mode: 'DRY_RUN' });

    expect(report.mode).toBe('DRY_RUN');
    expect(report.source.rows).toBeGreaterThan(0);
    expect(report.source.files).toBe(2);

    // Nothing claims to have been copied.
    expect(report.tables.every((t) => t.inserted === 0)).toBe(true);
    expect(report.files.every((f) => f.status !== 'COPIED')).toBe(true);
    expect(report.files.filter((f) => f.status === 'WOULD_COPY')).toHaveLength(2);

    // And nothing was.
    expect(await queryTarget('SELECT * FROM projects')).toHaveLength(0);
    expect(fs.readdirSync(targetRoot)).toHaveLength(0);
    expect(treeFingerprint(sourceRoot)).toBe(before);
  });

  it('copies the rows and the files, and verifies by reading the target back', async () => {
    const report = await migrate();

    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    expect(report.files.filter((f) => f.status === 'COPIED')).toHaveLength(2);
    expect(report.verification!.checksums.matched).toBe(2);
    expect(report.verification!.checksums.mismatched).toHaveLength(0);
    expect(report.verification!.rowCounts.every((r) => r.ok)).toBe(true);
    expect(report.verification!.relationships.every((r) => r.ok)).toBe(true);

    // Read the target independently of the tool's own report.
    expect(await queryTarget('SELECT id FROM projects')).toHaveLength(1);
    expect(await queryTarget('SELECT id FROM documents')).toHaveLength(2);
    expect(await queryTarget('SELECT id FROM project_events')).toHaveLength(3);
    expect(await queryTarget('SELECT id FROM audit_gaps')).toHaveLength(1);
  });

  it('preserves ids, timestamps, checksums and lineage exactly', async () => {
    await migrate();

    const rows = await queryTarget<{
      id: string;
      created_at: string;
      file_hash: string;
      status: string;
      superseded_by_document_id: string | null;
      parent_document_id: string | null;
      storage_key: string;
    }>('SELECT * FROM documents ORDER BY version');

    expect(rows.map((r) => r.id)).toEqual(['doc_probe_v1', 'doc_probe_v2']);
    // The exact string, not a re-interpreted timestamp.
    expect(rows[0]!.created_at).toBe('2026-03-01T09:00:00.000Z');
    // The superseded document keeps its row, its status and its bytes.
    expect(rows[0]!.status).toBe('SUPERSEDED');
    expect(rows[0]!.superseded_by_document_id).toBe('doc_probe_v2');
    expect(rows[1]!.parent_document_id).toBe('doc_probe_v1');

    // The checksum recorded in the source is the checksum of what the target
    // now holds — checked against the bytes, not against the row.
    const store = new LocalStorageProvider(targetRoot);
    for (const row of rows) {
      expect(sha256(await store.get(row.storage_key))).toBe(row.file_hash);
    }
  });

  it('inserts nothing on a second run, so resuming cannot duplicate', async () => {
    const first = await migrate();
    const firstInserted = first.tables.reduce((n, t) => n + t.inserted, 0);
    expect(firstInserted).toBeGreaterThan(0);

    const firstSkipped = first.tables.reduce((n, t) => n + t.skipped, 0);

    const second = await migrate();
    expect(second.tables.reduce((n, t) => n + t.inserted, 0)).toBe(0);
    /*
     * Everything the first run wrote **plus everything it already found**.
     *
     * This used to compare against `firstInserted` alone, which held only while
     * no table arrived pre-seeded. Migration 027 seeds one row — the Russell
     * cycle singleton — into both source and target, so the first run correctly
     * skips it rather than inserting it, and the second run skips it again. The
     * property being tested is unchanged and is the one that matters: the
     * second run inserts nothing, so resuming cannot duplicate.
     */
    expect(second.tables.reduce((n, t) => n + t.skipped, 0)).toBe(firstInserted + firstSkipped);
    expect(second.files.every((f) => f.status === 'ALREADY_PRESENT')).toBe(true);
    expect(second.ok).toBe(true);

    // The target holds one copy of everything, not two.
    expect(await queryTarget('SELECT id FROM documents')).toHaveLength(2);
    expect(await queryTarget('SELECT id FROM project_events')).toHaveLength(3);
  });

  it('resumes an interrupted migration without repeating what it finished', async () => {
    // Stand in for an interruption: the rows arrived, the files did not.
    await migrate();
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.mkdirSync(targetRoot, { recursive: true });

    const resumed = await migrate();
    expect(resumed.tables.reduce((n, t) => n + t.inserted, 0)).toBe(0);
    expect(resumed.files.filter((f) => f.status === 'COPIED')).toHaveLength(2);
    expect(resumed.ok).toBe(true);
  });

  it('never modifies the source, even across repeated runs', async () => {
    const before = treeFingerprint(sourceRoot);
    const databaseBefore = sha256(fs.readFileSync(sourceDbPath));

    await migrate({ mode: 'DRY_RUN' });
    await migrate();
    await migrate();
    await migrate({ mode: 'VERIFY_ONLY' });

    expect(treeFingerprint(sourceRoot)).toBe(before);
    // Separately and specifically: the database file itself, byte for byte.
    expect(sha256(fs.readFileSync(sourceDbPath))).toBe(databaseBefore);
    // And nothing was removed. A migration that "succeeded" by deleting the
    // original would pass a hash comparison of what remained.
    expect(fs.existsSync(sourceDbPath)).toBe(true);
    expect(fs.existsSync(path.join(sourceRoot, 'projects'))).toBe(true);
  });

  it('opens the source read-only, so a bug could not write to it either', async () => {
    const readOnly = openSqlite(sourceDbPath, { readOnly: true });
    await expect(
      readOnly.run('UPDATE documents SET canonical_name = ? WHERE id = ?', ['tampered', 'doc_probe_v1']),
    ).rejects.toThrow();
    await readOnly.close();

    const untouched = openSqlite(sourceDbPath, { readOnly: true });
    const row = await untouched.get<{ canonical_name: string }>(
      'SELECT canonical_name FROM documents WHERE id = ?',
      ['doc_probe_v1'],
    );
    expect(row!.canonical_name).toBe('World Model v1');
    await untouched.close();
  });

  it('refuses a file already in the target with different bytes rather than overwriting', async () => {
    const key = 'projects/probe/documents/world-model/World Model v1.pdf';
    const store = new LocalStorageProvider(targetRoot);
    await store.put({ key, body: Buffer.from('something else entirely') });

    const report = await migrate();
    const clash = report.files.find((f) => f.storageKey === key)!;
    expect(clash.status).toBe('FAILED');
    expect(clash.detail).toMatch(/nothing was overwritten/i);
    expect(report.ok).toBe(false);

    // The bytes that were already there are still there.
    expect((await store.get(key)).toString()).toBe('something else entirely');
  });

  it('verify-only changes nothing and reports whether the target really matches', async () => {
    await migrate();
    const clean = await migrate({ mode: 'VERIFY_ONLY' });
    expect(clean.ok).toBe(true);
    expect(clean.tables.every((t) => t.inserted === 0)).toBe(true);

    // Take a file away and the verification must notice, not shrug.
    fs.rmSync(path.join(targetRoot, 'projects'), { recursive: true, force: true });
    const broken = await migrate({ mode: 'VERIFY_ONLY' });
    expect(broken.ok).toBe(false);
    expect(broken.verification!.checksums.missing.length).toBeGreaterThan(0);
  });

  it('scopes to one project when asked, and says which', async () => {
    const report = await migrate({ mode: 'DRY_RUN', project: 'probe' });
    expect(report.scope.projectName).toBe('Probe');
    expect(report.scope.project).toBe('prj_migration_probe');

    await expect(migrate({ mode: 'DRY_RUN', project: 'no-such-project' })).rejects.toThrow(
      /no project/i,
    );
  });

  describe('with two projects in the source', () => {
    // Project B is built alongside A, with its own layer, documents, audit,
    // gap and events — so "only A moved" is a claim about a populated source
    // rather than about an empty one.
    beforeEach(async () => {
      await buildSourceBrain({ slug: 'second', name: 'Second', suffix: '_b' });
    });

    it('migrates only the project asked for, and leaves the other behind', async () => {
      const report = await migrate({ project: 'probe' });
      expect(report.ok, JSON.stringify(report.problems)).toBe(true);
      expect(report.scope.projectName).toBe('Probe');

      const projects = await queryTarget<{ id: string }>('SELECT id FROM projects');
      expect(projects.map((p) => p.id)).toEqual(['prj_migration_probe']);

      // Every one of A's entity types crossed…
      for (const [table, expected] of [
        ['layers', 1],
        ['documents', 2],
        ['audits', 1],
        ['audit_gaps', 1],
        ['project_events', 3],
      ] as const) {
        expect(await queryTarget(`SELECT * FROM ${table}`), table).toHaveLength(expected);
      }

      // …and none of B's did, at any depth. Asserted by identity rather than by
      // a name pattern: `audit_gaps` carries no project_id of its own, so
      // reaching it means scoping followed the relationships rather than just
      // filtering the tables that made it easy.
      expect(
        await queryTarget('SELECT id FROM documents WHERE project_id = $1', [
          'prj_migration_probe_b',
        ]),
      ).toHaveLength(0);
      expect(
        await queryTarget('SELECT id FROM layers WHERE project_id = $1', [
          'prj_migration_probe_b',
        ]),
      ).toHaveLength(0);
      expect(await queryTarget('SELECT id FROM audit_gaps WHERE id = $1', ['gap_probe_b'])).toHaveLength(0);
      expect(await queryTarget('SELECT id FROM documents WHERE id = $1', ['doc_probe_b_v1'])).toHaveLength(0);
    });

    it("keeps A's relationships intact and A's files present, B's absent", async () => {
      await migrate({ project: 'probe' });

      const rows = await queryTarget<{
        id: string;
        layer_id: string;
        superseded_by_document_id: string | null;
        storage_key: string;
        file_hash: string;
      }>('SELECT * FROM documents ORDER BY version');
      expect(rows[0]!.superseded_by_document_id).toBe('doc_probe_v2');
      // The layer it points at came across too, so the join still resolves.
      const layers = await queryTarget<{ id: string }>('SELECT id FROM layers');
      expect(layers[0]!.id).toBe(rows[0]!.layer_id);

      const store = new LocalStorageProvider(targetRoot);
      for (const row of rows) {
        expect(sha256(await store.get(row.storage_key))).toBe(row.file_hash);
      }
      // B's objects were never uploaded.
      expect(await store.exists('projects/second/documents/world-model/World Model v1.pdf')).toBe(
        false,
      );
    });

    it('does not disturb the other project once it has also been migrated', async () => {
      await migrate({ project: 'probe' });
      await migrate({ project: 'second' });

      expect(await queryTarget('SELECT id FROM projects')).toHaveLength(2);
      expect(await queryTarget('SELECT id FROM documents')).toHaveLength(4);

      // Re-running A now that B is there must touch nothing at all.
      const again = await migrate({ project: 'probe' });
      expect(again.tables.reduce((n, t) => n + t.inserted, 0)).toBe(0);
      expect(again.ok).toBe(true);
      expect(await queryTarget('SELECT id FROM projects')).toHaveLength(2);
      expect(await queryTarget('SELECT id FROM documents')).toHaveLength(4);

      const verify = await migrate({ mode: 'VERIFY_ONLY', project: 'probe' });
      expect(verify.ok).toBe(true);
    });

    it('resumes a project-scoped migration that was interrupted partway', async () => {
      // Interrupt for real: let the rows land, then take the uploaded objects
      // away, which is the shape of a run that died during the file stage.
      const first = await migrate({ project: 'probe' });
      expect(first.files.filter((f) => f.status === 'COPIED')).toHaveLength(2);
      fs.rmSync(targetRoot, { recursive: true, force: true });
      fs.mkdirSync(targetRoot, { recursive: true });

      const resumed = await migrate({ project: 'probe' });
      // It continued rather than restarting: no row was written twice…
      expect(resumed.tables.reduce((n, t) => n + t.inserted, 0)).toBe(0);
      expect(resumed.tables.reduce((n, t) => n + t.skipped, 0)).toBeGreaterThan(0);
      // …and the work that had actually been lost was redone.
      expect(resumed.files.filter((f) => f.status === 'COPIED')).toHaveLength(2);
      expect(resumed.ok).toBe(true);
      expect(resumed.verification!.checksums.matched).toBe(2);

      // Still one copy of everything, and B still untouched.
      expect(await queryTarget('SELECT id FROM documents')).toHaveLength(2);
      expect(await queryTarget('SELECT id FROM projects')).toHaveLength(1);
    });

    it('leaves the two-project source byte-identical throughout', async () => {
      const before = treeFingerprint(sourceRoot);
      const databaseBefore = sha256(fs.readFileSync(sourceDbPath));
      await migrate({ mode: 'DRY_RUN', project: 'probe' });
      await migrate({ project: 'probe' });
      await migrate({ project: 'second' });
      await migrate({ mode: 'VERIFY_ONLY' });
      expect(treeFingerprint(sourceRoot)).toBe(before);
      expect(sha256(fs.readFileSync(sourceDbPath))).toBe(databaseBefore);
    });
  });

  it('records what it did in the target, for the report rather than for safety', async () => {
    const report = await migrate();
    const runs = await queryTarget<{ id: string; status: string; files_copied: number }>(
      'SELECT * FROM cloud_migration_runs',
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(report.runId);
    expect(runs[0]!.status).toBe('COMPLETE');
    expect(Number(runs[0]!.files_copied)).toBe(2);

    const files = await queryTarget('SELECT * FROM cloud_migration_files');
    expect(files).toHaveLength(2);
  });

  it('refuses a target that is not Postgres instead of quietly copying nothing', async () => {
    await expect(
      migrate({ target: { provider: 'sqlite', connectionString: null, poolSize: 1 } }),
    ).rejects.toThrow(/must be Postgres/i);
  });
});
