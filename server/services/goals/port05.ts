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
 * The streams come from the plan's own latest portfolio. That reading is held
 * in this process and is not a row, so `evaluateGoalPortfolio` hands its
 * streams here (`notePlanStreams`) and the goal view finds them by the goal's
 * target; until a plan has been read, the streams read as unknown with the
 * reason, and nothing is invented in their place (invariant 39). Credit and
 * readiness are always read from rows. Nothing here writes.
 *
 * `model.ts` carries the result on `GoalView` (the one goal derivation, §29), so
 * the briefing and the goal page read it from the same place as everything else
 * about a goal.
 */
import type { StreamRole, StreamsReading } from './streams.ts';
import type { CapabilityCredit } from './capabilityCredit.ts';
import type { OfferReadiness, OfferReadingContext } from './offerReadiness.ts';
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
 * The streams of the latest goal-plan portfolio, keyed by what that plan was
 * read for: the target's project, currency, remaining amount and days left.
 *
 * `evaluateGoalPortfolio` hands them over itself, at the one place streams are
 * built, for its top-level evaluation only (the plan's reading — never the
 * as-is floor nor a reconstruction variant). An earlier version waited for the
 * plan to call a goal-keyed hand-off nothing ever called, so every live goal's
 * streams read as unknown in production (finding F1). The goal view finds the
 * entry from the goal's own target, read from rows, so the key cannot drift
 * from what the plan modelled.
 *
 * Process-local, like the plan's own reading (`plan.ts` `lastReadings`), and
 * bounded: an entry older than {@link PLAN_STREAMS_STALE_MS} is dropped, and
 * a goal whose plan has not been read since says so rather than showing an old
 * portfolio.
 */
interface HeldStreams {
  streams: StreamsReading;
  at: number;
}
const latestStreams = new Map<string, HeldStreams>();

/** The plan refreshes every half-hour (`PLAN_REFRESH_MS`); streams four refreshes old describe a plan nobody is reading. */
export const PLAN_STREAMS_STALE_MS = 2 * 60 * 60_000;

function streamsKey(projectId: string, currency: string, remainingCents: number, daysLeft: number): string {
  return `${projectId}|${currency}|${Math.round(remainingCents)}|${daysLeft}`;
}

/**
 * Called by `evaluateGoalPortfolio` with the openings it evaluated. The plan
 * models one project's openings in the goal's currency; a set that is empty or
 * mixed is not a goal plan and is not held.
 */
