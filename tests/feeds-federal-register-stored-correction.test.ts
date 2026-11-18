/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@3 — a correction stored before the
 * connector looked up the corrected rule's date stays dateless for good.
 *
 * C1-2026-21030 (NRC, AP1000 Design Certification Renewal) was fetched on
 * 2026-11-12 as "Corrects 2026-21030." The lookup that writes "Corrected rule
 * effective YYYY-MM-DD." ran only on items parsed in a new pull, and the
 * Federal Register cursor never lists that correction again, so no detector
 * version could ever see a date for it. A pull now also completes such stored
 * items, under the same per-pull lookup limit, as a new version of the record.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { pullDueFeeds, type AcquisitionDeps } from '../server/services/feeds/run.ts';
import {
  FEDERAL_REGISTER_CORRECTION_LOOKUPS,
  FEED_SOURCES,
  federalRegisterCorrectionIncomplete,
  federalRegisterEffectiveOnUrl,
  type FeedItem,
} from '../server/services/feeds/sources.ts';

const SOURCE = 'federal-register-rules';
const production = FEED_SOURCES.find((s) => s.id === SOURCE)!;
const FR = 'https://www.federalregister.gov/documents';
const LOOKUP_PREFIX = 'https://www.federalregister.gov/api/v1/documents/';

const storedCorrection: FeedItem = {
  externalId: 'C1-2026-21030',
  url: `${FR}/2026/11/12/C1-2026-21030/ap1000-design-certification-renewal`,
  title: 'AP1000 Design Certification Renewal',
  body: 'Corrects 2026-21030.',
  organization: 'Nuclear Regulatory Commission',
  publishedAt: '2026-11-12T00:00:00.000Z',
};

const emptyListing = { results: [] };

/** The document number a per-document lookup asks about, or null for the listing. */
function lookedUp(url: string): string | null {
  if (!url.startsWith(LOOKUP_PREFIX)) return null;
  return decodeURIComponent(url.slice(LOOKUP_PREFIX.length).split('.json')[0]!);
}

async function bodies(externalId: string): Promise<{ external_id: string; body: string | null }[]> {
  return getDb().all<{ external_id: string; body: string | null }>(
    `SELECT external_id, body FROM feed_items WHERE source = ? AND (external_id = ? OR external_id LIKE ?) ORDER BY external_id`,
    [SOURCE, externalId, `${externalId}#v%`],
  );
}

async function pull(answer: (url: string) => unknown, asked: string[]): Promise<void> {
  const out = await pullDueFeeds({
    now: new Date(),
    sources: [production],
    fetcher: async (url) => {
      asked.push(url);
      return answer(url);
    },
  });
  expect(out[0]?.error).toBeNull();
}

describe('federalRegisterCorrectionIncomplete', () => {
  it('is true only for a correction with no date of either kind', () => {
    expect(federalRegisterCorrectionIncomplete({ body: 'Corrects 2026-21030.' })).toBe(true);
    expect(federalRegisterCorrectionIncomplete({ body: 'Corrects 2026-21030. Corrected rule effective 2026-12-28.' })).toBe(false);
    expect(federalRegisterCorrectionIncomplete({ body: 'Effective 2026-12-28. Corrects 2026-21030.' })).toBe(false);
    expect(federalRegisterCorrectionIncomplete({ body: 'Effective 2026-11-12.' })).toBe(false);
    expect(federalRegisterCorrectionIncomplete({ body: null })).toBe(false);
  });
});

