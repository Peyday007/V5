/**
 * Historical market data, acquired from the research Brain already holds
 * (CAUSAL-14-7, S-0136..S-0141).
 *
 * For an established market — subcontracted cleaning, construction, logistics,
 * distribution, manufacturing, a regulated-industry partnership, or anything
 * else; no list here is a whitelist — the specification asks Brain to acquire
 * and use the history that already exists: how many transactions the market
 * makes, what was actually paid and the spread around it, and how many bids or
 * offers were won. A probability that ignores that record and reads only a
 * sample size somebody typed is a calculation with invented inputs.
 *
 * There is no second store of economic facts. The archive is the gated claims
 * research attached to openings (`cash_card_facts` → `research` claims, each
 * with its source page) and this Brain's own measured outcomes
 * (`cash_outcomes` lessons). `loadCashKnowledge` reads both once per project;
 * this module reads every sentence of that evidence for three kinds of record:
 *
 *   * a bid/win record — "won 14 of 60 bids", "a 23% win rate across 180
 *     tenders" — successes and trials, the only kind that is a sample of the
 *     behavioural rate a plan's probability rests on;
 *   * a transaction count — "1,240 contracts awarded" — the market's depth;
 *   * actual prices and spreads — amounts paid, a markup or margin share.
 *
 * Each record carries its lineage (its claim's source page), so one published
 * report cited on three openings is one record, never three, and the sample it
 * contributes is counted once. A record from another mechanism is broad: it
 * informs bounds and research, never the sample behind a probability. What the
 * archive does not hold is returned as a named research need — an unknown is a
 * task, never a favourable assumption (invariant 39).
 */
import type { CashCardFact, CashOpportunity } from '../../domain/types.ts';
import { readMoneyFigures } from '../cash/figures.ts';
import { raiseNeed } from '../cash/needs.ts';
import { setNeedCandidate } from '../../repos/cashPortfolio.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import type { CashKnowledge } from './knowledge.ts';

/** One historical record, with where it came from. */
export interface HistoryRecord<T> {
  value: T;
  /** The upstream data it rests on; records sharing a lineage are one record. */
  lineage: string;
  /** The claim or outcome row it was read from, so a reader can check it. */
  source: { kind: 'CLAIM' | 'CARD_FACT' | 'OUTCOME'; ref: string };
  /** The opening whose research holds it. Null for this Brain's own outcomes. */
  opportunityId: string | null;
  /** True when measured on a different mechanism: bounds and research only. */
  broad: boolean;
  /** The sentence (or outcome summary) it was read from. */
  quote: string;
}

export interface MarketHistory {
  opportunityId: string;
  bidWin: Array<HistoryRecord<{ wins: number; bids: number }>>;
  transactions: Array<HistoryRecord<{ count: number }>>;
  prices: Array<HistoryRecord<{ cents: number }>>;
  spreads: Array<HistoryRecord<{ share: number }>>;
  /** Pooled wins over bids from same-mechanism records, one per lineage. Null when none. */
  winRate: { wins: number; bids: number; rate: number } | null;
  /** Transactions the market made, summed over distinct same-mechanism lineages. Null when none. */
  marketTransactions: number | null;
  /** Actual prices paid (major units): low, median, high. Null when none. */
  priceBand: { low: number; median: number; high: number; observations: number } | null;
  /** Spread or margin shares observed: low, high. Null when none. */
  spreadBand: { low: number; high: number; observations: number } | null;
  /**
   * Independent real outcomes behind the behavioural rate: bids across distinct
   * same-mechanism lineages. Undefined when the archive holds no bid/win
   * record, which is never read as a large sample.
   */
  sampleSize: number | undefined;
  /** Distinct lineages acquired, across every kind. */
  sources: string[];
  /** The historical data a decision still needs and the archive does not hold. */
  researchNeeds: string[];
  /** The same needs, typed, so each can be handed to research under a stable key. */
  gaps: HistoryGap[];
}

/** A kind of historical record the archive does not yet hold for a market. */
export type HistoryKind = 'BID_WIN' | 'TRANSACTIONS' | 'PRICES';

