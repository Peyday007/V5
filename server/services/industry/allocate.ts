/**
 * Which question the kernel asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason `services/dispatch/router.ts` is pure
 * ---------------------------------------------------------------------------
 *
 * A function over a recorded snapshot (and the signals read beside it), so
 * "why did Brain research that" is answerable afterwards from an input rather
 * than from a re-run against a database that has moved on. Being pure also
 * makes it useless as a safety mechanism, which is deliberate and is the same
 * split the dispatcher draws: the exclusion is the unique index on
 * `industry_rounds`, so two ticks both deciding correctly that a subject should
 * be scanned produce one round.
 *
 * ---------------------------------------------------------------------------
 * Eligibility is rules; the choice between eligible questions is a score
 * ---------------------------------------------------------------------------
 *
 * This file used to be seven rules in a fixed order with no score, on the
 * argument that weights are a judgement nobody made. The owner has now made it
 * (2026-11-14, W-2 of docs/INTELLIGENCE-RECOVERY-2026-11-14.md): Brain must
 * expand its understanding where an answer is worth most, and a fixed order
 * picked the next subject by rule number and age, so nothing asked whether an
 * answer would change anything. What stays a rule is what is a *bound* — a
 * subject with a live round of a purpose is not asked it twice, a settled round
 * waits out a cool-off, a retired subject is not offered, and capital
 * decomposition of a qualified opening is finished first because the research
 * that qualified it is already paid for. Between the questions that remain
 * eligible, the order is the sum of four parts, each in [0, 1], each written on
 * the ask and on the `INDUSTRY_ROUND_OPENED` event so the choice can be argued
 * with:
 *
 * - **information** — how much is unknown that this question can reduce: the
 *   structure underneath a subject nobody decomposed, the mechanisms never
 *   asked of it, and the commercial positions its subtree holds that no fact
 *   prices (`openWorld(...).arrangements[].unpriced`).
 * - **relevance** — live goals whose construction reaches the subject, openings
 *   it already produced, and a person having seeded it.
 * - **transfer** — mechanisms that produced openings on other subjects and have
 *   never been asked of this one.
 * - **novelty** — `1 / (1 + rounds asked about it)`.
 *
 * Equal weights, because no measurement yet says one part predicts value better
 * than another; `SCORE_WEIGHTS` is where a measured reason would change them.
 *
 * ---------------------------------------------------------------------------
 * And it explores, so a score cannot trap it
 * ---------------------------------------------------------------------------
 *
 * A pure exploit order would keep re-asking the subjects the score already
 * likes. One pick in every `EXPLORE_EVERY` — counted over every round the
 * project has ever opened, so it holds at any concurrency including one — goes
 * to the least-explored eligible subject instead, whatever its score.
 */
import {
  ROUND_COOL_OFF_MS,
  SEARCH_BUCKETS,
  type SearchBucket,
} from '../cash/discovery.ts';
import { standingOf, type WatchContext } from './verdict.ts';
import type { GraphSnapshot, NodeCoverage } from './graph.ts';
import type { CashOpportunity, IndustryRound, IndustryRoundPurpose } from '../../domain/types.ts';

/** The four parts of a selection, each in [0, 1], and how the pick was made. */
export interface AskScore {
  information: number;
  relevance: number;
  transfer: number;
  novelty: number;
  total: number;
  /** FINISH: capital of a qualified opening. EXPLOIT: by score. EXPLORE: the reserved share. */
  pick: 'FINISH' | 'EXPLOIT' | 'EXPLORE';
}

export interface Ask {
  purpose: IndustryRoundPurpose;
  nodeId: string | null;
  bucketId: string | null;
  opportunityId: string | null;
  round: number;
  /**
   * The order this ask was chosen in, lower first: capital is 100, everything
   * else is `1000 − round(score × 100)`, so the recorded rank reads as the
   * score did.
   */
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
  /** When Brain came to know about this subject: the tiebreak between equal scores. */
  since: string;
  /** The recorded input, in words — including the score parts — so the decision can be argued with. */
  why: string;
  /** The score parts this ask was chosen on. Absent on asks made elsewhere (role asks). */
  score?: AskScore;
}

/**
 * The floor on how many kernel questions may be open at once.
 *
 * Not an allowance — the subscription behind a research mission is already
 * paid for, and §24 records the cost of treating a count of missions as a
 * quota. The kernel's real bound is `kernelConcurrency`: this floor plus the
 * research surfaces sitting idle (§78, §98), never above the grant's own
 * concurrency.
 */
