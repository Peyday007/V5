/**
 * The Cash Engine Card: what a person needs before deciding, and where each
 * answer came from.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `evidenceCard` answers twelve questions about an opening and is a pure
 * function of the opportunity row, which is what makes "is this ready to test"
 * decidable. It is not a decision brief. A person deciding whether to spend a
 * week on something needs the rest: how many hours, what it costs, what capital
 * it needs before money arrives, whether selling or calling is involved, what
 * the first steps are, what the bottleneck is, what would disqualify it, how it
 * scales, how confident any of this is, and what is still unknown.
 *
 * The production audit measured the gap precisely. Four filed reports answered
 * *who is asking* and *what they published*, and answered none of the fourteen
 * commercial questions — not badly, but not at all, because nothing ever asked
 * them.
 *
 * ---------------------------------------------------------------------------
 * Fact, estimate, assumption, unknown
 * ---------------------------------------------------------------------------
 *
 * Every field says which of those it is, and the distinction is a column rather
 * than a tone of voice:
 *
 *   FACT        a gated research claim. It resolves to a URL, a publisher and a
 *               date, exactly as a report's sentence does.
 *   ESTIMATE    Brain's own reading, carrying its basis, its assumptions and
 *               what would change it. Never shown the way a fact is shown.
 *   DECISION    a person's answer. Nothing automatic replaces one.
 *   UNKNOWN     nobody has answered it. It stays unknown: a blank is never a
 *               zero and is never an estimate, which is invariant 39 at the one
 *               place where being wrong costs somebody money.
 *
 * It composes rather than duplicates. The twelve original fields keep their
 * readiness meaning untouched — `readyToTest` is not consulted here and nothing
 * here can change it — and the new fields are read from `cash_card_facts`,
 * which already carried exactly the four-way distinction this needs. Where one
 * of the twelve has no column value, a recorded fact answers it instead: the
 * column still wins, but an answer Brain holds must not be displayed as an
 * unknown.
 */
import { evidenceCard, type CardFieldKey, type EvidenceCard } from './card.ts';
import type { CashCardFact, CashOpportunity } from '../../domain/types.ts';

/**
 * The questions a decision actually turns on, beyond the twelve on the card.
 *
 * Each one is a `cash_card_facts.field`, which is how it carries its own
 * provenance. The order is the order a person reads them in: what it is worth,
 * what it costs, what it takes, what could stop it, and what Brain makes of it.
 */
export const ENGINE_FIELDS = [
  /*
   * The capture thesis, first, because everything below it is only worth
   * asking once there is one. It is the single question that separates market
   * evidence from a piece of work — see `tier.ts` — and Brain proposes it from
   * what is already on the card rather than researching it, because "how would
   * *we* be paid" is a reading of a payer, an offer and a route rather than
   * something anybody publishes.
   */
  'captureMechanism',
  'revenueRange',
  'directCosts',
  'requiredCapital',
  'timeToFirstCash',
  'hours',
  'laborNeeds',
  /*
   * The five the production audit found were never asked at all.
   *
   * Four are facts about the world and are lanes on the validation profile.
   * The fifth, the fulfilment model, is a reading of the other four and is
   * proposed rather than researched.
   */
  'fulfilmentModel',
  'phoneDependency',
  'eligibility',
  'acquisitionAccess',
  'exitEvidence',
  'firstSteps',
  'bottleneck',
  'disqualifiers',
  'scalingLever',
  'confidence',
  'recommendation',
] as const;
export type EngineFieldKey = (typeof ENGINE_FIELDS)[number];

export type CardEntryKind = 'FACT' | 'ESTIMATE' | 'DECISION' | 'UNKNOWN';

export interface EngineCardEntry {
  key: CardFieldKey | EngineFieldKey;
  label: string;
  /** The answer, or null when nobody has answered it. */
  value: string | null;
  kind: CardEntryKind;
  /** What would answer it. A property of the question, not of today's blank. */
  task: string;
  /** EVIDENCE only: the gated claim this resolves to. */
  claimId: string | null;
  /** ESTIMATE only, and all three are required of one. */
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
}

export interface EngineCard {
  opportunityId: string;
  entries: EngineCardEntry[];
  /** Everything still unanswered, in the order it is asked. */
  unknowns: (CardFieldKey | EngineFieldKey)[];
  /**
   * Whether the deep dive has run, and what it concluded.
   *
   * Null means it has not started, which is what every opening is born as.
   */
  validationState: CashOpportunity['validationState'];
  /**
   * Brain's own recommendation, when it has formed one. Never a fact.
   */
  recommendation: EngineCardEntry | null;
}

