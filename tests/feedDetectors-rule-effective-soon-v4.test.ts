/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@3 — the recorded failure class, reproduced
 * on v3 and caught by v4 (SHADOW).
 *
 * Fixtures are Federal Register items in the shape the connector stores them
 * (`sources.ts parseFederalRegister` + `completeFederalRegisterCorrections`;
 * an edit of a record is a new stored copy "<id>#v<n>" with a later fetched_at).
 * The document numbers, titles, agencies and publication days are the recorded
 * misses; v3 dropped them for one of two reasons, which each fixture isolates:
 *
 *  - a copy of a correction stored bare ("Corrects N.") while the corrected
 *    rule's date was recorded on another copy, or on a stored copy of the
 *    corrected rule whose URL the substring lookup did not match;
 *  - an edit of a rule effective on its publication day: Brain held the
 *    document from that day, but the edit is a new stored copy ("<id>#v2")
 *    with a later fetched_at, and v3 measured "first held" from that copy.
 *
 * v3's bar is kept: a document Brain first stored after it was already in
 * force for more than a day (a late backfill) is still not "taking effect soon".
 *
 * Coast Guard 2026-23047 (enforced the day before publication, dated only in
 * prose) is a correct exclusion for both versions, not a miss.
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V2_LEAD_DAYS,
  RULE_EFFECTIVE_SOON_V3,
  RULE_EFFECTIVE_SOON_V4,
  federalRegisterDocumentOf,
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
): DetectorRecord {
  const [y, m, d] = published.split('-');
  return {
    id,
    source: 'federal-register-rules',
    url: `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    organization,
    publishedAt: `${published}T00:00:00.000Z`,
    fetchedAt: fetched,
    body,
  };
}

const NRC = 'Nuclear Regulatory Commission';
const FCC = 'Federal Communications Commission';
const USCG = 'Homeland Security Department, Coast Guard';
const ACF = 'Health and Human Services Department, Children and Families Administration';
const AP1000 = 'AP1000 Design Certification Renewal';

/** The correction as first stored, before completion, and the completed copy a later pull wrote. */
const correctionBare = fr('C1-2026-21030', '2026-11-12', NRC, 'Corrects 2026-21030.', AP1000);
const correctionCompleted = fr(
  'C1-2026-21030', '2026-11-12', NRC, 'Corrects 2026-21030. Corrected rule effective 2026-12-28.', AP1000,
  '2026-11-14T06:00:00.000Z', 'fi_C1-2026-21030#v2',
);
/**
 * Rules effective on their publication day, held by Brain from that day (a first copy that
 * stated no date yet) and edited days later: the edit is a new stored copy with a later fetched_at.
 */
const editedRule = (documentNumber: string, published: string, organization: string, title: string, editedAt: string): DetectorRecord[] => [
  fr(documentNumber, published, organization, 'Final rule.', title),
  fr(documentNumber, published, organization, `Final rule. Effective ${published}.`, title, editedAt, `fi_${documentNumber}#v2`),
];
const editedRules: DetectorRecord[] = [
  ...editedRule('2026-23040', '2026-11-12', FCC, 'National Television Multiple Ownership Rule', '2026-11-14T06:00:00.000Z'),
  ...editedRule('2026-23027', '2026-11-12', USCG, 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL', '2026-11-15T06:00:00.000Z'),
  ...editedRule('2026-23279', '2026-11-16', ACF, 'Restoring Flexibility To Support Head Start Program Access', '2026-11-18T06:00:00.000Z'),
];
const lateHeld = editedRules.filter((one) => one.id.endsWith('#v2'));
const fleetWeek = fr(
  '2026-23047', '2026-11-12', USCG,
  'The Coast Guard will enforce a special local regulation on November 11, 2026.',
  'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade',
);
const records = [correctionBare, correctionCompleted, ...editedRules, fleetWeek];
const trueMisses = [correctionBare, ...lateHeld].map((one) => one.id);

const later = new Date('2026-11-18T12:00:00.000Z');
const members = (signals: ReturnType<typeof RULE_EFFECTIVE_SOON_V4.detect>) => signals.flatMap((s) => s.memberIds);

describe('RULE_EFFECTIVE_SOON@3 misses the recorded items (the failure class)', () => {
  const kept = members(RULE_EFFECTIVE_SOON_V3.detect(records, later));

  it('leaves out every true miss', () => {
    for (const id of trueMisses) expect(kept).not.toContain(id);
  });

  it('keeps the completed copy of the correction while dropping its bare copy', () => {
    expect(kept).toContain(correctionCompleted.id);
    expect(kept).not.toContain(correctionBare.id);
  });

  it('misses the bare correction when the corrected rule’s stored URL has no trailing slash', () => {
    const corrected = { ...fr('2026-21030', '2026-10-14', NRC, 'Direct final rule. Effective 2026-12-28.'), url: `${FR}/2026/10/14/2026-21030` };
    expect(members(RULE_EFFECTIVE_SOON_V3.detect([correctionBare, corrected], later))).not.toContain(correctionBare.id);
  });
});

describe('RULE_EFFECTIVE_SOON@4 keeps them', () => {
  const signals = RULE_EFFECTIVE_SOON_V4.detect(records, later);
  const byKey = new Map(signals.map((s) => [s.groupKey, s]));

  it('keeps every true miss', () => {
    const kept = members(signals);
    for (const id of trueMisses) expect(kept).toContain(id);
  });

  it('groups each under the issuing (last-listed) agency, never the parent department', () => {
    expect(byKey.get('agency:nuclear regulatory commission')?.memberIds.sort()).toEqual([correctionBare.id, correctionCompleted.id].sort());
    expect(byKey.get('agency:nuclear regulatory commission')?.windowTo).toBe('2026-12-28T00:00:00.000Z');
    expect(byKey.get('agency:federal communications commission')?.memberIds).toEqual(['fi_2026-23040', 'fi_2026-23040#v2']);
    expect(byKey.get('agency:coast guard')?.memberIds).toEqual(['fi_2026-23027', 'fi_2026-23027#v2']);
    expect(byKey.get('agency:coast guard')?.entityName).toBe('Coast Guard');
    expect(byKey.get('agency:children and families administration')?.memberIds).toEqual(['fi_2026-23279', 'fi_2026-23279#v2']);
    expect(byKey.has('agency:homeland security department')).toBe(false);
    expect(byKey.has('agency:health and human services department')).toBe(false);
  });

  it('resolves a bare correction from a stored copy of the corrected rule, matched by document number', () => {
    const corrected = { ...fr('2026-21030', '2026-10-14', NRC, 'Direct final rule. Effective 2026-12-28.'), url: `${FR}/2026/10/14/2026-21030` };
    expect(members(RULE_EFFECTIVE_SOON_V4.detect([correctionBare, corrected], later))).toContain(correctionBare.id);
    expect(members(RULE_EFFECTIVE_SOON_V4.detect([correctionBare], later))).toEqual([]);
  });

  it('reads a document number exactly, so a rule never borrows its correction’s dates', () => {
    expect(federalRegisterDocumentOf(`${FR}/2026/11/12/C1-2026-21030/ap1000`)).toBe('C1-2026-21030');
    expect(federalRegisterDocumentOf(`${FR}/2026/10/14/2026-21030`)).toBe('2026-21030');
    expect(federalRegisterDocumentOf('https://example.com/x')).toBeNull();
    const rule = fr('2026-21030', '2026-11-10', NRC, 'Direct final rule.');
    expect(members(RULE_EFFECTIVE_SOON_V4.detect([rule, correctionCompleted], later))).not.toContain(rule.id);
  });

  it('gives the same verdict whichever day inside the membership window it runs', () => {
    for (const run of ['2026-11-16T12:00:00.000Z', '2026-11-25T00:00:00.000Z', '2026-12-10T00:00:00.000Z']) {
      expect(members(RULE_EFFECTIVE_SOON_V4.detect(records, new Date(run))).sort()).toEqual(members(signals).sort());
    }
  });

  it('never says "must comply by" a date already gone', () => {
    const fcc = byKey.get('agency:federal communications commission')!;
    expect(fcc.hypothesis).not.toMatch(/must comply by/);
    expect(fcc.label).toContain('took effect by 2026-11-12');
  });
});

describe('the Coast Guard enforcement notice is a correct exclusion, not a miss', () => {
  it('is kept by neither v3 nor v4', () => {
    expect(members(RULE_EFFECTIVE_SOON_V3.detect(records, later))).not.toContain(fleetWeek.id);
    expect(members(RULE_EFFECTIVE_SOON_V4.detect(records, later))).not.toContain(fleetWeek.id);
  });
});

describe('RULE_EFFECTIVE_SOON@4 lowers no bar', () => {
  const lead = (days: number) => new Date(Date.parse('2026-11-12T00:00:00.000Z') + days * DAY).toISOString().slice(0, 10);

  it('never keeps a rule effective before its publication', () => {
    const early = fr('2026-90001', '2026-11-12', FCC, 'Effective 2026-11-11.', 't', '2026-11-12T06:00:00.000Z');
    expect(RULE_EFFECTIVE_SOON_V4.detect([early], later)).toEqual([]);
  });

  it('keeps v3’s bar: a document Brain first held after it was in force for more than a day stays out', () => {
    // A late backfill: one copy, first stored three days after the rule took effect on publication.
    const backfilled = fr('2026-90002', '2026-11-12', FCC, 'Effective 2026-11-12.', 't', '2026-11-15T06:00:00.000Z');
    expect(RULE_EFFECTIVE_SOON_V4.detect([backfilled], later)).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V3.detect([backfilled], later)).toEqual([]);
    // First held within a day of taking effect: kept — each stored copy, as v4 reads every copy of a document.
    const held = fr('2026-90002', '2026-11-12', FCC, 'Final rule.', 't', '2026-11-13T06:00:00.000Z');
    const edit = { ...backfilled, id: 'fi_2026-90002#v2' };
    expect(members(RULE_EFFECTIVE_SOON_V4.detect([held, edit], later)).sort()).toEqual(['fi_2026-90002', 'fi_2026-90002#v2']);
    // Matched by document number only: another document's early copy never lends its fetch day.
    const other = fr('2026-90009', '2026-11-12', FCC, 'Final rule.', 't', '2026-11-12T06:00:00.000Z');
    expect(RULE_EFFECTIVE_SOON_V4.detect([other, backfilled], later)).toEqual([]);
  });

  it('holds the eight-week upper bound from publication', () => {
    const edge = fr('2026-90003', '2026-11-12', FCC, `Effective ${lead(RULE_EFFECTIVE_SOON_V2_LEAD_DAYS)}.`);
    const beyond = fr('2026-90004', '2026-11-12', FCC, `Effective ${lead(RULE_EFFECTIVE_SOON_V2_LEAD_DAYS + 1)}.`);
    const kept = members(RULE_EFFECTIVE_SOON_V4.detect([edge, beyond], later));
    expect(kept).toContain(edge.id);
    expect(kept).not.toContain(beyond.id);
  });

  it('keeps nothing outside its 30-day membership window or its own source', () => {
    expect(RULE_EFFECTIVE_SOON_V4.detect(records, new Date('2026-12-20T00:00:00.000Z'))).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V4.detect([{ ...lateHeld[0]!, source: 'remoteok' }], later)).toEqual([]);
  });

  it('reads the same sources and membership window as v3', () => {
    expect(RULE_EFFECTIVE_SOON_V4.sources).toEqual(RULE_EFFECTIVE_SOON_V3.sources);
    expect(RULE_EFFECTIVE_SOON_V4.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V3.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V4.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V3.lookbackMs);
  });
});

describe('installation', () => {
  it('v4 is installed in SHADOW in place of v3; v1, v2 and v3 stay exported with their versions', () => {
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V4);
    for (const old of [RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3]) expect(DETECTORS).not.toContain(old);
    expect(RULE_EFFECTIVE_SOON_V4).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 4, mode: 'SHADOW' });
    expect([RULE_EFFECTIVE_SOON.version, RULE_EFFECTIVE_SOON_V2.version, RULE_EFFECTIVE_SOON_V3.version]).toEqual([1, 2, 3]);
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
  });
});
