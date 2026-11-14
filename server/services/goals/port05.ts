/**
 * One goal's PORT-05 reading: its streams, what Brain is credited with
 * delivering, and which offers go out or wait on which permission.
 *
 * Three modules already answer one part each, and this composes them without
 * deciding anything again:
 *
 *   - `streams.ts` reads the goal's latest portfolio as streams — each
 *     opening's role (leading, alternate, contingency, working operation,
 *     future bet) and whether it is independent of the leading combination;
 *   - `capabilityCredit.ts` judges, from rows, whether Brain is credited with
 *     an opening's delivery and on what evidence — never because it can
 *     describe the work;
 *   - `offerReadiness.ts` decides, from rows, whether an opening's offer may go
 *     out now and which external action is stopped by which permission, while
 *     research and the other internal work stay runnable.
 *
 * The streams come from the plan's own latest portfolio. That reading is held by
 * the goal plan in this process and is not a row, so the plan hands it here
 * through `noteGoalPortfolio`; until it has, the streams read as unknown with
 * the reason, and nothing is invented in their place (invariant 39). Credit and
 * readiness are always read from rows. Nothing here writes.
 *
 * `model.ts` carries the result on `GoalView` (the one goal derivation, §29), so
 * the briefing and the goal page read it from the same place as everything else
 * about a goal.
 */
import type { StreamRole, StreamsReading } from './streams.ts';
import type { CapabilityCredit } from './capabilityCredit.ts';
import type { OfferReadiness, OfferReadMemo } from './offerReadiness.ts';
import type { CapabilityReading } from '../cash/capabilities.ts';
import type { CashOpportunity } from '../../domain/types.ts';

export interface Port05Stream {
  opportunityId: string;
  title: string;
  role: StreamRole;
  roles: StreamRole[];
  independent: boolean;
  independence: string;
  reason: string;
}

export interface Port05Credit {
  opportunityId: string;
  mode: CapabilityCredit['mode'];
  credited: boolean;
  providerDelivered: boolean;
  ownerPhysicallyAbsent: boolean | null;
  /** The rows the judgment rests on. */
  evidence: CapabilityCredit['evidence'];
  missingEvidence: string[];
  reason: string;
}

export interface Port05Offer {
  opportunityId: string;
  offerNow: boolean;
  sales: OfferReadiness['lanes']['sales'];
  salesBecause: string;
  /** Research runs whatever the permissions say. */
  research: 'RUNNABLE';
  /** Each external action that is stopped, and the permission that would allow it. */
  blocked: { action: string; reason: string; allowedBy: string }[];
  /** The external actions that may go ahead. */
  going: string[];
}

export interface Port05Reading {
  goalId: string;
  streams:
    | { known: true; streams: Port05Stream[]; independentStreams: number; roles: Partial<Record<StreamRole, number>> }
    | { known: false; reason: string };
  credits: Port05Credit[];
  offers: Port05Offer[];
  summary: { credited: number; notCredited: number; offersGoing: number; offersBlocked: number; offersNotYet: number };
}

/** Pure: the same readings always give the same composition. */
export function composePort05(input: {
  goalId: string;
  streams: StreamsReading | null | undefined;
  credits: readonly CapabilityCredit[];
  offers: readonly { opportunityId: string; readiness: OfferReadiness }[];
}): Port05Reading {
  let streams: Port05Reading['streams'];
  if (!input.streams) {
    streams = { known: false, reason: 'No portfolio reading of this goal is held yet, so its streams are not stated.' };
  } else {
    const list = input.streams.streams.map((one) => ({
      opportunityId: one.opportunityId,
      title: one.title,
      role: one.role,
      roles: [...one.roles],
      independent: one.independent,
      independence: one.independence,
      reason: one.reason,
    }));
    const roles: Partial<Record<StreamRole, number>> = {};
    for (const one of list) roles[one.role] = (roles[one.role] ?? 0) + 1;
    streams = { known: true, streams: list, independentStreams: input.streams.across.independentStreams, roles };
  }
  const credits: Port05Credit[] = input.credits.map((one) => ({
    opportunityId: one.opportunityId,
    mode: one.mode,
    credited: one.credited,
    providerDelivered: one.providerDelivered,
    ownerPhysicallyAbsent: one.ownerPhysicallyAbsent,
    evidence: one.evidence,
    missingEvidence: [...one.missingEvidence],
    reason: one.reason,
  }));
  const offers: Port05Offer[] = input.offers.map(({ opportunityId, readiness }) => ({
    opportunityId,
    offerNow: readiness.offerNow,
    sales: readiness.lanes.sales,
    salesBecause: readiness.lanes.salesBecause,
    research: readiness.lanes.research,
    blocked: readiness.actions.filter((a) => !a.may && a.blocker).map((a) => ({ action: a.action, reason: a.blocker!.reason, allowedBy: a.blocker!.allowedBy })),
    going: readiness.actions.filter((a) => a.may).map((a) => a.action),
  }));
  return {
    goalId: input.goalId,
    streams,
    credits,
    offers,
    summary: {
      credited: credits.filter((c) => c.credited).length,
      notCredited: credits.filter((c) => !c.credited).length,
      offersGoing: offers.filter((o) => o.sales === 'RUNNABLE').length,
      offersBlocked: offers.filter((o) => o.sales === 'BLOCKED').length,
      offersNotYet: offers.filter((o) => o.sales === 'NOT_YET').length,
    },
  };
}

/* --------------------------------------------------------- the plan's hand-off */