export interface HistoryGap {
  kind: HistoryKind;
  /** What to establish, phrased as a question research can answer from published or recorded sources. */
  question: string;
}

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+|\d+`;
const toInt = (text: string): number => Number.parseInt(text.replace(/,/g, ''), 10);
const BID_NOUN = String.raw`(?:bids?|tenders?|proposals?|quotes?|rfps?|rfqs?|pitches|pitch|offers?|submissions?|solicitations?|applications?)`;
const TRANSACTION_NOUN = String.raw`(?:transactions?|contracts?(?:\s+(?:awarded|signed|let))?|awards?|deals?|sales|orders?|jobs|placements?|closings?|purchases?|shipments?|loads)`;

/** Sentences of a researched passage. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|\n+/).map((one) => one.trim()).filter(Boolean);
}

/**
 * Bid/win records in a passage: "won 14 of 60 bids", "14 wins out of 60
 * tenders", "a 23% win rate across 180 bids", "60 bids, 14 awarded". A rate
 * with its count of bids becomes whole wins, rounded, so it is a sample and
 * not a point; a rate without a stated count is not a sample and is not read.
 */
export function readBidWin(text: string): Array<{ wins: number; bids: number; quote: string }> {
  const out: Array<{ wins: number; bids: number; quote: string }> = [];
  const patterns: Array<{ re: RegExp; read: (m: RegExpMatchArray) => { wins: number; bids: number } | null }> = [
    {
      re: new RegExp(String.raw`\b(?:won|win|wins|awarded|secured|landed|converted)\s+(${NUMBER})\s+(?:out\s+)?of\s+(?:the\s+)?(${NUMBER})\s+${BID_NOUN}`, 'gi'),
      read: (m) => ({ wins: toInt(m[1]!), bids: toInt(m[2]!) }),
    },
    {
      re: new RegExp(String.raw`\b(${NUMBER})\s+(?:wins?|awards?|won)\s+(?:out\s+)?(?:of|from|on|in)\s+(${NUMBER})\s+${BID_NOUN}`, 'gi'),
      read: (m) => ({ wins: toInt(m[1]!), bids: toInt(m[2]!) }),
    },
    {
      re: new RegExp(String.raw`(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\s+(?:win|award|hit|success|conversion)\s+rate\s+(?:across|on|over|from|for|in)\s+(${NUMBER})\s+${BID_NOUN}`, 'gi'),
      read: (m) => {
        const rate = Number(m[1]) / 100;
        const bids = toInt(m[2]!);
        return rate >= 0 && rate <= 1 ? { wins: Math.round(rate * bids), bids } : null;
      },
    },
    {
      re: new RegExp(String.raw`\b(${NUMBER})\s+${BID_NOUN}(?:\s+\w+){0,3}?,?\s+(?:of\s+which\s+)?(${NUMBER})\s+(?:were\s+)?(?:won|awarded|accepted|successful)`, 'gi'),
      read: (m) => ({ wins: toInt(m[2]!), bids: toInt(m[1]!) }),
    },
  ];
  for (const sentence of sentencesOf(text)) {
    const seen = new Set<string>();
    for (const { re, read } of patterns) {
      for (const match of sentence.matchAll(re)) {
        const got = read(match);
        if (!got || !(got.bids > 0) || got.wins < 0 || got.wins > got.bids || got.bids > 10_000_000) continue;
        const key = `${got.wins}/${got.bids}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...got, quote: sentence.slice(0, 300) });
      }
    }
  }
  return out;
}

/** Transaction counts in a passage: "1,240 contracts awarded", "about 3,000 transactions a year". */
export function readTransactionCounts(text: string): Array<{ count: number; quote: string }> {
  const out: Array<{ count: number; quote: string }> = [];
  const re = new RegExp(String.raw`\b(${NUMBER})\s+(?:\w+\s+){0,2}?${TRANSACTION_NOUN}\b`, 'gi');
  for (const sentence of sentencesOf(text)) {
    // A sentence that is a bid/win record states a sample, not the market's depth.
    if (readBidWin(sentence).length > 0) continue;
    for (const match of sentence.matchAll(re)) {
      const before = sentence.slice(Math.max(0, match.index! - 2), match.index!);
      if (/[$£€]\s?$/.test(before)) continue; // "$300 contracts" is a price, not a count
      const count = toInt(match[1]!);
      // A year is a date, not a count.
      if (!(count > 0) || (count >= 1900 && count <= 2100 && !match[1]!.includes(','))) continue;
      out.push({ count, quote: sentence.slice(0, 300) });
    }
  }
  return out;
}

