/**
 * DETECTOR_MISSES:RULE_EFFECTIVE_SOON@6: the recorded failure class, reproduced
 * on v6 and answered by v7 (SHADOW), in server/services/feeds/detectors.ts.
 *
 * Fixtures are Federal Register items in the shapes the connector stores: body
 * "Effective YYYY-MM-DD." (effective_on) or "Stated effective YYYY-MM-DD." (the
 * DATES field when effective_on is null), organization = agencies joined by
 * ", ", and the publication day in the document URL. The dates are the ones the
 * Federal Register API states for each document:
 *
 *  - Coast Guard 2026-23027: published 2026-11-12, effective_on 2026-11-11.
 *  - Coast Guard 2026-23047: published 2026-11-12, effective_on null, enforced
 *    on 2026-11-11 (DATES).
 *  - FCC 2026-23040: published 2026-11-12, effective_on 2027-01-11 (60 days).
 *
 * v6 counted the two Coast Guard notices as misses although its own bar (never
 * effective before publication) rightly excludes them. v7 declares `couldKeep`,
 * so `ruleReading` no longer counts an item it correctly excludes, while an item
 * it cannot read at all is still a miss. v6 dropped FCC 2026-23040 at its
 * 56-day bound. v7 keeps it at the 60-day minimum delay the Congressional
 * Review Act sets for a major rule.
 */
