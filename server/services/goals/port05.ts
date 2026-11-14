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
import type { OfferReadiness } from './offerReadiness.ts';

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

/** The live openings a goal pursues, each judged from its rows. Writes nothing. */
async function creditsFromRows(goalId: string): Promise<CapabilityCredit[]> {
  const { listLinks } = await import('../../repos/register.ts');
  const { getOpportunity } = await import('../../repos/cashPortfolio.ts');
  const { readAllCapabilities } = await import('../cash/capabilities.ts');
  const { readCreditCase, judgeCapabilityCredit } = await import('./capabilityCredit.ts');
  const out: CapabilityCredit[] = [];
  let readings: Awaited<ReturnType<typeof readAllCapabilities>> | null = null;
  for (const link of await listLinks(goalId)) {
    if (link.kind !== 'OPPORTUNITY') continue;
    const opportunity = await getOpportunity(link.ref);
    if (!opportunity || opportunity.state === 'ARCHIVED' || opportunity.state === 'DECLINED' || opportunity.state === 'COLLECTED') continue;
    readings ??= await readAllCapabilities();
    const credit = await readCreditCase(opportunity.id, readings);
    if (credit) out.push(judgeCapabilityCredit(credit));
  }
  return out;
}

/** One goal's PORT-05 reading, from rows and the plan's latest portfolio. Writes nothing. */
export async function readPort05(goalId: string, now: Date = new Date(), deps: Port05Deps = {}): Promise<Port05Reading> {
  const streams = deps.streams ? deps.streams(goalId) : (latestStreams.get(goalId) ?? null);
  const credits = await (deps.credits ?? creditsFromRows)(goalId);
  const offers = await (deps.offers ?? (async (id: string, at: Date) => (await import('./offerReadiness.ts')).offerReadinessForGoal(id, at)))(goalId, now);
  return composePort05({ goalId, streams, credits, offers });
}
