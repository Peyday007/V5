/**
 * Where one monetization path stands, derived from rows.
 *
 * Five of the seven statuses are read from the facts, the judgements, the
 * subject and the graph on every request. Two are judgements, because no
 * derivation could recover *somebody decided this cannot work* or *somebody put
 * it away* — §38's own pair, at a new table.
 *
 * Nothing here is stored. `tier.ts` makes the argument at the altitude above
 * this one and it is the same argument: a stored status is stale the moment the
 * evidence it was waiting on arrives, and deriving it is what reclassifies
 * everything already written by deploying rather than by a backfill that cannot
 * reach what a later tick produced.
 *
 * Pure and total over its inputs. The same path, facts, judgements and subject
 * produce the same status, which is what lets the page, the ranking, the
 * movement history and the shared frontier all read one answer instead of four.
 */
import { ATTRIBUTE } from '../../../domain/monetization.ts';
import type {
  CashOpportunity,
  MonetizationAttribute,
  MonetizationPath,
  MonetizationPathFact,
  MonetizationPathJudgment,
  MonetizationStatus,
} from '../../../domain/types.ts';

export interface StatusReading {
  status: MonetizationStatus;
  /**
   * What decided it, naming the row rather than describing a mood.
   *
   * Every branch below names something a reader could go and look at: a
   * judgement, the subject's own state, a path this one waits on, a blocked
   * capability, a count of unanswered questions, or the figure that came out
   * negative. "Waiting" with nothing named is the state §24 calls stuck, and it
   * is not one of the answers here.
   */
  because: string;
}

/**
 * The last judgement that still holds.
 *
 * `REVIVE` is the answering transition for the two judgements that put a path
 * away, so it clears them rather than being a status of its own — and the rows
 * it cleared stay exactly where they were, because deleting the doubt would
 * make the ledger claim nobody ever had any.
 */
export function standingJudgment(
  judgments: readonly MonetizationPathJudgment[],
): MonetizationPathJudgment | null {
  let standing: MonetizationPathJudgment | null = null;
  for (const one of judgments) {
    if (one.judgment === 'REVIVE') standing = null;
    else standing = one;
  }
  return standing;
}

export interface StatusInput {
  path: MonetizationPath;
  facts: readonly MonetizationPathFact[];
  /** This path's judgements, oldest first. */
  judgments: readonly MonetizationPathJudgment[];
  /** The discovery this is a way of monetizing, where the subject is one. */
  subject: CashOpportunity | null;
  /**
   * Paths this one cannot start without, that are not themselves live.
   *
   * Resolved by `graph.ts` against the whole subject rather than here, because
   * *requires* is a fact about every path on a subject and a function holding
   * one path cannot know it.
   */
  unmetRequirements: readonly { title: string; status: MonetizationStatus }[];
  /**
   * Capability gaps recorded against the subject, as `cash_needs` rows.
   *
   * A real recorded blocker with a remedy on it, rather than a reading of what
   * this method might need. What a method *requires* is a question — the
   * `requiredCapability` attribute — and an unanswered question is unproven
   * rather than blocked; inventing a mapping from an endowment to a Brain
   * capability would be a confident MISSING about something nobody established.
   */
  blockedBy: readonly { blockedAction: string; nextStep: string }[];
  /** The path this one was merged into, where it was. */
  mergedInto: { title: string } | null;
}

const LOAD_BEARING: MonetizationAttribute[] = (
  Object.keys(ATTRIBUTE) as MonetizationAttribute[]
).filter((key) => ATTRIBUTE[key].loadBearing);

