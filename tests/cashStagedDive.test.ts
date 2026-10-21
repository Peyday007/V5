/**
 * The staged deep dive, rounds per change epoch, and the derived dive room
 * (OPPORTUNITY-INTELLIGENCE §3.3, §3.4).
 *
 *   - an opening with no payer is screened first, and a screen that settles
 *     without one leaves the opening dormant with typed reopen conditions and
 *     no full sixteen-lane packet compiled;
 *   - a screen that finds the payer leads to the full dive, and QUALIFIED
 *     still needs every qualification field;
 *   - no extra round without a new epoch; a distinct change opens one even
 *     after every earlier round was spent; there is no lifetime cap on epochs;
 *     and the same change ref does not open one twice;
 *   - the room is zero under SHEDDING, never above the grant, and scales with
 *     the grant's free slots and the routable research surfaces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { registerResearchSurfaces } from './helpers/researchSurfaces.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { reopenConditionsFor, requestReconsideration } from '../server/repos/cashReconsideration.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { getProject } from '../server/repos/projects.ts';
import { compileMission } from '../server/services/russell/compiler.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashTier } from '../server/services/cash/tier.ts';
import {
  compareDiveValue,
  concludeScreens,
  diveRoom,
  fieldsWorthResearching,
  MAX_VALIDATION_ROUNDS,
  startValidations,
  whyNotDiving,
  mechanismYields,
  MECHANISM_MIN_SAMPLE,
  type DiveValueFacts,
} from '../server/services/cash/validation.ts';
import { diveStageForCandidate } from '../server/services/cash/diveStage.ts';
import { researchRoomFrom, type ResearchCapacity } from '../server/services/cash/researchRoom.ts';
import { advance, resetPressure } from '../server/db/pressure.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  // Off the in-code slug map, so a dive compiles under the validation envelope.
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`staged-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({
    email: `staged-${projectId.slice(-6)}@example.com`,
    displayName: 'Peyton',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  ownerId = owner.id;
  const started = await activate({
    projectId,
    ownerUserId: owner.id,
    actorUserId: owner.id,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
});

afterEach(() => resetPressure());

async function opening(title: string): Promise<string> {
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  await updateOpportunity(made.id, {
    buying_signal: `A county published a paid request: ${title}.`,
    source: 'https://example.gov/rfp',
  });
  return made.id;
}

async function startOne(id: string) {
  const started = await startValidations({ projectId });
  const mine = started.find((one) => one.opportunityId === id);
  expect(mine, 'the dive started').toBeDefined();
  return mine!;
}

/** The dive ran and settled, as `settleValidations` would leave it. */
async function settle(id: string, to: 'COMPLETE' | 'BLOCKED' = 'COMPLETE'): Promise<void> {
  await updateOpportunity(id, { validation_state: to, validation_settled_at: new Date().toISOString() });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('a staged deep dive asks the kill questions first', () => {
  it('screens a payer-less opening, and a failed screen is dormant with EVIDENCE:payer and no full packet', async () => {
    const id = await opening('ownership research on twenty parcels');
    const first = await startOne(id);
    expect(first.stage).toBe('SCREEN');
    expect(await diveStageForCandidate(id, first.candidateId)).toBe('SCREEN');
    expect((await getCandidate(first.candidateId))!.title).toMatch(/^Screen:/);

    // The compiled screen asks three lanes, payer required, and nothing else.
    const compiled = await compileMission({
      candidate: (await getCandidate(first.candidateId))!,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.mission.envelopeId).toBe('RUSSELL_CASH_VALIDATION_V1');
    const lanes = compiled.mission.fragments[0]!.requiredEvidence;
    expect(lanes.map((lane) => lane.id).sort()).toEqual(['disqualifier', 'payer', 'ruled_out']);
    expect(lanes.find((lane) => lane.id === 'payer')!.necessity).toBe('REQUIRED');

    // Closed without ever becoming a mission, it searched nothing: that is
    // not a finding that nobody pays.
    await settle(id, 'BLOCKED');
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).not.toBe('STAGE_ONE_FAILED');

    // It ran, and settled with no payer found.
    await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'screen',
      whyNow: 'test',
      idempotencyKey: `screen:${first.candidateId}`,
      candidateId: first.candidateId,
    });
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('STAGE_ONE_FAILED');
    const concluded = await concludeScreens(projectId);
    expect(concluded.map((one) => one.opportunityId)).toEqual([id]);
    const keys = (await reopenConditionsFor(id)).map((one) => one.blockerKey).sort();
    expect(keys).toEqual(['EVIDENCE:payer', 'FIELD:payer']);
    // Once per screen.
    expect(await concludeScreens(projectId)).toEqual([]);

    // No stage-2 packet: nothing further starts for it.
    expect((await startValidations({ projectId })).some((one) => one.opportunityId === id)).toBe(false);
    const qualify = (await listCandidates({ projectId })).filter((one) => one.title.startsWith('Qualify:'));
    expect(qualify).toEqual([]);
  });

  it('a screen that finds the payer leads to the full dive, and QUALIFIED still needs every field', async () => {
    const id = await opening('a paid transcription request');
    const first = await startOne(id);
    expect(first.stage).toBe('SCREEN');
    await updateOpportunity(id, { payer: 'Westfield County drainage authority' });
    await settle(id);
    const after = (await getOpportunity(id))!;
    expect((await whyNotDiving(after)).kind).toBe('ELIGIBLE');

    // The bar did not move: the payer alone qualifies nothing.
    const tier = cashTier({
      opportunity: after,
      card: cashEngineCard({ opportunity: after, facts: await cardFactsFor(id) }),
      readiness: evidenceCard(after).readiness,
    });
    expect(tier.tier === 'QUALIFIED' || tier.tier === 'READY_TO_TEST').toBe(false);

    const second = await startOne(id);
    expect(second.stage).toBe('FULL');
    const compiled = await compileMission({
      candidate: (await getCandidate(second.candidateId))!,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.mission.fragments[0]!.requiredEvidence.length).toBeGreaterThan(3);
  });
});

