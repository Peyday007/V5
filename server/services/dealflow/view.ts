/**
 * The dealflow kernel as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Derived on the read path, like everything else about this kernel
 * ---------------------------------------------------------------------------
 *
 * The stage, the compliance verdict, the landed cost, the capital class, the
 * next action and what Brain would ask next are all computed here and stored
 * nowhere. `tier.ts` and `placements` both settled this and the argument does
 * not change: a stored reading is stale the moment the evidence it was waiting
 * on arrives, and two readers deriving it separately is how one screen comes
 * to disagree with another.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to say
 * ---------------------------------------------------------------------------
 *
 * There is no score, no percentage and no probability anywhere in this view.
 * A deal with a supplier, a price and no compliance answer is described by
 * those three facts, not by a figure composed from them — because composing
 * one needs weights nobody set and the result reads like a measurement.
 *
 * `confidence` is reported as a set of named established facts rather than a
 * number, for the same reason. "Four of six established" is checkable; "67%
 * confident" is not, and it is the kind of number that survives into a
 * decision long after anybody remembers what went into it.
 *
 * ---------------------------------------------------------------------------
 * Our revenue is never a figure
 * ---------------------------------------------------------------------------
 *
 * §13's distinction, at the surface where it would be easiest to lose. The
 * transaction value is a number Brain can derive from published figures. What
 * *we* earn is a fee under a structure nobody has chosen, at a rate no source
 * states as ours — so what this view reports is the attested structures and
 * what each would require of our capital, and it reports no revenue figure at
 * all. A number there would be somebody else's published range, multiplied by
 * a transaction value, presented as arithmetic.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import { dealflowSnapshot, type DealflowSnapshot } from './graph.ts';
import { envelopeFor, type EnvelopeVerdict } from './compliance.ts';
import { landedEconomics } from './economics.ts';
import { commercialPath, describeCapital, structureOptions, type CapitalClass } from './structures.ts';
import { lessonsFrom, lessonsFor, type Lesson } from './lessons.ts';
import { planFrom, readAll } from './kernel.ts';
import { MAX_OPEN_DEAL_ROUNDS } from './allocate.ts';
import { DERIVED_LADDER } from './maturity.ts';
import type { DealRoundPurpose, DealStage } from '../../domain/types.ts';

export interface CategoryView {
  equipmentClass: string;
  buyers: number;
  suppliers: number;
  deals: number;
  /** The markets buyers of this class are in. */
  markets: string[];
  /** Published cost figures held for this class, across every lane. */
  costLines: number;
  attestedStructures: number;
  liveQuestions: number;
  lastAskedAt: string | null;
}

export interface MarketView {
  destination: string;
  buyers: number;
  deals: number;
  /** One per class researched into this market. */
  envelopes: { equipmentClass: string; verdict: EnvelopeVerdict; unestablished: number }[];
}

export interface PartyView {
  id: string;
  name: string;
  country: string | null;
  equipmentClass: string;
  note: string | null;
  decisionMaker: string | null;
  /** The claim that established it, so every line resolves to a passage. */
  sourceClaimId: string | null;
  deals: number;
}

export interface DealCandidateView {
  id: string;
  buyer: string;
  supplier: string;
  equipmentClass: string;
  destination: string | null;
  stage: DealStage;
  because: string;
  /** What it costs to land one, or null with the reason it is withheld. */
  transactionValueCents: number | null;
  currency: string | null;
  /**
   * What we would earn. Always null, and the field exists to say so.
   *
   * Removing it would be quieter and worse: a reader looking for our revenue
   * and finding no field assumes the view forgot, while a field that is
   * explicitly null with a sentence beside it says Brain will not invent one.
   */
  ourRevenueCents: null;
  ourRevenueNote: string;
  /** What the lightest attested structure would require of us. */
  capitalClass: CapitalClass | null;
  capitalNote: string;
  /**
   * When the money would reach us, in words rather than as a date.
   *
   * The brief asks for expected time to cash, and this is the honest form of
   * it: a lookup over `STRUCTURE_PROFILE`, which says when each way of being
   * paid normally pays — *on inspection, so it is cash before the goods ship*,
   * or *when the buyer pays us, after we have already paid the supplier*.
   *
   * It is deliberately **not** a number of days. Brain holds no lead time, no
   * sailing schedule and no payment term for this deal, so a figure here would
   * be composed from nothing and would be the most quoted number on the
   * screen. Null until a structure is attested, because a payment schedule for
   * a way of being paid nobody has evidence of is a guess about a guess.
   */
  paidWhen: string | null;
  /** Named facts rather than a score. */
  established: string[];
  outstanding: string[];
  blocker: string | null;
  nextAction: string | null;
  opportunityId: string | null;
}

