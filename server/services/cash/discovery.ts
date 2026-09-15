/**
 * Where a sprint's opportunities actually come from.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * Activating a sprint wrote a mode row and an event and nothing else — no goal,
 * no candidate, no mission, no queued job — and `capture` had exactly two
 * production callers: a person pressing a button, and the reoffer service.
 * Neither research writeback nor connected-site ingestion fed the portfolio. So
 * a freshly activated sprint could sit empty indefinitely beside a perfectly
 * healthy research fleet, while the screen said discovery had started.
 *
 * This module is the two halves that were missing, and the whole design rests
 * on one rule: **Brain decomposes; it never invents a finding.**
 *
 * ---------------------------------------------------------------------------
 * Half one: the buckets are the decomposition
 * ---------------------------------------------------------------------------
 *
 * Turning "maximize additional usable cash" into a researchable question is not
 * something a compiler may do — it is a judgement about the world, and §8 keeps
 * those out of state. What a compiler *can* do is fill a template, and the
 * plan's own search-bucket table is exactly that: a closed set of declared
 * places to look, each with what to look for and what makes something eligible.
 *
 * So each bucket becomes one captured idea per sprint, and from there the
 * existing path does everything: `judgeCandidate` checks the archive first
 * (§13), `compileMission` writes the specification against the envelope, the
 * approval envelope decides whether it may start, the evidence gate decides
 * what may be claimed, and the three audit roles decide whether it stands.
 * Nothing here bypasses any of that, and nothing here is a second pipeline.
 *
 * ---------------------------------------------------------------------------
 * Half two: a lane is a row, so a signal is not a judgement
 * ---------------------------------------------------------------------------
 *
 * Turning a finished mission into opportunities looks like it needs a reader:
 * which of these accepted claims is an *opening*? It does not, because the lane
 * is structural. `MARKET_DISCOVERY` declares `demand_signal` as a REQUIRED
 * evidence lane, a claim records which lane it fills, and the gate has already
 * refused anything unsourced. So "this claim is a demand signal" is a column,
 * and the harvest reads it rather than reading prose.
 *
 * What comes out is an opportunity in `DISCOVERED` with its **card blank**, and
 * that is the honest shape: a published request is evidence that somebody asked
 * for something, and it is not a payer, a price or a delivery path. Those are
 * the unknowns the card then names as tasks — §30's rule that an unknown is
 * never a favourable assumption, arriving at the moment an opportunity is born
 * rather than being asserted away by whoever created it.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import {
  createOpportunity,
  opportunityForClaim,
  updateOpportunity,
} from '../../repos/cashPortfolio.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import {
  closeRound,
  listRounds,
  openRound,
  openRoundsByCandidate,
} from '../../repos/cashDiscovery.ts';
import { citableClaims } from '../../repos/research.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { discoveryAllowed } from './lifecycle.ts';
import type {
  CashDiscoveryRound,
  CashMechanism,
  CashOpportunity,
} from '../../domain/types.ts';

/**
 * The plan's own search buckets, in code.
 *
 * Each one is a *place to look*, not a finding. The question is a template with
 * no fill: the sprint's objective is context a worker reads on the mission, and
 * putting it inside the question would make one sprint's specification differ
 * from another's for the same bucket — which breaks `launch()`'s rule that one
 * specification is researchable once.
 *
 * `OTHER` is deliberately absent. A bucket is something Brain knows how to ask
 * about; "something else" is not a question, and a producer that emitted one
 * would be asking a worker to decide what to research.
 */
export interface SearchBucket {
  id: string;
  mechanism: CashMechanism;
  title: string;
  question: string;
}

export const SEARCH_BUCKETS: readonly SearchBucket[] = Object.freeze([
  {
    id: 'explicit-paid-request',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    title: 'Who is publicly asking to pay for work right now',
    question:
      'Which buyers have published a paid request, brief, posting or listing for work that ' +
      'could be delivered within weeks — naming who asked, what they asked for, what it pays ' +
      'and when it closes?',
  },
  {
    id: 'supply-demand-mismatch',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Where a buyer and an available supplier are not meeting',
    question:
      'Where is there a published demand and a published available supply that are not ' +
      'currently connected — naming both sides, what each has said, and any licensing or ' +
      'platform restriction that decides whether connecting them is permitted?',
  },
  {
    id: 'temporary-exploit',
    mechanism: 'TEMPORARY_EXPLOIT',
    title: 'Which openings are about to close',
    question:
      'Which published openings — an expiring request, a stated closing date, an announced ' +
      'change of price or terms, a limited remaining quantity — are time-bounded, and what ' +
      'does the source say about when and why they end?',
  },
  {
    id: 'pain-triggered-implementation',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    title: 'Which businesses have published evidence of a problem worth paying to fix',
    question:
      'Which specific businesses have published evidence of operational friction — a notice, ' +
      'a complaint they answered, a stated backlog, a job posting describing the gap — beyond ' +
      'an unattractive website, and who at each one can approve paying for a fix?',
  },
  {
    id: 'resale-or-asset',
    mechanism: 'RESALE_OR_ASSET',
    title: 'Which assets have published demand and a favourable spread',
    question:
      'Which assets or deliverables have both a published asking price and published evidence ' +
      'of demand at a higher one, and what do the sources say about rights, delivery and how ' +
      'much remains?',
  },
]);

