/**
 * AUTO-20-1 repair, episode 2. Production, 2026-11-15 02:10Z–06:13Z: probe r01.auto-20-1
 * kept failing with "candidate OPERATOR:RECURRING_OPERATIONAL_FAILURE:6efa69506072328a#3
 * names attempt 2 as a failed method, but that attempt was decided HELD". The episode-1
 * repair (isFailedMethod, an un-inherited re-attempt judgment, correctMisjudgedMethods on
 * every improvement pass) was merged, but the release carrying it (Deploy run 1081 of
 * e678e79) failed at 05:46:59Z; the first successful release containing it (run 1082 of
 * 18d998a) finished at 06:17:03Z, after the last recorded failure. The stored row was
 * written by the pre-fix registerNextAttempt and only the released build's tick corrects it.
 *
 * This pins that sequence end to end, on the real schema through the repositories and the
 * probe function itself: rows as the pre-fix build left them fail the probe with exactly the
 * production detail; the released build's first pass (switch off or on) corrects them; a
 * second pass changes nothing; and no later path — an operator re-attempt, a re-registration
 * of the weakness, or a route set aside — names a HELD attempt as a failed method again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  decideCandidate,
  getCandidate,
  getCandidateByKey,
  listCandidates,
  listImprovementEvents,
  patchCandidate,
  upsertCandidate,
} from '../server/repos/improvement.ts';
import type { Decision, Weakness } from '../server/domain/improvement.ts';
import {
  improvementTickIfDue,
  isFailedMethod,
  ownerHandoffRef,
  registerDirected,
  registerNextAttempt,
  resetImprovementTick,
} from '../server/services/improvement/loop.ts';
import { originationHoldsOnRows } from '../server/services/factory/program/release01/autonomyProbe.ts';

const BASE = 'OPERATOR:RECURRING_OPERATIONAL_FAILURE:6efa69506072328a';
const HELD_ONLY = 'OPERATOR:RECURRING_OPERATIONAL_FAILURE:heldonly0000000';
const DIRECTED = 'OPERATOR:RECURRING_OPERATIONAL_FAILURE:director000000';
const ROUTED = 'ORIGINATED:UNMET_NEED:release-correction-capacity';
const ROUTE = { kind: 'INTEGRATION', owner: 'integration manager', why: 'a connector is missing' } as const;
const PRODUCTION_DETAIL = `candidate ${BASE}#3 names attempt 2 as a failed method, but that attempt was decided HELD`;
const MISLABEL = /names attempt \d+ as a failed method/;

let owner = 0;

async function member(
  key: string,
  attempt: number,
  opts: { decision?: Decision; evidence?: Record<string, unknown>; parentId?: string; kind?: string; deliveredRef?: string } = {},
): Promise<string> {
  owner += 1;
  const { candidate } = await upsertCandidate({
    weaknessKey: key,
    kind: opts.kind ?? 'OPERATOR_DEFICIENCY',
    title: 'recurring operational failure',
    problem: 'p',
    metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
    downstreamMetric: null,
    // One owner per row, so nothing is combined into anything else.
    ownerComponent: `server/services/operator/release-correction-${owner}.ts`,
    frequency: 3,
    denominator: 10,
    scope: 'GENERAL',
    severity: 'MEDIUM',
    evidence: opts.evidence ?? {},
    attempt,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  await getDb().run('UPDATE improvement_candidates SET created_at = ? WHERE id = ?', [`2026-11-0${attempt}T00:00:00.000Z`, candidate.id]);
  if (opts.deliveredRef) await patchCandidate(candidate.id, { deliveredAt: '2026-11-02T00:00:00.000Z', deliveredRef: opts.deliveredRef });
  if (opts.decision) await decideCandidate(candidate.id, opts.decision, 'test');
  return candidate.id;
}

const judgment = (failedAttempts: number[]) => ({
  judgment: `Attempt(s) ${failedAttempts.join(', ')} ended …; the operator started this attempt: the campaign stalled. Change the method, do not re-run it.`,
  failedAttempts,
});

/** Every row as the pre-fix build left it on production. */
type Ids = Record<'one' | 'two' | 'three' | 'h1' | 'h2' | 'h3' | 'd1' | 'd2' | 'd3' | 'r1' | 'r2' | 'r3', string>;

