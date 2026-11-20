/**
 * A plan read never holds the server's loop for more than one evaluation
 * (release check run 44718014146, 2026-11-20, commit 239230fc).
 *
 * `goals.sh check` read goal wst_db2e2e0e5204477692d5 (a $5,000/month
 * recurring goal, $1,500 of capital, the refused/NEEDS_EVIDENCE path): it
 * printed `trace plan … composed`, and then nothing — not one line of its 30 s
 * heartbeat, and not its own 6-minute timeout — for 27 minutes, until the job
 * was killed. A read of the same goal minutes later took under a minute. A
 * timer that cannot fire is a loop held by synchronous work.
 *
 * The one engine every plan reads (`evaluateGoalPortfolio`) is synchronous,
 * and two paths put it on the loop:
 *
 *  - the evaluator pool re-ran an evaluation that timed out on its thread
 *    inline — the input known to be too heavy for a thread, on the loop — and
 *    counted every timeout against the replacement budget meant for threads
 *    that cannot boot, so on a contended machine (the check runs at nice 19
 *    beside a freshly deployed server) three timeouts left the pool threadless
 *    and every later evaluation of the read ran inline;
 *  - the inline evaluator yielded with one `setImmediate` per evaluation, but
 *    an exploration asks for a chunk at once, so all of them resumed in the
 *    same check phase and ran as one block with every timer starved.
 *
 * Each is held here by measuring the loop itself, against what the same work
 * holds it for when it runs on it (a contended runner deschedules the main
 * thread whatever it does, so an absolute bound would measure the runner).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { inlineEvaluator, openEvaluator } from '../server/services/goals/reasoning/evaluatorPool.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { clearConstructionMemo } from '../server/services/cash/construct.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims } from '../server/repos/research.ts';

const input = (worlds: number, seed = 11) => ({ ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, seed, openings: GOAL_10K_OPENINGS, worlds });

/** How long `work` holds the loop when it runs on it, synchronously. */
function inlineHold(work: () => unknown): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

/** The longest the loop went without turning while `work` ran, and how many times it turned. */
async function watchLoop<T>(work: () => Promise<T>): Promise<{ value: T | Error; worst: number; turns: number }> {
  let last = performance.now();
  let worst = 0;
  let turns = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
    turns++;
  }, 1);
  try {
    const value = await work().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    return { value, worst: Math.max(worst, performance.now() - last), turns };
  } finally {
    clearInterval(tick);
  }
}

describe('the evaluator never holds the loop for more than one evaluation', () => {
  it('inline evaluations asked for at once each get their own turn of the loop', async () => {
    const evaluator = inlineEvaluator();
    await evaluator.evaluate(input(200));
    const one = inlineHold(() => evaluateGoalPortfolio(input(3_000, 99)));
    const asked = 6;
    const { value, worst, turns } = await watchLoop(() => Promise.all(Array.from({ length: asked }, (_, i) => evaluator.evaluate(input(3_000, 100 + i)))));
    expect(value).not.toBeInstanceOf(Error);
    // Before: the six resumed in one check phase, ran as one block (~6 × one), and not a single timer fired between them.
    expect(turns).toBeGreaterThanOrEqual(asked - 1);
    expect(worst).toBeLessThan(Math.max(250, one * 2.5));
  }, 120_000);

  it('an evaluation a thread cannot finish is abandoned, never rerun on the loop, and slow threads do not empty the pool', async () => {
    const heavy = input(10_000);
    const onLoop = inlineHold(() => evaluateGoalPortfolio(heavy));
    // A timeout no thread can meet: every attempt is a thread fault, as on a machine whose cores the server holds.
    const pool = openEvaluator(1, { evaluationTimeoutMs: 40 });
    try {
      // Three reads: six timeouts, twice the replacement budget. Before, the first timeout reran the evaluation on the
      // loop (a stall of `onLoop`), and after three the pool had no thread, so every evaluation ran on the loop.
      for (let read = 0; read < 3; read++) {
        const { value, worst } = await watchLoop(() => pool.evaluate(heavy));
        expect(worst, `read ${read + 1}: the loop was held ${Math.round(worst)} ms (the evaluation on the loop: ${Math.round(onLoop)} ms)`).toBeLessThan(Math.max(150, onLoop / 3));
        expect(value).toBeInstanceOf(Error);
        expect((value as Error).message).toMatch(/evaluation abandoned after 2 attempts on a thread: timed out on its thread/);
      }
    } finally {
      await pool.close();
    }
  }, 120_000);

  it('an evaluation that answers on its thread reads exactly as it does inline', async () => {
    const pool = openEvaluator(1);
    try {
      const read = input(500);
      expect((await pool.evaluate(read)).best).toEqual(evaluateGoalPortfolio(read).best);
    } finally {
      await pool.close();
    }
  }, 120_000);
});

