/**
 * Decisions: one current REJECT / HOLD / PRIORITIZE per opportunity per goal,
 * from that goal's own limits, recomputed once per distinct change, and never
 * over a person's archive or decline.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  currentDecision, decisionCounts, decisionHistory, requestDecisionRecompute,
} from '../server/repos/cashDecisions.ts';
import {
  decideOpportunity, limitsChangeRef, recomputeFlaggedDecisions,
} from '../server/services/cash/decisions.ts';
import type { ScreenFacts, ScreenLimits } from '../server/services/cash/screen.ts';

let projectId = '';
let modeId = '';
let userId = '';
const NOW = '2026-10-30T00:00:00.000Z';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({
    email: `decide-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  modeId = (await getCashMode(projectId))!.id;
});

async function piece(title: string): Promise<string> {
  return (await createOpportunity({ projectId, cashModeId: modeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' })).id;
}

const facts = (over: Partial<ScreenFacts> = {}): ScreenFacts => ({
  capitalRequiredCents: 500_000, noCapitalRoute: null, daysToPayment: 10, expiresAt: null, duplicateOf: null,
  requirements: [], capabilities: [], exclusions: [], hasPayer: true, hasPrice: true, typeHasHistory: true,
  sourceObservedAt: NOW, ...over,
});
const limits = (over: Partial<ScreenLimits> = {}): ScreenLimits => ({
  metric: 'COLLECTED_CASH', daysLeft: 30, capitalCeilingCents: 1_000_000, capitalBeforeProofCents: null, ...over,
});

describe('decisions per goal', () => {
  it('differ between two goals over the same opportunity', async () => {
    const id = await piece('A');
    const loose = limits();
    const tight = limits({ capitalCeilingCents: 100_000, daysLeft: 5 });
    await decideOpportunity({ projectId, opportunityId: id, goalId: 'goal_loose', facts: facts(), limits: loose, changeRef: limitsChangeRef('goal_loose', loose), now: NOW });
    await decideOpportunity({ projectId, opportunityId: id, goalId: 'goal_tight', facts: facts(), limits: tight, changeRef: limitsChangeRef('goal_tight', tight), now: NOW });
    expect((await currentDecision(id, 'goal_loose'))?.verdict).toBe('PRIORITIZE');
    const rejected = await currentDecision(id, 'goal_tight');
    expect(rejected?.verdict).toBe('REJECT');
    expect(rejected?.reason).toBe('CAPITAL_TOO_HIGH');
    expect(rejected?.bindingConstraint).toBe('capital ceiling');
    expect(rejected?.reopenCondition).toMatch(/capital limit/);
  });

  it('holds on a missing fact and names it', async () => {
    const id = await piece('B');
    await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts({ hasPayer: false }), limits: limits(), changeRef: 'c1', now: NOW });
    const d = await currentDecision(id, 'g');
    expect(d?.verdict).toBe('HOLD');
    expect(d?.missingFacts).toEqual(['who pays']);
  });
});

describe('recompute', () => {
  it('a changed goal limit supersedes the decision exactly once and keeps history', async () => {
    const id = await piece('C');
    const tight = limits({ capitalCeilingCents: 100_000 });
    const first = await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts(), limits: tight, changeRef: limitsChangeRef('g', tight), now: NOW });
    expect(first.status).toBe('RECORDED');
    const raised = limits({ capitalCeilingCents: 2_000_000 });
    const ref = limitsChangeRef('g', raised);
    expect(ref).not.toBe(limitsChangeRef('g', tight));
    expect((await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts(), limits: raised, changeRef: ref, now: NOW })).status).toBe('RECORDED');
    expect((await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts(), limits: raised, changeRef: ref, now: NOW })).status).toBe('UNCHANGED');
    expect((await currentDecision(id, 'g'))?.verdict).toBe('PRIORITIZE');
    const history = await decisionHistory(id, 'g');
    expect(history.map((d) => [d.verdict, d.isCurrent])).toEqual([['REJECT', false], ['PRIORITIZE', true]]);
    expect(await decisionCounts(projectId, 'g')).toEqual({ REJECT: 0, HOLD: 0, PRIORITIZE: 1 });
  });

  it('recomputes a flagged decision once for new evidence, then stops', async () => {
    const id = await piece('D');
    await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts({ hasPayer: false }), limits: limits(), changeRef: 'c1', now: NOW });
    expect(await requestDecisionRecompute(id, 'FIELD:payer@t1', NOW)).toBe(1);
    const loaders = { limitsFor: async () => limits(), factsFor: async () => ({ facts: facts(), evidenceIds: ['clm_1'] }) };
    expect(await recomputeFlaggedDecisions(projectId, loaders, { now: NOW })).toEqual({ recomputed: 1, released: 0, deferred: 0 });
    const d = await currentDecision(id, 'g');
    expect(d?.verdict).toBe('PRIORITIZE');
    expect(d?.evidenceIds).toEqual(['clm_1']);
    expect(await recomputeFlaggedDecisions(projectId, loaders, { now: NOW })).toEqual({ recomputed: 0, released: 0, deferred: 0 });
    // Asking again for the ref that built the current decision does nothing.
    expect(await requestDecisionRecompute(id, 'FIELD:payer@t1', NOW)).toBe(0);
  });

  it('keeps a flag when the inputs cannot be read', async () => {
    const id = await piece('E');
    await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts({ hasPayer: false }), limits: limits(), changeRef: 'c1', now: NOW });
    await requestDecisionRecompute(id, 'x1', NOW);
    const blind = { limitsFor: async () => null, factsFor: async () => null };
    expect((await recomputeFlaggedDecisions(projectId, blind, { now: NOW })).deferred).toBe(1);
    expect((await currentDecision(id, 'g'))?.recomputeChangeRef).toBe('x1');
  });
});

describe('a person has decided', () => {
  it('never decides over an archived or declined opportunity', async () => {
    const id = await piece('F');
    await getDb().run(`UPDATE cash_opportunities SET state = 'ARCHIVED' WHERE id = ?`, [id]);
    expect((await decideOpportunity({ projectId, opportunityId: id, goalId: 'g', facts: facts(), limits: limits(), changeRef: 'c1', now: NOW })).status).toBe('PERSON_DECIDED');
    expect(await currentDecision(id, 'g')).toBeNull();
    const other = await piece('G');
    expect((await decideOpportunity({ projectId, opportunityId: other, goalId: 'g', facts: facts(), limits: limits(), changeRef: 'c1', now: NOW })).status).toBe('RECORDED');
    await getDb().run(`UPDATE cash_opportunities SET state = 'DECLINED' WHERE id = ?`, [other]);
    expect((await decideOpportunity({ projectId, opportunityId: other, goalId: 'g', facts: facts({ hasPayer: false }), limits: limits(), changeRef: 'c2', now: NOW })).status).toBe('PERSON_DECIDED');
    expect((await currentDecision(other, 'g'))?.verdict).toBe('PRIORITIZE');
  });

  it('refuses another project\'s opportunity', async () => {
    const id = await piece('H');
    expect((await decideOpportunity({ projectId: 'prj_other', opportunityId: id, goalId: 'g', facts: facts(), limits: limits(), changeRef: 'c1', now: NOW })).status).toBe('NO_SUCH_OPPORTUNITY');
  });
});
