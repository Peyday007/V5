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
  employerKey,
  issuingAgencyOf,
  ruleReading,
  runDetectors,
  withinMemberWindow,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';

/** The day after the five were published: when the screen kept them and v1 had already dropped the same-day rules. */
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

  it('a rule already in force for days is not taking effect soon, and no signal asserts a past compliance date', () => {
    // The same same-day rules, read five days after they took effect.
    const later = new Date('2026-11-17T12:00:00.000Z');
    const kept = members(RULE_EFFECTIVE_SOON_V2.detect([...missed, corrected], later));
    for (const id of ['fi_2026-23073', 'fi_2026-23072', 'fi_2026-23041']) expect(kept).not.toContain(id);
    // The correction still counts: the rule it corrects takes effect 2026-12-28.
    expect(kept).toContain('fi_C1-2026-21030');
    // A rule published and effective weeks ago is not a member at all.
    expect(RULE_EFFECTIVE_SOON_V2.detect([fr('2026-80000', '2026-10-20', 'Federal Communications Commission', 'Effective 2026-10-20.')], later)).toEqual([]);
    for (const signal of RULE_EFFECTIVE_SOON_V2.detect([...missed, corrected], later)) {
      const complyBy = /comply by (\d{4}-\d{2}-\d{2})/.exec(signal.hypothesis ?? "")![1]!;
      expect(Date.parse(`${complyBy}T00:00:00.000Z`)).toBeGreaterThanOrEqual(Date.parse('2026-11-16T00:00:00.000Z'));
    }
  });

  it('keeps a rule effective yesterday, as v1 did, and drops one effective the day before', () => {
    const out = members(
      RULE_EFFECTIVE_SOON_V2.detect(
        [
          fr('2026-90010', '2026-11-10', 'Environmental Protection Agency', 'Effective 2026-11-12.'),
          fr('2026-90011', '2026-11-10', 'Environmental Protection Agency', 'Effective 2026-11-11.'),
        ],
        now,
      ),
    );
    expect(out).toEqual(['fi_2026-90010']);
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

describe('RULE_EFFECTIVE_SOON@2 readings key items the way the rule keys its entities', () => {
  it('declares the issuing-agency key it groups by', () => {
    expect(RULE_EFFECTIVE_SOON_V2.entityKeyOf!(FAA)).toBe('federal aviation administration');
    expect(RULE_EFFECTIVE_SOON_V2.entityKeyOf!(FAA)).not.toBe(employerKey(FAA));
  });

  it('counts a screened-KEEP item from a multi-agency issuer it left out as a miss', async () => {
    await freshProject();
    const live = new Date();
    const day = (offset: number) => new Date(live.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    await insertFeedItems('federal-register-rules', [
      // A member: FAA final rule effective inside the window.
      { externalId: 'faa-member', url: `${FR}/x/faa-member/a`, title: 'FAA member', body: `Effective ${day(10)}.`, organization: FAA, publishedAt: `${day(-1)}T00:00:00.000Z` },
      // Left out (no stated effective date) but the screen keeps it: a miss for the FAA entity.
      { externalId: 'faa-missed', url: `${FR}/x/faa-missed/b`, title: 'FAA missed', body: null, organization: FAA, publishedAt: `${day(-1)}T00:00:00.000Z` },
    ]);
    const items = await getDb().all<{ id: string; external_id: string }>(`SELECT id, external_id FROM feed_items WHERE source = 'federal-register-rules'`);
    const id = (externalId: string) => items.find((one) => one.external_id === externalId)!.id;
    await runDetectors({ now: live, detectors: [RULE_EFFECTIVE_SOON_V2] });
    const stored = await getDb().all<{ entity_key: string | null }>(`SELECT entity_key FROM feed_detections WHERE rule_id = 'RULE_EFFECTIVE_SOON' AND rule_version = 2`);
    expect(stored.map((one) => one.entity_key)).toEqual(['federal aviation administration']);
    for (const model of ['m1', 'm2']) {
      await getDb().run(
        `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
         VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
        [`cr-missed-${model}`, 'h-missed', id('faa-missed'), model, JSON.stringify({ verdict: 'KEEP', window: 'SHORT', deliverable: 'DOCUMENT', need: 'x', payer: 'y', reason: 'z' }), live.toISOString()],
      );
    }
    const reading = await ruleReading(RULE_EFFECTIVE_SOON_V2, live);
    expect(reading.members).toBe(1);
    expect(reading.misses).toBe(1);
    expect(reading.missedSamples.join(' ')).toContain('FAA missed');
  });
});

/**
 * Finding repair-reading-lookback-inflates-misses: v2 reads 90 days back only to
 * hold the rule a recent correction corrects, but keeps nothing published more
 * than 30 days ago. Its reading used the 90-day lookback as the universe of
 * misses, so an old rule the screen KEPT from a recognised agency counted as a
 * v2 miss and fed a spurious DETECTOR_MISSES:RULE_EFFECTIVE_SOON@2 proposal.
 */
describe('RULE_EFFECTIVE_SOON@2 counts as a miss only what it could have kept', () => {
  const DAY = 86_400_000;
  const live = new Date();
  const daysAgo = (n: number) => new Date(live.getTime() - n * DAY).toISOString();
  const dayAhead = (n: number) => new Date(live.getTime() + n * DAY).toISOString().slice(0, 10);
  const FCC = 'Federal Communications Commission';

  async function keep(itemId: string) {
    for (const model of ['m1', 'm2']) {
      await getDb().run(
        `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
         VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
        [`cr-${itemId}-${model}`, `h-${itemId}`, itemId, model, JSON.stringify({ verdict: 'KEEP', window: 'SHORT', deliverable: 'DOCUMENT', need: 'x', payer: 'y', reason: 'z' }), live.toISOString()],
      );
    }
  }

  it('the membership window is the one detect applies; a rule without one keeps what it reads', () => {
    expect(RULE_EFFECTIVE_SOON_V2.memberWindowMs).toBe(30 * DAY);
    expect(RULE_EFFECTIVE_SOON_V2.lookbackMs).toBeGreaterThan(RULE_EFFECTIVE_SOON_V2.memberWindowMs!);
    expect(withinMemberWindow(RULE_EFFECTIVE_SOON_V2, daysAgo(29), live.toISOString(), live)).toBe(true);
    expect(withinMemberWindow(RULE_EFFECTIVE_SOON_V2, daysAgo(31), live.toISOString(), live)).toBe(false);
    expect(withinMemberWindow(RULE_EFFECTIVE_SOON_V2, null, daysAgo(31), live)).toBe(false);
    expect(withinMemberWindow(RULE_EFFECTIVE_SOON_V2, 'not a date', live.toISOString(), live)).toBe(false);
    expect(withinMemberWindow(RULE_EFFECTIVE_SOON, daysAgo(400), live.toISOString(), live)).toBe(true);
  });

  it('an item published 30–90 days ago that the screen KEPT is not a miss; one inside the window still is', async () => {
    await freshProject();
    const rule = (n: string, published: string, body: string | null) => ({ externalId: n, url: `${FR}/x/${n}/rule-${n}`, title: `Rule ${n}`, body, organization: FCC, publishedAt: published });
    await insertFeedItems('federal-register-rules', [
      // Members: published in the window, effective within the horizon.
      rule('m1', daysAgo(2), `Effective ${dayAhead(10)}.`),
      rule('m2', daysAgo(3), `Effective ${dayAhead(20)}.`),
      // Read as context only (published 60 days ago), kept by the screen: not a miss.
      rule('old', daysAgo(60), `Effective ${dayAhead(5)}.`),
      // Inside the window but with no effective date the rule can read: a genuine miss.
      rule('recent', daysAgo(4), 'The rule takes effect on a date stated in its text.'),
    ]);
    const ids = new Map((await getDb().all<{ id: string; external_id: string }>(`SELECT id, external_id FROM feed_items WHERE source = 'federal-register-rules'`)).map((r) => [r.external_id, r.id]));
    const pass = await runDetectors({ now: live, detectors: [RULE_EFFECTIVE_SOON_V2] });
    expect(pass[0]!.records).toBe(4);
    for (const id of ids.values()) await keep(id);

    const reading = await ruleReading(RULE_EFFECTIVE_SOON_V2, live);
    expect(reading.members).toBe(2);
    expect(reading.confirmed).toBe(2);
    expect(reading.misses).toBe(1);
    expect(reading.missedSamples).toEqual([`Rule recent — ${FR}/x/recent/rule-recent`]);
  });
});