/** A sourced, accepted claim a price fact can cite. */
async function priceClaim(onProject: string, suffix: string): Promise<string> {
  const layerId = (await listLayers(onProject))[0]!.id;
  const run = await createRun({ projectId: onProject, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'price' });
  const orchestration = await createOrchestration({ projectId: onProject, layerId, runId: run.id, title: 'price', assignment: 'price', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: onProject, layerId, fragmentIndex: 0, fragmentKey: `price-${suffix}`, question: 'What these buyers pay',
      requiredEvidence: [{ id: 'figure', description: 'a published price', necessity: 'REQUIRED' }], acceptableSourceTypes: ['price list'], excludedSourceTypes: [],
      completionCriteria: ['a price'], dependsOn: [], minIndependentSources: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: `A practice pays $200 a month for a compliance report ${suffix}`, sourceUrl: `https://example.org/price/${suffix}`, sourceTitle: 'Price list', sourcePublisher: 'example.org',
      sourceDate: '2026-10-01', evidenceExcerpt: '$200 a month', evidenceLocator: 'table 1', evidenceLane: 'figure', retrievedAt: '2026-11-01', confidence: 0.9,
      validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const, contentHash: `ry-${suffix}`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

describe("a plan read of the incident goal's shape hands the loop back", () => {
  let projectId = '';
  let userId = '';
  beforeAll(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    clearConstructionMemo();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `ry-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    // A map and no priced opening: the read takes the refused path, its plan built from constructed arrangements.
    const actorRef = `person:${userId}`;
    for (const sector of ['Dentistry', 'Property management', 'Veterinary clinics']) {
      const root = await seedSubject({ projectId, name: sector, actorRef });
      for (const buyer of [`${sector} owners`, `Independent ${sector.toLowerCase()} operators`]) {
        const node = await seedSubject({ projectId, name: buyer, kind: 'BUYER_TYPE', parentId: root.node.id, actorRef });
        for (const [suffix, low, high] of [['a', 150, 250], ['b', 200, 300]] as const) {
          const claimId = await priceClaim(projectId, `${suffix}${node.node.id}`);
          await recordClaimFact({
            projectId, nodeId: node.node.id, claimId, key: 'price_per_unit', segment: `map_${node.node.id}`, low, high, status: 'OBSERVED',
            measures: `a ${buyer.toLowerCase()} pays a month for a compliance report`, sourceTitle: 'Price list', sourceUrl: `https://example.org/${claimId}`, sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
          });
        }
      }
    }
  }, 120_000);
  afterAll(async () => {
    await teardown();
  });

  it('reads a $5,000-a-month goal on $1,500 with the loop never held for seconds', async () => {
    const created = await createGoal({ projectId, objective: 'Earn $5,000 a month in recurring revenue within 30 days, with at most 1,500 dollars of starting capital.', actorRef: `person:${userId}`, userId, now: new Date(Date.now() - 60_000) });
    expect(created.ok, created.ok ? '' : created.reason).toBe(true);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const { value, worst } = await watchLoop(() => readGoalPlan({ goalId: created.ok ? created.goal.id : '', persist: false }));
    delay.disable();
    expect(value).not.toBeInstanceOf(Error);
    const reading = value as Awaited<ReturnType<typeof readGoalPlan>>;
    expect(reading?.verdict).toBe('NEEDS_EVIDENCE');
    // About half a second on an idle machine; a read that held the loop for an evaluation chunk or a timed-out
    // evaluation would be many times this.
    expect(worst).toBeLessThan(3_000);
    expect(delay.max / 1e6).toBeLessThan(3_000);
  }, 300_000);
});