export function deriveStatus(input: StatusInput): StatusReading {
  const standing = standingJudgment(input.judgments);

  if (standing?.judgment === 'ARCHIVE') {
    return {
      status: 'ARCHIVED',
      because: `Somebody put this away: ${standing.reason}`,
    };
  }
  if (standing?.judgment === 'INVALIDATE') {
    return {
      status: 'INVALIDATED',
      because: `Somebody established that this does not work: ${standing.reason}`,
    };
  }

  /*
   * A merged path reads as put away, and it says where it went.
   *
   * There is no MERGED status, and adding one would be wrong: from the reader's
   * side a merged possibility is one that is no longer separately pursued, and
   * what they need is the survivor's name. The row, its facts, its judgements
   * and its whole rank history are untouched, and clearing one column brings it
   * back — which is what makes §20's merge reversible rather than a delete
   * wearing a softer word.
   */
  if (input.mergedInto) {
    return {
      status: 'ARCHIVED',
      because: `This was merged into "${input.mergedInto.title}", which carries it now.`,
    };
  }

  if (input.subject && (input.subject.state === 'ARCHIVED' || input.subject.state === 'DECLINED')) {
    return {
      status: 'ARCHIVED',
      because:
        `The discovery this is a way of monetizing is ${input.subject.state.toLowerCase()}, so ` +
        'there is nothing here to monetize. Nothing about this path was judged.',
    };
  }

  if (standing?.judgment === 'WATCH') {
    return {
      status: 'WATCH',
      because: `Somebody asked to be kept informed rather than to act: ${standing.reason}`,
    };
  }

  if (input.unmetRequirements.length > 0) {
    const first = input.unmetRequirements[0]!;
    return {
      status: 'BLOCKED',
      because:
        `This cannot start until "${first.title}" has, and that is ${first.status.toLowerCase()}` +
        (input.unmetRequirements.length > 1
          ? `, along with ${input.unmetRequirements.length - 1} other path` +
            `${input.unmetRequirements.length === 2 ? '' : 's'} it waits on.`
          : '.'),
    };
  }

  if (input.blockedBy.length > 0) {
    const first = input.blockedBy[0]!;
    return {
      status: 'BLOCKED',
      because: `${first.blockedAction} is blocked on a capability Brain does not have. ${first.nextStep}`,
    };
  }

  const answered = new Map(input.facts.map((one) => [one.attribute, one]));
  if (answered.size === 0) {
    return {
      status: 'UNPROVEN',
      because:
        'Nothing has been established about this yet. It is a shape of transaction that could ' +
        'apply here, and that is all it is.',
    };
  }

  /*
   * Answered, and what it answers is not good.
   *
   * Three readings, every one of them from a recorded value rather than from a
   * view about how promising something sounds. A negative contribution needs
   * **both** figures, exactly as `derivedEconomics` withholds a margin against
   * an unknown cost: a blank may never be the reason something is called weak,
   * any more than it may be the reason something rises.
   */
  const revenue = answered.get('expectedRevenue')?.amountCents ?? null;
  const costs = answered.get('directCosts')?.amountCents ?? null;
  if (revenue !== null && costs !== null && revenue - costs <= 0) {
    return {
      status: 'WEAK',
      because:
        'The established revenue does not cover the established direct costs, so this loses ' +
        'money as it stands. Raising the price is a different path rather than a repair of this ' +
        'one.',
    };
  }
  if (answered.get('competition')?.value === 'SATURATED') {
    return {
      status: 'WEAK',
      because: 'What is published says this is saturated, so the same work is already being supplied.',
    };
  }
  if (
    answered.get('scalability')?.value === 'NONE' &&
    answered.get('repeatability')?.value === 'ONE_OFF'
  ) {
    return {
      status: 'WEAK',
      because:
        'It happens once and the second one costs what the first did, so this is a job rather ' +
        'than a way of being paid repeatedly. That is not a reason to delete it.',
    };
  }

  const open = LOAD_BEARING.filter((key) => !answered.has(key));
  if (open.length > 0) {
    return {
      status: 'UNPROVEN',
      because:
        `${answered.size} thing${answered.size === 1 ? '' : 's'} ${
          answered.size === 1 ? 'is' : 'are'
        } established about this and ${open.length} load-bearing question` +
        `${open.length === 1 ? '' : 's'} ${open.length === 1 ? 'is' : 'are'} still open.`,
    };
  }

  return {
    status: 'ACTIVE',
    because:
      'Every load-bearing question about this is answered, the economics come out positive, and ' +
      'nothing named is in its way.',
  };
}
