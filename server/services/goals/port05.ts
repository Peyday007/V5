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
 * readiness are always read from rows, and so is correlation: the buyer money
 * each stream has taken (`cash_money_entries`, payments less refunds) is read
 * now and every pair it covers over enough shared weeks is measured
 * (`withMeasuredCoMovement`) rather than left at the structural assumption.
 * Nothing here writes.
 *
 * `model.ts` carries the result on `GoalView` (the one goal derivation, §29), so
 * the briefing and the goal page read it from the same place as everything else
 * about a goal.
 */
import { withMeasuredCoMovement, type CorrelationKind, type CorrelationSource, type CoMovement, type FigureBasis, type ObservedOutcome, type StreamRole, type StreamsReading } from './streams.ts';
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

export interface Port05Correlation {
  a: string;
  b: string;
  coefficient: number;
  kind: CorrelationKind;
  basis: FigureBasis;
  source: CorrelationSource;
  /** The weeks and interval a measured coefficient rests on. */
  measured: CoMovement | null;
}

export interface Port05Reading {
  goalId: string;
  streams:
    | {
        known: true;
        streams: Port05Stream[];
        independentStreams: number;
        roles: Partial<Record<StreamRole, number>>;
        /** Pairwise over the leading combination and alternates, measured where the ledger allows. */
        correlations: Port05Correlation[];
        measuredPairs: number;
      }
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
    // A reading held from before correlations were carried has none to show.
    const correlations: Port05Correlation[] = (input.streams.across.correlations ?? []).map((p) => ({
      a: p.a,
      b: p.b,
      coefficient: p.coefficient,
      kind: p.kind,
      basis: p.basis,
      source: p.source ?? (p.kind === 'MEASURED_CO_MOVEMENT' ? 'MEASURED' : p.kind === 'SHARED_RISK_GROUP' ? 'DECLARED' : 'NONE'),
      measured: p.measured ?? null,
    }));
    streams = {
      known: true,
      streams: list,
      independentStreams: input.streams.across.independentStreams,
      roles,
      correlations,
      measuredPairs: correlations.filter((c) => c.kind === 'MEASURED_CO_MOVEMENT').length,
    };
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
  /** Buyer money the streams have taken, dated; defaults to the ledger. */
  observed?: (opportunityIds: readonly string[]) => Promise<ObservedOutcome[]>;
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

/**
 * Buyer money each opening has taken, from the append-only ledger: every
 * customer payment, less every refund, dated when it happened. An opening's
 * entries in more than one currency keep only its most-used currency — a
 * correlation is scale-free between two series, never inside one that adds a
 * dollar to a euro. Writes nothing.
 */
export async function observedOutcomesFromLedger(opportunityIds: readonly string[]): Promise<ObservedOutcome[]> {
  const { getOpportunity } = await import('../../repos/cashPortfolio.ts');
  const { listMoneyEntries } = await import('../../repos/cashLedger.ts');
  const out: ObservedOutcome[] = [];
  for (const id of new Set(opportunityIds)) {
    const opportunity = await getOpportunity(id);
    if (!opportunity) continue;
    const entries = (await listMoneyEntries({ projectId: opportunity.projectId, opportunityId: id, limit: 2000 })).filter((e) => e.kind === 'CUSTOMER_PAYMENT' || e.kind === 'REFUND');
    if (entries.length === 0) continue;
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.currency, (counts.get(e.currency) ?? 0) + 1);
    const currency = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
    for (const e of entries) {
      if (e.currency !== currency) continue;
      out.push({ opportunityId: id, occurredAt: e.occurredAt, amount: (e.kind === 'REFUND' ? -1 : 1) * Math.abs(e.amountCents) / 100 });
    }
  }
  return out;
}

/** One goal's PORT-05 reading, from rows and the plan's latest portfolio. Writes nothing. */
export async function readPort05(goalId: string, now: Date = new Date(), deps: Port05Deps = {}): Promise<Port05Reading> {
  const held = deps.streams ? deps.streams(goalId) : (latestStreams.get(goalId) ?? null);
  const observed = held ? await (deps.observed ?? observedOutcomesFromLedger)(held.streams.map((s) => s.opportunityId)) : [];
  const streams = held ? withMeasuredCoMovement(held, observed) : null;
  const credits = await (deps.credits ?? creditsFromRows)(goalId);
  const offers = await (deps.offers ?? (async (id: string, at: Date) => (await import('./offerReadiness.ts')).offerReadinessForGoal(id, at)))(goalId, now);
  return composePort05({ goalId, streams, credits, offers });
}
