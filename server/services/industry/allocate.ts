/**
 * Which question the kernel asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason `services/dispatch/router.ts` is pure
 * ---------------------------------------------------------------------------
 *
 * A function over a recorded snapshot, so "why did Brain research that" is
 * answerable afterwards from an input rather than from a re-run against a
 * database that has moved on. Being pure also makes it useless as a safety
 * mechanism, which is deliberate and is the same split the dispatcher draws:
 * the exclusion is the unique index on `industry_rounds`, so two ticks both
 * deciding correctly that a subject should be scanned produce one round.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic over rules, never a weighted score
 * ---------------------------------------------------------------------------
 *
 * Seven rules in a fixed order, each one a statement about what Brain has
 * already learned. There is no scoring function here because a score needs
 * weights, weights are a judgement nobody made, and the resulting number reads
 * like a measurement — `portfolio.ts` settled this for opportunities and
 * nothing about subjects changes the argument.
 *
 * The order is the brief's own priority: **finish what has already been spent
 * before starting the next search**, then deepen where evidence says money is,
 * then fill the blind spots, then come back to what has gone quiet. That first
 * clause is already in this codebase as `CompilerProfile.launchOrdinal`, and
 * production measured what its absence cost — twenty openings found and both
 * of their deep dives queued behind fifty broad searches.
 *
 * ---------------------------------------------------------------------------
 * It stops
 * ---------------------------------------------------------------------------
 *
 * Three bounds, and each is a bound rather than a preference. A subject with a
 * live round of a purpose is not asked that question twice at once. A settled
 * round waits out a cool-off. And a subject that has been searched
 * `BARREN_ROUNDS` times for nothing and decomposed into nothing is not offered
 * again — not because looking is forbidden, but because Brain has now
 * documented that there is nothing there, and §13's rule about the archive
 * applies to Brain's own history exactly as it applies to a project's.
 */
import {
  BARREN_ROUNDS,
  ROUND_COOL_OFF_MS,
  SEARCH_BUCKETS,
  type SearchBucket,
} from '../cash/discovery.ts';
import { standingOf } from './verdict.ts';
import type { GraphSnapshot, NodeCoverage } from './graph.ts';
import type { CashOpportunity, IndustryRound, IndustryRoundPurpose } from '../../domain/types.ts';

export interface Ask {
  purpose: IndustryRoundPurpose;
  nodeId: string | null;
  bucketId: string | null;
  opportunityId: string | null;
  round: number;
  /** Which rule admitted it. Lower is stronger, and the numbers are spaced. */
  rank: number;
  /**
   * What this is about, in words a person reads.
   *
   * Carried on the ask rather than resolved by each reader, because the first
   * version left every decline reading `ind_d947baf680e046138443: there is no
   * free slot` — technically true and useless, and §29 records what a status
   * nobody can read costs: they stop reading it.
   */
  subject: string;
  /**
   * When Brain came to know about this subject. The tiebreak between asks of
   * equal rank.
   *
   * Eleven sectors with no evidence between them are genuinely equal, and the
   * first version broke that tie on the generated node id — which is
   * deterministic, meaningless, and leaves the same subjects at the back of
   * the queue for ever. Oldest first is the order the map grew in, so every
   * subject gets a turn and nothing waits indefinitely because of how its id
   * happened to sort.
   */
  since: string;
  /** The recorded input, in words, so the decision can be argued with. */
  why: string;
}

/**
 * How many kernel questions may be open at once.
 *
 * Not an allowance — the subscription behind a research mission is already
 * paid for, and §24 records the cost of treating a count of missions as a
 * quota. It is a *concurrency* bound, which is the one limit in this area that
 * is real: the fleet has a measured fire ceiling, the discovery grant has its
 * own concurrency, and a kernel that queued fifty subjects at once would push
 * every deep dive on an opening already found behind them.
 */
export const MAX_OPEN_KERNEL_ROUNDS = 4;

/**
 * The tiers a piece must have reached before decomposing its capital is worth
 * a round.
 *
 * Capital decomposition is expensive and it answers a question that only
 * matters once somebody would actually pay: a piece with no established payer
 * has nothing to be capitalized *for*. So it waits for qualification, which is
 * `tier.ts`'s reading rather than a second opinion about the same rows.
 */
