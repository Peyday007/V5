/**
 * AUTO-20-1 repair, episode 1. Production, 2026-11-15: probe r01.auto-20-1 failed
 * because the operator's re-attempt of OPERATOR:RECURRING_OPERATIONAL_FAILURE:… #3
 * named attempt 2 as a failed method, and attempt 2 had been decided HELD.
 * registerNextAttempt counted every decision but KEPT and COMBINED as a failed
 * method; a HELD attempt waited on a person or a Factory stop and never ran its
 * method to an outcome. These pin that only KEPT_NO_EFFECT and REVERTED are named,
 * and that the already-stored mislabel is corrected by the improvement tick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { decideCandidate, getCandidate, listImprovementEvents, upsertCandidate } from '../server/repos/improvement.ts';
import type { Decision } from '../server/domain/improvement.ts';
import { correctMisjudgedMethods, improvementTick, isFailedMethod, registerNextAttempt } from '../server/services/improvement/loop.ts';
import { originationHoldsOnRows } from '../server/services/factory/program/release01/autonomyProbe.ts';

beforeEach(async () => {
  await freshProject();
});
afterEach(async () => {
  await teardown();
});

const BASE = 'OPERATOR:RECURRING_OPERATIONAL_FAILURE:6efa69506072328a';

async function member(key: string, attempt: number, opts: { decision?: Decision; evidence?: Record<string, unknown>; parentId?: string } = {}): Promise<string> {
  const { candidate } = await upsertCandidate({
    weaknessKey: key,
    kind: 'OPERATOR_DEFICIENCY',
    title: 'recurring operational failure',
    problem: 'p',
    metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
    downstreamMetric: null,
    ownerComponent: 'server/services/operator/director.ts',
    frequency: 3,
    denominator: 10,
    scope: 'GENERAL',
    severity: 'MEDIUM',
    evidence: opts.evidence ?? {},
    attempt,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  await getDb().run('UPDATE improvement_candidates SET created_at = ? WHERE id = ?', [`2026-11-0${attempt}T00:00:00.000Z`, candidate.id]);
  if (opts.decision) await decideCandidate(candidate.id, opts.decision, 'test');
  return candidate.id;
}

describe('a failed method is an attempt kept without effect or reverted', () => {
  it('reads only KEPT_NO_EFFECT and REVERTED as a failed method', () => {
    expect(isFailedMethod('KEPT_NO_EFFECT')).toBe(true);
    expect(isFailedMethod('REVERTED')).toBe(true);
    for (const d of ['HELD', 'REJECTED', 'COMBINED', 'KEPT', null, undefined]) expect(isFailedMethod(d)).toBe(false);
  });

  it('does not name a HELD attempt as a failed method when the operator starts the next attempt', async () => {
    const one = await member(BASE, 1, { decision: 'KEPT_NO_EFFECT' });
    const two = await member(`${BASE}#2`, 2, { decision: 'HELD', parentId: one });
    const next = await registerNextAttempt(two, { reason: 'the campaign stalled', evidence: {} });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const judged = next.candidate.evidence['methodInadequacy'] as { failedAttempts: number[] };
    expect(judged.failedAttempts).toEqual([1]);
    expect(next.candidate.evidence['reattempt']).toMatchObject({ priorDecisions: [{ attempt: 1, decision: 'KEPT_NO_EFFECT' }, { attempt: 2, decision: 'HELD' }] });
    const probe = await originationHoldsOnRows();
    expect(probe.ok).not.toBe(false);
  });

  it('records no method inadequacy at all when no earlier attempt ran its method to a failure', async () => {
    const one = await member(BASE, 1, { decision: 'HELD' });
    const next = await registerNextAttempt(one, { reason: 'held on a person who has since answered', evidence: {} });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.candidate.evidence['methodInadequacy']).toBeUndefined();
    expect(next.candidate.evidence['reattempt']).toMatchObject({ reason: 'held on a person who has since answered', priorDecisions: [{ attempt: 1, decision: 'HELD' }] });
  });

  it('re-judges rather than inherits a method judgment carried in the caller\'s evidence', async () => {
    // The director passes the previous attempt's whole evidence, judgment included.
    const one = await member(BASE, 1, { decision: 'HELD' });
    const inherited = { methodInadequacy: { judgment: 'Attempt(s) 1 ended HELD; …', failedAttempts: [1] }, directive: 'keep me', goalBaseline: 3 };
    const next = await registerNextAttempt(one, { reason: 'the person answered', evidence: inherited });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.candidate.evidence['methodInadequacy']).toBeUndefined();
    expect(next.candidate.evidence).toMatchObject({ directive: 'keep me', goalBaseline: 3 });
    expect((await originationHoldsOnRows()).ok).not.toBe(false);

    // With a real failure in the family, the new judgment replaces the inherited one.
    const two = await member('OPERATOR:INHERIT', 1, { decision: 'REVERTED' });
    const three = await member('OPERATOR:INHERIT#2', 2, { decision: 'HELD', parentId: two });
    const again = await registerNextAttempt(three, { reason: 'stalled', evidence: { methodInadequacy: { judgment: 'stale', failedAttempts: [1, 2] } } });
    expect(again.ok && (again.candidate.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
  });

  it('still names a reverted attempt as a failed method', async () => {
    const one = await member(BASE, 1, { decision: 'REVERTED' });
    const next = await registerNextAttempt(one, { reason: 'reverted', evidence: {} });
    expect(next.ok && (next.candidate.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
  });
});

describe('a stored judgment that names a HELD attempt is corrected on the tick', () => {
  it('rewrites the evidence, keeps the original in an event, and changes nothing the second time', async () => {
    const one = await member(BASE, 1, { decision: 'KEPT_NO_EFFECT' });
    const two = await member(`${BASE}#2`, 2, { decision: 'HELD', parentId: one });
    // The row production holds: attempt 2 named as failed though it was HELD.
    const three = await member(`${BASE}#3`, 3, {
      parentId: two,
      evidence: { methodInadequacy: { judgment: 'Attempt(s) 1, 2 ended KEPT_NO_EFFECT, HELD; …', failedAttempts: [1, 2] } },
    });
    const held = await member('OPERATOR:OTHER', 1, { decision: 'HELD' });
    const onlyHeld = await member('OPERATOR:OTHER#2', 2, {
      parentId: held,
      evidence: { methodInadequacy: { judgment: 'Attempt(s) 1 ended HELD; …', failedAttempts: [1] } },
    });
    expect((await originationHoldsOnRows()).ok).toBe(false);

    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.advanced).toEqual(expect.arrayContaining([`${BASE}#3: method judgment corrected`, 'OPERATOR:OTHER#2: method judgment corrected']));

    const fixed = (await getCandidate(three))!;
    expect((fixed.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    const cleared = (await getCandidate(onlyHeld))!;
    expect(cleared.evidence['methodInadequacy']).toBeUndefined();
    expect(cleared.evidence['reattempt']).toMatchObject({ priorDecisions: [{ attempt: 1, decision: 'HELD' }] });

    const events = await listImprovementEvents({ candidateId: three, kinds: ['METHOD_JUDGMENT_CORRECTED'] });
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ original: { failedAttempts: [1, 2] }, dropped: [{ attempt: 2, decision: 'HELD' }], kept: [1] });

    expect(await correctMisjudgedMethods()).toEqual([]);
    expect(await listImprovementEvents({ candidateId: three, kinds: ['METHOD_JUDGMENT_CORRECTED'] })).toHaveLength(1);
    expect((await originationHoldsOnRows()).ok).not.toBe(false);
  });
});
