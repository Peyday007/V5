/**
 * What to ask next, and why.
 *
 * ---------------------------------------------------------------------------
 * A pure function over a recorded snapshot
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/router.ts` draws this line and `services/industry/
 * allocate.ts` after it: the decision is pure so that *why did Brain research
 * that* is answerable afterwards from an input that was recorded, rather than
 * from a re-run against a database that has moved. Being pure also makes it
 * useless as a safety mechanism, which is correct — the exclusion is the
 * unique index on `deal_rounds`, so two ticks both deciding correctly produce
 * one round and the loser is an ordinary outcome.
 *
 * ---------------------------------------------------------------------------
 * Seven rules in a fixed order, and no weighted score anywhere
 * ---------------------------------------------------------------------------
 *
 * A score would need weights, weights are a judgement nobody made, and the
 * resulting number reads like a measurement. So the order below is an argument
 * that can be read and disagreed with, in the order the trade itself fails in.
 *
 * The one that matters most is rule 2: **finishing a deal outranks starting
 * one.** §38 records making the opposite mistake and correcting it — the
 * research that found an opening and the dive that qualified it have already
 * been paid for, so the thing that should wait is the next discovery rather
 * than the answer to a question one fact short of being useful.
 *
 * ---------------------------------------------------------------------------
 * It stops, and each bound is a bound rather than a preference
 * ---------------------------------------------------------------------------
 *
 * One live question per class; a cool-off before the same question is asked
 * again; and a question that has come back empty `BARREN_ROUNDS` times is not
 * asked again, because Brain has now documented that there is nothing there
 * and §13's rule about not researching what the archive answers applies to
 * Brain's own history too.
 *
 * `MAX_OPEN_DEAL_ROUNDS` is **concurrency and not a lifetime quota**. §24
 * removed exactly that kind of number from the standing authority and recorded
 * why: nothing it rationed was scarce, so it measured a starting point and
 * then became a permanent ceiling.
 */
import type { DealRoundPurpose, DealStage } from '../../domain/types.ts';
import type { ClassView, DealflowSnapshot } from './graph.ts';
import type { DealReading } from './maturity.ts';
import { nextLayerToResearch } from './compliance.ts';

/** How many of this kernel's questions may be live at once. Real provider capacity. */
export const MAX_OPEN_DEAL_ROUNDS = 3;

/** One live question per class, so a class cannot monopolise the slots. */
export const MAX_LIVE_PER_CLASS = 1;

/** How long before the same question may be asked again. */
export const ROUND_COOL_OFF_MS = 24 * 60 * 60 * 1000;

/**
 * How many empty answers retire a question.
 *
 * Three, and it applies per (purpose, subject) rather than per class: a class
 * whose demand question keeps coming back empty may still have an unanswered
 * compliance question worth asking.
 */
export const BARREN_ROUNDS = 3;

export interface Ask {
  purpose: DealRoundPurpose;
  equipmentClass: string | null;
  destination: string | null;
  partyId: string | null;
  dealId: string | null;
  round: number;
  /** The allocator's own reason, recorded beside the work it produces. */
  why: string;
  rank: number;
}

export interface Declined {
  subject: string;
  why: string;
}

export interface Allocation {
  asks: Ask[];
  declined: Declined[];
}

/** The identity a round's history is counted against. */
function askKey(input: {
  purpose: DealRoundPurpose;
  equipmentKey: string | null;
  destination: string | null;
  partyId: string | null;
}): string {
  return [
    input.purpose,
    input.equipmentKey ?? '-',
    input.destination?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '-',
    input.partyId ?? '-',
  ].join('|');
}

interface History {
  /** The next round number to ask, or null when this question is retired. */
  next: number | null;
  why: string | null;
}

