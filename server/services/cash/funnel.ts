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
  return lines;
}

/* ------------------------------------------------------------------ */
/* COM-13-3 — the outreach funnel, for any channel                      */
/* ------------------------------------------------------------------ */

/**
 * The owner's one-million-email figure is a thought experiment about
 * distribution leverage. Nothing here treats it as a reachable prospect count:
 * every stage below is a count of rows or `null` (unknown, never zero), each
 * stage is bounded by the one before it, and a message sent is never read as a
 * prospect reached, a buyer, a sale or revenue.
 *
 * A mechanism is grouped by what its rows say (`mechanism` and
 * `reachable_channel`), not by a list of approved categories: a channel Brain
 * has never seen is modelled exactly as one it has.
 */
export const OUTREACH_STAGES = [
  'permission',
  'uniqueProspects',
  'deliverable',
  'throughput',
  'replied',
  'qualified',
  'closed',
  'settled',
  'repeat',
] as const;

export interface OutreachRange {
  low: number | null;
  high: number | null;
}

export interface OutreachEvidence {
  projectId: string;
  /** A standing CONTACT_BUYER grant exists. Unknown (null) when no authority row says either way. */
  permissionGranted: boolean | null;
  /** Provider-measured sending capacity per day, shared with other campaigns. Null when never measured. */
  capacityPerDay: number | null;
}

export interface OutreachMechanism {
  key: string;
  mechanism: string;
  channel: string | null;
  /** Deal-size reading from agreements: VOLUME (many small), HIGH_TICKET (few large) or UNCLASSIFIED. */
  mode: 'VOLUME' | 'HIGH_TICKET' | 'UNCLASSIFIED';
  permission: boolean | null;
  openings: number;
  messagesSent: number | null;
  uniqueProspects: number | null;
  undeliverable: number | null;
  replied: number | null;
  qualified: number | null;
  agreed: number | null;
  settled: number | null;
  repeat: number | null;
  settledCents: number | null;
  capacityPerDay: number | null;
  /** Stages with no row behind them. They are named, never filled with a guess. */
  unknownStages: string[];
}

export interface RankedOutreach {
  key: string;
  mode: string;
  mechanism: string;
  channel: string | null;
  messagesSent: number | null;
  reachedProspects: OutreachRange;
  buyers: OutreachRange;
  replyRate: OutreachRange;
  closeRate: OutreachRange;
  /** Settled revenue per prospect reached, in minor units; null until something settled. */
  centsPerProspect: number | null;
  unknownStages: string[];
}

