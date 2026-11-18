/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@5 — the recorded failure class, reproduced
 * on v5 and caught by v6 (SHADOW).
 *
 * Fixtures are Federal Register items in the shapes the connector stores
 * (`sources.ts parseFederalRegister`): body = abstract + "Effective
 * YYYY-MM-DD." (effective_on) + "Corrects N." (correction_of) + "Stated
 * effective YYYY-MM-DD." (the official DATES field, written only when
 * effective_on is null and the record is not a correction, since 41d72ad);
 * organization = agencies joined by ", "; an edit is a new stored copy
 * "<id>#v<n>" with a later fetched_at. Where the shape is the connector's own
 * output, the fixture is produced by parseFederalRegister from an API row.
 *
 * What v5 drops, and why (asserted below):
 *
 *  - every record whose only date is the "Stated effective" marker, because
 *    v5 reads only "Effective" and so finds no date. The shape is the one the
 *    accepted research establishes for Coast Guard 2026-23047 (action
 *    "Notification of enforcement of regulation", effective_on null, the date
 *    only in DATES). Coast Guard 2026-23230 (Miami Winterfest), a recorded miss
 *    of the same kind of document, is modelled on that shape; its DATES text
 *    is illustrative, not read from the API. The other stated-date fixtures
 *    carry synthetic document numbers (2026-9xxxx) so that no test claims a
 *    production shape the record does not state. That holds however the
 *    copies are shaped: a bare copy with no body, publishedAt missing, a copy
 *    fetched days late, or one listing only the parent department.
 *
 * FCC 2026-23040, Coast Guard 2026-23027 and ACF 2026-23279 are recorded
 * misses whose stored shape no evidence in this objective establishes; the
 * earlier record (RULE_EFFECTIVE_SOON@4) states them as "Effective <publication
 * day>." stored late. They are asserted separately below in BOTH shapes —
 * effective_on set, and effective_on null with a DATES date — and v6 must keep
 * each in either, so the verdict does not depend on which one production holds.
 *
 * What v5 already keeps and v6 must keep identically (no regression): FAA
 * 2026-23073 and 2026-23072 (lead 0; a copy listing only Transportation
 * Department groups under the Federal Aviation Administration), FCC 2026-23041
 * (lead 0), and NRC C1-2026-21030 (a correction, bare and completed copies).
 *
 * Every v5 bar stays: Coast Guard 2026-23047 — "Stated effective 2026-11-11.",
 * the day before its 2026-11-12 publication — is a correct exclusion, and so is
 * a stated date more than eight weeks after publication, and a record published
 * outside the 30-day membership window.
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
  RULE_EFFECTIVE_SOON_V6,
  statedEffectiveDateOf,
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

/** A record exactly as parseFederalRegister stores an API row, with the feed item's id and fetch time. */
function stored(row: Record<string, unknown>, fetched: string, id = `fi_${String(row['document_number'])}`): DetectorRecord {
  const [item] = parseFederalRegister({ results: [row] });
  if (!item) throw new Error('row not parsed');
  return { id, source: 'federal-register-rules', url: item.url, title: item.title, organization: item.organization, publishedAt: item.publishedAt, fetchedAt: fetched, body: item.body };
}

const DHS = { id: 227, name: 'Homeland Security Department', parent_id: null };
const USCG_AGENCY = { id: 85, name: 'Coast Guard', parent_id: 227 };
const FCC_AGENCY = { id: 161, name: 'Federal Communications Commission', parent_id: null };
const HHS = { id: 221, name: 'Health and Human Services Department', parent_id: null };
const ACF_AGENCY = { id: 45, name: 'Children and Families Administration', parent_id: 221 };

const apiRow = (documentNumber: string, published: string, title: string, agencies: unknown[], dates: string, over: Record<string, unknown> = {}) => {
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
    dates,
    ...over,
  };
};

const NRC = 'Nuclear Regulatory Commission';
const FCC = 'Federal Communications Commission';
const DOT = 'Transportation Department';
const FAA = `${DOT}, Federal Aviation Administration`;
const USCG = 'Homeland Security Department, Coast Guard';
const AP1000 = 'AP1000 Design Certification Renewal';
const SIAP = 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments';

