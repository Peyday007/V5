/**
 * ORIGINATED:MISSED_OPPORTUNITY:DISCOVERED, the engine-question path.
 *
 * Production, 2026-11-12: 14 of 14 openings whose window ended expired while
 * still DISCOVERED. Under MAX_OPEN_ENGINE_QUESTIONS the question pass ranked by
 * fewest blanks and never read a recorded expiresAt, so a dated solicitation
 * with more blanks was never inside the cap before its window shut.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_OPEN_ENGINE_QUESTIONS,
  compareQuestionCandidates,
  reconcileEngineGaps,
  type QuestionCandidate,
} from '../server/services/cash/operate.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { CAPACITY_DEFERRAL_EVENT } from '../server/services/cash/validation.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';

const NOW = '2026-11-12T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): string {
  return new Date(Date.parse(NOW) + days * DAY).toISOString();
}

function candidate(
  name: string,
  fields: number,
  expiresAt: string | null,
  contribution: number | null = 1000,
): QuestionCandidate & { name: string } {
  return {
    name,
    opportunity: { expiresAt, peakFundingCents: 500, createdAt: `2026-10-01T00:00:${String(fields).padStart(2, '0')}.000Z` },
    fields: Array.from({ length: fields }, (_, i) => `field${i}`),
    contribution,
  };
}

/** Which openings get a question slot, one slot per field, as the pass spends them. */
function admitted(list: (QuestionCandidate & { name: string })[]): Set<string> {
  const out = new Set<string>();
  let slots = MAX_OPEN_ENGINE_QUESTIONS;
  for (const one of [...list].sort((a, b) => compareQuestionCandidates(a, b, NOW))) {
    for (const _field of one.fields) {
      if (slots === 0) return out;
      out.add(one.name);
      slots -= 1;
    }
  }
  return out;
}

