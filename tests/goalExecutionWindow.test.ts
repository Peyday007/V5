/**
 * A goal's commercial execution window (§119; owner, 2026-11-19, restated
 * 2026-11-24 as a recurring defect): "the $10K objective has a 30-day
 * COMMERCIAL EXECUTION period, beginning when actual commercial execution
 * starts." Planning, engineering and research before execution do not consume
 * it; before execution the deadline is relative, never a calendar date; the
 * countdown starts at authorized commercial execution.
 *
 * The 2026-11-19 instruction lived only in a conversation and every reader
 * kept counting down to the date "within 30 days" had been turned into. These
 * pin the rule where it is derived, where it is written, where it starts, and
 * the readers that select the row directly, so it cannot be lost again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { readObjective } from '../server/services/industry/construction/intent.ts';
import { createGoal, setTerms } from '../server/services/goals/decide.ts';
import { readTarget } from '../server/services/goals/target.ts';
import { startExecutionWindows } from '../server/services/goals/executionStart.ts';
import { executionPolicyForProject, forgetExecutionPolicies } from '../server/services/goals/policy.ts';
import { planningReport, planningReportLines } from '../server/services/goals/planningReport.ts';
import { daysLeftOf, deadlineText, effectiveDueAt, EXECUTION_ACTIONS, startsExecution } from '../server/domain/executionWindow.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-11-03T12:00:00.000Z');
const TEN_K = 'Collect $10,000 of settled cash within 30 days using little up-front capital.';

describe('the rule, pure', () => {
  const unstarted = { dueAt: null, executionWindowDays: 30, executionStartedAt: null };

  it('keeps the full window however much planning, engineering and research time passes', () => {
    for (const elapsed of [0, 1, 6, 21, 90]) {
      const at = new Date(NOW.getTime() + elapsed * DAY);
      expect(daysLeftOf(unstarted, at)).toBe(30);
      expect(effectiveDueAt(unstarted, at)).toBe(new Date(at.getTime() + 30 * DAY).toISOString());
    }
  });

  it('states the deadline relatively before execution, as a date after', () => {
    expect(deadlineText(unstarted)).toMatch(/^within 30 days of the start of commercial execution/);
    expect(deadlineText(unstarted)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const started = { dueAt: '2026-12-31T00:00:00.000Z', executionWindowDays: 30, executionStartedAt: '2026-12-01T00:00:00.000Z' };
    expect(deadlineText(started)).toBe('by 2026-12-31 (30-day execution window from 2026-12-01)');
    expect(daysLeftOf(started, new Date('2026-12-11T00:00:00.000Z'))).toBe(20);
    // A goal with no window is a fixed date, as before.
    expect(daysLeftOf({ dueAt: '2026-12-09T00:00:00.000Z', executionWindowDays: null, executionStartedAt: null }, new Date('2026-12-01T00:00:00.000Z'))).toBe(8);
  });

  it('starts only on buyer-facing authority', () => {
    expect([...EXECUTION_ACTIONS].sort()).toEqual(['ACCEPT_PAYMENT', 'CONTACT_BUYER', 'QUOTE_AND_INVOICE']);
    expect(startsExecution(['BUILD_A_TEST', 'RUN_PAID_TEST', 'PURCHASE_TOOL_OR_DATA', 'SPEND_FROM_ALLOWANCE'])).toBe(false);
    expect(startsExecution(['CONTACT_BUYER'])).toBe(true);
  });

  it('reads a stated span as a window and a stated date as a date', () => {
    expect(readObjective(TEN_K, NOW).windowDays).toBe(30);
    expect(readObjective('Make $5,000 in 4 weeks', NOW).windowDays).toBe(28);
    expect(readObjective('Make $5,000 by 2026-12-31', NOW).windowDays).toBeNull();
  });
});

describe('on the goal row', () => {
  let projectId: string;
  let userId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `window-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    forgetExecutionPolicies();
  });

  const grant = (allowedActions: string[], startsAt?: string) =>
    createAuthority({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'test grant', allowedActions, prohibitions: [], maxCommittedCents: 0, maxPerActionCents: 0, maxConcurrent: 1, currency: 'USD', ...(startsAt ? { startsAt } : {}) });

  it('stores "within 30 days" as a 30-day window with no calendar date, and every reader keeps the full window', async () => {
    const made = await createGoal({ projectId, objective: TEN_K, actorRef: 'person:test', userId, now: NOW });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const row = await getDb().get<{ due_at: string | null; execution_window_days: number; execution_started_at: string | null }>('SELECT due_at, execution_window_days, execution_started_at FROM workstreams WHERE id = ?', [made.goal.id]);
    expect(row).toMatchObject({ due_at: null, execution_window_days: 30, execution_started_at: null });
    const goal = (await getWorkstream(made.goal.id))!;
    expect(goal.executionWindowDays).toBe(30);
    // Three weeks of planning later the reading still has the whole window (the defect: 2026-12-09 counted down).
    for (const elapsed of [0, 21, 40]) {
      const reading = (await readTarget(goal, new Date(Date.now() + elapsed * DAY)))!;
      expect(reading.daysLeft).toBe(30);
      expect(reading.execution).toEqual({ windowDays: 30, startedAt: null });
      const lines = planningReportLines(planningReport({ target: reading, acceptance: { status: 'NOT_ACCEPTED', probability: null, candidate: null, shortfalls: [] } as never, measuredChance: null, verdict: 'X', summary: null } as never, goal.dueAt));
      expect(lines[0]).toMatch(/within 30 days of the start of commercial execution \(not started/);
      expect(lines[0]).not.toMatch(/ by \d{4}-/);
    }
    // The goal is live for every reader that selects the row directly.
    expect(await executionPolicyForProject(projectId)).toBe('SQUEEZE');
  });

  it('does not start on research-only or preparation authority, and starts once on buyer-facing authority', async () => {
    const made = await createGoal({ projectId, objective: TEN_K, actorRef: 'person:test', userId, now: NOW });
    if (!made.ok) throw new Error(made.reason);
    await grant(['BUILD_A_TEST']);
    expect(await startExecutionWindows({ projectId, actorRef: 'test' })).toEqual([]);
    expect((await getWorkstream(made.goal.id))!.executionStartedAt).toBeNull();

    await getDb().run(`UPDATE cash_authorities SET state = 'REVOKED' WHERE project_id = ?`, [projectId]);
    const live = await grant(['CONTACT_BUYER', 'ACCEPT_PAYMENT']);
    expect(await startExecutionWindows({ projectId, actorRef: 'test' })).toEqual([made.goal.id]);
    expect(await startExecutionWindows({ projectId, actorRef: 'test' })).toEqual([]);
    const goal = (await getWorkstream(made.goal.id))!;
    expect(goal.executionStartedAt).toBe(live.startsAt);
    expect(goal.dueAt).toBe(new Date(Date.parse(live.startsAt) + 30 * DAY).toISOString());
    const later = new Date(Date.parse(live.startsAt) + 10 * DAY);
    expect((await readTarget(goal, later))!.daysLeft).toBe(20);
    const started = (await listWorkstreamEvents(made.goal.id)).filter((e) => e.kind === 'GOAL_EXECUTION_STARTED');
    expect(started).toHaveLength(1);
  });

  it('refuses a calendar date that would silently replace the window, unless the window is cleared in the same decision', async () => {
    const made = await createGoal({ projectId, objective: TEN_K, actorRef: 'person:test', userId, now: NOW });
    if (!made.ok) throw new Error(made.reason);
    const echoed = await setTerms(made.goal.id, { outcome: 'x', dueAt: '2026-12-09T23:59:59.000Z' }, 'person:test');
    expect(echoed.ok).toBe(false);
    expect((await getWorkstream(made.goal.id))!.executionWindowDays).toBe(30);
    const replaced = await setTerms(made.goal.id, { dueAt: '2026-12-09T23:59:59.000Z', executionWindowDays: null }, 'person:test');
    expect(replaced.ok).toBe(true);
    const goal = (await getWorkstream(made.goal.id))!;
    expect(goal).toMatchObject({ executionWindowDays: null, dueAt: '2026-12-09T23:59:59.000Z' });
  });

  it('keeps an explicitly stated date a date', async () => {
    const made = await createGoal({ projectId, objective: 'Collect $10,000 of settled cash by 2026-12-31', actorRef: 'person:test', userId, now: NOW });
    if (!made.ok) throw new Error(made.reason);
    expect((await getWorkstream(made.goal.id))!).toMatchObject({ executionWindowDays: null, dueAt: '2026-12-31T23:59:59.000Z' });
  });
});

describe('structural guards', () => {
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));

  it('no reader filters live goals on the stored date alone', () => {
    // An unstarted window has no stored date: a filter on `due_at > ?` alone drops the goal from that reader.
    const offenders = walk(path.join(root, 'server')).filter((f) => /due_at IS NOT NULL AND due_at > \?/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('executionWindow.ts'));
    expect(offenders).toEqual([]);
  });

  it('no reader computes days left from the stored date', () => {
    const offenders = walk(path.join(root, 'server')).filter((f) => /Date\.parse\((?:goal|row|g|w)\.due_?[aA]t\)\s*-\s*now/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('both migration chains give the live $10K goal its full window', () => {
    for (const file of ['server/db/migrations/160_goal_execution_window.sql', 'server/db/pg-migrations/151_goal_execution_window.sql']) {
      const sql = fs.readFileSync(path.join(root, file), 'utf8');
      expect(sql).toMatch(/SET execution_window_days = 30, due_at = NULL\s+WHERE id = 'wst_7b4fcbb5f2384f31b6c3'/);
    }
  });
});