import { describe, expect, it } from 'vitest';
import {
  RULE_EFFECTIVE_SOON,
  RULE_EFFECTIVE_SOON_V2,
  RULE_EFFECTIVE_SOON_V2_LEAD_DAYS,
  RULE_EFFECTIVE_SOON_V3,
  RULE_EFFECTIVE_SOON_V4,
  RULE_EFFECTIVE_SOON_V5,
  RULE_EFFECTIVE_SOON_V6,
  RULE_EFFECTIVE_SOON_V7,
  RULE_EFFECTIVE_SOON_V7_LEAD_DAYS,
  ruleReading,
  runDetectors,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';

const FR = 'https://www.federalregister.gov/documents';
const COAST_GUARD = 'Homeland Security Department, Coast Guard';
const FCC = 'Federal Communications Commission';
const now = new Date('2026-11-17T12:00:00.000Z');

function urlOf(documentNumber: string, published: string, title: string): string {
  const [y, m, d] = published.split('-');
  return `${FR}/${y}/${m}/${d}/${documentNumber}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function fr(documentNumber: string, published: string, organization: string, body: string | null, title = documentNumber): DetectorRecord {
  return {
    id: `fi_${documentNumber}`,
    source: 'federal-register-rules',
    url: urlOf(documentNumber, published, title),
    title,
    organization,
    publishedAt: `${published}T00:00:00.000Z`,
    fetchedAt: `${published}T06:00:00.000Z`,
    body,
  };
}

const CG_23027 = fr('2026-23027', '2026-11-12', COAST_GUARD, 'Effective 2026-11-11.', 'Safety Zone; Sector Mobile Captain of the Port Zone, Mobile, AL');
const CG_23047 = fr('2026-23047', '2026-11-12', COAST_GUARD, 'Stated effective 2026-11-11.', 'Special Local Regulation; San Diego Fleet Week Veterans Day Boat Parade');
const FCC_23040 = fr('2026-23040', '2026-11-12', FCC, 'Effective 2027-01-11.', 'National Television Multiple Ownership Rule');
/** A Coast Guard rule both versions keep, so the agency is one the rule recognises. */
const CG_MEMBER = fr('2026-90001', '2026-11-13', COAST_GUARD, 'Effective 2026-11-20.', 'Safety Zone; synthetic member');
/** A Coast Guard item with no date the rule can read: still a genuine miss. */
const CG_UNDATED = fr('2026-90002', '2026-11-13', COAST_GUARD, null, 'Safety Zone; synthetic undated');

const memberIds = (signals: ReturnType<typeof RULE_EFFECTIVE_SOON_V7.detect>) => signals.flatMap((one) => one.memberIds);

describe('RULE_EFFECTIVE_SOON@7 detection', () => {
  const records = [CG_23027, CG_23047, FCC_23040, CG_MEMBER, CG_UNDATED];

  it('keeps FCC 2026-23040 (effective 60 days after publication), which v6 drops at its 56-day bound', () => {
    expect(RULE_EFFECTIVE_SOON_V7_LEAD_DAYS).toBe(60);
    expect(RULE_EFFECTIVE_SOON_V2_LEAD_DAYS).toBe(56);
    expect(memberIds(RULE_EFFECTIVE_SOON_V6.detect(records, now))).not.toContain(FCC_23040.id);
    expect(memberIds(RULE_EFFECTIVE_SOON_V7.detect(records, now))).toContain(FCC_23040.id);
  });

  it('still excludes a rule effective before its own publication, and one past sixty days', () => {
    const late = fr('2026-90003', '2026-11-12', FCC, 'Effective 2027-01-12.', 'synthetic 61 days');
    const kept = memberIds(RULE_EFFECTIVE_SOON_V7.detect([...records, late], now));
    expect(kept).toContain(CG_MEMBER.id);
    for (const out of [CG_23027, CG_23047, CG_UNDATED, late]) expect(kept).not.toContain(out.id);
  });

  it('keeps every v6 member identically (no regression)', () => {
    const v6 = memberIds(RULE_EFFECTIVE_SOON_V6.detect(records, now));
    const v7 = memberIds(RULE_EFFECTIVE_SOON_V7.detect(records, now));
    for (const id of v6) expect(v7).toContain(id);
  });

  it('couldKeep is false only for an effective date it read outside its bounds', () => {
    const rule = RULE_EFFECTIVE_SOON_V7;
    expect(rule.couldKeep!(CG_23027, now, records)).toBe(false);
    expect(rule.couldKeep!(CG_23047, now, records)).toBe(false);
    expect(rule.couldKeep!(FCC_23040, now, records)).toBe(true);
    expect(rule.couldKeep!(CG_MEMBER, now, records)).toBe(true);
    // Nothing the rule can read: that is a miss to learn from, not an exclusion.
    expect(rule.couldKeep!(CG_UNDATED, now, records)).toBe(true);
    // Read alone, the same verdicts.
    expect(rule.couldKeep!(CG_23027, now)).toBe(false);
    expect(rule.couldKeep!(FCC_23040, now)).toBe(true);
  });

  it('v6 declares no couldKeep: its readings are unchanged', () => {
    expect(RULE_EFFECTIVE_SOON_V6.couldKeep).toBeUndefined();
  });
});

describe('RULE_EFFECTIVE_SOON@7 counts as a miss only what it could have kept', () => {
  const DAY = 86_400_000;
  const live = new Date();
  const day = (offset: number) => new Date(live.getTime() + offset * DAY).toISOString().slice(0, 10);

  async function keep(itemId: string) {
    for (const model of ['m1', 'm2']) {
      await getDb().run(
        `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
         VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
        [`cr-${itemId}-${model}`, `h-${itemId}`, itemId, model, JSON.stringify({ verdict: 'KEEP', window: 'SHORT', deliverable: 'DOCUMENT', need: 'x', payer: 'y', reason: 'z' }), live.toISOString()],
      );
    }
  }

  it('a correctly excluded Coast Guard notice the screen KEPT is not a v7 miss; an unreadable one still is; v6 counts all three', async () => {
    await freshProject();
    const item = (externalId: string, published: string, body: string | null, title: string) => ({
      externalId, url: urlOf(externalId, published, title), title, body, organization: COAST_GUARD, publishedAt: `${published}T00:00:00.000Z`,
    });
    await insertFeedItems('federal-register-rules', [
      item('2026-91001', day(-2), `Effective ${day(5)}.`, 'Member safety zone'),
      // The 2026-23027 shape: effective the day before its publication.
      item('2026-91002', day(-1), `Effective ${day(-2)}.`, 'Backdated safety zone'),
      // The 2026-23047 shape: an enforcement that ended before its notice was published.
      item('2026-91003', day(-1), `Stated effective ${day(-2)}.`, 'Past enforcement notice'),
      // No date the rule can read.
      item('2026-91004', day(-1), null, 'Undated safety zone'),
    ]);
    const ids = (await getDb().all<{ id: string }>(`SELECT id FROM feed_items WHERE source = 'federal-register-rules'`)).map((one) => one.id);
    await runDetectors({ now: live, detectors: [RULE_EFFECTIVE_SOON_V6, RULE_EFFECTIVE_SOON_V7] });
    for (const id of ids) await keep(id);

    const v7 = await ruleReading(RULE_EFFECTIVE_SOON_V7, live);
    expect(v7.members).toBe(1);
    expect(v7.misses).toBe(1);
    expect(v7.missedSamples.join(' ')).toContain('Undated safety zone');

    // Regression: a rule without couldKeep reads exactly as before.
    const v6 = await ruleReading(RULE_EFFECTIVE_SOON_V6, live);
    expect(v6.members).toBe(1);
    expect(v6.misses).toBe(3);
  });
});

describe('installation', () => {
  it('v7 is SHADOW; v1..v6 stay exported with their versions', () => {
    expect(RULE_EFFECTIVE_SOON_V7).toMatchObject({ id: 'RULE_EFFECTIVE_SOON', version: 7, mode: 'SHADOW' });
    expect([RULE_EFFECTIVE_SOON, RULE_EFFECTIVE_SOON_V2, RULE_EFFECTIVE_SOON_V3, RULE_EFFECTIVE_SOON_V4, RULE_EFFECTIVE_SOON_V5, RULE_EFFECTIVE_SOON_V6].map((one) => one.version))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });
});