export interface QuestionView {
  purpose: DealRoundPurpose;
  subject: string;
  round: number;
  openedAt: string;
  state: string;
  found: number | null;
}

export interface DealflowView {
  projectId: string;
  active: boolean;
  /** Why nothing is being asked, when nothing is. */
  gate: string | null;
  categories: CategoryView[];
  markets: MarketView[];
  buyers: PartyView[];
  suppliers: PartyView[];
  deals: DealCandidateView[];
  /** What the kernel is asking right now. */
  live: QuestionView[];
  /** What it would ask next, with the allocator's own reason. Creates nothing. */
  next: { purpose: DealRoundPurpose; subject: string; why: string }[];
  declined: { subject: string; why: string }[];
  lessons: Lesson[];
  counts: {
    categories: number;
    buyers: number;
    suppliers: number;
    deals: number;
    outreachReady: number;
    blocked: number;
    liveQuestions: number;
    questionSlots: number;
    requirements: number;
    costLines: number;
    structures: number;
    observations: number;
  };
}

const REVENUE_NOTE =
  'Brain does not state what we would earn. The transaction value is derived from published ' +
  'figures; our share is a fee under a structure nobody has chosen yet, at a rate no source ' +
  'states as ours. A number here would be somebody else’s published range multiplied by a ' +
  'transaction value and presented as arithmetic.';

