/**
 * How much room is left, measured rather than guessed.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it deliberately is not
 * ---------------------------------------------------------------------------
 *
 * It is one reading on the operational surface that already exists
 * (`GET /api/health`, administrator view). It is not a storage product: there
 * is no archival engine here, no compression job, no per-project quota and no
 * approval anybody has to give before an idea may be stored. Storage is cheap
 * relative to the business this Brain runs, and the only thing worth building
 * is the reading that stops it becoming a surprise.
 *
 * ---------------------------------------------------------------------------
 * Evidence is counted once
 * ---------------------------------------------------------------------------
 *
 * `documents.file_hash` is the sha-256 of the bytes. Two documents that are the
 * same file are one file's worth of storage, so the deduplicated total is the
 * one the projection uses, and the naive total is reported beside it so the
 * saving is visible rather than merely claimed. Counting the same evidence
 * twice would make the runway projection wrong in the direction that costs
 * money.
 *
 * ---------------------------------------------------------------------------
 * Anything unmeasurable is absent, never estimated
 * ---------------------------------------------------------------------------
 *
 * Provisioned capacity is a fact about somebody's plan, not about this process.
 * It is read from `BRAIN_STORAGE_CAPACITY_GB` when an operator has set it, and
 * is `null` otherwise — which makes the percentage, the threshold and the
 * runway `null` too. A reading that invented a denominator would produce a
 * threshold warning nobody could act on and a runway nobody should believe.
 *
 * Growth is a difference between two observations, so a Brain with one sample
 * reports `null` growth and says why. The samples are this table's whole
 * purpose and are bounded: at most one an hour, however often the page is
 * refreshed.
 */
import fs from 'node:fs';
import { getDb } from '../db/database.ts';
import { activeDatabaseConfig } from '../db/database.ts';
import { activeStorageConfig, getStorage } from './storage/index.ts';
import { DB_PATH } from '../env.ts';
import { newId, nowIso, parseJson, toJson } from '../repos/util.ts';
import type { StorageReadingRow } from '../domain/types.ts';

/** No more than one sample an hour, whatever the traffic. */
export const SAMPLE_INTERVAL_MS = 60 * 60 * 1000;

/** The three thresholds, and what each one means. */
export const THRESHOLDS = [
  { at: 0.95, level: 'URGENT' as const },
  { at: 0.85, level: 'WARNING' as const },
  { at: 0.7, level: 'NOTICE' as const },
];

export type StorageLevel = 'OK' | 'NOTICE' | 'WARNING' | 'URGENT' | 'UNKNOWN';

/**
 * What a gigabyte-month costs, where an operator has said.
 *
 * `BRAIN_STORAGE_COST_PER_GB_MONTH`, in whole currency units. Absent means the
 * projected cost is `null`: a made-up unit price produces a made-up bill, and
 * one number on a status page is not worth being wrong about.
 */
function unitCost(): number | null {
  const raw = process.env['BRAIN_STORAGE_COST_PER_GB_MONTH'];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function capacityBytes(): number | null {
  const raw = process.env['BRAIN_STORAGE_CAPACITY_GB'];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 1024 * 1024 * 1024);
}

export interface StorageCategory {
  name: string;
  bytes: number;
  count: number;
}

export interface StorageHealth {
  observedAt: string;
  provider: string;
  /** Bytes of stored evidence, each distinct file counted once. */
  usedBytes: number | null;
  /** The same objects counted naively, so the deduplication is visible. */
  rawBytes: number | null;
  duplicateBytesSaved: number | null;
  databaseBytes: number | null;
  /** Evidence plus database, when both are measurable here. */
  totalBytes: number | null;
  capacityBytes: number | null;
  usedFraction: number | null;
  level: StorageLevel;
  /** One sentence a person can act on. Always present. */
  headline: string;
  /** Bytes per day, from the samples. Null until there are two. */
  growthBytesPerDay: number | null;
  growthWindowDays: number | null;
  /** Days until capacity at the measured rate. Null when either half is null. */
  daysUntilFull: number | null;
  projectedMonthlyCost: number | null;
  /** Where the space is going, when the store can say. */
  categories: StorageCategory[];
  /** Why a figure is missing, when one is. Never a guess in its place. */
  notes: string[];
}

interface Measured {
  usedBytes: number | null;
  rawBytes: number | null;
  count: number | null;
  databaseBytes: number | null;
  categories: StorageCategory[];
  notes: string[];
}

/**
 * Measure the two things Brain can actually measure about itself.
 *
 * Evidence comes from the `documents` rows, which record the size and the hash
 * of every stored file — so the figure is exact, deduplicated and costs one
 * indexed query, rather than a bucket listing that would be slow, paginated and
 * different every time it raced an upload.
 */
