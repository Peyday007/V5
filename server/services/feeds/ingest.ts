/**
 * Checkpointed, resumable, content-hashed ingestion of a large corpus in
 * shards (program fpg_ea512f54…, ACQ-21-4 step 3).
 *
 * A pull in `run.ts` is one request for one small JSON feed. A corpus — a
 * crawl index, a nightly bulk archive, a dump — is not: it is many shards
 * (index pages, archive members, query windows), it can be interrupted half
 * way, and most of it is not wanted. This module is the part that makes that
 * safe, and nothing more:
 *
 * - **Shards, filtered in place.** A source names its shards (or index
 *   queries) and a `keep` predicate. Each shard is read and filtered where it
 *   was read; only records the filter keeps reach the store. Nothing copies a
 *   corpus whole into the application server.
 * - **A checkpoint after every shard.** The checkpoint is a row on the
 *   existing cash ledger (`cash_events`, kind `FEED_INGEST_CHECKPOINT`), written
 *   only after the shard's records are stored. A run that dies mid-way resumes
 *   at the first shard with no checkpoint for its snapshot, and nothing already
 *   checkpointed is fetched or stored again.
 * - **Content hashes.** Every kept record is hashed (sha256 over its content
 *   fields, never its fetch time). The same content under a new id is a
 *   duplicate and is not stored; a known id whose content changed is an
 *   update, recorded as one. Hashes are carried in the checkpoints, so the
 *   dedup holds across runs and across snapshots of the same source.
 * - **Provider pacing.** The source's own spacing is waited between shard
 *   requests, never skipped because a run is behind.
 *
 * Storage is the existing owner: records go into `feed_items` through
 * `insertFeedItems`, and checkpoints onto the ledger every other feed pass
 * already writes to. No table, queue or scheduler is added (§10.3, §20.4).
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { insertFeedItems } from '../../repos/feeds.ts';
import type { FeedItem } from './sources.ts';

/** The ledger kind one shard's checkpoint is recorded under. */
export const INGEST_CHECKPOINT_EVENT = 'FEED_INGEST_CHECKPOINT';

/** A corpus read in shards. */
export interface ShardedSource {
  /** The `feed_items.source` the records are stored under. */
  id: string;
  /**
   * Which edition of the corpus this run reads (a crawl id, an archive date).
   * Checkpoints are per snapshot: a new snapshot reads every shard again, and
   * content already held is still recognised by its hash.
   */
  snapshot: string;
  /** Shard keys in reading order: index pages, archive members, query windows. */
  shards: readonly string[];
  /** Read one shard. Throwing interrupts the run; the shard is not checkpointed. */
  fetchShard(key: string): Promise<FeedItem[]>;
  /** The in-place filter: only records it keeps are stored. Absent keeps everything. */
  keep?: (item: FeedItem) => boolean;
  /** The provider's pacing between shard requests, in milliseconds. */
  spacingMs: number;
}

/** One shard's durable checkpoint. */
export interface ShardCheckpoint {
  source: string;
  snapshot: string;
  shard: string;
  /** Records the shard returned before the filter. */
  read: number;
  /** Records the filter kept. */
  kept: number;
  /** Kept records stored as new. */
  stored: number;
  /** Kept records whose content was already held under some id. */
  duplicates: number;
  /** Known ids whose content changed: an incremental update, recorded rather than silently dropped. */
  updated: string[];
  /** externalId → content hash for every kept record, so dedup holds on the next run. */
  hashes: Record<string, string>;
  at: string;
}

/** Where checkpoints and records live. The production store is `feedIngestStore`. */
export interface IngestStore {
  checkpoints(source: string): Promise<ShardCheckpoint[]>;
  saveCheckpoint(checkpoint: ShardCheckpoint): Promise<void>;
  /** Store new records; returns how many were inserted. */
  store(source: string, items: readonly FeedItem[]): Promise<number>;
}

export interface IngestRun {
  source: string;
  snapshot: string;
  /** Shards a previous run already checkpointed, skipped without a request. */
  resumedPast: string[];
  /** Shards this run read and checkpointed. */
  completed: ShardCheckpoint[];
  /** The shard that failed, if the run was interrupted; the next run starts there. */
  interruptedAt: { shard: string; error: string } | null;
}

/**
 * The content a record is: never its fetch time or where it was found, so a
 * re-read, or the same record mirrored under another id and address, hashes
 * the same.
 */
