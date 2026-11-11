/**
 * Reusable quantitative knowledge, read from the rows that already hold it.
 *
 * There is no second database of economic facts here. What one opportunity's
 * research established — a published payment term, a direct cost, the money
 * that goes out first — is a card fact resting on a gated claim; what buyers
 * actually did is a measured outcome. This module reads those rows and offers
 * them to `reconstruct` as observations about *their own* populations, with
 * the context that decides whether they transfer:
 *
 *   * the opening the target is about is direct evidence; every other opening
 *     is a comparable, discounted for each way it differs and refused outright
 *     where it differs on a dimension that matters for that quantity (a
 *     payment term measured on a resale is not evidence about a commission);
 *   * observations about other transaction types are broad evidence — enough
 *     for bounds, never for a probability;
 *   * a fact's lineage is its claim's source page, so two openings researched
 *     from one published rate card are one observation, not two;
 *   * money facts become *shares of the price* before they travel, because a
 *     cost of 40 on a 100 sale says nothing about a 2,000 sale and a share of
 *     40% does.
 *
 * What one goal's research established therefore makes the next related
 * opening cheaper to understand, and staleness is a property of each fact's
 * own date, so evidence too old to transfer stops transferring by itself.
 *
 * Reads are cached per project for a few minutes, keyed on the newest fact,
 * so a goal tick that infers fifty quantities reads the rows once.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { claimSources } from '../../repos/research.ts';
import { cashOutcomeLessons, type CashLesson } from '../cash/journey/learning.ts';
import { readMoneyFigures } from '../cash/figures.ts';
import type { CashCardFact, CashOpportunity } from '../../domain/types.ts';
import type { Estimate, Observation, QuantityNode } from '../../domain/quant.ts';
import { reconstruct } from './reconstruct.ts';
import { readRouteMoney, type RouteMoneyVelocity } from './deadline.ts';

/** The opportunity quantities this adapter can infer, and how each is measured. */
export const CASH_QUANTITIES = {
  daysToCash: { label: 'Days from start to usable cash', unit: 'days', kind: 'POSITIVE', fields: ['timeToFirstCash'], material: ['mechanism'], freshDays: 365 },
  costShare: { label: 'Direct cost as a share of the price', unit: 'share', kind: 'RATE', fields: ['directCosts'], material: ['mechanism'], freshDays: 365 },
  capitalShare: { label: 'Money tied up as a share of the price', unit: 'share', kind: 'RATE', fields: ['requiredCapital', 'exposure'], material: ['mechanism'], freshDays: 365 },
  /*
   * The two demand rates (owner, 2026-11-03: "Do not require our own completed
   * sales before making mathematical estimates"). Brain's own outcomes are the
   * best evidence of either, and come first; until there are some, a published
   * rate that research put on an opening's card — a reply rate for reaching
   * buyers of that kind, a close rate for selling them that offer — is a
   * comparable, discounted for every way its population differs.
   */
  respond: { label: 'Share of prospects contacted who reply with interest', unit: 'share', kind: 'RATE', fields: ['conversionRates', 'buyingEvidence'], material: ['mechanism'], freshDays: 1095 },
  close: { label: 'Share of interested buyers who agree', unit: 'share', kind: 'RATE', fields: ['conversionRates', 'buyingEvidence'], material: ['mechanism'], freshDays: 1095 },
} as const;
export type CashQuantity = keyof typeof CASH_QUANTITIES;

export const KNOWLEDGE_TTL_MS = 5 * 60 * 1000;

export interface CashKnowledge {
  projectId: string;
  opportunities: Map<string, CashOpportunity>;
  facts: CashCardFact[];
  lessons: CashLesson[];
  sources: Map<string, { sourceUrl: string | null; sourcePublisher: string | null; sourceDate: string | null }>;
  watermark: string;
  /** Estimates already made for one quantity in one context, reused across openings. */
  estimates: Map<string, Estimate | null>;
  /**
   * What each route's money actually did (MONEY-13-4), read from the
   * append-only ledger and keyed by opportunity: funding split, lead →
   * commitment → funds → usable timing, refunds, receivables, peak working
   * capital and the distinct cash identities. Brain's own measured money is
   * the strongest evidence of when cash lands and how much is tied up, so
   * `observationsFor` offers it to `reconstruct` before any published figure.
   */
  routeMoney: Map<string, RouteMoneyVelocity>;
}

const cache = new Map<string, { at: number; value: CashKnowledge }>();