// --- The records v5 misses: their only date is the connector's "Stated effective" marker. ---

/** Coast Guard 2026-23230: a notification of enforcement in 2026-23047's established shape (effective_on null, date only in DATES); the DATES text is illustrative; stored two days late. */
const miami = stored(
  apiRow(
    '2026-23230', '2026-11-16',
    'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade',
    [DHS, USCG_AGENCY],
    'The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.',
    { action: 'Notification of enforcement of regulation.', abstract: 'The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.' },
  ),
  '2026-11-18T06:00:00.000Z',
);
/** Synthetic: an FCC final rule with effective_on null, stated on publication day; first stored two days late. */
const fcc40 = stored(
  apiRow('2026-90040', '2026-11-12', 'Synthetic FCC rule dated only in DATES', [FCC_AGENCY], 'This rule is effective November 12, 2026.'),
  '2026-11-14T06:00:00.000Z',
);
/** Synthetic: a Coast Guard temporary safety zone with effective_on null, stated on publication day. */
const uscg27 = stored(
  apiRow('2026-90027', '2026-11-12', 'Synthetic Coast Guard safety zone dated only in DATES', [DHS, USCG_AGENCY], 'This rule is effective without actual notice from November 12, 2026.', { action: 'Temporary final rule.' }),
  '2026-11-14T06:00:00.000Z',
);
/** Synthetic: an ACF final rule with effective_on null, stated on publication day; stored two days late. */
const acf79 = stored(
  apiRow('2026-90279', '2026-11-16', 'Synthetic ACF rule dated only in DATES', [HHS, ACF_AGENCY], 'This final rule is effective November 16, 2026.'),
  '2026-11-18T06:00:00.000Z',
);
/** The same synthetic ACF rule again: a bare earlier copy (no body) with publishedAt missing, listing the parent department only. */
const acf79Bare = fr(
  '2026-90279', '2026-11-16', 'Health and Human Services Department', null,
  'Synthetic ACF rule dated only in DATES', '2026-11-17T06:00:00.000Z', 'fi_2026-90279#v0', null,
);

// --- The records v5 already keeps (lead 0, corrections, parent-only copies): v6 must keep them identically. ---

