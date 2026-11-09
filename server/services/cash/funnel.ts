/**
 * The Cash funnel, counted from rows (OPPORTUNITY-INTELLIGENCE §2.6, §3.6, §5 H).
 *
 * Point-in-time tier counts say where a sprint is. They do not say whether it
 * is getting anywhere, and the plan's success criterion H asks for that:
 * qualified and ready throughput per week, the time it takes to qualify, what
 * reconsiderations produced, how much research one qualified opening cost, how
 * much the archive answered, and what reached the real world.
 *
 * Every figure here is either a count of rows or `null`, and `null` means
 * **unknown** — never zero. Three of them are unknown by construction today and
 * say so: a tier is derived and never written down when it changes, so the week
 * a piece first became qualified is not recorded anywhere; a stage-1 dive exists
 * only once the dives carry a stage; and money that reached the world exists
 * only once an outcome or a settlement is recorded. A report that printed 0 for
 * any of those would be reporting an absence of rows as a finding.
 *
 * It writes nothing.
 */
import { getDb } from '../../db/database.ts';
import { cashNow } from '../../repos/cashMode.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { parseJson } from '../../repos/util.ts';
import type { CashCardFact, Standing } from '../../domain/types.ts';
import { CASH_TIERS, cashTier, tierRank, type CashTier } from './tier.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';

export const FUNNEL_WEEKS = 8;

export interface FunnelWeek {
  /** The Monday (UTC) the week starts on, as a date. */
  week: string;
  /** Openings first recorded that week, duplicates excluded. */
  discovered: number;
  /** Where the openings discovered that week stand now, by tier. A cohort reading. */
  cohortNow: Record<CashTier, number>;
  /** Pieces marked READY that week — a recorded transition. */
  markedReady: number;
  /** Pieces that first reached QUALIFIED that week. Unknown: no row records a tier crossing. */
  qualifiedCrossings: number | null;
}

export interface FunnelReading {
  window: { since: string; until: string; weeks: number };
  weeks: FunnelWeek[];
  /** Median days from discovery to the settling of the dive, for pieces qualified now. */
  medianDaysToQualified: { days: number | null; sample: number; basis: string };
  reconsiderations: {
    /** Changes consumed in the window, from the consumed-change ledger. */
    triggered: number;
    byVia: Record<string, number>;
    /** Where each reconsidered piece stands now. */
    outcomes: { advanced: number; waiting: number; dormantAgain: number; unknown: number };
    /** `CASH_RECONSIDERATION_TRIGGERED` events, written by the reconsideration engine. */
    engineEvents: number;
  };
  dives: {
    started: number;
    qualifiedNow: number;
    /** Dives started per piece qualified now. Unknown when nothing is qualified. */
    perQualified: number | null;
    /** Pieces whose every dive was a stage-1 screen. Unknown until dives carry a stage. */
    stageOneOnly: number | null;
  };
  archive: {
    requirementsAsked: number;
    closedByArchive: number;
    /** Closed over asked. Unknown when nothing was asked. */
    share: number | null;
  };
  sessions: {
    /** Fires Brain sent for this project in the window. */
    started: number;
    /** Research work items that finished successfully in the window. */
    acceptedCompletions: number;
    perSession: number | null;
  };
  outcomes: {
    /** Pieces with a recorded commercial outcome. Unknown when no outcome exists at all. */
    commercialTests: number | null;
    /** Settled cash in minor units, by currency. Unknown when nothing has settled. */
    settledByCurrency: Record<string, number> | null;
    byKind: Record<string, number>;
  };
  /**
   * Every mechanism that has recorded outcomes, modelled as the full outreach
   * funnel from those rows (COM-13-3). Stages no row states are unknown.
   */
  outreach: { mechanisms: OutreachFunnelReading[]; mix: MixReading };
}

