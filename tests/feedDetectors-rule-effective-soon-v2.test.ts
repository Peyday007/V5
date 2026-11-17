/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@1 — the recorded misses, reproduced on v1
 * and caught by v2 (SHADOW).
 *
 * The fixture is the five Federal Register items the free screen kept and v1
 * left out, in the shape the Federal Register parser stores them
 * (`sources.ts parseFederalRegister`: agencies joined parent first, the
 * effective date as "Effective YYYY-MM-DD.", a correction as "Corrects N.").
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_DAYS,
  RULE_EFFECTIVE_SOON_V2,
  correctedDocumentOf,
  issuingAgencyOf,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';

/** The run after the five were published, when v1 left them out (published 2026-11-12). */
const now = new Date('2026-11-13T12:00:00.000Z');
const FR = 'https://www.federalregister.gov/documents';

function fr(documentNumber: string, published: string, organization: string, body: string | null, title = documentNumber): DetectorRecord {
  const [y, m, d] = published.split('-');
  return {
    id: `fi_${documentNumber}`,
    source: 'federal-register-rules',
    url: `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    organization,
    publishedAt: `${published}T00:00:00.000Z`,
    fetchedAt: `${published}T06:00:00.000Z`,
    body,
  };
}

const FAA = 'Transportation Department, Federal Aviation Administration';
const missed: DetectorRecord[] = [
  fr('2026-23073', '2026-11-12', FAA, 'Effective 2026-11-12.', 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments'),
  fr('2026-23072', '2026-11-12', FAA, 'Effective 2026-11-12.', 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments'),
  fr('2026-23041', '2026-11-12', 'Federal Communications Commission', 'Effective 2026-11-12.', 'Television Broadcasting Services, St. George, Utah'),
  fr('C1-2026-21030', '2026-11-12', 'Nuclear Regulatory Commission', 'Corrects 2026-21030.', 'AP1000 Design Certification Renewal'),
  // Enforcement on 2026-11-11, stated only in its DATES text: not a rule taking effect soon.
  fr(
    '2026-23047',
    '2026-11-12',
    'Homeland Security Department, Coast Guard',
    'The Coast Guard will enforce a special local regulation on November 11, 2026.',
    'Special Local Regulation; Southern California Annual Marine Events for the San Diego Captain of the Port Zone',
  ),
];
/** The rule the correction corrects, stored when it was published (outside the 30-day membership window). */
const corrected = fr('2026-21030', '2026-10-14', 'Nuclear Regulatory Commission', 'Direct final rule. Effective 2026-12-28.', 'AP1000 Design Certification Renewal');

const members = (signals: ReturnType<typeof RULE_EFFECTIVE_SOON_V2.detect>) => signals.flatMap((s) => s.memberIds);

describe('RULE_EFFECTIVE_SOON@1 misses the recorded items (the failure class)', () => {
  it('v1 keeps none of the five, even with the corrected rule stored', () => {
    expect(RULE_EFFECTIVE_SOON.detect(missed, now)).toEqual([]);
    const kept = members(RULE_EFFECTIVE_SOON.detect([...missed, corrected], now));
    for (const record of missed) expect(kept).not.toContain(record.id);
  });
});

describe('RULE_EFFECTIVE_SOON@2 reads them', () => {
  const signals = RULE_EFFECTIVE_SOON_V2.detect([...missed, corrected], now);
  const byKey = new Map(signals.map((s) => [s.groupKey, s]));

  it('groups the FAA amendments under the issuing agency, not the parent department', () => {
    const faa = byKey.get('agency:federal aviation administration');
    expect(faa?.memberIds.sort()).toEqual(['fi_2026-23072', 'fi_2026-23073']);
    expect(faa?.entityName).toBe('Federal Aviation Administration');
    expect(byKey.has('agency:transportation department')).toBe(false);
  });

  it('keeps a rule effective on its own publication day', () => {
    expect(byKey.get('agency:federal communications commission')?.memberIds).toEqual(['fi_2026-23041']);
  });

  it('a correction inherits the corrected rule’s effective date from the stored record', () => {
    const nrc = byKey.get('agency:nuclear regulatory commission');
    expect(nrc?.memberIds).toEqual(['fi_C1-2026-21030']);
    expect(nrc?.windowFrom).toBe('2026-12-28T00:00:00.000Z');
    // Without the corrected record stored, nothing is inferred.
    expect(members(RULE_EFFECTIVE_SOON_V2.detect(missed, now))).not.toContain('fi_C1-2026-21030');
  });

  it('does not flag a notice whose only date is in its text, enforced before it was published', () => {
    expect(members(signals)).not.toContain('fi_2026-23047');
  });

  it('every member is an item the rule was given, with its own url as evidence', () => {
    for (const s of signals) {
      expect(s.hypothesis).toMatch(/Not established/);
      for (const id of s.memberIds) expect(s.sourceUrls).toContain([...missed, corrected].find((r) => r.id === id)!.url);
    }
  });
});

describe('RULE_EFFECTIVE_SOON@2 lowers no bar', () => {
  it('drops a rule effective before its publication, one beyond the window, and one published over 30 days ago', () => {
    const beyond = new Date(now.getTime() + (RULE_EFFECTIVE_SOON_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
    const out = RULE_EFFECTIVE_SOON_V2.detect(
      [
        fr('2026-90001', '2026-11-12', 'Environmental Protection Agency', 'Effective 2026-11-10.'),
        fr('2026-90002', '2026-11-12', 'Environmental Protection Agency', `Effective ${beyond}.`),
        fr('2026-90003', '2026-10-01', 'Environmental Protection Agency', 'Effective 2026-11-20.'),
        fr('2026-90004', '2026-11-12', 'Environmental Protection Agency', 'Corrects 2026-99999.'),
      ],
      now,
    );
    expect(out).toEqual([]);
  });

  it('does not keep a rule already in force before yesterday, even one published within 30 days', () => {
    const later = new Date('2026-11-17T12:00:00.000Z');
    const fcc = fr('2026-80000', '2026-10-20', 'Federal Communications Commission', 'Effective 2026-10-20.');
    expect(RULE_EFFECTIVE_SOON_V2.detect([fcc], later)).toEqual([]);
    // The recorded misses, effective 2026-11-12, are in force by 2026-11-17 and drop out then.
    const kept = members(RULE_EFFECTIVE_SOON_V2.detect([...missed, corrected], later));
    for (const id of ['fi_2026-23073', 'fi_2026-23072', 'fi_2026-23041']) expect(kept).not.toContain(id);
    // A rule effective yesterday or today is still taking effect; the correction's 2026-12-28 still counts.
    expect(kept).toContain('fi_C1-2026-21030');
    const onDay = members(RULE_EFFECTIVE_SOON_V2.detect([fr('2026-80001', '2026-11-16', 'Federal Communications Commission', 'Effective 2026-11-16.')], later));
    expect(onDay).toEqual(['fi_2026-80001']);
    for (const signal of RULE_EFFECTIVE_SOON_V2.detect([...missed, corrected], later)) {
      expect(Date.parse(signal.windowFrom)).toBeGreaterThanOrEqual(Date.parse('2026-11-16T00:00:00.000Z'));
    }
  });

  it('reads only its own source', () => {
    const other = { ...missed[2]!, source: 'remoteok' };
    expect(RULE_EFFECTIVE_SOON_V2.detect([other], now)).toEqual([]);
  });
});

describe('installation', () => {
  it('v2 is installed in SHADOW with the same id; v1 stays exported at version 1', () => {
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V2);
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON);
    expect(RULE_EFFECTIVE_SOON_V2).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 2, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON.version).toBe(1);
    expect(RULE_EFFECTIVE_SOON_V2.sources).toEqual(RULE_EFFECTIVE_SOON.sources);
  });

  it('reads the correction and agency forms the Federal Register parser writes', () => {
    expect(correctedDocumentOf('Corrects 2026-21030.')).toBe('2026-21030');
    expect(correctedDocumentOf('Effective 2026-12-28.')).toBeNull();
    expect(issuingAgencyOf(FAA)).toBe('Federal Aviation Administration');
    expect(issuingAgencyOf('Federal Communications Commission')).toBe('Federal Communications Commission');
    expect(issuingAgencyOf(null)).toBeNull();
  });
});