const PRICE_WORDS = /\b(?:paid|pays|price[sd]?|pricing|sold|sells?|charged?|charges|billed|rates?|fees?|awarded|contract value|average (?:ticket|order|deal|job)|per (?:job|contract|order|load|unit|visit|month|hour))\b/i;
const SPREAD_WORDS = /\b(?:spread|margin|markup|mark-up|commission|take rate|gross profit)\b/i;

/** Actual prices in a passage: money figures in sentences that say something was paid or priced. */
export function readPrices(text: string, currency: string): Array<{ cents: number; quote: string }> {
  const out: Array<{ cents: number; quote: string }> = [];
  for (const sentence of sentencesOf(text)) {
    if (!PRICE_WORDS.test(sentence) || SPREAD_WORDS.test(sentence)) continue;
    for (const figure of readMoneyFigures(sentence, currency)) {
      if (figure.cents > 0) out.push({ cents: figure.cents, quote: sentence.slice(0, 300) });
    }
  }
  return out;
}

/** Spread, margin or markup shares in a passage: "a 12% spread", "margins of 15–20%". */
export function readSpreads(text: string): Array<{ share: number; quote: string }> {
  const out: Array<{ share: number; quote: string }> = [];
  const re = /(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)?\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)|(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/gi;
  for (const sentence of sentencesOf(text)) {
    if (!SPREAD_WORDS.test(sentence)) continue;
    for (const match of sentence.matchAll(re)) {
      const values = match[3] !== undefined ? [Number(match[3])] : [Number(match[1]), Number(match[2])];
      for (const v of values) if (Number.isFinite(v) && v > 0 && v < 100) out.push({ share: v / 100, quote: sentence.slice(0, 300) });
    }
  }
  return out;
}