const correctedRule = fr('2026-21030', '2026-10-14', NRC, 'Direct final rule. Effective 2026-12-28.', AP1000);
const correctionBare = fr('C1-2026-21030', '2026-11-12', NRC, null, AP1000);
const correctionCompleted = fr(
  'C1-2026-21030', '2026-11-12', NRC, 'Corrects 2026-21030. Corrected rule effective 2026-12-28.', AP1000,
  '2026-11-14T06:00:00.000Z', 'fi_C1-2026-21030#v2',
);
const faa73 = fr('2026-23073', '2026-11-12', DOT, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-15T06:00:00.000Z', 'fi_2026-23073', null);
const faa73Edit = fr('2026-23073', '2026-11-12', FAA, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-16T06:00:00.000Z', 'fi_2026-23073#v2');
const faa72 = fr('2026-23072', '2026-11-12', FAA, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-14T06:00:00.000Z');
const faa72ParentOnly = fr('2026-23072', '2026-11-12', DOT, null, SIAP, '2026-11-15T06:00:00.000Z', 'fi_2026-23072#v2', null);
const fcc41 = fr(
  '2026-23041', '2026-11-12', FCC, 'Amends the Table of Allotments. Effective 2026-11-12.',
  'Television Broadcasting Services; St. George, Utah', '2026-11-14T06:00:00.000Z',
);

// --- Correct exclusions. ---

/** Coast Guard 2026-23047: enforced 2026-11-11, published 2026-11-12. */
const fleetWeek = stored(
  apiRow(
    '2026-23047', '2026-11-12',
    'Special Local Regulation; Southern California Annual Marine Events for the San Diego Captain of the Port Zone, San Diego Fleet Week Veterans Day Boat Parade, San Diego Bay, San Diego, CA',
    [DHS, USCG_AGENCY],
    'The regulations in 33 CFR 100.1101 will be enforced from 9 a.m. to 11 a.m. on November 11, 2026.',
    { action: 'Notification of enforcement of regulation.' },
  ),
  '2026-11-12T06:00:00.000Z',
);
const lastDay = new Date(Date.parse('2026-11-12T00:00:00.000Z') + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY).toISOString().slice(0, 10);
const statedTooFar = fr('2026-23102', '2026-11-12', FCC, `Stated effective ${new Date(Date.parse(`${lastDay}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10)}.`);
const statedOld = fr('2026-20002', '2026-10-01', FCC, 'Stated effective 2026-10-20.', '2026-20002', '2026-11-17T06:00:00.000Z');

const statedMisses = [miami, fcc40, uscg27, acf79, acf79Bare];
const alreadyKept = [correctionBare, correctionCompleted, faa73, faa73Edit, faa72, faa72ParentOnly, fcc41];
const records = [...statedMisses, correctedRule, ...alreadyKept, fleetWeek, statedTooFar, statedOld];

/** Each true miss and the agency group it belongs in. */
const expected: [DetectorRecord, string][] = [
  [miami, 'agency:coast guard'],
  [fcc40, 'agency:federal communications commission'],
  [uscg27, 'agency:coast guard'],
  [acf79, 'agency:children and families administration'],
  [acf79Bare, 'agency:children and families administration'],
  [correctionBare, 'agency:nuclear regulatory commission'],
  [correctionCompleted, 'agency:nuclear regulatory commission'],
  [faa73, 'agency:federal aviation administration'],
  [faa73Edit, 'agency:federal aviation administration'],
  [faa72, 'agency:federal aviation administration'],
  [faa72ParentOnly, 'agency:federal aviation administration'],
  [fcc41, 'agency:federal communications commission'],
];

const now = new Date('2026-11-18T12:00:00.000Z');
const members = (signals: DetectedSignal[]) => signals.flatMap((s) => s.memberIds);
const groupOf = (signals: DetectedSignal[], id: string) => signals.find((s) => s.memberIds.includes(id))?.groupKey ?? null;

describe('the fixtures are what the connector stores', () => {
  it('a record with effective_on null carries only the "Stated effective" marker, never an "Effective" sentence', () => {
    expect(miami.body).toContain('Stated effective 2026-12-13.');
    expect(fcc40.body).toBe('Stated effective 2026-11-12.');
    expect(uscg27.body).toBe('Stated effective 2026-11-12.');
    expect(acf79.body).toBe('Stated effective 2026-11-16.');
    expect(fleetWeek.body).toBe('Stated effective 2026-11-11.');
    for (const one of [miami, fcc40, uscg27, acf79, fleetWeek]) expect(one.body).not.toMatch(/\bEffective \d{4}-\d{2}-\d{2}\./);
    expect(acf79.organization).toBe('Health and Human Services Department, Children and Families Administration');
  });
});

describe('RULE_EFFECTIVE_SOON@5 misses the recorded items (the failure class)', () => {
  const signals = RULE_EFFECTIVE_SOON_V5.detect(records, now);
  const kept = members(signals);

  it('drops every record whose only date is "Stated effective": it reads no date at all', () => {
    for (const one of statedMisses) expect({ id: one.id, kept: kept.includes(one.id) }).toEqual({ id: one.id, kept: false });
  });

  it('drops them whatever day Brain stored them: the cause is the missing date, not the fetch day', () => {
    const onTime = statedMisses.map((one) => ({ ...one, fetchedAt: `${one.url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//)!.slice(1).join('-')}T06:00:00.000Z` }));
    expect(members(RULE_EFFECTIVE_SOON_V5.detect(onTime, now))).toEqual([]);
  });

  it('already keeps the lead-0, parent-only and correction records, grouped by issuing agency', () => {
    for (const one of alreadyKept) expect(kept).toContain(one.id);
    expect(groupOf(signals, faa72ParentOnly.id)).toBe('agency:federal aviation administration');
  });
});