/**
 * Every route's money, keyed by its opportunity, read through `readRouteMoney`
 * once per currency the project's openings are priced in. A route is held to
 * its own opening's currency: rows in another currency are a different amount
 * of a different thing and are left out rather than summed beside it, and a
 * row whose opportunity the project does not know belongs to no route.
 */
async function routeMoneyByOpportunity(projectId: string, opportunities: Map<string, CashOpportunity>): Promise<Map<string, RouteMoneyVelocity>> {
  const currencies = [...new Set([...opportunities.values()].map((one) => one.currency).filter((one): one is string => !!one))];
  const out = new Map<string, RouteMoneyVelocity>();
  for (const currency of currencies) {
    for (const money of await readRouteMoney({ projectId, currency })) {
      if (opportunities.get(money.routeKey)?.currency === currency) out.set(money.routeKey, money);
    }
  }
  return out;
}

export function forgetKnowledge(): void {
  cache.clear();
}

/** The evidence a project holds, read once and reused while fresh. */
export async function loadCashKnowledge(projectId: string, now = Date.now()): Promise<CashKnowledge> {
  const hit = cache.get(projectId);
  if (hit && now - hit.at < KNOWLEDGE_TTL_MS) return hit.value;
  const [opportunities, facts, lessons] = await Promise.all([listOpportunities({ projectId }), cardFactsForProject(projectId), cashOutcomeLessons(projectId)]);
  const evidence = facts.filter((one) => one.kind === 'EVIDENCE');
  const sources = await claimSources(evidence.map((one) => one.claimId).filter((one): one is string => !!one));
  const watermark = facts.reduce((max, one) => (one.updatedAt > max ? one.updatedAt : max), '');
  const byId = new Map(opportunities.map((one) => [one.id, one]));
  const routeMoney = await routeMoneyByOpportunity(projectId, byId);
  const value: CashKnowledge = { projectId, opportunities: byId, facts: evidence, lessons, sources, watermark, estimates: new Map(), routeMoney };
  cache.set(projectId, { at: now, value });
  return value;
}

export function priceBand(cents: number | null): string {
  if (cents === null || cents <= 0) return 'unpriced';
  return `1e${Math.floor(Math.log10(cents / 100))}`;
}

export function contextOf(opportunity: CashOpportunity): Record<string, string> {
  return {
    opportunity: opportunity.id,
    mechanism: opportunity.mechanism,
    signal: opportunity.opportunitySignal ?? 'unstated',
    industry: (opportunity.industry ?? 'unstated').toLowerCase().slice(0, 40),
    priceBand: priceBand(opportunity.priceCents),
  };
}

/** Days a published path to cash states: one figure, or a range "14–30 days". */
export function readDayRange(text: string): { low: number; high: number } | null {
  const match = /(\d{1,4})(?:\s*(?:-|–|to)\s*(\d{1,4}))?\s*(business day|day|week|month)s?\b/i.exec(text);
  if (!match) return null;
  const unit = match[3]!.toLowerCase();
  const factor = unit === 'week' ? 7 : unit === 'month' ? 30 : 1;
  const low = Number.parseInt(match[1]!, 10) * factor;
  const high = (match[2] ? Number.parseInt(match[2], 10) : Number.parseInt(match[1]!, 10)) * factor;
  if (!(low > 0) || high < low || high > 3650) return null;
  return { low, high };
}

