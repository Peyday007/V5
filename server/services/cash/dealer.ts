/**
 * Dealing execution jobs to the people running Cash Mode, fairly.
 *
 * ---------------------------------------------------------------------------
 * The rule, in the owner's words (2026-10-21)
 * ---------------------------------------------------------------------------
 *
 * Every person gets the same menu. Nobody gets the same job. If one person
 * makes more than another it is because they worked harder, never because they
 * were dealt better work. So jobs are dealt **per category**: four jobs of one
 * kind go one to each person; when a kind is short, the person who got one is
 * marked and the next job of that kind goes to somebody who has not, until the
 * table is even again.
 *
 * ---------------------------------------------------------------------------
 * What is stored, and what is derived
 * ---------------------------------------------------------------------------
 *
 * Nothing new is stored. Who holds a job is `cash_jobs.owner_user_id`, and the
 * category is the opportunity's `mechanism` — a closed vocabulary, so a
 * category is a fact rather than free text. The "owed" ledger is derived on
 * every read: in a category, a person is owed the difference between the most
 * anybody holds and what they hold. A stored ledger would be a second master
 * for a number the jobs table already answers, and the copy nobody reads is
 * the one that drifts.
 *
 * Holding counts every job a person was dealt that has not been RELEASED — live
 * work and COLLECTED work alike. A released job is off their plate, so they are
 * owed again; a finished one stays counted, so finishing work fast is never
 * punished with less of it.
 *
 * ---------------------------------------------------------------------------
 * Who gets dealt in
 * ---------------------------------------------------------------------------
 *
 * A seat is a real person who can sign in today (`peopleReading` READY). Not a
 * system identity, not a disabled account, not a slot nobody filled — a job
 * dealt to somebody who cannot open the page is a job nobody works. A person
 * who joins later starts at zero everywhere, so they are owed in every category
 * and catch up first; that is the literal rule, and it is written down rather
 * than softened.
 *
 * ---------------------------------------------------------------------------
 * What it never does
 * ---------------------------------------------------------------------------
 *
 * It never takes work off somebody who has started it. Only an unassigned job,
 * or one that was handed to the sprint's owner by inheritance before dealing
 * existed and that nobody has touched since, or one whose holder can no longer
 * sign in, is dealt. A job in execution keeps its owner. Every deal is a
 * compare-and-swap on the state *and* the owner it read, and every deal writes
 * a `CASH_JOB_DEALT` event saying why it went where it went.
 */
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { dealJob, listJobs } from '../../repos/cashJobs.ts';
import { peopleReading } from '../identity/people.ts';
import type { CashJob, CashMechanism, CashMode, CashOpportunity } from '../../domain/types.ts';

export const DEALT_EVENT = 'CASH_JOB_DEALT';

/** A person dealt into the game. */
export interface Seat {
  userId: string;
  displayName: string;
}

/** How each category reads to a person. */
export const CATEGORY_WORDS: Readonly<Record<CashMechanism, string>> = Object.freeze({
  EXISTING_BUYING_SIGNAL: 'buyers already shopping',
  DIAGNOSTIC_OPPORTUNITY: 'problems worth diagnosing',
  EXPLICIT_PAID_REQUEST: 'posted paid requests',
  TEMPORARY_EXPLOIT: 'openings about to close',
  SUPPLY_DEMAND_MISMATCH: 'connecting supply to demand',
  PAIN_TRIGGERED_IMPLEMENTATION: 'fixing a published problem',
  RESALE_OR_ASSET: 'resale and assets',
  INFORMATION_ASYMMETRY: 'hard-to-get information',
  PRODUCTIZED_SERVICE: 'productized services',
  CAPABILITY_ARBITRAGE: 'price spreads',
  SUBCONTRACTED_FULFILMENT: 'overflow work',
  JIGSAW_COMBINATION: 'combinations',
  OTHER: 'other work',
});

/** Who holds what, as the dealer counts it. */
export interface Tally {
  /** category -> userId -> jobs held. */
  byCategory: Map<string, Map<string, number>>;
  /** userId -> jobs held in every category. */
  totals: Map<string, number>;
  /** userId -> when they were last dealt anything, or absent for never. */
  lastDealtAt: Map<string, string>;
}