async function seedPreFix(checkProductionDetail = false): Promise<Ids> {
  const ids = {} as Ids;
  // The production family: #1 kept without effect, #2 held, #3 open naming 1 and 2.
  ids.one = await member(BASE, 1, { decision: 'KEPT_NO_EFFECT' });
  ids.two = await member(`${BASE}#2`, 2, { decision: 'HELD', parentId: ids.one });
  ids.three = await member(`${BASE}#3`, 3, { parentId: ids.two, evidence: { methodInadequacy: judgment([1, 2]) } });
  if (checkProductionDetail) {
    // The production family alone fails the probe with exactly the recorded production detail.
    const before = await originationHoldsOnRows();
    expect(before.ok).toBe(false);
    expect(before.detail).toBe(PRODUCTION_DETAIL);
  }
  // A variant decided HELD throughout, whose #3 names only the HELD attempt 2.
  ids.h1 = await member(HELD_ONLY, 1, { decision: 'HELD' });
  ids.h2 = await member(`${HELD_ONLY}#2`, 2, { decision: 'HELD', parentId: ids.h1 });
  ids.h3 = await member(`${HELD_ONLY}#3`, 3, { parentId: ids.h2, evidence: { methodInadequacy: judgment([2]) } });
  // A variant written through the director's re-attempt path: the earlier evidence carried whole.
  ids.d1 = await member(DIRECTED, 1, { decision: 'KEPT_NO_EFFECT' });
  ids.d2 = await member(`${DIRECTED}#2`, 2, { decision: 'HELD', parentId: ids.d1 });
  ids.d3 = await member(`${DIRECTED}#3`, 3, {
    parentId: ids.d2,
    evidence: {
      directive: 'change how the stalled campaign is resumed',
      goalBaseline: 3,
      reattempt: { reason: 'the campaign stalled', priorDecisions: [{ attempt: 1, decision: 'KEPT_NO_EFFECT' }, { attempt: 2, decision: 'HELD' }] },
      methodInadequacy: judgment([1, 2]),
    },
  });
  // A routed gap: #1 handed off and kept without effect, #2 handed off by the same route and HELD,
  // #3 open naming both — the route set-aside unions this prior judgment.
  const origination = { family: 'UNMET_NEED', judgment: 'needs wait on capacity Brain cannot reach', observed: ['need:n1'], handTo: [], route: ROUTE };
  const ref = ownerHandoffRef(ROUTE);
  ids.r1 = await member(ROUTED, 1, { kind: 'ORIGINATED_UNMET_NEED', decision: 'KEPT_NO_EFFECT', deliveredRef: ref, evidence: { origination } });
  ids.r2 = await member(`${ROUTED}#2`, 2, { kind: 'ORIGINATED_UNMET_NEED', decision: 'HELD', deliveredRef: ref, parentId: ids.r1, evidence: { origination } });
  ids.r3 = await member(`${ROUTED}#3`, 3, {
    kind: 'ORIGINATED_UNMET_NEED',
    parentId: ids.r2,
    evidence: { origination, knownCause: 'no connector reaches a supplier with spare capacity', methodInadequacy: judgment([1, 2]) },
  });
  return ids;
}

async function setSwitch(enabled: boolean): Promise<void> {
  const { IMPROVEMENT_SWITCH } = await import('../server/services/improvement/authority.ts');
  await getDb().run(
    `INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled`,
    [IMPROVEMENT_SWITCH, enabled ? 1 : 0, new Date().toISOString(), 'test', 'release-correction test'],
  );
}

/** A fresh process state and one improvement pass, as the released build's durable tick runs it. */
async function releasedPass(): Promise<void> {
  resetImprovementTick();
  const report = await improvementTickIfDue(Date.now() + 1000);
  expect(report).not.toBeNull();
}

/** Every stored method judgment names only attempts its own family decided as failed methods. */
async function noHeldNamed(): Promise<void> {
  const all = await listCandidates();
  for (const c of all) {
    const judged = c.evidence['methodInadequacy'] as { failedAttempts?: number[] } | undefined;
    if (!judged?.failedAttempts) continue;
    const base = c.weaknessKey.split('#')[0]!;
    for (const n of judged.failedAttempts) {
      const m = all.find((x) => (x.weaknessKey === base || x.weaknessKey.startsWith(`${base}#`)) && x.attempt === n);
      expect(isFailedMethod(m?.decision), `${c.weaknessKey} names attempt ${n} (${m?.decision ?? 'missing'})`).toBe(true);
    }
  }
}

