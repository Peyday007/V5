/**
 * One reader of what was decided: the explanation a person reads is the
 * decision record's row, not a second derivation from the standing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { decideOpportunity, standingDecision } from '../server/services/cash/decisions.ts';
import { explainStanding } from '../server/services/cash/standingSurface.ts';
import { cashView } from '../server/services/cash/view.ts';
import { sharedCashView } from '../server/services/cash/shared.ts';
import type { CashDecision } from '../server/domain/cashDecisions.ts';
import type { ScreenFacts, ScreenLimits } from '../server/services/cash/screen.ts';

const NOW = new Date().toISOString();
const decision = (over: Partial<CashDecision> = {}): CashDecision => ({
  id: 'd1', projectId: 'p', opportunityId: 'o', goalId: 'g', verdict: 'REJECT', reason: 'CAPITAL_TOO_HIGH',
  detail: 'it needs 9000.00 of capital against a ceiling of 5000.00', bindingConstraint: 'capital ceiling', missingFacts: [],
  evidenceIds: ['clm_1'], reopenCondition: "the goal's capital limit changes, or a route needing no capital is named",
  changeRef: 'c', isCurrent: true, recomputeChangeRef: null, recomputeRequestedAt: null, decidedAt: NOW, supersededAt: null, ...over,
});

describe('explainStanding reads the decision', () => {
  it('takes the stance, reason, limit, missing facts and reopen condition from the row', () => {
    const e = explainStanding({ kind: 'WAITING', cause: null, keys: ['FIELD:payer'], hasSourceClaim: true, decision: decision(), privateDetail: true });
    expect(e.stance).toBe('REJECTED');
    expect(e.reason).toContain('more capital than the goal allows');
    expect(e.bindingLimit).toContain('capital ceiling');
    expect(e.reopenWhen).toEqual([decision().reopenCondition]);
    expect(e.missing).toEqual([]);
    const held = explainStanding({ kind: 'ADVANCING', cause: null, keys: [], hasSourceClaim: true, decision: decision({ verdict: 'HOLD', reason: 'MISSING_FACTS', bindingConstraint: null, missingFacts: ['who pays'] }) });
    expect(held.stance).toBe('HELD');
    expect(held.missing).toEqual(['who pays']);
  });

  it("never quotes the decision's own sentence to a member, and states no figure", () => {
    const e = explainStanding({ kind: 'WAITING', cause: null, keys: [], hasSourceClaim: true, decision: decision() });
    const text = [e.headline, e.reason, e.bindingLimit, ...e.reopenWhen].join(' ');
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain('capital ceiling');
  });

  it("does not replace a person's archive or decline, or a finished piece", () => {
    expect(explainStanding({ kind: 'NOT_WORTH_PURSUING', cause: 'ARCHIVED', keys: [], hasSourceClaim: true, decision: decision({ verdict: 'PRIORITIZE', reason: 'CLEAR' }) }).reason).toBe('A person put it away.');
    expect(explainStanding({ kind: 'DONE', cause: null, keys: [], hasSourceClaim: true, decision: decision({ verdict: 'PRIORITIZE' }) }).stance).toBe('DONE');
  });

  it('is unchanged when no decision is recorded', () => {
    expect(explainStanding({ kind: 'DORMANT', cause: 'ROUNDS_SPENT', keys: [], hasSourceClaim: true, decision: null }).reason).toBe('The bounded deep dives for what is known now are spent.');
  });
});

describe('which decision a piece with several goals is told by', () => {
  it('rejects only when every goal rejected, else prefers a prioritize, then a hold', () => {
    const r = decision({ goalId: 'a' });
    const p = decision({ goalId: 'b', verdict: 'PRIORITIZE', reason: 'CLEAR' });
    const h = decision({ goalId: 'c', verdict: 'HOLD', reason: 'MISSING_FACTS' });
    expect(standingDecision([])).toBeNull();
    expect(standingDecision([r, decision({ goalId: 'd' })])?.verdict).toBe('REJECT');
    expect(standingDecision([r, p, h])?.verdict).toBe('PRIORITIZE');
    expect(standingDecision([r, h])?.verdict).toBe('HOLD');
    expect(standingDecision([decision({ isCurrent: false })])).toBeNull();
  });
});

describe('the surfaces read the stored decision', () => {
  let projectId = '';
  let pieceId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    const userId = (await createUser({ email: `ex-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
    const modeId = (await getCashMode(projectId))!.id;
    pieceId = (await createOpportunity({ projectId, cashModeId: modeId, ownerUserId: userId, title: 'A piece', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' })).id;
  });

  const facts: ScreenFacts = {
    capitalRequiredCents: 900_000, noCapitalRoute: null, daysToPayment: 5, expiresAt: null, duplicateOf: null, requirements: [],
    capabilities: [], exclusions: [], hasPayer: true, hasPrice: true, typeHasHistory: true, sourceObservedAt: NOW,
  };
  const limits: ScreenLimits = { metric: 'COLLECTED_CASH', daysLeft: 30, capitalCeilingCents: 500_000, capitalBeforeProofCents: null };

  it('tells the owner and a member the recorded REJECT, with figures only for the owner', async () => {
    const before = (await cashView({ projectId })).myCurrentWork.standingSurface.explanations[pieceId];
    expect(before?.stance).not.toBe('REJECTED');
    const decided = await decideOpportunity({ projectId, opportunityId: pieceId, goalId: 'g1', facts, limits, changeRef: 'c-1', now: NOW });
    expect(decided.status).toBe('RECORDED');
    const owner = (await cashView({ projectId })).myCurrentWork.standingSurface.explanations[pieceId]!;
    expect(owner.stance).toBe('REJECTED');
    expect(owner.reason).toContain('more capital than the goal allows');
    expect(owner.bindingLimit).toContain('capital ceiling');
    const shared = await sharedCashView({ projectId });
    const member = shared.standing.explanations[pieceId];
    expect(member).toBeDefined();
    expect(member!.stance).toBe('REJECTED');
    expect(JSON.stringify(member)).not.toMatch(/\d{4}/);
  });
});
