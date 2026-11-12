/**
 * ORIGINATED:MISSED_OPPORTUNITY:DISCOVERED — 14 of 14 dated openings (federal
 * solicitations N0010426QAC01 'DUST PLUG', 140LL027Q0005 'Signage Project for
 * Garnet Hill Recreation Area') expired while still DISCOVERED. The dive order
 * never read `expiresAt`, so a dated opening waited behind older undated ones
 * until it entered the 72h runway, where it can no longer be dived.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CashOpportunity } from '../server/domain/types.ts';
import { DEADLINE_PRIORITY_HORIZON_MS, compareDiveValue, diveOrder, type DiveValueFacts } from '../server/services/cash/validation.ts';
import { DIVE_RUNWAY_MS, closesWithin } from '../server/services/cash/worthResearching.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { startValidations } from '../server/services/cash/validation.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();

interface Row {
  opportunity: CashOpportunity;
  value: DiveValueFacts;
}

function row(input: {
  id: string;
  createdAt: string;
  expiresAt?: string | null;
  mechanism?: string | null;
  crossesTier?: boolean;
}): Row {
  const opportunity = {
    id: input.id,
    title: input.id,
    expiresAt: input.expiresAt ?? null,
    mechanism: input.mechanism ?? null,
    discoveryRoundId: null,
  } as unknown as CashOpportunity;
  const value: DiveValueFacts = {
    id: input.id,
    createdAt: input.createdAt,
    reconsidered: false,
    crossesTier: input.crossesTier ?? true,
    mechanismYield: 'UNMEASURED',
    stage: 'SCREEN',
    capital: 'UNKNOWN',
    timeToCashDays: null,
    answered: 0,
  } as DiveValueFacts;
  return { opportunity, value };
}

const none = () => false;

/** The band order as it stood at 7819a27: `expiresAt` never consulted. */
function oldOrder(opts: { dropped?: (o: CashOpportunity) => boolean; forGoal?: (o: CashOpportunity) => boolean } = {}) {
  const dropped = opts.dropped ?? none;
  const forGoal = opts.forGoal ?? none;
  const band = (o: CashOpportunity) =>
    dropped(o) ? 3 : forGoal(o) ? 0 : o.mechanism === 'TEMPORARY_EXPLOIT' ? 1 : 2;
  return (a: CashOpportunity, b: CashOpportunity) => band(a) - band(b);
}

function select(rows: Row[], order: (a: CashOpportunity, b: CashOpportunity) => number, room: number): string[] {
  const sorted = [...rows].sort((a, b) => compareDiveValue(a.value, b.value));
  sorted.sort((a, b) => order(a.opportunity, b.opportunity));
  return sorted.slice(0, room).map((r) => r.opportunity.id);
}

describe('dive order reads a recorded closing date (EDF)', () => {
  it('reproduces the miss: a dated opening 10 days out is dived before older undated ones, before the runway', () => {
    const room = 3;
    const undated = Array.from({ length: room }, (_, i) =>
      row({ id: `ongoing-${i}`, createdAt: `2026-09-0${i + 1}T00:00:00.000Z`, crossesTier: true }),
    );
    // Lower decision value (no tier crossing) and newer than every undated one.
    const solicitation = row({
      id: 'N0010426QAC01',
      createdAt: '2026-10-19T00:00:00.000Z',
      expiresAt: at(10 * DAY),
      crossesTier: false,
    });
    expect(closesWithin(solicitation.opportunity.expiresAt, NOW)).toBe(false);
    const rows = [...undated, solicitation];

    expect(select(rows, oldOrder(), room)).not.toContain('N0010426QAC01');
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select(rows, order, room)).toContain('N0010426QAC01');
  });

  it('orders dated openings in one band by earliest closing, regardless of decision value', () => {
    const later = row({ id: 'later', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: at(20 * DAY), crossesTier: true });
    const sooner = row({ id: 'sooner', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-28', crossesTier: false });
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select([later, sooner], order, 2)).toEqual(['sooner', 'later']);
  });

  it('keeps undated openings in decision-value order, goal openings first and dropped ones last', () => {
    const a = row({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z', crossesTier: true });
    const b = row({ id: 'b', createdAt: '2026-08-01T00:00:00.000Z', crossesTier: false });
    const goal = row({ id: 'goal', createdAt: '2026-10-10T00:00:00.000Z', crossesTier: false });
    const junk = row({ id: 'junk', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: at(5 * DAY), crossesTier: true });
    const dated = row({ id: 'dated', createdAt: '2026-10-10T00:00:00.000Z', expiresAt: at(8 * DAY), crossesTier: false });
    const order = diveOrder({
      now: NOW,
      dropped: (o) => o.id === 'junk',
      forGoal: (o) => o.id === 'goal',
      shortWindow: none,
    });
    expect(select([a, b, goal, junk, dated], order, 5)).toEqual(['goal', 'dated', 'a', 'b', 'junk']);
  });

  it('does not promote an opening already inside the runway, and leaves the runway unchanged', () => {
    expect(DIVE_RUNWAY_MS).toBe(72 * 60 * 60 * 1000);
    const inside = row({ id: 'inside', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: at(DAY), crossesTier: false });
    const undated = row({ id: 'undated', createdAt: '2026-10-02T00:00:00.000Z', crossesTier: true });
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select([inside, undated], order, 2)).toEqual(['undated', 'inside']);
  });

  it('does not promote a far-dated opening: months or years out it keeps its decision-value place', () => {
    expect(DEADLINE_PRIORITY_HORIZON_MS).toBe(10 * DIVE_RUNWAY_MS);
    const high = row({ id: 'high', createdAt: '2026-09-01T00:00:00.000Z', crossesTier: true });
    const farDated = row({ id: 'far-dated', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: at(180 * DAY), crossesTier: false });
    const yearsOut = row({ id: 'years-out', createdAt: '2026-09-15T00:00:00.000Z', expiresAt: '2029-06-30', crossesTier: false });
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    // Neither jumps band 2 nor reorders band 2 by its distant date: decision value decides.
    expect(select([farDated, yearsOut, high], order, 3)).toEqual(['high', 'years-out', 'far-dated']);
    expect(select([farDated, yearsOut, high], order, 3)).toEqual(select([farDated, yearsOut, high], oldOrder(), 3));
  });

  it('promotes a dated opening only while it closes within the horizon', () => {
    const high = row({ id: 'high', createdAt: '2026-09-01T00:00:00.000Z', crossesTier: true });
    const justInside = row({ id: 'inside-horizon', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: at(DEADLINE_PRIORITY_HORIZON_MS - DAY), crossesTier: false });
    const justOutside = row({ id: 'outside-horizon', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: at(DEADLINE_PRIORITY_HORIZON_MS + DAY), crossesTier: false });
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select([high, justInside], order, 1)).toEqual(['inside-horizon']);
    expect(select([high, justOutside], order, 1)).toEqual(['high']);
  });
});

