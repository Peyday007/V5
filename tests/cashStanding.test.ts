/**
 * Standing (OPPORTUNITY-INTELLIGENCE §3.1, assignment A).
 *
 * Every standing kind derived from rows, the events written only on a change,
 * and a replay that writes nothing. The pure half is asserted directly against
 * `standingFor`; the pass is asserted against the database, because "only when
 * it changed" is a property of what was already recorded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { archiveOpportunity, capture } from '../server/services/cash/opportunities.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import {
  getOpportunity,
  transitionOpportunity,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import {
  projectStandings,
  recordStandingChanges,
  standingFor,
  standingSignature,
  STANDING_EVENT,
  type StandingInput,
} from '../server/services/cash/standing.ts';
import {
  BLOCKER_DETECTION,
  BLOCKER_KINDS,
  formatBlockerKey,
  parseBlockerKey,
} from '../server/domain/types.ts';
import type { CashOpportunity, CashReopenCondition } from '../server/domain/types.ts';
import type { TierReading } from '../server/services/cash/tier.ts';
import { assemble, BEST_SHOWN } from '../server/services/cash/portfolio.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `standing-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const activated = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(activated.ok).toBe(true);
});

async function piece(title: string, extra: { requiredCapabilities?: string[] } = {}): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    ...extra,
  });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value.id;
}

const SIGNAL_TIER: TierReading = {
  tier: 'SIGNAL',
  establishes: 'a published request',
  doesNotEstablish: 'who would pay us',
  toAdvance: [{ key: 'payer', label: 'Who pays', task: 'Establish the payer', owner: 'BRAIN_RESEARCH' }],
  answered: 0,
  required: 1,
  summary: 'Evidence: nobody has said who would pay.',
};

function condition(over: Partial<CashReopenCondition>): CashReopenCondition {
  return {
    id: 'crc_1',
    projectId,
    opportunityId: 'cop_1',
    blockerKey: 'CAPABILITY:SEND_A_MESSAGE',
    recordedFrom: 'ROUNDS_SPENT',
    observedAtRecord: null,
    actorRef: 'BRAIN',
    createdAt: '2026-10-01T00:00:00.000Z',
    triggeredAt: null,
    triggerChangeRef: null,
    ...over,
  };
}

async function inputFor(id: string, over: Partial<StandingInput> = {}): Promise<StandingInput> {
  const opportunity = (await getOpportunity(id)) as CashOpportunity;
  return {
    opportunity,
    tier: SIGNAL_TIER,
    placement: { disposition: 'EVIDENCE_ONLY', because: SIGNAL_TIER.summary, missing: [], waitsOn: null },
    dive: null,
    needs: [],
    reopenConditions: [],
    ...over,
  };
}

describe('the vocabulary', () => {
  it('every kind declares how it is detected, and the four without a row source say so', () => {
    for (const kind of BLOCKER_KINDS) expect(BLOCKER_DETECTION[kind]).toBeTruthy();
    for (const kind of ['SUPPLIER', 'COST', 'CUSTOMER', 'REGULATION'] as const) {
      expect(BLOCKER_DETECTION[kind].detection).toBe('NOT_DETECTED');
      expect(BLOCKER_DETECTION[kind].automatic).toBe(false);
    }
    expect(BLOCKER_DETECTION.PERSON.detection).toBe('NEVER');
  });

  it('parses exactly, and refuses the nearest thing', () => {
    expect(parseBlockerKey('CAPABILITY:SEND_A_MESSAGE')).toBe('CAPABILITY:SEND_A_MESSAGE');
    expect(parseBlockerKey('PERSON')).toBe('PERSON');
    expect(parseBlockerKey('PERSON:someone')).toBeNull();
    expect(parseBlockerKey('capability:SEND_A_MESSAGE')).toBeNull();
    expect(parseBlockerKey('CAPABILITY:')).toBeNull();
    expect(parseBlockerKey('CAPABILITY:two words')).toBeNull();
    expect(parseBlockerKey('DATE:next tuesday')).toBeNull();
    expect(parseBlockerKey('DATE:2026-12-01')).toBe('DATE:2026-12-01');
    expect(formatBlockerKey('FIELD', 'payer')).toBe('FIELD:payer');
    expect(() => formatBlockerKey('FIELD', '')).toThrow();
  });
});

describe('every standing kind, from rows', () => {
  it('DONE for a collected piece', async () => {
    const id = await piece('A collected piece');
    await transitionOpportunity({ id, from: ['DISCOVERED'], to: 'COLLECTED', outcome: 'Paid.' });
    expect(standingFor(await inputFor(id)).kind).toBe('DONE');
  });

  it('DORMANT for an archive that named a condition, NOT_WORTH_PURSUING for one that named none', async () => {
    const watched = await piece('Archived with a watch');
    await archiveOpportunity({
      opportunityId: watched,
      actorRef: userId,
      reason: 'No messaging yet.',
      reopenWhen: ['CAPABILITY:SEND_A_MESSAGE'],
    });
    const plain = await piece('Archived for good');
    await archiveOpportunity({ opportunityId: plain, actorRef: userId, reason: 'No.', reopenWhen: [] });
    const all = await projectStandings(projectId);
    const dormant = all.get(watched)!.standing;
    expect(dormant.kind).toBe('DORMANT');
    if (dormant.kind === 'DORMANT') {
      expect(dormant.cause).toBe('ARCHIVED');
      expect(dormant.reopenWhen).toEqual(['CAPABILITY:SEND_A_MESSAGE']);
      expect(dormant.because).toContain('No messaging yet.');
    }
    expect(all.get(plain)!.standing.kind).toBe('NOT_WORTH_PURSUING');
  });

  it('WAITING on the shared fact an open need is blocked on', async () => {
    const id = await piece('Blocked on messaging');
    const raised = await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'Contact the buyer',
      whyItMatters: 'Nothing can be offered without it.',
      recommendedPath: 'Connect messaging.',
      setupEffort: 'An hour',
      nextStep: 'Set the messaging secrets.',
      completionCondition: 'SEND_A_MESSAGE reads PRESENT.',
      requestKey: `cap:${id}:SEND_A_MESSAGE`,
      blockerKey: 'CAPABILITY:SEND_A_MESSAGE',
    });
    expect(raised.ok).toBe(true);
    if (raised.ok) expect(raised.value.blockerKey).toBe('CAPABILITY:SEND_A_MESSAGE');
    const standing = (await projectStandings(projectId)).get(id)!.standing;
    expect(standing).toMatchObject({ kind: 'WAITING', on: ['CAPABILITY:SEND_A_MESSAGE'] });
  });

  it('refuses a malformed blocker key on a need', async () => {
    const id = await piece('A malformed need');
    const refused = await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'x',
      whyItMatters: 'x',
      recommendedPath: 'x',
      setupEffort: 'x',
      nextStep: 'x',
      completionCondition: 'x',
      blockerKey: 'SOMETHING VAGUE',
    });
    expect(refused.ok).toBe(false);
  });

  it('ADVANCING for a piece under way', async () => {
    const id = await piece('Under way');
    await transitionOpportunity({ id, from: ['DISCOVERED'], to: 'EXECUTING' });
    expect((await projectStandings(projectId)).get(id)!.standing.kind).toBe('ADVANCING');
  });

  it('a research need (FIELD/EVIDENCE) does not by itself make a piece wait', async () => {
    const id = await piece('Being researched');
    const standing = standingFor(
      await inputFor(id, {
        dive: { kind: 'IN_FLIGHT', state: 'RUNNING' },
        needs: [
          {
            state: 'OPEN',
            blockerKey: 'FIELD:payer',
          } as unknown as StandingInput['needs'][number],
        ],
      }),
    );
    expect(standing.kind).toBe('ADVANCING');
  });

  it('derived dead ends are DORMANT with their conditions, or NOT_WORTH_PURSUING with none', async () => {
    const id = await piece('Both dives spent');
    const spent = { kind: 'EPOCH_SPENT' as const, rounds: 2, cap: 2, epochStartedAt: null };
    const withWatch = standingFor(
      await inputFor(id, { dive: spent, reopenConditions: [condition({ opportunityId: id })] }),
    );
    expect(withWatch).toMatchObject({ kind: 'DORMANT', cause: 'ROUNDS_SPENT' });
    const without = standingFor(await inputFor(id, { dive: spent }));
    expect(without).toMatchObject({ kind: 'NOT_WORTH_PURSUING', cause: 'ROUNDS_SPENT' });
    // A failed stage-one screen is dormant on its reopen conditions, the same way.
    const screened = { kind: 'STAGE_ONE_FAILED' as const, open: ['payer'], epochStartedAt: null };
    expect(
      standingFor(await inputFor(id, { dive: screened, reopenConditions: [condition({ opportunityId: id })] })),
    ).toMatchObject({ kind: 'DORMANT', cause: 'ROUNDS_SPENT' });
    const disqualified = standingFor(
      await inputFor(id, { dive: { kind: 'DISQUALIFIED', reason: 'The RFP closed.' } }),
    );
    expect(disqualified).toMatchObject({ kind: 'NOT_WORTH_PURSUING', cause: 'DISQUALIFIED' });
  });

  it('a triggered condition on a person’s archive is a request, and still dormant', async () => {
    const id = await piece('Archived and met');
    await archiveOpportunity({ opportunityId: id, actorRef: userId, reason: 'Stop.' });
    const standing = standingFor(
      await inputFor(id, {
        reopenConditions: [
          condition({
            opportunityId: id,
            recordedFrom: 'ARCHIVE',
            triggeredAt: '2026-10-02T00:00:00.000Z',
            triggerChangeRef: 'capabilities@x',
          }),
        ],
      }),
    );
    expect(standing).toMatchObject({ kind: 'DORMANT', reconsiderationRequested: true });
    if (standing.kind === 'DORMANT') expect(standing.because).toContain('person');
  });

  it('an eligible dive advances when a slot is free and waits on SLOT when none is', async () => {
    const id = await piece('Eligible');
    const free = standingFor(await inputFor(id, { dive: { kind: 'ELIGIBLE' }, diveRoom: { kind: 'FREE' } }));
    expect(free.kind).toBe('ADVANCING');
    const full = standingFor(
      await inputFor(id, { dive: { kind: 'ELIGIBLE' }, diveRoom: { kind: 'FULL', inFlight: 2, cap: 2 } }),
    );
    expect(full).toMatchObject({ kind: 'WAITING', on: ['SLOT'] });
    const parked = standingFor(await inputFor(id, { dive: { kind: 'AWAITING_PERSON' } }));
    expect(parked).toMatchObject({ kind: 'WAITING', on: ['PERSON'] });
  });

  it('a duplicate defers to its survivor', async () => {
    const survivor = await piece('The survivor');
    const id = await piece('A second record');
    await updateOpportunity(id, { duplicate_of_id: survivor });
    expect((await projectStandings(projectId)).get(id)!.standing).toMatchObject({
      kind: 'NOT_WORTH_PURSUING',
      cause: 'DUPLICATE',
    });
  });

  it('carries standing on every placement and lists dormant pieces rather than dropping them', async () => {
    const live = await piece('Live and listed');
    const gone = await piece('Gone but kept');
    await archiveOpportunity({ opportunityId: gone, actorRef: userId, reason: 'Stop.', reopenWhen: ['PERSON'] });
    const opportunities = [(await getOpportunity(live))!, (await getOpportunity(gone))!];
    const plan = assemble({
      opportunities,
      tiers: { [live]: SIGNAL_TIER, [gone]: SIGNAL_TIER },
      deployableCents: 0,
      maxConcurrent: 0,
      discoveryOpen: true,
      standingInputs: {
        [gone]: {
          dive: null,
          needs: [],
          reopenConditions: [condition({ opportunityId: gone, recordedFrom: 'ARCHIVE', blockerKey: 'PERSON' })],
        },
      },
    });
    expect(plan.placements.every((one) => one.standing !== undefined)).toBe(true);
    expect(plan.dormant.map((one) => one.opportunity.id)).toEqual([gone]);
    expect(plan.actionable.map((one) => one.opportunity.id)).toEqual([live]);
    expect(plan.byStanding.DORMANT).toBe(1);
  });

  it('the actionable list is not capped at the highlight size', async () => {
    const ids: string[] = [];
    for (let i = 0; i < BEST_SHOWN + 4; i += 1) ids.push(await piece(`Executing piece ${i}`));
    for (const id of ids) await transitionOpportunity({ id, from: ['DISCOVERED'], to: 'EXECUTING' });
    const opportunities = await Promise.all(ids.map(async (id) => (await getOpportunity(id))!));
    const plan = assemble({
      opportunities,
      tiers: Object.fromEntries(ids.map((id) => [id, SIGNAL_TIER])),
      deployableCents: 0,
      maxConcurrent: 100,
      discoveryOpen: true,
    });
    expect(plan.actionable).toHaveLength(BEST_SHOWN + 4);
  });
});

describe('the standing pass', () => {
  it('writes on change only, and a replay writes nothing', async () => {
    const a = await piece('Piece A');
    const b = await piece('Piece B');

    const first = await recordStandingChanges(projectId);
    expect(first.map((one) => one.opportunityId).sort()).toEqual([a, b].sort());
    expect(await cashEventsOfKind(a, STANDING_EVENT)).toHaveLength(1);

    // Replay over unchanged rows: nothing.
    expect(await recordStandingChanges(projectId)).toEqual([]);
    expect(await cashEventsOfKind(a, STANDING_EVENT)).toHaveLength(1);

    // One piece changes standing: exactly one event, on that piece.
    await archiveOpportunity({ opportunityId: b, actorRef: userId, reason: 'Stop.', reopenWhen: [] });
    const second = await recordStandingChanges(projectId);
    expect(second).toHaveLength(1);
    expect(second[0]!.opportunityId).toBe(b);
    expect(second[0]!.to).toBe(standingSignature(second[0]!.standing));
    expect(second[0]!.from).toBe(first.find((one) => one.opportunityId === b)!.to);
    expect(await cashEventsOfKind(b, STANDING_EVENT)).toHaveLength(2);
    expect(await cashEventsOfKind(a, STANDING_EVENT)).toHaveLength(1);

    // And replaying that is quiet too.
    expect(await recordStandingChanges(projectId)).toEqual([]);
  });

  it('a changed blocker set is a change even when the kind is not', async () => {
    const id = await piece('Waiting on two things');
    await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'Contact',
      whyItMatters: 'x',
      recommendedPath: 'x',
      setupEffort: 'x',
      nextStep: 'x',
      completionCondition: 'x',
      requestKey: `a:${id}`,
      blockerKey: 'CAPABILITY:SEND_A_MESSAGE',
    });
    expect(await recordStandingChanges(projectId)).toHaveLength(1);
    await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'Invoice',
      whyItMatters: 'x',
      recommendedPath: 'x',
      setupEffort: 'x',
      nextStep: 'x',
      completionCondition: 'x',
      requestKey: `b:${id}`,
      blockerKey: 'CAPABILITY:ISSUE_AN_INVOICE',
    });
    const changed = await recordStandingChanges(projectId);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.to).toBe('WAITING|CAPABILITY:ISSUE_AN_INVOICE,CAPABILITY:SEND_A_MESSAGE');
  });
});
