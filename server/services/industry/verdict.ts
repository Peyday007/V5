/**
 * What to do with a subject, and how a piece of work stands on the two things
 * the brief actually optimizes for.
 *
 * ---------------------------------------------------------------------------
 * The verdict is derived, and it never invents a probability
 * ---------------------------------------------------------------------------
 *
 * Six verdicts, taken from the brief, and every one of them is decided by rows
 * that already exist: how many rounds have settled, what they found, what is in
 * the portfolio underneath, and how far each piece has got. Nothing here reads
 * prose, nothing here assigns a weight, and nothing here produces a number that
 * looks like a measurement.
 *
 * `portfolio.ts` already settled this question for opportunities and the
 * reasoning transfers exactly: the order is **lexicographic over observable
 * facts** rather than a weighted score, because a score needs weights, weights
 * are a judgement nobody made, and the number then reads like something that
 * was measured.
 *
 * ---------------------------------------------------------------------------
 * Cash now and position later are two readings, never one
 * ---------------------------------------------------------------------------
 *
 * The brief asks to optimize for both, and the tempting implementation is one
 * blended figure. That figure would be the invented judgement this codebase
 * refuses everywhere else: it would need a rate of exchange between "money this
 * week" and "a relationship with a producer", and nobody has set one. So both
 * are reported, each composed only of facts Brain holds, each naming what it
 * does not know — and a reader does the trading off, which is the part that was
 * always theirs.
 */
import { BARREN_ROUNDS } from '../cash/discovery.ts';
import type { NodeCoverage } from './graph.ts';
import type { CashOpportunity, OpportunityConstraint } from '../../domain/types.ts';
import type { CapitalReading } from './capital.ts';

export const PATH_VERDICTS = [
  'DEAD_END',
  'WATCH',
  'RESEARCH_MORE',
  'PILOT',
  'EXECUTE',
  'SCALE',
] as const;
export type PathVerdict = (typeof PATH_VERDICTS)[number];

export interface SubjectStanding {
  nodeId: string;
  verdict: PathVerdict;
  /** The rows the verdict was read from, so it can be argued with. */
  because: string;
  /** Whether more spending here is currently justified by what it produced. */
  worthDeepening: boolean;
}

/**
 * Where one subject stands.
 *
 * Ordered strongest evidence first: something that has already been paid for
 * outranks something that has been tested, which outranks something that has
 * been found. A subject only reaches `DEAD_END` by exhausting the same barren
 * rule `nextRoundFor` already applies — Brain has documented that there is
 * nothing here, so re-asking spends the allowance to learn it again — or by a
 * person retiring it, which is the one verdict no derivation could reach.
 */
export function standingOf(
  coverage: NodeCoverage,
  opportunities: readonly CashOpportunity[],
): SubjectStanding {
  const mine = opportunities.filter((one) => one.industryNodeId === coverage.node.id);
  const inState = (states: readonly string[]) =>
    mine.filter((one) => states.includes(one.state)).length;

  if (coverage.node.retiredAt !== null) {
    return {
      nodeId: coverage.node.id,
      verdict: 'DEAD_END',
      because: coverage.node.retiredReason ?? 'A person retired this subject.',
      worthDeepening: false,
    };
  }

  const collected = inState(['COLLECTED']);
  if (collected > 0) {
    return {
      nodeId: coverage.node.id,
      verdict: 'SCALE',
      because: `${collected} piece${collected === 1 ? '' : 's'} here have been paid for.`,
      worthDeepening: true,
    };
  }

  const running = inState(['EXECUTING', 'DELIVERING']);
  if (running > 0) {
    return {
      nodeId: coverage.node.id,
      verdict: 'EXECUTE',
      because: `${running} piece${running === 1 ? '' : 's'} here are being worked on.`,
      worthDeepening: true,
    };
  }

  const ready = inState(['READY']);
  if (ready > 0) {
    return {
      nodeId: coverage.node.id,
      verdict: 'PILOT',
      because: `${ready} piece${ready === 1 ? '' : 's'} here are ready to test.`,
      worthDeepening: true,
    };
  }

  /*
   * Barren by the same rule discovery already applies to its own buckets.
   *
   * Both halves have to be exhausted: a subject that has been scanned three
   * times and found nothing might still be one whose *children* are where the
   * money is, so a subject that recurses and has never been decomposed is
   * never dead. Calling it dead would kill the recursion the kernel exists
   * for, one level above where the evidence actually is.
   */
  const scannedOut = coverage.scanRounds >= BARREN_ROUNDS && coverage.scanFound === 0;
  const mappedOut = !coverage.recurses || (coverage.mapRounds >= 1 && coverage.mapFound === 0);
  if (scannedOut && mappedOut && !coverage.scanOpen && !coverage.mapOpen) {
    return {
      nodeId: coverage.node.id,
      verdict: 'DEAD_END',
      because:
        `${coverage.scanRounds} searches found no openings and ` +
        (coverage.recurses
          ? 'decomposing it found nothing underneath.'
          : 'nothing narrower sits underneath this kind of subject.'),
      worthDeepening: false,
    };
  }

  if (mine.length > 0) {
    return {
      nodeId: coverage.node.id,
      verdict: 'RESEARCH_MORE',
      because:
        `${mine.length} opening${mine.length === 1 ? '' : 's'} came from here and ` +
        'none has been qualified yet.',
      worthDeepening: true,
    };
  }

  const asked = coverage.scanRounds + coverage.mapRounds;
  if (asked === 0) {
    return {
      nodeId: coverage.node.id,
      verdict: 'RESEARCH_MORE',
      because: 'Nothing has been asked about this subject yet.',
      worthDeepening: true,
    };
  }

  return {
    nodeId: coverage.node.id,
    verdict: 'WATCH',
    because:
      `${asked} round${asked === 1 ? '' : 's'} have settled here without producing an ` +
      'opening, and there is still something left to ask.',
    worthDeepening: false,
  };
}

