/**
 * OPP-04 repair, episode 2, finding F3: a failed construction is not "no pathway".
 *
 * `readGoalPlan` caught a failed `goalArrangements` and read the plan with no constructed
 * arrangements, so a live goal whose model is refused read no pathway at all — production's
 * "30 live goal(s) read; none has a pathway". What construction composed for the goal on an
 * earlier pass is in the library (`rememberArrangements`), and is read back instead.
 *
 *   R01 — the pure reader takes a stored design back as an arrangement, and refuses rows that
 *         carry none, carry a malformed one, or name one organisation rather than a population.
 *   R02 — construction throws on a live goal whose model is refused: the plan still exposes the
 *         goal's own library designs as marked pathways, says construction failed, and the probe
 *         passes on them.
 *   R03 — construction throws and the library holds nothing for the goal: the failure stands
 *         and is said, never replaced by another goal's designs.
 */
import { describe, expect, it, vi } from 'vitest';

const construction = vi.hoisted(() => ({ fail: false }));
vi.mock('../server/services/cash/construct.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/cash/construct.ts')>();
  return {
    ...real,
    constructArrangements: async (...args: Parameters<typeof real.constructArrangements>) => {
      if (construction.fail) throw new Error('construction worker unavailable');
      return real.constructArrangements(...args);
    },
  };
});

import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { arrangementOfRecord, recalledGoalArrangements } from '../server/services/goals/arrangementRecall.ts';
import { rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';
import { pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';

const now = new Date();

function arrangement(key: string, over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key,
    signature: `sig-${key}`,
    inputsDigest: `dig-${key}`,
    structure: 'SUBCONTRACT',
    design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    origin: 'REVERSE',
    precedent: null,
    sector: null,
    demand: { name: 'Independent veterinary clinics', claimId: null, from: 'REVERSE', ref: 'pop:vets' },
    need: null,
    supply: null,
    label: `Constructed: overflow bookkeeping for independent veterinary clinics (${key})`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [{ failure: 'FEWER_BUYERS', effect: 'fewer clinics buy; nothing of ours was spent before they paid' }] },
    evidenced: 0,
    value: { tier: 'MECHANISM', p10: 40, p50: 400, p90: 4_000, observations: 3 },
    unknownParts: ['supply cost'],
    relatedOpenings: [],
    question: 'What does an independent veterinary clinic pay for overflow bookkeeping?',
    ...over,
  } as unknown as ConstructedArrangement;
}

async function liveGoal() {
  const { project } = await freshProject();
  const userId = (await createUser({ email: `f3-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  const g = await createWorkstream({ projectId: project.id, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId: project.id, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return { projectId: project.id, goalId: g.id, userId };
}

describe('R01: a stored design reads back as an arrangement', () => {
  const record = (design: unknown) => ({ design: design as Record<string, unknown>, signature: 'sig-x', inputsDigest: 'dig-x', legacyKey: 'x' });

  it('reads the stored arrangement and keeps its signature and digest', () => {
    const one = arrangementOfRecord(record({ version: 1, arrangement: { ...arrangement('a1'), signature: undefined, inputsDigest: undefined } }));
    expect(one?.key).toBe('a1');
    expect(one?.signature).toBe('sig-x');
    expect(one?.inputsDigest).toBe('dig-x');
  });

  it('refuses a row with no design, a malformed one, or one organisation as the buyer', () => {
    expect(arrangementOfRecord(record({}))).toBeNull();
    expect(arrangementOfRecord(record({ arrangement: { key: 'a2' } }))).toBeNull();
    expect(arrangementOfRecord(record({ arrangement: { ...arrangement('a4'), unknownParts: undefined } }))).toBeNull();
    expect(arrangementOfRecord(record({ arrangement: arrangement('a3', { demand: { name: 'GitHub', claimId: null, from: 'REVERSE', ref: 'org:gh' } as never }) }))).toBeNull();
  });
});

describe('R02/R03: a failed construction reads the goal\'s own library designs', () => {
  it('R02: exposes the recalled designs as marked pathways, says construction failed, and the probe passes', async () => {
    const { projectId, goalId } = await liveGoal();
    await rememberArrangements(projectId, goalId, [arrangement('a1b2c3d4e5f6'), arrangement('0f1e2d3c4b5a')], now.toISOString());
    expect((await recalledGoalArrangements(projectId, goalId)).map((a) => a.key).sort()).toEqual(['0f1e2d3c4b5a', 'a1b2c3d4e5f6']);

    construction.fail = true;
    try {
      const reading = await readGoalPlan({ goalId, persist: false });
      expect(reading?.degraded.some((d) => /construction worker unavailable/.test(d) && /from the library/.test(d))).toBe(true);
      expect(reading?.pathways).not.toBeNull();
      const pathways = reading!.pathways!.pathways;
      const ids = pathways.map((p) => p.opportunityId);
      expect(ids).toEqual(expect.arrayContaining(['arr_a1b2c3d4e5f6', 'arr_0f1e2d3c4b5a']));
      for (const p of pathways) expect(pathwayProblem(p)).toBeNull();
      const probe = await getProbe('r01.opp-04')!({});
      expect(probe.ok).toBe(true);
    } finally {
      construction.fail = false;
    }
  }, 120_000);

  it('R03: with nothing in the library for this goal, the failure stands and is said', async () => {
    const other = await liveGoal();
    await rememberArrangements(other.projectId, other.goalId, [arrangement('aaaaaaaaaaaa')], now.toISOString());
    const { goalId } = await liveGoal();
    construction.fail = true;
    try {
      const reading = await readGoalPlan({ goalId, persist: false });
      expect(reading?.degraded.some((d) => /construction worker unavailable/.test(d) && /without constructed arrangements/.test(d))).toBe(true);
      expect((reading?.pathways?.pathways ?? []).some((p) => p.opportunityId === 'arr_aaaaaaaaaaaa')).toBe(false);
    } finally {
      construction.fail = false;
    }
  }, 120_000);
});
