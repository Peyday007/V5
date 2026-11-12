/**
 * ACQ-21-5, effect guard: one browser mutation per approved input, request
 * limits held across workers, and an unknown outcome never retried.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { BROWSER_WORKFLOW_RUN_EVENT } from '../server/services/sources/browserWorkflow.ts';
import {
  DEFAULT_HOST_RUNS_PER_MINUTE,
  EFFECT_CLAIM_TTL_MS,
  browserEffectKey,
  claimBrowserEffect,
  guardBrowserRun,
  readBrowserEffect,
  readRequestBudget,
  requestBudgetFrom,
  resolveUnknownBrowserEffect,
  settleBrowserEffect,
  type BrowserCapability,
} from '../server/services/sources/browser/effectGuard.ts';

const cap: BrowserCapability = { host: 'portal.example.org', name: 'Submit renewal', version: '2026-11-01T00:00:00.000Z' };
const input = { form: { reference: 'R-1001', quantity: 2 } };
const worker = { type: 'WORKER' as const, id: 'wrk_a' };
const otherWorker = { type: 'WORKER' as const, id: 'wrk_b' };

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('the logical effect key', () => {
  it('is the same for the same capability version and approved input, whatever order the input was written in', () => {
    const a = browserEffectKey({ capability: cap, approvedInput: { form: { reference: 'R-1001', quantity: 2 } } });
    const b = browserEffectKey({ capability: { ...cap, host: 'PORTAL.example.org ' }, approvedInput: { form: { quantity: 2, reference: 'R-1001' } } });
    expect(a).toBe(b);
    expect(a).toMatch(/^bwe-[0-9a-f]{48}$/);
  });

  it('ignores scope, worker and attempt a caller sends beside it', () => {
    const plain = browserEffectKey({ capability: cap, approvedInput: input });
    const withExtras = browserEffectKey({ capability: cap, approvedInput: input, scope: 'mine', workerId: 'wrk_z', attempt: 7, projectId: 'prj_other' } as never);
    expect(withExtras).toBe(plain);
  });

  it('changes with the version or the approved input', () => {
    const base = browserEffectKey({ capability: cap, approvedInput: input });
    expect(browserEffectKey({ capability: { ...cap, version: '2026-11-02T00:00:00.000Z' }, approvedInput: input })).not.toBe(base);
    expect(browserEffectKey({ capability: cap, approvedInput: { form: { reference: 'R-1002', quantity: 2 } } })).not.toBe(base);
  });
});

describe('claiming a mutation', () => {
  it('lets exactly one of two concurrent workers perform it', async () => {
    const [a, b] = await Promise.all([
      claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: worker }),
      claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: otherWorker }),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const loser = a.claimed ? b : a;
    expect(loser.claimed).toBe(false);
    if (!loser.claimed) expect(loser.reason).toBe('HELD');
  });

  it('refuses a second claim of a completed effect', async () => {
    const first = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: worker });
    expect(first.claimed).toBe(true);
    expect(await settleBrowserEffect(first.operationId, { result: 'COMPLETED', summary: 'confirmation page shown' })).toBe(true);
    const again = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: otherWorker });
    expect(again).toMatchObject({ claimed: false, reason: 'COMPLETED', operationId: first.operationId });
  });

  it('never auto-retries an UNKNOWN outcome, and only a stated resolution clears it', async () => {
    const first = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: worker });
    expect(await settleBrowserEffect(first.operationId, { result: 'UNKNOWN', reason: 'timed out after pressing submit' })).toBe(true);
    for (const actor of [worker, otherWorker]) {
      const retry = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor });
      expect(retry).toMatchObject({ claimed: false, reason: 'UNKNOWN' });
    }
    expect((await readBrowserEffect(first.operationId))?.state).toBe('UNCERTAIN');
    await expect(resolveUnknownBrowserEffect(first.operationId, { by: 'VERIFICATION', happened: true, evidence: ' ' })).rejects.toThrow();
    expect(await resolveUnknownBrowserEffect(first.operationId, { by: 'VERIFICATION', happened: true, evidence: 'renewal R-1001 listed as submitted' })).toBe(true);
    expect((await readBrowserEffect(first.operationId))?.state).toBe('SUCCEEDED');
  });

  it('turns a claim its executor abandoned into UNKNOWN rather than performing it again', async () => {
    const start = new Date();
    const first = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: worker, now: new Date(start.getTime() - EFFECT_CLAIM_TTL_MS - 60_000) });
    expect(first.claimed).toBe(true);
    const later = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: otherWorker });
    expect(later).toMatchObject({ claimed: false, reason: 'UNKNOWN' });
    expect((await readBrowserEffect(first.operationId))?.state).toBe('UNCERTAIN');
  });

  it('refuses a failed effect rather than repeating it', async () => {
    const first = await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: worker });
    await settleBrowserEffect(first.operationId, { result: 'FAILED', detail: 'the site rejected the reference' });
    expect(await claimBrowserEffect({ projectId, capability: cap, approvedInput: input, actor: worker })).toMatchObject({ claimed: false, reason: 'FAILED' });
  });
});

describe('the request limit', () => {
  const now = new Date('2026-11-12T12:00:00.000Z');
  const rowAt = (secondsAgo: number, outcome = 'COMPLETED', id = `bev_${secondsAgo}`) => ({ id, outcome, at: new Date(now.getTime() - secondsAgo * 1000).toISOString() });

  it('defers a host at the site-declared limit, naming the limit and the rows counted', () => {
    const rows = [rowAt(5), rowAt(20), rowAt(50), rowAt(90), rowAt(10, 'REFUSED')];
    const budget = requestBudgetFrom('portal.example.org', rows, { now, declaredPerMinute: 3 });
    expect(budget).toMatchObject({ decision: 'DEFER', limit: 3, limitSource: 'SITE_DECLARED', counted: 3 });
    expect(budget.countedRowIds).toEqual(['bev_50', 'bev_20', 'bev_5']);
    expect(budget.reason).toContain('limit of 3/min');
    expect(budget.retryAfter).toBe(new Date(now.getTime() + 10_000).toISOString());
  });

  it('never lets a site-declared limit raise Brain\'s own ceiling, and proceeds under it', () => {
    const budget = requestBudgetFrom('portal.example.org', [rowAt(5)], { now, declaredPerMinute: 1000 });
    expect(budget).toMatchObject({ decision: 'PROCEED', limit: DEFAULT_HOST_RUNS_PER_MINUTE, limitSource: 'BRAIN_DEFAULT', counted: 1 });
  });

  it('defers a host that answered it is rate limited', () => {
    expect(requestBudgetFrom('portal.example.org', [], { now, rateLimited: true }).decision).toBe('DEFER');
  });

  it('counts the host\'s own BROWSER_WORKFLOW_RUN rows across workers, and a deferred run claims nothing', async () => {
    for (let i = 0; i < 2; i += 1) {
      await recordBinEvent({ eventType: BROWSER_WORKFLOW_RUN_EVENT, outcome: 'COMPLETED', measures: { host: 'portal.example.org', name: 'Submit renewal' }, workloadClass: 'acquisition' });
    }
    await recordBinEvent({ eventType: BROWSER_WORKFLOW_RUN_EVENT, outcome: 'COMPLETED', measures: { host: 'elsewhere.example.net', name: 'x' }, workloadClass: 'acquisition' });
    const budget = await readRequestBudget('portal.example.org', { declaredPerMinute: 2 });
    expect(budget).toMatchObject({ decision: 'DEFER', counted: 2, limit: 2 });
    expect(budget.countedRowIds).toHaveLength(2);

    const guarded = await guardBrowserRun({ projectId, capability: cap, approvedInput: input, actor: worker, effect: 'MUTATION', declaredPerMinute: 2 });
    expect(guarded.decision).toBe('DEFER');
    const ops = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM idempotency_operations WHERE namespace = 'browser.workflow.effect'");
    expect(Number(ops[0]?.n ?? 0)).toBe(0);
  });

  it('lets a read proceed unclaimed and a mutation proceed once', async () => {
    const read = await guardBrowserRun({ projectId, capability: cap, approvedInput: input, actor: worker, effect: 'READ', rows: async () => [] });
    expect(read).toMatchObject({ decision: 'PROCEED', claim: null });
    const first = await guardBrowserRun({ projectId, capability: cap, approvedInput: input, actor: worker, effect: 'MUTATION', rows: async () => [] });
    expect(first.decision).toBe('PROCEED');
    const second = await guardBrowserRun({ projectId, capability: cap, approvedInput: input, actor: otherWorker, effect: 'MUTATION', rows: async () => [] });
    expect(second.decision).toBe('REFUSE');
  });
});