const CAPITAL_READY_STATES: readonly string[] = Object.freeze(['EVIDENCE_CARD', 'READY']);

export interface AllocationInput {
  snapshot: GraphSnapshot;
  /** How many more rounds may be opened now. Never negative. */
  slots: number;
  /** Opportunities whose capital has already been decomposed, by id. */
  capitalDecomposed: ReadonlySet<string>;
}

export interface Allocation {
  asks: Ask[];
  /** Everything considered and not asked, with the reason. Reported, not acted on. */
  declined: { subject: string; why: string }[];
}

export function allocate(input: AllocationInput): Allocation {
  const { snapshot } = input;
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: Allocation['declined'] = [];
  const candidates: Ask[] = [];

  const open = snapshot.rounds.filter((one) => one.state === 'OPEN');
  const openByPurpose = (purpose: IndustryRoundPurpose, nodeId: string | null) =>
    open.some((one) => one.purpose === purpose && one.nodeId === nodeId);

  /*
   * Rule 2 — the bootstrap.
   *
   * There is no list of industries in this codebase and this is why: the first
   * question the kernel asks is which sectors the authoritative classification
   * systems declare, and the sectors arrive as gated claims. A constant here
   * would answer the question the kernel exists to ask.
   *
   * **It is not the first rule, and the first version of this file had it
   * there.** Writing the map is the broadest, longest-horizon question the
   * kernel asks, and the brief is explicit that long-horizon research must not
   * consume the fleet while immediate cash sits underexplored. A qualified
   * opening whose capital nobody has decomposed is the most immediate thing
   * there is — the research that found it and the deep dive that qualified it
   * are both already paid for — so it goes first. On a pass with free slots
   * both are asked anyway; the order only decides which waits when they are
   * scarce, and the thing that waits should be the map rather than the money.
   */
  if (!snapshot.bootstrap.asked) {
    candidates.push({
      purpose: 'BOOTSTRAP',
      nodeId: null,
      bucketId: null,
      opportunityId: null,
      round: 1,
      rank: 150,
      subject: 'the whole economy',
      since: snapshot.at,
      why: 'The industry map is empty, so nothing has been asked what the economy contains.',
    });
  } else if (snapshot.bootstrap.open) {
    declined.push({
      subject: 'the industry bootstrap',
      why: 'It is already running, and asking again would duplicate its spending.',
    });
  }

  /*
   * Rule 1 — finish what has already been spent.
   *
   * A qualified opening with no capital decomposition is the most expensive
   * thing in the system to leave alone: the research that found it and the
   * deep dive that qualified it are both paid for, and without this round
   * nobody can say what it would actually take to do.
   */
  for (const opportunity of capitalWorthy(snapshot.opportunities, input.capitalDecomposed)) {
    if (open.some((one) => one.purpose === 'CAPITAL' && one.opportunityId === opportunity.id)) {
      continue;
    }
    candidates.push({
      purpose: 'CAPITAL',
      nodeId: opportunity.industryNodeId,
      bucketId: null,
      opportunityId: opportunity.id,
      round: nextRound(snapshot.rounds, 'CAPITAL', null, null, opportunity.id, snapshot.at),
      rank: 100,
      subject: opportunity.title,
      since: opportunity.createdAt,
      why:
        `"${opportunity.title}" has been qualified and nothing has decomposed what capital it ` +
        'actually requires, so it cannot be compared against the money available.',
    });
  }

  const live = snapshot.coverage.filter((one) => one.node.retiredAt === null);
  for (const coverage of live) {
    const standing = standingOf(coverage, snapshot.opportunities);
    if (standing.verdict === 'DEAD_END') {
      declined.push({ subject: coverage.path.join(' → '), why: standing.because });
      continue;
    }

    /*
     * Rule 2 — deepen where the evidence already says money is.
     *
     * A subject that produced an opening under one mechanism is proven ground
     * for the other nine. This outranks opening a subject nobody has looked at
     * because the brief is explicit about it: research effort follows evidence
     * of accessible short-stage cash, and a subject that has produced one is
     * the only kind of evidence of that Brain can actually hold.
     */
    const unasked = SEARCH_BUCKETS.filter((one) => !coverage.bucketsAsked.has(one.id));
    if (coverage.openings > 0 && unasked.length > 0 && !coverage.scanOpen) {
      const bucket = unasked[0]!;
      candidates.push({
        purpose: 'SCAN',
        nodeId: coverage.node.id,
        bucketId: bucket.id,
        opportunityId: null,
        round: nextRound(snapshot.rounds, 'SCAN', coverage.node.id, bucket.id, null, snapshot.at),
        rank: 200 + coverage.depth,
        subject: coverage.path.join(' → '),
        since: coverage.node.createdAt,
        why:
          `${coverage.openings} opening${coverage.openings === 1 ? '' : 's'} already came from ` +
          `${coverage.path.join(' → ')}, and ${unasked.length} of the ten ways money is ` +
          'reachable have never been asked of it.',
      });
    }

    /*
     * Rule 3 — drill into what worked.
     *
     * The recursion the brief asks for, and the condition it turns on is
     * evidence rather than enthusiasm: a subject only earns decomposition once
     * something has actually been found in it.
     */
    if (
      coverage.openings > 0 &&
      coverage.recurses &&
      coverage.children === 0 &&
      !coverage.mapOpen &&
      coverage.mapRounds === 0
    ) {
      candidates.push({
        purpose: 'MAP',
        nodeId: coverage.node.id,
        bucketId: null,
        opportunityId: null,
        round: nextRound(snapshot.rounds, 'MAP', coverage.node.id, null, null, snapshot.at),
        rank: 300 + coverage.depth,
        subject: coverage.path.join(' → '),
        since: coverage.node.createdAt,
        why:
          `${coverage.path.join(' → ')} produced openings and nothing has established what sits ` +
          'underneath it, so the narrower subjects where the money actually is are invisible.',
      });
    }

    /*
     * Rule 4 — the blind spots.
     *
     * "Which economically important areas have we barely examined" is the
     * brief's own periodic question, and it is answered by a row: a subject
     * with no settled scan has been examined zero times. Shallowest first, so
     * breadth across the economy comes before depth in one corner of it.
     */
    if (coverage.scanRounds === 0 && !coverage.scanOpen) {
      const bucket = unasked[0] ?? SEARCH_BUCKETS[0]!;
      candidates.push({
        purpose: 'SCAN',
        nodeId: coverage.node.id,
        bucketId: bucket.id,
        opportunityId: null,
        round: nextRound(snapshot.rounds, 'SCAN', coverage.node.id, bucket.id, null, snapshot.at),
        rank: 400 + coverage.depth,
        subject: coverage.path.join(' → '),
        since: coverage.node.createdAt,
        why: `Nothing has ever searched ${coverage.path.join(' → ')} for an opening.`,
      });
    }

    /*
     * Rule 5 — decompose what has never been decomposed.
     *
     * Behind every scan, because the brief is a cash sprint: a subject that
     * has never been searched for money is worth searching before it is worth
     * anatomizing. `kindRecurses` is what stops this running forever — a
     * bottleneck and a buyer type are leaves of understanding, and mapping
     * them would produce a graph of adjectives.
     */
    if (coverage.recurses && coverage.mapRounds === 0 && !coverage.mapOpen) {
      candidates.push({
        purpose: 'MAP',
        nodeId: coverage.node.id,
        bucketId: null,
        opportunityId: null,
        round: nextRound(snapshot.rounds, 'MAP', coverage.node.id, null, null, snapshot.at),
        rank: 500 + coverage.depth,
        subject: coverage.path.join(' → '),
        since: coverage.node.createdAt,
        why: `Nothing has established what sits underneath ${coverage.path.join(' → ')}.`,
      });
    }

    /*
     * Rule 6 — come back to what has gone quiet.
     *
     * Published requests appear daily, so a settled scan is a reading of one
     * moment rather than a final answer. Most productive first, and only past
     * the cool-off, which is what keeps "ongoing" from becoming "uncontrolled".
     */
    if (
      coverage.scanRounds > 0 &&
      !coverage.scanOpen &&
      unasked.length === 0 &&
      pastCoolOff(coverage, snapshot.at) &&
      !(coverage.scanRounds >= BARREN_ROUNDS && coverage.scanFound === 0)
    ) {
      /*
       * The mechanism that has been asked of this subject least, and least
       * recently.
       *
       * The first version reached for `SEARCH_BUCKETS[0]` every time, so a
       * subject past its cool-off was re-asked the same one question for ever
       * and the other nine were never revisited. The bucket a re-scan picks is
       * not a tuning decision — it is the difference between a subject being
       * re-examined and one question being repeated.
       */
      const bucket = leastAsked(snapshot.rounds, coverage.node.id);
      candidates.push({
        purpose: 'SCAN',
        nodeId: coverage.node.id,
        bucketId: bucket.id,
        opportunityId: null,
        round: nextRound(snapshot.rounds, 'SCAN', coverage.node.id, bucket.id, null, snapshot.at),
        rank: 600 - Math.min(99, coverage.scanFound),
        subject: coverage.path.join(' → '),
        since: coverage.node.createdAt,
        why:
          `Every way money is reachable has been asked of ${coverage.path.join(' → ')} at least ` +
          `once, ${coverage.scanFound} opening${coverage.scanFound === 1 ? '' : 's'} came out, ` +
          'and the cool-off has passed.',
      });
    }
  }

  candidates.sort(
    (a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || compareAsk(a, b),
  );

  /*
   * One question per subject per pass.
   *
   * Without it a subject that qualifies under three rules takes three of the
   * four slots and everything else waits — which is the failure the dispatcher
   * already had to correct once, where one bin's refusal ended the whole
   * burst. Breadth is the point of a coverage engine.
   */
  const taken = new Set<string>();
  const asks: Ask[] = [];
  for (const ask of candidates) {
    if (asks.length >= slots) {
      declined.push({
        subject: ask.subject,
        why: 'There is no free slot this pass. It is the next thing asked when one opens.',
      });
      continue;
    }
    const key = ask.opportunityId ?? ask.nodeId ?? 'bootstrap';
    if (taken.has(key)) {
      declined.push({
        subject: ask.subject,
        why: 'Something else about the same subject is being asked this pass.',
      });
      continue;
    }
    taken.add(key);
    asks.push(ask);
  }
  return { asks, declined };
}

function capitalWorthy(
  opportunities: readonly CashOpportunity[],
  decomposed: ReadonlySet<string>,
): CashOpportunity[] {
  return opportunities.filter(
    (one) => CAPITAL_READY_STATES.includes(one.state) && !decomposed.has(one.id),
  );
}

/** The last resort when rank and age are both equal. Stable, never meaningful. */
function compareAsk(a: Ask, b: Ask): number {
  return (
    (a.nodeId ?? '').localeCompare(b.nodeId ?? '') ||
    (a.bucketId ?? '').localeCompare(b.bucketId ?? '') ||
    (a.opportunityId ?? '').localeCompare(b.opportunityId ?? '')
  );
}

function pastCoolOff(coverage: NodeCoverage, now: string): boolean {
  const settled = coverage.lastSettledAt;
  if (!settled) return false;
  return Date.parse(now) - Date.parse(settled) >= ROUND_COOL_OFF_MS;
}

/**
 * The mechanism this subject has been asked about least, and least recently.
 *
 * Deterministic in both dialects: count first, then the oldest last-asking,
 * then the bucket's own declared order — which never ties, because the ids are
 * distinct constants.
 */
function leastAsked(rounds: readonly IndustryRound[], nodeId: string): SearchBucket {
  const mine = rounds.filter((one) => one.purpose === 'SCAN' && one.nodeId === nodeId);
  const scored = SEARCH_BUCKETS.map((bucket, order) => {
    const asked = mine.filter((one) => one.bucketId === bucket.id);
    const last = asked.reduce((newest, one) => (one.openedAt > newest ? one.openedAt : newest), '');
    return { bucket, count: asked.length, last, order };
  });
  scored.sort(
    (a, b) => a.count - b.count || a.last.localeCompare(b.last) || a.order - b.order,
  );
  return scored[0]!.bucket;
}

/** The next asking of one exact question, from what has already been asked. */
export function nextRound(
  rounds: readonly IndustryRound[],
  purpose: IndustryRoundPurpose,
  nodeId: string | null,
  bucketId: string | null,
  opportunityId: string | null,
  _now: string,
): number {
  const mine = rounds.filter(
    (one) =>
      one.purpose === purpose &&
      one.nodeId === nodeId &&
      one.bucketId === bucketId &&
      one.opportunityId === opportunityId,
  );
  return mine.reduce((highest, one) => Math.max(highest, one.round), 0) + 1;
}