function historyFor(
  snapshot: DealflowSnapshot,
  key: string,
  now: number,
): History {
  const mine = snapshot.rounds
    .filter(
      (one) =>
        askKey({
          purpose: one.purpose,
          equipmentKey: one.equipmentKey,
          destination: one.destination,
          partyId: one.partyId,
        }) === key,
    )
    .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0));

  if (mine.length === 0) return { next: 1, why: null };

  if (mine.some((one) => one.state === 'OPEN')) {
    return { next: null, why: 'a question about this is already live' };
  }

  /*
   * Barren is counted over the *trailing* settled rounds rather than over all
   * of them, so a question that produced findings and then went quiet is not
   * retired by its own success — the run of empties has to be unbroken and
   * current.
   */
  let barren = 0;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const found = mine[i]?.found ?? 0;
    if (found > 0) break;
    barren += 1;
  }
  if (barren >= BARREN_ROUNDS) {
    return {
      next: null,
      why: `asked ${barren} times and established nothing, so Brain has documented that there is nothing here`,
    };
  }

  const last = mine[mine.length - 1];
  const settledAt = last?.harvestedAt ? Date.parse(last.harvestedAt) : null;
  if (settledAt !== null && Number.isFinite(settledAt) && now - settledAt < ROUND_COOL_OFF_MS) {
    return { next: null, why: 'it was answered within the cool-off' };
  }

  return { next: mine.length + 1, why: null };
}

export function allocate(input: {
  snapshot: DealflowSnapshot;
  /** The deal readings, computed by the caller so this stays pure. */
  readings: readonly DealReading[];
  slots: number;
  now?: string;
}): Allocation {
  const { snapshot } = input;
  const now = Date.parse(input.now ?? snapshot.takenAt);
  const asks: Ask[] = [];
  const declined: Declined[] = [];

  const liveByClass = new Map<string, number>();
  for (const round of snapshot.rounds) {
    if (round.state !== 'OPEN' || !round.equipmentKey) continue;
    liveByClass.set(round.equipmentKey, (liveByClass.get(round.equipmentKey) ?? 0) + 1);
  }

  const taken = new Set<string>();

  const offer = (
    ask: Omit<Ask, 'rank'>,
    equipmentKey: string | null,
    subject: string,
  ): boolean => {
    if (asks.length >= input.slots) return false;
    const key = askKey({
      purpose: ask.purpose,
      equipmentKey,
      destination: ask.destination,
      partyId: ask.partyId,
    });
    if (taken.has(key)) return false;

    if (equipmentKey) {
      const live = (liveByClass.get(equipmentKey) ?? 0) + countPending(asks, equipmentKey, snapshot);
      if (live >= MAX_LIVE_PER_CLASS) {
        declined.push({ subject, why: 'a question about this class is already live' });
        taken.add(key);
        return false;
      }
    }

    const history = historyFor(snapshot, key, now);
    if (history.next === null) {
      declined.push({ subject, why: history.why ?? 'it is not askable right now' });
      taken.add(key);
      return false;
    }

    taken.add(key);
    asks.push({ ...ask, round: history.next, rank: asks.length + 1 });
    return true;
  };

  // ------------------------------------------------------------------
  // 1. Nothing at all. The one question with no class attached.
  // ------------------------------------------------------------------
  if (snapshot.classes.length === 0) {
    offer(
      {
        purpose: 'SEED_EQUIPMENT',
        equipmentClass: null,
        destination: null,
        partyId: null,
        dealId: null,
        round: 1,
        why:
          'No class of equipment is on the map, so there is nothing to ask a two-sided ' +
          'question about. This is the only question that can be asked without one.',
      },
      null,
      'the starting map',
    );
    return { asks, declined };
  }

  // ------------------------------------------------------------------
  // 2. Finish a deal before starting another one.
  //
  // In descending order of how far along it already is, so the closest thing
  // to cash is asked about first. §38 records making this the other way round
  // and correcting it.
  // ------------------------------------------------------------------
  const advanceable = [...input.readings]
    .filter((one) => ADVANCEABLE.has(one.stage))
    .sort((a, b) => LADDER_RANK[b.stage] - LADDER_RANK[a.stage]);

  for (const reading of advanceable) {
    const ask = askThatAdvances(reading);
    if (!ask) continue;
    offer(
      ask,
      reading.deal.equipmentKey,
      `${reading.buyer.name} ↔ ${reading.supplier.name} (${reading.deal.equipmentClass})`,
    );
  }

  // ------------------------------------------------------------------
  // 3. One-sided classes, both directions. §5's demand-first and supply-first
  //    run together rather than as a mode somebody selects.
  // ------------------------------------------------------------------
  for (const view of snapshot.classes) {
    if (view.buyers.length > 0 && view.suppliers.length === 0) {
      offer(
        {
          purpose: 'SUPPLY',
          equipmentClass: view.equipmentClass,
          destination: null,
          partyId: null,
          dealId: null,
          round: 1,
          why:
            `${view.buyers.length} buyer${view.buyers.length === 1 ? '' : 's'} for ` +
            `${view.equipmentClass} and nobody established who builds it. A need with no ` +
            'supplier is not a deal.',
        },
        view.key,
        view.equipmentClass,
      );
    } else if (view.suppliers.length > 0 && view.buyers.length === 0) {
      offer(
        {
          purpose: 'DEMAND',
          equipmentClass: view.equipmentClass,
          destination: null,
          partyId: null,
          dealId: null,
          round: 1,
          why:
            `${view.suppliers.length} supplier${view.suppliers.length === 1 ? '' : 's'} for ` +
            `${view.equipmentClass} and nobody established who needs it. Capability with no ` +
            'buyer is not a deal either.',
        },
        view.key,
        view.equipmentClass,
      );
    }
  }

  // ------------------------------------------------------------------
  // 4. Account expansion, and only after a real transaction.
  //
  // §7 is explicit: do not blindly sell everything, identify *verified*
  // adjacent needs. So this fires off a recorded outcome rather than off
  // optimism, which also makes it the one question in the kernel that cannot
  // run before the operation has actually done something.
  // ------------------------------------------------------------------
  for (const reading of input.readings) {
    if (reading.stage !== 'PAID') continue;
    offer(
      {
        purpose: 'ADJACENT',
        equipmentClass: reading.buyer.equipmentClass,
        destination: reading.buyer.country,
        partyId: reading.buyer.id,
        dealId: reading.deal.id,
        round: 1,
        why:
          `${reading.buyer.name} has actually transacted. An account that has bought once is ` +
          'the cheapest place in this whole kernel to find the next need, and it is the only ' +
          'adjacency question that rests on something rather than on plausibility.',
      },
      reading.buyer.equipmentKey,
      reading.buyer.name,
    );
  }

  // ------------------------------------------------------------------
  // 5. Widen a class that has both sides but thin coverage.
  //
  // Oldest-touched first, so every class gets a turn. §38 records the defect
  // this avoids: with no such rule the tie fell through to a generated id,
  // which is deterministic, meaningless, and leaves the same subjects at the
  // back of the queue for ever.
  // ------------------------------------------------------------------
  const byAge = [...snapshot.classes].sort(
    (a, b) => lastTouched(a) - lastTouched(b) || a.key.localeCompare(b.key),
  );
  for (const view of byAge) {
    if (view.buyers.length === 0 || view.suppliers.length === 0) continue;
    const thinner: DealRoundPurpose =
      view.buyers.length <= view.suppliers.length ? 'DEMAND' : 'SUPPLY';
    offer(
      {
        purpose: thinner,
        equipmentClass: view.equipmentClass,
        destination: null,
        partyId: null,
        dealId: null,
        round: 1,
        why:
          `${view.equipmentClass} has ${view.buyers.length} buyer` +
          `${view.buyers.length === 1 ? '' : 's'} and ${view.suppliers.length} supplier` +
          `${view.suppliers.length === 1 ? '' : 's'}, so the ${
            thinner === 'DEMAND' ? 'demand' : 'supply'
          } side is the thinner one. More of it is more pairings.`,
      },
      view.key,
      view.equipmentClass,
    );
  }

  return { asks, declined };
}

