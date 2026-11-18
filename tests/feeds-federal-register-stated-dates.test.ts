/**
 * The Federal Register parser records a date the source states only in its
 * official `dates` field (effective_on null) as the marker sentence
 * "Stated effective YYYY-MM-DD." — the contract RULE_EFFECTIVE_SOON@6 reads.
 * Built from the recorded Coast Guard rows (2026-23230 Miami Winterfest,
 * 2026-23047 San Diego Fleet Week: action "Notification of enforcement of
 * regulation", effective_on null) and C1-2026-21030 (dates null).
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { RULE_EFFECTIVE_SOON_V5, RULE_EFFECTIVE_SOON_V6, type DetectorRecord } from '../server/services/feeds/detectors.ts';
import { pullDueFeeds } from '../server/services/feeds/run.ts';
import {
  FEDERAL_REGISTER_CORRECTION_LOOKUPS,
  FEED_SOURCES,
  federalRegisterActionStatesEffect,
  federalRegisterDatesUrl,
  federalRegisterStatedDate,
  federalRegisterStatedDateUnread,
  parseFederalRegister,
  type FeedItem,
} from '../server/services/feeds/sources.ts';

const USCG = [
  { id: 227, name: 'Homeland Security Department', parent_id: null },
  { id: 85, name: 'Coast Guard', parent_id: 227 },
];

const row = (over: Record<string, unknown>) => ({
  document_number: '2026-23230',
  title: 'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade',
  html_url: 'https://www.federalregister.gov/documents/2026/11/16/2026-23230/special-local-regulation',
  publication_date: '2026-11-16',
  effective_on: null,
  abstract: 'The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.',
  agencies: USCG,
  action: 'Notification of enforcement of regulation.',
  correction_of: null,
  dates: 'The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.',
  ...over,
});

describe('parseFederalRegister: a date stated only in the DATES field', () => {
  it('writes "Stated effective" for a notification of enforcement with effective_on null, and no Effective sentence', () => {
    const [item] = parseFederalRegister({ results: [row({})] });
    expect(item!.body).toContain('Stated effective 2026-12-13.');
    expect(item!.body).not.toMatch(/\bEffective \d{4}-\d{2}-\d{2}\./);
  });

  it('reads 2026-23047 (enforced the day before publication) as its stated date; the detector, not the parser, judges it', () => {
    const [item] = parseFederalRegister({
      results: [row({
        document_number: '2026-23047',
        html_url: 'https://www.federalregister.gov/documents/2026/11/12/2026-23047/special-local-regulation',
        publication_date: '2026-11-12',
        dates: 'The regulations in 33 CFR 100.1101 will be enforced from 9 a.m. to 11 a.m. on November 11, 2026.',
      })],
    });
    expect(item!.body).toContain('Stated effective 2026-11-11.');
  });

  it('takes the earliest date when the field states several', () => {
    const [item] = parseFederalRegister({ results: [row({ dates: 'Enforced from December 20, 2026 through January 2, 2027, and on December 13, 2026.' })] });
    expect(item!.body).toContain('Stated effective 2026-12-13.');
  });

  it('keeps exactly the current body for a row that has effective_on', () => {
    const withEffective = row({ effective_on: '2026-11-12', dates: 'This rule is effective November 12, 2026.' });
    const [item] = parseFederalRegister({ results: [withEffective] });
    expect(item!.body).toBe('The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade. Effective 2026-11-12.');
  });

  it('parses a row whose dates field is null or states no "Month D, YYYY" date exactly as before', () => {
    const [none] = parseFederalRegister({ results: [row({ dates: null })] });
    expect(none!.body).toBe('The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.');
    const [vague] = parseFederalRegister({ results: [row({ dates: 'Effective upon publication; comments due within 30 days.' })] });
    expect(vague!.body).toBe('The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.');
  });

  it('leaves a correction (C1-2026-21030 shape: effective_on, dates and action null) as before', () => {
    const [item] = parseFederalRegister({
      results: [row({
        document_number: 'C1-2026-21030',
        html_url: 'https://www.federalregister.gov/documents/2026/11/12/C1-2026-21030/ap1000-design-certification-renewal',
        abstract: null,
        action: null,
        dates: null,
        correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030',
      })],
    });
    expect(item!.body).toBe('Corrects 2026-21030.');
  });

  it('never writes a marker for a correction, even when its dates field states a date', () => {
    const [item] = parseFederalRegister({
      results: [row({ correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030', dates: 'Effective December 13, 2026.' })],
    });
    expect(item!.body).not.toContain('Stated effective');
  });
});

describe('federalRegisterStatedDate', () => {
  it('reads only a real "Month D, YYYY" date', () => {
    expect(federalRegisterStatedDate('on December 13, 2026.')).toBe('2026-12-13');
    expect(federalRegisterStatedDate('on February 30, 2026.')).toBeNull();
    expect(federalRegisterStatedDate('on 2026-12-13.')).toBeNull();
    expect(federalRegisterStatedDate(null)).toBeNull();
  });
});

describe('a DATES field that also names dates that are not effective dates', () => {
  it('never reads a comment deadline as the stated effective date', () => {
    expect(federalRegisterStatedDate('Comments must be received by December 1, 2026.')).toBeNull();
    expect(federalRegisterStatedDate('This rule is effective December 15, 2026. Comments must be received by December 1, 2026.')).toBe('2026-12-15');
    expect(federalRegisterStatedDate('This rule is effective December 15, 2026; comments must be received by December 1, 2026.')).toBe('2026-12-15');
    expect(federalRegisterStatedDate('This rule is effective December 15, 2026, and comments must be received on or before December 1, 2026.')).toBe('2026-12-15');
  });

  it('never reads an earlier publication date as the stated effective date', () => {
    expect(federalRegisterStatedDate('The rule published March 3, 2025, will be enforced on December 13, 2026.')).toBe('2026-12-13');
    expect(federalRegisterStatedDate('This document corrects the rule published March 3, 2025.')).toBeNull();
  });

  it('reads no date a meeting cue introduces, and a bare date as before', () => {
    expect(federalRegisterStatedDate('A public meeting will be held on December 2, 2026.')).toBeNull();
    expect(federalRegisterStatedDate('A public meeting will be held on December 2, 2026. The rule is effective December 20, 2026.')).toBe('2026-12-20');
    expect(federalRegisterStatedDate('December 13, 2026.')).toBe('2026-12-13');
  });

  it('keeps every enforcement date of one sentence, from 5 p.m. through 8 p.m. included', () => {
    expect(federalRegisterStatedDate('The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.')).toBe('2026-12-13');
  });

  it('writes no marker from a row whose DATES names only a comment deadline', () => {
    const [item] = parseFederalRegister({ results: [row({ dates: 'Comments must be received by December 1, 2026.' })] });
    expect(item!.body).not.toContain('Stated effective');
  });
});

describe('federalRegisterActionStatesEffect: the action field limits who carries a stated date', () => {
  it('admits rules and notifications of enforcement', () => {
    expect(federalRegisterActionStatesEffect('Notification of enforcement of regulation.')).toBe(true);
    expect(federalRegisterActionStatesEffect('Final rule.')).toBe(true);
    expect(federalRegisterActionStatesEffect('Temporary final rule.')).toBe(true);
    expect(federalRegisterActionStatesEffect('Interim final rule; request for comments.')).toBe(true);
  });

  it('refuses a proposed rule, a notice, a correction and a missing action', () => {
    expect(federalRegisterActionStatesEffect('Proposed rule.')).toBe(false);
    expect(federalRegisterActionStatesEffect('Notice.')).toBe(false);
    expect(federalRegisterActionStatesEffect('Final rule; correction.')).toBe(false);
    expect(federalRegisterActionStatesEffect(null)).toBe(false);
  });

  it('writes no marker for a row whose action is a proposed rule, even when DATES states an effective date', () => {
    const [item] = parseFederalRegister({ results: [row({ action: 'Proposed rule.', dates: 'This rule will be enforced on December 13, 2026.' })] });
    expect(item!.body).not.toContain('Stated effective');
  });
});

describe('the request', () => {
  const source = FEED_SOURCES.find((one) => one.id === 'federal-register-rules');
  const requested = [...new URL(source!.url).searchParams.getAll('fields[]')];

  /**
   * parseFederalRegister writes "Stated effective" only when the row's own
   * `action` passes federalRegisterActionStatesEffect. A listing that does not
   * request `action` hands the parser rows without it, so no fetch could ever
   * write the marker: the 2026-23230 row as the API returns it for this URL
   * must still carry its stated date.
   */
  it('requests every field the stated-date gate reads, so a fetched row can carry the marker', () => {
    expect(requested).toContain('action');
    const asServed = Object.fromEntries(Object.entries(row({})).filter(([field]) => requested.includes(field)));
    expect(federalRegisterActionStatesEffect(asServed['action'])).toBe(true);
    expect(parseFederalRegister({ results: [asServed] })[0]!.body).toContain('Stated effective 2026-12-13.');
  });

  it('asks the API for dates alongside the existing fields', () => {
    expect(source?.url).toContain('fields%5B%5D=dates');
    expect(source?.url).toContain('fields%5B%5D=effective_on');
    expect(source?.url).toContain('fields%5B%5D=correction_of');
  });

  /**
   * Every field the connector asks for has a consumer: dropping it from a row
   * changes what parseFederalRegister stores, for a row with effective_on and a
   * correction, or for one dated only in DATES. A field requested and never
   * read (as `action` once was) fails here.
   */
  it('requests only fields parseFederalRegister reads', () => {
    expect(requested.length).toBeGreaterThan(0);
    const dated = row({ effective_on: '2026-11-20', correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030' });
    const statedOnly = row({});
    const unread = requested.filter((field) => [dated, statedOnly].every((one) => {
      const without: Record<string, unknown> = { ...one };
      delete without[field];
      return JSON.stringify(parseFederalRegister({ results: [without] })) === JSON.stringify(parseFederalRegister({ results: [one] }));
    }));
    expect(unread).toEqual([]);
  });
});