const OPENED = 'CASH_DISCOVERY_OPENED';
const HARVESTED = 'CASH_OPPORTUNITY_HARVESTED';

/** The lane a claim must fill to be an opening rather than context. */
export const SIGNAL_LANE = 'demand_signal';

/**
 * The lanes whose claims can be an opening at all.
 *
 * One entry today, and a set rather than a comparison because the point is
 * that the *other* declared lanes are not openings: `economics` says what
 * something pays, `deliverability` says whether it can be done, and
 * `demand_absence` and `demand_closed` say there is nothing here or there is
 * no longer. All four are evidence worth keeping and none of them is a piece
 * of work.
 *
 * This was a single comparison against `demand_signal` with a comment saying
 * the lane was "the whole of" whether something is an opening. It is not: a
 * lane says what *kind* of evidence a claim is, and "a regional authority
 * published a paid request" and "nobody in this market is asking" are the same
 * kind of evidence with opposite answers.
 */
export const OPENING_LANES: ReadonlySet<string> = new Set([SIGNAL_LANE]);

export interface OpenedDiscovery {
  bucketId: string;
  candidateId: string;
  /** Which asking this is. A bucket is re-asked while the sprint is active. */
  round: number;
}

/**
 * Start the sprint's discovery, once per bucket.
 *
 * Idempotent by rows rather than by a flag: a `CASH_DISCOVERY_OPENED` event
 * carries the bucket it opened, events are append-only and never deleted, and
 * the check is "has this bucket been opened in this project". A flag can be set
 * by a tick that then dies; rows cannot.
 *
 * Gated by `discoveryAllowed`, which is the same gate `capture` is behind — so
 * a wound-down sprint opens nothing new, and reactivating it opens whatever it
 * had not reached yet rather than starting again.
 */
export async function openDiscovery(input: {
  projectId: string;
  limit?: number;
  now?: string;
}): Promise<OpenedDiscovery[]> {
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed || !gate.mode) return [];
  const mode = gate.mode;
  const now = input.now ?? new Date().toISOString();

  /*
   * What has been asked, from the table that exists to remember it.
   *
   * This used to read `listCashEvents(projectId, 500)` — the **activity display
   * window** — so a month of ordinary sprint activity pushed the opening events
   * out of it and every bucket was opened again as a duplicate. A display
   * window is not an index.
   */
  const rounds = await listRounds(input.projectId);
  const byBucket = new Map<string, CashDiscoveryRound[]>();
  for (const round of rounds) {
    byBucket.set(round.bucketId, [...(byBucket.get(round.bucketId) ?? []), round]);
  }

  const out: OpenedDiscovery[] = [];
  const limit = Math.max(1, input.limit ?? 1);
  for (const bucket of SEARCH_BUCKETS) {
    if (out.length >= limit) break;
    const history = byBucket.get(bucket.id) ?? [];
    const next = nextRoundFor(history, now);
    if (next === null) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: next === 1 ? bucket.title : `${bucket.title} (round ${next})`,
      statement: questionFor(bucket, mode.objective, next, history),
    });

    const opened = await openRound({
      projectId: input.projectId,
      cashModeId: mode.id,
      bucketId: bucket.id,
      mechanism: bucket.mechanism,
      round: next,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `Discovery opened: ${bucket.title} (round ${next}).`,
      detail: {
        bucketId: bucket.id,
        mechanism: bucket.mechanism,
        candidateId: candidate.id,
        cashModeId: mode.id,
        round: next,
        objective: mode.objective,
      },
    });
    out.push({ bucketId: bucket.id, candidateId: candidate.id, round: next });
  }
  return out;
}

/**
 * How long a finished bucket waits before Brain asks it again.
 *
 * A sprint that searched once in its first hour and never again is not what a
 * month of broad discovery is for — published requests appear daily, and the
 * buckets are places to look rather than questions with final answers. So a
 * round is re-asked, and the cool-off is what keeps "ongoing" from becoming
 * "uncontrolled": one re-ask per bucket per day, and only once the previous
 * round has actually been answered.
 */
export const ROUND_COOL_OFF_MS = 24 * 60 * 60 * 1000;

/** How many times Brain will re-ask a bucket that keeps finding nothing. */
export const BARREN_ROUNDS = 3;

