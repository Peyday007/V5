/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@3 — the recorded failure class, reproduced
 * on v3 and caught by v4 (SHADOW).
 *
 * A Federal Register document re-sent with different content is stored as a new
 * version row (`insertFeedItems`: `<number>#v2`, the same url, fetched later),
 * and the earlier row is never rewritten. v3 judged each row alone, so the
 * earlier row of a correction that only later gained "Corrected rule effective
 * …" (C1-2026-21030), and the later row of a rule effective on its own
 * publication day (FAA 2026-23073), were left out while the free screen kept
 * them. Fixtures are in the shape the connector stores (`sources.ts
 * parseFederalRegister` + `completeFederalRegisterCorrections`).
 */
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V3,
  RULE_EFFECTIVE_SOON_V4,
  federalRegisterDocumentOf,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';

const FR = 'https://www.federalregister.gov/documents';

function fr(
  documentNumber: string,
  published: string,
  organization: string,
  body: string | null,
  title: string,
  fetched = `${published}T06:00:00.000Z`,
  version = 1,
): DetectorRecord {
  const [y, m, d] = published.split('-');
  return {
    id: version === 1 ? `fi_${documentNumber}` : `fi_${documentNumber}#v${version}`,
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
const AP1000 = 'AP1000 Design Certification Renewal';

// C1-2026-21030 as first stored (before the corrected-rule lookup), and its later version carrying the API date.
const correctionV1 = fr('C1-2026-21030', '2026-11-12', 'Nuclear Regulatory Commission', 'Corrects 2026-21030.', AP1000);
const correctionV2 = fr(
  'C1-2026-21030', '2026-11-12', 'Nuclear Regulatory Commission',
  'Corrects 2026-21030. Corrected rule effective 2026-12-28.', AP1000, '2026-11-17T06:00:00.000Z', 2,
);
// FAA 2026-23073, effective on its publication day, and a later version re-sent with an edited abstract.
const faaV1 = fr('2026-23073', '2026-11-12', FAA, 'Effective 2026-11-12.', SIAP);
const faaV2 = fr('2026-23073', '2026-11-12', FAA, 'Amends approach procedures. Effective 2026-11-12.', SIAP, '2026-11-15T06:00:00.000Z', 2);
// Coast Guard 2026-23047: enforced 2026-11-11, dated only in prose — not a rule taking effect soon.
const coastGuard = fr(
  '2026-23047', '2026-11-12', 'Homeland Security Department, Coast Guard',
  'The Coast Guard will enforce a special local regulation on November 11, 2026.',
  'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade',
);

const records = [correctionV1, correctionV2, faaV1, faaV2, coastGuard];
const trueMisses = [correctionV1.id, faaV2.id];
const later = new Date('2026-11-17T12:00:00.000Z');
const members = (signals: ReturnType<typeof RULE_EFFECTIVE_SOON_V4.detect>) => signals.flatMap((s) => s.memberIds);

describe('RULE_EFFECTIVE_SOON@3 misses the recorded items (the failure class)', () => {
  it('leaves out a superseded version of a kept correction, and a later version of a lead-0 rule', () => {
    const kept = members(RULE_EFFECTIVE_SOON_V3.detect(records, later));
    for (const id of trueMisses) expect(kept).not.toContain(id);
    // The same documents are kept through their other version: the miss is per row, not per document.
    expect(kept).toContain(correctionV2.id);
    expect(kept).toContain(faaV1.id);
  });
});

describe('RULE_EFFECTIVE_SOON@4 judges a document once, from all its stored versions', () => {
  it('keeps every version row of each document, grouped by issuing agency', () => {
    const signals = RULE_EFFECTIVE_SOON_V4.detect(records, later);
    const kept = members(signals);
    for (const id of [...trueMisses, correctionV2.id, faaV1.id]) expect(kept).toContain(id);
    expect(signals.map((s) => s.groupKey).sort()).toEqual(['agency:federal aviation administration', 'agency:nuclear regulatory commission']);
    const faa = signals.find((s) => s.groupKey === 'agency:federal aviation administration')!;
    expect(faa.entityName).toBe('Federal Aviation Administration');
    expect(faa.memberTitles).toEqual([SIAP]);
    expect(faa.sourceUrls).toEqual([faaV1.url]);
    const nrc = signals.find((s) => s.groupKey === 'agency:nuclear regulatory commission')!;
    expect(nrc.windowFrom).toBe('2026-12-28T00:00:00.000Z');
  });

  it('a lone version keeps v3’s verdict: the stale correction alone states no date, the lead-0 rule alone is first held when fetched', () => {
    expect(RULE_EFFECTIVE_SOON_V4.detect([correctionV1], later)).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V4.detect([faaV2], later)).toEqual([]);
  });

  it('the most recently fetched version that states a date decides it', () => {
    const moved = fr('2026-23073', '2026-11-12', FAA, 'Effective 2027-03-01.', SIAP, '2026-11-16T06:00:00.000Z', 3);
    // Moved beyond eight weeks of publication: the document is out, every version with it.
    expect(RULE_EFFECTIVE_SOON_V4.detect([faaV1, faaV2, moved], later)).toEqual([]);
  });

  it('reads documents by their Federal Register number', () => {
    expect(federalRegisterDocumentOf(correctionV2.url)).toBe('C1-2026-21030');
    expect(federalRegisterDocumentOf('https://example.org/x')).toBe('https://example.org/x');
  });
});

describe('RULE_EFFECTIVE_SOON@4 keeps every bar', () => {
  it('never keeps the Coast Guard notice dated only in prose (a correct exclusion, not a miss)', () => {
    expect(members(RULE_EFFECTIVE_SOON_V3.detect(records, later))).not.toContain(coastGuard.id);
    expect(members(RULE_EFFECTIVE_SOON_V4.detect(records, later))).not.toContain(coastGuard.id);
  });

  it('never keeps a rule effective before its publication or more than 56 days after it', () => {
    const early = fr('2026-30001', '2026-11-12', FAA, 'Effective 2026-11-10.', 'Early');
    const beyond = fr('2026-30002', '2026-11-12', FAA, 'Effective 2027-01-08.', 'Beyond');
    const edge = fr('2026-30003', '2026-11-12', FAA, 'Effective 2027-01-07.', 'Edge');
    const kept = members(RULE_EFFECTIVE_SOON_V4.detect([early, beyond, edge], later));
    expect(kept).toEqual([edge.id]);
  });

  it('never keeps a rule already in force when Brain first held any version of it', () => {
    const first = fr('2026-30004', '2026-11-12', FAA, 'Effective 2026-11-12.', 'Late', '2026-11-16T06:00:00.000Z');
    const second = fr('2026-30004', '2026-11-12', FAA, 'Edited. Effective 2026-11-12.', 'Late', '2026-11-17T06:00:00.000Z', 2);
    expect(RULE_EFFECTIVE_SOON_V4.detect([first, second], later)).toEqual([]);
  });

  it('keeps nothing outside its 30-day membership window or its own source', () => {
    expect(RULE_EFFECTIVE_SOON_V4.detect(records, new Date('2026-12-20T00:00:00.000Z'))).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V4.detect(records.map((one) => ({ ...one, source: 'remoteok' })), later)).toEqual([]);
  });

  it('is version 4 in SHADOW with v3’s sources and windows; v1–v3 stay exported with their versions', () => {
    expect(RULE_EFFECTIVE_SOON_V4).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 4, mode: 'SHADOW' });
    expect(RULE_EFFECTIVE_SOON_V4.sources).toEqual(RULE_EFFECTIVE_SOON.sources);
    expect(RULE_EFFECTIVE_SOON_V4.memberWindowMs).toBe(RULE_EFFECTIVE_SOON_V3.memberWindowMs);
    expect(RULE_EFFECTIVE_SOON_V4.lookbackMs).toBe(RULE_EFFECTIVE_SOON_V3.lookbackMs);
    expect(RULE_EFFECTIVE_SOON_V3.version).toBe(3);
    expect(RULE_EFFECTIVE_SOON_V2.version).toBe(2);
    expect(RULE_EFFECTIVE_SOON.version).toBe(1);
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
  });
});
