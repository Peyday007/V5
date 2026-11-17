/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@2 — the recorded misses, reproduced on v2
 * and caught by v3 (SHADOW).
 *
 * The fixture is the five Federal Register items the free screen kept and v2
 * left out, in the shape the Federal Register connector stores them
 * (`sources.ts parseFederalRegister` + `followFederalRegisterCorrections`:
 * agencies joined parent first, "Effective YYYY-MM-DD." for the record's own
 * effective_on, "Corrects N." and "Corrected rule effective YYYY-MM-DD." for a
 * correction).
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V2_LEAD_DAYS,
  RULE_EFFECTIVE_SOON_V3,
  correctedRuleEffectiveOf,
  effectiveDateOf,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import {
  CORRECTED_RULE_EFFECTIVE,
  FEED_SOURCES,
  followFederalRegisterCorrections,
  parseFederalRegister,
} from '../server/services/feeds/sources.ts';

const FR = 'https://www.federalregister.gov/documents';
const DAY = 86_400_000;

function fr(documentNumber: string, published: string, organization: string, body: string | null, title = documentNumber, fetchedAt = `${published}T06:00:00.000Z`): DetectorRecord {
  const [y, m, d] = published.split('-');
  return {
    id: `fi_${documentNumber}`,
    source: 'federal-register-rules',
    url: `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    organization,
    publishedAt: `${published}T00:00:00.000Z`,
    fetchedAt,
    body,
  };
}

const FAA = 'Transportation Department, Federal Aviation Administration';
const SIAP = 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments';
const missed: DetectorRecord[] = [
  fr('2026-23073', '2026-11-12', FAA, 'Effective 2026-11-12.', SIAP),
  fr('2026-23072', '2026-11-12', FAA, 'Effective 2026-11-12.', SIAP),
  fr('2026-23041', '2026-11-12', 'Federal Communications Commission', 'Effective 2026-11-12.', 'Television Broadcasting Services, St. George, Utah'),
  // The correction as the connector now stores it: the corrected rule's own effective_on, under its own marker.
  fr('C1-2026-21030', '2026-11-12', 'Nuclear Regulatory Commission', 'Corrects 2026-21030. Corrected rule effective 2026-12-28.', 'AP1000 Design Certification Renewal'),
  // Enforcement on 2026-11-11, stated only in its DATES text: not a rule taking effect soon.
  fr(
    '2026-23047',
    '2026-11-12',
    'Homeland Security Department, Coast Guard',
    'The Coast Guard will enforce a special local regulation on November 11, 2026.',
    'Special Local Regulation; Southern California Annual Marine Events for the San Diego Captain of the Port Zone',
  ),
];
/** The correction as v2 read it: before the connector carried the corrected rule's date. */
const correctionAsBefore = fr('C1-2026-21030', '2026-11-12', 'Nuclear Regulatory Commission', 'Corrects 2026-21030.', 'AP1000 Design Certification Renewal');

const members = (signals: ReturnType<typeof RULE_EFFECTIVE_SOON_V3.detect>) => signals.flatMap((s) => s.memberIds).sort();

/** The day the reading counted them: more than a day after their publication, inside the 30-day membership window. */
const now = new Date('2026-11-17T12:00:00.000Z');

describe('RULE_EFFECTIVE_SOON@2 misses the recorded items (the failure class)', () => {
  it('drops the lead-0 rules once it runs more than a day after their publication, while they stay members of its window', () => {
    const kept = members(RULE_EFFECTIVE_SOON_V2.detect(missed, now));
    for (const id of ['fi_2026-23073', 'fi_2026-23072', 'fi_2026-23041']) expect(kept).not.toContain(id);
    // …though on their publication day it kept them: the verdict depended on the run clock.
    expect(members(RULE_EFFECTIVE_SOON_V2.detect(missed, new Date('2026-11-12T12:00:00.000Z')))).toEqual(
      expect.arrayContaining(['fi_2026-23041', 'fi_2026-23072', 'fi_2026-23073']),
    );
  });

  it('misses the correction when the corrected rule 2026-21030 is not stored', () => {
    const records = missed.map((one) => (one.id === 'fi_C1-2026-21030' ? correctionAsBefore : one));
    expect(members(RULE_EFFECTIVE_SOON_V2.detect(records, now))).not.toContain('fi_C1-2026-21030');
  });
});

describe('RULE_EFFECTIVE_SOON@3 reads them', () => {
  const signals = RULE_EFFECTIVE_SOON_V3.detect(missed, now);
  const byKey = new Map(signals.map((s) => [s.groupKey, s]));

  it('keeps all four true members and not the enforcement notice', () => {
    expect(members(signals)).toEqual(['fi_2026-23041', 'fi_2026-23072', 'fi_2026-23073', 'fi_C1-2026-21030']);
    expect(members(signals)).not.toContain('fi_2026-23047');
  });

  it('groups the FAA amendments under the issuing agency, not the parent department', () => {
    const faa = byKey.get('agency:federal aviation administration');
    expect(faa?.memberIds.sort()).toEqual(['fi_2026-23072', 'fi_2026-23073']);
    expect(faa?.entityName).toBe('Federal Aviation Administration');
    expect(byKey.has('agency:transportation department')).toBe(false);
  });

  it('keeps the FCC rule effective on its own publication day', () => {
    expect(byKey.get('agency:federal communications commission')?.memberIds).toEqual(['fi_2026-23041']);
  });

  it('reads the correction’s date from the connector marker, with no corrected record stored', () => {
    const nrc = byKey.get('agency:nuclear regulatory commission');
    expect(nrc?.memberIds).toEqual(['fi_C1-2026-21030']);
    expect(nrc?.windowFrom).toBe('2026-12-28T00:00:00.000Z');
  });

  it('falls back to the stored corrected record when the marker is absent', () => {
    const corrected = fr('2026-21030', '2026-10-14', 'Nuclear Regulatory Commission', 'Direct final rule. Effective 2026-12-28.', 'AP1000 Design Certification Renewal');
    expect(members(RULE_EFFECTIVE_SOON_V3.detect([correctionAsBefore, corrected], now))).toEqual(['fi_C1-2026-21030']);
    expect(members(RULE_EFFECTIVE_SOON_V3.detect([correctionAsBefore], now))).toEqual([]);
  });

  it('gives the same verdict on every day inside the membership window', () => {
    for (const at of ['2026-11-12T12:00:00.000Z', '2026-11-13T12:00:00.000Z', '2026-11-17T12:00:00.000Z', '2026-12-11T12:00:00.000Z']) {
      expect(members(RULE_EFFECTIVE_SOON_V3.detect(missed, new Date(at)))).toEqual(['fi_2026-23041', 'fi_2026-23072', 'fi_2026-23073', 'fi_C1-2026-21030']);
    }
    // Past the 30-day membership window it is no longer news.
    expect(members(RULE_EFFECTIVE_SOON_V3.detect(missed, new Date('2026-12-13T12:00:00.000Z')))).toEqual([]);
  });
});

describe('RULE_EFFECTIVE_SOON@3 lowers no bar', () => {
  it('never keeps a rule effective before its own publication', () => {
    const early = fr('2026-90001', '2026-11-12', 'Federal Communications Commission', 'Effective 2026-11-11.');
    expect(RULE_EFFECTIVE_SOON_V3.detect([early], now)).toEqual([]);
  });

  it('never keeps a rule already in force when Brain first held it', () => {
    // Published 2026-11-01, effective 2026-11-03, first fetched 2026-11-10: in force for a week already.
    const late = fr('2026-90002', '2026-11-01', 'Federal Communications Commission', 'Effective 2026-11-03.', '2026-90002', '2026-11-10T06:00:00.000Z');
    expect(RULE_EFFECTIVE_SOON_V3.detect([late], now)).toEqual([]);
  });

  it('keeps the eight-week upper bound from publication', () => {
    const last = new Date(Date.parse('2026-11-12T00:00:00.000Z') + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY).toISOString().slice(0, 10);
    const over = new Date(Date.parse('2026-11-12T00:00:00.000Z') + (RULE_EFFECTIVE_SOON_V2_LEAD_DAYS + 1) * DAY).toISOString().slice(0, 10);
    expect(members(RULE_EFFECTIVE_SOON_V3.detect([fr('2026-90003', '2026-11-12', 'Federal Communications Commission', `Effective ${last}.`)], now))).toEqual(['fi_2026-90003']);
    expect(RULE_EFFECTIVE_SOON_V3.detect([fr('2026-90004', '2026-11-12', 'Federal Communications Commission', `Effective ${over}.`)], now)).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V3.detect([fr('2026-90005', '2026-11-12', 'Nuclear Regulatory Commission', `Corrects 2026-1. Corrected rule effective ${over}.`)], now)).toEqual([]);
  });

  it('reads only its own sources', () => {
    expect(RULE_EFFECTIVE_SOON_V3.detect([{ ...missed[2]!, source: 'remoteok' }], now)).toEqual([]);
  });
});

describe('installation', () => {
  it('v3 is installed in SHADOW in place of v2; v1 and v2 stay exported at their versions', () => {
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V3);
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON_V2);
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON);
    expect(RULE_EFFECTIVE_SOON_V3).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 3, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON_V2).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 2, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON.version).toBe(1);
    expect(RULE_EFFECTIVE_SOON_V3.sources).toEqual(RULE_EFFECTIVE_SOON_V2.sources);
    expect(RULE_EFFECTIVE_SOON_V3.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V2.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V3.entityKeyOf!(FAA)).toBe(RULE_EFFECTIVE_SOON_V2.entityKeyOf!(FAA));
  });

  it('the corrected-rule marker is not an "Effective" sentence, so v1 and v2 read what they read before', () => {
    const body = 'Corrects 2026-21030. Corrected rule effective 2026-12-28.';
    expect(effectiveDateOf(body)).toBeNull();
    expect(correctedRuleEffectiveOf(body)).toBe('2026-12-28');
    expect(RULE_EFFECTIVE_SOON_V2.detect([missed[3]!], now)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Federal Register connector: the corrected rule's own effective_on
// ---------------------------------------------------------------------------

const correctionRow = {
  document_number: 'C1-2026-21030',
  title: 'AP1000 Design Certification Renewal',
  html_url: `${FR}/2026/11/12/C1-2026-21030/ap1000-design-certification-renewal`,
  publication_date: '2026-11-12',
  abstract: null,
  effective_on: null,
  agencies: [{ name: 'Nuclear Regulatory Commission', id: 383 }],
  correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030',
};
const plainRow = {
  document_number: '2026-23041',
  title: 'Television Broadcasting Services, St. George, Utah',
  html_url: `${FR}/2026/11/12/2026-23041/television-broadcasting-services-st-george-utah`,
  publication_date: '2026-11-12',
  abstract: 'Amends the table.',
  effective_on: '2026-11-12',
  agencies: [{ name: 'Federal Communications Commission', id: 161 }],
};

describe('Federal Register connector: a correction carries the corrected rule’s effective date', () => {
  it('follows correction_of to the corrected rule and writes its effective_on under the marker, with no Effective line', async () => {
    const asked: string[] = [];
    const items = await followFederalRegisterCorrections(parseFederalRegister({ results: [correctionRow] }), async (url) => {
      asked.push(url);
      return { document_number: '2026-21030', effective_on: '2026-12-28' };
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/api/v1/documents/2026-21030.json');
    expect(asked[0]).toContain('fields%5B%5D=effective_on');
    expect(items[0]?.body).toBe(`Corrects 2026-21030. ${CORRECTED_RULE_EFFECTIVE} 2026-12-28.`);
    expect(effectiveDateOf(items[0]?.body)).toBeNull();
  });

  it('reads several corrected rules in one request from a results list', async () => {
    const second = { ...correctionRow, document_number: 'C1-2026-22000', html_url: `${FR}/2026/11/12/C1-2026-22000/x`, correction_of: '2026-22000' };
    const items = await followFederalRegisterCorrections(parseFederalRegister({ results: [correctionRow, second] }), async () => ({
      count: 2,
      results: [
        { document_number: '2026-21030', effective_on: '2026-12-28' },
        { document_number: '2026-22000', effective_on: null },
      ],
    }));
    expect(items.map((one) => correctedRuleEffectiveOf(one.body))).toEqual(['2026-12-28', null]);
  });

  it('uses the corrected rule from the same page without another request', async () => {
    const corrected = { ...plainRow, document_number: '2026-21030', html_url: `${FR}/2026/10/14/2026-21030/ap1000`, effective_on: '2026-12-28', agencies: [{ name: 'Nuclear Regulatory Commission' }] };
    const parsed = parseFederalRegister({ results: [correctionRow, corrected] });
    expect(parsed[0]?.body).toBe('Corrects 2026-21030. Corrected rule effective 2026-12-28.');
    const items = await followFederalRegisterCorrections(parsed, async () => {
      throw new Error('no request expected');
    });
    expect(items).toEqual(parsed);
  });

  it('a failed follow-up leaves the correction as parsed, inferring nothing', async () => {
    const parsed = parseFederalRegister({ results: [correctionRow] });
    const items = await followFederalRegisterCorrections(parsed, async () => {
      throw new Error('503');
    });
    expect(items).toEqual(parsed);
    expect(items[0]?.body).toBe('Corrects 2026-21030.');
  });

  it('writes a row without correction_of exactly as before, and asks nothing for it', async () => {
    const parsed = parseFederalRegister({ results: [plainRow] });
    expect(parsed[0]?.body).toBe('Amends the table. Effective 2026-11-12.');
    expect(parsed[0]?.organization).toBe('Federal Communications Commission');
    const items = await followFederalRegisterCorrections(parsed, async () => {
      throw new Error('no request expected');
    });
    expect(items).toEqual(parsed);
  });

  it('is installed on the Federal Register source', () => {
    expect(FEED_SOURCES.find((s) => s.id === 'federal-register-rules')?.follow).toBe(followFederalRegisterCorrections);
  });
});