export const MAX_OPEN_KERNEL_ROUNDS = 4;

/**
 * How many kernel rounds may be open at once: the floor, plus one per idle
 * research surface, capped by the grant the rounds launch under.
 *
 * An unreadable spare lifts nothing (an unknown is never favourable), and a
 * grant's concurrency is never exceeded: it is a person's ceiling on research
 * in flight, and the kernel's rounds are part of that research.
 */
export function kernelConcurrency(input: { spare: number | null; grantCap: number | null }): number {
  const lifted = MAX_OPEN_KERNEL_ROUNDS + Math.max(0, Math.trunc(input.spare ?? 0));
  if (input.grantCap === null || !Number.isFinite(input.grantCap)) return lifted;
  return Math.max(0, Math.min(lifted, Math.trunc(input.grantCap)));
}

/** One pick in this many goes to the least-explored eligible subject (ε = 0.25). */
export const EXPLORE_EVERY = 4;

/** The weight of each score part. Equal until a measurement says otherwise. */
export const SCORE_WEIGHTS = Object.freeze({ information: 1, relevance: 1, transfer: 1, novelty: 1 });

/**
 * How many distinct unpriced fact keys make a subtree's pricing "wholly
 * unknown" for the information part. Six is about half the construction fact
 * vocabulary a position is priced from: past it, one more unknown changes the
 * reading little.
 */
export const UNPRICED_SATURATION = 6;

/**
 * When the whole-economy question is asked again (W-3).
 *
 * Ninety days. Classification systems revise on long cycles, but national
 * statistical agencies add and retire codes between them, and a first answer
 * is rarely complete: a quarterly re-read catches both at the cost of one
 * round, and says so plainly where nothing changed.
 */
export const BOOTSTRAP_REFRESH_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * When a subject's decomposition is asked again (W-3).
 *
 * Sixty days. Structure inside an industry — who buys, who performs the work,
 * where supply is constrained — moves faster than its classification, and a
 * one-shot map never saw anything that arrived after it. Long enough that a
 * map is not re-asked before its own children have been examined.
 */
export const MAP_REFRESH_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The tiers a piece must have reached before decomposing its capital is worth
 * a round. Capital decomposition answers a question that only matters once
 * somebody would actually pay, so it waits for qualification (`tier.ts`).
 */
const CAPITAL_READY_STATES: readonly string[] = Object.freeze(['EVIDENCE_CARD', 'READY']);

/**
 * What the kernel reads beside the snapshot, per subject. Computed by the
 * kernel (it needs goals and the construction engine), passed in so this
 * stays a pure function. Missing entries read as zero.
 */
export interface SubjectSignals {
  /** Live goals whose construction reaches each node. */
  goalsReaching: ReadonlyMap<string, number>;
  /** When the newest live goal reaching each node was set. */
  goalReachedAt: ReadonlyMap<string, string>;
  /** Distinct unpriced fact keys over the open positions of each node's subtree. */
  unpriced: ReadonlyMap<string, number>;
}

export const NO_SIGNALS: SubjectSignals = Object.freeze({
  goalsReaching: new Map<string, number>(),
  goalReachedAt: new Map<string, string>(),
  unpriced: new Map<string, number>(),
});

export interface AllocationInput {
  snapshot: GraphSnapshot;
  /** How many more rounds may be opened now. Never negative. */
  slots: number;
  /** Opportunities whose capital has already been decomposed, by id. */
  capitalDecomposed: ReadonlySet<string>;
  signals?: SubjectSignals;
  /**
   * Which purposes may be asked. The standing authority asks only BOOTSTRAP
   * and MAP: an opening search files openings into a sprint's portfolio, and
   * with no sprint there is none to file them into. Omitted, every purpose.
   */
  purposes?: readonly IndustryRoundPurpose[];
}

export interface Allocation {
  asks: Ask[];
  /** Everything considered and not asked, with the reason. Reported, not acted on. */
  declined: { subject: string; why: string }[];
}

interface Candidate {
  ask: Ask;
  /** The subject key one-ask-per-pass is about, and exploration ranks. */
  key: string;
  /** Rounds ever asked about the subject, for the exploration order. */
  asked: number;
  lastAskedAt: string | null;
  depth: number;
}

