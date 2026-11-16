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
import { DECISION_CAP_EVENT, DECISION_PASS_LIMIT, decideOpenings, decisionOrder, UNDATED_RESERVED_EVERY } from '../server/services/cash/decisions.ts';
import { closingInstant } from '../server/services/cash/worthResearching.ts';
import { currentDecision } from '../server/repos/cashDecisions.ts';
import { handedOpeningsOutcome, judgeHandedOpenings } from '../server/services/improvement/loop.ts';
import { MEASURE_MAX_HOURS } from '../server/domain/improvement.ts';

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

  it('under overload keeps a reserved share of places for undated openings, newest first (review finding F2)', () => {
    // More dated openings than any cap: pure EDF would never reach an undated one.
    const dated = Array.from({ length: 20 }, (_, i) => o(`dated-${i}`, new Date(NOW.getTime() + (i + 1) * DAY).toISOString()));
    const input = [o('newest-undated', null), ...dated, o('older-undated', null), o('oldest-undated', null)];
    const order = decisionOrder(input, now).map((one) => one.id);
    expect(order).toHaveLength(input.length);
    expect(new Set(order).size).toBe(input.length);
    // Every UNDATED_RESERVED_EVERY-th place goes to the next undated opening, in arrival order.
    expect(UNDATED_RESERVED_EVERY).toBeGreaterThan(1);
    expect(order[UNDATED_RESERVED_EVERY - 1]).toBe('newest-undated');
    expect(order[2 * UNDATED_RESERVED_EVERY - 1]).toBe('older-undated');
    expect(order[3 * UNDATED_RESERVED_EVERY - 1]).toBe('oldest-undated');
    // The dated ones keep every other place, earliest close first.
    expect(order.filter((id) => id.startsWith('dated-'))).toEqual(dated.map((one) => one.id));
    // So any cap of k places decides at least floor(k / UNDATED_RESERVED_EVERY) undated openings.
    for (let k = 1; k <= input.length; k += 1) {
      const undatedTaken = order.slice(0, k).filter((id) => id.endsWith('-undated')).length;
      expect(undatedTaken).toBeGreaterThanOrEqual(Math.min(3, Math.floor(k / UNDATED_RESERVED_EVERY)));
    }
  });

  it('gives the remaining places to whichever queue still has openings', () => {
    const input = [o('u1', null), o('u2', null), o('u3', null), o('u4', null), o('u5', null), o('d1', '2026-11-18')];
    expect(decisionOrder(input, now).map((one) => one.id)).toEqual(['d1', 'u1', 'u2', 'u3', 'u4', 'u5']);
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

  it('at the production cap, a closing opening behind more decidable openings than the cap is decided on every tick until it closes (review finding R3-F2)', async () => {
    // Production calls decideOpenings(projectId, { now }) with no limit (operate.ts): drive exactly that.
    const closing = await opening('JPFans buyer request (closes 2026-11-20)', 10_000, '2026-11-20');
    const newer = 3;
    for (let i = 0; i < DECISION_PASS_LIMIT + newer; i += 1) await opening(`undated ${i}`, 9_000 - i);
    const closesAt = closingInstant('2026-11-20')!;

    // A tick a day from the gap's reading to the close, each one inside the window.
    const ticks = [0, 1, 2, 3, 4].map((d) => new Date(NOW.getTime() + d * DAY)).filter((t) => t.getTime() < closesAt);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    let decidedBeforeClose = 0;
    for (const tick of ticks) {
      // The failure class: in arrival order the closing opening sits past the cap on every tick,
      // so the old walk ended every pass before reaching it and it reached its close undecided.
      const arrival = (await listOpportunities({ projectId, states: ['DISCOVERED', 'EVIDENCE_CARD', 'READY'] })).map((one) => one.id);
      expect(arrival.indexOf(closing)).toBeGreaterThanOrEqual(DECISION_PASS_LIMIT);

      const pass = await decideOpenings(projectId, { now: tick.toISOString() });
      // The production cap binds here, and the pass says so in its own counts.
      expect(pass.considered).toBe(DECISION_PASS_LIMIT);
      expect(pass.pastCap).toEqual({ dated: 0, undated: DECISION_PASS_LIMIT + newer + 1 - DECISION_PASS_LIMIT });

      const decision = await currentDecision(closing, goalId);
      expect(decision).not.toBeNull();
      expect(Date.parse(decision!.decidedAt)).toBeLessThan(closesAt);
      decidedBeforeClose += 1;
    }
    // Never left undecided at its close: every tick inside the window decided it.
    expect(decidedBeforeClose).toBe(ticks.length);

    // The cap binding is a production row, not an inference — and an unchanged backlog writes it once.
    const capRows = await getDb().all<{ detail: string }>('SELECT detail FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, DECISION_CAP_EVENT]);
    expect(capRows).toHaveLength(1);
    expect(JSON.parse(capRows[0]!.detail)).toMatchObject({ limit: DECISION_PASS_LIMIT, considered: DECISION_PASS_LIMIT, pastCap: { dated: 0, undated: newer + 1 } });
  }, 120_000);

  it('records which dated openings the cap left when dated openings starve, with their closes', async () => {
    const limit = 2;
    const dated: string[] = [];
    for (let i = 0; i < 4; i += 1) dated.push(await opening(`dated ${i}`, 60 + i, new Date(NOW.getTime() + (i + 1) * DAY).toISOString()));
    const pass = await decideOpenings(projectId, { now: NOW.toISOString(), limit });
    expect(pass.pastCap).toEqual({ dated: 2, undated: 0 });
    const rows = await getDb().all<{ detail: string }>('SELECT detail FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, DECISION_CAP_EVENT]);
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail) as { datedLeft: { id: string }[] };
    expect(detail.datedLeft.map((one) => one.id)).toEqual([dated[2], dated[3]]);
    // A changed backlog is a new reading.
    await opening('dated 4', 70, new Date(NOW.getTime() + 5 * DAY).toISOString());
    await decideOpenings(projectId, { now: NOW.toISOString(), limit });
    expect((await getDb().all('SELECT id FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, DECISION_CAP_EVENT]))).toHaveLength(2);
  });

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

  it('under overload of dated openings still decides an undated one, and counts what the cap left (review finding F2)', async () => {
    const limit = UNDATED_RESERVED_EVERY;
    const undated = await opening('newest undated', 5);
    const dated: string[] = [];
    for (let i = 0; i < 2 * UNDATED_RESERVED_EVERY; i += 1) {
      dated.push(await opening(`dated ${i}`, 60 + i, new Date(NOW.getTime() + (i + 1) * DAY).toISOString()));
    }
    const pass = await decideOpenings(projectId, { now: NOW.toISOString(), limit });
    expect(pass.considered).toBe(limit);
    // Pure EDF would have filled every slot with dated openings; the reserved place decides the undated one.
    expect(await currentDecision(undated, goalId)).not.toBeNull();
    expect(await currentDecision(dated[0]!, goalId)).not.toBeNull();
    expect(await currentDecision(dated[dated.length - 1]!, goalId)).toBeNull();
    // Starvation on either side is in the record, not inferred.
    expect(pass.pastCap).toEqual({ dated: dated.length - (limit - 1), undated: 0 });
  });
});

describe('judging a MISSED_OPPORTUNITY hand-off by the openings it handed (review finding R2-F1)', () => {
  const kept = { decision: 'KEPT' as const, reason: 'Metric improved.', revert: false };
  const handed = [
    { id: 'undated', stateAtHandOff: 'DISCOVERED', expiresAt: null },
    { id: 'dated', stateAtHandOff: 'EVIDENCE_CARD', expiresAt: '2026-11-20' },
  ];
  const unpursued = new Map([
    ['undated', { state: 'DISCOVERED', expiresAt: null }],
    ['dated', { state: 'EVIDENCE_CARD', expiresAt: '2026-11-20' }],
  ]);

  it('counts an undated unpursued opening as still open, however much time passes', () => {
    const outcome = handedOpeningsOutcome(handed, unpursued, new Date('2027-06-01T00:00:00.000Z'));
    expect(outcome).toMatchObject({ handed: 2, pursued: 0, stillOpen: 1, expiredUnpursued: 1, missing: 0 });
  });

  it('withholds a KEPT while a handed opening is still open, within the measurement bound', () => {
    const outcome = handedOpeningsOutcome(handed, unpursued, NOW);
    expect(outcome.stillOpen).toBe(2);
    expect(judgeHandedOpenings(kept, outcome, 24).decision).toBeNull();
    expect(judgeHandedOpenings(kept, outcome, MEASURE_MAX_HOURS - 1).decision).toBeNull();
  });

  it('decides KEPT_NO_EFFECT once the bound has passed with an undated opening still unpursued, rather than never', () => {
    const outcome = handedOpeningsOutcome(handed, unpursued, new Date('2027-06-01T00:00:00.000Z'));
    expect(outcome.stillOpen).toBeGreaterThan(0);
    const judged = judgeHandedOpenings(kept, outcome, MEASURE_MAX_HOURS);
    expect(judged.decision).toBe('KEPT_NO_EFFECT');
    expect(judged.revert).toBe(false);
    // A later tick still decides: there is no reachable state where it stays null for ever.
    expect(judgeHandedOpenings(kept, outcome, MEASURE_MAX_HOURS * 10).decision).toBe('KEPT_NO_EFFECT');
  });

  it('keeps the KEPT when a handed opening was pursued, and leaves a regression or pending reading as measured', () => {
    const pursued = new Map(unpursued);
    pursued.set('dated', { state: 'EXECUTING', expiresAt: '2026-11-20' });
    expect(judgeHandedOpenings(kept, handedOpeningsOutcome(handed, pursued, NOW), 1).decision).toBe('KEPT');
    const outcome = handedOpeningsOutcome(handed, unpursued, NOW);
    const reverted = { decision: 'REVERTED' as const, reason: 'Regressed.', revert: true };
    expect(judgeHandedOpenings(reverted, outcome, 1)).toEqual(reverted);
    const pending = { decision: null, reason: 'Still measuring.', revert: false };
    expect(judgeHandedOpenings(pending, outcome, 1)).toEqual(pending);
  });
});

/**
 * The contact step reaches READY pieces in the same deadline order
 * (`operate.ts readyContactOrder`, read by `advanceWithinAuthority` under
 * MAX_CONTACTS_PER_PASS): a READY piece closing in days is not left behind
 * older undated ones while the per-pass cap is spent on them.
 */
describe('readyContactOrder (pure): which READY pieces the contact cap reaches first', async () => {
  const { MAX_CONTACTS_PER_PASS, readyContactOrder } = await import('../server/services/cash/operate.ts');
  const now = NOW.toISOString();
  const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10);
  const piece = (id: string, expiresAt: string | null) => ({ id, expiresAt });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const none = { now, salesOrder: [] as string[], prioritized: new Set<string>() };

  it('a closing READY piece is reached before older undated ones, inside the per-pass cap', () => {
    const older = Array.from({ length: MAX_CONTACTS_PER_PASS + 2 }, (_, i) => piece(`old-${i}`, null));
    const ordered = readyContactOrder([...older, piece('closing', day(3))], none);
    expect(ordered[0]!.id).toBe('closing');
    expect(ids(ordered.slice(0, MAX_CONTACTS_PER_PASS))).toContain('closing');
  });

  it('dated pieces go earliest deadline first, and an ISO instant is read as its instant', () => {
    const ordered = readyContactOrder([piece('late', day(9)), piece('soon', day(2)), piece('mid', `${day(5)}T08:00:00.000Z`)], none);
    expect(ids(ordered)).toEqual(['soon', 'mid', 'late']);
  });

  it('a current PRIORITIZE decision outranks sales order among undated pieces', () => {
    const ordered = readyContactOrder([piece('a', null), piece('b', null), piece('c', null)], { now, salesOrder: ['a', 'b', 'c'], prioritized: new Set(['c']) });
    expect(ids(ordered)).toEqual(['c', 'a', 'b']);
  });

  it('a PRIORITIZE decision outranks a date: an undated prioritized piece goes ahead of a dated one without it (R4-F2)', () => {
    const ordered = readyContactOrder([piece('dated', day(4)), piece('prio', null)], { now, salesOrder: [], prioritized: new Set(['prio']) });
    expect(ids(ordered)).toEqual(['prio', 'dated']);
  });

  it('among prioritized pieces, the earliest window still goes first', () => {
    const ordered = readyContactOrder([piece('p-undated', null), piece('p-late', day(8)), piece('p-soon', day(2)), piece('plain-soon', day(1))], {
      now,
      salesOrder: [],
      prioritized: new Set(['p-undated', 'p-late', 'p-soon']),
    });
    expect(ids(ordered).slice(0, 2)).toEqual(['p-soon', 'p-late']);
    expect(ids(ordered).indexOf('p-undated')).toBeLessThan(ids(ordered).indexOf('plain-soon'));
  });

  it('a steady supply of dated pieces cannot starve an undated one: it holds a place inside every pass (R4-F2)', () => {
    const datedPieces = Array.from({ length: MAX_CONTACTS_PER_PASS * 3 }, (_, i) => piece(`dated-${i}`, day(1 + i)));
    const ordered = readyContactOrder([...datedPieces, piece('undated', null)], none);
    expect(ids(ordered.slice(0, MAX_CONTACTS_PER_PASS))).toContain('undated');
    // The rest of the pass still goes to the earliest windows, in order.
    expect(ids(ordered.slice(0, MAX_CONTACTS_PER_PASS)).filter((id) => id !== 'undated')).toEqual(['dated-0', 'dated-1'].slice(0, MAX_CONTACTS_PER_PASS - 1));
  });

  it('every reserved place goes to the next undated piece while any remain, then dated fill the rest', () => {
    const datedPieces = Array.from({ length: 6 }, (_, i) => piece(`d${i}`, day(1 + i)));
    const undatedPieces = [piece('u0', null), piece('u1', null)];
    const ordered = ids(readyContactOrder([...undatedPieces, ...datedPieces], none));
    const every = MAX_CONTACTS_PER_PASS;
    expect(ordered[every - 1]).toBe('u0');
    expect(ordered[2 * every - 1]).toBe('u1');
    expect(ordered.filter((id) => id.startsWith('d'))).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('an undated PRIORITIZE piece is reached in the first pass however many dated pieces wait', () => {
    const datedPieces = Array.from({ length: 10 }, (_, i) => piece(`dated-${i}`, day(1 + i)));
    const ordered = readyContactOrder([...datedPieces, piece('prio', null)], { now, salesOrder: [], prioritized: new Set(['prio']) });
    expect(ordered[0]!.id).toBe('prio');
  });

  it('sales order breaks ties, and pieces it does not name keep row order after those it does', () => {
    const ordered = readyContactOrder([piece('x', null), piece('y', null), piece('b', null), piece('a', null)], { now, salesOrder: ['a', 'b'], prioritized: new Set() });
    expect(ids(ordered)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('an already-closed window sorts as undated, never ahead of an open one', () => {
    const ordered = readyContactOrder([piece('closed', day(-2)), piece('undated', null), piece('open', day(6))], { now, salesOrder: ['undated', 'closed'], prioritized: new Set() });
    expect(ordered[0]!.id).toBe('open');
    // Closed and undated compare on sales order alone: the past date earns no place.
    expect(ids(ordered)).toEqual(['open', 'undated', 'closed']);
  });

  it('an unparseable date is undated, not a deadline', () => {
    const ordered = readyContactOrder([piece('junk', 'next Tuesday'), piece('open', day(1))], none);
    expect(ids(ordered)).toEqual(['open', 'junk']);
  });

  it('is pure: the input order is left as it was', () => {
    const input = [piece('u', null), piece('d', day(2))];
    readyContactOrder(input, none);
    expect(ids(input)).toEqual(['u', 'd']);
  });
});
