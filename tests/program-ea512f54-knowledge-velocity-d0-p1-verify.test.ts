/**
 * KNOW-25-1, S-0358 (repair: deepening promotions unconsumed). What selective
 * deepening promotes in an extraction pass beyond the unreadable records —
 * contested fact keys, identity collisions and cross-source links — is sent to
 * costly verification: the next feed shortlist round puts each to research as a
 * question with the records it rests on, records that it did, and does not ask
 * it again while it is recent. Held candidates are never asked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { LOOP_QUESTIONS_ASKED_EVENT, openFeedShortlist, pendingDeepeningQuestions, recordFeedExtraction } from '../server/services/feeds/run.ts';

let projectId = '';
let userId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({ email: `verify-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();

/** Two sources that state one subject's budget differently and name the same organization in different places. */
async function seed(): Promise<void> {
  const sources = [`va${Math.random().toString(36).slice(2, 8)}`, `vb${Math.random().toString(36).slice(2, 8)}`];
  for (const [i, source] of sources.entries()) {
    await insertFeedItems(source, [
      {
        externalId: `${source}-rfq`,
        url: `https://example.test/${source}/rfq`,
        title: 'Request for quotes: 500 kg of packaging film',
        body: `Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget $${i === 0 ? '4,000' : '9,500'}.`,
        organization: 'Acme Foods LLC',
        publishedAt: hoursAgo(5 + i),
      },
      {
        externalId: `${source}-ad`,
        url: `https://example.test/${source}/ad`,
        title: 'Lawn care now booking',
        body: 'We offer weekly mowing in Portland, OR for $45.',
        organization: 'Acme Foods LLC',
        publishedAt: hoursAgo(4 + i),
      },
    ]);
  }
}

const nonItem = (id: string) => !id.startsWith('item:');

describe('promoted deepening candidates reach verification', () => {
  it('every promoted key/entity/link candidate becomes one verification question; a held one never does', async () => {
    await seed();
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 2 }))!;
    const promoted = pass.deepening!.promoted.filter((d) => nonItem(d.id));
    const held = pass.deepening!.held.filter((d) => nonItem(d.id));
    // The fixture yields contested keys, collisions and links, more than capacity admits.
    expect(promoted.length).toBeGreaterThan(0);
    expect(held.length).toBeGreaterThan(0);
    const questions = pass.deepening!.questions!;
    expect(questions.map((q) => q.neighborhood).sort()).toEqual([...new Set(promoted.map((d) => d.id))].sort());
    for (const d of held) if (!promoted.some((p) => p.id === d.id)) expect(questions.some((q) => q.neighborhood === d.id)).toBe(false);
    for (const q of questions) {
      expect(q.key).toBe(`deepen:${q.neighborhood}`);
      expect(q.evidenceUrls.length).toBeGreaterThan(0);
      expect(q.evidenceUrls.every((u) => u.startsWith('https://example.test/'))).toBe(true);
      // Built from code's own structure, never a record's words.
      expect(q.question).not.toMatch(/Acme|packaging|mowing|Austin|Portland/);
    }
    expect(new Set(questions.map((q) => q.key)).size).toBe(questions.length);
    // The shortlist reads exactly what the row queued.
    const read = await pendingDeepeningQuestions(projectId, new Date(), 100);
    expect(read.map((q) => q.key).sort()).toEqual(questions.map((q) => q.key).sort());
  });

  it('the shortlist round puts the promoted questions to research, records them, and does not ask them again', async () => {
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    await seed();
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 3 }))!;
    const queued = pass.deepening!.questions!;
    expect(queued.length).toBeGreaterThan(0);

    const roundId = await openFeedShortlist({ projectId, now: new Date() });
    expect(roundId).not.toBeNull();
    const round = (await listRounds(projectId)).find((one) => one.id === roundId)!;
    const statement = (await getCandidate(round.candidateId))!.statement;
    const verifyLines = statement.match(/- verify:/g) ?? [];
    expect(verifyLines.length).toBe(Math.min(queued.length, 5));
    for (const q of queued.slice(0, 5)) {
      expect(statement).toContain(q.question);
      for (const url of q.evidenceUrls) expect(statement).toContain(url);
    }

    const asked = await getDb().all<{ detail: string }>('SELECT detail FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, LOOP_QUESTIONS_ASKED_EVENT]);
    expect(asked).toHaveLength(1);
    const detail = JSON.parse(asked[0]!.detail) as { roundId: string; keys: string[]; deepening: string[] };
    expect(detail.roundId).toBe(roundId);
    expect(detail.deepening.sort()).toEqual(queued.slice(0, 5).map((q) => q.key).sort());
    expect(detail.keys).toEqual(expect.arrayContaining(detail.deepening));
    // Consumed once: a recent ask is not repeated.
    const left = await pendingDeepeningQuestions(projectId, new Date(), 100);
    expect(left.some((q) => detail.deepening.includes(q.key))).toBe(false);
  });

  it('with no deepening capacity nothing is promoted and nothing is put to verification', async () => {
    await seed();
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(pass.deepening!.promoted).toEqual([]);
    expect(pass.deepening!.questions).toEqual([]);
    expect(await pendingDeepeningQuestions(projectId, new Date())).toEqual([]);
  });
});