describe('dives are counted per change epoch, with no lifetime cap', () => {
  async function spendEpoch(id: string): Promise<void> {
    await updateOpportunity(id, { payer: 'A named buyer' });
    for (let round = 0; round < MAX_VALIDATION_ROUNDS; round += 1) {
      await startOne(id);
      await settle(id);
    }
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('EPOCH_SPENT');
    // No extra round without a new epoch.
    expect((await startValidations({ projectId })).some((one) => one.opportunityId === id)).toBe(false);
  }

  it('a distinct change opens a new epoch after every earlier round was spent, again and again', async () => {
    const id = await opening('a recurring outsourced brief');
    await spendEpoch(id);
    for (let change = 1; change <= 3; change += 1) {
      await tick();
      expect(
        await requestReconsideration({ projectId, opportunityId: id, changeRef: `evidence@${change}` }),
      ).toBe(true);
      expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('ELIGIBLE');
      await tick();
      const again = await startOne(id);
      expect(again.stage).toBe('FULL');
      expect((await getOpportunity(id))!.validationRounds).toBe(1);
      await settle(id);
      await startOne(id);
      await settle(id);
      expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('EPOCH_SPENT');
    }
  });

  it('the same change ref does not open an epoch twice', async () => {
    const id = await opening('an expiring surplus lot');
    await spendEpoch(id);
    await tick();
    expect(await requestReconsideration({ projectId, opportunityId: id, changeRef: 'evidence@same' })).toBe(true);
    await tick();
    await startOne(id);
    await settle(id);
    await startOne(id);
    await settle(id);
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('EPOCH_SPENT');
    await tick();
    expect(await requestReconsideration({ projectId, opportunityId: id, changeRef: 'evidence@same' })).toBe(false);
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('EPOCH_SPENT');
  });
});

