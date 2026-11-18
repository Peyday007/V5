/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@6 — a failure class reproduced on v6 and
 * caught by v7 (SHADOW).
 *
 * Fixtures are Federal Register items in the shapes the connector stores
 * (`sources.ts parseFederalRegister`), produced by parseFederalRegister from an
 * API row wherever the shape is the connector's own output.
 *
 * What v6 drops (asserted below): a correction of a rule whose only date is the
 * connector's "Stated effective" marker (effective_on null, the date only in
 * DATES — the shape established for Coast Guard 2026-23047 and modelled for
 * 2026-23230). The correction states no date of its own, the corrected rule
 * states no "Effective" sentence, and the connector's "Corrected rule
 * effective" lookup reads effective_on alone, so v6 has no date for it. The
 * correction's number (C1-2026-23230) is synthetic: no evidence in the
 * objective states that such a correction was published.
 *
 * What v6 already keeps and v7 must keep identically (no regression): Coast
 * Guard 2026-23230 itself, FAA 2026-23073 and 2026-23072 (lead 0; grouped under
 * the Federal Aviation Administration, not the Transportation Department), FCC
 * 2026-23041 (lead 0), FCC 2026-23040, Coast Guard 2026-23027 and ACF
 * 2026-23279 (effective on publication day, stored late), and NRC C1-2026-21030
 * (a correction completed with "Corrected rule effective").
 *
 * Every bar stays: Coast Guard 2026-23047 — "Stated effective 2026-11-11.", the
 * day before its 2026-11-12 publication — is a correct exclusion in both, and so
 * is a correction published after the stated date of the rule it corrects.
 */
