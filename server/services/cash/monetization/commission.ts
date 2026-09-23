/**
 * Which question about which possibility is worth asking now.
 *
 * ---------------------------------------------------------------------------
 * What was wrong, and why a ledger alone could not fix it
 * ---------------------------------------------------------------------------
 *
 * §49 built a ledger that preserves every way a discovery could be paid for,
 * ranks them lexicographically so it can say exactly why one is above another,
 * and prints under each one the questions still open and the task that would
 * answer each. It could ask none of them. An audit of the shipped ledger found
 * that **two of the thirteen attributes had a production writer** — both
 * `RECOMMENDATION`, both carried from a figure already on the discovery — so
 * `kind = 'EVIDENCE'` had never been written, `claim_id` had never been
 * written, seven of the eleven ranking criteria were dead on real data, and two
 * of the seven statuses were unreachable by construction.
 *
 * That is not a missing feature. It is §24's own sentence arriving at a ledger
 * rather than at a state machine: **a state that says "waiting" which nobody
 * can resolve is not waiting, it is stuck** — and the eighth time this file has
 * had to write it. A surface that prints *nothing has read a payment term for
 * this* every tick, for ever, with nothing that could ever read one, teaches a
 * person to stop reading the surface.
 *
 * ---------------------------------------------------------------------------
 * It is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * There is no agent here, no queue, no scheduler and no second evidence
 * system. A commission creates a **Russell candidate** and lets the path that
 * already exists do all of it: `judgeCandidate` asks the archive first,
 * `compiler.ts` writes the specification, `RUSSELL_MONETIZATION_ATTRIBUTE_V1`
 * decides whether it may start, `nextLaunchable` orders it against everything
 * else waiting, the durable queue leases the work, `gateFragment` applies all
 * seven evidence conditions, and all three audit roles decide whether the
 * report stands. Every one of those is untouched, and none of them is
 * duplicated.
 *
 * What is new is one row saying *Brain asked this, about this possibility,
 * about this attribute, for this reason* — `industry_rounds`' shape one axis
 * along, because that table already solved the identical problem.
 *
 * ---------------------------------------------------------------------------
 * The selection rule, and why it is derived rather than tuned
 * ---------------------------------------------------------------------------
 *
 * The instruction is to prioritize by decision value, and — the half that
 * actually constrains anything — to **avoid spending work on attributes whose
 * answers cannot change a decision.** A weighted score over "importance" would
 * be the invented-judgement §8 keeps out of state, at the field where it would
 * cost real research capacity. So the rule is read off the ranking that already
 * exists:
 *
 * The order is **lexicographic**. Two neighbours are separated by the *first*
 * criterion they differ on, and `explainRanking` says so in those words:
 * *nothing below that was consulted.* So an attribute that feeds only criteria
 * **below** the one already separating a path from its neighbour cannot move
 * it, however well it is answered. That is not a heuristic — it is the sort
 * function read backwards, and it is the whole of the "cannot change a
 * decision" test.
 *
 * It has teeth exactly where it should. A path already separated from both
 * neighbours at `STATUS` — the first criterion — can only be moved by
 * something that changes its status, which is a load-bearing question or one
 * of the four readings that can make it weak. Asking what it is up against
 * competitively would be spending a research activation to learn something the
 * sort function will never reach.
 */
import { ATTRIBUTE } from '../../../domain/monetization.ts';
import { CRITERIA, compareOn } from './rank.ts';
import type { RankableEntry } from './rank.ts';
import type { LedgerEntry } from './ledger.ts';
import { MONETIZATION_ATTRIBUTES } from '../../../domain/types.ts';
import type {
  MonetizationAttribute,
  MonetizationCommission,
  MonetizationStatus,
} from '../../../domain/types.ts';

/**
 * How many questions one project may have in flight at once.
 *
 * **A concurrency bound, and deliberately not an allowance.** §24 removed three
 * lifetime quotas from the standing authority and recorded why: the
 * subscription behind a research mission is already paid for, so a count of
 * missions measured a starting point and then became a permanent wall. Nothing
 * here is scarce in that sense either.
 *
 * What *is* real is capacity. The fleet has a measured fire ceiling, the
 * discovery grant has its own concurrency, and the industry kernel already
 * takes four. A ledger that queued a question for every open attribute on every
 * possibility would push every deep dive on an opening already found behind
 * several hundred of them, which is precisely the "actionable work sitting
 * behind background work" the validation ordering exists to prevent.
 *
 * Three, under the kernel's four, because a possibility's attribute is the
 * narrowest and least urgent of the three kinds of question this sprint asks.
 */