function lineageOfFact(fact: CashCardFact, knowledge: CashKnowledge): string {
  const src = fact.claimId ? knowledge.sources.get(fact.claimId) : null;
  if (src?.sourceUrl) {
    try {
      const url = new URL(src.sourceUrl);
      return `url:${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return `url:${src.sourceUrl}`;
    }
  }
  return `fact:${fact.id}`;
}

/** Whether evidence about `other` may describe `target`'s market at all, and whether only broadly. */
function relation(target: CashOpportunity, other: CashOpportunity): 'SAME' | 'BROAD' {
  if (other.mechanism !== target.mechanism) return 'BROAD';
  const a = (target.industry ?? '').trim().toLowerCase();
  const b = (other.industry ?? '').trim().toLowerCase();
  // An industry neither states does not differ; one that both state and differ does.
  return a && b && a !== b ? 'BROAD' : 'SAME';
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Acquire the historical record of one opening's market from everything the
 * project's research and outcomes hold. Every evidence fact is read, not only
 * the fields a card names, because a bid record researched as "buying
 * evidence" or a price researched as "competition" is history all the same.
 */
export function acquireMarketHistory(knowledge: CashKnowledge, target: CashOpportunity): MarketHistory {
  const history: MarketHistory = {
    opportunityId: target.id,
    bidWin: [],
    transactions: [],
    prices: [],
    spreads: [],
    winRate: null,
    marketTransactions: null,
    priceBand: null,
    spreadBand: null,
    sampleSize: undefined,
    sources: [],
    researchNeeds: [],
    gaps: [],
  };
  for (const fact of knowledge.facts) {
    if (fact.kind !== 'EVIDENCE') continue;
    const opportunity = knowledge.opportunities.get(fact.opportunityId);
    if (!opportunity || opportunity.duplicateOfId) continue;
    const broad = relation(target, opportunity) === 'BROAD';
    const lineage = lineageOfFact(fact, knowledge);
    const source = fact.claimId ? { kind: 'CLAIM' as const, ref: fact.claimId } : { kind: 'CARD_FACT' as const, ref: fact.id };
    const base = { lineage, source, opportunityId: opportunity.id, broad };
    for (const one of readBidWin(fact.value)) history.bidWin.push({ ...base, value: { wins: one.wins, bids: one.bids }, quote: one.quote });
    for (const one of readTransactionCounts(fact.value)) history.transactions.push({ ...base, value: { count: one.count }, quote: one.quote });
    for (const one of readPrices(fact.value, opportunity.currency)) {
      // A price travels only within one currency; another currency is not converted by guess.
      if (opportunity.currency.toUpperCase() !== target.currency.toUpperCase()) continue;
      history.prices.push({ ...base, value: { cents: one.cents }, quote: one.quote });
    }
    for (const one of readSpreads(fact.value)) history.spreads.push({ ...base, value: { share: one.share }, quote: one.quote });
  }
  // This Brain's own outcomes are bid/win history measured first-hand.
  for (const lesson of knowledge.lessons) {
    if (lesson.contacts <= 0) continue;
    const broad = lesson.mechanism !== target.mechanism;
    const lineage = `cash_outcomes:${knowledge.projectId}:${lesson.mechanism ?? '-'}:${lesson.channel ?? '-'}`;
    history.bidWin.push({
      value: { wins: lesson.agreements, bids: lesson.contacts },
      lineage,
      source: { kind: 'OUTCOME', ref: lineage },
      opportunityId: null,
      broad,
      quote: `${lesson.agreements} of ${lesson.contacts} offers agreed (${lesson.channel ?? 'unstated channel'})`,
    });
    if (lesson.completed > 0) {
      history.transactions.push({ value: { count: lesson.completed }, lineage, source: { kind: 'OUTCOME', ref: lineage }, opportunityId: null, broad, quote: `${lesson.completed} completed on this Brain` });
    }
  }

  // One record per lineage per kind: the largest-sample reading of a page stands for it.
  const perLineage = <T>(records: Array<HistoryRecord<T>>, size: (value: T) => number): Array<HistoryRecord<T>> => {
    const best = new Map<string, HistoryRecord<T>>();
    for (const one of records.filter((r) => !r.broad)) {
      const held = best.get(one.lineage);
      if (!held || size(one.value) > size(held.value)) best.set(one.lineage, one);
    }
    return [...best.values()];
  };
  const bidWin = perLineage(history.bidWin, (v) => v.bids);
  if (bidWin.length > 0) {
    const wins = bidWin.reduce((s, one) => s + one.value.wins, 0);
    const bids = bidWin.reduce((s, one) => s + one.value.bids, 0);
    history.winRate = { wins, bids, rate: wins / bids };
    history.sampleSize = bids;
  }
  const transactions = perLineage(history.transactions, (v) => v.count);
  if (transactions.length > 0) history.marketTransactions = transactions.reduce((s, one) => s + one.value.count, 0);
  const priceSeen = new Set<string>();
  const prices = history.prices.filter((one) => !one.broad).filter((one) => {
    const key = `${one.lineage}|${one.value.cents}`;
    if (priceSeen.has(key)) return false;
    priceSeen.add(key);
    return true;
  });
  if (prices.length > 0) {
    const majors = prices.map((one) => one.value.cents / 100);
    history.priceBand = { low: Math.min(...majors), median: median(majors), high: Math.max(...majors), observations: prices.length };
  }
  const spreads = history.spreads.filter((one) => !one.broad).map((one) => one.value.share);
  if (spreads.length > 0) history.spreadBand = { low: Math.min(...spreads), high: Math.max(...spreads), observations: spreads.length };
  history.sources = [...new Set([...history.bidWin, ...history.transactions, ...history.prices, ...history.spreads].map((one) => one.lineage))].sort();

  const market = [target.industry, target.mechanism].filter(Boolean).join(' / ') || 'this market';
  const gap = (kind: HistoryKind, need: string, question: string): void => {
    history.researchNeeds.push(need);
    history.gaps.push({ kind, question });
  };
  if (!history.winRate) {
    gap('BID_WIN', `bid/win history for ${market}: how many bids or offers were made and how many were won`,
      `How many bids, tenders, quotes or offers were made in ${market}, and how many of them were won? State both counts (e.g. "won 14 of 60 bids") and the source.`);
  }
  if (history.marketTransactions === null) {
    gap('TRANSACTIONS', `transaction counts for ${market}: how many deals the market actually makes in a period`,
      `How many transactions, contracts or orders does ${market} actually make in a stated period? Give the count, the period and the source.`);
  }
  if (!history.priceBand && !history.spreadBand) {
    gap('PRICES', `actual prices paid and spreads in ${market}, not asking prices`,
      `What prices were actually paid in ${market} (not asking or list prices), and what spread, margin or markup sits between buyer and supplier? Give the figures and the source.`);
  }
  return history;
}

/** One history gap once it has been handed to research. */
export interface RequestedHistory extends HistoryGap {
  needId: string;
  candidateId: string | null;
}

/**
 * Actively acquire what the archive lacks (CAUSAL-14-7): each missing kind of
 * historical record becomes a research need on the review a person already
 * reads (`raiseNeed`, under a key stable per opening and kind, so asking again
 * returns the open row rather than adding one), and its question is captured
 * as an idea through `createCandidate`, the entrance research already runs
 * through — archive first, judgment, and the standing grant deciding whether
 * anything is spent. No second queue and no spend here (§10.3). When research
 * lands, its gated claims are evidence facts on the opening, and the next
 * `acquireMarketHistory` reads them; the need's completion condition says so.
 */
export async function requestMarketHistory(input: {
  projectId: string;
  actorRef: string;
  opportunity: CashOpportunity;
  history: MarketHistory;
}): Promise<{ requested: RequestedHistory[]; refused: Array<{ kind: HistoryKind; reason: string }> }> {
  const { projectId, actorRef, opportunity, history } = input;
  const requested: RequestedHistory[] = [];
  const refused: Array<{ kind: HistoryKind; reason: string }> = [];
  const label = opportunity.title || opportunity.id;
  for (const gap of history.gaps) {
    const raised = await raiseNeed({
      projectId,
      opportunityId: opportunity.id,
      actorRef,
      blockedAction: `Calibrate the probability for "${label}" from its market's historical record`.slice(0, 500),
      whyItMatters:
        'A probability computed from a sample nobody measured is a calculation with invented inputs. ' +
        'The market already has a record of this; until Brain holds it, the figure stays uncalibrated.',
      recommendedPath: gap.question,
      setupEffort: 'One bounded look at published or recorded sources.',
      nextStep: gap.question,
      completionCondition: `The opening holds a sourced evidence fact that the market-history reader parses as ${gap.kind === 'BID_WIN' ? 'a bid/win record (wins of bids)' : gap.kind === 'TRANSACTIONS' ? 'a transaction count' : 'an actual price paid or a spread'}.`,
      requestKey: `market-history:${opportunity.id}:${gap.kind}`,
    });
    if (!raised.ok) {
      refused.push({ kind: gap.kind, reason: raised.reason });
      continue;
    }
    let candidateId = raised.value.candidateId;
    if (!candidateId) {
      const candidate = await createCandidate({
        projectId,
        visibility: 'SHARED',
        title: `Market history: ${gap.kind.toLowerCase().replace('_', '/')} for ${label}`.slice(0, 200),
        statement: `For the opening "${label}", establish from published or recorded sources: ${gap.question}`,
      });
      // Another request may have pointed the need first; its idea stands and this one is not attached.
      candidateId = (await setNeedCandidate(raised.value.id, candidate.id)) ? candidate.id : null;
    }
    requested.push({ ...gap, needId: raised.value.id, candidateId });
  }
  return { requested, refused };
}

/** The evidence an activity carries from its acquired history, for the portfolio engine. */
export function historyEvidence(history: MarketHistory): {
  sampleSize?: number;
  winRate?: { wins: number; bids: number };
  marketTransactions?: number;
  priceObservations: number;
  sources: string[];
  researchNeeds: string[];
} {
  return {
    ...(history.sampleSize !== undefined ? { sampleSize: history.sampleSize } : {}),
    ...(history.winRate ? { winRate: { wins: history.winRate.wins, bids: history.winRate.bids } } : {}),
    ...(history.marketTransactions !== null ? { marketTransactions: history.marketTransactions } : {}),
    priceObservations: history.priceBand?.observations ?? 0,
    sources: history.sources,
    researchNeeds: history.researchNeeds,
  };
}