beforeEach(async () => {
  owner = 0;
  await freshProject();
  const existing = await getProjectBySlug('brain-architecture');
  const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
  await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
  await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
});
afterEach(async () => {
  await teardown();
});

describe.each([
  ['off', false],
  ['on', true],
])('the released build corrects the episode-2 mislabel with the improvement switch %s', (_label, enabled) => {
  it('fails the probe with the production detail before, and passes it after one pass, idempotently', async () => {
    await setSwitch(enabled);
    const ids = await seedPreFix(true);
    expect((await originationHoldsOnRows()).ok).toBe(false);

    await releasedPass();

    // (a) The probe no longer reports any attempt named as a failed method that was not one.
    const after = await originationHoldsOnRows();
    expect(after.detail ?? '').not.toMatch(MISLABEL);
    expect(after.ok).not.toBe(false);
    await noHeldNamed();

    // (b) Only KEPT_NO_EFFECT/REVERTED attempts stay named; a judgment left with none is removed and
    // moved to `reattempt`; the original survives in an append-only METHOD_JUDGMENT_CORRECTED event.
    expect(((await getCandidate(ids.three))!.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    const heldOnly = (await getCandidate(ids.h3))!;
    expect(heldOnly.evidence['methodInadequacy']).toBeUndefined();
    expect(heldOnly.evidence['reattempt']).toMatchObject({
      priorDecisions: [{ attempt: 1, decision: 'HELD' }, { attempt: 2, decision: 'HELD' }],
      judgment: judgment([2]).judgment,
    });
    const directed = (await getCandidate(ids.d3))!;
    expect((directed.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    expect(directed.evidence).toMatchObject({ directive: 'change how the stalled campaign is resumed', goalBaseline: 3 });
    expect(directed.evidence['reattempt']).toMatchObject({ reason: 'the campaign stalled' });
    const routed = (await getCandidate(ids.r3))!;
    expect((routed.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    if (enabled) {
      // The pass that advanced the routed gap set its route aside on the attempt that failed, never the HELD one.
      const aside = routed.evidence['routeSetAside'] as { failedAttempts: number[] } | undefined;
      if (aside) expect(aside.failedAttempts).toEqual([1]);
    }

    const corrected = async (id: string) => listImprovementEvents({ candidateId: id, kinds: ['METHOD_JUDGMENT_CORRECTED'] });
    const first = await corrected(ids.three);
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).toMatchObject({ original: { failedAttempts: [1, 2] }, dropped: [{ attempt: 2, decision: 'HELD' }], kept: [1] });
    expect((await corrected(ids.h3))[0]!.detail).toMatchObject({ original: { failedAttempts: [2] }, kept: [] });
    expect(await corrected(ids.d3)).toHaveLength(1);
    expect(await corrected(ids.r3)).toHaveLength(1);
    // Rows that named nothing false were not touched.
    for (const id of [ids.one, ids.two, ids.h1, ids.h2, ids.d1, ids.d2, ids.r1, ids.r2]) expect(await corrected(id)).toEqual([]);

    // (c) A second pass changes nothing: no new event, the same evidence.
    const snapshot = await Promise.all([ids.three, ids.h3, ids.d3].map(async (id) => (await getCandidate(id))!.evidence['methodInadequacy'] ?? null));
    await releasedPass();
    for (const id of [ids.three, ids.h3, ids.d3, ids.r3]) expect(await corrected(id)).toHaveLength(1);
    expect(await Promise.all([ids.three, ids.h3, ids.d3].map(async (id) => (await getCandidate(id))!.evidence['methodInadequacy'] ?? null))).toEqual(snapshot);
    expect((await originationHoldsOnRows()).detail ?? '').not.toMatch(MISLABEL);
  });
});

describe('no later path re-introduces a HELD attempt as a failed method', () => {
  it('an operator re-attempt from the HELD #2 or from #3 names no HELD attempt', async () => {
    const ids = await seedPreFix();
    await releasedPass();

    // From the HELD #2: a later attempt exists, so nothing is written.
    const fromTwo = await registerNextAttempt(ids.two, { reason: 'stalled again', evidence: (await getCandidate(ids.two))!.evidence });
    expect(fromTwo.ok).toBe(false);
    // From #3, decided HELD as the director decides it before re-attempting: #3 is the last attempt.
    await decideCandidate(ids.three, 'HELD', 'operator re-attempt');
    const fromThree = await registerNextAttempt(ids.three, { reason: 'stalled again', evidence: (await getCandidate(ids.three))!.evidence });
    expect(fromThree.ok).toBe(false);

    // A two-attempt family where the re-attempt is allowed, with the director passing #2's whole
    // evidence, stale judgment included: the new attempt is judged from the family's own decisions.
    const a = await member('OPERATOR:RECURRING_OPERATIONAL_FAILURE:twoattempt0000', 1, { decision: 'KEPT_NO_EFFECT' });
    const b = await member('OPERATOR:RECURRING_OPERATIONAL_FAILURE:twoattempt0000#2', 2, {
      decision: 'HELD',
      parentId: a,
      evidence: { directive: 'keep me', methodInadequacy: judgment([1, 2]) },
    });
    const next = await registerNextAttempt(b, { reason: 'the campaign stalled', evidence: (await getCandidate(b))!.evidence });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect((next.candidate.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    expect(next.candidate.evidence).toMatchObject({ directive: 'keep me' });

    await releasedPass();
    await noHeldNamed();
    expect((await originationHoldsOnRows()).detail ?? '').not.toMatch(MISLABEL);
  });

  it('a later register() of the same weakness names no HELD attempt, refreshing an open attempt or opening the next', async () => {
    const ids = await seedPreFix();
    await releasedPass();

    const weakness = (key: string): Weakness => ({
      key,
      kind: 'OPERATOR_DEFICIENCY',
      title: 'recurring operational failure',
      problem: 'p',
      metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
      downstreamMetric: null,
      ownerComponent: `server/services/operator/register-${key.slice(-6)}.ts`,
      mutationScope: [],
      frequency: 4,
      denominator: 10,
      scope: 'GENERAL',
      severity: 'MEDIUM',
      researchQuestion: 'why does the operation keep failing',
      samples: ['s1'],
      knownCause: null,
    });

    // The production family's #3 is open: a re-registration refreshes it and keeps the corrected judgment.
    await registerDirected(weakness(BASE));
    expect(((await getCandidateByKey(`${BASE}#3`))!.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);

    // A decided family long past its recurrence wait: register() opens #3 judged from the decisions.
    const key = 'OPERATOR:RECURRING_OPERATIONAL_FAILURE:registered0000';
    const one = await member(key, 1, { decision: 'KEPT_NO_EFFECT' });
    const two = await member(`${key}#2`, 2, { decision: 'HELD', parentId: one });
    await getDb().run('UPDATE improvement_candidates SET updated_at = ? WHERE id = ?', ['2026-10-01T00:00:00.000Z', two]);
    const { candidate, created } = await registerDirected(weakness(key));
    expect(created).toBe(true);
    expect(candidate.weaknessKey).toBe(`${key}#3`);
    expect((candidate.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);

    await noHeldNamed();
    expect((await originationHoldsOnRows()).detail ?? '').not.toMatch(MISLABEL);
    expect(ids.three).toBeTruthy();
  });

  it('a route set aside on a pass unions only failed methods into the prior judgment', async () => {
    await setSwitch(true);
    const ids = await seedPreFix();
    await releasedPass();
    await releasedPass();
    const routed = (await getCandidate(ids.r3))!;
    expect((routed.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    const aside = routed.evidence['routeSetAside'] as { failedAttempts: number[] } | undefined;
    if (aside) expect(aside.failedAttempts).toEqual([1]);
    await noHeldNamed();
  });

  it('a mislabel left on a row the director already decided HELD is corrected too, once, leaving the decision as it was', async () => {
    // The director decides the latest attempt HELD before re-attempting it; at attempt 3 of 3 the
    // re-attempt is refused, so the stale judgment stays on a decided row the pre-fix build wrote.
    const ids = await seedPreFix(true);
    await decideCandidate(ids.three, 'HELD', 'operator re-attempt');
    const decided = (await getCandidate(ids.three))!;
    expect((await originationHoldsOnRows()).ok).toBe(false);

    await releasedPass();
    const fixed = (await getCandidate(ids.three))!;
    expect((fixed.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
    expect(fixed.decision).toBe('HELD');
    expect(fixed.decisionReason).toBe(decided.decisionReason);
    expect(fixed.updatedAt).toBe(decided.updatedAt);
    expect((await originationHoldsOnRows()).detail ?? '').not.toMatch(MISLABEL);
    await noHeldNamed();

    await releasedPass();
    expect(await listImprovementEvents({ candidateId: ids.three, kinds: ['METHOD_JUDGMENT_CORRECTED'] })).toHaveLength(1);
  });
});
