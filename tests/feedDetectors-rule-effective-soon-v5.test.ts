/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@4 — the recorded failure class, reproduced
 * on v4 and caught by v5 (SHADOW).
 *
 * Fixtures are Federal Register items in the shape the connector stores them
 * (`sources.ts parseFederalRegister`: body = abstract + "Effective YYYY-MM-DD."
 * + "Corrects N."; organization = agencies joined by ", "; a correction is
 * completed with "Corrected rule effective YYYY-MM-DD."; an edit of a record is
 * a new stored copy "<id>#v<n>" with a later fetched_at). The document numbers,
 * titles, agencies and publication days are the recorded misses. v4 dropped or
 * mis-grouped them for one of four reasons, which each fixture isolates:
 *
 *  - a copy of a correction stored without "Corrects N." (C1-2026-21030): v4
 *    saw no corrected rule, though the correction's own number names it;
 *  - (defensive, not a recorded cause) a stored copy with no publishedAt or
 *    one stated with an offset: parseFederalRegister never writes either —
 *    isoOrNull always emits a UTC "Z" timestamp and publication_date is always
 *    present — so these are kept in their own describe block below and v4 is
 *    never said to have missed a production record because of them;
 *  - a rule whose copies list different agencies (Transportation Department
 *    alone, then with the Federal Aviation Administration): v4 split one
 *    document across the parent department and the issuing office;
 *  - a rule effective on its publication day that Brain first stored two or
 *    more days after publication (FCC 2026-23040, Coast Guard 2026-23027, ACF
 *    2026-23279): v4 measured "already in force" from Brain's fetch day, not
 *    the Federal Register's publication day, and dropped it — although the
 *    free screen, reading the same record, kept it.
 *
 * Every v4 bar stays: Coast Guard 2026-23047 (enforced the day before
 * publication, dated only in prose) is a correct exclusion, and so are a rule
 * effective more than eight weeks after publication, one effective before it,
 * and one published outside the 30-day membership window however late Brain
 * stored it.
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V2_LEAD_DAYS,
  RULE_EFFECTIVE_SOON_V3,
  RULE_EFFECTIVE_SOON_V4,
  RULE_EFFECTIVE_SOON_V5,
  correctedDocumentOfNumber,
  federalRegisterPublishedDayOf,
  type DetectedSignal,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import { parseFederalRegister } from '../server/services/feeds/sources.ts';

const DAY = 86_400_000;
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

const NRC = 'Nuclear Regulatory Commission';
const FCC = 'Federal Communications Commission';
const DOT = 'Transportation Department';
const FAA = `${DOT}, Federal Aviation Administration`;
const USCG = 'Homeland Security Department, Coast Guard';
const ACF = 'Health and Human Services Department, Children and Families Administration';
const AP1000 = 'AP1000 Design Certification Renewal';
const SIAP = 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments';