describe('engine questions are raised Earliest Deadline First', () => {
  it('admits a dated opening with more blanks inside the cap ahead of undated ones', () => {
    const undated = Array.from({ length: MAX_OPEN_ENGINE_QUESTIONS }, (_, i) => candidate(`undated-${i}`, 1, null));
    const solicitation = candidate('solicitation', 4, inDays(10));
    const got = admitted([...undated, solicitation]);
    expect(got.has('solicitation')).toBe(true);
    expect(got.size).toBe(1 + (MAX_OPEN_ENGINE_QUESTIONS - 4));
  });

  it('orders two dated openings earliest window first, whatever their blanks', () => {
    const later = candidate('later', 1, inDays(20));
    const sooner = candidate('sooner', 5, inDays(8));
    const sorted = [later, sooner].sort((a, b) => compareQuestionCandidates(a, b, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['sooner', 'later']);
  });

  it('reads a date-only expiresAt as the end of that day', () => {
    const dateOnly = candidate('date-only', 3, inDays(9).slice(0, 10));
    const timed = candidate('timed', 1, inDays(12));
    const sorted = [timed, dateOnly].sort((a, b) => compareQuestionCandidates(a, b, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['date-only', 'timed']);
  });

  it('keeps the existing order for undated openings', () => {
    const a = candidate('two-blanks', 2, null, 5000);
    const b = candidate('one-blank-small', 1, null, 100);
    const c = candidate('one-blank-large', 1, null, 9000);
    const d = candidate('one-blank-unknown', 1, null, null);
    const sorted = [a, b, c, d].sort((x, y) => compareQuestionCandidates(x, y, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['one-blank-large', 'one-blank-small', 'one-blank-unknown', 'two-blanks']);
  });

  it('gives no deadline priority to a window already inside the research runway, or an unparseable one', () => {
    const closing = candidate('closing', 3, inDays(1));
    const garbage = candidate('garbage', 3, 'next Tuesday');
    const undated = candidate('undated', 1, null);
    const sorted = [closing, garbage, undated].sort((x, y) => compareQuestionCandidates(x, y, NOW));
    expect(sorted[0]!.name).toBe('undated');
  });
});

/*
 * The same property through `reconcileEngineGaps` itself, against a database:
 * the real candidate filters (dives spent, worth researching, tier), the real
 * raiseNeed and the real cap. A later change to that loop is caught here, where
 * the slot model above cannot see it.
 */
describe('reconcileEngineGaps raises a dated opening\'s questions inside the cap', () => {
  let projectId = '';
  let userId = '';
  const ENGINE = ['revenueRange', 'directCosts', 'requiredCapital', 'timeToFirstCash', 'laborNeeds'];

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    userId = (await createUser({
      email: `edf-q-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Usable cash, quickly.' })).ok).toBe(true);
  });

  /** A CANDIDATE whose dives are spent, with `blank` engine fields left to ask. */
  async function spentCandidate(title: string, blank: number, expiresAt: string | null): Promise<string> {
    const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
    if (!captured.ok) throw new Error(captured.reason);
    const id = captured.value.id;
    await fillCard({
      opportunityId: id,
      actorRef: userId,
      patch: {
        payer: 'The drainage authority',
        reachableChannel: 'procurement@authority.example',
        buyingSignal: `Request published: ${title}`,
        signalObservedAt: '2026-10-15T09:00:00.000Z',
        offerScope: title,
        acceptanceCondition: 'Delivered as specified',
        priceCents: 200_000,
        deliveryMethod: 'A report by email',
        fulfillmentOwner: 'Brain',
        peakFundingCents: 0,
      },
    });
    const ask = new Set(ENGINE.slice(0, blank));
    for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
      if (ask.has(field)) continue;
      await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `Answered: ${field}.`, decidedBy: userId });
    }
    await getDb().run(
      `UPDATE cash_opportunities SET validation_state = 'BLOCKED', validation_rounds = 2, source_claim_id = NULL, expires_at = ? WHERE id = ?`,
      [expiresAt, id],
    );
    return id;
  }

  const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
  const askedFor = (raised: { opportunityId: string }[], id: string) => raised.filter((one) => one.opportunityId === id).length;

  it('asks every blank of a solicitation closing in 10 days, though six undated openings with fewer blanks fill the cap', async () => {
    // Six undated openings with two blanks each: twelve questions, exactly the cap.
    const undated: string[] = [];
    for (let i = 0; i < MAX_OPEN_ENGINE_QUESTIONS / 2; i += 1) undated.push(await spentCandidate(`Ongoing parcel research ${i}`, 2, null));
    const solicitation = await spentCandidate("Solicitation N0010426QAC01 'DUST PLUG'", 5, fromNow(10 * DAY));
    const raised = await reconcileEngineGaps(projectId);
    expect(raised.length).toBe(MAX_OPEN_ENGINE_QUESTIONS);
    expect(askedFor(raised, solicitation)).toBe(5);
    // The rest of the cap still goes to the undated openings, in their existing order.
    expect(undated.reduce((n, id) => n + askedFor(raised, id), 0)).toBe(MAX_OPEN_ENGINE_QUESTIONS - 5);
  });

  it('asks the earlier window first, and gives no priority to one already inside the runway', async () => {
    const later = await spentCandidate('A solicitation closing in 20 days', 5, fromNow(20 * DAY));
    const sooner = await spentCandidate('Solicitation 140LL027Q0005, signage project', 5, fromNow(8 * DAY));
    const undated = await spentCandidate('Ongoing bookkeeping request', 5, null);
    const inside = await spentCandidate('A solicitation closing tomorrow', 1, fromNow(24 * 60 * 60 * 1000));
    const raised = await reconcileEngineGaps(projectId);
    expect(raised.length).toBe(MAX_OPEN_ENGINE_QUESTIONS);
    const order = [...new Set(raised.map((one) => one.opportunityId))];
    expect(order).toEqual([sooner, later, undated]);
    expect(askedFor(raised, undated)).toBe(MAX_OPEN_ENGINE_QUESTIONS - 10);
    // One blank, so the old fewest-blanks order would have asked it first; its window is inside the runway.
    expect(askedFor(raised, inside)).toBe(0);
  });
  /*
   * Review of the EDF change (2026-11-12): "they waited for a slot" must be read
   * from rows, not asserted. Through the production pass: a dated opening an
   * order could still save, left with blanks because the cap is full, gets one
   * CAPACITY_DEFERRAL_EVENT row carrying the cap reading; an undated opening and
   * one already inside the runway get none, and repeating the pass adds nothing.
   */
  it('records a capacity row for a dated opening the full cap leaves waiting, and only for it', async () => {
    const sooner = await spentCandidate('Solicitation 140LL027Q0005, signage project', 5, fromNow(8 * DAY));
    const middle = await spentCandidate('A solicitation closing in 15 days', 5, fromNow(15 * DAY));
    const later = await spentCandidate("Solicitation N0010426QAC01 'DUST PLUG'", 5, fromNow(20 * DAY));
    const undated = await spentCandidate('Ongoing bookkeeping request', 2, null);
    const inside = await spentCandidate('A solicitation closing tomorrow', 1, fromNow(24 * 60 * 60 * 1000));

    const first = await reconcileEngineGaps(projectId);
    expect(first.length).toBe(MAX_OPEN_ENGINE_QUESTIONS);
    expect(askedFor(first, sooner) + askedFor(first, middle)).toBe(10);
    expect(askedFor(first, later)).toBe(MAX_OPEN_ENGINE_QUESTIONS - 10);

    // The cap is full and `later` still has blanks: this pass is where it waits.
    expect(await reconcileEngineGaps(projectId)).toEqual([]);
    const rows = await cashEventsOfKind(later, CAPACITY_DEFERRAL_EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      lane: 'ENGINE_QUESTION',
      atDiscovery: 'ORDERABLE',
      openQuestions: MAX_OPEN_ENGINE_QUESTIONS,
      cap: MAX_OPEN_ENGINE_QUESTIONS,
    });
    for (const id of [sooner, middle, undated, inside]) expect(await cashEventsOfKind(id, CAPACITY_DEFERRAL_EVENT)).toEqual([]);

    // The same contention on the next tick is not new evidence.
    await reconcileEngineGaps(projectId);
    expect(await cashEventsOfKind(later, CAPACITY_DEFERRAL_EVENT)).toHaveLength(1);
  });
});