export function contentHash(item: FeedItem): string {
  const content = [item.title, item.body ?? '', item.organization ?? '', item.publishedAt ?? ''].join('\u0000');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Read a sharded corpus from its last checkpoint to its end, or until a shard
 * fails. Every shard is fetched at most once per snapshot across all runs.
 */
export async function ingestShards(
  source: ShardedSource,
  store: IngestStore,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
): Promise<IngestRun> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const history = await store.checkpoints(source.id);
  const done = new Set(history.filter((one) => one.snapshot === source.snapshot).map((one) => one.shard));
  // What is already held, from every earlier checkpoint of this source, whatever its snapshot.
  const hashById = new Map<string, string>();
  const heldHashes = new Set<string>();
  for (const checkpoint of [...history].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const [id, hash] of Object.entries(checkpoint.hashes)) {
      hashById.set(id, hash);
      heldHashes.add(hash);
    }
  }

  const run: IngestRun = { source: source.id, snapshot: source.snapshot, resumedPast: [], completed: [], interruptedAt: null };
  let requested = false;
  for (const shard of source.shards) {
    if (done.has(shard)) {
      run.resumedPast.push(shard);
      continue;
    }
    if (requested && source.spacingMs > 0) await sleep(source.spacingMs);
    requested = true;
    let items: FeedItem[];
    try {
      items = await source.fetchShard(shard);
    } catch (error) {
      run.interruptedAt = { shard, error: error instanceof Error ? error.message : String(error) };
      break;
    }
    const kept = source.keep ? items.filter((one) => source.keep!(one)) : items;
    const fresh: FeedItem[] = [];
    const updated: string[] = [];
    const hashes: Record<string, string> = {};
    let duplicates = 0;
    for (const item of kept) {
      const hash = contentHash(item);
      const known = hashById.get(item.externalId);
      hashes[item.externalId] = hash;
      if (known !== undefined && known !== hash) {
        updated.push(item.externalId);
      } else if (known === undefined && heldHashes.has(hash)) {
        duplicates += 1;
      } else if (known === undefined) {
        fresh.push(item);
      } else {
        duplicates += 1;
      }
      hashById.set(item.externalId, hash);
      heldHashes.add(hash);
    }
    const stored = fresh.length > 0 ? await store.store(source.id, fresh) : 0;
    const checkpoint: ShardCheckpoint = {
      source: source.id,
      snapshot: source.snapshot,
      shard,
      read: items.length,
      kept: kept.length,
      stored,
      duplicates,
      updated,
      hashes,
      at: now().toISOString(),
    };
    // Written only after the records are stored: a crash between the two re-reads the shard, never skips it.
    await store.saveCheckpoint(checkpoint);
    run.completed.push(checkpoint);
  }
  return run;
}

/**
 * The production store: records into `feed_items`, checkpoints onto the
 * project's cash ledger.
 */
export function feedIngestStore(projectId: string): IngestStore {
  return {
    async checkpoints(source) {
      const rows = await getDb().all<{ detail: string | null }>(
        `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at, id`,
        [projectId, INGEST_CHECKPOINT_EVENT],
      );
      const out: ShardCheckpoint[] = [];
      for (const row of rows) {
        try {
          const detail = JSON.parse(row.detail ?? '{}') as Partial<ShardCheckpoint>;
          if (detail.source !== source || typeof detail.shard !== 'string' || typeof detail.snapshot !== 'string') continue;
          out.push({
            source: detail.source,
            snapshot: detail.snapshot,
            shard: detail.shard,
            read: Number(detail.read ?? 0),
            kept: Number(detail.kept ?? 0),
            stored: Number(detail.stored ?? 0),
            duplicates: Number(detail.duplicates ?? 0),
            updated: Array.isArray(detail.updated) ? detail.updated.map(String) : [],
            hashes: detail.hashes && typeof detail.hashes === 'object' ? (detail.hashes as Record<string, string>) : {},
            at: String(detail.at ?? ''),
          });
        } catch {
          // An unreadable row is not a checkpoint: its shard is read again rather than assumed done.
        }
      }
      return out;
    },
    async saveCheckpoint(checkpoint) {
      await recordCashEvent({
        projectId,
        kind: INGEST_CHECKPOINT_EVENT,
        actorRef: 'BRAIN',
        summary:
          `Ingested ${checkpoint.source} (${checkpoint.snapshot}) shard ${checkpoint.shard}: ${checkpoint.read} read, ` +
          `${checkpoint.kept} kept by the filter, ${checkpoint.stored} stored, ${checkpoint.duplicates} duplicate(s) by content hash, ` +
          `${checkpoint.updated.length} update(s).`,
        detail: { ...checkpoint },
      });
    },
    store: (source, items) => insertFeedItems(source, items),
  };
}
