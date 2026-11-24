/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@6 — the recorded failure class, reproduced
 * on v6 and answered by v7 (SHADOW).
 *
 * Two causes, asserted below:
 *
 *  1. `ruleReading` counted as a miss any in-window, KEEP-screened item from an
 *     agency the rule recognises, without applying the rule's own date
 *     predicate. Coast Guard 2026-23027 ("Effective 2026-11-11.", published
 *     2026-11-12) and 2026-23047 ("Stated effective 2026-11-11.", an enforcement
 *     window that ended before publication) are correct exclusions that were
 *     reported as misses. v7 states `couldKeep` — the same predicate `detect`
 *     applies — and the reading leaves out what the rule could never keep.
 *  2. FCC 2026-23040 is effective 2027-01-11, 60 days after its 2026-11-12
 *     publication: the earliest a major rule may take effect. v6's 56-day bound
 *     excluded it; v7's bound is 60 days.
 *
 * A detector without `couldKeep` reads exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import {
  DETECTORS,
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V2_LEAD_DAYS,
  RULE_EFFECTIVE_SOON_V3,
  RULE_EFFECTIVE_SOON_V4,
  RULE_EFFECTIVE_SOON_V5,
  RULE_EFFECTIVE_SOON_V6,
  RULE_EFFECTIVE_SOON_V7,
  RULE_EFFECTIVE_SOON_V7_LEAD_DAYS,
  loadDetectorRecords,
  ruleReading,
  runDetectors,
  type Detector,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';

const FR = 'https://www.federalregister.gov/documents';
const USCG = 'Homeland Security Department, Coast Guard';
const FCC = 'Federal Communications Commission';

function fr(documentNumber: string, published: string, organization: string, body: string, title = documentNumber): DetectorRecord {
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

const NOW = new Date('2026-11-20T12:00:00.000Z');
const MOBILE = fr('2026-23027', '2026-11-12', USCG, 'Effective 2026-11-11.', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL');
const FLEET_WEEK = fr('2026-23047', '2026-11-12', USCG, 'Stated effective 2026-11-11.', 'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade');
const FCC_OWNERSHIP = fr('2026-23040', '2026-11-12', FCC, 'Effective 2027-01-11.', 'National Television Multiple Ownership Rule');

describe('v7 detection and its own predicate', () => {
  it('keeps the 60-day major rule v6 drops', () => {
    expect(RULE_EFFECTIVE_SOON_V7_LEAD_DAYS).toBe(60);
    expect(RULE_EFFECTIVE_SOON_V2_LEAD_DAYS).toBe(56);
    const v6 = RULE_EFFECTIVE_SOON_V6.detect([FCC_OWNERSHIP], NOW);
    expect(v6).toEqual([]);
    const v7 = RULE_EFFECTIVE_SOON_V7.detect([FCC_OWNERSHIP], NOW);
    expect(v7).toHaveLength(1);
    expect(v7[0]!.memberIds).toEqual([FCC_OWNERSHIP.id]);
  });

  it('still excludes what is effective before its own publication, and says so through couldKeep', () => {
    expect(RULE_EFFECTIVE_SOON_V7.detect([MOBILE, FLEET_WEEK], NOW)).toEqual([]);
    expect(RULE_EFFECTIVE_SOON_V7.couldKeep!(MOBILE, NOW)).toBe(false);
    expect(RULE_EFFECTIVE_SOON_V7.couldKeep!(FLEET_WEEK, NOW)).toBe(false);
    expect(RULE_EFFECTIVE_SOON_V7.couldKeep!(FCC_OWNERSHIP, NOW)).toBe(true);
  });

  it('couldKeep agrees with detect over the same copies', () => {
    const copies = [MOBILE, FLEET_WEEK, FCC_OWNERSHIP];
    const detected = new Set(RULE_EFFECTIVE_SOON_V7.detect(copies, NOW).flatMap((one) => one.memberIds));
    for (const record of copies) expect(RULE_EFFECTIVE_SOON_V7.couldKeep!(record, NOW, copies)).toBe(detected.has(record.id));
  });

  it('keeps every other bar: past 60 days, or published outside the membership window, is still out', () => {
    expect(RULE_EFFECTIVE_SOON_V7.couldKeep!(fr('2026-99001', '2026-11-12', FCC, 'Effective 2027-01-12.'), NOW)).toBe(false);
    expect(RULE_EFFECTIVE_SOON_V7.couldKeep!(fr('2026-99002', '2026-09-01', FCC, 'Effective 2026-10-01.'), NOW)).toBe(false);
  });
});

describe('installation', () => {
  it('v7 is installed in SHADOW in place of v6; v1..v6 stay exported with their versions', () => {
    expect(RULE_EFFECTIVE_SOON_V7).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 7, mode: 'SHADOW' });
    expect(DETECTORS).toContain(RULE_EFFECTIVE_SOON_V7);
    expect(DETECTORS).not.toContain(RULE_EFFECTIVE_SOON_V6);
    expect(DETECTORS.filter((one) => one.id === 'RULE_EFFECTIVE_SOON')).toHaveLength(1);
    const old = [RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4, RULE_EFFECTIVE_SOON_V5, RULE_EFFECTIVE_SOON_V6];
    expect(old.map((one) => one.version)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const one of old) expect(one.couldKeep).toBeUndefined();
  });
});

describe('ruleReading counts as a miss only what the rule could have kept', () => {
  const live = new Date();
  const day = (offset: number) => new Date(live.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

  async function keep(itemId: string): Promise<void> {
    for (const model of ['m1', 'm2']) {
      await getDb().run(
        `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
         VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
        [`cr-${itemId}-${model}`, `h-${itemId}`, itemId, model, JSON.stringify({ verdict: 'KEEP', window: 'SHORT', deliverable: 'DOCUMENT', need: 'x', payer: 'y', reason: 'z' }), live.toISOString()],
      );
    }
  }

  async function seed(): Promise<Map<string, string>> {
    await freshProject();
    const published = day(-2);
    const [y, m, d] = published.split('-');
    const item = (n: string, body: string | null) => ({
      externalId: n,
      url: `${FR}/${y}/${m}/${d}/${n}/rule-${n}`,
      title: `Rule ${n}`,
      body,
      organization: USCG,
      publishedAt: `${published}T00:00:00.000Z`,
    });
    await insertFeedItems('federal-register-rules', [
      // A member: effective inside the window.
      item('2026-80001', `Effective ${day(10)}.`),
      // The recorded shapes: effective, or stated effective, the day before publication.
      item('2026-80002', `Effective ${day(-3)}.`),
      item('2026-80003', `Stated effective ${day(-3)}.`),
      // Same agency, in the window, a date the rule could keep: if a detection leaves it out,
      // that is a genuine miss.
      item('2026-80004', `Effective ${day(20)}.`),
    ]);
    const ids = new Map((await getDb().all<{ id: string; external_id: string }>(`SELECT id, external_id FROM feed_items WHERE source = 'federal-register-rules'`)).map((r) => [r.external_id, r.id]));
    return ids;
  }

  it('does not count the before-publication exclusions, and still counts a keepable item left out', async () => {
    const ids = await seed();
    await runDetectors({ now: live, detectors: [RULE_EFFECTIVE_SOON_V7] });
    const stored = await getDb().all<{ member_ids: string }>(`SELECT member_ids FROM feed_detections WHERE rule_id = 'RULE_EFFECTIVE_SOON' AND rule_version = 7`);
    const memberIds = stored.flatMap((one) => JSON.parse(one.member_ids) as string[]);
    expect(memberIds).toContain(ids.get('2026-80001'));
    expect(memberIds).not.toContain(ids.get('2026-80002'));
    expect(memberIds).not.toContain(ids.get('2026-80003'));
    // Leave the keepable one out of the stored detection, as an earlier run that missed it would.
    await getDb().run(`UPDATE feed_detections SET member_ids = ? WHERE rule_id = 'RULE_EFFECTIVE_SOON' AND rule_version = 7`, [JSON.stringify([ids.get('2026-80001')])]);
    for (const id of ids.values()) await keep(id);

    const reading = await ruleReading(RULE_EFFECTIVE_SOON_V7, live);
    expect(reading.members).toBe(1);
    expect(reading.misses).toBe(1);
    expect(reading.missedSamples.join(' ')).toContain('Rule 2026-80004');
    expect(reading.missedSamples.join(' ')).not.toContain('Rule 2026-80002');
    expect(reading.missedSamples.join(' ')).not.toContain('Rule 2026-80003');

    // Regression: the same rule without couldKeep reads exactly as before — every one a miss.
    const { couldKeep: _unused, ...rest } = RULE_EFFECTIVE_SOON_V7;
    const without: Detector = { ...rest, detect: (records, now) => RULE_EFFECTIVE_SOON_V7.detect(records, now) };
    const before = await ruleReading(without, live);
    expect(before.misses).toBe(3);
  });
});

describe('the reading merges copies over exactly the records detection read (F2)', () => {
  const live = new Date();
  const day = (offset: number) => new Date(live.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const published = day(-2);
  const [y, m, d] = published.split('-');

  async function seedOne(): Promise<string> {
    await freshProject();
    await insertFeedItems('federal-register-rules', [
      { externalId: '2026-80010', url: `${FR}/${y}/${m}/${d}/2026-80010/rule-a`, title: 'Rule 2026-80010', body: `Effective ${day(10)}.`, organization: USCG, publishedAt: `${published}T00:00:00.000Z` },
      { externalId: '2026-80011', url: `${FR}/${y}/${m}/${d}/2026-80011/rule-b`, title: 'Rule 2026-80011', body: 'Rule text with no effective sentence.', organization: USCG, publishedAt: `${published}T00:00:00.000Z` },
    ]);
    for (const row of await getDb().all<{ id: string }>(`SELECT id FROM feed_items WHERE source = 'federal-register-rules'`)) {
      for (const model of ['m1', 'm2']) {
        await getDb().run(
          `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
           VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
          [`cr-${row.id}-${model}`, `h-${row.id}`, row.id, model, JSON.stringify({ verdict: 'KEEP', window: 'SHORT', deliverable: 'DOCUMENT', need: 'x', payer: 'y', reason: 'z' }), live.toISOString()],
        );
      }
    }
    return (await getDb().get<{ id: string }>(`SELECT id FROM feed_items WHERE external_id = '2026-80011'`))!.id;
  }

  it('runDetectors hands detect and couldKeep the identical record set', async () => {
    await seedOne();
    const seen: { detect: string[] | null; couldKeep: Set<string> } = { detect: null, couldKeep: new Set() };
    const spy: Detector = {
      ...RULE_EFFECTIVE_SOON_V7,
      couldKeep(record, now, copies) {
        for (const one of copies ?? []) seen.couldKeep.add(one.id);
        return RULE_EFFECTIVE_SOON_V7.couldKeep!(record, now, copies);
      },
      detect(records, now) {
        seen.detect = records.map((one) => one.id);
        return RULE_EFFECTIVE_SOON_V7.detect(records, now);
      },
    };
    await runDetectors({ now: live, detectors: [spy] });
    // A second pass: now there is a stored detection, so the reading consults couldKeep.
    const firstId = (await getDb().get<{ id: string }>(`SELECT id FROM feed_items WHERE external_id = '2026-80010'`))!.id;
    await getDb().run(`UPDATE feed_detections SET member_ids = ? WHERE rule_id = 'RULE_EFFECTIVE_SOON' AND rule_version = 7`, [JSON.stringify([firstId])]);
    seen.couldKeep.clear();
    await runDetectors({ now: live, detectors: [spy] });
    expect(seen.detect).not.toBeNull();
    expect([...seen.couldKeep].sort()).toEqual([...seen.detect!].sort());
  });

  it('ruleReading judges keepability over the records it is given, not a second read', async () => {
    const laterId = await seedOne();
    await runDetectors({ now: live, detectors: [RULE_EFFECTIVE_SOON_V7] });
    const firstId = (await getDb().get<{ id: string }>(`SELECT id FROM feed_items WHERE external_id = '2026-80010'`))!.id;
    await getDb().run(`UPDATE feed_detections SET member_ids = ? WHERE rule_id = 'RULE_EFFECTIVE_SOON' AND rule_version = 7`, [JSON.stringify([firstId])]);
    const stored = await loadDetectorRecords(RULE_EFFECTIVE_SOON_V7, live);
    // Over the database's copies alone, 2026-80011 carries no date: the rule cannot keep it.
    expect((await ruleReading(RULE_EFFECTIVE_SOON_V7, live, stored)).misses).toBe(0);
    // Detection read a second copy of 2026-80011 that states its date. Copies merge by
    // document number, so the rule keeps both — and since the stored detection left them
    // out, the reading must count both, agreeing with detection rather than a fresh query.
    const later = stored.find((one) => one.id === laterId)!;
    const datedCopy: DetectorRecord = { ...later, id: `${later.id}-copy`, body: `Effective ${day(20)}.` };
    const withCopy = [...stored, datedCopy];
    const detected = new Set(RULE_EFFECTIVE_SOON_V7.detect(withCopy, live).flatMap((one) => one.memberIds));
    expect(detected.has(laterId)).toBe(true);
    const reading = await ruleReading(RULE_EFFECTIVE_SOON_V7, live, withCopy);
    expect(reading.misses).toBe(1); // only the stored item has a screen verdict; the copy has none
    expect(reading.missedSamples.join(' ')).toContain('Rule 2026-80011');
  });

  it('loadDetectorRecords is ordered and capped deterministically', async () => {
    await seedOne();
    const all = await loadDetectorRecords(RULE_EFFECTIVE_SOON_V7, live);
    expect(all).toHaveLength(2);
    const one = await loadDetectorRecords(RULE_EFFECTIVE_SOON_V7, live, 1);
    expect(one.map((r) => r.id)).toEqual([all[0]!.id]);
    expect(await loadDetectorRecords(RULE_EFFECTIVE_SOON_V7, live, 1)).toEqual(one);
  });
});
