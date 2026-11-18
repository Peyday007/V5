/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@5 — the recorded failure class, reproduced
 * on v5 and caught by v6 (SHADOW).
 *
 * Fixtures are Federal Register items in the shape the connector stores them
 * (`sources.ts parseFederalRegister`: body = abstract + "Effective YYYY-MM-DD."
 * + "Corrects N."; organization = agencies joined by ", "; an edit is a new
 * stored copy "<id>#v<n>" with a later fetched_at). Unlike the v5 suite, each
 * rule here is given only the records `runDetectors` would load for it: those
 * fetched no earlier than its own lookback (plus a day) before the run.
 *
 * What the reproduction shows, per recorded item:
 *  - FCC 2026-23040 and 2026-23041, Coast Guard 2026-23027, ACF 2026-23279,
 *    FAA 2026-23073/23072 and NRC C1-2026-21030 in every stored shape named in the
 *    assignment
 *    (fetched days late, publishedAt missing, a copy listing only the parent
 *    department, a bare copy beside a copy that states "Effective", a correction
 *    whose rule was stored 35 days before the run): v5
 *    already keeps them when it can read a stated date, and so does v6 — those
 *    shapes are not a v5 cause, and the test pins that.
 *  - A document whose only stated date is the connector's "Stated effective"
 *    marker: v5 has no date; v6 reads the marker (never prose).
 *  - Coast Guard 2026-23047 (enforced 2026-11-11, published 2026-11-12, dated
 *    only in prose) and Coast Guard 2026-23230 as a notification of
 *    enforcement with no stated date: correct exclusions in both versions.
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
  type Detector,
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

const now = new Date('2026-11-18T12:00:00.000Z');

/** What `runDetectors` hands a rule: its sources, fetched no earlier than lookback + one day before the run. */
const loaded = (detector: Detector, all: readonly DetectorRecord[]): DetectorRecord[] => {
  const since = now.getTime() - detector.lookbackMs - DAY;
  return all.filter((one) => detector.sources.includes(one.source) && Date.parse(one.fetchedAt) >= since);
};
const run = (detector: Detector, all: readonly DetectorRecord[]): DetectedSignal[] => detector.detect(loaded(detector, all), now);
const members = (signals: DetectedSignal[]) => signals.flatMap((s) => s.memberIds);
const groupOf = (signals: DetectedSignal[], id: string) => signals.find((s) => s.memberIds.includes(id))?.groupKey ?? null;

/** The corrected rule, stored when it was published (35 days before the run); the correction stored bare. */
const correctedRule = fr('2026-21030', '2026-10-14', NRC, 'Direct final rule. Effective 2026-12-28.', AP1000);
const correctionBare = fr('C1-2026-21030', '2026-11-12', NRC, 'Corrects 2026-21030.', AP1000);
const correctionNoBody = fr('C1-2026-21030', '2026-11-12', NRC, null, AP1000, '2026-11-12T07:00:00.000Z', 'fi_C1-2026-21030#legacy');