export function allocate(input: AllocationInput): Allocation {
  const { snapshot } = input;
  const signals = input.signals ?? NO_SIGNALS;
  const allowed = (purpose: IndustryRoundPurpose) => !input.purposes || input.purposes.includes(purpose);
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: Allocation['declined'] = [];
  const finish: Ask[] = [];
  const candidates: Candidate[] = [];
  const nowMs = Date.parse(snapshot.at);

  const open = snapshot.rounds.filter((one) => one.state === 'OPEN');
  const productive = productiveBuckets(snapshot.rounds);

  /*
   * The bootstrap: the whole economy, first asked when the map is empty and
   * asked again past `BOOTSTRAP_REFRESH_MS` (W-3). There is no list of
   * industries in this codebase; the sectors arrive as gated claims.
   */
  if (allowed('BOOTSTRAP')) {
    const mine = snapshot.rounds.filter((one) => one.purpose === 'BOOTSTRAP');
    const last = latest(mine.filter((one) => one.state !== 'OPEN').map((one) => one.harvestedAt ?? one.openedAt));
    if (snapshot.bootstrap.open) {
      declined.push({
        subject: 'the industry bootstrap',
        why: 'It is already running, and asking again would duplicate its spending.',
      });
    } else if (!snapshot.bootstrap.asked || (last !== null && nowMs - Date.parse(last) >= BOOTSTRAP_REFRESH_MS)) {
      const first = !snapshot.bootstrap.asked;
      const parts = scored({ information: first ? 1 : 0.5, relevance: 0, transfer: 0, novelty: 1 / (1 + mine.length) });
      candidates.push({
        key: 'bootstrap',
        asked: mine.length,
        lastAskedAt: latest(mine.map((one) => one.openedAt)),
        depth: -1,
        ask: {
          purpose: 'BOOTSTRAP',
          nodeId: null,
          bucketId: null,
          opportunityId: null,
          round: nextRound(snapshot.rounds, 'BOOTSTRAP', null, null, null, snapshot.at),
          rank: rankOf(parts),
          subject: 'the whole economy',
          since: snapshot.at,
          why: first
            ? 'The industry map is empty, so nothing has been asked what the economy contains.'
            : `What the economy contains was last asked ${days(nowMs - Date.parse(last!))} days ago, ` +
              'past the refresh, so classification revisions since then are unread.',
          score: parts,
        },
      });
    }
  }

  /*
   * Finish what has already been spent: a qualified opening with no capital
   * decomposition. A bound rather than a score — the research that found it
   * and the dive that qualified it are paid for.
   */
  if (allowed('CAPITAL')) {
    for (const opportunity of capitalWorthy(snapshot.opportunities, input.capitalDecomposed)) {
      if (open.some((one) => one.purpose === 'CAPITAL' && one.opportunityId === opportunity.id)) continue;
      /*
       * Only an opening that sits on the map: `industry_rounds` requires a node
       * on every round but the bootstrap (production, 2026-11-02).
       */
      if (!opportunity.industryNodeId) {
        declined.push({
          subject: opportunity.title,
          why: 'Its capital is not decomposed here because it was filed outside the industry map; a round needs a subject on the map.',
        });
        continue;
      }
      finish.push({
        purpose: 'CAPITAL',
        nodeId: opportunity.industryNodeId,
        bucketId: null,
        opportunityId: opportunity.id,
        round: nextRound(snapshot.rounds, 'CAPITAL', opportunity.industryNodeId, null, opportunity.id, snapshot.at),
        rank: 100,
        subject: opportunity.title,
        since: opportunity.createdAt,
        why:
          `"${opportunity.title}" has been qualified and nothing has decomposed what capital it ` +
          'actually requires, so it cannot be compared against the money available.',
        score: { information: 1, relevance: 1, transfer: 0, novelty: 0, total: 2, pick: 'FINISH' },
      });
    }
  }

  const byId = new Map(snapshot.nodes.map((one) => [one.id, one]));
  const live = snapshot.coverage.filter((one) => one.node.retiredAt === null);
  for (const coverage of live) {
    const nodeId = coverage.node.id;
    const subject = coverage.path.join(' → ');
    const mineRounds = snapshot.rounds.filter((one) => one.nodeId === nodeId);
    const unasked = SEARCH_BUCKETS.filter((one) => !coverage.bucketsAsked.has(one.id));
    const productiveUnasked = unasked.filter((one) => productive.has(one.id) && productiveOn(snapshot.rounds, one.id, nodeId));
    const standing = standingOf(coverage, snapshot.opportunities, {
      now: snapshot.at,
      goalReachedAt: signals.goalReachedAt.get(nodeId) ?? null,
      adjacentOpeningAt: adjacentOpeningAt(coverage, byId, snapshot.opportunities),
      productiveUnasked: allowed('SCAN') ? productiveUnasked.map((one) => one.id) : [],
    });
    if (standing.verdict === 'DEAD_END') {
      declined.push({ subject, why: standing.because });
      continue;
    }
    if (standing.watch && standing.watch.reopenedBy === null) {
      declined.push({ subject, why: standing.because });
      continue;
    }
    const reopened = standing.watch?.reopenedBy ?? null;

    const goals = signals.goalsReaching.get(nodeId) ?? 0;
    const unpriced = Math.min(1, (signals.unpriced.get(nodeId) ?? 0) / UNPRICED_SATURATION);
    const relevance = Math.min(
      1,
      0.5 * Math.min(goals, 2) + 0.25 * Math.min(coverage.openings, 2) + (coverage.node.origin === 'SEED' ? 0.25 : 0),
    );
    const novelty = 1 / (1 + mineRounds.length);
    const transferShare = productive.size === 0 ? 0 : productiveUnasked.length / productive.size;
    const options: Ask[] = [];
    const because = (text: string) => (reopened ? `${text} It was barren and is reopened: ${reopened}.` : text);
    const relevanceWords = [
      goals > 0 ? `${goals} live goal${goals === 1 ? '' : 's'} reach it` : null,
      coverage.openings > 0 ? `${coverage.openings} opening${coverage.openings === 1 ? '' : 's'} already came from it` : null,
      coverage.node.origin === 'SEED' ? 'a person seeded it' : null,
    ].filter((one): one is string => one !== null);

    /* An opening search: a mechanism never asked of it, or a re-read past the cool-off. */
    if (allowed('SCAN') && !coverage.scanOpen) {
      if (unasked.length > 0) {
        const bucket = productiveUnasked[0] ?? unasked[0]!;
        const parts = scored({
          information: 0.7 * (unasked.length / SEARCH_BUCKETS.length) + 0.3 * unpriced,
          relevance,
          transfer: productive.has(bucket.id) ? 1 : 0,
          novelty,
        });
        options.push({
          purpose: 'SCAN',
          nodeId,
          bucketId: bucket.id,
          opportunityId: null,
          round: nextRound(snapshot.rounds, 'SCAN', nodeId, bucket.id, null, snapshot.at),
          rank: rankOf(parts),
          subject,
          since: coverage.node.createdAt,
          why: because(
            coverage.scanRounds === 0
              ? `Nothing has ever searched ${subject} for an opening${relevanceWords.length ? `, and ${relevanceWords.join(', ')}` : ''}.`
              : `${unasked.length} of the ${SEARCH_BUCKETS.length} ways money is reachable have never been asked of ${subject}` +
                  `${relevanceWords.length ? `, and ${relevanceWords.join(', ')}` : ''}.`,
          ),
          score: parts,
        });
      } else if (pastCoolOff(coverage, snapshot.at)) {
        const bucket = leastAsked(snapshot.rounds, nodeId);
        const parts = scored({ information: 0.25 + 0.3 * unpriced, relevance, transfer: 0, novelty });
        options.push({
          purpose: 'SCAN',
          nodeId,
          bucketId: bucket.id,
          opportunityId: null,
          round: nextRound(snapshot.rounds, 'SCAN', nodeId, bucket.id, null, snapshot.at),
          rank: rankOf(parts),
          subject,
          since: coverage.node.createdAt,
          why: because(
            `Every way money is reachable has been asked of ${subject} at least once, ` +
              `${coverage.scanFound} opening${coverage.scanFound === 1 ? '' : 's'} came out, and the cool-off has passed.`,
          ),
          score: parts,
        });
      }
    }

    /*
     * A decomposition: never asked, or asked again past `MAP_REFRESH_MS` (W-3).
     * `kindRecurses` is what stops this running forever — a bottleneck and a
     * buyer type are leaves of understanding.
     */
    if (allowed('MAP') && coverage.recurses && !coverage.mapOpen) {
      const maps = mineRounds.filter((one) => one.purpose === 'MAP' && one.state !== 'OPEN');
      const lastMap = latest(maps.map((one) => one.harvestedAt ?? one.openedAt));
      const fresh = coverage.mapRounds === 0;
      if (fresh || (lastMap !== null && nowMs - Date.parse(lastMap) >= MAP_REFRESH_MS)) {
        const parts = scored({
          information: 0.7 * (fresh ? 1 : 0.5) + 0.3 * unpriced,
          relevance,
          transfer: transferShare * 0.5,
          novelty,
        });
        options.push({
          purpose: 'MAP',
          nodeId,
          bucketId: null,
          opportunityId: null,
          round: nextRound(snapshot.rounds, 'MAP', nodeId, null, null, snapshot.at),
          rank: rankOf(parts),
          subject,
          since: coverage.node.createdAt,
          why: because(
            fresh
              ? `Nothing has established what sits underneath ${subject}` +
                  `${relevanceWords.length ? `, and ${relevanceWords.join(', ')}` : ''}.`
              : `What sits underneath ${subject} was last decomposed ${days(nowMs - Date.parse(lastMap!))} days ago, ` +
                  'past the refresh, so structure that arrived since is unread.',
          ),
          score: parts,
        });
      }
    }

    if (options.length === 0) continue;
    /* One question per subject per pass, so breadth is not starved: its best one. */
    options.sort((a, b) => b.score!.total - a.score!.total || purposeOrder(a) - purposeOrder(b));
    candidates.push({
      ask: options[0]!,
      key: nodeId,
      asked: mineRounds.length,
      lastAskedAt: coverage.lastAskedAt,
      depth: coverage.depth,
    });
  }

  return select({ finish, candidates, slots, sequence: snapshot.rounds.length, declined });
}