export function notePlanStreams(input: {
  openings: readonly { opportunity?: { projectId?: string; currency?: string } | null }[];
  remaining: number;
  daysLeft: number;
  streams: StreamsReading | null | undefined;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  for (const [key, held] of latestStreams) if (now - held.at > PLAN_STREAMS_STALE_MS) latestStreams.delete(key);
  const first = input.openings[0]?.opportunity;
  if (!input.streams || !first?.projectId || !first.currency) return;
  if (!input.openings.every((one) => one.opportunity?.projectId === first.projectId && one.opportunity?.currency === first.currency)) return;
  latestStreams.set(streamsKey(first.projectId, first.currency, input.remaining * 100, input.daysLeft), { streams: input.streams, at: now });
}

/**
 * The held streams for a goal's target. The plan counted its days left at the
 * time it read, so a reading taken since may count one fewer.
 */
export function heldPlanStreams(
  target: { projectId: string; currency: string; remainingCents: number; daysLeft: number | null },
  now: number = Date.now(),
): StreamsReading | null {
  if (target.daysLeft === null) return null;
  for (const days of [target.daysLeft, target.daysLeft + 1]) {
    const held = latestStreams.get(streamsKey(target.projectId, target.currency, target.remainingCents, days));
    if (held && now - held.at <= PLAN_STREAMS_STALE_MS) return held.streams;
  }
  return null;
}

/** Tests. */
export function noteGoalStreamsCleared(): void {
  latestStreams.clear();
}

/* ------------------------------------------------------------------ reader */

/**
 * What one read shares across every goal it reads (finding F5).
 *
 * A person's goals read used to call {@link readPort05} once per live goal, in
 * series, and each call re-read the goal and its target, its links, every
 * opening twice, the capability readings, and — per opening — the project's
 * five commercial grants, its execution policy and the goal's spending rows:
 * goals × openings × about ten queries on the main goals route. The context
 * reads each of those once per read: the commercial grants and policy once per
 * project, the capability readings once, each opening once, the goal and target
 * once. It is built for one read at one `now` and discarded with it, so nothing
 * here is a cache that outlives a read (a grant withdrawn a second ago is read
 * again by the next read).
 */
export interface Port05ReadContext {
  readonly now: Date;
  readonly offers: OfferReadingContext;
  capabilities(): Promise<ReadonlyMap<string, CapabilityReading>>;
  opportunity(id: string): Promise<CashOpportunity | null>;
}

export async function port05ReadContext(now: Date = new Date()): Promise<Port05ReadContext> {
  const { offerReadingContext } = await import('./offerReadiness.ts');
  const { readAllCapabilities } = await import('../cash/capabilities.ts');
  const offers = offerReadingContext(now);
  let capabilities: Promise<ReadonlyMap<string, CapabilityReading>> | null = null;
  return {
    now,
    offers,
    capabilities: () => (capabilities ??= readAllCapabilities()),
    opportunity: offers.spending.opportunity,
  };
}

/** The streams of the plan last read for this goal's target, or null. Reads rows; writes nothing. */
async function streamsFromPlan(goalId: string, now: Date, context?: Port05ReadContext): Promise<StreamsReading | null> {
  if (context) {
    const target = await context.offers.spending.target(goalId);
    return target ? heldPlanStreams(target, now.getTime()) : null;
  }
  const { getWorkstream } = await import('../../repos/register.ts');
  const { readTarget } = await import('./target.ts');
  const goal = await getWorkstream(goalId);
  if (!goal) return null;
  const target = await readTarget(goal, now);
  return target ? heldPlanStreams(target, now.getTime()) : null;
}

export interface Port05Deps {
  streams?: (goalId: string, now: Date) => StreamsReading | null | Promise<StreamsReading | null>;
  credits?: (goalId: string) => Promise<CapabilityCredit[]>;
  offers?: (goalId: string, now: Date) => Promise<{ opportunityId: string; readiness: OfferReadiness }[]>;
}

/** The live openings a goal pursues, read once each. */
async function liveOpenings(goalId: string, context: Port05ReadContext, opportunityIds?: readonly string[]): Promise<CashOpportunity[]> {
  const { SETTLED_OPENING_STATES } = await import('./offerReadiness.ts');
  const ids =
    opportunityIds ?? (await context.offers.spending.links(goalId)).filter((link) => link.kind === 'OPPORTUNITY').map((link) => link.ref);
  const rows = await Promise.all([...new Set(ids)].map((id) => context.opportunity(id)));
  return rows.filter((one): one is CashOpportunity => one !== null && !SETTLED_OPENING_STATES.has(one.state));
}

/** Each live opening judged from its rows. Writes nothing. */
async function creditsFromRows(openings: readonly CashOpportunity[], context: Port05ReadContext): Promise<CapabilityCredit[]> {
  if (openings.length === 0) return [];
  const { readCreditCase, judgeCapabilityCredit } = await import('./capabilityCredit.ts');
  const readings = await context.capabilities();
  const cases = await Promise.all(openings.map((opportunity) => readCreditCase(opportunity.id, readings, opportunity)));
  return cases.filter((one): one is NonNullable<typeof one> => one !== null).map((one) => judgeCapabilityCredit(one));
}

/**
 * One goal's PORT-05 reading, from rows and the plan's latest portfolio.
 * Writes nothing. A caller reading several goals passes one
 * {@link Port05ReadContext} (or uses {@link readPort05ForGoals}) so the rows
 * they share are read once.
 */
export async function readPort05(
  goalId: string,
  now: Date = new Date(),
  deps: Port05Deps = {},
  options: { context?: Port05ReadContext; opportunityIds?: readonly string[] } = {},
): Promise<Port05Reading> {
  const context = options.context ?? (await port05ReadContext(now));
  const needsOpenings = !deps.credits || !deps.offers;
  const openings = needsOpenings ? await liveOpenings(goalId, context, options.opportunityIds) : [];
  const [streams, credits, offers] = await Promise.all([
    deps.streams ? deps.streams(goalId, now) : streamsFromPlan(goalId, now, context),
    deps.credits ? deps.credits(goalId) : creditsFromRows(openings, context),
    deps.offers
      ? deps.offers(goalId, now)
      : import('./offerReadiness.ts').then(({ offerReadinessForGoal }) => offerReadinessForGoal(goalId, now, { context: context.offers, openings })),
  ]);
  return composePort05({ goalId, streams, credits, offers });
}

/** A goal's reading, or why it could not be taken — never a silent gap. */
export type Port05Outcome = { ok: true; reading: Port05Reading } | { ok: false; reason: string };

/** How many goals one read derives at once: enough to overlap I/O, few enough not to flood the pool. */
export const PORT05_READ_CONCURRENCY = 4;

/**
 * Every named goal's PORT-05 reading in one read, over one shared context and
 * a bounded number at a time. A goal whose reading fails is returned with the
 * reason rather than dropped, so the view can say it was not read.
 */
export async function readPort05ForGoals(
  goals: readonly { goalId: string; opportunityIds?: readonly string[] }[],
  now: Date = new Date(),
  options: { deps?: Port05Deps; concurrency?: number } = {},
): Promise<Map<string, Port05Outcome>> {
  const out = new Map<string, Port05Outcome>();
  if (goals.length === 0) return out;
  const context = await port05ReadContext(now);
  const queue = [...goals];
  const lanes = Math.max(1, Math.min(options.concurrency ?? PORT05_READ_CONCURRENCY, queue.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const reading = await readPort05(next.goalId, now, options.deps, { context, opportunityIds: next.opportunityIds });
          out.set(next.goalId, { ok: true, reading });
        } catch (err) {
          out.set(next.goalId, { ok: false, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }),
  );
  return out;
}