/** Classes touched most recently rank last, so everything gets a turn. */
function lastTouched(view: ClassView): number {
  const times = view.rounds
    .map((one) => Date.parse(one.openedAt))
    .filter((one) => Number.isFinite(one));
  return times.length === 0 ? 0 : Math.max(...times);
}

/** Pending asks already counted against a class this pass. */
function countPending(
  asks: readonly Ask[],
  equipmentKey: string,
  snapshot: DealflowSnapshot,
): number {
  return asks.filter((one) => {
    if (!one.equipmentClass) return false;
    const view = snapshot.classes.find((c) => c.equipmentClass === one.equipmentClass);
    return view?.key === equipmentKey;
  }).length;
}

const LADDER_RANK: Readonly<Record<DealStage, number>> = Object.freeze({
  SIGNAL: 0,
  HYPOTHESIS: 1,
  DISCOVERED: 2,
  RESEARCHED: 3,
  QUALIFIED: 4,
  COMMERCIAL_PATH: 5,
  OUTREACH_READY: 6,
  ENGAGED: 7,
  QUOTING: 8,
  NEGOTIATING: 9,
  CONTRACTING: 10,
  PAID: 11,
  LOST: -1,
  BLOCKED: -1,
});

/**
 * The stages where more research still moves the deal.
 *
 * `OUTREACH_READY` is absent deliberately: there is nothing left to research,
 * and asking anyway would spend the allowance to delay the one thing that
 * produces cash. `BLOCKED` and `LOST` are absent because no question changes
 * either.
 */