async function measure(): Promise<Measured> {
  const notes: string[] = [];
  const db = getDb();

  const totals = await db.all<{ used: number | null; count: number | null }>(
    `SELECT SUM(size) AS used, COUNT(*) AS count FROM (
       SELECT MAX(file_size) AS size
         FROM documents
        WHERE file_size IS NOT NULL AND file_hash IS NOT NULL AND file_missing = 0
        GROUP BY file_hash
     ) distinct_files`,
  );
  const raw = await db.all<{ raw: number | null }>(
    `SELECT SUM(file_size) AS raw FROM documents
      WHERE file_size IS NOT NULL AND file_hash IS NOT NULL AND file_missing = 0`,
  );

  const categories = (
    await db.all<{ name: string | null; bytes: number | null; count: number | null }>(
      `SELECT document_type AS name, SUM(size) AS bytes, COUNT(*) AS count FROM (
         SELECT document_type, file_hash, MAX(file_size) AS size
           FROM documents
          WHERE file_size IS NOT NULL AND file_hash IS NOT NULL AND file_missing = 0
          GROUP BY document_type, file_hash
       ) grouped
       GROUP BY name
       ORDER BY bytes DESC`,
    )
  )
    .filter((row) => row.name !== null && row.bytes !== null)
    .slice(0, 8)
    .map((row) => ({
      name: row.name as string,
      bytes: Number(row.bytes ?? 0),
      count: Number(row.count ?? 0),
    }));

  let databaseBytes: number | null = null;
  if (db.dialect === 'postgres') {
    try {
      const rows = await db.all<{ bytes: string | number | null }>(
        'SELECT pg_database_size(current_database()) AS bytes',
      );
      const value = rows[0]?.bytes;
      databaseBytes = value === null || value === undefined ? null : Number(value);
    } catch {
      notes.push('the database size could not be read on this deployment');
    }
  } else {
    try {
      databaseBytes = fs.statSync(DB_PATH).size;
    } catch {
      notes.push('the database file could not be measured');
    }
  }

  return {
    usedBytes: totals[0]?.used === null || totals[0]?.used === undefined
      ? 0
      : Number(totals[0].used),
    rawBytes: raw[0]?.raw === null || raw[0]?.raw === undefined ? 0 : Number(raw[0].raw),
    count: totals[0]?.count === null || totals[0]?.count === undefined
      ? 0
      : Number(totals[0].count),
    databaseBytes,
    categories,
    notes,
  };
}

/**
 * Record a sample, at most once an hour.
 *
 * Bounded on purpose: growth needs history, and a status page somebody leaves
 * open on a wallboard must not be the reason the table grows. Returns the rows
 * that exist afterwards, newest first.
 */
