/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@2 — the recorded misses, reproduced on v2
 * and caught by v3 (SHADOW).
 *
 * The fixture is the five Federal Register items the free screen kept and v2
 * left out, in the shape the Federal Register connector stores them
 * (`sources.ts parseFederalRegister` + `completeFederalRegisterCorrections`:
 * agencies joined parent first, "Effective YYYY-MM-DD.", a correction as
 * "Corrects N." plus the corrected rule's API effective_on as
 * "Corrected rule effective YYYY-MM-DD.").
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V2_LEAD_DAYS,
  RULE_EFFECTIVE_SOON_V3,
  correctedEffectiveDateOf,
  effectiveDateOf,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import {
  FEED_SOURCES,
  completeFederalRegisterCorrections,
  federalRegisterEffectiveOnUrl,
  parseFederalRegister,
} from '../server/services/feeds/sources.ts';

const DAY = 86_400_000;
const FR = 'https://www.federalregister.gov/documents';

function fr(documentNumber: string, published: string, organization: string, body: string | null, title = documentNumber, fetched = `${published}T06:00:00.000Z`): DetectorRecord {
  const [y, m, d] = published.split('-');
  return {
    id: `fi_${documentNumber}`,
    source: 'federal-register-rules',
    url: `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    organization,
    publishedAt: `${published}T00:00:00.000Z`,
    fetchedAt: fetched,
    body,
  };
}

const FAA = 'Transportation Department, Federal Aviation Administration';
const SIAP = 'Standard Instrument Approach Procedures, and Takeoff Minimums and Obstacle Departure Procedures; Miscellaneous Amendments';
const missed: DetectorRecord[] = [
  fr('2026-23073', '2026-11-12', FAA, 'Effective 2026-11-12.', SIAP),
  fr('2026-23072', '2026-11-12', FAA, 'Effective 2026-11-12.', SIAP),
  fr('2026-23041', '2026-11-12', 'Federal Communications Commission', 'Effective 2026-11-12.', 'Television Broadcasting Services, St. George, Utah'),
  // As the connector now stores it: the corrected rule's API effective_on (2026-21030 is not stored).
  fr('C1-2026-21030', '2026-11-12', 'Nuclear Regulatory Commission', 'Corrects 2026-21030. Corrected rule effective 2026-12-28.', 'AP1000 Design Certification Renewal'),
  // Enforced on 2026-11-11, dated only in its DATES prose: not a rule taking effect soon.
  fr('2026-23047', '2026-11-12', 'Homeland Security Department, Coast Guard', 'The Coast Guard will enforce a special local regulation on November 11, 2026.', 'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade'),
];
const coastGuard = missed[4]!;

/** More than a day after publication, inside the 30-day membership window: when v2 counted them missed. */
const later = new Date('2026-11-17T12:00:00.000Z');
const members = (signals: ReturnType<typeof RULE_EFFECTIVE_SOON_V3.detect>) => signals.flatMap((s) => s.memberIds);

describe('RULE_EFFECTIVE_SOON@2 misses the recorded items (the failure class)', () => {
  it('drops the lead-0 rules once it runs more than a day after publication', () => {
    const kept = members(RULE_EFFECTIVE_SOON_V2.detect(missed, later));
    for (const id of ['fi_2026-23073', 'fi_2026-23072', 'fi_2026-23041']) expect(kept).not.toContain(id);
  });

  it('misses the correction when the corrected rule 2026-21030 is not stored', () => {
    const asV2Stored = { ...missed[3]!, body: 'Corrects 2026-21030.' };
    expect(members(RULE_EFFECTIVE_SOON_V2.detect([asV2Stored], new Date('2026-11-12T12:00:00.000Z')))).toEqual([]);
  });
});

describe('RULE_EFFECTIVE_SOON@3 reads them', () => {
  const signals = RULE_EFFECTIVE_SOON_V3.detect(missed, later);
  const byKey = new Map(signals.map((s) => [s.groupKey, s]));

  it('keeps both FAA rules under the Federal Aviation Administration, not the Transportation Department', () => {
    expect(byKey.get('agency:federal aviation administration')?.memberIds.sort()).toEqual(['fi_2026-23072', 'fi_2026-23073']);
    expect(byKey.get('agency:federal aviation administration')?.entityName).toBe('Federal Aviation Administration');
    expect(byKey.has('agency:transportation department')).toBe(false);
  });

  it('keeps the FCC lead-0 rule', () => {
    expect(byKey.get('agency:federal communications commission')?.memberIds).toEqual(['fi_2026-23041']);
  });

  it('keeps the NRC correction from the connector’s corrected-rule marker', () => {
    const nrc = byKey.get('agency:nuclear regulatory commission');
    expect(nrc?.memberIds).toEqual(['fi_C1-2026-21030']);
    expect(nrc?.windowTo).toBe('2026-12-28T00:00:00.000Z');
  });

  it('does not keep the Coast Guard enforcement notice dated only in prose', () => {
    expect(members(signals)).not.toContain(coastGuard.id);
  });

  it('gives the same verdict whichever day inside the membership window it runs', () => {
    for (const run of ['2026-11-12T12:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-12-10T00:00:00.000Z']) {
      expect(members(RULE_EFFECTIVE_SOON_V3.detect(missed, new Date(run))).sort()).toEqual(members(signals).sort());
    }
  });

  it('falls back to the stored corrected record when the connector recorded no marker', () => {
    const bare = { ...missed[3]!, body: 'Corrects 2026-21030.' };
    const corrected = fr('2026-21030', '2026-10-14', 'Nuclear Regulatory Commission', 'Direct final rule. Effective 2026-12-28.');
    expect(members(RULE_EFFECTIVE_SOON_V3.detect([bare, corrected], later))).toContain(bare.id);
    expect(members(RULE_EFFECTIVE_SOON_V3.detect([bare], later))).toEqual([]);
  });
});

describe('RULE_EFFECTIVE_SOON@3 keeps every bar', () => {
  it('never keeps a rule effective before its publication', () => {
    const early = fr('2026-90001', '2026-11-12', 'Federal Communications Commission', 'Effective 2026-11-11.');
    expect(RULE_EFFECTIVE_SOON_V3.detect([early], later)).toEqual([]);
  });

  it('does not keep a rule already in force when Brain first held it', () => {
    const late = fr('2026-90002', '2026-10-20', 'Federal Communications Commission', 'Effective 2026-10-20.', 't', '2026-11-10T06:00:00.000Z');
    expect(RULE_EFFECTIVE_SOON_V3.detect([late], later)).toEqual([]);
  });

  it('holds the eight-week upper bound from publication', () => {
    const lead = (days: number) => new Date(Date.parse('2026-11-12T00:00:00.000Z') + days * DAY).toISOString().slice(0, 10);
    const edge = fr('2026-90003', '2026-11-12', 'Federal Communications Commission', `Effective ${lead(RULE_EFFECTIVE_SOON_V2_LEAD_DAYS)}.`);
    const beyond = fr('2026-90004', '2026-11-12', 'Federal Communications Commission', `Effective ${lead(RULE_EFFECTIVE_SOON_V2_LEAD_DAYS + 1)}.`);
    const kept = members(RULE_EFFECTIVE_SOON_V3.detect([edge, beyond], later));
    expect(kept).toContain(edge.id);
    expect(kept).not.toContain(beyond.id);
  });

  it('keeps nothing outside its 30-day membership window or its own source', () => {
    expect(RULE_EFFECTIVE_SOON_V3.detect(missed, new Date('2026-12-20T00:00:00.000Z'))).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V3.detect([{ ...missed[2]!, source: 'remoteok' }], later)).toEqual([]);
  });
});

describe('installation', () => {
  it('v3 is installed in SHADOW in place of v2; v1 and v2 stay exported with their versions', () => {
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V3);
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON_V2);
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON);
    expect(RULE_EFFECTIVE_SOON_V3).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 3, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON_V2).toMatchObject({ version: 2, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON.version).toBe(1);
    expect(RULE_EFFECTIVE_SOON_V3.sources).toEqual(RULE_EFFECTIVE_SOON.sources);
    expect(RULE_EFFECTIVE_SOON_V3.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V2.memberWindowMs);
  });

  it('the corrected-rule marker is not an Effective sentence, so v1 and v2 readings are unchanged', () => {
    expect(effectiveDateOf('Corrects 2026-21030. Corrected rule effective 2026-12-28.')).toBeNull();
    expect(correctedEffectiveDateOf('Corrects 2026-21030. Corrected rule effective 2026-12-28.')).toBe('2026-12-28');
  });
});

describe('Federal Register connector: the corrected rule’s effective date', () => {
  const correctionRow = {
    document_number: 'C1-2026-21030',
    title: 'AP1000 Design Certification Renewal',
    html_url: `${FR}/2026/11/12/C1-2026-21030/ap1000-design-certification-renewal`,
    publication_date: '2026-11-12',
    abstract: null,
    effective_on: null,
    agencies: [{ name: 'Nuclear Regulatory Commission' }],
    correction_of: '2026-21030',
  };
  const plainRow = { ...correctionRow, document_number: '2026-23041', correction_of: null, abstract: 'Amends the table.', effective_on: '2026-11-12' };

  it('writes the corrected rule’s API effective_on under its own marker and no Effective line', async () => {
    const asked: string[] = [];
    const items = await completeFederalRegisterCorrections(parseFederalRegister({ results: [correctionRow] }), async (url) => {
      asked.push(url);
      return { document_number: '2026-21030', effective_on: '2026-12-28' };
    });
    expect(asked).toEqual([federalRegisterEffectiveOnUrl('2026-21030')]);
    expect(items[0]!.body).toBe('Corrects 2026-21030. Corrected rule effective 2026-12-28.');
    expect(effectiveDateOf(items[0]!.body)).toBeNull();
  });

  it('writes a row without correction_of exactly as before, asking nothing', async () => {
    const parsed = parseFederalRegister({ results: [plainRow] });
    let calls = 0;
    const items = await completeFederalRegisterCorrections(parsed, async () => { calls += 1; return {}; });
    expect(items).toEqual(parsed);
    expect(items[0]!.body).toBe('Amends the table. Effective 2026-11-12.');
    expect(calls).toBe(0);
  });

  it('infers nothing when the lookup fails or the corrected rule states no date', async () => {
    const parsed = parseFederalRegister({ results: [correctionRow] });
    expect(await completeFederalRegisterCorrections(parsed, async () => { throw new Error('HTTP 503'); })).toEqual(parsed);
    expect(await completeFederalRegisterCorrections(parsed, async () => ({ document_number: '2026-21030', effective_on: null }))).toEqual(parsed);
    expect(await completeFederalRegisterCorrections(parsed, async () => ({ document_number: 'other', effective_on: '2026-12-28' }))).toEqual(parsed);
  });

  it('is the Federal Register source’s completion step', () => {
    expect(FEED_SOURCES.find((s) => s.id === 'federal-register-rules')?.complete).toBe(completeFederalRegisterCorrections);
  });
});