describe('the dive room is derived', () => {
  const capacity = (over: Partial<ResearchCapacity> = {}): ResearchCapacity => ({
    grantMax: 6,
    grantLive: 0,
    surfaces: 8,
    shedding: false,
    sheddingReason: null,
    ...over,
  });

  it('is zero under SHEDDING, whatever else is free', () => {
    expect(researchRoomFrom({ capacity: capacity({ shedding: true }), inFlight: 0, unlaunched: 0 }).room).toBe(0);
  });

  it('is never above the grant, holds one slot back for discovery, and never the last', () => {
    expect(researchRoomFrom({ capacity: capacity(), inFlight: 0, unlaunched: 0 }).room).toBe(5);
    expect(researchRoomFrom({ capacity: capacity({ grantLive: 5 }), inFlight: 0, unlaunched: 0 }).room).toBe(1);
    expect(researchRoomFrom({ capacity: capacity({ grantLive: 6 }), inFlight: 0, unlaunched: 0 }).room).toBe(0);
    expect(researchRoomFrom({ capacity: capacity({ grantMax: null }), inFlight: 0, unlaunched: 0 }).room).toBe(0);
    for (let max = 1; max <= 12; max += 1) {
      for (let live = 0; live <= max; live += 1) {
        const room = researchRoomFrom({
          capacity: capacity({ grantMax: max, grantLive: live, surfaces: 50 }),
          inFlight: 0,
          unlaunched: 0,
        }).room;
        expect(room).toBeLessThanOrEqual(max - live);
      }
    }
  });

  it('scales with the routable surfaces, with a floor of one while the grant has room', () => {
    expect(researchRoomFrom({ capacity: capacity({ surfaces: 2 }), inFlight: 0, unlaunched: 0 }).room).toBe(2);
    expect(researchRoomFrom({ capacity: capacity({ surfaces: 0 }), inFlight: 0, unlaunched: 0 }).room).toBe(1);
    expect(researchRoomFrom({ capacity: capacity({ surfaces: 0 }), inFlight: 1, unlaunched: 0 }).room).toBe(0);
    expect(researchRoomFrom({ capacity: capacity({ surfaces: 3 }), inFlight: 2, unlaunched: 2 }).room).toBe(1);
  });

  it('starts concurrent research for several productive workers, and none under pressure', async () => {
    for (let index = 0; index < 6; index += 1) await opening(`opening number ${index}`);
    // With no fleet registered, the floor: one at a time.
    expect((await diveRoom(projectId)).room).toBe(1);
    await registerResearchSurfaces(projectId, 4);
    expect((await diveRoom(projectId)).room).toBe(4);

    // Under SHEDDING nothing starts.
    advance({ times: [], failures: 5 }, Date.now());
    expect((await diveRoom(projectId)).room).toBe(0);
    expect(await startValidations({ projectId })).toEqual([]);
    resetPressure();

    const started = await startValidations({ projectId });
    expect(started.length).toBe(4);
    // Four in flight against four surfaces: no more until one settles.
    expect(await startValidations({ projectId })).toEqual([]);
  });
});