export async function dealflowView(projectId: string): Promise<DealflowView> {
  const mode = await getCashMode(projectId);
  const snapshot = await dealflowSnapshot(projectId);
  const readings = await readAll(snapshot);
  const plan = planFrom(snapshot, readings);
  const lessons = lessonsFrom(snapshot.observations);

  const live = snapshot.rounds
    .filter((one) => one.state === 'OPEN')
    .map((one) => toQuestion(one, snapshot));

  const deals: DealCandidateView[] = readings.map((reading) => {
    const established: string[] = [];
    const outstanding: string[] = [];

    const push = (ok: boolean, label: string) => (ok ? established : outstanding).push(label);
    push(true, 'a named buyer with a published need');
    push(true, 'a named supplier that builds this class');
    push(reading.destination !== null, 'the market the buyer is in');
    push(
      reading.economics.components.some(
        (one) => one.component === 'FACTORY_PRICE' && one.amountCents !== null,
      ),
      'a published price for the equipment',
    );
    push(reading.envelope.verdict === 'ESTABLISHED', 'the compliance envelope, all five layers');
    push(reading.economics.landedCents !== null, 'the landed cost');
    push(reading.economics.savingCents !== null, 'what the buyer pays today');
    push(reading.path.established, 'a commercial structure this trade actually uses');
    push(reading.buyer.decisionMaker !== null, 'who decides the purchase');

    return {
      id: reading.deal.id,
      buyer: reading.buyer.name,
      supplier: reading.supplier.name,
      equipmentClass: reading.deal.equipmentClass,
      destination: reading.destination,
      stage: reading.stage,
      because: reading.because,
      transactionValueCents: reading.economics.landedCents,
      currency: reading.economics.currency,
      ourRevenueCents: null,
      ourRevenueNote: REVENUE_NOTE,
      capitalClass: reading.path.lightestCapitalClass,
      capitalNote: `The lightest attested structure requires ${describeCapital(
        reading.path.lightestCapitalClass,
      )}.`,
      /*
       * The lightest attested structure's own payment schedule, in its words.
       * A lookup over a constant rather than a figure composed from lead times
       * and sailing schedules Brain does not hold.
       */
      paidWhen: lightestAttested(reading)?.profile.paidWhen ?? null,
      established,
      outstanding,
      blocker: reading.blocker,
      nextAction: reading.nextAction,
      opportunityId: reading.deal.opportunityId,
    };
  });

  // Strongest first, so the closest thing to cash is at the top. A sort order
  // rather than a ranking: nothing here says one deal is better than another,
  // only that one is further along.
  deals.sort((a, b) => ladderRank(b.stage) - ladderRank(a.stage) || a.buyer.localeCompare(b.buyer));

  const categories: CategoryView[] = snapshot.classes.map((view) => {
    const asked = view.rounds
      .map((one) => one.openedAt)
      .sort()
      .pop();
    return {
      equipmentClass: view.equipmentClass,
      buyers: view.buyers.length,
      suppliers: view.suppliers.length,
      deals: view.deals.length,
      markets: view.destinations,
      costLines: view.costs.length,
      attestedStructures: new Set(view.structures.map((one) => one.structure)).size,
      liveQuestions: view.liveRounds,
      lastAskedAt: asked ?? null,
    };
  });

  const markets = marketsFrom(snapshot);

  return {
    projectId,
    active: mode?.state === 'ACTIVE',
    gate:
      mode === null
        ? 'No sprint is active on this project, so this kernel asks nothing. Everything it has ' +
          'already established is still here.'
        : mode.state !== 'ACTIVE'
          ? `The sprint is ${mode.state.toLowerCase().replace('_', ' ')}, so no new questions ` +
            'are opened. What research already found is still filed, and a deal already ' +
            'promoted is still somebody’s to finish.'
          : null,
    categories,
    markets,
    buyers: snapshot.parties
      .filter((one) => one.kind === 'BUYER' && one.retiredAt === null)
      .map((one) => toParty(one, snapshot)),
    suppliers: snapshot.parties
      .filter((one) => one.kind === 'SUPPLIER' && one.retiredAt === null)
      .map((one) => toParty(one, snapshot)),
    deals,
    live,
    next: plan.asks.map((ask) => ({
      purpose: ask.purpose,
      subject: ask.equipmentClass ?? ask.destination ?? 'the starting map',
      why: ask.why,
    })),
    declined: plan.declined,
    lessons,
    counts: {
      categories: snapshot.classes.length,
      buyers: snapshot.parties.filter((one) => one.kind === 'BUYER' && one.retiredAt === null)
        .length,
      suppliers: snapshot.parties.filter(
        (one) => one.kind === 'SUPPLIER' && one.retiredAt === null,
      ).length,
      deals: snapshot.deals.length,
      outreachReady: readings.filter((one) => one.stage === 'OUTREACH_READY').length,
      blocked: readings.filter((one) => one.stage === 'BLOCKED').length,
      liveQuestions: snapshot.openRounds,
      questionSlots: MAX_OPEN_DEAL_ROUNDS,
      requirements: snapshot.requirements.length,
      costLines: snapshot.costs.length,
      structures: snapshot.structures.length,
      observations: snapshot.observations.length,
    },
  };
}

/**
 * The attested structure that requires least of our own capital.
 *
 * The same one `commercialPath` reports the capital class of, found the same
 * way — by the class order rather than by a score — so the capital note and
 * the payment schedule beside it are always about the same structure. Two
 * readers choosing separately is how one line comes to describe a structure
 * the line under it is not about.
 */
function lightestAttested(reading: {
  path: { attested: readonly { profile: { capitalClass: CapitalClass } }[]; lightestCapitalClass: CapitalClass | null };
}): { profile: { capitalClass: CapitalClass; paidWhen: string } } | null {
  const cls = reading.path.lightestCapitalClass;
  if (!cls) return null;
  return (
    (reading.path.attested.find((one) => one.profile.capitalClass === cls) as {
      profile: { capitalClass: CapitalClass; paidWhen: string };
    }) ?? null
  );
}

function ladderRank(stage: DealStage): number {
  const index = DERIVED_LADDER.indexOf(stage);
  if (index >= 0) return index;
  if (stage === 'BLOCKED' || stage === 'LOST') return -1;
  // Everything past the ladder is being pursued, so it outranks all of it.
  return DERIVED_LADDER.length + 1;
}