/**
 * Which round of this bucket to open now, or null for none.
 *
 * Three conditions, and each one is a bound rather than a preference. A bucket
 * with a live round is not asked twice at once, because the second would
 * duplicate the first's spending. A finished round waits out the cool-off. And
 * a bucket whose last `BARREN_ROUNDS` rounds all found nothing stops — not
 * because looking is forbidden, but because Brain has now documented that
 * there is nothing there, and re-asking is the allowance spent to learn it
 * again. That is §13's rule about the archive, applied to Brain's own history.
 */
export function nextRoundFor(history: CashDiscoveryRound[], now: string): number | null {
  if (history.some((one) => one.state === 'OPEN')) return null;
  if (history.length === 0) return 1;

  const ordered = [...history].sort((a, b) => a.round - b.round);
  const last = ordered[ordered.length - 1]!;
  const settledAt = last.harvestedAt ?? last.openedAt;
  if (Date.parse(now) - Date.parse(settledAt) < ROUND_COOL_OFF_MS) return null;

  const recent = ordered.slice(-BARREN_ROUNDS);
  if (recent.length >= BARREN_ROUNDS && recent.every((one) => one.found === 0)) return null;

  return last.round + 1;
}

/**
 * The question this round actually asks.
 *
 * The sprint's objective was recorded in the event and left out of the
 * candidate, so the thing a worker read was the bucket's generic template and
 * the thing that said what the sprint was *for* was in a row nobody downstream
 * opened. The objective is context rather than an instruction — it says which
 * openings are worth reporting, and it cannot widen the envelope, the evidence
 * gate or the source classes, all of which are the compiler's.
 *
 * A later round says what the earlier ones already covered, so the worker is
 * looking for what is new rather than re-reporting what Brain already holds.
 */
export function questionFor(
  bucket: SearchBucket,
  objective: string,
  round: number,
  history: readonly CashDiscoveryRound[],
): string {
  const parts = [bucket.question, `This is for a short cash sprint whose goal is: ${objective}`];
  if (round > 1) {
    const found = history.reduce((total, one) => total + one.found, 0);
    parts.push(
      `Brain has asked this ${round - 1} time${round === 2 ? '' : 's'} before and filed ${found} ` +
        'opening' + (found === 1 ? '' : 's') + '. Report what has been published since, and say ' +
        'so plainly where nothing has.',
    );
  }
  return parts.join(' ');
}

/**
 * Which bucket each live candidate is asking, from the rounds table.
 *
 * Read by key rather than scanned out of the last 500 events, which is what
 * made a busy sprint stop harvesting its own research entirely: with the
 * opening events out of the window this map came back empty and `harvest`
 * returned nothing at all.
 */
async function liveRounds(
  projectId: string,
): Promise<Map<string, { round: CashDiscoveryRound; bucket: SearchBucket }>> {
  const byId = new Map(SEARCH_BUCKETS.map((bucket) => [bucket.id, bucket]));
  const out = new Map<string, { round: CashDiscoveryRound; bucket: SearchBucket }>();
  for (const [candidateId, round] of await openRoundsByCandidate(projectId)) {
    const bucket = byId.get(round.bucketId);
    if (bucket) out.set(candidateId, { round, bucket });
  }
  return out;
}

export interface Harvested {
  opportunity: CashOpportunity;
  claimId: string;
  missionId: string;
}

/**
 * Turn what discovery found into pieces of the portfolio.
 *
 * Reads finished missions rather than being hooked to the moment one finishes,
 * which is the third time this repository has needed that distinction: a hook
 * fixes one entrance, and rows reach every entrance plus everything already
 * stranded. A mission that completed before this existed is harvested on the
 * next tick.
 *
 * **Not gated by the sprint's lifecycle**, and that is deliberate. Filing what
 * a mission already found is not new discovery — the spending happened when the
 * mission ran — and dropping results because the sprint wound down in the
 * meantime would throw away work already paid for. Winding down stops
 * `openDiscovery`; it does not stop the answers arriving.
 */
