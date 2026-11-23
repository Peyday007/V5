/**
 * Every adaptation change kind reaches Brain's real planner (bench/planningReliability/
 * world.ts `applyChange`): on small synthetic worlds, the plan is read, the world changes
 * through production's own write path, and the re-read plan differs as the change implies.
 *
 * The assertions are on what the planner itself reports — the target it reads, the
 * deadline it counts, the limits it holds, the chain links it finds missing, the limits it
 * finds broken, the openings it considers and what it calls unestablished — never on a
 * grade, so a planner that judges a world better or worse tomorrow does not break them;
 * only a change that stops reaching the planner does.
 */
// First: the bench's process environment (as `bench/planningReliability/index.ts` loads it).
import '../bench/env.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gradeAdaptation } from '../bench/planningReliability/adaptation.ts';
import type { CaseDimensions, PlanningCase } from '../bench/planningReliability/case.ts';
import { observe, type ObservedPlan } from '../bench/planningReliability/grade.ts';
import { buildTemplate, closeWorldDatabase, proveDeliverables, runWorld, type Template, type WorldReading } from '../bench/planningReliability/world.ts';

const dims = (industry: string, mechanism: string): CaseDimensions => ({
  capital: 'none', target: 'small', deadline: 'long', industry, mechanism, autonomy: 'unlimited', missingEvidence: 'none', contradictoryEvidence: false, objectiveChanged: true,
});

/** One Brain-performed deal, already accepted in writing, every figure evidenced. */
const OPENINGS: PlanningCase = {
  id: 'adapt-openings',
  heldOut: false,
  description: 'Goal terms and opening evidence change one at a time on one world.',
  dimensions: dims('credit unions', 'EXPLICIT_PAID_REQUEST'),
  objective: 'Generate $2,000 within 30 days.',
  openings: [
    { key: 'cu', title: 'Quarterly market data workbook for Lakeside Credit Union', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'credit unions', payer: 'Lakeside Credit Union', price: 2500, cost: 50, capital: 0, daysToCash: 7, hours: 2, performer: 'BRAIN', agreements: [2500] },
  ],
  changes: [
    { change: { kind: 'TARGET', amount: 2400 } },
    { change: { kind: 'SUPPLIER_COST', opening: 'cu', cost: 3000 } },
    { change: { kind: 'SUPPLIER_COST', opening: 'cu', cost: 50 } },
    { change: { kind: 'DAYS_TO_CASH', opening: 'cu', days: 60 } },
    { change: { kind: 'DEADLINE', days: 90 } },
    { change: { kind: 'CONTRADICTING_EVIDENCE', opening: 'cu', field: 'price', value: 250 } },
    { change: { kind: 'BUYER_UNAVAILABLE', opening: 'cu', reason: 'The credit union chose another vendor.' } },
  ],
  expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['REACHABLE_BUYER', 'OFFER_AND_PRICE'] } },
};

/** Subcontracted lots that each tie up $2,000. */
const CAPITAL: PlanningCase = {
  id: 'adapt-capital',
  heldOut: false,
  description: 'The starting capital shrinks, the limit is removed, and the words restate one.',
  dimensions: { ...dims('commercial cleaning', 'SUBCONTRACTED_FULFILMENT'), capital: 'large' },
  objective: 'Generate $5,000 within 30 days using at most $10,000 of capital.',
  openings: [
    { key: 'clean', title: 'Post-construction cleanup for general contractors', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning', payer: 'General contractors', price: 3000, cost: 1000, capital: 2000, daysToCash: 10, hours: 2, performer: 'SUBCONTRACTOR', subcontractor: 'BrightCrew Cleaning LLC (quoted)', agreements: [3000, 3000] },
  ],
  changes: [
    { change: { kind: 'CAPITAL', capital: 500 } },
    { change: { kind: 'CONSTRAINT', constraint: 'CAPITAL', limit: null } },
    { change: { kind: 'OBJECTIVE', objective: 'Generate $5,000 within 30 days using at most $1,000 of capital.' } },
  ],
  expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['CAPITAL'], links: ['ECONOMICS'] } },
};

/** The owner's own consulting: 10 owner hours a deal, four accepted. */
const HOURS: PlanningCase = {
  id: 'adapt-hours',
  heldOut: false,
  description: 'An owner-hours limit is added, then removed.',
  dimensions: { ...dims('property management', 'CAPABILITY_ARBITRAGE'), autonomy: 'owner-hours-limited' },
  objective: 'Generate $3,000 within 30 days.',
  openings: [
    { key: 'owner', title: 'Tenant-screening policy consultation for property managers', mechanism: 'CAPABILITY_ARBITRAGE', industry: 'property management', payer: 'Property managers', price: 1000, cost: 0, capital: 0, daysToCash: 7, hours: 10, performer: 'OWNER', agreements: [1000, 1000, 1000, 1000] },
  ],
  changes: [
    { change: { kind: 'CONSTRAINT', constraint: 'OWNER_HOURS', limit: 5 }, expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['OWNER_HOURS'] }, ownerHoursMax: 5 } },
    { change: { kind: 'CONSTRAINT', constraint: 'OWNER_HOURS', limit: null } },
  ],
  expect: { verdict: 'EXECUTABLE_PLAN' },
};