const ADVANCEABLE: ReadonlySet<DealStage> = new Set<DealStage>([
  'HYPOTHESIS',
  'DISCOVERED',
  'RESEARCHED',
  'QUALIFIED',
  'COMMERCIAL_PATH',
]);

/**
 * The one question that would move this deal, derived from its own reading.
 *
 * Every branch here mirrors a branch in `derivedStage`, deliberately: the
 * reading says what is missing and this turns that into the question that
 * settles it, so the two cannot drift into disagreeing about what a deal is
 * waiting for. A separate opinion about what to research would be exactly that
 * drift.
 */
function askThatAdvances(reading: DealReading): Omit<Ask, 'rank'> | null {
  const cls = reading.deal.equipmentClass;
  const destination = reading.destination;

  // No market to test against. That is a demand question about the buyer's own
  // country, and nothing downstream can be asked until it is answered.
  if (!destination) return null;

  const hasPrice = reading.economics.components.some(
    (one) => one.component === 'FACTORY_PRICE' && one.amountCents !== null,
  );
  if (!hasPrice) {
    return {
      purpose: 'LANDED_COST',
      equipmentClass: cls,
      destination,
      partyId: null,
      dealId: reading.deal.id,
      round: 1,
      why: `Nothing says what ${cls} costs, so every figure downstream rests on a number nobody has.`,
    };
  }

  const layer = nextLayerToResearch(reading.envelope);
  if (layer) {
    return {
      purpose: 'COMPLIANCE',
      equipmentClass: cls,
      destination,
      partyId: null,
      dealId: reading.deal.id,
      round: 1,
      why:
        `${reading.envelope.unestablished.length} compliance layer` +
        `${reading.envelope.unestablished.length === 1 ? '' : 's'} unresearched for ${cls} into ` +
        `${destination}, starting with ${layer}. This is the cheapest thing that can still ` +
        'make the whole pairing worthless.',
    };
  }

  if (reading.economics.landedCents === null && reading.economics.missing.length > 0) {
    return {
      purpose: 'LANDED_COST',
      equipmentClass: cls,
      destination,
      partyId: null,
      dealId: reading.deal.id,
      round: 1,
      why:
        `The goods can lawfully get there. ${reading.economics.missing.length} load-bearing ` +
        `cost line${reading.economics.missing.length === 1 ? '' : 's'} ` +
        `(${reading.economics.missing.join(', ')}) ${
          reading.economics.missing.length === 1 ? 'is' : 'are'
        } missing, so the landed cost is withheld rather than wrong.`,
    };
  }

  if (!reading.path.established) {
    return {
      purpose: 'STRUCTURE',
      equipmentClass: cls,
      destination: null,
      partyId: null,
      dealId: reading.deal.id,
      round: 1,
      why:
        'The deal is lawful and costed, and nothing says how this trade actually pays somebody ' +
        'in the middle. Without that there is no way to participate that a person could approve.',
    };
  }

  if (!reading.buyer.decisionMaker) {
    return {
      purpose: 'DECISION_MAKER',
      /*
       * The round names the class even though the *finding* will not.
       *
       * Those are two different things and the schema is right to insist on
       * the first: a decision-maker question is scoped to one organisation's
       * need for one class, and a round that named no class would be a
       * question about the organisation in general. What the worker declares
       * is separate — a DECISION_MAKER claim carries no `deal_equipment`,
       * because who signs for a purchase is a fact about the organisation.
       */
      equipmentClass: reading.deal.equipmentClass,
      destination: reading.buyer.country,
      partyId: reading.buyer.id,
      dealId: reading.deal.id,
      round: 1,
      why:
        `Everything is established except somebody to approach at ${reading.buyer.name}. A deal ` +
        'with no named decision maker is a deal nobody can start.',
    };
  }

  if (reading.economics.buyerAlternativeCents === null) {
    return {
      purpose: 'LANDED_COST',
      equipmentClass: cls,
      destination,
      partyId: null,
      dealId: reading.deal.id,
      round: 1,
      why:
        `What ${reading.buyer.name} pays for this today is unknown, so whether this is worth ` +
        'their while is unknown — and that, rather than our margin, is what decides whether ' +
        'they answer at all.',
    };
  }

  return null;
}
