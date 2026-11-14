/**
 * G-1: a goal with no cash target is planned — interpreted, given four or more
 * strategies that differ in mechanism, critiqued independently, revised once,
 * and decided by code. The model is a deterministic fake injected per test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { latestObjectiveReading } from '../server/repos/objectiveReadings.ts';
import {
  advanceObjectivePlans,
  decideObjective,
  interpretObjective,
  OBJECTIVE_REFRESH_MS,
  planObjective,
  type ObjectiveModel,
  type ObjectiveRole,
} from '../server/services/goals/objectivePlan.ts';

let projectId = '';
const now = new Date('2026-11-14T12:00:00.000Z');

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

async function goal(intent: string, outcome: string | null = null): Promise<string> {
  const g = await createWorkstream({ projectId, title: intent.slice(0, 60), intent, purpose: 'CAPABILITY', createdByUserId: null });
  if (outcome) await getDb().run('UPDATE workstreams SET outcome = ? WHERE id = ?', [outcome, g.id]);
  return g.id;
}

interface Spec {
  name: string;
  mechanism: string;
  cost?: [number, number];
  days?: [number, number];
  brokenDependency?: boolean;
  evidence?: number;
  guesses?: number;
}

function strategy(s: Spec, intentRef: string, key?: string): Record<string, unknown> {
  return {
    ...(key ? { key } : {}),
    name: s.name,
    mechanism: s.mechanism,
    summary: `${s.name}.`,
    steps: [
      { id: '1', action: 'find the first customers', dependsOn: [], days: 3 },
      { id: '2', action: 'deliver the first job', dependsOn: s.brokenDependency ? ['9'] : ['1'], days: 5 },
    ],
    resources: ['owner time'],
    timeDays: { low: s.days?.[0] ?? 20, high: s.days?.[1] ?? 60 },
    costUsd: { low: s.cost?.[0] ?? 500, high: s.cost?.[1] ?? 3000 },
    risks: ['demand is thinner than hoped'],
    assumptions: [
      ...Array.from({ length: s.evidence ?? 2 }, (_, i) => ({ statement: `the owner wants this (${i})`, basis: 'EVIDENCE', source: intentRef })),
      ...Array.from({ length: s.guesses ?? 1 }, (_, i) => ({ statement: `customers will pay a market rate (${i})`, basis: 'ASSUMPTION' })),
      { statement: 'a fabricated survey says so', basis: 'EVIDENCE', source: 'survey:made-up' },
    ],
    wouldChange: ['a quote from three local buyers'],
    killCriteria: ['no paying customer within 30 days'],
  };
}

const FIVE: Spec[] = [
  { name: 'Acquire an existing operator', mechanism: 'buy a small running company with its customer book and staff' },
  { name: 'Subcontract crews', mechanism: 'sell contracts and subcontract every job to independent crews', brokenDependency: true },
  { name: 'Commercial contracts', mechanism: 'win recurring office building contracts through facility managers' },
  { name: 'Franchise', mechanism: 'license an established franchise brand and its booking system' },
  { name: 'Same thing again', mechanism: 'buy a small running company with its customer book and staff' },
];

/** A fake lane: strategist, critic and reviser answer from fixed scripts, and every call is counted. */
function fakeModel(script: { generate: (intentRef: string) => string; critique?: (keys: string[], round: number) => string; revise?: (keys: string[], intentRef: string) => string }) {
  const calls: { role: ObjectiveRole; prompt: string }[] = [];
  let critiques = 0;
  const model: ObjectiveModel = async (role, _system, prompt) => {
    calls.push({ role, prompt });
    const intentRef = /(goal:[a-z0-9_]+:intent)/i.exec(prompt)?.[1] ?? 'none';
    const keys = [...prompt.matchAll(/^- (S\d+) \|/gm)].map((m) => m[1]!);
    if (role === 'STRATEGIST') return script.generate(intentRef);
    if (role === 'CRITIC') return (script.critique ?? (() => '{"findings":[]}'))(keys, ++critiques);
    return (script.revise ?? (() => '{"strategies":[]}'))(keys, intentRef);
  };
  return { model, calls };
}