describe('RULE_EFFECTIVE_SOON@6 keeps them, each in its agency group', () => {
  const signals = RULE_EFFECTIVE_SOON_V6.detect(records, now);

  it('keeps every true miss in the issuing agency’s group', () => {
    for (const [record, group] of expected) expect({ id: record.id, group: groupOf(signals, record.id) }).toEqual({ id: record.id, group });
  });

  it('groups FAA 2026-23073 and 2026-23072 under the Federal Aviation Administration whatever copy lists only Transportation Department', () => {
    expect(signals.map((s) => s.groupKey)).not.toContain('agency:transportation department');
    expect(signals.map((s) => s.groupKey)).not.toContain('agency:health and human services department');
  });

  it('counts one rule per document in the wording', () => {
    const acf = signals.find((s) => s.groupKey === 'agency:children and families administration')!;
    expect(acf.memberIds.sort()).toEqual([acf79.id, acf79Bare.id].sort());
    expect(acf.label).toMatch(/^1 final rule\(s\)/);
    const uscg = signals.find((s) => s.groupKey === 'agency:coast guard')!;
    expect(uscg.memberIds.sort()).toEqual([miami.id, uscg27.id].sort());
    expect(uscg.windowTo).toBe('2026-12-13T00:00:00.000Z');
  });

  it('says where a stated date came from', () => {
    expect(signals[0]!.qualifiers.some((one) => /DATES field/.test(one))).toBe(true);
  });

  it('keeps on v6 exactly what v5 keeps, plus the stated-date records', () => {
    const v5 = members(RULE_EFFECTIVE_SOON_V5.detect(records, now)).sort();
    const v6 = members(signals).sort();
    expect(v6).toEqual([...v5, ...statedMisses.map((one) => one.id)].sort());
  });
});

/**
 * The three recorded misses whose stored shape this objective does not
 * establish. Each is built in both shapes production could hold — effective_on
 * set to the publication day (as the RULE_EFFECTIVE_SOON@4 record states them),
 * and effective_on null with that date only in DATES — stored two days late,
 * as recorded. v6 must keep each in either shape, so its verdict on them does
 * not rest on an unestablished fixture.
 */
describe('FCC 2026-23040, Coast Guard 2026-23027 and ACF 2026-23279: kept whichever shape production stored', () => {
  const ACF = 'Health and Human Services Department, Children and Families Administration';
  const recorded: [string, string, string, string, unknown[], string][] = [
    ['2026-23040', '2026-11-12', 'National Television Multiple Ownership Rule', FCC, [FCC_AGENCY], 'agency:federal communications commission'],
    ['2026-23027', '2026-11-12', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL', USCG, [DHS, USCG_AGENCY], 'agency:coast guard'],
    ['2026-23279', '2026-11-16', 'Restoring Flexibility To Support Head Start Program Access', ACF, [HHS, ACF_AGENCY], 'agency:children and families administration'],
  ];
  const lateBy2 = (published: string) => new Date(Date.parse(`${published}T06:00:00.000Z`) + 2 * DAY).toISOString();
  const withEffective = recorded.map(([n, p, t, , agencies]) =>
    stored(apiRow(n, p, t, agencies, `This rule is effective ${p}.`, { effective_on: p }), lateBy2(p)));
  const statedOnly = recorded.map(([n, p, t, , agencies]) => {
    const [y, m, d] = p.split('-');
    const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m) - 1];
    return stored(apiRow(n, p, t, agencies, `This rule is effective ${month} ${Number(d)}, ${y}.`), lateBy2(p));
  });

  it('the two shapes are what the connector stores: an "Effective" sentence, or only the "Stated effective" marker', () => {
    for (const [i, one] of withEffective.entries()) expect(one.body).toBe(`Effective ${recorded[i]![1]}.`);
    for (const [i, one] of statedOnly.entries()) expect(one.body).toBe(`Stated effective ${recorded[i]![1]}.`);
  });

  it('keeps each, in its issuing agency’s group, when effective_on is set', () => {
    const signals = RULE_EFFECTIVE_SOON_V6.detect(withEffective, now);
    for (const [i, one] of withEffective.entries()) expect({ id: one.id, group: groupOf(signals, one.id) }).toEqual({ id: one.id, group: recorded[i]![5] });
  });

  it('keeps each, in its issuing agency’s group, when effective_on is null and the date is only in DATES', () => {
    const signals = RULE_EFFECTIVE_SOON_V6.detect(statedOnly, now);
    for (const [i, one] of statedOnly.entries()) expect({ id: one.id, group: groupOf(signals, one.id) }).toEqual({ id: one.id, group: recorded[i]![5] });
  });

  it('v5 keeps the effective_on shape and drops only the DATES-only shape: the latter is the class v6 adds', () => {
    expect(members(RULE_EFFECTIVE_SOON_V5.detect(withEffective, now)).sort()).toEqual(withEffective.map((one) => one.id).sort());
    expect(members(RULE_EFFECTIVE_SOON_V5.detect(statedOnly, now))).toEqual([]);
  });
});