/**
 * Choose up to `slots` asks: finishing first, then by score, with every
 * `EXPLORE_EVERY`-th pick over the project's history reserved for the
 * least-explored eligible subject.
 */
function select(input: {
  finish: Ask[];
  candidates: Candidate[];
  slots: number;
  sequence: number;
  declined: Allocation['declined'];
}): Allocation {
  const { declined } = input;
  const asks: Ask[] = [];
  const taken = new Set<string>();
  const full = (ask: Ask) =>
    declined.push({ subject: ask.subject, why: 'There is no free slot this pass. It is the next thing asked when one opens.' });

  input.finish.sort((a, b) => a.since.localeCompare(b.since) || compareAsk(a, b));
  for (const ask of input.finish) {
    const key = ask.opportunityId ?? ask.nodeId ?? '';
    if (asks.length >= input.slots) {
      full(ask);
      continue;
    }
    taken.add(key);
    asks.push(ask);
  }

  const byScore = [...input.candidates].sort(
    (a, b) => b.ask.score!.total - a.ask.score!.total || a.ask.since.localeCompare(b.ask.since) || compareAsk(a.ask, b.ask),
  );
  const byExploration = [...input.candidates].sort(
    (a, b) =>
      a.asked - b.asked ||
      (a.lastAskedAt ?? '').localeCompare(b.lastAskedAt ?? '') ||
      a.depth - b.depth ||
      a.ask.since.localeCompare(b.ask.since) ||
      compareAsk(a.ask, b.ask),
  );

  const remaining = Math.max(0, input.slots - asks.length);
  let exploreSlots = 0;
  for (let index = 0; index < remaining; index += 1) {
    if ((input.sequence + index) % EXPLORE_EVERY === EXPLORE_EVERY - 1) exploreSlots += 1;
  }

  const explored: Ask[] = [];
  const exploited: Ask[] = [];
  const take = (candidate: Candidate, pick: AskScore['pick']): Ask => {
    taken.add(candidate.key);
    const score = { ...candidate.ask.score!, pick };
    return { ...candidate.ask, score, why: `${candidate.ask.why} ${describe(score)}` };
  };
  /*
   * Exploitation first so the reserved share goes to a subject the score did
   * not already take; exploration picks are placed ahead of them in the result
   * so a caller that trims the tail (expand's role-slot reservation) trims an
   * exploit, never the reserved exploration.
   */
  for (const candidate of byScore) {
    if (exploited.length >= remaining - exploreSlots) break;
    if (taken.has(candidate.key)) continue;
    exploited.push(take(candidate, 'EXPLOIT'));
  }
  for (const candidate of byExploration) {
    if (explored.length >= exploreSlots) break;
    if (taken.has(candidate.key)) continue;
    explored.push(take(candidate, 'EXPLORE'));
  }
  // An exploration slot nothing unexplored could fill goes back to the score.
  for (const candidate of byScore) {
    if (explored.length + exploited.length >= remaining) break;
    if (taken.has(candidate.key)) continue;
    exploited.push(take(candidate, 'EXPLOIT'));
  }
  asks.push(...explored, ...exploited);

  // One candidate per subject, so a subject not taken simply found no slot.
  for (const candidate of byScore) {
    if (!taken.has(candidate.key)) full(candidate.ask);
  }
  return { asks, declined };
}

