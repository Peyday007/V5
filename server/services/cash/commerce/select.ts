/**
 * Which opening is closest to a real transaction, and what stops it.
 *
 * The question Cash Mode could not answer was not "what is ranked first" — the
 * monetization ledger ranks eight hundred possibilities — but "which one should
 * somebody actually try to sell today, and to whom". That needs three things
 * the ranking does not require: a named buyer, a route that reaches them, and
 * an offer. A demand test with any of the three invented is a test of the
 * invention, so this refuses to select an opening that lacks one and names the
 * missing one instead as the decisive gap.
 *
 * Pure over what it reads, lexicographic, and stored nowhere. There is no
 * score: every criterion below is a fact about rows, and two openings that
 * differ are separated by the first criterion they differ on, which is the
 * reason printed beside the choice.
 */
import { listOpportunities } from '../../../repos/cashPortfolio.ts';
import { cardFactsFor } from '../../../repos/cashCardFacts.ts';
import { cashEngineCard, type EngineCardEntry } from '../engineCard.ts';
import { evidenceCard } from '../card.ts';
import { cashTier, tierRank, type CashTier } from '../tier.ts';
import { liveTestFor, listObligations } from '../../../repos/cashCommerce.ts';
import { LIVE_OBLIGATION_STATES } from '../../../domain/commerce.ts';
import type { CashOpportunity } from '../../../domain/types.ts';
import type { OpportunitySignal } from '../../../domain/types.ts';

/**
 * How directly an opening's own evidence shows somebody wanting to buy.
 *
 * Read from the declared signal, never from prose. A published request from a
 * named buyer is demand; a vendor's price list is evidence about the vendor.
 * This orders the *search* for a first sale and changes no tier: §33's rule that
 * market evidence is not an opportunity stays exactly where it was.
 */
export const DEMAND_DIRECTNESS: Readonly<Record<OpportunitySignal, number>> = Object.freeze({
  ACTIVE_BUYER_DEMAND: 3,
  PAID_TASK_OR_CONTRACT: 3,
  EXPIRING_OPENING: 2,
  RECURRING_OUTSOURCED_WORK: 2,
  SUPPLY_DEMAND_MISMATCH: 1,
  PRICING_OR_INFORMATION_ASYMMETRY: 0,
  RESALABLE_ASSET_OPENING: 0,
});

/** The three things a demand test cannot be formed without, in the order asked. */
export const TEST_INPUTS = [
  { key: 'payer', label: 'who would buy it' },
  { key: 'access', label: 'how to reach them' },
  { key: 'offer', label: 'what is offered' },
] as const;
export type TestInputKey = (typeof TEST_INPUTS)[number]['key'];

export interface TestInputGap {
  key: TestInputKey;
  label: string;
  /** What would answer it, from the card's own task sentence. */
  task: string;
}

export interface OpeningReading {
  opportunityId: string;
  title: string;
  state: CashOpportunity['state'];
  tier: CashTier;
  signal: OpportunitySignal | null;
  directness: number;
  /** The three test inputs, with their values where the card has them. */
  inputs: Record<TestInputKey, string | null>;
  priceCents: number | null;
  missing: TestInputGap[];
  /** A demand test can be formed from recorded facts alone. */
  testable: boolean;
  /** Something is already under way: a live test or a live obligation. */
  inMotion: boolean;
  expiresAt: string | null;
  signalObservedAt: string | null;
  ownerUserId: string;
}

export interface Selection {
  readings: OpeningReading[];
  /** The opening to work on, or null when none can be tested honestly. */
  selected: OpeningReading | null;
  /** Why it came first, naming the criterion that separated it from the next. */
  because: string;
  /** When nothing is selectable, the one fact that would change that, in words. */
  decisiveGap: string | null;
  /** The closest opening, even when it is not testable, so the gap has a subject. */
  closest: OpeningReading | null;
}

const LIVE: CashOpportunity['state'][] = [
  'DISCOVERED',
  'EVIDENCE_CARD',
  'READY',
  'EXECUTING',
  'DELIVERING',
];

function valueOf(entries: Map<string, EngineCardEntry>, key: string): string | null {
  const v = entries.get(key)?.value ?? null;
  return v && v.trim() ? v.trim() : null;
}