export const MAX_OPEN_COMMISSIONS = 3;

/**
 * How many times one question may be asked about one possibility.
 *
 * Two, and not a ladder — `MAX_VALIDATION_ROUNDS`' reasoning verbatim, and
 * §15's rule underneath it. A third pass against the same published sources is
 * the same search a third time, which `repair.ts` refuses by name. A question
 * still open after two has an honest answer — **the sources do not publish
 * it** — and that answer is recorded, stays visible, and is never converted
 * into a negative answer to the question itself.
 */
export const MAX_COMMISSION_ROUNDS = 2;

/**
 * How long after a settled asking the same question may be asked again.
 *
 * A commission that settled UNRESOLVED yesterday will not find a different
 * published source today. `ROUND_COOL_OFF_MS` makes the same argument for the
 * industry kernel's scans; this is that constant's sibling rather than a second
 * opinion about the same thing.
 */
export const COMMISSION_COOL_OFF_MS = 24 * 60 * 60 * 1000;

/** The statuses whose open questions are worth research at all. */
const WORTH_ASKING: ReadonlySet<MonetizationStatus> = Object.freeze(
  new Set<MonetizationStatus>(['ACTIVE', 'WATCH', 'BLOCKED', 'WEAK', 'UNPROVEN']),
);

/**
 * How far down the ledger a possibility may sit and still be asked about.
 *
 * "Paths near the top" is the instruction, and near has to be a number
 * somewhere. It is deliberately wider than the five the surface shows, because
 * §49's own rule is that the top five are a *view* of the space and never the
 * space: a question that would move number nine into number four is exactly
 * the question worth asking, and a window of five could never ask it.
 *
 * It is a preference and never a ceiling. Nothing is refused for ranking
 * poorly — rules 2, 3 and 4 below reach a path at any position, and a path
 * outside the window is `declined` with that reason rather than forgotten.
 */
export const NEAR_THE_TOP = 12;

/**
 * Which ranking criteria an answer to each attribute could actually move.
 *
 * Every attribute feeds `EVIDENCE_DEPTH` and `ANSWERED`, because answering
 * anything at all raises both — that is what those two criteria count. The rest
 * is the criterion's own `order()` read off the table: `TIME_TO_CASH` reads
 * `timeToCash` and nothing else, `CONTRIBUTION` reads a revenue and a cost.
 *
 * `STATUS` is the one that takes several, and each entry in it is a branch of
 * `deriveStatus` rather than a guess: a load-bearing attribute because the last
 * open one is what holds a path at UNPROVEN, and the four weakness readings
 * because each of them is a branch that can make a path WEAK.
 *
 * `DISCOVERED` takes none, which is correct: when a possibility was found is
 * not a thing research can change.
 */
const ALWAYS: readonly string[] = Object.freeze(['EVIDENCE_DEPTH', 'ANSWERED']);

function feeds(attribute: MonetizationAttribute): readonly string[] {
  const out = [...ALWAYS];
  if (ATTRIBUTE[attribute].loadBearing) out.push('STATUS');
  switch (attribute) {
    case 'timeToCash':
      out.push('TIME_TO_CASH');
      break;
    case 'expectedRevenue':
      out.push('CONTRIBUTION');
      break;
    case 'directCosts':
      // Both: it is half of the margin, and a margin at or below zero is one of
      // the three readings `deriveStatus` calls weak.
      out.push('CONTRIBUTION', 'STATUS');
      break;
    case 'requiredCapital':
      out.push('CAPITAL_REQUIRED');
      break;
    case 'executionDifficulty':
      out.push('EXECUTION_DIFFICULTY');
      break;
    case 'competition':
      out.push('COMPETITION', 'STATUS');
      break;
    case 'repeatability':
      out.push('REPEATABILITY', 'STATUS');
      break;
    case 'scalability':
      out.push('SCALABILITY', 'STATUS');
      break;
    default:
      break;
  }
  return out;
}

/**
 * The criteria that are still deciding anything for this path.
 *
 * Against each immediate neighbour, the criteria at or above the first one they
 * already differ on. Anything below it was not consulted for that pair and
 * cannot be, so an attribute feeding only those cannot move this path past that
 * neighbour however well it is answered.
 *
 * Both neighbours, because a path can be separated from the one above by status
 * and tied with the one below on everything — and the question that would
 * settle the tie below is worth asking.
 *
 * A path with no neighbour at all — a ledger of one — has every criterion live,
 * because there is nothing yet to be separated from and the first thing that
 * arrives could be separated on anything.
 */
