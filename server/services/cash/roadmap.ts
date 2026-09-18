/**
 * What Brain is researching, counted from rows it already wrote.
 *
 * The activity log answers "what happened"; it is a stream of events and it is
 * the wrong instrument for "where is this up to". This is the second question,
 * and every number in it is a `COUNT` over a table that already existed —
 * `cash_discovery_rounds`, `russell_missions`, `research_fragments`,
 * `cash_opportunities`. No column was added and no migration was needed, which
 * is the whole reason this file is a projection rather than a feature.
 *
 * **It writes nothing, and that is structural rather than a promise.** It calls
 * four `list*` readers and counts what comes back. There is no transition, no
 * enqueue, no claim, no compare-and-swap and no repository function here that
 * could take one — a dashboard that could nudge the work it is describing would
 * be a second orchestration path, and §27's sentence about a second universe
 * applies to a read model exactly as it applies to a runner.
 *
 * **The denominator is the plan's, never a constant.** A round's planned item
 * count is however many fragments its mission's orchestration actually holds;
 * if that is nineteen across ten mechanisms then nineteen and ten is what this
 * reports. There is no target anywhere in this file, and `percent` is
 * deliberately absent: discovery is open-ended by mandate (§30 —
 * `RUSSELL_CASH_DISCOVERY_V1` bounds what may be *done*, not how much there is
 * to find), so a completion percentage over it would be a fraction of a number
 * nobody knows. What is bounded is a *round*, so a round is what carries a
 * fraction.
 *
 * **A stage nobody has reached reads zero rather than absent.** Zero
 * opportunities validated is a fact about today; it must not read the same as a
 * pipeline that does not exist, which is invariant 39 at a screen.
 */
import { listRounds } from '../../repos/cashDiscovery.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { getOrchestration, listFragments } from '../../repos/research.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import { FRAGMENT_STATUSES } from '../../domain/types.ts';
import type {
  CashDiscoveryRound,
  CashOpportunity,
  FragmentStatus,
  ResearchFragment,
} from '../../domain/types.ts';

/** One line of the research plan, in the words a person reads. */
export interface RoadmapStage {
  key: string;
  label: string;
  count: number;
  /** What this stage means, without an internal code in it. */
  note: string;
}

/**
 * What is *actually* happening to a round, as opposed to what its state column
 * says.
 *
 * `cash_discovery_rounds.state` says OPEN until the round is harvested, and in
 * production all ten rounds of the live sprint read OPEN while every one of
 * their candidates was parked and no work item existed anywhere. A screen that
 * shows that as research underway is the status that contradicts the control
 * beside it — §29's own defect, and the reason it is worth a derived column.
 *
 *   AWAITING_LAUNCH  the idea is captured and has not been judged yet.
 *   PARKED           it was judged and cannot proceed. `blocker` says why.
 *   RESEARCHING      a mission is running and its fragments are with a worker.
 *   ANSWERED         the mission finished; what it found is being harvested.
 */
export const ROUND_ACTIVITIES = [
  'AWAITING_LAUNCH',
  'PARKED',
  'RESEARCHING',
  'ANSWERED',
] as const;
export type RoundActivity = (typeof ROUND_ACTIVITIES)[number];

export interface RoadmapRound {
  roundId: string;
  /** The search bucket this round asked, and which asking it is. */
  bucketId: string;
  mechanism: string;
  round: number;
  state: CashDiscoveryRound['state'];
  openedAt: string;
  /**
   * Openings this round produced, once it has been counted.
   *
   * **Null while the round is OPEN**, and that is the correction rather than a
   * nicety. `cash_discovery_rounds.found` is `NOT NULL DEFAULT 0` and is
   * written by exactly one statement — `closeRound`, which is guarded on
   * `state = 'OPEN'` and moves the round out of it. So on a live round the
   * column is the default, meaning *not counted yet*, and the comment that used
   * to sit here said the opposite: "zero is a finding, not a blank". It is a
   * finding on a settled round and a blank on every other, and this projection
   * only ever returns live ones — so in production every `found` it published
   * was a blank being read as a measurement. The Cash page said "0 openings
   * found" about rounds that had produced thirty-one signals between them.
   *
   * The two readers of the *row* rather than this field are unaffected and were
   * already right: `nextRoundFor` returns before its barren check whenever any
   * round is OPEN, so what it and `questionFor` see is always settled.
   */
  found: number | null;
  /**
   * The plan behind it: how many fragments its mission actually holds, and
   * where each one is. Null when the round has no mission yet — which is a real
   * state (the idea is captured and not yet launched) rather than zero work.
   */
  plan: {
    orchestrationId: string;
    planned: number;
    byStatus: Record<FragmentStatus, number>;
    /** The questions currently being worked, as the fragments themselves state them. */
    inFlight: string[];
  } | null;
  /** What is actually happening, derived rather than read off `state`. */
  activity: RoundActivity;
  /**
   * Why it is not moving, in the words whoever stopped it recorded.
   *
   * Null when it is moving. Never composed here: it is the candidate's own
   * reason, or the packet's own failure reason, because a dashboard that
   * paraphrased a blocker would eventually paraphrase it wrongly.
   */
  blocker: string | null;
}

