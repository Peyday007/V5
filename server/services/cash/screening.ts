/**
 * Cheap commercial screening: whether an opening has earned an expensive look.
 *
 * Before this, every opening that was merely *eligible* got the full deep dive —
 * a fourteen-question qualification of who pays, what it pays, what it costs,
 * what capital it ties up, how long the money takes and what rules it out — and
 * every signal also raised up to three needs, each its own research mission. A
 * vendor's published rate card, an appraisal of a domain nobody has bought and
 * a gig marketplace paying cents a minute were each researched in full before
 * anything found that there was no customer, or no margin. The research was
 * honest; it was spent in the wrong order.
 *
 * This module reads what Brain already holds — the opening's own kind of
 * evidence, its card, what earlier dives established, and what a person or an
 * earlier reading already rejected — and answers one question per opening:
 *
 *   * `PRIORITIZE` — the decisive facts are already on the row, so a full
 *     qualification is worth its cost now, and it goes first.
 *   * `TARGET` — plausible, and one unanswered question decides whether it is
 *     worth more. Brain asks **that** question and nothing else.
 *   * `PARK` — that question was already asked and nothing published answers
 *     it. Kept, with the exact missing evidence named, and reconsidered the
 *     moment the field is answered. No spending meanwhile.
 *   * `SCREEN_OUT` — a recorded fact disqualifies it: the opening has closed, a
 *     dive established that the thing its kind depends on does not exist, the
 *     economics are established as negative, or this exact mechanism from this
 *     exact source was already rejected and nothing new has arrived since.
 *
 * Three rules make it a screen rather than a filter that loses things.
 *
 * **Unknown is never rejection.** Every `SCREEN_OUT` reason is a row somebody or
 * something wrote — an expiry, an accepted NEGATIVE_EXISTENCE claim, a
 * person's decline, a negative economics verdict. A blank is a reason to *ask*,
 * which is `TARGET`, never a reason to stop.
 *
 * **Nothing is destroyed or moved.** The reading is derived on every pass and
 * stored nowhere except as an append-only `CASH_OPPORTUNITY_SCREENED` event
 * when it changes, for the history and the measurement. No opportunity's state,
 * tier or card is written here. SIGNAL → CANDIDATE → QUALIFIED → READY_TO_TEST
 * mean exactly what they meant.
 *
 * **Revenue alone decides nothing.** No rule reads a price as a reason to look
 * or not to look. A large figure with no payer is `TARGET` on the payer; a small
 * figure with a payer, a cost and a published repeat is `PRIORITIZE`. Whether
 * the margin is good is the economics owner's answer (`tier.ts`), read here as
 * an input and never re-derived — see `economicsOf`.
 *
 * No monetary threshold is invented anywhere in this file. There is no
 * approved figure in this Brain for "too small to bother with", and the honest
 * thing is to have no such rule rather than to make one up; a screen that needs
 * one asks the owner (it does not, today).
 */
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { cashEventsOfKind, recordCashEvent } from '../../repos/cashMode.ts';
import { latestScreens, sourceUrlsFor } from '../../repos/cashScreening.ts';
import { citableClaims, listPasses } from '../../repos/research.ts';
import { listNeeds, listOpportunities } from '../../repos/cashPortfolio.ts';
import { latestMissionForCandidate, missionsForCandidate } from '../../repos/russellMissions.ts';
import { questionKey } from './conditions.ts';
import { cashEngineCard, type EngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { cashTier, type QualificationKey, type TierReading } from './tier.ts';
import { FIELD_BY_LANE, MAX_VALIDATION_ROUNDS, finishedDivePackets } from './validation.ts';
import type { CashCardFact, CashNeed, CashOpportunity, OpportunitySignal } from '../../domain/types.ts';

export const SCREEN_VERDICTS = ['PRIORITIZE', 'TARGET', 'PARK', 'SCREEN_OUT'] as const;
export type ScreenVerdict = (typeof SCREEN_VERDICTS)[number];

/** Every reason a screen can give. Closed, so a report can count them. */
export const SCREEN_REASONS = [
  /** SCREEN_OUT: the opening's own recorded expiry has passed. */
  'OPENING_EXPIRED',
  /** SCREEN_OUT: the economics owner's verdict is negative. */
  'ECONOMICS_NEGATIVE',
  /** SCREEN_OUT: a dive established, with a documented search, that what this kind depends on does not exist. */
  'ESTABLISHED_ABSENT',
  /** SCREEN_OUT: the same mechanism from the same source was rejected, and nothing newer has arrived. */
  'MECHANISM_REJECTED',
  /** PARK: the decisive question was already asked in a targeted round and remains unanswered. */
  'DECISIVE_QUESTION_UNANSWERED',
  /** PRIORITIZE: the economics owner reads it as positive. */
  'ECONOMICS_POSITIVE',
  /** PRIORITIZE: a named buyer's dated request, with the payer already known. */
  'DIRECT_DEMAND_PAYER_KNOWN',
  /** PRIORITIZE: every gate its kind fails on is already answered. */
  'GATES_ANSWERED',
  /** PRIORITIZE: a targeted round answered the question it asked, so the rest is now worth asking. */
  'DECISIVE_QUESTION_PASSED',
  /** TARGET: one question decides whether it deserves more. */
  'DECISIVE_UNKNOWN',
] as const;
export type ScreenReason = (typeof SCREEN_REASONS)[number];

/**
 * What the evidence's *shape* is, from its kind. A description, never a verdict.
 *
 * "Fast cash, scalable income, or neither" is the economics owner's reading
 * once there are figures (`route` on the tier, when present). Before then the
 * only honest answer is what kind of transaction the evidence describes: a
 * one-off paid job, something that repeats, or an asset trade.
 */
export type ScreenShape = 'ONE_OFF' | 'REPEATABLE' | 'ASSET_TRADE' | 'UNKNOWN';

export interface EconomicReading {
  verdict: 'POSITIVE' | 'NEGATIVE' | 'UNKNOWN';
  /** The economics owner's route — fast cash, scalable, unattractive — when it gives one. */
  route: string | null;
}

/**
 * The seam to the economics owner, and deliberately nothing more.
 *
 * Unit economics — what a transaction leaves after its costs, and whether that
 * is fast cash or scale — belong to `tier.ts`, which another workstream is
 * extending to carry `economics` and `route` on its reading. A second model of
 * the same arithmetic here would be the two-readers defect this repository
 * records more than any other. So this reads the owner's fields structurally
 * when they are present and reports `null` when they are not: an absent
 * economics reading is *unknown*, and unknown never screens anything out.
 */
export function economicsOf(tier: TierReading): EconomicReading | null {
  const reading = tier as TierReading & {
    economics?: { verdict?: unknown } | null;
    route?: unknown;
  };
  const verdict = reading.economics?.verdict;
  if (verdict !== 'POSITIVE' && verdict !== 'NEGATIVE' && verdict !== 'UNKNOWN') return null;
  return { verdict, route: typeof reading.route === 'string' ? reading.route : null };
}

/**
 * The order each kind of evidence fails in, cheapest question first.
 *
 * Each list is the kind's own `doesNotEstablish` from `SIGNAL_MEANING`, turned
 * into questions and ordered so an **existence** question (is it still open,
 * does anything actually sell, who pays) comes before an **estimation**
 * question (what it costs, how long it takes). An existence question is one
 * lookup and its answer can end the opening outright; an estimate is several
 * lookups and only adjusts one. That ordering is the whole of "cheapest
 * decisive question first", and it is written down rather than scored.
 */
export const DECISIVE_LADDER: Readonly<Record<OpportunitySignal | 'UNSIGNALLED', readonly QualificationKey[]>> =
  Object.freeze({
    // A named buyer asked: who pays and whether we can reach and qualify for them.
    ACTIVE_BUYER_DEMAND: ['payer', 'access', 'eligibility', 'revenueRange', 'directCosts'],
    // A listing pays: whether we may take it, what it leaves, and whether it repeats.
    PAID_TASK_OR_CONTRACT: ['payer', 'eligibility', 'revenueRange', 'directCosts', 'hours', 'scalingLever'],
    // Two published prices: whether anything sells at the higher one, then whether we can buy the lower.
    PRICING_OR_INFORMATION_ASYMMETRY: ['exitEvidence', 'acquisitionAccess', 'directCosts', 'payer'],
    // It closes: whether it is still open, then who pays.
    EXPIRING_OPENING: ['buyingEvidence', 'payer', 'eligibility', 'revenueRange', 'directCosts'],
    // Demand and supply unconnected: whether either side pays the connector, and whether we can reach supply.
    SUPPLY_DEMAND_MISMATCH: ['payer', 'acquisitionAccess', 'eligibility', 'revenueRange'],
    // An asset with an asking price: whether it actually sells after fees, then whether we can acquire it.
    RESALABLE_ASSET_OPENING: ['exitEvidence', 'acquisitionAccess', 'directCosts', 'payer'],
    // A brief commissioned repeatedly: who pays, what it pays, what it costs, and whether one machine serves the next.
    RECURRING_OUTSOURCED_WORK: ['payer', 'revenueRange', 'directCosts', 'scalingLever'],
    UNSIGNALLED: ['payer', 'buyingEvidence', 'revenueRange'],
  });

/** Why each rung is the one worth asking, in a sentence a person reads. */
const WHY_DECISIVE: Readonly<Partial<Record<QualificationKey, string>>> = Object.freeze({
  payer: 'nothing yet says who would pay us, and without a payer nothing else on the card matters',
  access: 'whether a supplier can reach the buyer at all decides whether the rest is worth knowing',
  buyingEvidence: 'whether the request is still open decides whether there is anything to qualify',
  eligibility: 'a supplier rule that excludes us ends it however good the rest is',
  revenueRange: 'what comparable work is published at decides whether there is a margin to look for',
  directCosts: 'what delivering it costs decides whether the price leaves anything',
  hours: 'how much human time it takes decides whether it is a business or a wage',
  scalingLever: 'a single paid job is employment; whether it repeats decides whether it is worth building for',
  acquisitionAccess: 'whether the cheaper side can actually be bought now decides whether the spread exists',
  exitEvidence:
    'a published or asking price is not a sale; whether anything actually sells at the higher figure ' +
    'after fees decides whether there is anything here at all',
});

/** The fields whose arrival is new evidence about the mechanism itself. */
const DECISIVE_FIELDS: ReadonlySet<string> = new Set(
  Object.values(DECISIVE_LADDER).flatMap((one) => [...one]),
);

/** A rejection that applies to every later opening with the same key. */
export interface MechanismRejection {
  opportunityId: string;
  key: string;
  at: string;
  why: 'DECLINED' | 'ARCHIVED' | 'ECONOMICS_NEGATIVE' | 'ESTABLISHED_ABSENT';
}

/** One targeted round: what it asked, and when it was asked. */
export interface TargetedRound {
  question: string;
  round: number;
  at: string;
}

export interface ScreenInput {
  opportunity: CashOpportunity;
  card: EngineCard;
  tier: TierReading;
  facts: readonly CashCardFact[];
  /** The rejection key for this opening; null when it has no source to key on. */
  key: string | null;
  /** Fields an accepted NEGATIVE_EXISTENCE claim from one of its dives established as absent. */
  establishedAbsent: readonly string[];
  /**
   * Those claims' ids. A card entry resting on one is an absence written into
   * an answer's place, and is read as unanswered: "no sale was found" in the
   * exit-evidence field is not exit evidence.
   */
  negativeClaimIds: readonly string[];
  /** Rejections of *other* openings that share a key with this one. */
  rejections: readonly MechanismRejection[];
  /** Targeted rounds already run for it, settled or not. */
  targetedRounds: readonly TargetedRound[];
  /**
   * How many of its finished dives actually ran a research pass. A round the
   * stall backstop closed researched nothing, so it asked nothing either.
   */
  researchedDives: number;
  /**
   * Card fields already asked *narrowly* — by a targeted round that ran, or by
   * a need whose research finished — and so not worth asking the same way twice.
   */
  askedNarrowly: readonly string[];
  /** Whether a deep dive could still be started for it (`MAX_VALIDATION_ROUNDS`). */
  diveRoundsLeft: boolean;
  /** The card fields the needs path can ask about, one narrow question each. */
  needAskable: readonly string[];
  now: string;
}

export interface Screen {
  verdict: ScreenVerdict;
  reason: ScreenReason;
  /** One sentence, composed from rows. */
  because: string;
  /** The question Brain asks next for a TARGET, or that is outstanding for a PARK. */
  decisive: QualificationKey | null;
  /**
   * Who asks it, so it is asked exactly once.
   *
   * A card field is one narrow need; anything else is a one-question deep
   * dive. Both asking the same field is the same question bought twice — the
   * first version of this module did exactly that, and the duplicate was
   * refused downstream as "already researched" only by luck of compilation.
   * `FULL_DIVE` is a PRIORITIZE: the whole qualification.
   */
  askBy: 'NEED' | 'DIVE' | 'FULL_DIVE' | null;
  shape: ScreenShape;
  economics: EconomicReading | null;
  /** A rejection that was set aside because newer evidence arrived. */
  reconsidered: { rejectedOpportunityId: string; evidenceField: string } | null;
  /** What makes two readings the same reading, so a pass records only a change. */
  fingerprint: string;
}

function shapeOf(signal: OpportunitySignal | null): ScreenShape {
  switch (signal) {
    case 'ACTIVE_BUYER_DEMAND':
    case 'PAID_TASK_OR_CONTRACT':
    case 'EXPIRING_OPENING':
      return 'ONE_OFF';
    case 'RECURRING_OUTSOURCED_WORK':
    case 'SUPPLY_DEMAND_MISMATCH':
      return 'REPEATABLE';
    case 'PRICING_OR_INFORMATION_ASYMMETRY':
    case 'RESALABLE_ASSET_OPENING':
      return 'ASSET_TRADE';
    default:
      return 'UNKNOWN';
  }
}

/** The kinds whose evidence is a named buyer's own dated request. */
const DIRECT_DEMAND: ReadonlySet<OpportunitySignal> = new Set([
  'ACTIVE_BUYER_DEMAND',
  'PAID_TASK_OR_CONTRACT',
  'EXPIRING_OPENING',
]);

/**
 * The screen, as a pure decision over rows.
 *
 * Pure and total, so "why was this not researched" is answerable from a
 * recorded input rather than from a re-run against a database that has moved —
 * the same split `services/dispatch/router.ts` draws.
 */
export function screenOpportunity(input: ScreenInput): Screen {
  const { opportunity, card, tier } = input;
  const signal = opportunity.opportunitySignal ?? null;
  const shape = shapeOf(signal);
  const economics = economicsOf(tier);
  const answered = (key: string): boolean => {
    const entry = card.entries.find((one) => one.key === key);
    if (!entry?.value) return false;
    return !(entry.claimId && input.negativeClaimIds.includes(entry.claimId));
  };
  const ladder = DECISIVE_LADDER[signal ?? 'UNSIGNALLED'];
  const decisive = ladder.find((key) => !answered(key)) ?? null;

  const make = (
    verdict: ScreenVerdict,
    reason: ScreenReason,
    because: string,
    extra: Partial<Pick<Screen, 'decisive' | 'reconsidered'>> = {},
  ): Screen => {
    const chosen = extra.decisive === undefined ? decisive : extra.decisive;
    const askBy: Screen['askBy'] =
      verdict === 'PRIORITIZE'
        ? 'FULL_DIVE'
        : verdict === 'TARGET' && chosen
          ? input.needAskable.includes(chosen)
            ? 'NEED'
            : 'DIVE'
          : null;
    return {
      verdict,
      reason,
      because,
      decisive: verdict === 'TARGET' || verdict === 'PARK' ? chosen : null,
      askBy,
      shape,
      economics,
      reconsidered: extra.reconsidered ?? null,
      fingerprint: [verdict, reason, verdict === 'TARGET' || verdict === 'PARK' ? (chosen ?? '') : ''].join(
        '|',
      ),
    };
  };

  // 1. The opening itself says it has closed.
  if (opportunity.expiresAt && opportunity.expiresAt <= input.now) {
    return make(
      'SCREEN_OUT',
      'OPENING_EXPIRED',
      `The opening's own recorded expiry (${opportunity.expiresAt}) has passed, so there is ` +
        'nothing left to qualify.',
    );
  }

  // 2. The economics owner has already read the figures and they do not work.
  if (economics?.verdict === 'NEGATIVE') {
    return make(
      'SCREEN_OUT',
      'ECONOMICS_NEGATIVE',
      'The published costs are at least the published price, so what it leaves is nothing or ' +
        'less; researching the rest would not change that.',
    );
  }

  // 3. A dive established, by documented search, that the thing this kind
  //    depends on is not there — and nothing has since answered it.
  const required = ladder.filter((key) => key === 'exitEvidence' || key === 'acquisitionAccess' || key === 'payer');
  const absent = required.find((key) => input.establishedAbsent.includes(key) && !answered(key));
  if (absent) {
    return make(
      'SCREEN_OUT',
      'ESTABLISHED_ABSENT',
      `An earlier qualification established, from a documented search, that the ${labelOf(absent)} ` +
        'does not exist — and this kind of opening depends on it.',
    );
  }

  // 4. The same mechanism from the same source was already rejected, unless
  //    materially new evidence has arrived since.
  let reconsidered: Screen['reconsidered'] = null;
  if (input.key) {
    const matching = input.rejections
      .filter((one) => one.key === input.key && one.opportunityId !== opportunity.id)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    const newest = matching[0];
    if (newest) {
      const fresh = input.facts.find(
        (fact) =>
          (fact.kind === 'EVIDENCE' || fact.kind === 'PERSON') &&
          DECISIVE_FIELDS.has(fact.field) &&
          fact.createdAt > newest.at,
      );
      if (!fresh) {
        return make(
          'SCREEN_OUT',
          'MECHANISM_REJECTED',
          `The same kind of opening from the same source was rejected on ${newest.at} ` +
            `(${newest.why.toLowerCase().replace('_', ' ')}, ${newest.opportunityId}), and no new ` +
            'evidence about it has arrived since. New evidence on any decisive question reopens it.',
        );
      }
      reconsidered = { rejectedOpportunityId: newest.opportunityId, evidenceField: fresh.field };
    }
  }

  // 5. Positive economics from the owner: worth the full qualification first.
  if (economics?.verdict === 'POSITIVE') {
    return make(
      'PRIORITIZE',
      'ECONOMICS_POSITIVE',
      'The published price exceeds the published costs, so the rest of the qualification is ' +
        'worth its cost now.',
      { reconsidered },
    );
  }

  // 6. Every gate this kind fails on is answered.
  if (!decisive) {
    return make(
      'PRIORITIZE',
      'GATES_ANSWERED',
      'Every question this kind of opening usually fails on is already answered, so the full ' +
        'qualification is worth its cost.',
      { reconsidered },
    );
  }

  // 7. A targeted round asked one question and it was answered: the cheap
  //    gate passed, so the full qualification has earned its cost.
  const inFlight =
    opportunity.validationState === 'PENDING' || opportunity.validationState === 'RUNNING';
  const passed = input.targetedRounds.find((one) => answered(one.question));
  if (passed && !inFlight) {
    return make(
      'PRIORITIZE',
      'DECISIVE_QUESTION_PASSED',
      `The one question asked first — ${labelOf(passed.question)} — was answered in round ` +
        `${passed.round}, so a full qualification is now worth its cost.`,
      { reconsidered },
    );
  }

  // 8. The decisive question was already asked and nothing answered it.
  //
  //    Asked narrowly — a targeted round, or a need's own research — is a
  //    question that failed on its own terms, and asking it the same way again
  //    is the repeated strategy §15 refuses. Asked broadly — inside a full
  //    qualification — still leaves the narrow question as a different
  //    strategy, so it parks only when no narrow question is left to ask: the
  //    dives are spent and the field is not one a need can ask.
  if (!inFlight) {
    const narrowly = input.askedNarrowly.includes(decisive);
    const broadly = input.researchedDives > input.targetedRounds.length;
    const askable = input.needAskable.includes(decisive) || input.diveRoundsLeft;
    if (narrowly || (broadly && !askable)) {
      const how = narrowly
        ? 'Brain asked it narrowly'
        : `${input.researchedDives} full qualification${input.researchedDives === 1 ? '' : 's'} asked it`;
      return make(
        'PARK',
        'DECISIVE_QUESTION_UNANSWERED',
        `The question this opening turns on — ${labelOf(decisive)} — is still unanswered: ${how}, ` +
          'and nothing published answered it. Kept with that gap named, and reconsidered the ' +
          'moment it is answered.',
        { reconsidered },
      );
    }
  }

  // 9. A named buyer's own dated request with the payer already known.
  if (signal && DIRECT_DEMAND.has(signal) && answered('payer') && opportunity.signalObservedAt) {
    return make(
      'PRIORITIZE',
      'DIRECT_DEMAND_PAYER_KNOWN',
      `A named buyer published this on ${opportunity.signalObservedAt} and the payer is known, so ` +
        'a full qualification is worth its cost. The economics are not yet established and it is ' +
        'not treated as profitable.',
      { reconsidered },
    );
  }

  // 10. Otherwise: ask the one question that decides whether it deserves more.
  return make(
    'TARGET',
    'DECISIVE_UNKNOWN',
    `Brain asks one question first — ${labelOf(decisive)} — because ` +
      `${WHY_DECISIVE[decisive] ?? 'it is the first gate this kind of opening fails on'}.`,
    { reconsidered },
  );
}

function labelOf(key: string): string {
  switch (key) {
    case 'payer':
      return 'payer';
    case 'access':
      return 'route to the buyer';
    case 'buyingEvidence':
      return 'whether the request is still open';
    case 'eligibility':
      return 'supplier eligibility';
    case 'revenueRange':
      return 'published price';
    case 'directCosts':
      return 'direct cost';
    case 'hours':
      return 'human time';
    case 'scalingLever':
      return 'evidence that it repeats';
    case 'acquisitionAccess':
      return 'current acquisition route';
    case 'exitEvidence':
      return 'evidence of actual sales after fees';
    default:
      return key;
  }
}

/**
 * The narrow question a `TARGET` round asks, instead of the full qualification.
 *
 * The phrases are `validationQuestion`'s own, so a targeted round passes the
 * same envelope screen the full one was tuned to pass, and nothing is invented
 * about the opening: its words are the published signal.
 */
const TARGET_ASK: Readonly<Partial<Record<QualificationKey, string>>> = Object.freeze({
  payer: 'who actually pays for this and how a supplier reaches them',
  access: 'how a supplier reaches whoever pays for this, and whether that route is open to a new supplier',
  buyingEvidence: 'whether this request is still open, and when it was last published or updated',
  eligibility: 'what rule decides whether a supplier like this one is eligible at all',
  revenueRange: 'what comparable work is published at',
  directCosts: 'what delivering it would cost',
  hours: 'how much human time comparable work is published as taking',
  scalingLever:
    'whether the same work is published as commissioned repeatedly, so that what serves one ' +
    'customer would serve the next',
  acquisitionAccess: 'what is published about acquiring the thing itself now and from whom',
  exitEvidence:
    'whether anything actually sells at the higher figure after fees rather than merely being ' +
    'listed or appraised at it',
});

export function targetedQuestion(opportunity: CashOpportunity, key: QualificationKey): string {
  const signal = (opportunity.buyingSignal ?? opportunity.title).replace(/\s+/g, ' ').trim();
  const observed = opportunity.signalObservedAt
    ? ` It was published or observed on ${opportunity.signalObservedAt}.`
    : '';
  const source = opportunity.source ? ` The source is ${opportunity.source}.` : '';
  return (
    `Before qualifying this specific opening in full: "${signal}".${source}${observed} ` +
    `Establish only ${TARGET_ASK[key] ?? `the ${labelOf(key)}`}, because that one answer decides ` +
    'whether the opening deserves a full qualification. If nothing published answers it, say so ' +
    'plainly, and where a documented search finds that it does not exist, record that search. ' +
    'A price somebody else charges, an asking price and an appraisal are evidence about a market ' +
    'and are not evidence that anybody would pay us.'
  );
}

/**
 * The key two openings share when they are the same mechanism from the same place.
 *
 * Narrow on purpose: the kind of evidence and the host of the source it came
 * from. Two transcription marketplaces are two keys; the same marketplace's rate
 * card arriving again is one. A wider key would need somebody to read two
 * sentences and decide they mean the same business, which is a judgement this
 * module does not make — and a wrong match would screen out a good opening on
 * the strength of a different, bad one.
 */
export function rejectionKey(opportunity: CashOpportunity, sourceUrl: string | null): string | null {
  const kind = opportunity.opportunitySignal ?? opportunity.mechanism;
  const host = hostOf(sourceUrl) ?? normalisedSource(opportunity.source);
  return host ? `${kind}|${host}` : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function normalisedSource(source: string | null): string | null {
  if (!source) return null;
  const host = hostOf(source);
  if (host) return host;
  const flat = source.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return flat || null;
}

// ---------------------------------------------------------------------------
// Gathering the rows, once per pass
// ---------------------------------------------------------------------------

const SCREENABLE_STATES = new Set(['DISCOVERED', 'EVIDENCE_CARD']);

export interface PortfolioScreen {
  opportunity: CashOpportunity;
  tier: TierReading;
  screen: Screen;
}

/**
 * Screen every live opening in a project.
 *
 * Openings already executing, delivered, declined or archived are not screened:
 * their commercial questions are closed, and a declined or archived one is an
 * *input* here — a rejection — rather than something to decide about.
 */
export async function screenPortfolio(projectId: string, now = new Date().toISOString()): Promise<PortfolioScreen[]> {
  const all = await listOpportunities({ projectId });
  const urls = await sourceUrlsFor(
    all.map((one) => one.sourceClaimId).filter((one): one is string => Boolean(one)),
  );
  const keyOf = (one: CashOpportunity): string | null =>
    rejectionKey(one, one.sourceClaimId ? (urls.get(one.sourceClaimId) ?? null) : null);

  // Read each opening's rows once, one opening at a time: this runs on every
  // operating pass, and a fan-out of every opening's reads at once is exactly
  // what a shared pooler punishes.
  const needs = await listNeeds({ projectId });
  const gathered = [];
  for (const opportunity of all) {
    const facts = await cardFactsFor(opportunity.id);
    const card = cashEngineCard({ opportunity, facts });
    const tier = cashTier({ opportunity, card, readiness: evidenceCard(opportunity).readiness });
    const history = await diveHistory(opportunity);
    const askedByNeeds = await fieldsAskedByNeeds(
      opportunity.id,
      needs.filter((one) => one.opportunityId === opportunity.id),
    );
    gathered.push({
      opportunity,
      facts,
      card,
      tier,
      key: keyOf(opportunity),
      establishedAbsent: history.establishedAbsent,
      negativeClaimIds: history.negativeClaimIds,
      researchedDives: history.researchedDives,
      targetedRounds: history.targetedRounds,
      askedNarrowly: [...new Set([...history.askedByTargets, ...askedByNeeds])],
      diveRoundsLeft: opportunity.validationRounds < MAX_VALIDATION_ROUNDS,
      needAskable: evidenceCard(opportunity).fields.map((one) => one.key),
    });
  }

  // Rejections a person made, and rejections a screen made on a recorded fact.
  // A MECHANISM_REJECTED screen is deliberately not itself a rejection: one
  // rejection must not propagate through every later copy of itself.
  const rejections: MechanismRejection[] = [];
  for (const one of gathered) {
    if (!one.key) continue;
    if (one.opportunity.state === 'DECLINED' || one.opportunity.state === 'ARCHIVED') {
      rejections.push({
        opportunityId: one.opportunity.id,
        key: one.key,
        at: one.opportunity.updatedAt,
        why: one.opportunity.state === 'DECLINED' ? 'DECLINED' : 'ARCHIVED',
      });
    }
  }
  const primary = new Map<string, Screen>();
  for (const one of gathered) {
    if (!SCREENABLE_STATES.has(one.opportunity.state)) continue;
    const screen = screenOpportunity({ ...one, rejections: [], now });
    primary.set(one.opportunity.id, screen);
    if (one.key && (screen.reason === 'ECONOMICS_NEGATIVE' || screen.reason === 'ESTABLISHED_ABSENT')) {
      rejections.push({
        opportunityId: one.opportunity.id,
        key: one.key,
        at: one.opportunity.validationSettledAt ?? one.opportunity.updatedAt,
        why: screen.reason,
      });
    }
  }

  const out: PortfolioScreen[] = [];
  for (const one of gathered) {
    if (!SCREENABLE_STATES.has(one.opportunity.state)) continue;
    const screen = screenOpportunity({ ...one, rejections, now });
    out.push({ opportunity: one.opportunity, tier: one.tier, screen });
  }
  return out;
}

/**
 * What its finished dives established: which card fields do not exist, and how many there were.
 *
 * An accepted NEGATIVE_EXISTENCE claim is §14's standard for a negative: a
 * documented search of the places it would be. Its lane says which field —
 * `FIELD_BY_LANE`, a row rather than a reading of the claim's prose.
 */
async function diveHistory(opportunity: CashOpportunity): Promise<{
  establishedAbsent: string[];
  negativeClaimIds: string[];
  researchedDives: number;
  targetedRounds: TargetedRound[];
  askedByTargets: string[];
}> {
  const empty = {
    establishedAbsent: [],
    negativeClaimIds: [],
    researchedDives: 0,
    targetedRounds: [],
    askedByTargets: [],
  };
  if (opportunity.validationRounds === 0 && !opportunity.validationOrchestrationId) return empty;
  const absent = new Set<string>();
  const negatives: string[] = [];
  const researched = new Set<string>();
  for (const packet of await finishedDivePackets(opportunity)) {
    if ((await listPasses(packet)).some((pass) => pass.status === 'COMPLETE')) researched.add(packet);
    for (const claim of await citableClaims(packet)) {
      if (claim.claimType !== 'NEGATIVE_EXISTENCE') continue;
      negatives.push(claim.id);
      const field = claim.evidenceLane ? FIELD_BY_LANE[claim.evidenceLane] : undefined;
      if (field) absent.add(field);
    }
  }
  const targetedRounds: TargetedRound[] = [];
  const askedByTargets: string[] = [];
  for (const event of await cashEventsOfKind(opportunity.id, 'CASH_VALIDATION_STARTED')) {
    const question = event.detail['targeted'];
    const round = event.detail['round'];
    if (typeof question !== 'string') continue;
    targetedRounds.push({ question, round: typeof round === 'number' ? round : 0, at: event.createdAt });
    // Asked only if its round actually researched something.
    const candidateId = event.detail['candidateId'];
    if (typeof candidateId !== 'string') continue;
    for (const mission of await missionsForCandidate(candidateId)) {
      if (mission.orchestrationId && researched.has(mission.orchestrationId)) askedByTargets.push(question);
    }
  }
  return {
    establishedAbsent: [...absent],
    negativeClaimIds: negatives,
    researchedDives: researched.size,
    targetedRounds,
    askedByTargets,
  };
}

/**
 * The card fields a need already asked about this opening and got an ending for.
 *
 * A need is one narrow question, and a need whose research finished without
 * filling its field asked it and found nothing. Matched by rebuilding the key,
 * as `reconcileDiscoverableGaps` does, never by parsing it apart.
 */
async function fieldsAskedByNeeds(opportunityId: string, needs: readonly CashNeed[]): Promise<string[]> {
  const out: string[] = [];
  const asked = needs.filter((one) => one.candidateId && one.requestKey?.startsWith('question:'));
  if (asked.length === 0) return out;
  for (const field of ALL_FIELD_KEYS) {
    const key = questionKey(opportunityId, field);
    for (const need of asked) {
      if (need.requestKey !== key) continue;
      const mission = await latestMissionForCandidate(need.candidateId!);
      if (mission && FINISHED_MISSIONS.has(mission.state)) out.push(field);
    }
  }
  return out;
}

const FINISHED_MISSIONS: ReadonlySet<string> = new Set(['DONE', 'FAILED', 'CANCELLED']);
const ALL_FIELD_KEYS: readonly string[] = [...new Set(Object.values(DECISIVE_LADDER).flatMap((one) => [...one]))];

/**
 * Record each opening's screen when it changes, for the history and the measurement.
 *
 * Append-only and idempotent by the fingerprint: a pass that reads the same
 * screen as the last recorded one writes nothing, so a tick, a retry and a
 * restart produce one row per change rather than one per pass.
 */
export async function recordScreens(projectId: string, screens?: PortfolioScreen[]): Promise<number> {
  const readings = screens ?? (await screenPortfolio(projectId));
  const last = await latestScreens(projectId);
  let written = 0;
  for (const { opportunity, screen } of readings) {
    if (last.get(opportunity.id)?.fingerprint === screen.fingerprint) continue;
    await recordCashEvent({
      projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_OPPORTUNITY_SCREENED',
      actorRef: 'BRAIN',
      summary: screen.because,
      detail: {
        fingerprint: screen.fingerprint,
        verdict: screen.verdict,
        reason: screen.reason,
        decisive: screen.decisive,
        shape: screen.shape,
        economics: screen.economics?.verdict ?? null,
        reconsidered: screen.reconsidered,
      },
    });
    written += 1;
  }
  return written;
}

/** Which verdicts spend nothing on an opening. */
export function screenWithholds(screen: Screen): boolean {
  return screen.verdict === 'SCREEN_OUT' || screen.verdict === 'PARK';
}

/** Strongest claim on capacity first: full qualifications, then targeted questions. */
export function screenRank(screen: Screen): number {
  if (screen.verdict === 'PRIORITIZE') return screen.reason === 'ECONOMICS_POSITIVE' ? 0 : 1;
  if (screen.verdict === 'TARGET') return 2;
  return 3;
}
