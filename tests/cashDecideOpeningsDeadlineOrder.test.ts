/**
 * The decision producer takes its capped slots Earliest Deadline First.
 *
 * Production, 2026-11-16 (ORIGINATED:MISSED_OPPORTUNITY:CLOSING): openings
 * closing within five days — the PRPA RFP 26-152-P, JPFans closing 2026-11-20 —
 * stayed unpursued. `decideOpenings` walked the decidable openings newest first
 * and stopped at `limit` goal-opening pairs, and every unchanged pair still
 * used up the cap. An older opening with a recorded close a few days away sat
 * past the cap on every tick, never got a decision, and the lifecycle had
 * nothing to PRIORITIZE it on before its window ended.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listOpportunities, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { decideOpenings, decisionOrder } from '../server/services/cash/decisions.ts';
import { currentDecision } from '../server/repos/cashDecisions.ts';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

describe('decisionOrder (pure)', () => {
  const now = NOW.toISOString();
  const o = (id: string, expiresAt: string | null) => ({ id, expiresAt });

  it('puts a recorded future close first, earliest first, and keeps the arrival order for the rest', () => {
    // Arrival order, as listOpportunities returns it: newest first.
    const input = [
      o('new-undated', null),
      o('closes-in-9d', new Date(NOW.getTime() + 9 * DAY).toISOString()),
      o('mid-undated', null),
      o('closes-2026-11-20', '2026-11-20'),
      o('old-undated', null),
    ];
    expect(decisionOrder(input, now).map((one) => one.id)).toEqual([
      'closes-2026-11-20',
      'closes-in-9d',
      'new-undated',
      'mid-undated',
      'old-undated',
    ]);
  });

  it('reads a date-only close as the end of that day, the way closingInstant does', () => {
    const input = [o('later-today', '2026-11-16T18:00:00.000Z'), o('end-of-today', '2026-11-16')];
    expect(decisionOrder(input, now).map((one) => one.id)).toEqual(['later-today', 'end-of-today']);
  });

  it('treats an unreadable or already-passed close as undated, keeping its arrival place', () => {
    const input = [
      o('unreadable', 'next Tuesday'),
      o('passed', '2026-11-01'),
      o('dated', '2026-11-18'),
      o('undated', null),
    ];
    expect(decisionOrder(input, now).map((one) => one.id)).toEqual(['dated', 'unreadable', 'passed', 'undated']);
  });

  it('is stable for equal closes and does not mutate its input', () => {
    const input = [o('a', '2026-11-18'), o('b', null), o('c', '2026-11-18')];
    const copy = input.map((one) => ({ ...one }));
    expect(decisionOrder(input, now).map((one) => one.id)).toEqual(['a', 'c', 'b']);
    expect(input).toEqual(copy);
  });
});

describe('decideOpenings under its cap (the recorded failure class)', () => {
  let projectId = '';
  let userId = '';
  let cashModeId = '';
  let goalId = '';

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `edf-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
    cashModeId = (await getCashMode(projectId))!.id;
    const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, capitalCeilingCents: 500_000, now: new Date(NOW.getTime() - 60_000) });
    expect(set.ok).toBe(true);
    goalId = g.id;
  });

  /** A decidable opening filed `ageMinutes` before NOW, with an optional recorded close. */
  async function opening(title: string, ageMinutes: number, expiresAt: string | null = null): Promise<string> {
    const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: null, source: 'A publisher', ...(expiresAt ? { expiresAt } : {}) });
    await updateOpportunity(o.id, { peak_funding_cents: 100_000 });
    await getDb().run('UPDATE cash_opportunities SET created_at = ? WHERE id = ?', [new Date(NOW.getTime() - ageMinutes * 60_000).toISOString(), o.id]);
    return o.id;
  }

  it('an older opening closing within 5 days takes a capped slot ahead of newer undated ones', async () => {
    const limit = 3;
    // The closing opening was filed first: it is the oldest.
    const closing = await opening('PRPA RFP 26-152-P — zero-emission forklifts', 60, '2026-11-20');
    // Newer undated openings: more of them than the cap.
    const u1 = await opening('undated 1 (oldest)', 40);
    const u2 = await opening('undated 2', 30);
    const u3 = await opening('undated 3', 20);
    const u4 = await opening('undated 4 (newest)', 10);

    // Before the change the producer walked this order and stopped at `limit`:
    // the closing opening sat past the cap.
    const arrival = (await listOpportunities({ projectId, states: ['DISCOVERED', 'EVIDENCE_CARD', 'READY'] })).map((one) => one.id);
    expect(arrival).toEqual([u4, u3, u2, u1, closing]);
    expect(arrival.indexOf(closing)).toBeGreaterThanOrEqual(limit);

    const pass = await decideOpenings(projectId, { now: NOW.toISOString(), limit });
    expect(pass.goals).toBe(1);
    expect(pass.considered).toBe(limit);

    // After: the closing opening has a current decision...
    expect(await currentDecision(closing, goalId)).not.toBeNull();
    // ...and the remaining slots went to the undated openings newest first.
    expect(await currentDecision(u4, goalId)).not.toBeNull();
    expect(await currentDecision(u3, goalId)).not.toBeNull();
    expect(await currentDecision(u2, goalId)).toBeNull();
    expect(await currentDecision(u1, goalId)).toBeNull();
  });

  it('keeps the closing opening first on every later tick, while unchanged pairs still use up the cap', async () => {
    const limit = 2;
    const closing = await opening('JPFans buyer request', 60, '2026-11-20');
    for (let i = 0; i < 4; i += 1) await opening(`undated ${i}`, 50 - i * 10);
    await decideOpenings(projectId, { now: NOW.toISOString(), limit });
    const first = await currentDecision(closing, goalId);
    expect(first).not.toBeNull();
    // A new fact on the closing opening is decided on the next tick, even though
    // the newer openings' unchanged pairs still take up slots.
    await updateOpportunity(closing, { peak_funding_cents: 900_000 });
    await decideOpenings(projectId, { now: NOW.toISOString(), limit });
    const second = await currentDecision(closing, goalId);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.verdict).toBe('REJECT');
  });
});
