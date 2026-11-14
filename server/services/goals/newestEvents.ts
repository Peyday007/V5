/**
 * Newest-first reads of the factory event ledger, for the passes that need
 * "the current state" of something recorded there.
 *
 * `listFactoryEvents` answers oldest first under a `LIMIT` capped at 5000, so
 * taking `.at(-1)` of it reads the 5000th-oldest row once a kind passes that
 * count — frozen forever, so a later promotion is never seen (and never
 * demoted) and a review fingerprint never matches (so it is re-recorded every
 * pass). These reads order newest first and page by offset, so the newest row
 * is always the first one read, whatever the ledger's size. The row mapper is
 * the repository's own; this adds an ordering, not a second store.
 */
import { getDb } from '../../db/database.ts';
import type { FactoryEvent, FactoryEventRow } from '../../domain/factory.ts';
import { mapEvent } from '../../repos/factoryFleet.ts';

export const NEWEST_PAGE = 500;

/**
 * Factory events of `kinds`, newest first, one page at a time. The caller stops
 * iterating as soon as it has what it needs; nothing is capped, so an old row is
 * still reachable when no newer one matches.
 */
export async function* newestFactoryEvents(kinds: readonly string[], pageSize = NEWEST_PAGE): AsyncGenerator<FactoryEvent> {
  if (kinds.length === 0) return;
  const size = Math.max(1, Math.floor(pageSize));
  const placeholders = kinds.map(() => '?').join(', ');
  for (let offset = 0; ; offset += size) {
    const rows = await getDb().all<FactoryEventRow>(
      `SELECT * FROM factory_events WHERE kind IN (${placeholders})
        ORDER BY at DESC, rowid DESC LIMIT ${size} OFFSET ${offset}`,
      [...kinds],
    );
    for (const row of rows) yield mapEvent(row);
    if (rows.length < size) return;
  }
}

/** The newest event of `kinds` that `match` accepts, or null. */
export async function newestFactoryEvent(
  kinds: readonly string[],
  match: (event: FactoryEvent) => boolean = () => true,
  pageSize = NEWEST_PAGE,
): Promise<FactoryEvent | null> {
  for await (const event of newestFactoryEvents(kinds, pageSize)) if (match(event)) return event;
  return null;
}

/** Every event of `kinds` that `match` accepts, oldest first — the whole ledger, not its oldest 5000. */
export async function allFactoryEventsOldestFirst(
  kinds: readonly string[],
  match: (event: FactoryEvent) => boolean = () => true,
  pageSize = NEWEST_PAGE,
): Promise<FactoryEvent[]> {
  const out: FactoryEvent[] = [];
  for await (const event of newestFactoryEvents(kinds, pageSize)) if (match(event)) out.push(event);
  return out.reverse();
}