describe('a Federal Register pull completes a correction stored before the lookup existed', () => {
  it('appends the corrected rule’s effective date as a new version, original text intact (plain fetcher pass)', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedCorrection]);
    const asked: string[] = [];
    await pull((url) => (lookedUp(url) === '2026-21030' ? { document_number: '2026-21030', effective_on: '2026-12-28' } : emptyListing), asked);
    expect(asked).toContain(federalRegisterEffectiveOnUrl('2026-21030'));
    const rows = await bodies('C1-2026-21030');
    // The row fetched 2026-11-12 is never rewritten; the completion is the record's next version.
    expect(rows).toEqual([
      { external_id: 'C1-2026-21030', body: 'Corrects 2026-21030.' },
      { external_id: 'C1-2026-21030#v2', body: 'Corrects 2026-21030. Corrected rule effective 2026-12-28.' },
    ]);
    expect(rows[1]!.body!.startsWith('Corrects 2026-21030.')).toBe(true);
    expect(rows[1]!.body!.endsWith('Corrected rule effective 2026-12-28.')).toBe(true);

    // Completed once: the next pull does not ask again and stores nothing more.
    const again: string[] = [];
    await getDb().run('DELETE FROM feed_pulls WHERE source = ?', [SOURCE]);
    await pull((url) => (lookedUp(url) === '2026-21030' ? { document_number: '2026-21030', effective_on: '2026-12-28' } : emptyListing), again);
    expect(again.filter((url) => lookedUp(url) !== null)).toEqual([]);
    expect(await bodies('C1-2026-21030')).toHaveLength(2);
  });

  it('does the same through the acquisition pipeline', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedCorrection]);
    const asked: string[] = [];
    const deps: AcquisitionDeps = {
      transport: async (url) => {
        asked.push(url);
        const answer = lookedUp(url) === '2026-21030' ? { document_number: '2026-21030', effective_on: '2026-12-28' } : emptyListing;
        return { status: 200, headers: {}, body: JSON.stringify(answer) };
      },
      validators: async () => null,
      supervise: async () => ({ outcome: 'NONE' }),
      record: async () => undefined,
      yields: async () => new Map(),
      recordYields: async () => undefined,
      sleep: async () => undefined,
    };
    await pullDueFeeds({ now: new Date(), sources: [production], acquisition: deps });
    expect(asked).toContain(federalRegisterEffectiveOnUrl('2026-21030'));
    expect((await bodies('C1-2026-21030')).map((r) => r.body)).toEqual([
      'Corrects 2026-21030.',
      'Corrects 2026-21030. Corrected rule effective 2026-12-28.',
    ]);
  });

  it('leaves the stored item unchanged when the lookup fails', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedCorrection]);
    const asked: string[] = [];
    await pull((url) => {
      if (lookedUp(url) !== null) throw new Error('HTTP 503');
      return emptyListing;
    }, asked);
    expect(asked).toContain(federalRegisterEffectiveOnUrl('2026-21030'));
    expect(await bodies('C1-2026-21030')).toEqual([{ external_id: 'C1-2026-21030', body: 'Corrects 2026-21030.' }]);
  });

  it('leaves the stored item unchanged when the corrected rule states no effective date', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedCorrection]);
    const asked: string[] = [];
    await pull((url) => (lookedUp(url) === '2026-21030' ? { document_number: '2026-21030', effective_on: null } : emptyListing), asked);
    expect(asked).toContain(federalRegisterEffectiveOnUrl('2026-21030'));
    expect(await bodies('C1-2026-21030')).toEqual([{ external_id: 'C1-2026-21030', body: 'Corrects 2026-21030.' }]);
  });

  it('does not look up an item that already carries a date', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [
      { ...storedCorrection, body: 'Corrects 2026-21030. Corrected rule effective 2026-12-28.' },
      { ...storedCorrection, externalId: 'C1-2026-22000', body: 'Effective 2026-12-01. Corrects 2026-22000.' },
      { ...storedCorrection, externalId: '2026-23041', body: 'Effective 2026-11-12.' },
    ]);
    const asked: string[] = [];
    await pull(() => emptyListing, asked);
    expect(asked.filter((url) => lookedUp(url) !== null)).toEqual([]);
  });

  it('bounds lookups per pull by FEDERAL_REGISTER_CORRECTION_LOOKUPS, parsed and stored together', async () => {
    await freshProject();
    const stored = Array.from({ length: FEDERAL_REGISTER_CORRECTION_LOOKUPS + 5 }, (_, i) => ({
      ...storedCorrection,
      externalId: `C1-2026-3${String(i).padStart(4, '0')}`,
      body: `Corrects 2026-3${String(i).padStart(4, '0')}.`,
    }));
    await insertFeedItems(SOURCE, stored);
    const listing = {
      results: [
        {
          document_number: 'C1-2026-40000',
          title: 'A correction parsed in this pull',
          html_url: `${FR}/2026/11/17/C1-2026-40000/a-correction`,
          publication_date: '2026-11-17',
          abstract: null,
          effective_on: null,
          agencies: [{ name: 'Nuclear Regulatory Commission' }],
          correction_of: '2026-40000',
        },
      ],
    };
    const asked: string[] = [];
    await pull((url) => {
      const doc = lookedUp(url);
      return doc ? { document_number: doc, effective_on: '2026-12-28' } : listing;
    }, asked);
    const lookups = asked.map(lookedUp).filter((doc): doc is string => doc !== null);
    expect(lookups).toHaveLength(FEDERAL_REGISTER_CORRECTION_LOOKUPS);
    // What was parsed in this pull is completed first.
    expect(lookups[0]).toBe('2026-40000');
    const completed = await getDb().all<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM feed_items WHERE source = ? AND external_id LIKE 'C1-2026-3%#v2'`,
      [SOURCE],
    );
    expect(Number(completed[0]!.n)).toBe(FEDERAL_REGISTER_CORRECTION_LOOKUPS - 1);
  });
});

describe('the correction helpers in sources.ts keep their own doc comments', () => {
  const source = readFileSync(fileURLToPath(new URL('../server/services/feeds/sources.ts', import.meta.url)), 'utf8');
  /** The JSDoc block that ends immediately above `export … function name(`. */
  function docAbove(name: string): string {
    const at = source.search(new RegExp(`export (async )?function ${name}\\(`));
    expect(at).toBeGreaterThan(0);
    const before = source.slice(0, at);
    expect(before.trimEnd().endsWith('*/')).toBe(true);
    return before.slice(before.lastIndexOf('/**'));
  }

  it('no doc comment is left orphaned directly above another doc comment', () => {
    expect(/\*\/\s*\n\s*\/\*\*/.test(source)).toBe(false);
  });

  it('each correction helper is described by the comment above it', () => {
    expect(docAbove('completeFederalRegisterCorrections')).toContain('Corrected rule effective YYYY-MM-DD.');
    expect(docAbove('completeFederalRegisterCorrections')).toContain('leaves the item as parsed');
    expect(docAbove('federalRegisterCorrectionIncomplete')).toContain('would still look up');
    expect(docAbove('federalRegisterCorrectionIncomplete')).not.toContain('ask the Federal Register API');
  });
});