/** Rate bounds with a 95% Wilson interval; null when nothing was observed. */
export function rateRange(successes: number | null, trials: number | null): OutreachRange {
  if (successes === null || trials === null || trials <= 0) return { low: null, high: null };
  const z = 1.96;
  const p = Math.min(1, successes / trials);
  const denom = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export async function outreachEvidenceFor(projectId: string): Promise<OutreachEvidence> {
  const db = getDb();
  const grants = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_actions WHERE project_id = ? AND action = 'CONTACT_BUYER'`,
    [projectId],
  );
  let capacityPerDay: number | null = null;
  try {
    const { instantlyCapacity } = await import('./providers/instantly.ts');
    capacityPerDay = (await instantlyCapacity())?.perDay ?? null;
  } catch {
    capacityPerDay = null;
  }
  return { projectId, permissionGranted: Number(grants?.n ?? 0) > 0 ? true : null, capacityPerDay };
}

export async function mechanismsFromRows(projectId: string, evidence?: unknown): Promise<OutreachMechanism[]> {
  const db = getDb();
  const ev = (evidence ?? null) as OutreachEvidence | null;
  const opps = await db.all<{ id: string; mechanism: string; reachable_channel: string | null }>(
    `SELECT id, mechanism, reachable_channel FROM cash_opportunities
      WHERE project_id = ? AND duplicate_of_id IS NULL`,
    [projectId],
  );
  const groupOf = new Map<string, { mechanism: string; channel: string | null; ids: Set<string> }>();
  const keyOfOpp = new Map<string, string>();
  for (const o of opps) {
    const key = `${o.mechanism}|${o.reachable_channel ?? ''}`;
    const g = groupOf.get(key) ?? { mechanism: o.mechanism, channel: o.reachable_channel, ids: new Set<string>() };
    g.ids.add(o.id);
    groupOf.set(key, g);
    keyOfOpp.set(o.id, key);
  }
  const contacts = await db.all<{ opportunity_id: string; reference: string | null }>(
    `SELECT opportunity_id, reference FROM cash_actions WHERE project_id = ? AND action = 'CONTACT_BUYER'`,
    [projectId],
  );
  const obs = await db.all<{ opportunity_id: string; kind: string }>(
    `SELECT opportunity_id, kind FROM cash_observations WHERE project_id = ?`,
    [projectId],
  );
  const agreements = await db.all<{ opportunity_id: string; amount_cents: number; state: string }>(
    `SELECT opportunity_id, amount_cents, state FROM cash_agreements WHERE project_id = ?`,
    [projectId],
  );
  const money = await db.all<{ opportunity_id: string | null; kind: string; amount_cents: number }>(
    `SELECT opportunity_id, kind, amount_cents FROM cash_money_entries
      WHERE project_id = ? AND kind IN ('SETTLEMENT','CUSTOMER_PAYMENT')`,
    [projectId],
  );

  const out: OutreachMechanism[] = [];
  for (const [key, g] of groupOf) {
    const inGroup = (id: string | null): boolean => id !== null && g.ids.has(id);
    const mine = contacts.filter((c) => inGroup(c.opportunity_id));
    const sent = mine.length;
    const prospects = new Set(mine.map((c) => c.opportunity_id)).size;
    const o = obs.filter((x) => inGroup(x.opportunity_id));
    const repliedSet = new Set(o.filter((x) => x.kind === 'BUYER_REPLIED').map((x) => x.opportunity_id));
    const decided = new Set(
      o.filter((x) => ['BUYER_ACCEPTED', 'BUYER_COUNTERED', 'BUYER_DECLINED'].includes(x.kind)).map((x) => x.opportunity_id),
    );
    const agreed = agreements.filter((a) => inGroup(a.opportunity_id) && a.state === 'AGREED');
    const settledRows = money.filter((m) => inGroup(m.opportunity_id));
    const settledPieces = new Set(settledRows.map((m) => m.opportunity_id));
    const paymentsByPiece = new Map<string, number>();
    for (const m of money.filter((x) => inGroup(x.opportunity_id) && x.kind === 'CUSTOMER_PAYMENT')) {
      paymentsByPiece.set(m.opportunity_id!, (paymentsByPiece.get(m.opportunity_id!) ?? 0) + 1);
    }
    const undeliverable = o.filter((x) => x.kind === 'CONTACT_UNDELIVERABLE').length;
    const amounts = agreed.map((a) => a.amount_cents);
    const mid = median(amounts);
    const mode: OutreachMechanism['mode'] =
      mid === null || sent === 0 ? 'UNCLASSIFIED' : sent >= 20 && mid < 100_000 ? 'VOLUME' : mid >= 100_000 ? 'HIGH_TICKET' : 'UNCLASSIFIED';
    const known = (n: number, have: boolean): number | null => (have ? n : null);
    const m: OutreachMechanism = {
      key,
      mechanism: g.mechanism,
      channel: g.channel,
      mode,
      permission: ev?.permissionGranted ?? null,
      openings: g.ids.size,
      messagesSent: known(sent, sent > 0),
      uniqueProspects: known(prospects, sent > 0),
      undeliverable: known(undeliverable, sent > 0),
      replied: known(repliedSet.size, sent > 0),
      qualified: known(decided.size, sent > 0),
      agreed: known(new Set(agreed.map((a) => a.opportunity_id)).size, sent > 0),
      settled: known(settledPieces.size, sent > 0),
      repeat: known([...paymentsByPiece.values()].filter((n) => n >= 2).length, sent > 0),
      settledCents: settledRows.length > 0 ? settledRows.filter((x) => x.kind === 'SETTLEMENT').reduce((s, x) => s + Number(x.amount_cents), 0) : null,
      capacityPerDay: ev?.capacityPerDay ?? null,
      unknownStages: [],
    };
    if (m.permission === null) m.unknownStages.push('permission');
    if (m.capacityPerDay === null) m.unknownStages.push('throughput');
    if (m.messagesSent === null) m.unknownStages.push('uniqueProspects', 'deliverable', 'replied', 'qualified', 'closed', 'settled', 'repeat');
    out.push(m);
  }
  return out;
}

/**
 * Rank mechanisms by settled revenue per prospect reached. A mechanism with no
 * messages sent has no funnel to rank and is returned unranked with its unknown
 * stages named. Buyers are bounded by prospects reached, which are bounded by
 * messages sent — never the other way round.
 */
export function searchOutreachMix(mechanisms: readonly OutreachMechanism[]): { ranked: RankedOutreach[]; unranked: OutreachMechanism[] } {
  const ranked: RankedOutreach[] = [];
  const unranked: OutreachMechanism[] = [];
  for (const m of mechanisms) {
    if (m.messagesSent === null || m.uniqueProspects === null) {
      unranked.push(m);
      continue;
    }
    const reached = Math.max(0, m.uniqueProspects - (m.undeliverable ?? 0));
    const buyersObserved = Math.min(m.agreed ?? 0, reached);
    ranked.push({
      key: m.key,
      mode: m.mode,
      mechanism: m.mechanism,
      channel: m.channel,
      messagesSent: m.messagesSent,
      reachedProspects: { low: reached, high: reached },
      buyers: { low: Math.min(m.settled ?? 0, buyersObserved), high: buyersObserved },
      replyRate: rateRange(m.replied, reached),
      closeRate: rateRange(buyersObserved, m.qualified !== null && m.qualified > 0 ? m.qualified : null),
      centsPerProspect: m.settledCents !== null && reached > 0 ? m.settledCents / reached : null,
      unknownStages: m.unknownStages,
    });
  }
  ranked.sort((a, b) => (b.centsPerProspect ?? -1) - (a.centsPerProspect ?? -1));
  return { ranked, unranked };
}