export async function harvest(input: {
  projectId: string;
  limit?: number;
}): Promise<Harvested[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const live = await liveRounds(input.projectId);
  if (live.size === 0) return [];

  const missions = (await listMissions({ projectId: input.projectId })).filter(
    (mission) =>
      mission.state === 'DONE' &&
      mission.candidateId !== null &&
      live.has(mission.candidateId) &&
      mission.orchestrationId !== null,
  );

  const out: Harvested[] = [];
  const limit = Math.max(1, input.limit ?? 20);
  for (const mission of missions) {
    if (out.length >= limit) break;
    const { bucket, round } = live.get(mission.candidateId!)!;
    let foundHere = 0;

    /*
     * The citable set, not the accepted-fragment one.
     *
     * A bucket question is deliberately broad — "which buyers have published a
     * paid request" — so a fragment answering it will often fall short on
     * *coverage* while every claim it produced passed the seven-condition gate
     * on its own. `acceptedClaims` would discard all of them for that, which is
     * the exact defect `citableClaims` was written for one altitude up: a
     * five-state question answered for one state, with the other four states'
     * verified facts thrown away. A gated claim is a real observation whether
     * or not the question around it was fully settled.
     *
     * What does not change is what the claim *is*. Coverage is not weakened
     * here, because an opening is a single observation rather than an answer to
     * the bucket.
     */
    for (const claim of await citableClaims(mission.orchestrationId!)) {
      if (out.length >= limit) break;
      // A lane is a row. This is the whole of "is this an opening" — no prose
      // is read, and the gate has already refused anything unsourced.
      if (!OPENING_LANES.has(claim.evidenceLane ?? '')) continue;
      if (!claim.sourceUrl) continue;
      /*
       * A documented absence is a finding, and it is not an opening.
       *
       * `NEGATIVE_EXISTENCE` is a claim type the research standards already
       * recognise — it is how "nothing published says anyone is asking" is
       * established at all — and filing one as an opportunity would put
       * *nobody is asking* into the portfolio as a piece of work. The lane says
       * what kind of evidence a claim is; the claim type says whether it found
       * something or established that there was nothing.
       */
      if (claim.claimType === 'NEGATIVE_EXISTENCE') continue;
      if (await opportunityForClaim(input.projectId, claim.id)) continue;

      const created = await createOpportunity({
        projectId: input.projectId,
        cashModeId: mode.id,
        ownerUserId: mode.ownerUserId,
        title: clamp(claim.claim, 160),
        mechanism: bucket.mechanism,
        currency: mode.currency,
        source: claim.sourcePublisher ?? claim.sourceTitle ?? claim.sourceUrl,
        /*
         * The bucket is where this came from, never what it is.
         *
         * `candidateId` means "the Russell idea this opportunity is", and the
         * wind-down guard reads exactly that column to tell new discovery from
         * research supporting an existing obligation. A bucket question found
         * dozens of unrelated openings and is research about none of them, so
         * writing it there would make the guard read a discovery bucket as
         * support work the moment any one of its openings started executing —
         * and re-open the bucket during a wind-down that had stopped it.
         */
        discoveredByCandidateId: mission.candidateId,
        sourceClaimId: claim.id,
        nextAction:
          'Establish who can approve payment and how to reach them. The source says somebody ' +
          'asked; it does not say who pays.',
      });

      /*
       * The signal, and only the signal.
       *
       * A published request is evidence that somebody asked for something. It
       * is not a payer, a price, an acceptance condition or a delivery path,
       * and writing any of those from it would be the favourable assumption the
       * card exists to refuse. They stay unknown, which is what makes them
       * appear as tasks.
       */
      const withSignal = await updateOpportunity(created.id, {
        buying_signal: clamp(claim.claim, 1_000),
        signal_observed_at: claim.sourceDate ?? claim.retrievedAt ?? null,
      });

      await recordCashEvent({
        projectId: input.projectId,
        opportunityId: created.id,
        kind: HARVESTED,
        actorRef: 'BRAIN',
        summary: `An opening was harvested from a claim in "${bucket.title}".`,
        detail: {
          bucketId: bucket.id,
          claimId: claim.id,
          missionId: mission.id,
          sourceUrl: claim.sourceUrl,
        },
      });

      foundHere += 1;
      out.push({ opportunity: withSignal ?? created, claimId: claim.id, missionId: mission.id });
    }

    /*
     * The round is settled by its own bookkeeping, not by the loop ending.
     *
     * `found` is what decides whether this bucket is worth asking again, so a
     * round that produced nothing has to record *nothing* rather than simply
     * stop being open. Guarded on OPEN, so two ticks reading one finished
     * mission settle it once — and a round that hit the per-tick limit stays
     * open, because the claims it has not reached yet are still its own.
     */
    if (out.length < limit) await closeRound({ id: round.id, to: 'HARVESTED', found: foundHere });
  }
  return out;
}

function clamp(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (tidy.length <= max) return tidy;
  const cut = tidy.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * One project's discovery step, for the tick.
 *
 * Opening and harvesting in one call because they are one idea — start what has
 * not started, file what has finished — and because a caller that could do one
 * without the other is a caller that eventually does.
 */
export async function runDiscovery(projectId: string): Promise<{
  opened: OpenedDiscovery[];
  harvested: Harvested[];
}> {
  // One read answers both halves for the many projects that hold no sprint at
  // all, which is what makes this cheap enough to run for every project on
  // every tick.
  if (!(await getCashMode(projectId))) return { opened: [], harvested: [] };
  return {
    opened: await openDiscovery({ projectId, limit: 1 }),
    harvested: await harvest({ projectId, limit: 10 }),
  };
}
