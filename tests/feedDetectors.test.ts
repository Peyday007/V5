/**
 * Code-first recognition: a rule finds the pattern, no model is asked about
 * its members, and a signal is never passed off as a buyer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import {
  CONCENTRATED_HIRING,
  CODE_SIGNAL_SOURCE,
  detectionReading,
  employerKey,
  jobFamily,
  runDetectors,
  titleKey,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';
import { screenFeedLeads, shortlistFunnel } from '../server/services/feeds/run.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 1000, timeoutMs: 1000 };

let projectId = '';
let userId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({ email: `det-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
});

function rec(id: string, title: string, org: string | null, published: string | null, source = 'remoteok'): DetectorRecord {
  return { id, source, url: `https://${source}.test/${id}`, title, organization: org, publishedAt: published, fetchedAt: now.toISOString() };
}

describe('normalisation', () => {
  it('keeps two companies apart and one company together', () => {
    expect(employerKey('Acme, Inc.')).toBe('acme');
    expect(employerKey('ACME LLC')).toBe('acme');
    expect(employerKey('Acme Health')).not.toBe(employerKey('Acme'));
    expect(employerKey('')).toBeNull();
    expect(titleKey('Senior Data Analyst (Remote)')).toBe(titleKey('Data Analyst'));
    expect(titleKey('Data Engineer')).not.toBe(titleKey('Data Analyst'));
    expect(jobFamily('Senior Data Analyst')?.key).toBe('DATA');
    expect(jobFamily('Office Plant Waterer')).toBeNull();
  });
});

describe('concentrated hiring', () => {
  it('fires on three distinct titles from one employer in one family within the window', () => {
    const signals = CONCENTRATED_HIRING.detect(
      [
        rec('a', 'Data Analyst', 'Acme Inc', daysAgo(1)),
        rec('b', 'Analytics Engineer', 'ACME', daysAgo(5), 'remotive'),
        rec('c', 'BI Developer', 'Acme', daysAgo(9)),
        rec('d', 'Data Analyst', 'Other Co', daysAgo(2)),
      ],
      now,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ category: 'DATA', deliverable: 'DATASET', entityKey: 'acme' });
    expect(signals[0]!.memberIds.sort()).toEqual(['a', 'b', 'c']);
    expect(signals[0]!.label).toContain('3 distinct data job titles');
    expect(signals[0]!.qualifiers.join(' ')).toMatch(/not vacancies/);
    expect(signals[0]!.hypothesis).toMatch(/Not established/);
  });

  it('does not count one job posted on three boards as three', () => {
    expect(
      CONCENTRATED_HIRING.detect(
        [
          rec('a', 'Senior Data Analyst', 'Acme', daysAgo(1)),
          rec('b', 'Data Analyst (Remote)', 'Acme', daysAgo(1), 'remotive'),
          rec('c', 'Sr. Data Analyst', 'Acme Inc', daysAgo(2)),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('refuses stale, undated, unnamed and cross-employer records', () => {
    expect(
      CONCENTRATED_HIRING.detect(
        [
          rec('a', 'Data Analyst', 'Acme', daysAgo(30)),
          rec('b', 'Analytics Engineer', 'Acme', null),
          rec('c', 'BI Developer', null, daysAgo(1)),
          rec('d', 'Data Scientist', 'Acme Health', daysAgo(1)),
          rec('e', 'Data Analyst', 'Acme', daysAgo(1)),
        ],
        now,
      ),
    ).toEqual([]);
  });
});

describe('in the feed path', () => {
  async function seed(): Promise<void> {
    const items = [
      ['1', 'Data Analyst', 'Acme Inc', 1],
      ['2', 'Analytics Engineer', 'Acme', 3],
      ['3', 'BI Developer', 'ACME', 6],
      ['4', 'Store Manager', 'Elsewhere', 2],
    ] as const;
    await insertFeedItems('remoteok', items.map(([id, title, org, d]) => ({ externalId: id, url: `https://remoteok.test/${id}`, title, body: null, organization: org, publishedAt: daysAgo(d) })));
  }

  it('covers the members, asks no model about them, and sends one lead to the shortlist', async () => {
    await seed();
    const first = await runDetectors({ now });
    expect(first[0]).toMatchObject({ signals: 1, created: 1, covered: 3, filed: 1 });

    // A restart finds the same detection and reports nothing new.
    const again = await runDetectors({ now });
    expect(again[0]).toMatchObject({ signals: 1, created: 0, extended: 0, covered: 0, filed: 0 });
    expect((await getDb().all('SELECT id FROM feed_detections')).length).toBe(1);

    const asked: string[] = [];
    const completer: Completer = async (_c, _m, _s, prompt) => {
      asked.push(prompt);
      return '{"verdict":"DROP","window":"UNKNOWN","deliverable":"NONE","need":"","payer":"","reason":"x"}';
    };
    await screenFeedLeads({ now, config, completer });
    // Only the one uncovered record was screened, by both models.
    expect(asked).toHaveLength(2);
    expect(asked.every((one) => one.includes('Store Manager'))).toBe(true);
    expect(await detectionReading()).toMatchObject({ covered: 3, coveredUnscreened: 3 });

    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const funnel = await shortlistFunnel(projectId, now);
    const lead = funnel.chosen.find(({ item }) => item.source === CODE_SIGNAL_SOURCE);
    expect(lead).toBeDefined();
    expect(lead!.item.title).toMatch(/^Acme: /);
  });

  it('extends a detection when a new title arrives, and never shrinks it', async () => {
    await seed();
    await runDetectors({ now });
    await insertFeedItems('remotive', [{ externalId: '9', url: 'https://remotive.test/9', title: 'Machine Learning Engineer', body: null, organization: 'Acme', publishedAt: daysAgo(0) }]);
    const later = await runDetectors({ now });
    expect(later[0]).toMatchObject({ created: 0, extended: 1, covered: 1 });
    const row = await getDb().get<{ member_ids: string }>('SELECT member_ids FROM feed_detections');
    expect(JSON.parse(row!.member_ids)).toHaveLength(4);
  });
});
