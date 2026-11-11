/**
 * CAUSAL-14-7 (S-0136..S-0141), against a real database: Brain actively
 * acquires the market history an opening lacks. Each missing kind of record
 * (bid/win, transaction counts, actual prices) is handed to research through
 * the owners that already exist — a `cash_needs` row under a stable key and an
 * idea captured at the research entrance — and once research lands as an
 * evidence fact on the opening, the next acquisition reads and uses it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { forgetKnowledge, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { acquireMarketHistory, requestMarketHistory } from '../server/services/quant/history.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let opening: CashOpportunity;

beforeEach(async () => {
  forgetKnowledge();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `history-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const activated = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  expect(activated.ok).toBe(true);
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'Subcontracted office cleaning',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    industry: 'commercial cleaning',
  });
  if (!captured.ok) throw new Error(captured.reason);
  opening = (await getOpportunity(captured.value.id))!;
});

afterAll(async () => {
  await teardown();
});

describe('Brain acquires the history a market lacks (CAUSAL-14-7)', () => {
  it('hands every missing kind of record to research, once, and reads the answer when it lands', async () => {
    const before = acquireMarketHistory(await loadCashKnowledge(projectId), opening);
    expect(before.winRate).toBeNull();
    expect(before.gaps.map((g) => g.kind).sort()).toEqual(['BID_WIN', 'PRICES', 'TRANSACTIONS']);

    const sent = await requestMarketHistory({ projectId, actorRef: userId, opportunity: opening, history: before });
    expect(sent.refused).toEqual([]);
    expect(sent.requested.map((r) => r.kind).sort()).toEqual(['BID_WIN', 'PRICES', 'TRANSACTIONS']);
    for (const one of sent.requested) {
      expect(one.candidateId).toBeTruthy();
      const candidate = await getCandidate(one.candidateId!);
      expect(candidate?.projectId).toBe(projectId);
      expect(candidate?.statement).toContain(one.question);
    }
    const needs = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`market-history:${opening.id}:`));
    expect(needs).toHaveLength(3);
    expect(needs.every((n) => n.opportunityId === opening.id)).toBe(true);

    // Asking again returns the open rows; the review is not flooded.
    const again = await requestMarketHistory({ projectId, actorRef: userId, opportunity: opening, history: before });
    expect(again.requested.map((r) => r.needId).sort()).toEqual(sent.requested.map((r) => r.needId).sort());
    expect(again.requested.map((r) => r.candidateId).sort()).toEqual(sent.requested.map((r) => r.candidateId).sort());
    expect((await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`market-history:${opening.id}:`))).toHaveLength(3);

    // Research lands as an evidence fact on the opening; the next acquisition uses it.
    await recordCardFact({
      projectId,
      opportunityId: opening.id,
      field: 'buyingEvidence',
      kind: 'EVIDENCE',
      value: 'Regional janitorial subcontractors won 42 of 180 bids on municipal cleaning tenders in 2025.',
      decidedBy: 'research',
    });
    forgetKnowledge();
    const after = acquireMarketHistory(await loadCashKnowledge(projectId), opening);
    expect(after.winRate).toEqual({ wins: 42, bids: 180, rate: 42 / 180 });
    expect(after.sampleSize).toBe(180);
    expect(after.gaps.map((g) => g.kind)).not.toContain('BID_WIN');
  });

  it('sends nothing for a market whose record is already held', async () => {
    await recordCardFact({
      projectId,
      opportunityId: opening.id,
      field: 'buyingEvidence',
      kind: 'EVIDENCE',
      value: 'Firms won 30 of 120 bids. The market let 1,240 contracts awarded last year. Buyers paid $1,800 per contract on average.',
      decidedBy: 'research',
    });
    const history = acquireMarketHistory(await loadCashKnowledge(projectId), opening);
    expect(history.gaps).toEqual([]);
    const sent = await requestMarketHistory({ projectId, actorRef: userId, opportunity: opening, history });
    expect(sent.requested).toEqual([]);
    expect((await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith('market-history:'))).toHaveLength(0);
  });
});
