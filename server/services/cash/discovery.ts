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
import { getCashMode, listCashEvents, recordCashEvent } from '../../repos/cashMode.ts';
import {
  createOpportunity,
  opportunityForClaim,
  updateOpportunity,
} from '../../repos/cashPortfolio.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { citableClaims } from '../../repos/research.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { discoveryAllowed } from './lifecycle.ts';
import type { CashMechanism, CashOpportunity } from '../../domain/types.ts';

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

export interface OpenedDiscovery {
  bucketId: string;
  candidateId: string;
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
}): Promise<OpenedDiscovery[]> {
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed || !gate.mode) return [];

  const already = new Set(
    (await listCashEvents(input.projectId, 500))
      .filter((event) => event.kind === OPENED)
      .map((event) => String(event.detail['bucketId'] ?? '')),
  );

  const out: OpenedDiscovery[] = [];
  const limit = Math.max(1, input.limit ?? 1);
  for (const bucket of SEARCH_BUCKETS) {
    if (out.length >= limit) break;
    if (already.has(bucket.id)) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: bucket.title,
      statement: bucket.question,
    });

    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `Discovery opened: ${bucket.title}.`,
      detail: {
        bucketId: bucket.id,
        mechanism: bucket.mechanism,
        candidateId: candidate.id,
        cashModeId: gate.mode.id,
        objective: gate.mode.objective,
      },
    });
    out.push({ bucketId: bucket.id, candidateId: candidate.id });
  }
  return out;
}

/** Which bucket a candidate was opened for, from the events. */
async function bucketsByCandidate(projectId: string): Promise<Map<string, SearchBucket>> {
  const byId = new Map(SEARCH_BUCKETS.map((bucket) => [bucket.id, bucket]));
  const out = new Map<string, SearchBucket>();
  for (const event of await listCashEvents(projectId, 500)) {
    if (event.kind !== OPENED) continue;
    const candidateId = String(event.detail['candidateId'] ?? '');
    const bucket = byId.get(String(event.detail['bucketId'] ?? ''));
    if (candidateId && bucket) out.set(candidateId, bucket);
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

  const buckets = await bucketsByCandidate(input.projectId);
  if (buckets.size === 0) return [];

  const missions = (await listMissions({ projectId: input.projectId })).filter(
    (mission) =>
      mission.state === 'DONE' &&
      mission.candidateId !== null &&
      buckets.has(mission.candidateId) &&
      mission.orchestrationId !== null,
  );

  const out: Harvested[] = [];
  const limit = Math.max(1, input.limit ?? 20);
  for (const mission of missions) {
    if (out.length >= limit) break;
    const bucket = buckets.get(mission.candidateId!)!;

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
      if (claim.evidenceLane !== SIGNAL_LANE) continue;
      if (!claim.sourceUrl) continue;
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

      out.push({ opportunity: withSignal ?? created, claimId: claim.id, missionId: mission.id });
    }
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