export interface CashRoadmap {
  /** Every mechanism this sprint has opened a round for. The plan's own breadth. */
  mechanisms: string[];
  rounds: { open: number; harvested: number; abandoned: number; total: number };
  /** The live rounds, newest first. What Brain is researching right now. */
  active: RoadmapRound[];
  /** Fragment counts across every live round, so the plan has one total. */
  research: {
    planned: number;
    byStatus: Record<FragmentStatus, number>;
  };
  /** What discovery has produced, counted by the state each piece is in. */
  pipeline: RoadmapStage[];
  /** One sentence naming the next thing that moves, derived from the counts. */
  whatHappensNext: string;
}

function emptyCounts(): Record<FragmentStatus, number> {
  const out = {} as Record<FragmentStatus, number>;
  for (const status of FRAGMENT_STATUSES) out[status] = 0;
  return out;
}

function add(into: Record<FragmentStatus, number>, from: Record<FragmentStatus, number>): void {
  for (const status of FRAGMENT_STATUSES) into[status] += from[status];
}

/**
 * The plan behind one round.
 *
 * Read through the candidate the round already names: the round holds the idea,
 * the idea's latest mission holds the orchestration, and the orchestration holds
 * the fragments. Every hop is an existing foreign key, so nothing here infers a
 * link that a row does not already state.
 */
async function planFor(round: CashDiscoveryRound): Promise<RoadmapRound['plan']> {
  const mission = await latestMissionForCandidate(round.candidateId);
  if (!mission?.orchestrationId) return null;

  const fragments: ResearchFragment[] = await listFragments(mission.orchestrationId);
  const byStatus = emptyCounts();
  for (const fragment of fragments) byStatus[fragment.status] += 1;

  return {
    orchestrationId: mission.orchestrationId,
    planned: fragments.length,
    byStatus,
    /*
     * The fragment's own question, never a summary of it. A dashboard that
     * paraphrased what a worker was researching would eventually paraphrase it
     * wrongly, and the question is the one thing already written in words.
     */
    inFlight: fragments
      .filter((one) => one.status === 'RUNNING' || one.status === 'VALIDATING')
      .map((one) => one.question)
      .filter((question): question is string => typeof question === 'string' && question.length > 0),
  };
}

/**
 * What is really happening to one round, and why it is not moving.
 *
 * Every branch reads a row Brain wrote. A parked candidate carries the reason
 * `judgeCandidate` recorded — most often that no standing authority existed,
 * which was true of all ten production rounds — and a stopped packet carries
 * its own failure reason. Nothing here composes a blocker out of counts.
 */
async function activityOf(
  round: CashDiscoveryRound,
  plan: RoadmapRound['plan'],
): Promise<{ activity: RoundActivity; blocker: string | null }> {
  const candidate = await getCandidate(round.candidateId);
  if (candidate && candidate.state === 'PARKED') {
    return {
      activity: 'PARKED',
      blocker:
        candidate.reason ??
        'This idea was judged and parked, and its reason was not recorded.',
    };
  }
  if (!plan) {
    return {
      activity: 'AWAITING_LAUNCH',
      blocker: null,
    };
  }
  const packet = await getOrchestration(plan.orchestrationId);
  if (packet && (packet.status === 'NEEDS_HUMAN' || packet.status === 'FAILED')) {
    return {
      activity: 'PARKED',
      blocker:
        packet.failureReason ??
        packet.cancelReason ??
        'The research stopped and is waiting for a person.',
    };
  }
  const working =
    plan.byStatus.RUNNING + plan.byStatus.VALIDATING + plan.byStatus.QUEUED + plan.byStatus.PLANNED;
  if (working > 0) return { activity: 'RESEARCHING', blocker: null };
  return { activity: 'ANSWERED', blocker: null };
}