function scored(parts: Omit<AskScore, 'total' | 'pick'>): AskScore {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const information = round3(clamp(parts.information));
  const relevance = round3(clamp(parts.relevance));
  const transfer = round3(clamp(parts.transfer));
  const novelty = round3(clamp(parts.novelty));
  const total = round3(
    SCORE_WEIGHTS.information * information +
      SCORE_WEIGHTS.relevance * relevance +
      SCORE_WEIGHTS.transfer * transfer +
      SCORE_WEIGHTS.novelty * novelty,
  );
  return { information, relevance, transfer, novelty, total, pick: 'EXPLOIT' };
}

function rankOf(score: AskScore): number {
  return 1000 - Math.round(score.total * 100);
}

/** The score parts in words, appended to `why` so the recorded reason carries them. */
export function describe(score: AskScore): string {
  const how =
    score.pick === 'EXPLORE'
      ? `chosen as exploration (one pick in ${EXPLORE_EVERY} goes to the least-explored subject)`
      : score.pick === 'FINISH'
        ? 'chosen to finish work already paid for'
        : 'chosen by score';
  return (
    `[score ${score.total.toFixed(2)} = information ${score.information.toFixed(2)} + relevance ` +
    `${score.relevance.toFixed(2)} + transfer ${score.transfer.toFixed(2)} + novelty ` +
    `${score.novelty.toFixed(2)}; ${how}]`
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function days(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

/** On a tie, a search before a decomposition: the cheaper question, and the map follows next pass. */
function purposeOrder(ask: Ask): number {
  return ask.purpose === 'SCAN' ? 0 : 1;
}

/** Mechanism buckets that produced openings anywhere on the map. */
function productiveBuckets(rounds: readonly IndustryRound[]): Set<string> {
  const out = new Set<string>();
  for (const one of rounds) {
    if (one.purpose === 'SCAN' && one.bucketId && (one.found ?? 0) > 0) out.add(one.bucketId);
  }
  return out;
}

/** Whether a bucket produced openings on a subject other than this one. */
function productiveOn(rounds: readonly IndustryRound[], bucketId: string, nodeId: string): boolean {
  return rounds.some((one) => one.purpose === 'SCAN' && one.bucketId === bucketId && one.nodeId !== nodeId && (one.found ?? 0) > 0);
}

/** The newest opening filed on this subject's parent, siblings or children. */
function adjacentOpeningAt(
  coverage: NodeCoverage,
  byId: ReadonlyMap<string, { id: string; parentId: string | null }>,
  opportunities: readonly CashOpportunity[],
): string | null {
  const self = coverage.node;
  const near = new Set<string>();
  if (self.parentId) near.add(self.parentId);
  for (const node of byId.values()) {
    if (node.id === self.id) continue;
    if (node.parentId === self.id) near.add(node.id);
    if (self.parentId && node.parentId === self.parentId) near.add(node.id);
  }
  return latest(
    opportunities.filter((one) => one.industryNodeId !== null && near.has(one.industryNodeId)).map((one) => one.createdAt),
  );
}

function capitalWorthy(
  opportunities: readonly CashOpportunity[],
  decomposed: ReadonlySet<string>,
): CashOpportunity[] {
  return opportunities.filter(
    (one) => CAPITAL_READY_STATES.includes(one.state) && !decomposed.has(one.id),
  );
}

/** The last resort when score and age are both equal. Stable, never meaningful. */
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

function latest(values: readonly string[]): string | null {
  let out: string | null = null;
  for (const value of values) if (out === null || value > out) out = value;
  return out;
}

/**
 * The mechanism this subject has been asked about least, and least recently.
 * Deterministic: count, then the oldest last-asking, then declared order.
 */
function leastAsked(rounds: readonly IndustryRound[], nodeId: string): SearchBucket {
  const mine = rounds.filter((one) => one.purpose === 'SCAN' && one.nodeId === nodeId);
  const scoredBuckets = SEARCH_BUCKETS.map((bucket, order) => {
    const asked = mine.filter((one) => one.bucketId === bucket.id);
    const last = asked.reduce((newest, one) => (one.openedAt > newest ? one.openedAt : newest), '');
    return { bucket, count: asked.length, last, order };
  });
  scoredBuckets.sort((a, b) => a.count - b.count || a.last.localeCompare(b.last) || a.order - b.order);
  return scoredBuckets[0]!.bucket;
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