describe('decision-value order and the fields worth researching', () => {
  const facts = (over: Partial<DiveValueFacts>): DiveValueFacts => ({
    id: 'a',
    createdAt: '2026-10-01T00:00:00.000Z',
    reconsidered: false,
    crossesTier: false,
    stage: 'FULL',
    capital: 'UNKNOWN',
    timeToCashDays: null,
    answered: 0,
    ...over,
  });

  it('ranks a mechanism whose dives never changed a decision behind the rest, and never an unmeasured one', () => {
    const order = (list: DiveValueFacts[]) => [...list].sort(compareDiveValue).map((one) => one.id);
    // Unproductive goes behind an otherwise equal one, even one that is older.
    expect(
      order([
        facts({ id: 'tried-and-useless', mechanismYield: 'UNPRODUCTIVE', createdAt: '2026-09-01T00:00:00.000Z' }),
        facts({ id: 'unmeasured' }),
      ]),
    ).toEqual(['unmeasured', 'tried-and-useless']);
    // Unmeasured is never pushed back for lacking history: exploration is preserved.
    expect(
      order([facts({ id: 'new', mechanismYield: 'UNMEASURED' }), facts({ id: 'proven', mechanismYield: 'PRODUCTIVE', createdAt: '2026-12-01T00:00:00.000Z' })]),
    ).toEqual(['new', 'proven']);
    // A stronger decision-value fact still wins over the measured yield.
    expect(
      order([facts({ id: 'plain' }), facts({ id: 'crosses', crossesTier: true, mechanismYield: 'UNPRODUCTIVE' })]),
    ).toEqual(['crosses', 'plain']);
  });

  it('measures a mechanism unproductive only past its sample, and one decision restores it', () => {
    const piece = (mechanism: string, over: Partial<{ validationState: string | null; tier: 'SIGNAL' | 'CANDIDATE' | 'QUALIFIED' | 'READY_TO_TEST'; state: string }> = {}) => ({
      mechanism,
      validationState: 'COMPLETE',
      tier: 'CANDIDATE' as const,
      state: 'EVIDENCE_CARD',
      ...over,
    });
    const small = Array.from({ length: MECHANISM_MIN_SAMPLE - 1 }, () => piece('A'));
    expect(mechanismYields(small).get('A')?.yield).toBe('UNMEASURED');
    const enough = Array.from({ length: MECHANISM_MIN_SAMPLE }, () => piece('A'));
    expect(mechanismYields(enough).get('A')?.yield).toBe('UNPRODUCTIVE');
    // An opening still in its first dive is not evidence about the mechanism.
    expect(mechanismYields([...small, piece('A', { validationState: 'RUNNING' })]).get('A')?.yield).toBe('UNMEASURED');
    // A disqualifying answer is a decision too.
    expect(mechanismYields([...enough, piece('A', { state: 'DECLINED' })]).get('A')?.yield).toBe('PRODUCTIVE');
    expect(mechanismYields([...enough, piece('A', { tier: 'QUALIFIED' })]).get('A')?.yield).toBe('PRODUCTIVE');
  });

  it('is lexicographic over recorded facts, first difference decides', () => {
    const order = (list: DiveValueFacts[]) => [...list].sort(compareDiveValue).map((one) => one.id);
    expect(order([facts({ id: 'plain' }), facts({ id: 'reconsidered', reconsidered: true, createdAt: '2026-12-01T00:00:00.000Z' })])).toEqual(['reconsidered', 'plain']);
    expect(order([facts({ id: 'refine' }), facts({ id: 'cross', crossesTier: true })])).toEqual(['cross', 'refine']);
    expect(order([facts({ id: 'full' }), facts({ id: 'screen', stage: 'SCREEN' })])).toEqual(['screen', 'full']);
    // Unknown capital is last, never favoured.
    expect(order([facts({ id: 'unknown' }), facts({ id: 'exceeds', capital: 'EXCEEDS' }), facts({ id: 'fits', capital: 'FITS' })])).toEqual(['fits', 'exceeds', 'unknown']);
    expect(order([facts({ id: 'none' }), facts({ id: 'slow', timeToCashDays: 60 }), facts({ id: 'fast', timeToCashDays: 7 })])).toEqual(['fast', 'slow', 'none']);
    expect(order([facts({ id: 'bare' }), facts({ id: 'partly', answered: 3 })])).toEqual(['partly', 'bare']);
    expect(order([facts({ id: 'late', createdAt: '2026-10-02T00:00:00.000Z' }), facts({ id: 'early' })])).toEqual(['early', 'late']);
  });

  it('asks only the kill fields while nobody is known to pay', async () => {
    const id = await opening('a published request with no named payer');
    const o = (await getOpportunity(id))! as CashOpportunity;
    const tier = cashTier({
      opportunity: o,
      card: cashEngineCard({ opportunity: o, facts: [] }),
      readiness: evidenceCard(o).readiness,
    });
    const worth = fieldsWorthResearching(o, tier);
    expect(worth[0]).toBe('payer');
    expect(worth.every((key) => key === 'payer' || key === 'disqualifiers')).toBe(true);
  });
});