function pipelineOf(opportunities: CashOpportunity[]): RoadmapStage[] {
  const count = (...states: CashOpportunity['state'][]): number =>
    opportunities.filter((one) => states.includes(one.state)).length;

  return [
    {
      key: 'DISCOVERED',
      label: 'Openings found',
      count: count('DISCOVERED'),
      note: 'Harvested from an accepted research claim. The card is still blank.',
    },
    {
      key: 'VALIDATING',
      label: 'Being qualified',
      count: opportunities.filter(
        (one) => one.validationState === 'PENDING' || one.validationState === 'RUNNING',
      ).length,
      note:
        'A bounded deep dive is establishing who pays, what it pays, what it costs and what ' +
        'would rule it out. Published sources only; nothing is contacted or spent.',
    },
    {
      key: 'CARD_READY',
      label: 'Cards complete',
      count: opportunities.filter((one) => one.validationState === 'COMPLETE').length,
      note: 'The deep dive finished. What it could not establish is listed as unknown.',
    },
    {
      key: 'EVIDENCE_CARD',
      label: 'Being validated',
      count: count('EVIDENCE_CARD'),
      note: 'A card exists and Brain is filling in what is load-bearing and unknown.',
    },
    {
      key: 'READY',
      label: 'Ready to test',
      count: count('READY'),
      note: 'Every load-bearing field is answered. Executing one needs your authorization.',
    },
    {
      key: 'EXECUTING',
      label: 'Being pursued',
      count: count('EXECUTING', 'DELIVERING'),
      note: 'An action was recorded against a grant you gave.',
    },
    {
      key: 'COLLECTED',
      label: 'Collected',
      count: count('COLLECTED'),
      note: 'Delivered and settled.',
    },
    {
      key: 'CLOSED',
      label: 'Declined or archived',
      count: count('DECLINED', 'ARCHIVED'),
      note: 'Kept with its reason. Nothing is deleted.',
    },
  ];
}

/**
 * The next thing that moves, named from the counts and from nothing else.
 *
 * Ordered by what actually unblocks the most: a person's decision first,
 * because nothing downstream of it can proceed; then work already in flight;
 * then the honest "nothing is running" when that is the truth. §6 forbids
 * dressing the last one up.
 */
function nextStep(input: {
  ready: number;
  validating: number;
  running: number;
  queued: number;
  blocked: number;
  openRounds: number;
  /** Rounds that are open and cannot move, with the first one's own reason. */
  parkedRounds: number;
  firstBlocker: string | null;
}): string {
  /*
   * A round that cannot move is named first, whatever else is happening.
   *
   * In production ten rounds read OPEN, every candidate was parked for want of
   * a standing authority, no work item existed, and this sentence said a
   * discovery round was open and its research had not been planned yet. That
   * is true and it is the wrong thing to say: it reads as patience when what
   * was needed was a fix. A screen that describes a stall as progress teaches
   * a person to stop reading it.
   */
  if (input.parkedRounds > 0 && input.running === 0 && input.queued === 0) {
    return (
      `${input.parkedRounds} discovery round${input.parkedRounds === 1 ? ' is' : 's are'} open ` +
      `and cannot proceed: ${input.firstBlocker ?? 'the reason was not recorded'}`
    );
  }
  if (input.ready > 0) {
    return `${input.ready} opportunit${input.ready === 1 ? 'y is' : 'ies are'} ready to test. Executing one needs a standing authorization from you.`;
  }
  if (input.validating > 0) {
    return `Brain is filling in the load-bearing blanks on ${input.validating} card${input.validating === 1 ? '' : 's'}. Each becomes ready to test once nothing decisive is unknown.`;
  }
  if (input.running > 0) {
    return `${input.running} research question${input.running === 1 ? ' is' : 's are'} with a worker now. Accepted claims become openings; refused ones keep their reason.`;
  }
  if (input.queued > 0) {
    return `${input.queued} research question${input.queued === 1 ? ' is' : 's are'} queued and waiting for a worker to be fired at ${input.queued === 1 ? 'it' : 'them'}.`;
  }
  if (input.blocked > 0) {
    return `${input.blocked} research question${input.blocked === 1 ? ' is' : 's are'} blocked. Each keeps the reason it stopped; nothing retries a strategy that already failed.`;
  }
  if (input.openRounds > 0) {
    return 'A discovery round is open and its research has not been planned yet.';
  }
  return 'Nothing is running. No discovery round is open and no research is queued.';
}