/** The words that say which demand rate a sentence states. */
const RATE_WORDS: Record<'respond' | 'close', RegExp> = {
  respond: /\b(?:repl(?:y|ies|ied)|respon(?:se|ses|d|ded|ding)|positive repl|interested|meetings? booked|booking rate|lead rate|open rate)\b/i,
  close: /\b(?:clos(?:e|ed|ing)(?: rate)?|conver(?:t|ts|ted|sion)|win rate|won|signed|purchase rate|bought|buy(?:s|ing)?)\b/i,
};
const PERCENT = /(\d{1,2}(?:\.\d+)?)\s*%?\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)|(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/gi;

/**
 * A published rate of one kind, read from a researched sentence: a single
 * figure ("a 3.4% reply rate") or a range ("closes 10–25%"). Only a sentence
 * that names the rate's own words counts, so a reply rate is never read as a
 * close rate; a figure over 100% is not a rate. Several figures in the
 * sentences that qualify become one range spanning them — the reader never
 * picks the convenient one.
 */
export function readRate(text: string, kind: 'respond' | 'close'): Observation['value'] | null {
  const words = RATE_WORDS[kind];
  const other = RATE_WORDS[kind === 'respond' ? 'close' : 'respond'];
  const figures: number[] = [];
  for (const sentence of text.split(/(?<=[.;!?])\s+|\n+/)) {
    if (!words.test(sentence)) continue;
    // A sentence naming both rates: each figure belongs to whichever rate's words stand nearest it.
    const both = other.test(sentence);
    const distance = (re: RegExp, at: number, end: number) =>
      Math.min(...[...sentence.matchAll(new RegExp(re.source, 'gi'))].map((m) => (m.index! >= end ? m.index! - end : Math.max(0, at - (m.index! + m[0].length)))));
    for (const match of sentence.matchAll(PERCENT)) {
      if (both && distance(other, match.index!, match.index! + match[0].length) < distance(words, match.index!, match.index! + match[0].length)) continue;
      const values = match[3] !== undefined ? [Number(match[3])] : [Number(match[1]), Number(match[2])];
      for (const v of values) if (Number.isFinite(v) && v > 0 && v <= 100) figures.push(Math.round(v * 1e4) / 1e6);
    }
  }
  if (figures.length === 0) return null;
  const low = Math.min(...figures);
  const high = Math.max(...figures);
  return low === high ? { kind: 'POINT', value: low } : { kind: 'RANGE', low, high };
}

function lineageOf(fact: CashCardFact, knowledge: CashKnowledge): string[] {
  const src = fact.claimId ? knowledge.sources.get(fact.claimId) : null;
  if (src?.sourceUrl) {
    try {
      const url = new URL(src.sourceUrl);
      return [`url:${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`];
    } catch {
      return [`url:${src.sourceUrl}`];
    }
  }
  return [`fact:${fact.id}`];
}

/**
 * What one route's ledger measured for a quantity, or null when its rows do
 * not state it. Every figure is from stated rows: days to cash is the measured
 * stages from commitment (and from the lead, when a row dates it) to usable
 * cash; cost and capital are shares of what was billed, so they travel to an
 * opening at another price. A stage the rows leave unknown makes the figure
 * unknown — it is never filled with zero.
 */
export function ledgerFigure(money: RouteMoneyVelocity, quantity: CashQuantity): { value: number; measures: string } | null {
  const billed = money.identities.GROSS_BILLINGS;
  if (quantity === 'daysToCash') {
    if (money.daysCommitmentToFunds === null || money.daysFundsToUsableCash === null) return null;
    const lead = money.daysLeadToCommitment ?? 0;
    const days = lead + money.daysCommitmentToFunds + money.daysFundsToUsableCash;
    return { value: days, measures: `${money.daysLeadToCommitment === null ? 'commitment' : 'lead'} to usable cash, measured on this Brain's ledger` };
  }
  if (quantity === 'costShare') {
    if (billed === null || billed <= 0 || money.supplierOutlays.length === 0) return null;
    const share = money.supplierOutlays.reduce((t, o) => t + o.amount, 0) / billed;
    return share >= 0 && share <= 1 ? { value: share, measures: "supplier outlays as a share of billings, measured on this Brain's ledger" } : null;
  }
  if (quantity === 'capitalShare') {
    if (billed === null || billed <= 0 || money.peakWorkingCapital === null) return null;
    const share = money.peakWorkingCapital / billed;
    return share >= 0 && share <= 1 ? { value: share, measures: "peak working capital as a share of billings, measured on this Brain's ledger" } : null;
  }
  return null;
}

/** The observations a project holds about one quantity. */
export function observationsFor(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity): Observation[] {
  const spec = CASH_QUANTITIES[quantity];
  const out: Observation[] = [];
  for (const [opportunityId, money] of knowledge.routeMoney ?? []) {
    const opportunity = knowledge.opportunities.get(opportunityId);
    if (!opportunity || opportunity.duplicateOfId) continue;
    const figure = ledgerFigure(money, quantity);
    if (!figure) continue;
    out.push({
      id: `ledger:${opportunityId}:${quantity}`,
      value: { kind: 'POINT', value: figure.value, exact: quantity !== 'daysToCash' },
      context: contextOf(opportunity),
      lineage: [`cash_money_entries:${knowledge.projectId}:${opportunityId}`],
      source: { kind: 'LEDGER_ENTRY', ref: opportunityId, note: money.unknowns.length ? `unknown: ${money.unknowns.slice(0, 3).join('; ')}` : undefined },
      broad: opportunity.mechanism !== target.mechanism,
      measures: `${figure.measures} on "${opportunity.title.slice(0, 60)}"`,
    });
  }
  if (quantity === 'close') {
    for (const lesson of knowledge.lessons) {
      if (lesson.contacts <= 0) continue;
      const same = lesson.mechanism === target.mechanism;
      out.push({
        id: `lesson:${lesson.mechanism ?? '-'}:${lesson.channel ?? '-'}`,
        value: { kind: 'COUNT', successes: lesson.agreements, trials: lesson.contacts },
        context: { mechanism: lesson.mechanism ?? 'unstated', channel: lesson.channel ?? 'unstated' },
        lineage: [`cash_outcomes:${knowledge.projectId}:${lesson.mechanism ?? '-'}:${lesson.channel ?? '-'}`],
        source: { kind: 'OTHER', ref: `cash_outcomes:${lesson.mechanism ?? '-'}`, note: `${lesson.agreements} of ${lesson.contacts} contacts agreed` },
        broad: !same,
        measures: 'agreements per contact, measured on this Brain',
      });
    }
  }
  for (const fact of knowledge.facts) {
    if (!(spec.fields as readonly string[]).includes(fact.field)) continue;
    const opportunity = knowledge.opportunities.get(fact.opportunityId);
    if (!opportunity || opportunity.duplicateOfId) continue;
    let value: Observation['value'] | null = null;
    if (quantity === 'respond' || quantity === 'close') {
      value = readRate(fact.value, quantity);
    } else if (quantity === 'daysToCash') {
      const days = readDayRange(fact.value);
      if (days) value = days.low === days.high ? { kind: 'POINT', value: days.low } : { kind: 'RANGE', low: days.low, high: days.high };
    } else {
      // A money fact travels as a share of the price it was measured against.
      const price = opportunity.priceCents;
      const figures = readMoneyFigures(fact.value, opportunity.currency).filter((one) => !one.perUnit);
      if (price && price > 0 && figures.length > 0) {
        const share = Math.max(...figures.map((one) => one.cents)) / price;
        // Two published amounts about one opening: an exact ratio, not a sampled rate.
        if (share >= 0 && share <= 1) value = { kind: 'POINT', value: share, exact: true };
      }
    }
    if (!value) continue;
    const src = fact.claimId ? knowledge.sources.get(fact.claimId) : null;
    out.push({
      id: `fact:${fact.id}`,
      value,
      context: contextOf(opportunity),
      lineage: lineageOf(fact, knowledge),
      source: fact.claimId ? { kind: 'CLAIM', ref: fact.claimId, note: src?.sourcePublisher ?? undefined } : { kind: 'CARD_FACT', ref: fact.id },
      observedAt: src?.sourceDate && !Number.isNaN(Date.parse(src.sourceDate)) ? new Date(Date.parse(src.sourceDate)).toISOString() : fact.createdAt,
      broad: opportunity.mechanism !== target.mechanism,
      measures: `${fact.field} on "${opportunity.title.slice(0, 60)}"`,
    });
  }
  return out;
}

/** The node `reconstruct` resolves for one quantity of one opening. */
export function nodeFor(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity): QuantityNode {
  const spec = CASH_QUANTITIES[quantity];
  return {
    key: quantity.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
    label: spec.label,
    unit: spec.unit,
    kind: spec.kind,
    min: 0,
    max: spec.kind === 'RATE' ? 1 : 3650,
    context: contextOf(target),
    material: [...spec.material],
    freshDays: spec.freshDays,
    observations: observationsFor(knowledge, quantity, target),
  };
}

/**
 * Infer one quantity of one opening from everything the project holds, or
 * null when nothing at all bears on it (an UNKNOWN with only physical bounds
 * says nothing the existing sweep did not already say).
 */
export function inferCashQuantity(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity, now: Date = new Date()): Estimate | null {
  const node = nodeFor(knowledge, quantity, target);
  const observations = node.observations ?? [];
  if (observations.length === 0) return null;
  // Openings that differ only in identity and hold no evidence of their own
  // get the same answer; it is computed once per context.
  const own = observations.some((one) => one.context.opportunity === target.id);
  const { opportunity: _id, ...shared } = contextOf(target);
  const key = own ? null : `${quantity}|${now.toISOString().slice(0, 10)}|${JSON.stringify(shared)}`;
  if (key && knowledge.estimates.has(key)) return knowledge.estimates.get(key)!;
  const est = reconstruct({ nodes: [node] }, node.key, now).estimates[node.key]!;
  const out = est.tier === 'UNKNOWN' ? null : est;
  if (key) knowledge.estimates.set(key, out);
  return out;
}