const LABELS: Record<EngineFieldKey, { label: string; task: string }> = {
  revenueRange: {
    label: 'Realistic revenue or price range',
    task:
      'Find what comparable work is published at — a figure or a range, each with its source ' +
      'and date. A price is read from a source and never produced.',
  },
  directCosts: {
    label: 'Direct costs',
    task:
      'Find published prices for what delivering this needs: tools, data, subcontracted ' +
      'labour, platform fees. A cost nobody publishes is unknown, not zero.',
  },
  captureMechanism: {
    label: 'How we would be paid',
    task:
      'Name who would pay us, what we would supply them, and through what route — from the ' +
      'payer, the offer and the access already on this card. A published price somebody else ' +
      'charges is not an answer to this, and neither is an asking price, an appraisal or a ' +
      'marketplace that exists.',
  },
  requiredCapital: {
    label: 'Required capital',
    task: 'State the maximum cash out before any of it comes back.',
  },
  fulfilmentModel: {
    label: 'How the work actually gets done',
    task:
      'Say which of these it is — done by AI, done by software, delegated, subcontracted or ' +
      'manual — what human work is left after that, and who performs it. Judged from the ' +
      'published delivery requirements and hours rather than from how the work sounds.',
  },
  phoneDependency: {
    label: 'Whether calling is required',
    task:
      'Say whether the published route to the buyer requires a phone call, and if it does, ' +
      'what the offshore-calling or non-phone alternative would be. Nobody here is going to ' +
      'make the calls, so a phone-dependent model with no route is a disqualifier rather than ' +
      'a detail.',
  },
  eligibility: {
    label: 'Eligibility and permission',
    task:
      'Find what published rule decides whether a supplier like this one may take it at all — ' +
      'a licence, a registration, a platform term, a procurement qualification, a residency or ' +
      'insurance condition. A documented absence of one is a real finding.',
  },
  acquisitionAccess: {
    label: 'How we would acquire it',
    task:
      'Find what is published about obtaining the thing itself now: from whom, at what price, ' +
      'on what terms, and what registration, membership or licence standing in the way. A ' +
      'spread nobody can buy into is a fact about a market rather than an opening.',
  },
  exitEvidence: {
    label: 'Evidence it actually sells',
    task:
      'Find published evidence of completed sales at the higher figure — sold prices, ' +
      'sell-through, settled auctions — and what is left after the platform fees. An asking ' +
      'price, a listing and an appraisal are none of those.',
  },
  timeToFirstCash: {
    label: 'Time to first cash',
    task:
      'Find the published payment terms, payout schedule or decision date, and say when money ' +
      'would actually be usable rather than when the work is done.',
  },
  hours: {
    label: 'Expected human hours',
    task:
      'Find what comparable work is published as taking, across more than one example. One ' +
      'listing’s estimate is that listing’s estimate.',
  },
  laborNeeds: {
    label: 'Selling, calling, fulfilment or offshore help',
    task:
      'Say which of those this actually requires, from what the request and the platform ' +
      'publish rather than from how the work sounds.',
  },
  firstSteps: {
    label: 'Exact first steps',
    task: 'The specific things somebody would do first, in order, each one doable this week.',
  },
  bottleneck: {
    label: 'Bottleneck',
    task: 'The one thing that decides whether this happens at all.',
  },
  disqualifiers: {
    label: 'Disqualifiers',
    task:
      'Any published fact that would rule this out outright — closed, awarded, restricted, or ' +
      'requiring something nobody here has. A documented absence of one is a real finding.',
  },
  scalingLever: {
    label: 'Scaling lever',
    task:
      'If this works once, what would make the second one cheaper or faster — and would the ' +
      'same machinery serve a different customer, or is each one a job done by hand?',
  },
  confidence: {
    label: 'Confidence',
    task: 'How much of this rests on evidence, and how much on reading between the lines.',
  },
  recommendation: {
    label: 'Recommendation',
    task: 'Do this, or do not, and why — with what would change the answer.',
  },
};

/** A stored answer, or null when it is blank — a blank is never an answer. */
function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function kindOf(fact: CashCardFact | undefined, value: string | null): CardEntryKind {
  if (value === null) return 'UNKNOWN';
  if (!fact) return 'FACT';
  if (fact.kind === 'EVIDENCE') return 'FACT';
  if (fact.kind === 'RECOMMENDATION') return 'ESTIMATE';
  return 'DECISION';
}

/**
 * The whole card for one opening.
 *
 * `facts` is every `cash_card_facts` row for this opportunity, passed in rather
 * than read here so the caller can fetch a project's worth in one query — the
 * card is composed for every piece on the page.
 *
 * Deterministic and total over its inputs: the same opportunity and the same
 * facts produce the same card. Nothing here writes, and nothing here invents a
 * value — a field with no column value and no fact is `UNKNOWN`, which is the
 * answer rather than the absence of one.
 */
