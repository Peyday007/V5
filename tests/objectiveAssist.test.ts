/**
 * The model's second reading of an objective (`objectiveAssist.ts`): asked only
 * where `readObjective` leaves a gap, and taken only where the words bear it
 * out. No model: the reader's own reading, unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listWorkstreamEvents } from '../server/repos/register.ts';
import { readObjective } from '../server/services/industry/construction/intent.ts';
import { applyAssist, assistObjective, assistReason, type ObjectiveInterpreter } from '../server/services/goals/objectiveAssist.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { readTarget } from '../server/services/goals/target.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';

const NOW = new Date('2026-11-25T12:00:00Z');
const read = (text: string) => readObjective(text, NOW);

/** A model that answers with `answer` and records what it was asked. */
function fakeModel(answer: Record<string, unknown> | string): ObjectiveInterpreter & { calls: number } {
  const out = { calls: 0, label: 'test:model', chat: (async () => ({ content: '', toolCalls: [], ms: 1, completionTokens: 1, error: null })) as ChatFn };
  out.chat = async () => {
    out.calls += 1;
    return { content: typeof answer === 'string' ? answer : `Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, toolCalls: [], ms: 1, completionTokens: 1, error: null };
  };
  return out;
}

// "I've got a van and about $700" is now read directly as $700 of capital, so the
// unplaced example states the figure with nothing the reader can place it by.
const VAN = 'I want a side income of $2,500/mo within the next few months; a van in the driveway, $700 tops.';
const RENT = 'Need $1,200 for rent on the first of next month.';
const COVER = 'The side business should cover my $1,900 rent each month within 90 days.';

describe('when a second reading is asked', () => {
  it('asks only for an unplaced money figure, no amount beside money, or no deadline', () => {
    expect(assistReason(read(VAN))).toMatch(/unplaced/);
    expect(assistReason(read(COVER))).toMatch(/unplaced/);
    expect(assistReason(read(RENT))).toMatch(/no deadline/);
    expect(assistReason(read(RENT), { dueAtGiven: true })).toBeNull();
    expect(assistReason(read('Collect $10,000 within 30 days with at most $3,000 of capital.'))).toBeNull();
    expect(assistReason(read('Write a better onboarding guide.'))).toBeNull();
  });
});

describe('applyAssist: only what the words bear out', () => {
  it('places an unplaced figure the words state, and records the field', () => {
    const o = applyAssist(read(VAN), { kind: 'CASH', amount: 2500, monthly: true, capitalCeiling: 700, resources: ['a van'] }, NOW, 'test:model');
    expect(o).toMatchObject({ amount: 2500, recurring: 'MONTHLY', capitalCeiling: 700 });
    expect(o.unread).toEqual([]);
    expect(o.assisted).toEqual({ model: 'test:model', fields: ['capitalCeiling', 'resources'], rejected: [] });
  });
  it('reads a deadline whose phrase is quoted from the words', () => {
    const o = applyAssist(read(RENT), { kind: 'CASH', amount: 1200, deadline: '2026-12-01', deadlinePhrase: 'on the first of next month' }, NOW, 'm');
    expect(o.deadline).toBe('2026-12-01T23:59:59.000Z');
    expect(o.unread).toEqual([]);
    expect(o.assisted?.fields).toEqual(['deadline']);
  });
  it('reads an amount and its cadence the reader could not place', () => {
    const o = applyAssist(read(COVER), { kind: 'CASH', amount: 1900, currency: 'USD', monthly: true }, NOW, 'm');
    expect(o).toMatchObject({ kind: 'CASH', amount: 1900, currency: 'USD', recurring: 'MONTHLY' });
    expect(o.unread).toEqual([]);
    expect(o.assisted?.fields).toEqual(['amount', 'monthly']);
  });
  it('never invents a figure, a deadline, a limit or a resource', () => {
    const rent = applyAssist(read(RENT), { amount: 1200, deadline: '2026-12-01', deadlinePhrase: 'by December 1st', hoursPerWeek: 3, capitalCeiling: 500, resources: ['a truck'], location: 'Detroit' }, NOW, 'm');
    expect(rent).toMatchObject({ deadline: null, hoursPerWeek: null, capitalCeiling: null, resources: [] });
    expect(rent.location ?? null).toBeNull();
    expect(rent.assisted?.fields).toEqual([]);
    expect(rent.assisted?.rejected).toHaveLength(5);
    expect(rent.unread).toContain('deadline: none stated');
    // A vague "a few hours" names no figure: a model's 3 is refused.
    const few = applyAssist(read('Make $2,000 sometime soon with $300 and a few hours a week.'), { hoursPerWeek: 3, deadline: '2027-01-01', deadlinePhrase: 'soon' }, NOW, 'm');
    expect(few.hoursPerWeek).toBeNull();
    expect(few.deadline).toBeNull();
    // An amount the words do not state, a past date and a figure already read as the capital are refused.
    expect(applyAssist(read(COVER), { amount: 2000, monthly: true }, NOW, 'm').amount).toBeNull();
    expect(applyAssist(read(RENT), { deadline: '2026-11-01', deadlinePhrase: 'first of next month' }, NOW, 'm').deadline).toBeNull();
    expect(applyAssist(read('Get to something good. I have $700.'), { amount: 700 }, NOW, 'm').amount).toBeNull();
    // A cadence the words do not state is refused with the amount kept.
    const once = applyAssist(read('The side business should cover my $1,900 rent within 90 days.'), { amount: 1900, monthly: true }, NOW, 'm');
    expect(once.recurring).toBeNull();
  });
  it('keeps the reader\'s own fields: the model fills gaps, never overwrites', () => {
    const o = applyAssist(read(VAN), { amount: 700, capitalCeiling: 2500, monthly: false }, NOW, 'm');
    expect(o.amount).toBe(2500);
    expect(o.recurring).toBe('MONTHLY');
  });
});

describe('assistObjective', () => {
  it('returns the reader\'s reading unchanged with no model, a failed call, or no JSON', async () => {
    const r = read(VAN);
    expect(await assistObjective(r, NOW, null)).toBe(r);
    expect(await assistObjective(r, NOW, fakeModel('I cannot help with that.'))).toBe(r);
    const failing: ObjectiveInterpreter = { label: 'x', chat: async () => ({ content: '', toolCalls: [], ms: 1, completionTokens: 0, error: 'HTTP 429' }) };
    expect(await assistObjective(r, NOW, failing)).toBe(r);
  });
  it('does not ask when the reader read everything', async () => {
    const model = fakeModel({ amount: 1 });
    await assistObjective(read('Collect $10,000 within 30 days.'), NOW, model);
    expect(model.calls).toBe(0);
  });
});

describe('createGoal with a second reading', () => {
  let projectId = '';
  let userId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `assist-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('refuses words with an unplaced figure when no model is configured, as before', async () => {
    const made = await createGoal({ projectId, objective: VAN, actorRef: 'person:test', userId, now: NOW, interpreter: null });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.reason).toMatch(/\$700/);
  });

  it('creates the goal from the verified second reading and records which fields it gave', async () => {
    const model = fakeModel({ kind: 'CASH', amount: 2500, currency: 'USD', monthly: true, capitalCeiling: 700, hoursPerWeek: null, resources: ['a van'] });
    const made = await createGoal({ projectId, objective: VAN, actorRef: 'person:test', userId, now: NOW, interpreter: model });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(model.calls).toBe(1);
    expect(made.goal.target).toMatchObject({ amountCents: 250_000, currency: 'USD', capitalCeilingCents: 70_000, resources: 'a van' });
    expect(made.reading.assisted).toMatchObject({ model: 'test:model', fields: ['capitalCeiling', 'resources'] });
    const events = await listWorkstreamEvents(made.goal.id);
    const set = events.find((e) => e.kind === 'GOAL_TARGET_SET' && e.summary.startsWith('Target:'))!;
    expect(set.detail).toMatchObject({ assisted: { fields: ['capitalCeiling', 'resources'] } });
    expect(set.summary).toMatch(/second reading/);
  });

  it('carries a cadence only the second reading found to the run-rate the goal counts', async () => {
    const model = fakeModel({ kind: 'CASH', amount: 1900, currency: 'USD', monthly: true });
    const made = await createGoal({ projectId, objective: COVER, actorRef: 'person:test', userId, now: NOW, interpreter: model });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.goal.target).toMatchObject({ amountCents: 190_000 });
    expect(made.goal.outcome).toMatch(/^a monthly recurring run-rate/);
    expect((await readTarget(made.goal, NOW))!.scope?.recurring).toBe('MONTHLY');
  });

  it('reads the production request with no model at all', async () => {
    const made = await createGoal({ projectId, objective: "Need about $2,000 by end of next month. I don't have money to put in but I've got a pickup truck and my weekends are free.", actorRef: 'person:test', userId, now: NOW, interpreter: null });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.goal.target).toMatchObject({ amountCents: 200_000, resources: 'a pickup truck; my weekends are free' });
    expect(made.reading.assisted).toBeUndefined();
  });
});