let dir = '';
let template: Template;
const run = async (c: PlanningCase, index: number): Promise<{ world: WorldReading; o: ObservedPlan[] }> => {
  const world = await runWorld(c, template, dir, index);
  return { world, o: world.readings.map((r) => observe(r, world.keyOf)) };
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env['BRAIN_DATA_DIR'] ?? os.tmpdir(), 'adaptation-'));
  await proveDeliverables();
  template = await buildTemplate(dir);
}, 120_000);

afterAll(async () => {
  await closeWorldDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('each change reaches the planner, and the re-read plan moves as the change implies', () => {
  it('target, supplier cost, days to cash, deadline, contradicting evidence and a buyer gone', { timeout: 300_000 }, async () => {
    const { world, o } = await run(OPENINGS, 0);
    expect(world.readings).toHaveLength(OPENINGS.changes!.length + 1);
    expect(world.before).toBe(world.readings[0]);
    expect(world.reading).toBe(world.readings[7]);
    const [initial, target, costly, cheap, slow, later, contradicted, gone] = o as [ObservedPlan, ObservedPlan, ObservedPlan, ObservedPlan, ObservedPlan, ObservedPlan, ObservedPlan, ObservedPlan];
    const daysLeft = world.readings.map((r) => r.target.daysLeft);
    // The first reading: the one opening is considered with a complete chain.
    expect(initial.targetCents).toBe(200_000);
    expect(initial.missing['cu']).toEqual([]);
    // TARGET: the plan is read against the new amount.
    expect(target.targetCents).toBe(240_000);
    // SUPPLIER_COST above the price: the economics link fails on this opening, and no plan stands on it.
    expect(costly.missing['cu']).toContain('ECONOMICS');
    expect(costly.stance === 'NO_PLAN' || !costly.members.some((m) => m.key === 'cu')).toBe(true);
    // …and back under it: the link is whole again.
    expect(cheap.missing['cu']).not.toContain('ECONOMICS');
    // DAYS_TO_CASH past the deadline: the cash no longer settles in time.
    expect(slow.missing['cu']).toContain('SETTLES_IN_TIME');
    expect(slow.broken).toContain('DEADLINE');
    // DEADLINE moved to 90 days: the window the planner counts moves, and the cash settles inside it again.
    expect(daysLeft[5]).toBeGreaterThanOrEqual(89);
    expect(daysLeft[4]).toBeLessThanOrEqual(30);
    expect(later.missing['cu']).not.toContain('SETTLES_IN_TIME');
    expect(later.broken).not.toContain('DEADLINE');
    // CONTRADICTING_EVIDENCE on the price: the price is no longer read as established.
    const priceUnsettled = (p: ObservedPlan) =>
      p.stance === 'NO_PLAN' || (p.missing['cu'] ?? []).includes('OFFER_AND_PRICE') || p.members.some((m) => m.key === 'cu' && m.unestablished.includes('price'));
    expect(priceUnsettled(later)).toBe(false);
    expect(priceUnsettled(contradicted)).toBe(true);
    // BUYER_UNAVAILABLE: the opening is no longer considered, nor planned on.
    expect(Object.keys(later.missing)).toContain('cu');
    expect(Object.keys(gone.missing)).not.toContain('cu');
    expect(gone.members.some((m) => m.key === 'cu')).toBe(false);
  });

  it('starting capital, a capital limit removed, and a limit restated in the words', { timeout: 300_000 }, async () => {
    const { world, o } = await run(CAPITAL, 1);
    const ceilings = world.readings.map((r) => r.target.capitalCeilingCents);
    expect(ceilings).toEqual([1_000_000, 50_000, null, 100_000]);
    const [initial, small, removed, restated] = o as [ObservedPlan, ObservedPlan, ObservedPlan, ObservedPlan];
    expect(initial.broken).not.toContain('CAPITAL');
    // CAPITAL: $500 of starting capital cannot hold a $2,000 lot.
    expect(small.broken).toContain('CAPITAL');
    // CONSTRAINT removed: nothing limits what is tied up, so the limit is not broken.
    expect(removed.broken).not.toContain('CAPITAL');
    // OBJECTIVE: the restated words carry a $1,000 limit, and the planner holds it.
    expect(restated.broken).toContain('CAPITAL');
  });

  it('an owner-hours limit added, then removed, and the case graded at each step by the one grader', { timeout: 300_000 }, async () => {
    const { world, o } = await run(HOURS, 2);
    expect(world.readings.map((r) => r.target.hoursCeiling)).toEqual([null, 5, null]);
    const [initial, limited, freed] = o as [ObservedPlan, ObservedPlan, ObservedPlan];
    expect(initial.broken).not.toContain('OWNER_HOURS');
    expect(limited.broken).toContain('OWNER_HOURS');
    expect(freed.broken).not.toContain('OWNER_HOURS');
    // The grade judges the graded readings (after change 1 and the last), each against its own step's case.
    const g = gradeAdaptation(HOURS, world.readings, world.keyOf);
    expect(g.steps.map((s) => s.step)).toEqual([1, 2]);
    expect(g.steps.map((s) => s.change)).toEqual(['CONSTRAINT', 'CONSTRAINT']);
    expect(g.steps[0]!.grade.outcome === 'NO_PLAN_JUSTIFIED_CORRECT' || g.steps[0]!.grade.failures.length > 0).toBe(true);
  });
});