export function cashEngineCard(input: {
  opportunity: CashOpportunity;
  facts: CashCardFact[];
}): EngineCard {
  const byField = new Map(input.facts.map((fact) => [fact.field, fact]));
  const base: EvidenceCard = evidenceCard(input.opportunity);

  const entries: EngineCardEntry[] = base.fields.map((field) => {
    const fact = byField.get(field.key);
    /*
     * The column first, and a recorded answer where the column is blank.
     *
     * `evidenceCard` reads the opportunity row, which is what makes readiness
     * decidable, and that stays exactly as it is — the column wins wherever it
     * has a value and nothing here writes one. But a `cash_card_facts` row is
     * an answer too: `applyValidationAnswers` fills `payer` from a gated claim
     * without touching the column, so reading the column alone reported a
     * question as unanswered while its evidence sat beside it with a claim id
     * on it. An answer nothing displays is the same defect as a mechanism
     * nothing calls, and here it reads as *we do not know* about something
     * Brain does know.
     */
    const value = field.value ?? text(fact?.value);
    return {
      key: field.key,
      label: field.label,
      value,
      kind: kindOf(fact, value),
      task: field.task,
      claimId: fact?.claimId ?? null,
      basis: fact?.basis ?? null,
      assumptions: fact?.assumptions ?? null,
      uncertainty: fact?.uncertainty ?? null,
    };
  });

  for (const key of ENGINE_FIELDS) {
    const fact = byField.get(key);
    const value = text(fact?.value);
    entries.push({
      key,
      label: LABELS[key].label,
      value,
      kind: kindOf(fact, value),
      task: LABELS[key].task,
      claimId: fact?.claimId ?? null,
      basis: fact?.basis ?? null,
      assumptions: fact?.assumptions ?? null,
      uncertainty: fact?.uncertainty ?? null,
    });
  }

  return {
    opportunityId: input.opportunity.id,
    entries,
    unknowns: entries.filter((entry) => entry.value === null).map((entry) => entry.key),
    validationState: input.opportunity.validationState,
    recommendation: entries.find((entry) => entry.key === 'recommendation' && entry.value) ?? null,
  };
}

/**
 * Derived economics, with its inputs named and its arithmetic shown.
 *
 * Refuses rather than estimates, in both directions that matter. A margin needs
 * a price *and* a bounded cost, and with either missing it is withheld naming
 * which — a margin against an unknown cost fails in the direction that makes a
 * piece look worth doing, which is the error nobody notices because it looks
 * like ambition. And every input is named by the claim it came from, so a
 * reader can check the number rather than believe it.
 */
export interface DerivedFigure {
  key: string;
  label: string;
  /** The formula, in words, so the arithmetic is visible rather than asserted. */
  formula: string;
  /** The card fields it was computed from, and their claims where they have one. */
  inputs: { field: string; value: string; claimId: string | null }[];
  value: string | null;
  /** Why it is null, when it is. Never an estimate standing in for a refusal. */
  withheld: string | null;
}

export function derivedEconomics(card: EngineCard): DerivedFigure[] {
  const entry = (key: string): EngineCardEntry | undefined =>
    card.entries.find((one) => one.key === key);

  const revenue = entry('revenueRange');
  const costs = entry('directCosts');
  const hours = entry('hours');

  const out: DerivedFigure[] = [];

  const marginInputs = [revenue, costs].filter(
    (one): one is EngineCardEntry => Boolean(one && one.value),
  );
  out.push({
    key: 'margin',
    label: 'Expected margin',
    formula: 'the published price or range, less the published direct costs',
    inputs: marginInputs.map((one) => ({
      field: one.key,
      value: one.value!,
      claimId: one.claimId,
    })),
    value:
      revenue?.value && costs?.value
        ? `${revenue.value} less ${costs.value}`
        : null,
    withheld:
      revenue?.value && costs?.value
        ? null
        : !revenue?.value && !costs?.value
          ? 'Neither a price nor a cost is known, so there is nothing to take one from the other.'
          : revenue?.value
            ? 'The direct costs are unknown. A margin against an unknown cost reads as better ' +
              'than it is, so none is given.'
            : 'No published price is known, so there is nothing to take the costs from.',
  });

  /*
   * Hours are reported beside the margin and never multiplied by a rate.
   *
   * Inventing the rate is the same defect one step along: it would turn a
   * figure nobody set into a cost that looks measured.
   */
  if (hours?.value) {
    out.push({
      key: 'effort',
      label: 'Effort',
      formula: 'the published hours, reported as hours rather than priced at a rate nobody set',
      inputs: [{ field: hours.key, value: hours.value, claimId: hours.claimId }],
      value: hours.value,
      withheld: null,
    });
  }

  return out;
}