import { describe, expect, it } from 'vitest';
import {
  RULE_EFFECTIVE_SOON_V5,
  RULE_EFFECTIVE_SOON_V6,
  RULE_EFFECTIVE_SOON_V7,
  type DetectedSignal,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import { parseFederalRegister } from '../server/services/feeds/sources.ts';

const FR = 'https://www.federalregister.gov/documents';
const NOW = new Date('2026-11-18T12:00:00.000Z');

function stored(row: Record<string, unknown>, fetched: string, id = `fi_${String(row['document_number'])}`): DetectorRecord {
  const [item] = parseFederalRegister({ results: [row] });
  if (!item) throw new Error('row not parsed');
  return { id, source: 'federal-register-rules', url: item.url, title: item.title, organization: item.organization, publishedAt: item.publishedAt, fetchedAt: fetched, body: item.body };
}

const DHS = { id: 227, name: 'Homeland Security Department', parent_id: null };
const USCG = { id: 85, name: 'Coast Guard', parent_id: 227 };
const FCC = { id: 161, name: 'Federal Communications Commission', parent_id: null };
const HHS = { id: 221, name: 'Health and Human Services Department', parent_id: null };
const ACF = { id: 45, name: 'Children and Families Administration', parent_id: 221 };
const DOT = { id: 492, name: 'Transportation Department', parent_id: null };
const FAA = { id: 159, name: 'Federal Aviation Administration', parent_id: 492 };
const NRC = { id: 383, name: 'Nuclear Regulatory Commission', parent_id: null };

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

const MIAMI_TITLE = 'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade';

/** Coast Guard 2026-23230 in 2026-23047's established shape; the DATES text is illustrative. */
const miami = stored(
  apiRow('2026-23230', '2026-11-16', MIAMI_TITLE, [DHS, USCG], {
    action: 'Notification of enforcement of regulation.',
    dates: 'The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.',
  }),
  '2026-11-16T06:00:00.000Z',
);
/** Synthetic correction of 2026-23230: effective_on, dates and action null, correction_of names the rule (C1-2026-21030's shape). */
const miamiCorrection = stored(
  apiRow('C1-2026-23230', '2026-11-17', MIAMI_TITLE, [DHS, USCG], { action: null, correction_of: '2026-23230' }),
  '2026-11-17T06:00:00.000Z',
);
/** Coast Guard 2026-23047: enforced 2026-11-11, published 2026-11-12 — a correct exclusion. */
const sanDiego = stored(
  apiRow('2026-23047', '2026-11-12', 'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade', [DHS, USCG], {
    action: 'Notification of enforcement of regulation.',
    dates: 'The regulations in 33 CFR 100.1101 will be enforced from 10 a.m. to 2 p.m. on November 11, 2026.',
  }),
  '2026-11-14T06:00:00.000Z',
);
/** A correction of 2026-23047 is excluded too: its corrected rule's stated date precedes the correction's publication. */
const sanDiegoCorrection = stored(
  apiRow('C1-2026-23047', '2026-11-13', 'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade', [DHS, USCG], { action: null, correction_of: '2026-23047' }),
  '2026-11-14T06:00:00.000Z',
);
const faa73 = stored(apiRow('2026-23073', '2026-11-12', 'Standard Instrument Approach Procedures (73)', [DOT, FAA], { effective_on: '2026-11-12' }), '2026-11-13T06:00:00.000Z');
const faa72 = stored(apiRow('2026-23072', '2026-11-12', 'Standard Instrument Approach Procedures (72)', [DOT, FAA], { effective_on: '2026-11-12' }), '2026-11-13T06:00:00.000Z');
const fcc41 = stored(apiRow('2026-23041', '2026-11-12', 'Television Broadcasting Services; St. George, Utah', [FCC], { effective_on: '2026-11-12' }), '2026-11-14T06:00:00.000Z');
const fcc40 = stored(apiRow('2026-23040', '2026-11-12', 'National Television Multiple Ownership Rule', [FCC], { effective_on: '2026-11-12' }), '2026-11-15T06:00:00.000Z');
const mobile = stored(apiRow('2026-23027', '2026-11-12', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL', [DHS, USCG], { effective_on: '2026-11-12' }), '2026-11-15T06:00:00.000Z');
const headStart = stored(apiRow('2026-23279', '2026-11-16', 'Restoring Flexibility To Support Head Start Program Access', [HHS, ACF], { effective_on: '2026-11-16' }), '2026-11-18T06:00:00.000Z');
const ap1000: DetectorRecord = {
  ...stored(apiRow('C1-2026-21030', '2026-11-12', 'AP1000 Design Certification Renewal', [NRC], { action: null, correction_of: '2026-21030' }), '2026-11-12T06:00:00.000Z'),
};
const ap1000Completed: DetectorRecord = { ...ap1000, id: 'fi_C1-2026-21030#v2', body: `${ap1000.body} Corrected rule effective 2026-12-28.`, fetchedAt: '2026-11-13T06:00:00.000Z' };

const ALL = [miami, miamiCorrection, sanDiego, sanDiegoCorrection, faa73, faa72, fcc41, fcc40, mobile, headStart, ap1000, ap1000Completed];

const members = (signals: DetectedSignal[]): Set<string> => new Set(signals.flatMap((one) => one.memberIds));
const groupOf = (signals: DetectedSignal[], id: string): string | undefined => signals.find((one) => one.memberIds.includes(id))?.entityName ?? undefined;

describe('the recorded failure class (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@6)', () => {
  it('the connector stores the correction bare and the corrected rule only with "Stated effective"', () => {
    expect(miamiCorrection.body).toBe('Corrects 2026-23230.');
    expect(miami.body).toBe('Stated effective 2026-12-13.');
  });

  it('v6 drops a correction of a rule dated only in DATES; v7 keeps it under the issuing agency', () => {
    const v6 = RULE_EFFECTIVE_SOON_V6.detect(ALL, NOW);
    const v7 = RULE_EFFECTIVE_SOON_V7.detect(ALL, NOW);
    expect(members(v6).has(miamiCorrection.id)).toBe(false);
    expect(members(v7).has(miamiCorrection.id)).toBe(true);
    expect(groupOf(v7, miamiCorrection.id)).toBe('Coast Guard');
  });

  it('v7 keeps every record v6 keeps, grouped identically', () => {
    const v6 = RULE_EFFECTIVE_SOON_V6.detect(ALL, NOW);
    const v7 = RULE_EFFECTIVE_SOON_V7.detect(ALL, NOW);
    for (const id of members(v6)) {
      expect(members(v7).has(id)).toBe(true);
      expect(groupOf(v7, id)).toBe(groupOf(v6, id));
    }
    for (const record of [miami, faa73, faa72, fcc41, fcc40, mobile, headStart, ap1000, ap1000Completed]) {
      expect(members(v7).has(record.id)).toBe(true);
    }
    expect(groupOf(v7, faa73.id)).toBe('Federal Aviation Administration');
    expect(groupOf(v7, faa72.id)).toBe('Federal Aviation Administration');
  });

  it('keeps every bar: 2026-23047 and its correction stay out of v6 and v7', () => {
    for (const detector of [RULE_EFFECTIVE_SOON_V6, RULE_EFFECTIVE_SOON_V7]) {
      const kept = members(detector.detect(ALL, NOW));
      expect(kept.has(sanDiego.id)).toBe(false);
      expect(kept.has(sanDiegoCorrection.id)).toBe(false);
    }
  });

  it('an "Effective" sentence on the corrected rule still wins over its stated date', () => {
    const effectiveCopy: DetectorRecord = { ...miami, id: 'fi_2026-23230#v2', body: 'Effective 2026-12-20. Stated effective 2026-12-13.', fetchedAt: '2026-11-17T12:00:00.000Z' };
    const v7 = RULE_EFFECTIVE_SOON_V7.detect([miami, effectiveCopy, miamiCorrection], NOW);
    const signal = v7.find((one) => one.memberIds.includes(miamiCorrection.id))!;
    expect(signal.windowTo.slice(0, 10)).toBe('2026-12-20');
  });
});

describe('installation', () => {
  it('v7 is SHADOW, version 7, and reads what v6 reads', () => {
    expect(RULE_EFFECTIVE_SOON_V7).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 7, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON_V7.sources).toEqual(RULE_EFFECTIVE_SOON_V6.sources);
    expect(RULE_EFFECTIVE_SOON_V7.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V6.lookbackMs);
    expect(RULE_EFFECTIVE_SOON_V7.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V6.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V7.entityKeyOf!('Transportation Department, Federal Aviation Administration'))
      .toBe(RULE_EFFECTIVE_SOON_V5.entityKeyOf!('Transportation Department, Federal Aviation Administration'));
  });
});