/**
 * How many rounds are read at once.
 *
 * The rounds were read with an unbounded `Promise.all`, on the reasoning that a
 * dashboard walking them one at a time would take longer than the tick that
 * produces the rows — which is true, and is not the whole story. Each round
 * costs several queries, so the fan-out is a multiple of however many rounds a
 * sprint happens to have, and the cloud Postgres is reached through a pooler in
 * session mode where every connection is a client.
 *
 * Production measured it at 52 ideas: the reader died with
 * `EMAXCONNSESSION max clients reached in session mode — pool_size: 15`, and
 * because `cashRoadmap` is part of `cashView`, that is the Cash page failing to
 * load rather than a report failing to print. **A dashboard that cannot be read
 * is worse than a slow one**, and the size of a sprint is exactly the thing that
 * must not decide whether its own screen works.
 *
 * Four keeps the parallelism that made this fast and leaves the pool room for
 * the requests it is shared with. It is a bound rather than a target: a sprint
 * with three rounds still reads all three at once.
 */
const ROUNDS_READ_AT_ONCE = 4;

/**
 * `Promise.all` with a ceiling, preserving input order.
 *
 * Order matters here: `plans` and `activities` are zipped back against `live` by
 * index, so a helper that returned completions in finishing order would quietly
 * attach one round's plan to another round's row.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Read the roadmap. Nothing here writes.
 *
 * The rounds are read once and their plans in parallel — bounded, because the
 * fan-out is otherwise a multiple of however many rounds a sprint has and the
 * pooled connection is not. See `ROUNDS_READ_AT_ONCE`.
 */
export async function cashRoadmap(projectId: string): Promise<CashRoadmap> {
  const [rounds, opportunities] = await Promise.all([
    listRounds(projectId),
    listOpportunities({ projectId }),
  ]);

  const live = rounds.filter((one) => one.state === 'OPEN');
  const plans = await mapBounded(live, ROUNDS_READ_AT_ONCE, (one) => planFor(one));
  const activities = await mapBounded(live, ROUNDS_READ_AT_ONCE, (round, index) =>
    activityOf(round, plans[index] ?? null),
  );

  const research = { planned: 0, byStatus: emptyCounts() };
  const active: RoadmapRound[] = live.map((round, index) => {
    const plan = plans[index] ?? null;
    if (plan) {
      research.planned += plan.planned;
      add(research.byStatus, plan.byStatus);
    }
    const state = activities[index]!;
    return {
      roundId: round.id,
      bucketId: round.bucketId,
      mechanism: round.mechanism,
      round: round.round,
      state: round.state,
      openedAt: round.openedAt,
      // Not counted until something counted it. See the field's own note.
      found: round.state === 'OPEN' ? null : round.found,
      plan,
      activity: state.activity,
      blocker: state.blocker,
    };
  });

  const pipeline = pipelineOf(opportunities);
  const stage = (key: string): number => pipeline.find((one) => one.key === key)?.count ?? 0;

  return {
    // Every mechanism a round has been opened for, including closed ones: the
    // breadth of the plan is what has been asked, not what is asking today.
    mechanisms: [...new Set(rounds.map((one) => one.mechanism))].sort(),
    rounds: {
      open: live.length,
      harvested: rounds.filter((one) => one.state === 'HARVESTED').length,
      abandoned: rounds.filter((one) => one.state === 'ABANDONED').length,
      total: rounds.length,
    },
    active,
    research,
    pipeline,
    whatHappensNext: nextStep({
      parkedRounds: active.filter((one) => one.activity === 'PARKED').length,
      firstBlocker: active.find((one) => one.activity === 'PARKED')?.blocker ?? null,
      ready: stage('READY'),
      validating: stage('EVIDENCE_CARD') + stage('VALIDATING'),
      running: research.byStatus.RUNNING,
      queued: research.byStatus.QUEUED,
      blocked: research.byStatus.BLOCKED,
      openRounds: live.length,
    }),
  };
}