/** FAA: a copy listing only the parent department, fetched days late with publishedAt missing; an edit listing the office. */
const faa73 = fr('2026-23073', '2026-11-12', DOT, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-15T06:00:00.000Z', undefined, null);
const faa73Edit = fr('2026-23073', '2026-11-12', FAA, 'Amends SIAPs.', SIAP, '2026-11-16T06:00:00.000Z', 'fi_2026-23073#v2');
const faa72Dot = fr('2026-23072', '2026-11-12', DOT, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-14T06:00:00.000Z');
const faa72 = fr('2026-23072', '2026-11-12', FAA, 'Amends SIAPs. Effective 2026-11-12.', SIAP, '2026-11-12T06:00:00.000Z', 'fi_2026-23072#v1');
const fcc41 = fr('2026-23041', '2026-11-12', FCC, 'Effective 2026-11-12.', 'Television Broadcasting Services; St. George, Utah', '2026-11-14T06:00:00.000Z', undefined, null);
const fcc40 = fr('2026-23040', '2026-11-12', FCC, 'Effective 2026-11-12.', 'National Television Multiple Ownership Rule', '2026-11-15T06:00:00.000Z');
/** A bare edit of 2026-23040 with no Effective sentence of its own. */
const fcc40Bare = fr('2026-23040', '2026-11-12', FCC, null, 'National Television Multiple Ownership Rule', '2026-11-16T06:00:00.000Z', 'fi_2026-23040#v2');
const uscg27 = fr('2026-23027', '2026-11-12', USCG, 'Effective 2026-11-12.', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL', '2026-11-14T06:00:00.000Z');
const acf79 = fr('2026-23279', '2026-11-16', ACF, 'Effective 2026-11-16.', 'Restoring Flexibility To Support Head Start Program Access', '2026-11-18T06:00:00.000Z', undefined, null);
/** A rule whose only stated date is the connector's structured marker. */
const statedOnly = fr('2026-23300', '2026-11-16', FCC, 'Stated effective 2026-12-16.', 'Stated only', '2026-11-16T06:00:00.000Z');

/** Correct exclusions: enforced before publication, dated only in prose; a notification of enforcement with no stated date. */
const fleetWeek = fr(
  '2026-23047', '2026-11-12', USCG,
  'The Coast Guard will enforce a special local regulation on November 11, 2026.',
  'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade',
);
const winterfest = fr(
  '2026-23230', '2026-11-16', USCG, 'Notification of enforcement of regulation.',
  'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade',
);

const records = [
  correctedRule, correctionBare, correctionNoBody, faa73, faa73Edit, faa72Dot, faa72, fcc41, fcc40, fcc40Bare, uscg27, acf79, statedOnly,
  fleetWeek, winterfest,
];
const expected: [DetectorRecord, string][] = [
  [correctionBare, 'agency:nuclear regulatory commission'],
  [correctionNoBody, 'agency:nuclear regulatory commission'],
  [faa73, 'agency:federal aviation administration'],
  [faa73Edit, 'agency:federal aviation administration'],
  [faa72Dot, 'agency:federal aviation administration'],
  [faa72, 'agency:federal aviation administration'],
  [fcc41, 'agency:federal communications commission'],
  [fcc40, 'agency:federal communications commission'],
  [fcc40Bare, 'agency:federal communications commission'],
  [uscg27, 'agency:coast guard'],
  [acf79, 'agency:children and families administration'],
  [statedOnly, 'agency:federal communications commission'],
];

describe('RULE_EFFECTIVE_SOON@5 on the recorded items (the failure class)', () => {
  const kept = members(run(RULE_EFFECTIVE_SOON_V5, records));

  it('drops a rule whose only stated date is the connector’s "Stated effective" marker', () => {
    expect(kept).not.toContain(statedOnly.id);
  });

  it('already keeps the late-fetched, publishedAt-missing, bare-copy and parent-only shapes (not a v5 cause)', () => {
    for (const one of [correctionBare, correctionNoBody, faa73, faa73Edit, faa72Dot, faa72, fcc41, fcc40, fcc40Bare, uscg27, acf79]) expect(kept).toContain(one.id);
    expect(loaded(RULE_EFFECTIVE_SOON_V5, records)).toContain(correctedRule);
  });
});

describe('RULE_EFFECTIVE_SOON@6 keeps them, each in its issuing agency’s group', () => {
  const signals = run(RULE_EFFECTIVE_SOON_V6, records);

  it('keeps every true miss in its agency group', () => {
    for (const [record, group] of expected) expect({ id: record.id, group: groupOf(signals, record.id) }).toEqual({ id: record.id, group });
  });

  it('groups FAA 2026-23073 and 2026-23072 under the FAA whatever copy lists only the Transportation Department', () => {
    expect(signals.map((s) => s.groupKey)).not.toContain('agency:transportation department');
  });

  it('never makes the corrected rule itself a member: it is outside the 30-day membership window', () => {
    expect(members(signals)).not.toContain(correctedRule.id);
  });

  it('reads the marker only when no copy states "Effective": a stated Effective sentence wins', () => {
    const both = fr('2026-23301', '2026-11-16', FCC, 'Effective 2026-11-20.', 'Both', '2026-11-16T06:00:00.000Z');
    const markerCopy = fr('2026-23301', '2026-11-16', FCC, 'Stated effective 2026-11-17.', 'Both', '2026-11-17T06:00:00.000Z', 'fi_2026-23301#v2');
    const fcc = run(RULE_EFFECTIVE_SOON_V6, [both, markerCopy]).find((s) => s.groupKey === 'agency:federal communications commission')!;
    expect(fcc.windowFrom).toBe('2026-11-20T00:00:00.000Z');
  });

  it('never reads the marker for a correction', () => {
    const correctionWithMarker = fr('C1-2026-23302', '2026-11-16', FCC, 'Stated effective 2026-11-20.', 'Correction');
    expect(members(run(RULE_EFFECTIVE_SOON_V6, [correctionWithMarker]))).toEqual([]);
  });
});

describe('every v5 bar is kept', () => {
  const kept = members(run(RULE_EFFECTIVE_SOON_V6, records));

  it('leaves out Coast Guard 2026-23047 (enforced 2026-11-11, published 2026-11-12, dated only in prose)', () => {
    expect(kept).not.toContain(fleetWeek.id);
    expect(members(run(RULE_EFFECTIVE_SOON_V5, records))).not.toContain(fleetWeek.id);
  });

  it('leaves out a notification of enforcement with no stated date (Coast Guard 2026-23230)', () => {
    expect(kept).not.toContain(winterfest.id);
  });

  it('leaves out a marker date before publication and one past the eight-week bound', () => {
    const lastDay = new Date(Date.parse('2026-11-16T00:00:00.000Z') + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY).toISOString().slice(0, 10);
    const before = fr('2026-23303', '2026-11-16', FCC, 'Stated effective 2026-11-15.');
    const far = fr('2026-23304', '2026-11-16', FCC, `Stated effective ${new Date(Date.parse(`${lastDay}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10)}.`);
    const edge = fr('2026-23305', '2026-11-16', FCC, `Stated effective ${lastDay}.`);
    expect(members(run(RULE_EFFECTIVE_SOON_V6, [before, far, edge]))).toEqual([edge.id]);
  });

  it('leaves out a rule published outside the 30-day membership window, however far back it reads', () => {
    const old = fr('2026-20000', '2026-10-01', FCC, 'Effective 2026-11-20.');
    expect(members(run(RULE_EFFECTIVE_SOON_V6, [old]))).toEqual([]);
  });

  it('infers nothing for a correction whose corrected rule was never stored, marker or not', () => {
    expect(members(run(RULE_EFFECTIVE_SOON_V6, [correctionBare]))).toEqual([]);
  });

  it('parses no prose: "effective" in free text is not a date', () => {
    expect(statedEffectiveDateOf('This rule is effective December 16, 2026.')).toBeNull();
    expect(statedEffectiveDateOf('Stated effective 2026-12-16.')).toBe('2026-12-16');
  });
});

describe('installation', () => {
  it('v6 is installed in SHADOW in place of v5; v1..v5 stay exported with their versions', () => {
    expect(RULE_EFFECTIVE_SOON_V6).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 6, mode: 'SHADOW' });
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V6);
    const old = [RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4, RULE_EFFECTIVE_SOON_V5];
    for (const one of old) expect(DETECTORS).not.toContain(one);
    expect(old.map((one) => [one.version, one.mode])).toEqual([[1, 'SHADOW'], [2, 'SHADOW'], [3, 'SHADOW'], [4, 'SHADOW'], [5, 'SHADOW']]);
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
  });

  it('reads v5’s sources, lookback, membership window and entity keys', () => {
    expect(RULE_EFFECTIVE_SOON_V6.sources).toEqual(RULE_EFFECTIVE_SOON_V5.sources);
    expect(RULE_EFFECTIVE_SOON_V6.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V5.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V6.entityKeyOf!(FAA)).toBe(RULE_EFFECTIVE_SOON_V5.entityKeyOf!(FAA));
    expect(RULE_EFFECTIVE_SOON_V6.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V5.lookbackMs);
  });
});
