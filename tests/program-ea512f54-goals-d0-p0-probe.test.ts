/**
 * GOAL-09: probe r01.goal-09 judges production rows. It fails when there is nothing to read,
 * and when a persisted reading contradicts the acceptance rule: a candidate is never an
 * accepted plan, coverage is never a defensible probability, and a goal's ceilings never
 * become another project's default.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetExecutionPolicies } from '../server/services/goals/policy.ts';
import { readingProblem } from '../server/services/factory/program/release01/acceptanceProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
let projectId = '';
let goalId = '';
let seq = 0;

beforeEach(async () => {
  forgetExecutionPolicies();
  projectId = (await freshProject()).project.id;
  await getDb().run('DELETE FROM goal_plan_readings');
});

async function liveGoal(): Promise<void> {
  const userId = (await createUser({ email: `g9-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  const g = await createWorkstream({ projectId, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  goalId = g.id;
}

async function reading(verdict: string, acceptance: unknown, createdAt = new Date().toISOString()): Promise<void> {
  seq += 1;
  await getDb().run(
    `INSERT INTO goal_plan_readings (id, workstream_id, digest, verdict, strategies, forecast, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`gpr-t${seq}`, goalId, `d${seq}`, verdict, '[]', JSON.stringify({ acceptance }), createdAt],
  );
}

const probe = () => getProbe('r01.goal-09')!({});
const candidate = { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: { reachBasis: 'COVERAGE', reach: 0.97 } };
const accepted = (over: object = {}) => ({
  status: 'ACCEPTED',
  required: 0.9,
  probability: { basis: 'EVIDENCED_PORTFOLIO', value: 0.95, lowerBound: 0.92 },
  accepted: { label: 'plan', opportunityIds: ['o1'] },
  ...over,
});

describe('readingProblem (pure)', () => {
  it('accepts a candidate with no probability and an accepted plan on a defensible basis', () => {
    expect(readingProblem('NEEDS_EVIDENCE', candidate, 0.9)).toBeNull();
    expect(readingProblem('RECOMMENDABLE', accepted(), 0.9)).toBeNull();
    expect(readingProblem('RECOMMENDABLE', accepted({ probability: { basis: 'TARGET_MET', lowerBound: 1 } }), 0.9)).toBeNull();
  });

  it('refuses coverage, a low bar, a low bound, a candidate reported as recommendable, and a missing record', () => {
    expect(readingProblem('RECOMMENDABLE', accepted({ probability: { basis: 'COVERAGE', lowerBound: 0.99 } }), 0.9)).toMatch(/not a defensible probability/);
    expect(readingProblem('RECOMMENDABLE', accepted({ required: 0.5 }), 0.9)).toMatch(/lower than the one required/);
    expect(readingProblem('RECOMMENDABLE', accepted({ probability: { basis: 'EVIDENCED_PORTFOLIO', lowerBound: 0.85 } }), 0.9)).toMatch(/lower bound/);
    expect(readingProblem('RECOMMENDABLE', candidate, 0.9)).toMatch(/only a candidate/);
    expect(readingProblem('NEEDS_EVIDENCE', { ...candidate, probability: { basis: 'COVERAGE' } }, 0.9)).toMatch(/holds an accepted plan or a probability/);
    expect(readingProblem('NEEDS_EVIDENCE', accepted(), 0.9)).toMatch(/verdict is not RECOMMENDABLE/);
    expect(readingProblem('RECOMMENDABLE', null, 0.9)).toMatch(/no acceptance record/);
  });
});

describe('probe r01.goal-09 on rows', () => {
  it('is registered once the policy module is loaded', () => {
    expect(getProbe('r01.goal-09')).not.toBeNull();
  });

  it('fails when no live goal exists, rather than passing on nothing', async () => {
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no live goal/);
  });

  it('fails with a live goal but no reading that carries an acceptance', async () => {
    await liveGoal();
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no plan reading since/);
  });

  it('passes on honest candidate and accepted readings, while the goal stays SQUEEZE and other projects stay evidence-first', async () => {
    await liveGoal();
    await createProject({ name: 'No goal targets this' });
    await reading('NEEDS_EVIDENCE', candidate);
    const r = await probe();
    expect(r.detail).toMatch(/1 live goal\(s\) pursued as SQUEEZE, \d+ other project\(s\) evidence-first; 1 reading/);
    expect(r.ok).toBe(true);
    await reading('RECOMMENDABLE', accepted());
    expect((await probe()).ok).toBe(true);
  });

  it('fails when a stored reading counterfeits assurance', async () => {
    await liveGoal();
    await reading('RECOMMENDABLE', accepted({ probability: { basis: 'COVERAGE', lowerBound: 0.99 } }));
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not a defensible probability/);
  });

  it('judges from the first reading stamped with an acceptance, and still refuses an unstamped one after it', async () => {
    await liveGoal();
    // Written on the rule's day by the Brain released before the rule: no acceptance key at all.
    seq += 1;
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, verdict, strategies, forecast, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`gpr-t${seq}`, goalId, `d${seq}`, 'NOT_VIABLE', '[]', JSON.stringify({ remainingCents: 1 }), '2026-11-09T05:00:00.000Z'],
    );
    await reading('NOT_VIABLE', candidate, '2026-11-09T12:00:00.000Z');
    expect((await probe()).ok).toBe(true);
    seq += 1;
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, verdict, strategies, forecast, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`gpr-t${seq}`, goalId, `d${seq}`, 'NOT_VIABLE', '[]', JSON.stringify({ remainingCents: 1 }), '2026-11-09T13:00:00.000Z'],
    );
    expect((await probe()).ok).toBe(false);
  });

  it('does not judge readings from before the acceptance rule', async () => {
    await liveGoal();
    await reading('RECOMMENDABLE', null, '2026-11-01T00:00:00.000Z');
    expect((await probe()).detail).toMatch(/no plan reading since/);
  });
});
