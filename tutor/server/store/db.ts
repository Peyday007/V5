import { createRequire } from 'node:module';
import { join } from 'node:path';

// Loaded through require so test tooling that does not yet list `node:sqlite` as a builtin still finds it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

/**
 * The tutor's own small database: a card cache, the rules text, saved decks, match records and
 * the learning profile. Schema changes are numbered and applied once, in order.
 */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE cards (
     oracle_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     layout TEXT NOT NULL,
     json TEXT NOT NULL
   );
   CREATE TABLE card_names (
     norm TEXT NOT NULL,
     oracle_id TEXT NOT NULL,
     kind TEXT NOT NULL,           -- FULL | FACE
     PRIMARY KEY (norm, oracle_id, kind)
   );
   CREATE INDEX card_names_norm ON card_names(norm);
   CREATE TABLE printings (
     set_code TEXT NOT NULL,
     number TEXT NOT NULL,
     json TEXT,                    -- null: Scryfall answered 404
     fetched_at TEXT NOT NULL,
     PRIMARY KEY (set_code, number)
   );
   CREATE TABLE rulings (oracle_id TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE rules (number TEXT PRIMARY KEY, text TEXT NOT NULL);
   CREATE TABLE glossary (term TEXT PRIMARY KEY, text TEXT NOT NULL);
   CREATE TABLE decks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     game TEXT NOT NULL,
     format TEXT NOT NULL,
     source_text TEXT NOT NULL,
     data TEXT NOT NULL,           -- the resolved deck, quantities exactly as uploaded
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE matches (
     id TEXT PRIMARY KEY,
     deck_id TEXT NOT NULL,
     engine_match_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     coach_mode TEXT NOT NULL,
     opponents TEXT NOT NULL,
     created_at TEXT NOT NULL,
     ended_at TEXT,
     outcome TEXT
   );
   CREATE TABLE match_events (
     match_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     json TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (match_id, seq)
   );
   CREATE TABLE learning (
     concept TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     practiced INTEGER NOT NULL DEFAULT 0,
     misunderstood INTEGER NOT NULL DEFAULT 0,
     last_note TEXT,
     updated_at TEXT NOT NULL
   );`,
];

export function openDb(dataDir: string, file = 'tutor.db'): Db {
  const db = new DatabaseSync(join(dataDir, file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export const nowIso = (): string => new Date().toISOString();