export function decisiveCriteria(
  entry: RankableEntry,
  neighbours: readonly RankableEntry[],
): ReadonlySet<string> {
  if (neighbours.length === 0) return new Set(CRITERIA.map((one) => one.id));
  const live = new Set<string>();
  for (const other of neighbours) {
    for (const criterion of CRITERIA) {
      live.add(criterion.id);
      if (compareOn(criterion, entry, other) !== 0) break;
    }
  }
  return live;
}

/** One question Brain proposes to ask. */
export interface CommissionAsk {
  pathId: string;
  attribute: MonetizationAttribute;
  round: number;
  /** Which rule admitted it. Lower is stronger, and the numbers are spaced. */
  ruleRank: number;
  /** Why it matters now, over the ledger as it stood when this was decided. */
  reason: string;
  /** What this is a question about, in words a person reads. */
  subject: string;
  /** The position it held. The tiebreak between asks of equal rank. */
  rank: number;
}

export interface CommissionAllocation {
  asks: CommissionAsk[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
}

export interface CommissionInput {
  /** The ledger as it stands, already ranked. */
  entries: readonly LedgerEntry[];
  /** Rankable form of the same entries, in the same order. */
  rankable: readonly RankableEntry[];
  /** Every commission ever opened in this project. */
  commissions: readonly MonetizationCommission[];
  /**
   * `pathId::attribute` for every answer whose claim has since been
   * contradicted.
   *
   * Passed in rather than read here, because this function is pure and because
   * a contradiction is a **row** — `research_claims.contradiction_state`,
   * written by `brain_report_contradiction` — and nothing in this module
   * interprets it. Composed by the pass that calls this.
   */
  contradicted: ReadonlySet<string>;
  /** How many more may be opened now. Never negative. */
  slots: number;
  now: number;
}

/**
 * What to ask next, as a pure function over a recorded snapshot.
 *
 * Pure for `services/dispatch/router.ts`' reason: *why did Brain research this*
 * has to be answerable afterwards from a recorded input rather than from a
 * re-run against a ledger that has since moved. Being pure also makes it
 * useless as a safety mechanism, and that is stated here rather than assumed —
 * two ticks may both compute this correctly and both try to open the same
 * question. The exclusion is the unique index in `openCommission`, and this
 * can under-ask and cannot over-ask.
 */
export function allocateCommissions(input: CommissionInput): CommissionAllocation {
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: CommissionAllocation['declined'] = [];
  const candidates: CommissionAsk[] = [];

  const rankableById = new Map(input.rankable.map((one) => [one.path.id, one]));
  const byPathAttribute = new Map<string, MonetizationCommission[]>();
  for (const one of input.commissions) {
    const key = `${one.pathId}::${one.attribute}`;
    const held = byPathAttribute.get(key);
    if (held) held.push(one);
    else byPathAttribute.set(key, [one]);
  }

  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index]!;
    const mine = rankableById.get(entry.path.id);
    if (!mine) continue;

    if (!WORTH_ASKING.has(entry.status)) {
      declined.push({
        subject: entry.path.title,
        why:
          `it is ${entry.status.toLowerCase()}, so nothing about it is waiting on an answer — ` +
          'reviving it is a decision somebody makes, not a question research settles',
      });
      continue;
    }

    const neighbours = [input.rankable[index - 1], input.rankable[index + 1]].filter(
      (one): one is RankableEntry => one !== undefined,
    );
    const decisive = decisiveCriteria(mine, neighbours);