/**
 * Reviewer finding F3: the marker was written only on a new fetch, so a rule
 * stored before the parser read DATES (2026-23230 fetched 2026-11-16 with its
 * abstract alone) kept its old body and v6's shadow readings over stored
 * history could never see it. A pull now re-reads such a stored rule once for
 * its own fields and stores the marker as the record's next version.
 */
describe('a Federal Register pull re-reads a rule stored before the DATES field was read', () => {
  const SOURCE = 'federal-register-rules';
  const production = FEED_SOURCES.find((s) => s.id === SOURCE)!;
  const LOOKUP_PREFIX = 'https://www.federalregister.gov/api/v1/documents/';
  const lookedUp = (url: string): string | null =>
    url.startsWith(LOOKUP_PREFIX) ? decodeURIComponent(url.slice(LOOKUP_PREFIX.length).split('.json')[0]!) : null;
  const ABSTRACT = 'The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.';
  const storedRule = (externalId: string, body: string | null = ABSTRACT): FeedItem => ({
    externalId,
    url: `https://www.federalregister.gov/documents/2026/11/16/${externalId}/special-local-regulation`,
    title: 'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade',
    body,
    organization: 'Homeland Security Department, Coast Guard',
    publishedAt: '2026-11-16T00:00:00.000Z',
  });
  const official: Record<string, Record<string, unknown>> = {
    '2026-23230': { document_number: '2026-23230', effective_on: null, correction_of: null, action: row({})['action'], dates: row({})['dates'] },
    '2026-23041': { document_number: '2026-23041', effective_on: '2026-11-12', correction_of: null, action: 'Final rule.', dates: null },
    // A proposed rule stated in DATES is no stated effective date (the parser's action gate), on a re-read too.
    '2026-23997': { document_number: '2026-23997', effective_on: null, correction_of: null, action: 'Proposed rule.', dates: 'This rule will be enforced on December 13, 2026.' },
    '2026-23999': { document_number: '2026-23999', effective_on: null, correction_of: null, action: 'Final rule.', dates: null },
  };
  async function pull(answer: (url: string) => unknown, asked: string[]): Promise<void> {
    await getDb().run('DELETE FROM feed_pulls WHERE source = ?', [SOURCE]);
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
  const answer = (url: string): unknown => {
    const doc = lookedUp(url);
    return doc ? official[doc] ?? {} : { results: [] };
  };
  async function bodies(externalId: string): Promise<{ external_id: string; body: string | null }[]> {
    return getDb().all<{ external_id: string; body: string | null }>(
      `SELECT external_id, body FROM feed_items WHERE source = ? AND (external_id = ? OR external_id LIKE ?) ORDER BY external_id`,
      [SOURCE, externalId, `${externalId}#v%`],
    );
  }

  it('is true only for a stored rule that is not a correction and carries no date or DATES record', () => {
    expect(federalRegisterStatedDateUnread(storedRule('2026-23230'))).toBe(true);
    expect(federalRegisterStatedDateUnread(storedRule('2026-23230', null))).toBe(true);
    expect(federalRegisterStatedDateUnread(storedRule('2026-23230', `${ABSTRACT} Stated effective 2026-12-13.`))).toBe(false);
    expect(federalRegisterStatedDateUnread(storedRule('2026-23230', `${ABSTRACT} No stated date.`))).toBe(false);
    expect(federalRegisterStatedDateUnread(storedRule('2026-23041', 'Effective 2026-11-12.'))).toBe(false);
    expect(federalRegisterStatedDateUnread(storedRule('C1-2026-21030', null))).toBe(false);
    expect(federalRegisterStatedDateUnread(storedRule('2026-30000', 'Corrects 2026-21030.'))).toBe(false);
    expect(production.incomplete!(storedRule('2026-23230'))).toBe(true);
    expect(production.incomplete!(storedRule('C1-2026-21030', 'Corrects 2026-21030.'))).toBe(true);
  });

  it('appends the marker the parser writes today as a new version, the stored row intact, and v6 then reads it', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedRule('2026-23230')]);
    const asked: string[] = [];
    await pull(answer, asked);
    expect(asked).toContain(federalRegisterDatesUrl('2026-23230'));
    expect(new URL(federalRegisterDatesUrl('2026-23230')).searchParams.getAll('fields[]')).toContain('action');
    const rows = await bodies('2026-23230');
    expect(rows).toEqual([
      { external_id: '2026-23230', body: ABSTRACT },
      { external_id: '2026-23230#v2', body: `${ABSTRACT} Stated effective 2026-12-13.` },
    ]);
    // Exactly what a fresh parse of the same official row writes.
    expect(rows[1]!.body).toBe(parseFederalRegister({ results: [row({})] })[0]!.body);

    // v6 over the stored history (both copies, read together by document number) now sees it.
    const records: DetectorRecord[] = rows.map((one, i) => ({
      id: `fi_${i}`,
      source: SOURCE,
      url: storedRule('2026-23230').url,
      title: storedRule('2026-23230').title,
      organization: storedRule('2026-23230').organization,
      publishedAt: '2026-11-16T00:00:00.000Z',
      fetchedAt: '2026-11-16T06:00:00.000Z',
      body: one.body,
    }));
    const now = new Date('2026-11-18T12:00:00.000Z');
    expect(RULE_EFFECTIVE_SOON_V5.detect(records, now)).toEqual([]);
    const [signal] = RULE_EFFECTIVE_SOON_V6.detect(records, now);
    expect(signal?.memberIds).toEqual(['fi_0', 'fi_1']);
    expect(signal?.windowFrom).toBe('2026-12-13T00:00:00.000Z');

    // Read once: the next pull asks nothing more and stores nothing more.
    const again: string[] = [];
    await pull(answer, again);
    expect(again.filter((url) => lookedUp(url) !== null)).toEqual([]);
    expect(await bodies('2026-23230')).toHaveLength(2);
  });

  it('records an effective_on as "Effective", and a DATES field with no date as "No stated date." so it is not asked again', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedRule('2026-23041', 'Television Broadcasting Services.'), storedRule('2026-23999'), storedRule('2026-23997')]);
    const asked: string[] = [];
    await pull(answer, asked);
    expect((await bodies('2026-23041')).map((r) => r.body)).toEqual(['Television Broadcasting Services.', 'Television Broadcasting Services. Effective 2026-11-12.']);
    expect((await bodies('2026-23999')).map((r) => r.body)).toEqual([ABSTRACT, `${ABSTRACT} No stated date.`]);
    expect((await bodies('2026-23997')).map((r) => r.body)).toEqual([ABSTRACT, `${ABSTRACT} No stated date.`]);
    const again: string[] = [];
    await pull(answer, again);
    expect(again.filter((url) => lookedUp(url) !== null)).toEqual([]);
  });

  it('leaves the stored rule unchanged when the lookup fails or answers about another document', async () => {
    await freshProject();
    await insertFeedItems(SOURCE, [storedRule('2026-23230')]);
    await pull((url) => {
      if (lookedUp(url) !== null) throw new Error('HTTP 503');
      return { results: [] };
    }, []);
    await pull((url) => (lookedUp(url) !== null ? { ...official['2026-23230'], document_number: 'other' } : { results: [] }), []);
    expect(await bodies('2026-23230')).toEqual([{ external_id: '2026-23230', body: ABSTRACT }]);
  });

  it('never re-reads a rule this pull parsed: its DATES field was just read by the parser', async () => {
    await freshProject();
    const asked: string[] = [];
    await pull((url) => (lookedUp(url) !== null ? official['2026-23999'] : { results: [row({ document_number: '2026-23998', dates: null })] }), asked);
    expect(asked.filter((url) => lookedUp(url) !== null)).toEqual([]);
    expect((await bodies('2026-23998')).map((r) => r.body)).toEqual([row({})['abstract']]);
  });

  it('shares the per-pull lookup limit with corrections', async () => {
    await freshProject();
    await insertFeedItems(
      SOURCE,
      Array.from({ length: FEDERAL_REGISTER_CORRECTION_LOOKUPS + 5 }, (_, i) => storedRule(`2026-4${String(i).padStart(4, '0')}`)),
    );
    const asked: string[] = [];
    await pull((url) => (lookedUp(url) !== null ? {} : { results: [] }), asked);
    expect(asked.filter((url) => lookedUp(url) !== null)).toHaveLength(FEDERAL_REGISTER_CORRECTION_LOOKUPS);
  });
});