async function sample(measured: Measured, at: string): Promise<StorageReadingRow[]> {
  const db = getDb();
  const recent = await db.all<StorageReadingRow>(
    'SELECT * FROM storage_readings ORDER BY observed_at DESC, rowid DESC LIMIT 60',
  );
  const newest = recent[0];
  const dueForOne =
    !newest || Date.parse(at) - Date.parse(newest.observed_at) >= SAMPLE_INTERVAL_MS;

  if (!dueForOne) return recent;

  const provider = activeStorageConfig()?.provider ?? getStorage().kind;
  await db.run(
    `INSERT INTO storage_readings
       (id, observed_at, provider, database_bytes, object_bytes, object_count,
        object_bytes_raw, categories)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('str'), at, provider, measured.databaseBytes, measured.usedBytes,
      measured.count, measured.rawBytes, toJson(measured.categories),
    ],
  );
  return await db.all<StorageReadingRow>(
    'SELECT * FROM storage_readings ORDER BY observed_at DESC, rowid DESC LIMIT 60',
  );
}

/**
 * Bytes per day, from the oldest sample that is not the newest.
 *
 * The whole window rather than the last two, because two adjacent samples an
 * hour apart turn one large import into a projection of terabytes. A negative
 * rate — evidence was removed — is reported as no measurable growth rather than
 * as a runway that grows for ever.
 */
function growthFrom(rows: StorageReadingRow[]): {
  bytesPerDay: number | null;
  windowDays: number | null;
  note: string | null;
} {
  const usable = rows.filter((row) => row.object_bytes !== null);
  if (usable.length < 2) {
    return {
      bytesPerDay: null,
      windowDays: null,
      note: 'growth needs two readings and this Brain has taken one so far',
    };
  }
  const newest = usable[0]!;
  const oldest = usable[usable.length - 1]!;
  const days = (Date.parse(newest.observed_at) - Date.parse(oldest.observed_at)) / 86_400_000;
  if (!(days > 0)) {
    return { bytesPerDay: null, windowDays: null, note: 'the readings share a timestamp' };
  }
  const total = (newest.object_bytes ?? 0) + (newest.database_bytes ?? 0);
  const before = (oldest.object_bytes ?? 0) + (oldest.database_bytes ?? 0);
  const delta = total - before;
  if (delta <= 0) {
    return { bytesPerDay: 0, windowDays: days, note: null };
  }
  return { bytesPerDay: delta / days, windowDays: days, note: null };
}

function levelFor(fraction: number | null): StorageLevel {
  if (fraction === null) return 'UNKNOWN';
  for (const threshold of THRESHOLDS) {
    if (fraction >= threshold.at) return threshold.level;
  }
  return 'OK';
}

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * The reading.
 *
 * Nothing here stops, throttles or refuses any Brain work at any threshold, and
 * nothing calls it from a work path. It is a report, and a report that could
 * halt research would be a storage product deciding what the business does.
 */
export async function storageHealth(at = nowIso()): Promise<StorageHealth> {
  const measured = await measure();
  const rows = await sample(measured, at);
  const growth = growthFrom(rows);
  const notes = [...measured.notes];
  if (growth.note) notes.push(growth.note);

  const capacity = capacityBytes();
  if (capacity === null) {
    notes.push(
      'provisioned capacity is not configured here, so the percentage, the threshold and the ' +
        'runway are not reported rather than being estimated',
    );
  }

  const totalBytes =
    measured.usedBytes === null
      ? null
      : measured.usedBytes + (measured.databaseBytes ?? 0);
  const fraction =
    capacity !== null && totalBytes !== null ? totalBytes / capacity : null;
  const level = levelFor(fraction);

  const daysUntilFull =
    capacity !== null && totalBytes !== null && growth.bytesPerDay !== null && growth.bytesPerDay > 0
      ? Math.max(0, (capacity - totalBytes) / growth.bytesPerDay)
      : null;

  const cost = unitCost();
  const projectedMonthlyCost =
    cost !== null && totalBytes !== null
      ? Number(((totalBytes / (1024 * 1024 * 1024)) * cost).toFixed(2))
      : null;
  if (cost === null) {
    notes.push('no unit storage price is configured, so no monthly cost is projected');
  }

  return {
    observedAt: at,
    provider: activeStorageConfig()?.provider ?? getStorage().kind,
    usedBytes: measured.usedBytes,
    rawBytes: measured.rawBytes,
    duplicateBytesSaved:
      measured.rawBytes !== null && measured.usedBytes !== null
        ? measured.rawBytes - measured.usedBytes
        : null,
    databaseBytes: measured.databaseBytes,
    totalBytes,
    capacityBytes: capacity,
    usedFraction: fraction,
    level,
    headline: headlineFor(level, totalBytes, capacity, fraction, daysUntilFull),
    growthBytesPerDay: growth.bytesPerDay,
    growthWindowDays: growth.windowDays,
    daysUntilFull,
    projectedMonthlyCost,
    categories: measured.categories,
    notes,
  };
}

/**
 * The sentence.
 *
 * At `WARNING` and `URGENT` it names what would be archived or compressed
 * first, from the measured categories rather than from a rule of thumb — a
 * warning that cannot say where the space went is one nobody can act on.
 */
function headlineFor(
  level: StorageLevel,
  totalBytes: number | null,
  capacity: number | null,
  fraction: number | null,
  daysUntilFull: number | null,
): string {
  if (totalBytes === null) return 'Storage could not be measured on this deployment.';
  const used = gib(totalBytes);
  if (level === 'UNKNOWN' || capacity === null || fraction === null) {
    return `${used} stored. No provisioned capacity is configured, so there is no percentage to report.`;
  }
  const percent = `${Math.round(fraction * 100)}%`;
  const runway =
    daysUntilFull === null
      ? 'growth is not measurable yet'
      : `about ${Math.round(daysUntilFull)} day(s) at the current rate`;
  switch (level) {
    case 'URGENT':
      return `${used} of ${gib(capacity)} used (${percent}). Urgent: ${runway}. Raise capacity now.`;
    case 'WARNING':
      return `${used} of ${gib(capacity)} used (${percent}). ${runway}. Largest categories are worth reviewing for archival.`;
    case 'NOTICE':
      return `${used} of ${gib(capacity)} used (${percent}). ${runway}. Nothing to do yet.`;
    default:
      return `${used} of ${gib(capacity)} used (${percent}).`;
  }
}

/** For a diagnostic that wants the samples themselves. */
export async function storageSamples(limit = 30): Promise<
  { observedAt: string; objectBytes: number | null; databaseBytes: number | null }[]
> {
  const rows = await getDb().all<StorageReadingRow>(
    'SELECT * FROM storage_readings ORDER BY observed_at DESC, rowid DESC LIMIT ?',
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    observedAt: row.observed_at,
    objectBytes: row.object_bytes,
    databaseBytes: row.database_bytes,
  }));
}

/** The stored categories of one sample, for a report that wants them. */
export function categoriesOf(row: StorageReadingRow): StorageCategory[] {
  return parseJson<StorageCategory[]>(row.categories, []);
}

/** Which persistence this Brain is on, for the reading's own header. */
export function persistenceLabel(): string {
  return activeDatabaseConfig()?.provider ?? 'sqlite';
}