/*
 * The same property through the production loop itself, against a database:
 * `startValidations` reads the rows, applies `whyNotDiving`, spends its room and
 * captures the dives. A later change to that loop — the room, the goal places
 * beside it, a skip — is caught here, where the pure model above cannot see it.
 */
describe('startValidations dives a dated opening before the runway closes it', () => {
  let projectId = '';
  let modeId = '';
  let ownerId = '';

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`edf-${projectId.slice(-6)}`, projectId]);
    const owner = await createUser({
      email: `edf-dive-${projectId.slice(-6)}@example.com`,
      displayName: 'Owner',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    ownerId = owner.id;
    const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Usable cash, quickly.' });
    if (!started.ok) throw new Error('could not activate');
    modeId = started.mode.id;
  });

  async function opening(title: string, expiresAt: string | null = null): Promise<string> {
    const made = await createOpportunity({
      projectId,
      cashModeId: modeId,
      ownerUserId: ownerId,
      title,
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
      expiresAt,
    });
    await updateOpportunity(made.id, { buying_signal: `A county published a paid request: ${title}.`, source: 'https://example.gov/rfp' });
    return made.id;
  }

  const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
  const started = async (limit: number) => (await startValidations({ projectId, limit })).map((one) => one.opportunityId);

  it('spends the one free dive on the solicitation closing in 10 days, not on older undated openings', async () => {
    const older = [await opening('An ongoing request for parcel research'), await opening('An ongoing request for a traffic count')];
    const solicitation = await opening("Solicitation N0010426QAC01 'DUST PLUG'", fromNow(10 * DAY));
    const ids = await started(1);
    expect(ids).toEqual([solicitation]);
    for (const id of older) expect(ids).not.toContain(id);
  });

  it('dives the earlier window first, whatever its age, and skips one already inside the runway without spending the room', async () => {
    const later = await opening('A solicitation closing in 20 days', fromNow(20 * DAY));
    const undated = await opening('An ongoing request for bookkeeping');
    // Ahead of everything in the order (an approved goal's own opening), but inside the
    // runway, so whyNotDiving refuses it: the loop must skip it and still spend its room.
    const inside = await opening('A goal-found solicitation closing tomorrow', fromNow(DAY));
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'HARVESTED', ?, 1, ?, ?)`,
      [`cdr_${projectId.slice(-6)}`, projectId, modeId, 'goal-wst_edf-open', 'OTHER', `rcn_${projectId.slice(-6)}`, at, at, at],
    );
    await getDb().run('UPDATE cash_opportunities SET discovery_round_id = ? WHERE id = ?', [`cdr_${projectId.slice(-6)}`, inside]);
    const sooner = await opening('Solicitation 140LL027Q0005, signage project', fromNow(8 * DAY));
    const ids = await started(1);
    expect(ids).toEqual([sooner]);
    expect(ids).not.toContain(inside);
    expect(ids).not.toContain(later);
    expect(ids).not.toContain(undated);
  });
});