/** The Monday on or before `iso`, as `YYYY-MM-DD` (UTC). */
export function weekOf(iso: string): string {
  const date = new Date(iso);
  const day = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

function emptyTiers(): Record<CashTier, number> {
  return Object.fromEntries(CASH_TIERS.map((tier) => [tier, 0])) as Record<CashTier, number>;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The funnel for one project.
 *
 * `standings` are the current standings (from `projectStandings`), used only to
 * say where a reconsidered piece stands now; without them every outcome is
 * unknown rather than guessed.
 */
export async function cashFunnel(input: {
  projectId: string;
  standings?: ReadonlyMap<string, Standing>;
  now?: string;
  weeks?: number;
}): Promise<FunnelReading> {
  const db = getDb();
  const until = input.now ?? cashNow();
  const weeksCount = input.weeks ?? FUNNEL_WEEKS;
  const sinceMonday = new Date(Date.parse(weekOf(until)) - (weeksCount - 1) * 7 * 86_400_000);
  const since = sinceMonday.toISOString();
  const sevenDaysAgo = new Date(Date.parse(until) - 7 * 86_400_000).toISOString();

  const opportunities = await listOpportunities({ projectId: input.projectId });
  const facts = new Map<string, CashCardFact[]>();
  for (const fact of await cardFactsForProject(input.projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }
  const tierOf = new Map<string, CashTier>();
  for (const opportunity of opportunities) {
    tierOf.set(
      opportunity.id,
      cashTier({
        opportunity,
        card: cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] }),
        readiness: evidenceCard(opportunity).readiness,
      }).tier,
    );
  }

  // Weeks, oldest first.
  const weeks = new Map<string, FunnelWeek>();
  for (let index = 0; index < weeksCount; index += 1) {
    const week = new Date(sinceMonday.getTime() + index * 7 * 86_400_000).toISOString().slice(0, 10);
    weeks.set(week, {
      week,
      discovered: 0,
      cohortNow: emptyTiers(),
      markedReady: 0,
      qualifiedCrossings: null,
    });
  }
  for (const opportunity of opportunities) {
    if (opportunity.duplicateOfId || opportunity.createdAt < since) continue;
    const bucket = weeks.get(weekOf(opportunity.createdAt));
    if (!bucket) continue;
    bucket.discovered += 1;
    bucket.cohortNow[tierOf.get(opportunity.id) ?? 'SIGNAL'] += 1;
  }
  const readyEvents = await db.all<{ created_at: string }>(
    `SELECT created_at FROM cash_events
      WHERE project_id = ? AND kind = 'CASH_OPPORTUNITY_READY' AND created_at >= ?`,
    [input.projectId, since],
  );
  for (const event of readyEvents) {
    const bucket = weeks.get(weekOf(event.created_at));
    if (bucket) bucket.markedReady += 1;
  }

  // Discovery to qualified, for what is qualified now and whose dive settled.
  const qualifiedNow = opportunities.filter(
    (one) => tierRank(tierOf.get(one.id) ?? 'SIGNAL') >= tierRank('QUALIFIED'),
  );
  const days = qualifiedNow
    .filter((one) => one.validationSettledAt !== null)
    .map((one) => (Date.parse(one.validationSettledAt!) - Date.parse(one.createdAt)) / 86_400_000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const medianDays = median(days);

  // Reconsiderations, from the consumed-change ledger.
  const triggers = await db.all<{ opportunity_id: string; kind: string }>(
    `SELECT opportunity_id, kind FROM cash_reconsideration_triggers
      WHERE project_id = ? AND created_at >= ?`,
    [input.projectId, since],
  );
  const byVia: Record<string, number> = {};
  const outcomes = { advanced: 0, waiting: 0, dormantAgain: 0, unknown: 0 };
  for (const trigger of triggers) {
    byVia[trigger.kind] = (byVia[trigger.kind] ?? 0) + 1;
    const standing = input.standings?.get(trigger.opportunity_id);
    if (!standing) outcomes.unknown += 1;
    else if (standing.kind === 'ADVANCING' || standing.kind === 'DONE') outcomes.advanced += 1;
    else if (standing.kind === 'WAITING') outcomes.waiting += 1;
    else outcomes.dormantAgain += 1;
  }
  const engineEvents = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_events
      WHERE project_id = ? AND kind = 'CASH_RECONSIDERATION_TRIGGERED' AND created_at >= ?`,
    [input.projectId, since],
  );

  // Dives, and whether any carries a stage.
  const diveEvents = await db.all<{ opportunity_id: string | null; detail: string }>(
    `SELECT opportunity_id, detail FROM cash_events
      WHERE project_id = ? AND kind = 'CASH_VALIDATION_STARTED'`,
    [input.projectId],
  );
  const stagesByPiece = new Map<string, string[]>();
  let anyStage = false;
  for (const event of diveEvents) {
    const stage = parseJson<Record<string, unknown>>(event.detail, {})['stage'];
    if (stage !== undefined && stage !== null) anyStage = true;
    if (!event.opportunity_id) continue;
    stagesByPiece.set(event.opportunity_id, [
      ...(stagesByPiece.get(event.opportunity_id) ?? []),
      stage === undefined || stage === null ? '' : String(stage),
    ]);
  }
  const isScreen = (stage: string): boolean => stage === '1' || /SCREEN/i.test(stage);
  const stageOneOnly = anyStage
    ? [...stagesByPiece.values()].filter((stages) => stages.length > 0 && stages.every(isScreen)).length
    : null;

  // What the archive answered.
  const coverage = await db.get<{ asked: number; closed: number }>(
    `SELECT COUNT(*) AS asked,
            SUM(CASE WHEN c.needs_research = 0 THEN 1 ELSE 0 END) AS closed
       FROM requirement_coverage c
       JOIN research_orchestrations o ON o.id = c.orchestration_id
      WHERE o.project_id = ?`,
    [input.projectId],
  );
  const asked = Number(coverage?.asked ?? 0);
  const closed = Number(coverage?.closed ?? 0);

  // Sessions started against accepted completions, over the last seven days.
  const sessions = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_events
      WHERE project_id = ? AND event_type = 'DISPATCH_SENT' AND at >= ?`,
    [input.projectId, sevenDaysAgo],
  );
  const completions = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM work_items
      WHERE project_id = ? AND work_type LIKE 'RESEARCH_%' AND state = 'SUCCEEDED'
        AND completed_at >= ?`,
    [input.projectId, sevenDaysAgo],
  );
  const sessionsStarted = Number(sessions?.n ?? 0);
  const accepted = Number(completions?.n ?? 0);

  // What reached the world.
  const outcomeRows = await db.all<{ opportunity_id: string; kind: string }>(
    `SELECT opportunity_id, kind FROM cash_outcomes WHERE project_id = ?`,
    [input.projectId],
  );
  const byKind: Record<string, number> = {};
  for (const row of outcomeRows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const settlements = await db.all<{ currency: string; total: number }>(
    `SELECT currency, SUM(amount_cents) AS total FROM cash_money_entries
      WHERE project_id = ? AND kind = 'SETTLEMENT' GROUP BY currency`,
    [input.projectId],
  );

  const qualifiedCount = qualifiedNow.length;
  return {
    window: { since, until, weeks: weeksCount },
    weeks: [...weeks.values()],
    medianDaysToQualified: {
      days: medianDays,
      sample: days.length,
      basis:
        'from the day an opening was recorded to the day the dive that qualified it settled, for ' +
        'openings qualified now',
    },
    reconsiderations: {
      triggered: triggers.length,
      byVia,
      outcomes,
      engineEvents: Number(engineEvents?.n ?? 0),
    },
    dives: {
      started: diveEvents.length,
      qualifiedNow: qualifiedCount,
      perQualified: qualifiedCount > 0 ? diveEvents.length / qualifiedCount : null,
      stageOneOnly,
    },
    archive: {
      requirementsAsked: asked,
      closedByArchive: closed,
      share: asked > 0 ? closed / asked : null,
    },
    sessions: {
      started: sessionsStarted,
      acceptedCompletions: accepted,
      perSession: sessionsStarted > 0 ? accepted / sessionsStarted : null,
    },
    outcomes: {
      commercialTests:
        outcomeRows.length > 0 ? new Set(outcomeRows.map((row) => row.opportunity_id)).size : null,
      settledByCurrency:
        settlements.length > 0
          ? Object.fromEntries(settlements.map((row) => [row.currency, Number(row.total)]))
          : null,
      byKind,
    },
    outreach: await outreachFromRows(input.projectId),
  };
}

/** A number, or the word `unknown`. Never a zero standing in for an absence. */
export function figure(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return digits > 0 ? value.toFixed(digits) : String(value);
}

/** The FUNNEL block's lines, exactly as the report prints them. */
export function formatFunnel(reading: FunnelReading): string[] {
  const lines: string[] = [];
  lines.push(`FUNNEL (weeks from ${reading.window.since.slice(0, 10)}; counted from rows)`);
  lines.push('  week        discovered  now: signal candidate qualified ready  marked-ready  qualified-crossings');
  for (const week of reading.weeks) {
    lines.push(
      `  ${week.week}  ${String(week.discovered).padStart(10)}       ${String(week.cohortNow.SIGNAL).padStart(6)}` +
        ` ${String(week.cohortNow.CANDIDATE).padStart(9)} ${String(week.cohortNow.QUALIFIED).padStart(9)}` +
        ` ${String(week.cohortNow.READY_TO_TEST).padStart(5)}  ${String(week.markedReady).padStart(12)}` +
        `  ${figure(week.qualifiedCrossings)}`,
    );
  }
  lines.push(
    '  qualified-crossings is unknown: a tier is derived and never written down when it changes; ' +
      '"now" is where each week\'s discoveries stand today.',
  );
  const m = reading.medianDaysToQualified;
  lines.push(`  median days discovery→qualified ${figure(m.days, 1)} (n=${m.sample}; ${m.basis})`);
  const r = reading.reconsiderations;
  lines.push(
    `  reconsiderations triggered=${r.triggered}` +
      ` via ${Object.entries(r.byVia).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'}` +
      ` engine-events=${r.engineEvents}` +
      ` outcome advanced=${r.outcomes.advanced} waiting=${r.outcomes.waiting}` +
      ` dormant-again=${r.outcomes.dormantAgain} unknown=${r.outcomes.unknown}`,
  );
  const d = reading.dives;
  lines.push(
    `  dives started=${d.started} qualified-now=${d.qualifiedNow}` +
      ` dives-per-qualified=${figure(d.perQualified, 1)} stage-1-only=${figure(d.stageOneOnly)}`,
  );
  const a = reading.archive;
  lines.push(
    `  requirements asked=${a.requirementsAsked} closed-by-archive=${a.closedByArchive}` +
      ` share=${a.share === null ? 'unknown' : `${(a.share * 100).toFixed(1)}%`}`,
  );
  const s = reading.sessions;
  lines.push(
    `  last 7 days: sessions-started=${s.started} accepted-completions=${s.acceptedCompletions}` +
      ` per-session=${figure(s.perSession, 3)}`,
  );
  const o = reading.outcomes;
  lines.push(
    `  outcomes commercial-tests=${figure(o.commercialTests)} settled=` +
      (o.settledByCurrency === null
        ? 'unknown'
        : Object.entries(o.settledByCurrency).map(([c, n]) => `${c} ${n}`).join(' ')) +
      ` kinds ${Object.entries(o.byKind).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'}`,
  );
  if (reading.outreach.mechanisms.length === 0) {
    lines.push('  outreach funnel: no mechanism has recorded an outcome yet');
  } else {
    for (const mechanism of reading.outreach.mechanisms) lines.push(...formatOutreachFunnel(mechanism).map((line) => `  ${line}`));
    lines.push(
      `  outreach mix ranked=${reading.outreach.mix.ranked.map((one) => one.mode).join(',') || '(none)'}` +
        ` unranked=${reading.outreach.mix.unranked.map((one) => `${one.mode}[${one.firstUnknown ?? 'unknown'}]`).join(',') || '(none)'}`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------------- */
/* The outreach funnel (COM-13-3): messages are not buyers                    */
/* ------------------------------------------------------------------------- */

/**
 * A stage input is measured, estimated with a range, or unknown. Unknown is a
 * state of its own: it is never turned into a favourable number, and it makes
 * every figure downstream of it unknown too.
 */
export type StageInput =
  | { basis: 'MEASURED'; value: number }
  | { basis: 'ESTIMATED'; low: number; high: number }
  | { basis: 'UNKNOWN' };

/** The stages of any outreach mechanism, each its own figure, in funnel order. */
export const OUTREACH_STAGES = [
  'permission', // provider terms and consent permit this use at all: 1 = permitted, 0 = refused
  'uniqueProspects', // unique relevant prospects reachable (a count, not a message count)
  'deliverability', // share of sends that reach an inbox or inbox-equivalent
  'throughput', // messages the sending accounts can send in the period, at their reputation
  'response', // share of reached prospects that reply or engage
  'qualification', // share of responders that qualify
  'close', // share of qualified that buy
  'settlement', // share of closed value that settles as cash
  'fulfillment', // share of settled orders delivered without refund
  'repeat', // additional purchases per fulfilled buyer
] as const;
export type OutreachStage = (typeof OUTREACH_STAGES)[number];

/**
 * One way of reaching demand. `mode` is a label for the comparison, not a
 * category the model branches on: volume, high-ticket, partner and marketplace
 * mechanisms are modelled by the same stages with different inputs, and a
 * mechanism of any other kind is modelled the same way.
 */
export interface OutreachMechanism {
  mode: string;
  label: string;
  inputs: Partial<Record<OutreachStage, StageInput>>;
  /** Value of one fulfilled purchase, in minor units. Unknown unless somebody supplied it. */
  dealValueCents?: StageInput;
  /** Messages the mechanism proposes to send. Reported as effort only; no stage reads it as a buyer. */
  messagesSent?: number;
}

export interface Range {
  low: number | null;
  high: number | null;
}

export interface OutreachFigure extends Range {
  basis: 'MEASURED' | 'ESTIMATED' | 'UNKNOWN';
  /** Why the figure is unknown, when it is. */
  because: string | null;
}

export interface OutreachFunnelReading {
  mode: string;
  label: string;
  /** Every stage input as given, defaulting to unknown. */
  stages: Record<OutreachStage, OutreachFigure>;
  /** Messages proposed. Effort, never buyers, sales or revenue. */
  messagesSent: number | null;
  /** Counts at each step, derived from the stage inputs and never from messagesSent. */
  reachedProspects: OutreachFigure;
  responders: OutreachFigure;
  qualified: OutreachFigure;
  buyers: OutreachFigure;
  settledBuyers: OutreachFigure;
  fulfilledBuyers: OutreachFigure;
  /**
   * Settled revenue from first purchases alone, in minor units. It does not
   * depend on the repeat stage, so an unknown repeat input leaves it known.
   */
  firstPurchaseRevenueCents: OutreachFigure;
  /** Revenue over the period including repeat purchases. Unknown while repeat is unknown. */
  revenueCents: OutreachFigure;
  /** First stage whose input is unknown or refused, in funnel order. */
  firstUnknown: OutreachStage | null;
  permitted: boolean | null;
}

const UNKNOWN_FIGURE = (because: string): OutreachFigure => ({ basis: 'UNKNOWN', low: null, high: null, because });

/**
 * What a stage input is a quantity of. A share is a fraction of the stage before
 * it and cannot exceed 1; a count or amount is any non-negative number; a
 * permission is a yes or a no and is never a fraction. A value that is not the
 * kind its stage needs is unknown, not clamped: clamping would turn a bad
 * recording into a favourable number.
 */
export type StageKind = 'share' | 'count' | 'permission';

const SHARE_STAGES: readonly OutreachStage[] = ['deliverability', 'response', 'qualification', 'close', 'settlement', 'fulfillment'];
const COUNT_STAGES: readonly OutreachStage[] = ['uniqueProspects', 'throughput', 'repeat'];

/** The kind of quantity each stage is. Exported so a caller can say what a stage takes. */
export function stageKind(stage: OutreachStage): StageKind {
  if (stage === 'permission') return 'permission';
  if (SHARE_STAGES.includes(stage)) return 'share';
  if (COUNT_STAGES.includes(stage)) return 'count';
  return 'count';
}

function figureOf(input: StageInput | undefined, what: string, kind: StageKind = 'count'): OutreachFigure {
  if (!input || input.basis === 'UNKNOWN') return UNKNOWN_FIGURE(`${what} is unknown`);
  const fits = (value: number): boolean => {
    if (!Number.isFinite(value) || value < 0) return false;
    if (kind === 'share') return value <= 1;
    if (kind === 'permission') return value === 0 || value === 1;
    return true;
  };
  const describe = kind === 'share' ? 'a share between 0 and 1' : kind === 'permission' ? 'a yes (1) or a no (0)' : 'a count or an amount';
  if (input.basis === 'MEASURED') {
    return fits(input.value)
      ? { basis: 'MEASURED', low: input.value, high: input.value, because: null }
      : UNKNOWN_FIGURE(`${what} was recorded as a value that is not ${describe}`);
  }
  // Permission is a fact about provider terms, so a range over it says nothing.
  if (kind === 'permission') return UNKNOWN_FIGURE(`${what} is a yes or a no; an estimate over it is not evidence`);
  const low = Math.min(input.low, input.high);
  const high = Math.max(input.low, input.high);
  return fits(low) && fits(high)
    ? { basis: 'ESTIMATED', low, high, because: null }
    : UNKNOWN_FIGURE(`${what} was recorded as a range that is not ${describe}`);
}

/** One step of the funnel: a count times a share. Unknown on either side stays unknown. */
function step(count: OutreachFigure, share: OutreachFigure, what: string): OutreachFigure {
  if (count.basis === 'UNKNOWN' || count.low === null || count.high === null) {
    return UNKNOWN_FIGURE(count.because ?? `${what} follows an unknown stage`);
  }
  if (share.basis === 'UNKNOWN' || share.low === null || share.high === null) {
    return UNKNOWN_FIGURE(share.because ?? `${what} needs an input that is unknown`);
  }
  const basis = count.basis === 'MEASURED' && share.basis === 'MEASURED' ? 'MEASURED' : 'ESTIMATED';
  return { basis, low: count.low * share.low, high: count.high * share.high, because: null };
}

/**
 * Model one outreach mechanism as the full funnel. Pure.
 *
 * Reached prospects are the unique relevant prospects times deliverability,
 * capped by what sending throughput can reach. The number of messages sent is
 * carried as effort and is read by no stage, so sending more messages never
 * produces a buyer by itself, and a permission that is refused or unknown makes
 * every figure after it unknown rather than zero or favourable.
 */
export function modelOutreachFunnel(mechanism: OutreachMechanism): OutreachFunnelReading {
  const stages = Object.fromEntries(
    OUTREACH_STAGES.map((stage) => [stage, figureOf(mechanism.inputs[stage], stage, stageKind(stage))]),
  ) as Record<OutreachStage, OutreachFigure>;

  const permission = stages.permission;
  const permitted: boolean | null =
    permission.basis === 'UNKNOWN' || permission.low === null || permission.high === null
      ? null
      : permission.high > 0 && permission.low > 0
        ? true
        : permission.high === 0
          ? false
          : null;
  const gate = (figure: OutreachFigure): OutreachFigure => {
    if (permitted === true) return figure;
    return UNKNOWN_FIGURE(
      permitted === false ? 'provider terms or consent refuse this use' : 'whether provider terms and consent permit this use is unknown',
    );
  };

  const { uniqueProspects, deliverability, throughput } = stages;
  const deliverable = gate(step(uniqueProspects, deliverability, 'reached prospects'));
  const reachedProspects: OutreachFigure =
    deliverable.basis === 'UNKNOWN' || throughput.basis === 'UNKNOWN' || deliverable.high === null || throughput.high === null || throughput.low === null || deliverable.low === null
      ? deliverable.basis === 'UNKNOWN'
        ? deliverable
        : UNKNOWN_FIGURE(throughput.because ?? 'sending throughput is unknown')
      : {
          basis: 'ESTIMATED',
          low: Math.min(deliverable.low, throughput.low),
          high: Math.min(deliverable.high, throughput.high),
          because: null,
        };

  const responders = step(reachedProspects, stages.response, 'responders');
  const qualified = step(responders, stages.qualification, 'qualified');
  const buyers = step(qualified, stages.close, 'buyers');
  const settledBuyers = step(buyers, stages.settlement, 'settled buyers');
  const fulfilledBuyers = step(settledBuyers, stages.fulfillment, 'fulfilled buyers');
  const deal = figureOf(mechanism.dealValueCents, 'deal value');
  const firstPurchase = step(fulfilledBuyers, deal, 'revenue');
  // Each fulfilled buyer buys once, plus `repeat` further purchases on average.
  const repeat = stages.repeat;
  const revenueCents: OutreachFigure =
    firstPurchase.basis === 'UNKNOWN' || repeat.basis === 'UNKNOWN' || firstPurchase.low === null || firstPurchase.high === null || repeat.low === null || repeat.high === null
      ? UNKNOWN_FIGURE(firstPurchase.because ?? repeat.because ?? 'repeat purchase is unknown')
      : {
          basis: firstPurchase.basis === 'MEASURED' && repeat.basis === 'MEASURED' ? 'MEASURED' : 'ESTIMATED',
          low: firstPurchase.low * (1 + repeat.low),
          high: firstPurchase.high * (1 + repeat.high),
          because: null,
        };

  const firstUnknown =
    OUTREACH_STAGES.find((stage) => stages[stage].basis === 'UNKNOWN' || (stage === 'permission' && permitted !== true)) ?? null;

  return {
    mode: mechanism.mode,
    label: mechanism.label,
    stages,
    messagesSent: mechanism.messagesSent ?? null,
    reachedProspects,
    responders,
    qualified,
    buyers,
    settledBuyers,
    fulfilledBuyers,
    firstPurchaseRevenueCents: firstPurchase,
    revenueCents,
    firstUnknown,
    permitted,
  };
}

export interface MixReading {
  /** Mechanisms whose first-purchase revenue is known to a range, strongest lower bound first. */
  ranked: OutreachFunnelReading[];
  /** Mechanisms with an unknown or refused stage. Never ranked, never assumed favourable. */
  unranked: { mode: string; label: string; firstUnknown: OutreachStage | null; because: string | null }[];
}

/**
 * Compare any set of mechanisms for the economically strongest mix. Pure.
 *
 * No mode is a default and none is excluded: a mechanism is ranked only on its
 * own stage inputs, by the low end of its first-purchase revenue range, and one with an unknown
 * stage is listed as unranked with the stage that is missing, which is the task
 * to do next.
 */
export function searchOutreachMix(mechanisms: readonly OutreachMechanism[]): MixReading {
  const readings = mechanisms.map(modelOutreachFunnel);
  const ranked = readings
    .filter((one) => one.firstPurchaseRevenueCents.basis !== 'UNKNOWN')
    .sort(
      (a, b) =>
        (b.firstPurchaseRevenueCents.low ?? 0) - (a.firstPurchaseRevenueCents.low ?? 0) ||
        (b.firstPurchaseRevenueCents.high ?? 0) - (a.firstPurchaseRevenueCents.high ?? 0),
    );
  const unranked = readings
    .filter((one) => one.firstPurchaseRevenueCents.basis === 'UNKNOWN')
    .map((one) => ({
      mode: one.mode,
      label: one.label,
      firstUnknown: one.firstUnknown,
      because: one.firstPurchaseRevenueCents.because,
    }));
  return { ranked, unranked };
}

/** The outreach funnel's lines for a reading: every stage with its basis, and what is unknown. */
export function formatOutreachFunnel(reading: OutreachFunnelReading): string[] {
  const show = (f: OutreachFigure): string =>
    f.basis === 'UNKNOWN' ? `unknown (${f.because ?? 'no input'})` : `${figure(f.low, 2)}–${figure(f.high, 2)} ${f.basis.toLowerCase()}`;
  return [
    `OUTREACH FUNNEL ${reading.mode}: ${reading.label}`,
    `  messages sent ${figure(reading.messagesSent)} (effort only; not prospects, buyers or revenue)`,
    ...OUTREACH_STAGES.map((stage) => `  ${stage.padEnd(16)} ${show(reading.stages[stage])}`),
    `  reached prospects ${show(reading.reachedProspects)}`,
    `  buyers ${show(reading.buyers)}`,
    `  first-purchase revenue (minor units) ${show(reading.firstPurchaseRevenueCents)}`,
    `  revenue incl. repeat (minor units) ${show(reading.revenueCents)}`,
  ];
}

/**
 * Build the mechanisms from the outcome rows Brain has written (§94). Only what
 * a row states becomes a measured input: the share of contacts that were
 * answered, the share that bounced, the share of answered contacts that agreed,
 * the share of agreed deals not refunded, and the agreed price. Permission,
 * unique prospects, throughput, qualification, settlement and repeat are stated
 * by no outcome row, so they stay unknown and keep revenue unknown until
 * somebody records them; a message count is never read as a buyer. A mechanism
 * is whatever the rows name (its `mechanism`, else its `channel`), never a
 * list this code knows.
 */
async function outreachFromRows(projectId: string): Promise<{ mechanisms: OutreachFunnelReading[]; mix: MixReading }> {
  const rows = await getDb().all<{
    mechanism: string | null;
    channel: string | null;
    opportunity_id: string;
    kind: string;
    value_cents: number | null;
    value_text: string | null;
    request_key: string;
  }>(
    `SELECT mechanism, channel, opportunity_id, kind, value_cents, value_text, request_key
       FROM cash_outcomes
      WHERE project_id = ? AND kind IN ('CONTACT_RESULT', 'ACCEPTED_PRICE', 'REFUNDED')
      ORDER BY created_at`,
    [projectId],
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.mechanism ?? row.channel ?? 'unspecified';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const measured = (numerator: number, denominator: number): StageInput =>
    denominator > 0 ? { basis: 'MEASURED', value: numerator / denominator } : { basis: 'UNKNOWN' };
  const mechanisms: OutreachMechanism[] = [];
  for (const [mode, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const contacts = group.filter((one) => one.kind === 'CONTACT_RESULT');
    const bounced = contacts.filter((one) => one.value_text === 'CONTACT_UNDELIVERABLE').length;
    const answered = contacts.filter(
      (one) => one.value_text !== 'BUYER_SILENT' && one.value_text !== 'CONTACT_UNDELIVERABLE',
    ).length;
    const accepted = new Map<string, number>();
    for (const one of group) if (one.kind === 'ACCEPTED_PRICE' && one.value_cents !== null) accepted.set(one.opportunity_id, one.value_cents);
    const refunded = new Set(group.filter((one) => one.kind === 'REFUNDED').map((one) => one.opportunity_id));
    const refundedAccepted = [...accepted.keys()].filter((id) => refunded.has(id)).length;
    const price = median([...accepted.values()]);
    mechanisms.push({
      mode,
      label: `${mode} (measured from ${contacts.length} recorded contact result(s))`,
      messagesSent: contacts.length > 0 ? contacts.length : undefined,
      inputs: {
        deliverability: measured(contacts.length - bounced, contacts.length),
        response: measured(answered, contacts.length - bounced),
        close: measured(Math.min(accepted.size, answered), answered),
        fulfillment: measured(accepted.size - refundedAccepted, accepted.size),
      },
      dealValueCents: price === null ? { basis: 'UNKNOWN' } : { basis: 'MEASURED', value: price },
    });
  }
  return { mechanisms: mechanisms.map(modelOutreachFunnel), mix: searchOutreachMix(mechanisms) };
}