export interface Holding {
  userId: string;
  category: string;
  at: string | null;
}

/** Count what each seat holds. Pure. Holdings for people without a seat are ignored. */
export function tally(seats: readonly Seat[], holdings: readonly Holding[]): Tally {
  const seated = new Set(seats.map((seat) => seat.userId));
  const out: Tally = { byCategory: new Map(), totals: new Map(), lastDealtAt: new Map() };
  for (const holding of holdings) {
    if (!seated.has(holding.userId)) continue;
    add(out, holding);
  }
  return out;
}

function add(t: Tally, holding: Holding): void {
  const inCategory = t.byCategory.get(holding.category) ?? new Map<string, number>();
  inCategory.set(holding.userId, (inCategory.get(holding.userId) ?? 0) + 1);
  t.byCategory.set(holding.category, inCategory);
  t.totals.set(holding.userId, (t.totals.get(holding.userId) ?? 0) + 1);
  if (holding.at) {
    const last = t.lastDealtAt.get(holding.userId);
    if (!last || holding.at > last) t.lastDealtAt.set(holding.userId, holding.at);
  }
}

export interface Choice {
  userId: string;
  because: string;
}

/**
 * Who the next job of this category goes to. Pure and deterministic.
 *
 * In order, and the first difference decides — never a weighted score:
 *   1. fewest held in this category (whoever is owed one gets it);
 *   2. fewest held in every category;
 *   3. dealt longest ago (never dealt is longest ago);
 *   4. user id, so a tie resolves the same way on every call.
 */
export function chooseSeat(category: string, seats: readonly Seat[], t: Tally): Choice | null {
  if (seats.length === 0) return null;
  const inCategory = t.byCategory.get(category) ?? new Map<string, number>();
  const ranked = [...seats].sort((a, b) => {
    const ca = inCategory.get(a.userId) ?? 0;
    const cb = inCategory.get(b.userId) ?? 0;
    if (ca !== cb) return ca - cb;
    const ta = t.totals.get(a.userId) ?? 0;
    const tb = t.totals.get(b.userId) ?? 0;
    if (ta !== tb) return ta - tb;
    const la = t.lastDealtAt.get(a.userId) ?? '';
    const lb = t.lastDealtAt.get(b.userId) ?? '';
    if (la !== lb) return la < lb ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const chosen = ranked[0]!;
  const held = inCategory.get(chosen.userId) ?? 0;
  const most = Math.max(0, ...seats.map((seat) => inCategory.get(seat.userId) ?? 0));
  const words = CATEGORY_WORDS[category as CashMechanism] ?? category.toLowerCase();
  const because =
    held < most
      ? `${chosen.displayName} was owed one: they held ${held} ${words} job(s) while somebody held ${most}`
      : `everybody held ${held} ${words} job(s), so it went to whoever had the least work overall, then whoever was dealt longest ago`;
  return { userId: chosen.userId, because };
}

/**
 * What each seat is owed, per category. Pure.
 *
 * In a category, a person is owed the most anybody holds minus what they hold.
 * Categories nobody holds anything in owe nobody anything.
 */
export function owed(seats: readonly Seat[], t: Tally): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [category, held] of t.byCategory) {
    const most = Math.max(0, ...seats.map((seat) => held.get(seat.userId) ?? 0));
    const perSeat = new Map<string, number>();
    for (const seat of seats) {
      const gap = most - (held.get(seat.userId) ?? 0);
      if (gap > 0) perSeat.set(seat.userId, gap);
    }
    if (perSeat.size > 0) out.set(category, perSeat);
  }
  return out;
}

