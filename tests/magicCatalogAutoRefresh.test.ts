/**
 * The catalog fills itself when somebody reads its status: empty or stale
 * starts one refresh, a recent failure or a refresh already running does not,
 * and tests never reach the network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { loadMagicFixtures } from './helpers/magicFixtures.ts';
import { getDb } from '../server/db/database.ts';
import { upsertCatalogSource } from '../server/repos/magicCatalog.ts';
import { DEFAULT_SOURCE_KEY, ensureCatalogFresh, RETRY_AFTER_FAILURE_MS, STALE_AFTER_MS } from '../server/services/magic/catalog/index.ts';

let starts = 0;
const start = () => { starts++; };

beforeEach(async () => {
  await freshProject();
  starts = 0;
});

describe('ensureCatalogFresh', () => {
  it('is off under the test runner unless asked, so no test reaches Scryfall', async () => {
    expect(await ensureCatalogFresh({ start })).toBe('DISABLED');
    expect(starts).toBe(0);
  });

  it('starts a refresh for an empty catalog', async () => {
    expect(await ensureCatalogFresh({ start, enabled: true })).toBe('STARTED');
    expect(starts).toBe(1);
  });

  it('leaves a fresh catalog alone and refreshes a stale one', async () => {
    await loadMagicFixtures();
    const fetchedAt = new Date().toISOString();
    await upsertCatalogSource({ sourceKey: DEFAULT_SOURCE_KEY, status: 'FRESH', fetchedAt, cardCount: 1 });
    expect(await ensureCatalogFresh({ start, enabled: true })).toBe('FRESH');
    const later = new Date(Date.now() + STALE_AFTER_MS + 60_000);
    expect(await ensureCatalogFresh({ start, enabled: true, now: later })).toBe('STARTED');
    expect(starts).toBe(1);
  });

  it('holds off after a failure, then asks again', async () => {
    await upsertCatalogSource({ sourceKey: DEFAULT_SOURCE_KEY, status: 'FAILED', lastError: 'Scryfall did not answer.', cardCount: 0 });
    expect(await ensureCatalogFresh({ start, enabled: true })).toBe('RECENT_FAILURE');
    const later = new Date(Date.now() + RETRY_AFTER_FAILURE_MS + 60_000);
    expect(await ensureCatalogFresh({ start, enabled: true, now: later })).toBe('STARTED');
    expect(starts).toBe(1);
    expect(await getDb().get('SELECT 1 AS ok')).toBeTruthy();
  });
});