export async function readOpening(
  opportunity: CashOpportunity,
): Promise<OpeningReading> {
  const card = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) });
  const short = evidenceCard(opportunity);
  const tier = cashTier({ opportunity, card, readiness: short.readiness }).tier;
  const entries = new Map(card.entries.map((one) => [one.key as string, one]));
  const inputs = {
    payer: valueOf(entries, 'payer'),
    access: valueOf(entries, 'access'),
    offer: valueOf(entries, 'offer'),
  } as Record<TestInputKey, string | null>;
  const missing: TestInputGap[] = TEST_INPUTS.filter((one) => inputs[one.key] === null).map(
    (one) => ({
      key: one.key,
      label: one.label,
      task: entries.get(one.key)?.task ?? `Establish ${one.label}.`,
    }),
  );
  const inMotion =
    (await liveTestFor(opportunity.id)) !== null ||
    (
      await listObligations({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        states: LIVE_OBLIGATION_STATES,
      })
    ).length > 0;
  return {
    opportunityId: opportunity.id,
    title: opportunity.title,
    state: opportunity.state,
    tier,
    signal: opportunity.opportunitySignal,
    directness: opportunity.opportunitySignal
      ? DEMAND_DIRECTNESS[opportunity.opportunitySignal]
      : 0,
    inputs,
    priceCents: opportunity.priceCents,
    missing,
    testable: missing.length === 0,
    inMotion,
    expiresAt: opportunity.expiresAt,
    signalObservedAt: opportunity.signalObservedAt,
    ownerUserId: opportunity.ownerUserId,
  };
}

interface Criterion {
  name: string;
  /** Negative when `a` should come first. */
  compare: (a: OpeningReading, b: OpeningReading) => number;
}

/** Newest first; an undated signal after every dated one. */
function newer(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

/** Soonest first; no expiry after every stated one. */
function sooner(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export const CRITERIA: readonly Criterion[] = Object.freeze([
  {
    name: 'work already under way on it',
    compare: (a, b) => Number(b.inMotion) - Number(a.inMotion),
  },
  {
    name: 'a buyer, a route and an offer are all recorded',
    compare: (a, b) => Number(b.testable) - Number(a.testable),
  },
  { name: 'further qualified', compare: (a, b) => tierRank(b.tier) - tierRank(a.tier) },
  {
    name: 'its evidence shows somebody asking to buy',
    compare: (a, b) => b.directness - a.directness,
  },
  { name: 'fewer of the three test inputs missing', compare: (a, b) => a.missing.length - b.missing.length },
  { name: 'it closes sooner', compare: (a, b) => sooner(a.expiresAt, b.expiresAt) },
  { name: 'its signal is more recent', compare: (a, b) => newer(a.signalObservedAt, b.signalObservedAt) },
  { name: 'id', compare: (a, b) => (a.opportunityId < b.opportunityId ? -1 : 1) },
]);

export function compareOpenings(a: OpeningReading, b: OpeningReading): { order: number; by: string } {
  for (const one of CRITERIA) {
    const order = one.compare(a, b);
    if (order !== 0) return { order, by: one.name };
  }
  return { order: 0, by: 'nothing — they are equal on every recorded fact' };
}

/**
 * The selection for one project, derived now.
 *
 * `now` is taken as an argument so the same rows produce the same answer on a
 * re-run; an opening whose stated expiry has passed is excluded rather than
 * ranked, because it cannot be sold to.
 */
export async function selectOpening(input: {
  projectId: string;
  now: string;
}): Promise<Selection> {
  const live = (await listOpportunities({ projectId: input.projectId, states: LIVE })).filter(
    (one) => one.exhaustedAt === null && (one.expiresAt === null || one.expiresAt > input.now),
  );
  const readings: OpeningReading[] = [];
  for (const opportunity of live) readings.push(await readOpening(opportunity));
  readings.sort((a, b) => compareOpenings(a, b).order);

  const closest = readings[0] ?? null;
  const selected = closest && (closest.testable || closest.inMotion) ? closest : null;
  const next = readings[1] ?? null;

  let because: string;
  if (!closest) because = 'There is no live opening in this sprint.';
  else if (!next) because = 'It is the only live opening.';
  else because = `It comes before "${trim(next.title)}" because ${compareOpenings(closest, next).by}.`;

  let decisiveGap: string | null = null;
  if (!selected) {
    if (!closest) {
      decisiveGap =
        'Discovery has not produced an opening yet, so there is nobody to test an offer on. ' +
        'Discovery continues on its own.';
    } else {
      const first = closest.missing[0]!;
      decisiveGap =
        `No opening has ${TEST_INPUTS.map((one) => one.label).join(', ')} all recorded, so no ` +
        `demand test can be formed without inventing one of them. The closest is ` +
        `"${trim(closest.title)}" (${closest.opportunityId}), missing ${closest.missing
          .map((one) => one.label)
          .join(', ')}. The decisive step is: ${first.task}`;
    }
  }
  return { readings, selected, because, decisiveGap, closest };
}

export function trim(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
