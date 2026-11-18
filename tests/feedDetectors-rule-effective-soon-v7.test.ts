/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@6 — the recorded failure class, reproduced
 * on v6 and caught by v7 (SHADOW), with the connector change that completes a
 * bare stored correction.
 *
 * Fixtures are Federal Register items in the shapes the connector stores
 * (`sources.ts parseFederalRegister`, then `completeFederalRegisterCorrections`):
 * body = abstract + "Effective YYYY-MM-DD." (effective_on) + "Corrects N."
 * (correction_of) + "Stated effective YYYY-MM-DD." (the official DATES field,
 * only when effective_on is null and the record is not a correction) +
 * "Corrected rule effective YYYY-MM-DD." (the corrected rule's effective_on,
 * looked up by the connector). An edit is a new stored copy "<id>#v<n>".
 *
 * The recorded misses (2026-23040, 2026-23027, 2026-23279, 2026-23230,
 * 2026-23041, 2026-23073, 2026-23072, C1-2026-21030) are all built here. What
 * v6 still drops, and why (asserted below):
 *
 *  - a correction of a rule whose effective_on is null: the rule's own copy
 *    carries only "Stated effective", which v6 reads for the rule but never
 *    for its correction. Modelled on NRC C1-2026-21030's established shape
 *    (type Rule; effective_on, dates and action null; correction_of
 *    2026-21030) correcting a rule dated only in DATES; the corrected rule's
 *    DATES text is illustrative, not read from the API.
 *  - C1-2026-21030 stored bare (no "Corrects" sentence) while the corrected
 *    rule's copy is not among the records: no copy states any date. The
 *    connector never completed it, because it found a target only in the
 *    body; it now reads the target from the "C<n>-" number too.
 *
 * Every bar stays: Coast Guard 2026-23047 (enforced 2026-11-11, published
 * 2026-11-12) is excluded by v6 and v7 alike.
 *
 * Coast Guard 2026-23230 is a recorded miss, but no record Brain holds states
 * its DATES text, so no fixture here claims one. What is recorded (its number,
 * title, publication day and agency) is used as recorded, and the test asserts
 * only what holds whatever date production states: v7 keeps it exactly when
 * that date falls in the rule's window, under the Coast Guard. The kept
 * notification of enforcement among the misses is a synthetic number
 * (2026-92000) in 2026-23047's established shape, claiming no production date.
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V3,
  RULE_EFFECTIVE_SOON_V4,
  RULE_EFFECTIVE_SOON_V5,
  RULE_EFFECTIVE_SOON_V6,
  RULE_EFFECTIVE_SOON_V7,
  type DetectedSignal,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import {
  completeFederalRegisterCorrections,
  federalRegisterCorrectionIncomplete,
  federalRegisterCorrectionTarget,
  federalRegisterItemIncomplete,
  parseFederalRegister,
  type FeedItem,
} from '../server/services/feeds/sources.ts';

const FR = 'https://www.federalregister.gov/documents';

function fr(
  documentNumber: string,
  published: string,
  organization: string,
  body: string | null,
  title = documentNumber,
  fetched = `${published}T06:00:00.000Z`,
  id = `fi_${documentNumber}`,
  publishedAt: string | null = `${published}T00:00:00.000Z`,
): DetectorRecord {
  const [y, m, d] = published.split('-');
  return {
    id,
    source: 'federal-register-rules',
    url: `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    organization,
    publishedAt,
    fetchedAt: fetched,
    body,
  };
}

const toRecord = (item: FeedItem, fetched: string, id = `fi_${item.externalId}`): DetectorRecord => ({
  id, source: 'federal-register-rules', url: item.url, title: item.title, organization: item.organization, publishedAt: item.publishedAt, fetchedAt: fetched, body: item.body,
});

function stored(row: Record<string, unknown>, fetched: string, id?: string): DetectorRecord {
  const [item] = parseFederalRegister({ results: [row] });
  if (!item) throw new Error('row not parsed');
  return toRecord(item, fetched, id);
}

const DHS = { id: 227, name: 'Homeland Security Department', parent_id: null };
const USCG_AGENCY = { id: 85, name: 'Coast Guard', parent_id: 227 };
const FCC_AGENCY = { id: 161, name: 'Federal Communications Commission', parent_id: null };
const HHS = { id: 221, name: 'Health and Human Services Department', parent_id: null };
const ACF_AGENCY = { id: 45, name: 'Children and Families Administration', parent_id: 221 };
const DOT_AGENCY = { id: 492, name: 'Transportation Department', parent_id: null };
const FAA_AGENCY = { id: 159, name: 'Federal Aviation Administration', parent_id: 492 };
const NRC_AGENCY = { id: 383, name: 'Nuclear Regulatory Commission', parent_id: null };

const apiRow = (documentNumber: string, published: string, title: string, agencies: unknown[], over: Record<string, unknown> = {}) => {
  const [y, m, d] = published.split('-');
  return {
    document_number: documentNumber,
    title,
    html_url: `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    publication_date: published,
    effective_on: null,
    abstract: null,
    agencies,
    action: 'Final rule.',
    correction_of: null,
    dates: null,
    ...over,
  };
};

