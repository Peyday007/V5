/**
 * GOAL-09 repair, episode 1. Production (2026-11-10) failed `probe r01.goal-09`
 * on reading gpr_8c679e2aefba4625a30f, written by the Brain released before the
 * acceptance writer: its forecast carried no acceptance record. History is
 * never rewritten (CLAUDE.md §5); the writer instead guarantees that every row
 * it persists carries one that keeps the candidate/accepted separation, and
 * that a legacy row never stands as a goal's latest reading.
 *
 * Rows are written through `readGoalPlan({ persist: true })` and judged by the
 * probe's own `readingProblem`, never by constructed forecast JSON.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { executionPolicyForProject, forgetExecutionPolicies } from '../server/services/goals/policy.ts';
import {
  forecastCarriesAcceptance,
  judgeAcceptance,
  latestReading,
  listReadings,
  persistableVerdict,
  readGoalPlan,
  storableAcceptance,
  RECOMMENDATION_POLICY,
} from '../server/services/goals/plan.ts';
import { readingProblem } from '../server/services/factory/program/release01/acceptanceProbe.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';

let projectId = '';
let userId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetExecutionPolicies();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `g09-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goal(amountCents: number, days = 30): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

function judged(row: { verdict: string; forecast: string | null }): string | null {
  const acceptance = row.forecast ? (JSON.parse(row.forecast) as { acceptance?: unknown }).acceptance ?? null : null;
  return readingProblem(row.verdict, acceptance as Parameters<typeof readingProblem>[1], RECOMMENDATION_POLICY.requiredProbability);
}

function portfolio(basis: 'PROBABILITY' | 'COVERAGE', reach: number): GoalPortfolio {
  return {
    basis,
    worlds: 1000,
    best: { members: [{ opportunityId: 'cop_a', title: 'Opening A' }], reach, settledP50: 20_000 },
    missing: basis === 'COVERAGE' ? ['conversion is assumed, not measured'] : [],
    limits: { correlation: 0.3 },
  } as unknown as GoalPortfolio;
}

describe('GOAL-09: every persisted reading carries an acceptance that keeps the rule', () => {
  it('a goal with no candidate persists a NO_CANDIDATE reading the probe accepts, and stays pursued as SQUEEZE', async () => {
    const id = await goal(1_000_000);
    const reading = await readGoalPlan({ goalId: id, persist: true });
    expect(reading).not.toBeNull();
    const row = (await latestReading(id))!;
    expect(row).not.toBeNull();
    expect(forecastCarriesAcceptance(row.forecast)).toBe(true);
    const acceptance = JSON.parse(row.forecast!).acceptance;
    expect(acceptance.status).not.toBe('ACCEPTED');
    expect(acceptance.probability).toBeNull();
    expect(acceptance.accepted).toBeNull();
    expect(acceptance.required).toBe(RECOMMENDATION_POLICY.requiredProbability);
    expect(row.verdict).not.toBe('RECOMMENDABLE');
    expect(judged(row)).toBeNull();
    // Planning unproven does not stop execution: the goal's project is still pursued.
    forgetExecutionPolicies();
    expect(await executionPolicyForProject(projectId)).toBe('SQUEEZE');
  });

  it('a met target persists an ACCEPTED reading on the ledger, never on coverage', async () => {
    const id = await goal(100_000);
    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 100_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: `k${Math.random()}`, verifiedReference: 'po_g09' });
    await readGoalPlan({ goalId: id, persist: true });
    const row = (await latestReading(id))!;
    const acceptance = JSON.parse(row.forecast!).acceptance;
    expect(acceptance.status).toBe('ACCEPTED');
    expect(acceptance.probability.basis).toBe('TARGET_MET');
    expect(row.verdict).toBe('RECOMMENDABLE');
    expect(judged(row)).toBeNull();
  });

  it('a legacy latest reading without an acceptance is followed by a stamped one, and is itself kept', async () => {
    const id = await goal(1_000_000);
    await readGoalPlan({ goalId: id, persist: true });
    const stamped = (await latestReading(id))!;
    // The released-before shape: the same digest, a forecast with no acceptance, written later.
    const legacyId = newId('gpr');
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL, '[]', NULL, ?, ?)`,
      [legacyId, id, stamped.digest, stamped.verdict, JSON.stringify({ remainingCents: 1_000_000 }), new Date(Date.now() + 1000).toISOString()],
    );
    expect(judged((await latestReading(id))!)).toBe('carries no acceptance record');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await readGoalPlan({ goalId: id, persist: true });
    const latest = (await latestReading(id))!;
    expect(latest.id).not.toBe(legacyId);
    expect(judged(latest)).toBeNull();
    expect((await listReadings(id)).some((one) => one.id === legacyId)).toBe(true);
  });

  it('an unchanged stamped reading is not written twice', async () => {
    const id = await goal(1_000_000);
    await readGoalPlan({ goalId: id, persist: true });
    await readGoalPlan({ goalId: id, persist: true });
    expect((await listReadings(id)).length).toBe(1);
  });

  it('a project no live targeted goal names is evidence-first: the goal\'s ceilings are not a default', async () => {
    const other = (await freshProject()).project.id;
    forgetExecutionPolicies();
    expect(await executionPolicyForProject(other)).toBe('EVIDENCE_FIRST');
  });
});

describe('GOAL-09: hypothetical coverage is never 90% proof', () => {
  it('coverage of assumed inputs stays a candidate with no probability, however high', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio('COVERAGE', 1), measuredChance: null, considered: [{ opportunityId: 'cop_a', missing: [] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.probability).toBeNull();
    expect(a.accepted).toBeNull();
    expect(readingProblem(persistableVerdict('RECOMMENDABLE', a), a as never, RECOMMENDATION_POLICY.requiredProbability)).toBeNull();
  });

  it('a candidate is never stored as RECOMMENDABLE; an accepted plan keeps it', () => {
    expect(persistableVerdict('RECOMMENDABLE', { status: 'CANDIDATE_ONLY' })).toBe('NEEDS_EVIDENCE');
    expect(persistableVerdict('RECOMMENDABLE', { status: 'NO_CANDIDATE' })).toBe('NEEDS_EVIDENCE');
    expect(persistableVerdict('RECOMMENDABLE', { status: 'ACCEPTED' })).toBe('RECOMMENDABLE');
    expect(persistableVerdict('NOT_VIABLE', { status: 'CANDIDATE_ONLY' })).toBe('NOT_VIABLE');
  });

  it('a candidate is stored whole: its coverage figure survives, and nothing the acceptance produced is discarded', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio('COVERAGE', 0.97), measuredChance: null, considered: [{ opportunityId: 'cop_a', missing: [] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
    const stored = storableAcceptance(a);
    // Unchanged, field for field: the coverage reading lives in the candidate, not in `probability`.
    expect(stored).toEqual(a);
    expect(stored.candidate?.reach).toBe(0.97);
    expect(stored.candidate?.reachBasis).toBe('COVERAGE');
    expect(readingProblem('NEEDS_EVIDENCE', stored as never, RECOMMENDATION_POLICY.requiredProbability)).toBeNull();
    // An accepted plan is stored as it is.
    const accepted = judgeAcceptance({ achieved: true, chosen: null, portfolio: null, measuredChance: null, considered: [] });
    expect(storableAcceptance(accepted)).toBe(accepted);
  });

  it('a malformed candidate that claims a probability loses only that claim, never its candidate', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio('COVERAGE', 0.97), measuredChance: null, considered: [{ opportunityId: 'cop_a', missing: [] }] });
    const malformed = { ...a, probability: { value: 0.97, lowerBound: 0.95, basis: 'EVIDENCED_PORTFOLIO' as const, sample: 100, note: 'x' }, accepted: { label: 'x', opportunityIds: ['cop_a'] } };
    expect(readingProblem('NEEDS_EVIDENCE', malformed as never, RECOMMENDATION_POLICY.requiredProbability)).toBe('is only a candidate yet holds an accepted plan or a probability');
    const stored = storableAcceptance(malformed);
    expect(stored.probability).toBeNull();
    expect(stored.accepted).toBeNull();
    expect(stored.candidate).toEqual(a.candidate);
    expect(stored.shortfalls).toEqual(a.shortfalls);
    expect(readingProblem('NEEDS_EVIDENCE', stored as never, RECOMMENDATION_POLICY.requiredProbability)).toBeNull();
  });

  it('a stored forecast is read for its acceptance, and a malformed one carries none', () => {
    expect(forecastCarriesAcceptance(null)).toBe(false);
    expect(forecastCarriesAcceptance('{not json')).toBe(false);
    expect(forecastCarriesAcceptance(JSON.stringify({ remainingCents: 1 }))).toBe(false);
    expect(forecastCarriesAcceptance(JSON.stringify({ acceptance: { status: 'CANDIDATE_ONLY' } }))).toBe(true);
  });
});