    /*
     * Every unanswered question, **and** every answered one whose claim has
     * since been contradicted.
     *
     * The second half was missing and the rule that needed it could never
     * fire. `entry.unknowns` is attributes with no fact at all, so a
     * contradicted *answer* — which by definition has one — was never reached,
     * and `admit`'s contradiction branch was a mechanism nothing called. That
     * is the seventh time this repository has had to write that sentence, and
     * the first time I wrote one into a module whose whole purpose is removing
     * them; found by reading the diff rather than by a test, which is recorded
     * rather than quietly fixed.
     *
     * Re-asking destroys nothing. `mayReplace` refuses an `EVIDENCE` answer
     * replacing an `EVIDENCE` answer, so the recorded answer stands exactly
     * where it is and the new claim keeps its own row — §17's rule that new
     * evidence never silently overwrites old, which is why this is safe to ask
     * at all.
     */
    const contradictedHere = MONETIZATION_ATTRIBUTES.filter((attribute) =>
      input.contradicted.has(`${entry.path.id}::${attribute}`),
    );
    for (const attribute of [...entry.unknowns, ...contradictedHere]) {
      const history = byPathAttribute.get(`${entry.path.id}::${attribute}`) ?? [];

      if (history.some((one) => one.state === 'OPEN')) {
        declined.push({
          subject: `${entry.path.title} — ${ATTRIBUTE[attribute].label}`,
          why: 'Brain is already asking this and has not had the answer back yet',
        });
        continue;
      }
      /*
       * The budget counts askings that were actually researched.
       *
       * `round` stays `history.length + 1` — it is a *position*, and it has to
       * keep climbing or a second asking would collide with the first on
       * `UNIQUE (project_id, path_id, attribute, round)` and never be inserted.
       * What must not count is an `ABANDONED` one, because nothing was
       * researched and nothing refused: the possibility was put away mid-question
       * (see `abandonPutAway`), and if somebody revives it the attribute deserves
       * the budget it started with rather than half of it. §23's *a refusal is
       * not misconduct*, one table along and about the asker rather than the
       * surface.
       *
       * The sentence below says `researched` and now only ever reports rounds
       * that were — it used to count abandonments and tell a reader the
       * published sources had been searched twice when they had been searched
       * once, or not at all.
       */
      const researched = history.filter((one) => one.state !== 'ABANDONED');
      if (researched.length >= MAX_COMMISSION_ROUNDS) {
        declined.push({
          subject: `${entry.path.title} — ${ATTRIBUTE[attribute].label}`,
          why:
            `it has been researched ${researched.length} times and the published sources do not ` +
            'settle it. Asking a third time is the same search again, which is refused rather ' +
            'than repeated — the question stays open and stays visible',
        });
        continue;
      }
      const contradicted = input.contradicted.has(`${entry.path.id}::${attribute}`);
      /*
       * The last asking that actually searched, for the same reason the budget
       * counts those: the cool-off's own justification is that *the same
       * sources will not have changed*, and an abandonment consulted no
       * sources at all. A possibility revived the day after it was put away
       * would otherwise wait a day for a search that never happened.
       */
      const researchedHistory = researched;
      const last = researchedHistory[researchedHistory.length - 1];
      /*
       * The cool-off does not apply to a contradiction, and the reason is the
       * cool-off's own.
       *
       * It exists because *the same sources will not have changed* — which is
       * true of a question that simply went unanswered and is exactly what a
       * contradiction refutes: something now says otherwise, and waiting a day
       * to look at it would be waiting out a condition that has already
       * changed. It cannot loop, because `MAX_COMMISSION_ROUNDS` still bounds
       * it at one further asking.
       */
      if (
        !contradicted &&
        last?.settledAt &&
        input.now - Date.parse(last.settledAt) < COMMISSION_COOL_OFF_MS
      ) {
        declined.push({
          subject: `${entry.path.title} — ${ATTRIBUTE[attribute].label}`,
          why: 'it was researched within the last day, and the same sources will not have changed',
        });
        continue;
      }

      const moves = feeds(attribute).filter((one) => decisive.has(one));
      if (moves.length === 0) {
        declined.push({
          subject: `${entry.path.title} — ${ATTRIBUTE[attribute].label}`,
          why:
            'answering it could not change where this sits. The order is decided by the first ' +
            `criterion it differs from its neighbours on, and this question only feeds ones ` +
            'below that — so nothing would consult the answer',
        });
        continue;
      }

      const admitted = admit({
        entry,
        attribute,
        moves,
        round: history.length + 1,
        contradicted,
      });
      if (!admitted) {
        declined.push({
          subject: `${entry.path.title} — ${ATTRIBUTE[attribute].label}`,
          why:
            `it sits at #${entry.rank}, outside the ${NEAR_THE_TOP} nearest the top, and nothing ` +
            'about it is blocking, contested or contradicted — so a question here would not ' +
            'reach a decision anybody is close to making',
        });
        continue;
      }
      candidates.push(admitted);
    }
  }

  /*
   * Strongest rule first, then the possibility's own position, then its title.
   *
   * The title rather than the id is the tiebreak for `allocate`'s recorded
   * reason: the first version of the industry allocator broke ties on a
   * generated id, which is deterministic, meaningless and leaves the same
   * subjects at the back of the queue for ever.
   */
  candidates.sort(
    (a, b) => a.ruleRank - b.ruleRank || a.rank - b.rank || a.subject.localeCompare(b.subject),
  );

  const asks: CommissionAsk[] = [];
  const takenPaths = new Set<string>();
  for (const one of candidates) {
    if (asks.length >= slots) {
      declined.push({
        subject: `${one.subject} — ${ATTRIBUTE[one.attribute].label}`,
        why: `there is no free slot: ${MAX_OPEN_COMMISSIONS} questions may be open at once`,
      });
      continue;
    }
    /*
     * One live question per possibility, however many of its attributes are
     * open.
     *
     * Not a bound on the possibility — it is asked again the moment its
     * question comes back. It stops three slots going to three attributes of
     * one path while every other possibility in the ledger waits, which is the
     * shape of starvation a purely rank-ordered queue produces.
     */
    if (takenPaths.has(one.pathId)) {
      declined.push({
        subject: `${one.subject} — ${ATTRIBUTE[one.attribute].label}`,
        why: 'another question about this same possibility is being asked first',
      });
      continue;
    }
    takenPaths.add(one.pathId);
    asks.push(one);
  }
  return { asks, declined };
}