/** The people dealt in today: real people who can sign in. */
export async function seats(): Promise<Seat[]> {
  const reading = await peopleReading(null);
  return reading.people
    .filter((person) => person.state === 'READY')
    .map((person) => ({ userId: person.userId, displayName: person.displayName }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/**
 * A job handed to the sprint's owner by inheritance, before dealing existed.
 *
 * Every job the pipeline prepared until now was created ASSIGNED to the
 * opportunity's owner — which is the sprint's owner — in the same statement,
 * so its `assigned_at` equals its `created_at`. Nobody chose that; it is the
 * default the dealer replaces. A job anybody touched since has a later
 * `assigned_at`, and a job in execution is not ASSIGNED, so neither matches.
 */
export function inheritedFromOwner(job: CashJob, mode: Pick<CashMode, 'ownerUserId'>): boolean {
  return (
    job.state === 'ASSIGNED' &&
    job.createdBy === 'BRAIN' &&
    job.ownerUserId === mode.ownerUserId &&
    job.assignedAt !== null &&
    job.assignedAt === job.createdAt
  );
}

/** Whether the dealer has ever dealt this job. */
async function dealtJobIds(projectId: string): Promise<Set<string>> {
  const rows = await getDb().all<{ detail: string }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ?`,
    [projectId, DEALT_EVENT],
  );
  const out = new Set<string>();
  for (const row of rows) {
    try {
      const id = (JSON.parse(row.detail) as { jobId?: unknown }).jobId;
      if (typeof id === 'string') out.add(id);
    } catch {
      // An unreadable detail names no job; it cannot stop a deal.
    }
  }
  return out;
}

export interface Dealt {
  jobId: string;
  opportunityId: string;
  category: string;
  toUserId: string;
  fromUserId: string | null;
  because: string;
}

export interface DealReport {
  dealt: Dealt[];
  /** Jobs that could not be dealt, and why. */
  undealt: { jobId: string; because: string }[];
  seats: number;
}

/**
 * Deal every job that is waiting for a person. Idempotent: a job dealt once
 * has an owner and a `CASH_JOB_DEALT` row, so the next pass leaves it alone.
 */
export async function dealJobs(projectId: string): Promise<DealReport> {
  const report: DealReport = { dealt: [], undealt: [], seats: 0 };
  const mode = await getCashMode(projectId);
  if (!mode) return report;

  const seatList = await seats();
  report.seats = seatList.length;
  const seated = new Set(seatList.map((seat) => seat.userId));
  const opportunities = new Map<string, CashOpportunity>(
    (await listOpportunities({ projectId })).map((one) => [one.id, one]),
  );
  const jobs = (await listJobs(projectId)).filter((job) => job.state !== 'RELEASED');
  const already = await dealtJobIds(projectId);

  const waiting = (job: CashJob): boolean => {
    // Nobody holds it yet.
    if (job.state === 'UNASSIGNED' && job.ownerUserId === null) return true;
    // Its holder can no longer sign in, and nothing has been started on it.
    if (job.state === 'ASSIGNED' && job.ownerUserId !== null && !seated.has(job.ownerUserId)) return true;
    // Handed to the owner by default before dealing existed, and never dealt.
    return !already.has(job.id) && inheritedFromOwner(job, mode);
  };

  const toDeal = jobs
    .filter(waiting)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  const dealing = new Set(toDeal.map((job) => job.id));

  // What is already on people's plates, leaving out what is about to be dealt.
  const holdings: Holding[] = [];
  for (const job of jobs) {
    if (dealing.has(job.id) || job.ownerUserId === null) continue;
    const opportunity = opportunities.get(job.opportunityId);
    if (!opportunity) continue;
    holdings.push({ userId: job.ownerUserId, category: opportunity.mechanism, at: job.assignedAt });
  }
  const t = tally(seatList, holdings);

  for (const job of toDeal) {
    const opportunity = opportunities.get(job.opportunityId);
    if (!opportunity) {
      report.undealt.push({ jobId: job.id, because: 'its opportunity cannot be read' });
      continue;
    }
    const choice = chooseSeat(opportunity.mechanism, seatList, t);
    if (!choice) {
      report.undealt.push({ jobId: job.id, because: 'nobody can sign in to take it yet' });
      continue;
    }
    const ok = await dealJob({
      jobId: job.id,
      expectState: job.state,
      expectOwnerUserId: job.ownerUserId,
      ownerUserId: choice.userId,
    });
    if (!ok) {
      report.undealt.push({ jobId: job.id, because: 'it changed while being dealt; the next pass reads it again' });
      continue;
    }
    add(t, { userId: choice.userId, category: opportunity.mechanism, at: new Date().toISOString() });
    report.dealt.push({
      jobId: job.id,
      opportunityId: opportunity.id,
      category: opportunity.mechanism,
      toUserId: choice.userId,
      fromUserId: job.ownerUserId,
      because: choice.because,
    });
    const name = seatList.find((seat) => seat.userId === choice.userId)?.displayName ?? choice.userId;
    await recordCashEvent({
      projectId,
      opportunityId: opportunity.id,
      kind: DEALT_EVENT,
      actorRef: 'BRAIN',
      summary: `Job for "${opportunity.title}" dealt to ${name}, because ${choice.because}.`,
      detail: {
        jobId: job.id,
        category: opportunity.mechanism,
        toUserId: choice.userId,
        fromUserId: job.ownerUserId,
        seats: seatList.length,
      },
    });
  }
  return report;
}

/* --------------------------------------------------------------------------
 * Readings
 * ------------------------------------------------------------------------ */

export interface CategoryCount {
  category: CashMechanism;
  label: string;
  count: number;
}

export interface PlateReading {
  /** How many people are dealt in. */
  seats: number;
  /** What the reader holds, per category. */
  mine: CategoryCount[];
  /** What the reader is owed, per category: the next job of that kind is theirs. */
  owedToMe: CategoryCount[];
  /** Every plate, for a reader who may see the whole sprint. Absent otherwise. */
  everyone?: { userId: string; displayName: string; total: number; byCategory: CategoryCount[]; owed: CategoryCount[] }[];
}

function counts(map: Map<string, number> | undefined, userId: string): number {
  return map?.get(userId) ?? 0;
}

function categoryCounts(entries: [string, number][]): CategoryCount[] {
  return entries
    .filter(([, n]) => n > 0)
    .map(([category, n]) => ({
      category: category as CashMechanism,
      label: CATEGORY_WORDS[category as CashMechanism] ?? category.toLowerCase(),
      count: n,
    }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));
}

/** Every job somebody holds, with its category. */
async function currentHoldings(projectId: string): Promise<Holding[]> {
  const opportunities = new Map(
    (await listOpportunities({ projectId })).map((one) => [one.id, one]),
  );
  const holdings: Holding[] = [];
  for (const job of await listJobs(projectId)) {
    if (job.state === 'RELEASED' || job.ownerUserId === null) continue;
    const opportunity = opportunities.get(job.opportunityId);
    if (!opportunity) continue;
    holdings.push({ userId: job.ownerUserId, category: opportunity.mechanism, at: job.assignedAt });
  }
  return holdings;
}

/** The dealer's table for one reader. Writes nothing. */
export async function plateReading(
  projectId: string,
  viewer: { userId: string | null; full: boolean },
): Promise<PlateReading> {
  const seatList = await seats();
  const t = tally(seatList, await currentHoldings(projectId));
  const debts = owed(seatList, t);

  const plateOf = (userId: string) => ({
    byCategory: categoryCounts([...t.byCategory].map(([category, held]) => [category, counts(held, userId)])),
    owed: categoryCounts([...debts].map(([category, per]) => [category, counts(per, userId)])),
  });

  const me = viewer.userId ? plateOf(viewer.userId) : { byCategory: [], owed: [] };
  const reading: PlateReading = { seats: seatList.length, mine: me.byCategory, owedToMe: me.owed };
  if (viewer.full) {
    reading.everyone = seatList.map((seat) => {
      const plate = plateOf(seat.userId);
      return {
        userId: seat.userId,
        displayName: seat.displayName,
        total: t.totals.get(seat.userId) ?? 0,
        byCategory: plate.byCategory,
        owed: plate.owed,
      };
    });
  }
  return reading;
}

/**
 * How many jobs are owed in each category, summed over every seat.
 *
 * What discovery reads to decide which kind of work to look for first: a
 * category somebody is owed is one Brain should find more of.
 */
export async function owedByCategory(projectId: string): Promise<Map<CashMechanism, number>> {
  const seatList = await seats();
  const out = new Map<CashMechanism, number>();
  for (const [category, per] of owed(seatList, tally(seatList, await currentHoldings(projectId)))) {
    out.set(category as CashMechanism, [...per.values()].reduce((sum, n) => sum + n, 0));
  }
  return out;
}