/**
 * The latest portfolio streams each goal's plan produced in this process. The
 * plan's own reading is process-local too (`plan.ts` `lastReadings`); this only
 * lets the composition see the streams of it. Bounded by the goals that exist.
 */
const latestStreams = new Map<string, StreamsReading>();

/** The goal plan hands over the streams of the portfolio it just read. */
export function noteGoalPortfolio(goalId: string, portfolio: { streams?: StreamsReading } | null | undefined): void {
  if (portfolio?.streams) latestStreams.set(goalId, portfolio.streams);
  else latestStreams.delete(goalId);
}

export function noteGoalStreamsCleared(): void {
  latestStreams.clear();
}

/* ------------------------------------------------------------------ reader */

export interface Port05Deps {
  streams?: (goalId: string) => StreamsReading | null;
  credits?: (goalId: string) => Promise<CapabilityCredit[]>;
  offers?: (goalId: string, now: Date) => Promise<{ opportunityId: string; readiness: OfferReadiness }[]>;
}

/**
 * What one read of many goals shares. A person's goals read derives PORT-05 for
 * every live goal, and without this each goal re-read every capability, every
 * project's commercial grants (five checks per opening) and its policy, and each
 * opening twice — N goals × M openings × ~10 queries on the main goals route.
 * Within one read the capabilities are read once, each project's grants and
 * policy once, each opening once and each opening's credit and readiness once
 * even when several goals pursue it. Scoped to one read and one `now`: a
 * capability lost an hour ago is never credited by a context that outlived it.
 */
export interface Port05ReadContext {
  now: Date;
  opening(id: string): Promise<CashOpportunity | null>;
  credit(opening: CashOpportunity): Promise<CapabilityCredit | null>;
  readiness(opening: CashOpportunity): Promise<OfferReadiness>;
  /** Run one goal's reading under the read's concurrency bound. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** How many goals one read derives at once: concurrent, without taking the whole pool. */
export const PORT05_READ_CONCURRENCY = 4;

function memoize<K, V>(compute: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const held = new Map<K, Promise<V>>();
  return (key) => {
    let found = held.get(key);
    if (!found) {
      found = compute(key);
      held.set(key, found);
    }
    return found;
  };
}

/** A context for one read. Reads rows lazily and at most once per key; writes nothing. */
export function port05ReadContext(now: Date = new Date(), concurrency = PORT05_READ_CONCURRENCY): Port05ReadContext {
  let capabilities: Promise<ReadonlyMap<string, CapabilityReading>> | null = null;
  let memo: Promise<OfferReadMemo> | null = null;
  const opening = memoize(async (id: string) => (await import('../../repos/cashPortfolio.ts')).getOpportunity(id));
  const creditById = memoize(async (id: string): Promise<CapabilityCredit | null> => {
    const { readAllCapabilities } = await import('../cash/capabilities.ts');
    const { readCreditCase, judgeCapabilityCredit } = await import('./capabilityCredit.ts');
    capabilities ??= readAllCapabilities();
    const found = await readCreditCase(id, await capabilities);
    return found ? judgeCapabilityCredit(found) : null;
  });
  const readinessById = new Map<string, Promise<OfferReadiness>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    now,
    opening,
    credit: (one) => creditById(one.id),
    readiness(one) {
      let found = readinessById.get(one.id);
      if (!found) {
        found = (async () => {
          const readiness = await import('./offerReadiness.ts');
          memo ??= Promise.resolve(readiness.offerReadMemo());
          return readiness.offerReadinessFor(one, now, await memo);
        })();
        readinessById.set(one.id, found);
      }
      return found;
    },
    async run(task) {
      if (active >= Math.max(1, concurrency)) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

async function liveOpenings(goalId: string, context: Port05ReadContext): Promise<CashOpportunity[]> {
  const { liveOpeningsForGoal } = await import('./offerReadiness.ts');
  return liveOpeningsForGoal(goalId, context.opening);
}

/** The live openings a goal pursues, each judged from its rows. Writes nothing. */
async function creditsFromRows(goalId: string, context: Port05ReadContext): Promise<CapabilityCredit[]> {
  const credits = await Promise.all((await liveOpenings(goalId, context)).map((one) => context.credit(one)));
  return credits.filter((one): one is CapabilityCredit => one !== null);
}

async function offersFromRows(goalId: string, context: Port05ReadContext): Promise<{ opportunityId: string; readiness: OfferReadiness }[]> {
  return Promise.all(
    (await liveOpenings(goalId, context)).map(async (one) => ({ opportunityId: one.id, readiness: await context.readiness(one) })),
  );
}

/**
 * One goal's PORT-05 reading, from rows and the plan's latest portfolio. Writes
 * nothing. Pass the read's `context` when reading many goals, so what they share
 * is read once; without one, the goal gets a context of its own.
 */
export async function readPort05(goalId: string, now: Date = new Date(), deps: Port05Deps = {}, context?: Port05ReadContext): Promise<Port05Reading> {
  const ctx = context ?? port05ReadContext(now);
  return ctx.run(async () => {
    const streams = deps.streams ? deps.streams(goalId) : (latestStreams.get(goalId) ?? null);
    const [credits, offers] = await Promise.all([
      deps.credits ? deps.credits(goalId) : creditsFromRows(goalId, ctx),
      deps.offers ? deps.offers(goalId, now) : offersFromRows(goalId, ctx),
    ]);
    return composePort05({ goalId, streams, credits, offers });
  });
}