/**
 * What Brain can actually say about cash now and position later.
 *
 * Both are lists of established facts and named unknowns rather than scores.
 * The unknowns are the half that matters: a piece with three cash facts and
 * six unknowns is not a better bet than one with one fact and no unknowns, and
 * a number would have said it was.
 */
export interface StandingReading {
  opportunityId: string;
  cashNow: { facts: string[]; unknown: string[] };
  positionLater: { facts: string[]; unknown: string[] };
  /** Constraints that change the economics, which a score would have hidden. */
  constraints: string[];
}

export function readStanding(
  opportunity: CashOpportunity,
  capital: CapitalReading,
  constraints: readonly OpportunityConstraint[],
): StandingReading {
  const cashFacts: string[] = [];
  const cashUnknown: string[] = [];
  const laterFacts: string[] = [];
  const laterUnknown: string[] = [];

  if (opportunity.payer) cashFacts.push(`A payer is established: ${opportunity.payer}.`);
  else cashUnknown.push('Who would pay is not established.');

  if (opportunity.priceCents !== null) cashFacts.push('A price is established.');
  else cashUnknown.push('What it pays is not established.');

  if (opportunity.reachableChannel) cashFacts.push('There is a way to reach the buyer.');
  else cashUnknown.push('How to reach the buyer is not established.');

  if (capital.minimumOwnerCents !== null) {
    cashFacts.push('The owner capital this actually requires has been decomposed.');
  } else {
    cashUnknown.push(
      capital.unknown === 'NOT_DECOMPOSED'
        ? 'Nothing has decomposed what capital this requires.'
        : 'At least one capital requirement has no established amount, so the minimum is withheld.',
    );
  }

  if (opportunity.expiresAt) {
    cashFacts.push(`The source states this closes on ${opportunity.expiresAt}.`);
  }

  if (capital.mechanisms.length > 0) {
    cashFacts.push(
      `${capital.mechanisms.length} published way${capital.mechanisms.length === 1 ? '' : 's'} ` +
        'of removing or deferring a capital requirement were found here.',
    );
  }

  /*
   * Position later is about what a transaction *leaves behind*, and Brain
   * holds far less about it than about cash. Saying so is the honest output:
   * the alternative is a confident sentence about strategic value composed
   * from nothing, which is the invented judgement this module refuses.
   */
  if (opportunity.industryNodeId) {
    laterFacts.push('It sits in a mapped subject, so what is adjacent to it is readable.');
  } else {
    laterUnknown.push('Nothing says which industry this is in, so nothing adjacent is readable.');
  }

  if (opportunity.fulfillmentOwner) {
    laterFacts.push('Who would fulfil it is established, so what repeating it takes is known.');
  } else {
    laterUnknown.push('Who would fulfil it is not established.');
  }

  if (opportunity.deliveryMethod) {
    laterFacts.push('A delivery method is established, so the relationship it creates is readable.');
  } else {
    laterUnknown.push('How it would be delivered is not established.');
  }

  return {
    opportunityId: opportunity.id,
    cashNow: { facts: cashFacts, unknown: cashUnknown },
    positionLater: { facts: laterFacts, unknown: laterUnknown },
    constraints: constraints
      .filter((one) => one.opportunityId === opportunity.id)
      .map((one) => (one.effect ? `${one.statement} — ${one.effect}` : one.statement)),
  };
}