describe('interpretation', () => {
  it('reads constraints, the success measure, and says when none is stated', () => {
    const conflicted = interpretObjective({ title: 'Stores', intent: 'Open 50 stores in 2 weeks with $1,000', outcome: null, dueAt: null }, now);
    expect(conflicted.constraints.map((c) => [c.id, c.value])).toEqual([
      ['budget', 1000],
      ['deadline', 14],
      ['quantity', 50],
    ]);
    expect(conflicted.successMeasure?.statement).toMatch(/50 stores/);

    const rate = interpretObjective({ title: 'Rate', intent: "Cut our research rounds' no-report rate below 20%", outcome: null, dueAt: null }, now);
    expect(rate.constraints.find((c) => c.kind === 'RATE')?.value).toBe(20);
    expect(rate.successMeasure).not.toBeNull();

    const cleaning = interpretObjective({ title: 'Cleaning', intent: 'Build or expand a cleaning business in Harrisburg', outcome: null, dueAt: null }, now);
    expect(cleaning.industry).toBe('cleaning');
    expect(cleaning.geography).toBe('Harrisburg');
    expect(cleaning.successMeasure).toBeNull();
    expect(cleaning.questions[0]).toMatch(/success measure|observable result/i);
  });
});

describe('planObjective', () => {
  it('plans a business objective: four distinct strategies, critique, one revision, a code verdict', async () => {
    const id = await goal('Build or expand a cleaning business in Harrisburg');
    const { model, calls } = fakeModel({
      generate: (ref) => JSON.stringify({ strategies: FIVE.map((s) => strategy(s, ref)) }),
      critique: (keys, round) =>
        JSON.stringify({
          findings:
            round === 1
              ? [
                  { strategy: 'S3', kind: 'UNSUPPORTED_ASSUMPTION', severity: 'CRITICAL', detail: 'no facility manager has been asked', constraint: '' },
                  { strategy: 'S1', kind: 'OTHER', severity: 'MAJOR', detail: 'financing is not arranged', constraint: '' },
                  { strategy: 'S99', kind: 'OTHER', severity: 'CRITICAL', detail: 'about a strategy that does not exist', constraint: '' },
                ]
              : keys.map((k) => ({ strategy: k, kind: 'OTHER', severity: 'MINOR', detail: 'still thin', constraint: '' })),
        }),
      revise: (keys, ref) => JSON.stringify({ strategies: keys.map((k) => strategy({ ...FIVE[Number(k.slice(1)) - 1]!, brokenDependency: false }, ref, k)) }),
    });

    const result = await planObjective(id, { now, model });
    expect(result?.created).toBe(true);
    const reading = result!.reading;
    // No success measure was stated: never PLAN_READY on an unknown (invariant 39).
    expect(reading.verdict).toBe('NEEDS_EVIDENCE');
    const judged = reading.strategies as { strategy: { key: string; mechanism: string; assumptions: { basis: string; source: string | null }[] }; original: unknown; status: string }[];
    expect(judged.length).toBe(4); // the fifth repeated the first's mechanism
    expect(new Set(judged.map((j) => j.strategy.mechanism)).size).toBe(4);
    // A fabricated source is relabelled an assumption; a given one is kept.
    expect(judged[0]!.strategy.assumptions.filter((a) => a.basis === 'EVIDENCE').every((a) => a.source?.startsWith('goal:'))).toBe(true);
    expect(judged[0]!.strategy.assumptions.some((a) => a.basis === 'ASSUMPTION' && /fabricated/.test(JSON.stringify(a)))).toBe(true);
    // S2 (broken dependency, found by code) and S3 (critic) were revised once and survived the re-critique.
    expect(judged.filter((j) => j.original).map((j) => j.strategy.key).sort()).toEqual(['S2', 'S3']);
    expect(judged.every((j) => j.status === 'SURVIVED')).toBe(true);
    expect(reading.critique).toHaveLength(2);
    expect(calls.map((c) => c.role)).toEqual(['STRATEGIST', 'CRITIC', 'REVISER', 'CRITIC']);
    const decision = reading.decision as { questions: string[]; chosen: string; constructionNote: string | null };
    expect(decision.questions.join(' ')).toMatch(/observable result/);
    expect(decision.chosen).toBe('S2'); // no major finding and the lowest cost tie broken by key
    expect(decision.constructionNote).not.toBeNull(); // §92 construction was read for "cleaning"
    expect((reading.calls as { refused: number }).refused).toBeGreaterThan(0); // the finding about S99

    const events = await listWorkstreamEvents(id);
    expect(events.some((e) => e.kind === 'OBJECTIVE_PLAN_READ')).toBe(true);
    const projectEvents = await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM project_events WHERE event_type = 'GOAL_OBJECTIVE_PLAN_READ' AND entity_id = ?`, [id]);
    expect(Number(projectEvents[0]!.n)).toBe(1);
  });

  it('is PLAN_READY when a strategy survives on evidence and a success measure is stated', async () => {
    const id = await goal('Build or expand a cleaning business in Harrisburg', 'Ten recurring commercial clients under contract');
    const { model } = fakeModel({ generate: (ref) => JSON.stringify({ strategies: FIVE.slice(0, 4).map((s) => strategy(s, ref)) }) });
    const reading = (await planObjective(id, { now, model, construction: false }))!.reading;
    expect(reading.verdict).toBe('PLAN_READY');
    expect(reading.chosenStrategy).toMatch(/^S\d$/);
  });

  it('is NEEDS_EVIDENCE when the survivors rest mainly on assumptions, and lists what would decide it', async () => {
    const id = await goal('Launch a product with three dependent workstreams', 'The product is live with its three workstreams delivered');
    const { model } = fakeModel({ generate: (ref) => JSON.stringify({ strategies: FIVE.slice(0, 4).map((s) => strategy({ ...s, brokenDependency: false, evidence: 0, guesses: 3 }, ref)) }) });
    const reading = (await planObjective(id, { now, model, construction: false }))!.reading;
    expect(reading.verdict).toBe('NEEDS_EVIDENCE');
    const questions = (reading.decision as { questions: string[] }).questions;
    expect(questions.some((q) => /^Is it true that customers will pay/.test(q))).toBe(true);
    expect(questions).toContain('a quote from three local buyers');
  });

  it('is NOT_SUPPORTED, naming the constraint, when every strategy fails one ("50 stores in 2 weeks with $1,000")', async () => {
    const id = await goal('Open 50 stores in 2 weeks with $1,000');
    const costly = FIVE.slice(0, 4).map((s) => ({ ...s, brokenDependency: false, cost: [250_000, 2_000_000] as [number, number], days: [10, 90] as [number, number] }));
    const { model } = fakeModel({
      generate: (ref) => JSON.stringify({ strategies: costly.map((s) => strategy(s, ref)) }),
      critique: (keys) => JSON.stringify({ findings: keys.map((k) => ({ strategy: k, kind: 'CONSTRAINT_CONFLICT', severity: 'CRITICAL', detail: '50 stores cannot open in 14 days', constraint: 'quantity' })) }),
      revise: (keys, ref) => JSON.stringify({ strategies: keys.map((k) => strategy(costly[Number(k.slice(1)) - 1]!, ref, k)) }),
    });
    const reading = (await planObjective(id, { now, model, construction: false }))!.reading;
    expect(reading.verdict).toBe('NOT_SUPPORTED');
    const decision = reading.decision as { failedConstraint: { id: string; statement: string; strategiesFailing: number } };
    expect(decision.failedConstraint.id).toBe('budget');
    expect(decision.failedConstraint.statement).toMatch(/\$1,000/);
    expect(decision.failedConstraint.strategiesFailing).toBe(4);
    expect((reading.strategies as { status: string }[]).every((j) => j.status === 'REJECTED')).toBe(true);
  });

  it('refuses a malformed answer: the reading is DEGRADED, not a crash and not a plan', async () => {
    const id = await goal('Cut our research rounds no-report rate below 20%');
    const { model } = fakeModel({ generate: () => 'Sure! Here are some ideas: work harder, hire more.' });
    const result = await planObjective(id, { now, model, construction: false });
    expect(result!.reading.verdict).toBe('DEGRADED');
    expect(result!.reading.error).toMatch(/0 valid, distinct strategies/);

    // An off-shape critique degrades too: no plan is judged uncritiqued.
    const other = await goal('Launch a newsletter for our customers', 'Five hundred subscribers');
    const second = fakeModel({ generate: (ref) => JSON.stringify({ strategies: FIVE.slice(0, 4).map((s) => strategy({ ...s, brokenDependency: false }, ref)) }), critique: () => 'looks great' });
    const degraded = (await planObjective(other, { now, model: second.model, construction: false }))!.reading;
    expect(degraded.verdict).toBe('DEGRADED');
    expect(degraded.error).toMatch(/critique was refused/);

    // A model that throws is recorded, not raised.
    const third = await goal('Write the operations handbook', 'A handbook the team uses');
    const failing: ObjectiveModel = async () => {
      throw new Error('connection reset');
    };
    const thrown = (await planObjective(third, { now, model: failing, construction: false }))!.reading;
    expect(thrown.verdict).toBe('DEGRADED');
    expect(thrown.error).toMatch(/0 valid/);
    expect(JSON.stringify(thrown.calls)).toMatch(/connection reset/);
  });

  it('leaves a targeted goal to plan.ts', async () => {
    const id = await goal('Raise cash');
    await getDb().run(`UPDATE workstreams SET target_metric = 'SETTLED_CASH', target_amount_cents = 100, target_currency = 'USD', target_project_id = ?, target_set_at = ? WHERE id = ?`, [projectId, now.toISOString(), id]);
    const { model, calls } = fakeModel({ generate: () => '{}' });
    expect(await planObjective(id, { now, model })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('advanceObjectivePlans', () => {
  it('plans one due goal per call, and a restart on the same inputs writes no duplicate and calls no model', async () => {
    const a = await goal('Launch a product with three dependent workstreams', 'Live product');
    const b = await goal('Build or expand a cleaning business in Harrisburg', 'Ten clients');
    const paused = await goal('Something paused', 'never');
    await getDb().run('UPDATE workstreams SET paused_at = ?, paused_reason = ? WHERE id = ?', [now.toISOString(), 'not now', paused]);
    const { model, calls } = fakeModel({ generate: (ref) => JSON.stringify({ strategies: FIVE.slice(0, 4).map((s) => strategy({ ...s, brokenDependency: false }, ref)) }) });

    const first = await advanceObjectivePlans(now, { model, construction: false });
    const second = await advanceObjectivePlans(now, { model, construction: false });
    expect(first.read).toBe(1);
    expect(second.read).toBe(1);
    expect(new Set([first.goalId, second.goalId])).toEqual(new Set([a, b]));
    const callsAfterTwo = calls.length;

    // Restart: same inputs, same window — nothing due, nothing written, no model call.
    const third = await advanceObjectivePlans(now, { model, construction: false });
    expect(third).toMatchObject({ read: 0, skipped: 'no goal due' });
    expect(await planObjective(a, { now, model, construction: false })).toMatchObject({ created: false });
    expect(calls.length).toBe(callsAfterTwo);
    const rows = await getDb().all<{ workstream_id: string; n: number }>('SELECT workstream_id, COUNT(*) AS n FROM goal_objective_readings GROUP BY workstream_id');
    expect(rows.map((r) => [r.workstream_id, Number(r.n)]).sort()).toEqual([[a, 1], [b, 1]].sort());
    expect(await latestObjectiveReading(paused)).toBeNull();

    // Inputs changed: that goal is due again at once.
    await getDb().run('UPDATE workstreams SET outcome = ? WHERE id = ?', ['Live product with paying users', a]);
    expect(await advanceObjectivePlans(now, { model, construction: false })).toMatchObject({ read: 1, goalId: a });

    // A refresh window later, each is due again.
    const later = new Date(now.getTime() + OBJECTIVE_REFRESH_MS);
    const refreshed = await advanceObjectivePlans(later, { model, construction: false });
    expect(refreshed.read).toBe(1);
    expect([a, b]).toContain(refreshed.goalId);

    // No lane, no work.
    expect(await advanceObjectivePlans(later, { model: null })).toMatchObject({ read: 0, skipped: 'no model lane configured' });
  });
});

describe('decideObjective', () => {
  it('never reports success with no strategies', () => {
    const interp = interpretObjective({ title: 'x', intent: 'Do something', outcome: 'done', dueAt: null }, now);
    expect(decideObjective(interp, []).verdict).toBe('NEEDS_EVIDENCE');
  });
});