/**
 * The four reasons a question is worth asking, in the brief's own order.
 *
 * Each returns the ask with the rule that admitted it and a sentence saying
 * what was true when it did. None of them reads prose, forms a view about
 * value, or produces a number that could be mistaken for a measurement.
 */
function admit(input: {
  entry: LedgerEntry;
  attribute: MonetizationAttribute;
  moves: readonly string[];
  round: number;
  /** Whether the claim behind this path's existing answer has been contradicted. */
  contradicted: boolean;
}): CommissionAsk | null {
  const { entry, attribute, moves, round } = input;
  const label = ATTRIBUTE[attribute].label.toLowerCase();
  const base = {
    pathId: entry.path.id,
    attribute,
    round,
    subject: entry.path.title,
    rank: entry.rank,
  };
  const again = round > 1 ? ' This is the second and last time it is asked.' : '';

  /*
   * Rule 2 — a blocker keeping an otherwise promising possibility out of reach.
   *
   * Ahead of position, deliberately: a BLOCKED path ranks below every live one
   * *because* it is blocked, so a rule that reached only the top of the ledger
   * would never reach the one thing standing between a possibility and being
   * actionable. That is the ordering mistake §33 records one kernel along,
   * where capital decomposition ranked behind starting the map.
   */
  if (entry.status === 'BLOCKED') {
    return {
      ...base,
      ruleRank: 10,
      reason:
        `This possibility is blocked — ${entry.statusBecause} — and its ${label} is one of the ` +
        `questions still open. Settling it is what would let it be acted on rather than ` +
        `waited on.${again}`,
    };
  }

  /*
   * Rule 3 — a fact that decides the current position and can no longer be
   * relied on.
   *
   * A contradicted claim is a row rather than a reading: `contradiction_state`
   * is written by `brain_report_contradiction` and nothing here interprets it.
   * The path keeps its answer — §17's rule that new evidence never silently
   * overwrites old — and the question is asked again so both can stand.
   */
  if (input.contradicted) {
    return {
      ...base,
      ruleRank: 20,
      reason:
        `Its ${label} is what decides where this sits, and the claim behind that answer has ` +
        `been contradicted. The existing answer stays exactly where it is; this asks the ` +
        `question again so the two can be held against each other.${again}`,
    };
  }

  /*
   * Rule 1 — an unanswered question that could move something near the top.
   *
   * `moves` is the criteria the answer could actually reach, already
   * intersected with the ones still deciding this path's position. The window
   * is a preference and the reason says which criterion, so the decision can be
   * argued with rather than taken on trust.
   */
  if (entry.rank <= NEAR_THE_TOP) {
    return {
      ...base,
      ruleRank: 30,
      reason:
        `This sits at #${entry.rank} and its ${label} is unknown. Answering it could move ` +
        `${moves.length === 1 ? 'the criterion' : 'criteria'} still deciding its position ` +
        `(${moves.join(', ').toLowerCase().replace(/_/g, ' ')}), so the answer would change ` +
        `where it ranks rather than only what is known about it.${again}`,
    };
  }

  /*
   * Rule 4 — a decisive contrast between two possibilities competing for the
   * same discovery.
   *
   * Two ways of taking one opening that compete, are adjacent, and are missing
   * the same thing: the answer separates them, and it separates them whichever
   * way it comes out. That is the one case where a question below the window is
   * still worth an activation, and it is read from a recorded edge rather than
   * from how similar two titles look.
   */
  const competing = entry.edges.filter((one) => one.kind === 'COMPETES_WITH');
  if (competing.length > 0) {
    return {
      ...base,
      ruleRank: 40,
      reason:
        `This competes with ${competing.length} other way${
          competing.length === 1 ? '' : 's'
        } of taking the same discovery, and its ${label} is unknown on both sides. Establishing ` +
        `it is what would separate them, whichever way the answer comes out.${again}`,
    };
  }

  return null;
}