function toParty(
  party: DealflowSnapshot['parties'][number],
  snapshot: DealflowSnapshot,
): PartyView {
  return {
    id: party.id,
    name: party.name,
    country: party.country,
    equipmentClass: party.equipmentClass,
    note: party.note,
    decisionMaker: party.decisionMaker,
    sourceClaimId: party.sourceClaimId,
    deals: snapshot.deals.filter(
      (one) => one.buyerPartyId === party.id || one.supplierPartyId === party.id,
    ).length,
  };
}

function toQuestion(
  round: DealflowSnapshot['rounds'][number],
  snapshot: DealflowSnapshot,
): QuestionView {
  const party = round.partyId
    ? snapshot.parties.find((one) => one.id === round.partyId)
    : undefined;
  const subject =
    round.equipmentClass && round.destination
      ? `${round.equipmentClass} into ${round.destination}`
      : (round.equipmentClass ?? party?.name ?? 'the starting map');
  return {
    purpose: round.purpose,
    subject,
    round: round.round,
    openedAt: round.openedAt,
    state: round.state,
    // Null while OPEN, and the reader says *not counted yet* rather than nought
    // — §33's defect, deliberately not repeated here.
    found: round.found,
  };
}

function marketsFrom(snapshot: DealflowSnapshot): MarketView[] {
  const byMarket = new Map<string, MarketView>();
  for (const view of snapshot.classes) {
    for (const destination of view.destinations) {
      const key = destination.toLowerCase();
      const existing = byMarket.get(key) ?? {
        destination,
        buyers: 0,
        deals: 0,
        envelopes: [],
      };
      const buyers = view.buyers.filter(
        (one) => (one.country ?? '').toLowerCase() === key,
      );
      const envelope = envelopeFor({
        equipmentClass: view.equipmentClass,
        destination,
        requirements: view.requirements,
      });
      existing.buyers += buyers.length;
      existing.deals += view.deals.filter((deal) =>
        buyers.some((one) => one.id === deal.buyerPartyId),
      ).length;
      existing.envelopes.push({
        equipmentClass: view.equipmentClass,
        verdict: envelope.verdict,
        unestablished: envelope.unestablished.length,
      });
      byMarket.set(key, existing);
    }
  }
  return [...byMarket.values()];
}

/**
 * One deal in full, for somebody who wants to check it rather than scan it.
 *
 * Everything here resolves to a claim: each requirement carries the claim that
 * established it, each cost line carries its own, each structure carries the
 * source that attested it. A person who disagrees with the reading can walk
 * back to the passage rather than to a summary.
 */
export async function dealDetail(input: {
  projectId: string;
  dealId: string;
}): Promise<{
  reading: ReturnType<typeof detailShape>;
} | null> {
  const snapshot = await dealflowSnapshot(input.projectId);
  const readings = await readAll(snapshot);
  const reading = readings.find((one) => one.deal.id === input.dealId);
  if (!reading) return null;
  const lessons = lessonsFor({
    lessons: lessonsFrom(snapshot.observations),
    equipmentClass: reading.deal.equipmentClass,
    destination: reading.destination,
  });
  return { reading: detailShape(reading, snapshot, lessons) };
}

function detailShape(
  reading: Awaited<ReturnType<typeof readAll>>[number],
  snapshot: DealflowSnapshot,
  lessons: Lesson[],
) {
  const options = structureOptions({
    equipmentClass: reading.deal.equipmentClass,
    evidence: snapshot.structures,
  });
  return {
    deal: reading.deal,
    buyer: reading.buyer,
    supplier: reading.supplier,
    stage: reading.stage,
    because: reading.because,
    nextAction: reading.nextAction,
    blocker: reading.blocker,
    /* All five layers, always — a reader has to be able to see which are open. */
    envelope: reading.envelope,
    economics: landedEconomics({
      equipmentClass: reading.deal.equipmentClass,
      destination: reading.destination ?? '',
      costs: snapshot.costs,
    }),
    path: commercialPath(options),
    /* Every structure, not only the attested ones. An unattested structure is
     * not refused — hiding it would make the absence of research look like a
     * judgement about the structure. */
    structures: options,
    lessons,
    ourRevenueNote: REVENUE_NOTE,
  };
}