describe('an "Effective" sentence and a correction still take precedence', () => {
  it('reads "Effective" on any copy before a "Stated effective" marker on another', () => {
    const statedCopy = fr('2026-23500', '2026-11-12', FCC, 'Stated effective 2026-11-10.', '2026-23500');
    const effectiveCopy = fr('2026-23500', '2026-11-12', FCC, 'Effective 2026-11-20.', '2026-23500', '2026-11-13T06:00:00.000Z', 'fi_2026-23500#v2');
    const signals = RULE_EFFECTIVE_SOON_V6.detect([statedCopy, effectiveCopy], now);
    expect(members(signals).sort()).toEqual([statedCopy.id, effectiveCopy.id].sort());
    expect(signals[0]!.windowFrom).toBe('2026-11-20T00:00:00.000Z');
  });

  it('never gives a correction a "Stated effective" date in place of the corrected rule’s', () => {
    const odd = fr('C1-2026-23600', '2026-11-12', NRC, 'Corrects 2026-23600. Stated effective 2026-11-20.', 'odd');
    expect(members(RULE_EFFECTIVE_SOON_V6.detect([odd], now))).toEqual([]);
  });
});

describe('every v5 bar is kept', () => {
  const kept = members(RULE_EFFECTIVE_SOON_V6.detect(records, now));

  it('leaves out Coast Guard 2026-23047 (stated 2026-11-11, published 2026-11-12)', () => {
    expect(kept).not.toContain(fleetWeek.id);
  });

  it('leaves out a stated date more than eight weeks after publication', () => {
    expect(kept).not.toContain(statedTooFar.id);
  });

  it('leaves out a record published outside the 30-day membership window however late Brain stored it', () => {
    expect(kept).not.toContain(statedOld.id);
  });

  it('infers nothing for a record with no marker at all', () => {
    const none = fr('2026-23700', '2026-11-12', FCC, 'The Commission will enforce the rule on November 20, 2026.', '2026-23700');
    expect(members(RULE_EFFECTIVE_SOON_V6.detect([none], now))).toEqual([]);
  });
});

describe('helpers', () => {
  it('reads only the "Stated effective" marker', () => {
    expect(statedEffectiveDateOf('Abstract. Stated effective 2026-12-13.')).toBe('2026-12-13');
    expect(statedEffectiveDateOf('Effective 2026-12-13.')).toBeNull();
    expect(statedEffectiveDateOf('Corrected rule effective 2026-12-13.')).toBeNull();
    expect(statedEffectiveDateOf(null)).toBeNull();
  });
});

describe('installation', () => {
  it('v6 is exported in SHADOW; v1..v5 stay exported unchanged', () => {
    expect(RULE_EFFECTIVE_SOON_V6).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 6, mode: 'SHADOW' });
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON_V6);
    expect(DETECTORS.find((one) => one.id === 'RULE_EFFECTIVE_SOON')!.version).toBeGreaterThanOrEqual(6);
    for (const old of [RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4, RULE_EFFECTIVE_SOON_V5]) {
      expect(DETECTORS).not.toContain(old);
    }
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
    expect([RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4, RULE_EFFECTIVE_SOON_V5].map((one) => [one.version, one.mode]))
      .toEqual([[1, 'SHADOW'], [2, 'SHADOW'], [3, 'SHADOW'], [4, 'SHADOW'], [5, 'SHADOW']]);
  });

  it('reads the same sources, lookback, membership window and entity keys as v5', () => {
    expect(RULE_EFFECTIVE_SOON_V6.sources).toEqual(RULE_EFFECTIVE_SOON_V5.sources);
    expect(RULE_EFFECTIVE_SOON_V6.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V5.lookbackMs);
    expect(RULE_EFFECTIVE_SOON_V6.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V5.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V6.entityKeyOf!(FAA)).toBe(RULE_EFFECTIVE_SOON_V5.entityKeyOf!(FAA));
  });
});