/** The corrected rule, stored when it was published; the correction as stored bare (no correction_of read) and completed. */
const correctedRule = fr('2026-21030', '2026-10-14', NRC, 'Direct final rule. Effective 2026-12-28.', AP1000);
const correctionBare = fr('C1-2026-21030', '2026-11-12', NRC, null, AP1000);
const correctionCompleted = fr(
  'C1-2026-21030', '2026-11-12', NRC, 'Corrects 2026-21030. Corrected rule effective 2026-12-28.', AP1000,
  '2026-11-14T06:00:00.000Z', 'fi_C1-2026-21030#v2',
);
/** FAA: the first copy lists only the parent department; the edit lists the issuing office. */
const faa73 = fr('2026-23073', '2026-11-12', DOT, 'Amends SIAPs. Effective 2026-11-12.', SIAP);
const faa73Edit = fr('2026-23073', '2026-11-12', FAA, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-13T06:00:00.000Z', 'fi_2026-23073#v2');
const lastDay = new Date(Date.parse('2026-11-12T00:00:00.000Z') + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY).toISOString().slice(0, 10);
/**
 * FAA 2026-23072 and FCC 2026-23041, as the connector stores them: effective on
 * their publication day (lead 0, per the API records), publishedAt the UTC
 * timestamp isoOrNull writes, first stored two days after publication — the
 * same recorded cause as FCC 2026-23040.
 */
const faa72 = fr('2026-23072', '2026-11-12', FAA, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-14T06:00:00.000Z');
const fcc41 = fr(
  '2026-23041', '2026-11-12', FCC, 'Amends the Table of Allotments. Effective 2026-11-12.',
  'Television Broadcasting Services; St. George, Utah', '2026-11-14T06:00:00.000Z',
);
/** Effective on publication, first stored by Brain two days later (a pull that ran late): the screen kept each. */
const fcc40 = fr('2026-23040', '2026-11-12', FCC, 'Effective 2026-11-12.', 'National Television Multiple Ownership Rule', '2026-11-14T06:00:00.000Z');
const uscg27 = fr('2026-23027', '2026-11-12', USCG, 'Effective 2026-11-12.', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL', '2026-11-14T06:00:00.000Z');
const acf79 = fr('2026-23279', '2026-11-16', ACF, 'Effective 2026-11-16.', 'Restoring Flexibility To Support Head Start Program Access', '2026-11-18T06:00:00.000Z');

const fleetWeek = fr(
  '2026-23047', '2026-11-12', USCG,
  'The Coast Guard will enforce a special local regulation on November 11, 2026.',
  'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade',
);
const tooFar = fr('2026-23100', '2026-11-12', FCC, `Effective ${new Date(Date.parse(`${lastDay}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10)}.`);
const beforePublication = fr('2026-23101', '2026-11-12', USCG, 'Temporary final rule. Effective 2026-11-10.');

const records = [
  correctedRule, correctionBare, correctionCompleted, faa73, faa73Edit, faa72, fcc41, fcc40, uscg27, acf79,
  fleetWeek, tooFar, beforePublication,
];
/** Each true miss and the agency group it belongs in. */
const expected: [DetectorRecord, string][] = [
  [correctionBare, 'agency:nuclear regulatory commission'],
  [correctionCompleted, 'agency:nuclear regulatory commission'],
  [faa73, 'agency:federal aviation administration'],
  [faa73Edit, 'agency:federal aviation administration'],
  [faa72, 'agency:federal aviation administration'],
  [fcc41, 'agency:federal communications commission'],
  [fcc40, 'agency:federal communications commission'],
  [uscg27, 'agency:coast guard'],
  [acf79, 'agency:children and families administration'],
];

const now = new Date('2026-11-18T12:00:00.000Z');
const members = (signals: DetectedSignal[]) => signals.flatMap((s) => s.memberIds);
const groupOf = (signals: DetectedSignal[], id: string) => signals.find((s) => s.memberIds.includes(id))?.groupKey ?? null;

describe('RULE_EFFECTIVE_SOON@4 misses the recorded items (the failure class)', () => {
  const signals = RULE_EFFECTIVE_SOON_V4.detect(records, now);
  const kept = members(signals);

  it('drops the correction copy stored without "Corrects N."', () => {
    expect(kept).not.toContain(correctionBare.id);
  });

  it('drops a lead-0 rule Brain first stored two days after publication (FCC 2026-23040 and 2026-23041, FAA 2026-23072, USCG 2026-23027, ACF 2026-23279)', () => {
    for (const late of [fcc40, fcc41, faa72, uscg27, acf79]) expect(kept).not.toContain(late.id);
  });

  it('keeps the very same records when Brain stored them on their publication day: the fetch day decided it', () => {
    const onTime = [fcc40, fcc41, faa72, uscg27, acf79].map((one) => ({ ...one, fetchedAt: `${one.publishedAt!.slice(0, 10)}T12:00:00.000Z` }));
    expect(members(RULE_EFFECTIVE_SOON_V4.detect(onTime, now)).sort()).toEqual(onTime.map((one) => one.id).sort());
  });

  it('groups one FAA document under the parent department for one copy and the FAA for the other', () => {
    expect(groupOf(signals, faa73.id)).toBe('agency:transportation department');
    expect(groupOf(signals, faa73Edit.id)).toBe('agency:federal aviation administration');
  });
});

describe('RULE_EFFECTIVE_SOON@5 keeps them, each in its agency group', () => {
  const signals = RULE_EFFECTIVE_SOON_V5.detect(records, now);

  it('keeps every true miss in the issuing agency’s group', () => {
    for (const [record, group] of expected) expect({ id: record.id, group: groupOf(signals, record.id) }).toEqual({ id: record.id, group });
  });

  it('never groups by the parent department', () => {
    expect(signals.map((s) => s.groupKey)).not.toContain('agency:transportation department');
  });

  it('counts one rule per document in the wording', () => {
    const faa = signals.find((s) => s.groupKey === 'agency:federal aviation administration')!;
    expect(faa.memberIds).toHaveLength(3);
    expect(faa.label).toMatch(/^2 final rule\(s\)/);
  });

  it('keeps the bare correction from the corrected rule alone, with no other copy of the correction', () => {
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([correctedRule, correctionBare], now))).toEqual([correctionBare.id]);
    expect(members(RULE_EFFECTIVE_SOON_V4.detect([correctedRule, correctionBare], now))).toEqual([]);
  });

  it('resolves a "Corrects" target that differs from the correction only by the C1- prefix', () => {
    const selfNamed = fr('C1-2026-21030', '2026-11-12', NRC, 'Corrects C1-2026-21030.', AP1000);
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([correctedRule, selfNamed], now))).toEqual([selfNamed.id]);
  });

  it('infers nothing for a correction whose corrected rule is not stored and states no date', () => {
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([correctionBare], now))).toEqual([]);
  });
});

describe('the fixtures are what the connector stores', () => {
  const apiRow = (record: DetectorRecord, effective: string, agencies: { id: number; name: string; parent_id: number | null }[]) => ({
    document_number: record.id.replace(/^fi_/, ''),
    title: record.title,
    html_url: record.url,
    publication_date: federalRegisterPublishedDayOf(record.url),
    effective_on: effective,
    abstract: record.body!.replace(/\s*Effective \d{4}-\d{2}-\d{2}\.$/, ''),
    agencies,
  });
  const dot = { id: 492, name: 'Transportation Department', parent_id: null };
  const faaAgency = { id: 159, name: 'Federal Aviation Administration', parent_id: 492 };
  const fccAgency = { id: 161, name: FCC, parent_id: null };

  it('parseFederalRegister produces each lead-0 fixture exactly: UTC publishedAt, never null, every listed agency', () => {
    for (const [record, agencies] of [
      [faa72, [faaAgency, dot]],
      [faa73Edit, [dot, faaAgency]],
      [fcc41, [fccAgency]],
      [fcc40, [fccAgency]],
    ] as const) {
      const [parsed] = parseFederalRegister({ results: [apiRow(record, '2026-11-12', [...agencies])] });
      expect(parsed).toMatchObject({ url: record.url, title: record.title, body: record.body, organization: record.organization, publishedAt: record.publishedAt });
      expect(parsed!.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
  });
});

describe('defensive: stored shapes the connector does not write (no recorded miss rests on them)', () => {
  it('v5 still reads the day from the URL when publishedAt is missing or carries an offset', () => {
    const offset = fr('2026-23900', '2026-11-12', FAA, `Amends SIAPs. Effective ${lastDay}.`, SIAP, undefined, undefined, '2026-11-12T00:00:00+01:00');
    const missing = fr('2026-23901', '2026-11-12', FCC, 'Effective 2026-11-12.', '2026-23901', '2026-11-13T06:00:00.000Z', undefined, null);
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([offset, missing], now)).sort()).toEqual([offset.id, missing.id].sort());
  });
});

describe('every v4 bar is kept', () => {
  const kept = members(RULE_EFFECTIVE_SOON_V5.detect(records, now));

  it('leaves out Coast Guard 2026-23047 (dated only in prose, enforced before publication)', () => {
    expect(kept).not.toContain(fleetWeek.id);
  });

  it('leaves out a rule effective more than eight weeks after publication', () => {
    expect(kept).not.toContain(tooFar.id);
  });

  it('leaves out a rule effective before its publication', () => {
    expect(kept).not.toContain(beforePublication.id);
  });

  it('leaves out a rule effective before its publication however early Brain stored it', () => {
    const early = { ...beforePublication, id: 'fi_early', fetchedAt: '2026-11-12T00:00:01.000Z' };
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([early], now))).toEqual([]);
  });

  it('leaves out a rule published outside the 30-day window however late Brain stored it', () => {
    const backfilled = fr('2026-20001', '2026-10-17', FCC, 'Effective 2026-11-20.', '2026-20001', '2026-11-18T06:00:00.000Z');
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([backfilled], now))).toEqual([]);
  });

  it('leaves out a rule published outside the 30-day membership window', () => {
    const old = fr('2026-20000', '2026-10-01', FCC, 'Effective 2026-10-01.');
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([old], now))).toEqual([]);
  });
});

describe('the verdict is a property of the record, not of when Brain fetched it', () => {
  it('keeps or drops each record identically whatever day inside the window Brain first stored it', () => {
    const subjects = [fcc40, uscg27, acf79, fcc41, faa72, tooFar, beforePublication, fleetWeek];
    const baseline = members(RULE_EFFECTIVE_SOON_V5.detect(subjects, now)).sort();
    for (const lagDays of [0, 1, 2, 5]) {
      const shifted = subjects.map((one) => ({
        ...one,
        fetchedAt: new Date(Math.min(now.getTime(), Date.parse(federalRegisterPublishedDayOf(one.url)!) + lagDays * DAY + 6 * 3_600_000)).toISOString(),
      }));
      expect({ lagDays, kept: members(RULE_EFFECTIVE_SOON_V5.detect(shifted, now)).sort() }).toEqual({ lagDays, kept: baseline });
    }
    expect(baseline).toEqual([fcc40, uscg27, acf79, fcc41, faa72].map((one) => one.id).sort());
  });
});

describe('helpers', () => {
  it('reads the publication day from the document URL', () => {
    expect(federalRegisterPublishedDayOf(fcc41.url)).toBe('2026-11-12');
    expect(federalRegisterPublishedDayOf('https://www.federalregister.gov/d/2026-23041')).toBeNull();
  });

  it('reads the corrected document from a correction number', () => {
    expect(correctedDocumentOfNumber('C1-2026-21030')).toBe('2026-21030');
    expect(correctedDocumentOfNumber('C2-2026-21030')).toBe('2026-21030');
    expect(correctedDocumentOfNumber('2026-21030')).toBeNull();
  });
});

describe('installation', () => {
  it('v5 stays exported in SHADOW (v6 is installed in its place); v1..v4 stay exported unchanged', () => {
    expect(RULE_EFFECTIVE_SOON_V5).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 5, mode: 'SHADOW' });
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON_V5);
    for (const old of [RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4]) expect(DETECTORS).not.toContain(old);
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
    expect(RULE_EFFECTIVE_SOON_V4).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 4, mode: 'SHADOW' });
    expect([RULE_EFFECTIVE_SOON.version, RULE_EFFECTIVE_SOON_V2.version, RULE_EFFECTIVE_SOON_V3.version]).toEqual([1, 2, 3]);
  });

  it('reads the same sources, lookback, membership window and entity keys as v4', () => {
    expect(RULE_EFFECTIVE_SOON_V5.sources).toEqual(RULE_EFFECTIVE_SOON_V4.sources);
    expect(RULE_EFFECTIVE_SOON_V5.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V4.lookbackMs);
    expect(RULE_EFFECTIVE_SOON_V5.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V4.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V5.entityKeyOf!(FAA)).toBe(RULE_EFFECTIVE_SOON_V4.entityKeyOf!(FAA));
  });
});
