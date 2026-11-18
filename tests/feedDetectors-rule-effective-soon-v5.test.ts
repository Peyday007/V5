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
 * mis-grouped them for one of three reasons, which each fixture isolates:
 *
 *  - a copy of a correction stored without "Corrects N." (C1-2026-21030): v4
 *    saw no corrected rule, though the correction's own number names it;
 *  - a rule effective on its publication day whose stored copy carries no
 *    publishedAt, or one with an offset, so v4 measured from the wrong day;
 *  - a rule whose copies list different agencies (Transportation Department
 *    alone, then with the Federal Aviation Administration): v4 split one
 *    document across the parent department and the issuing office.
 *
 * Every v4 bar stays: Coast Guard 2026-23047 (enforced the day before
 * publication, dated only in prose) is a correct exclusion, and so are a rule
 * effective more than eight weeks after publication, one effective before it,
 * and a late backfill already in force when Brain first held it.
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
/** FAA: publication date stated with an offset east of UTC; effective on the last day of the eight-week bound. */
const lastDay = new Date(Date.parse('2026-11-12T00:00:00.000Z') + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY).toISOString().slice(0, 10);
const faa72 = fr('2026-23072', '2026-11-12', FAA, `Amends SIAPs. Effective ${lastDay}.`, SIAP, undefined, undefined, '2026-11-12T00:00:00+01:00');
/** FCC: effective on its publication day, stored the next day with no publishedAt. */
const fcc41 = fr(
  '2026-23041', '2026-11-12', FCC, 'Amends the Table of Allotments. Effective 2026-11-12.',
  'Television Broadcasting Services; St. George, Utah', '2026-11-13T06:00:00.000Z', undefined, null,
);
const fcc40 = fr('2026-23040', '2026-11-12', FCC, 'Effective 2026-11-12.', 'National Television Multiple Ownership Rule');
const uscg27 = fr('2026-23027', '2026-11-12', USCG, 'Effective 2026-11-12.', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL');
const acf79 = fr('2026-23279', '2026-11-16', ACF, 'Effective 2026-11-16.', 'Restoring Flexibility To Support Head Start Program Access');

const fleetWeek = fr(
  '2026-23047', '2026-11-12', USCG,
  'The Coast Guard will enforce a special local regulation on November 11, 2026.',
  'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade',
);
const tooFar = fr('2026-23100', '2026-11-12', FCC, `Effective ${new Date(Date.parse(`${lastDay}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10)}.`);
const beforePublication = fr('2026-23101', '2026-11-12', USCG, 'Temporary final rule. Effective 2026-11-10.');
const lateBackfill = fr('2026-23102', '2026-11-12', FCC, 'Effective 2026-11-12.', '2026-23102', '2026-11-16T06:00:00.000Z');

const records = [
  correctedRule, correctionBare, correctionCompleted, faa73, faa73Edit, faa72, fcc41, fcc40, uscg27, acf79,
  fleetWeek, tooFar, beforePublication, lateBackfill,
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

  it('drops a lead-0 rule stored the next day without a publishedAt', () => {
    expect(kept).not.toContain(fcc41.id);
  });

  it('drops a rule effective on the last day of the bound when publishedAt carries an offset', () => {
    expect(kept).not.toContain(faa72.id);
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

  it('leaves out a late backfill already in force when Brain first held it', () => {
    expect(kept).not.toContain(lateBackfill.id);
  });

  it('leaves out a rule published outside the 30-day membership window', () => {
    const old = fr('2026-20000', '2026-10-01', FCC, 'Effective 2026-10-01.');
    expect(members(RULE_EFFECTIVE_SOON_V5.detect([old], now))).toEqual([]);
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
  it('v5 is installed in SHADOW in place of v4; v1..v4 stay exported unchanged', () => {
    expect(RULE_EFFECTIVE_SOON_V5).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 5, mode: 'SHADOW' });
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V5);
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