const NRC = 'Nuclear Regulatory Commission';
const DOT = 'Transportation Department';
const AP1000 = 'AP1000 Design Certification Renewal';
const SIAP = 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments';
const late = (published: string, days = 2) => new Date(Date.parse(`${published}T06:00:00.000Z`) + days * 86_400_000).toISOString();

// --- The recorded misses, in the shapes the connector stores. ---

const fcc40 = stored(apiRow('2026-23040', '2026-11-12', 'National Television Multiple Ownership Rule', [FCC_AGENCY], { effective_on: '2026-11-12' }), late('2026-11-12'));
const uscg27 = stored(
  apiRow('2026-23027', '2026-11-12', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL', [DHS, USCG_AGENCY], { effective_on: '2026-11-12', action: 'Temporary final rule.' }),
  late('2026-11-12'),
);
const acf79 = stored(
  apiRow('2026-23279', '2026-11-16', 'Restoring Flexibility To Support Head Start Program Access', [HHS, ACF_AGENCY], { effective_on: '2026-11-16' }),
  late('2026-11-16'),
);
/**
 * Coast Guard 2026-23230 as recorded: number, title, publication day and agency.
 * Its DATES text is not in any record, so it is a parameter: `miami(dates)`
 * builds the row for whatever DATES text production holds.
 */
const MIAMI_TITLE = 'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade';
const miami = (dates: string) => stored(
  apiRow('2026-23230', '2026-11-16', MIAMI_TITLE, [DHS, USCG_AGENCY], { action: 'Notification of enforcement of regulation.', dates }),
  late('2026-11-16'),
);
/**
 * A notification of enforcement in 2026-23047's established shape (effective_on
 * null, date only in DATES), enforced after its publication (synthetic number
 * 2026-92000: no production shape or date claimed).
 */
const enforcement = stored(
  apiRow('2026-92000', '2026-11-16', 'Synthetic Coast Guard notification of enforcement', [DHS, USCG_AGENCY], {
    action: 'Notification of enforcement of regulation.',
    dates: 'The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.',
  }),
  late('2026-11-16'),
);
const fcc41 = stored(
  apiRow('2026-23041', '2026-11-12', 'Television Broadcasting Services; St. George, Utah', [FCC_AGENCY], { effective_on: '2026-11-12' }),
  late('2026-11-12'),
);
const faa73 = stored(apiRow('2026-23073', '2026-11-12', SIAP, [DOT_AGENCY, FAA_AGENCY], { effective_on: '2026-11-12' }), late('2026-11-12'));
const faa72 = stored(apiRow('2026-23072', '2026-11-12', SIAP, [DOT_AGENCY, FAA_AGENCY], { effective_on: '2026-11-12' }), late('2026-11-12'));
/** A copy of 2026-23072 that lists only the parent department and no date: still the FAA's. */
const faa72ParentOnly = fr('2026-23072', '2026-11-12', DOT, null, SIAP, late('2026-11-12', 3), 'fi_2026-23072#v2', null);

/** NRC C1-2026-21030, stored bare (effective_on, dates, action and correction_of all null), with no copy of 2026-21030 among the records. */
const ap1000Row = apiRow('C1-2026-21030', '2026-11-12', AP1000, [NRC_AGENCY], { action: null });
const ap1000Bare = stored(ap1000Row, '2026-11-12T06:00:00.000Z');

/**
 * A correction of a rule whose effective_on is null and whose date is only in
 * its DATES field (synthetic numbers 2026-9xxxx: no production shape claimed).
 */
const datesOnlyRule = stored(
  apiRow('2026-91000', '2026-11-02', 'Synthetic NRC rule dated only in DATES', [NRC_AGENCY], { dates: 'This rule is effective December 2, 2026.' }),
  '2026-11-02T06:00:00.000Z',
);
const correctionOfDatesOnly = stored(
  apiRow('C1-2026-91000', '2026-11-12', 'Synthetic NRC rule dated only in DATES', [NRC_AGENCY], { action: null, correction_of: { document_number: '2026-91000' } }),
  '2026-11-12T06:00:00.000Z',
);

// --- Correct exclusion: Coast Guard 2026-23047, enforced 2026-11-11, published 2026-11-12. ---
const fleetWeek = stored(
  apiRow(
    '2026-23047', '2026-11-12',
    'Special Local Regulation; Southern California Annual Marine Events for the San Diego Captain of the Port Zone, San Diego Fleet Week Veterans Day Boat Parade, San Diego Bay, San Diego, CA',
    [DHS, USCG_AGENCY],
    { action: 'Notification of enforcement of regulation.', dates: 'The regulations in 33 CFR 100.1101 will be enforced from 9 a.m. to 11 a.m. on November 11, 2026.' },
  ),
  '2026-11-12T06:00:00.000Z',
);

const now = new Date('2026-11-18T12:00:00.000Z');
const members = (signals: DetectedSignal[]) => signals.flatMap((s) => s.memberIds);
const groupOf = (signals: DetectedSignal[], id: string) => signals.find((s) => s.memberIds.includes(id))?.groupKey ?? null;

/** The connector's completion of the bare correction, as a pull runs it over stored items: the corrected rule's own effective_on. */
async function completedAp1000(): Promise<DetectorRecord> {
  const [item] = parseFederalRegister({ results: [ap1000Row] });
  const [done] = await completeFederalRegisterCorrections([item!], async (url) => {
    expect(url).toContain('/documents/2026-21030.json');
    return { document_number: '2026-21030', effective_on: '2026-12-28' };
  }, 25, 0);
  return toRecord(done!, '2026-11-18T06:00:00.000Z', 'fi_C1-2026-21030#v2');
}

describe('the fixtures are what the connector stores', () => {
  it('C1-2026-21030 stored bare carries no body; the correction of a DATES-only rule says only what it corrects', () => {
    expect(ap1000Bare.body).toBeNull();
    expect(datesOnlyRule.body).toBe('Stated effective 2026-12-02.');
    expect(correctionOfDatesOnly.body).toBe('Corrects 2026-91000.');
    expect(fleetWeek.body).toBe('Stated effective 2026-11-11.');
    expect(faa73.organization).toBe('Transportation Department, Federal Aviation Administration');
  });
});

describe('the connector completes a bare stored correction from its own number', () => {
  it('names the target from "Corrects N." or, failing that, the "C<n>-" number', () => {
    expect(federalRegisterCorrectionTarget({ body: 'Corrects 2026-21030.', externalId: 'C1-2026-21030' })).toBe('2026-21030');
    expect(federalRegisterCorrectionTarget({ body: null, externalId: 'C1-2026-21030' })).toBe('2026-21030');
    expect(federalRegisterCorrectionTarget({ body: null, externalId: '2026-21030' })).toBeNull();
    expect(federalRegisterCorrectionTarget({ body: null })).toBeNull();
  });

  it('treats the bare copy as incomplete, and a completed one as complete', () => {
    const [item] = parseFederalRegister({ results: [ap1000Row] });
    expect(federalRegisterCorrectionIncomplete(item!)).toBe(true);
    expect(federalRegisterItemIncomplete(item!)).toBe(true);
    expect(federalRegisterCorrectionIncomplete({ ...item!, body: 'Corrected rule effective 2026-12-28.' })).toBe(false);
  });

  it('writes the corrected rule’s effective_on as "Corrected rule effective"', async () => {
    expect((await completedAp1000()).body).toBe('Corrected rule effective 2026-12-28.');
  });

  it('a failed lookup leaves it exactly as stored', async () => {
    const [item] = parseFederalRegister({ results: [ap1000Row] });
    expect(await completeFederalRegisterCorrections([item!], async () => { throw new Error('HTTP 503'); }, 25, 0)).toEqual([item]);
  });
});

describe('RULE_EFFECTIVE_SOON@6 misses the recorded class; @7 keeps every true miss', async () => {
  const ap1000Completed = await completedAp1000();
  const records = [fcc40, uscg27, acf79, enforcement, fcc41, faa73, faa72, faa72ParentOnly, ap1000Bare, ap1000Completed, datesOnlyRule, correctionOfDatesOnly, fleetWeek];
  const expected: [DetectorRecord, string][] = [
    [fcc40, 'agency:federal communications commission'],
    [uscg27, 'agency:coast guard'],
    [acf79, 'agency:children and families administration'],
    [enforcement, 'agency:coast guard'],
    [fcc41, 'agency:federal communications commission'],
    [faa73, 'agency:federal aviation administration'],
    [faa72, 'agency:federal aviation administration'],
    [faa72ParentOnly, 'agency:federal aviation administration'],
    [ap1000Bare, 'agency:nuclear regulatory commission'],
    [ap1000Completed, 'agency:nuclear regulatory commission'],
    [correctionOfDatesOnly, 'agency:nuclear regulatory commission'],
  ];

  it('v6 drops a correction of a rule dated only in DATES', () => {
    const kept = members(RULE_EFFECTIVE_SOON_V6.detect(records, now));
    expect(kept).not.toContain(correctionOfDatesOnly.id);
    expect(kept).toContain(datesOnlyRule.id);
  });

  it('v6 (and v7) drop C1-2026-21030 stored bare when nothing completed it and its rule is not held', () => {
    expect(members(RULE_EFFECTIVE_SOON_V6.detect([ap1000Bare], now))).toEqual([]);
    expect(members(RULE_EFFECTIVE_SOON_V7.detect([ap1000Bare], now))).toEqual([]);
  });

  it('v7 keeps every true miss, each under its issuing agency', () => {
    const signals = RULE_EFFECTIVE_SOON_V7.detect(records, now);
    for (const [record, group] of expected) expect({ id: record.id, group: groupOf(signals, record.id) }).toEqual({ id: record.id, group });
    const keys = signals.map((s) => s.groupKey);
    expect(keys).not.toContain('agency:transportation department');
    expect(keys).not.toContain('agency:homeland security department');
    expect(keys).not.toContain('agency:health and human services department');
  });

  it('v7 dates the correction by the corrected rule, against its own publication day', () => {
    const nrc = RULE_EFFECTIVE_SOON_V7.detect([datesOnlyRule, correctionOfDatesOnly], now)[0]!;
    expect(nrc.memberIds.sort()).toEqual([datesOnlyRule.id, correctionOfDatesOnly.id].sort());
    expect(nrc.windowFrom).toBe('2026-12-02T00:00:00.000Z');
    expect(nrc.qualifiers.some((one) => /correction of a rule with no effective_on/.test(one))).toBe(true);
  });

  it('v7 keeps everything v6 keeps', () => {
    const v6 = members(RULE_EFFECTIVE_SOON_V6.detect(records, now));
    const v7 = members(RULE_EFFECTIVE_SOON_V7.detect(records, now));
    for (const id of v6) expect(v7).toContain(id);
    expect(v7.sort()).toEqual([...v6, correctionOfDatesOnly.id].sort());
  });

  it('2026-23047 (enforced the day before publication) stays excluded by v6 and v7', () => {
    expect(members(RULE_EFFECTIVE_SOON_V6.detect(records, now))).not.toContain(fleetWeek.id);
    expect(members(RULE_EFFECTIVE_SOON_V7.detect(records, now))).not.toContain(fleetWeek.id);
  });
});

describe('Coast Guard 2026-23230: decided by whatever date its DATES text states, never by a date assumed here', () => {
  const on = (day: string) => `The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on ${day}.`;
  const cases: [string, string, boolean][] = [
    ['before publication', 'November 15, 2026', false],
    ['on the publication day', 'November 16, 2026', true],
    ['four weeks after', 'December 14, 2026', true],
    ['eight weeks after', 'January 11, 2027', true],
    ['more than eight weeks after', 'January 20, 2027', false],
  ];
  for (const [label, day, kept] of cases) {
    it(`a date ${label} is ${kept ? 'kept under the Coast Guard' : 'not kept'} by v7, as by v6`, () => {
      const record = miami(on(day));
      const v7 = RULE_EFFECTIVE_SOON_V7.detect([record], now);
      expect(members(v7).includes(record.id)).toBe(kept);
      expect(members(RULE_EFFECTIVE_SOON_V6.detect([record], now)).includes(record.id)).toBe(kept);
      if (kept) expect(groupOf(v7, record.id)).toBe('agency:coast guard');
    });
  }

  it('with no DATES text it states no date, and is not kept', () => {
    const record = miami('');
    expect(record.body ?? '').not.toMatch(/Stated effective/);
    expect(members(RULE_EFFECTIVE_SOON_V7.detect([record], now))).toEqual([]);
  });
});

describe('every bar is kept', () => {
  it('never reads a correction’s own "Stated effective" marker in place of the corrected rule’s date', () => {
    const odd = fr('C1-2026-93000', '2026-11-12', NRC, 'Corrects 2026-93000. Stated effective 2026-11-20.', 'odd');
    expect(members(RULE_EFFECTIVE_SOON_V7.detect([odd], now))).toEqual([]);
  });

  it('a corrected rule’s stated date before the correction’s publication, or more than eight weeks after it, is not kept', () => {
    const early = fr('2026-94000', '2026-10-20', NRC, 'Stated effective 2026-11-01.');
    const earlyFix = fr('C1-2026-94000', '2026-11-12', NRC, 'Corrects 2026-94000.');
    const far = fr('2026-95000', '2026-11-10', NRC, 'Stated effective 2027-02-01.');
    const farFix = fr('C1-2026-95000', '2026-11-12', NRC, 'Corrects 2026-95000.');
    const kept = members(RULE_EFFECTIVE_SOON_V7.detect([early, earlyFix, far, farFix], now));
    expect(kept).not.toContain(earlyFix.id);
    expect(kept).not.toContain(farFix.id);
    expect(kept).not.toContain(far.id);
  });

  it('a correction published outside the 30-day membership window is not kept', () => {
    const rule = fr('2026-96000', '2026-09-01', NRC, 'Stated effective 2026-10-15.');
    const fix = fr('C1-2026-96000', '2026-10-01', NRC, 'Corrects 2026-96000.', 'fix', '2026-11-17T06:00:00.000Z');
    expect(members(RULE_EFFECTIVE_SOON_V7.detect([rule, fix], now))).toEqual([]);
  });
});

describe('installation', () => {
  it('v7 is installed in SHADOW in place of v6; v1..v6 stay exported unchanged', () => {
    expect(RULE_EFFECTIVE_SOON_V7).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 7, mode: 'SHADOW' });
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V7);
    const old = [RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4, RULE_EFFECTIVE_SOON_V5, RULE_EFFECTIVE_SOON_V6];
    for (const one of old) expect(DETECTORS).not.toContain(one);
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
    expect(old.map((one) => [one.version, one.mode])).toEqual([[1, 'SHADOW'], [2, 'SHADOW'], [3, 'SHADOW'], [4, 'SHADOW'], [5, 'SHADOW'], [6, 'SHADOW']]);
  });

  it('reads the same sources, lookback, membership window and entity keys as v6', () => {
    expect(RULE_EFFECTIVE_SOON_V7.sources).toEqual(RULE_EFFECTIVE_SOON_V6.sources);
    expect(RULE_EFFECTIVE_SOON_V7.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V6.lookbackMs);
    expect(RULE_EFFECTIVE_SOON_V7.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V6.memberWindowMs);
    const faa = 'Transportation Department, Federal Aviation Administration';
    expect(RULE_EFFECTIVE_SOON_V7.entityKeyOf!(faa)).toBe(RULE_EFFECTIVE_SOON_V6.entityKeyOf!(faa));
  });
});
