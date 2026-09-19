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
 * Half two: the signal is a column, chosen by somebody who read the source
 * ---------------------------------------------------------------------------
 *
 * Turning a finished mission into opportunities looks like it needs a reader:
 * which of these accepted claims is an *opening*? It does not, and the first
 * version of this file got the reason nearly right and the mechanism wrong. It
 * read `evidence_lane === 'demand_signal'` — a literal no lane id in this
 * repository has ever been — and additionally required a `russell_missions`
 * row, which the packets an administrator starts do not have. So it matched
 * nothing, twice over, and four filed reports full of accepted openings
 * produced no portfolio at all. **A condition that can never hold is not a
 * rule, it is an absence with a comment on it.**
 *
 * What replaces it is still a column and still not prose: a worker that read
 * the source names one of seven `OPPORTUNITY_SIGNALS` on the claim, or none,
 * and `signalledClaims` returns exactly the accepted ones that carry it. The
 * judgement is made once, by the only party that can make it — somebody who
 * read the page — and is then a value from a closed vocabulary that Brain
 * matches exactly. A claim with no signal is evidence and nothing else, which
 * is why every row written before this existed carries null and **cannot
 * become an opportunity merely by existing**.
 *
 * The mechanism follows from the signal by a lookup rather than a reading, and
 * a `NEGATIVE_EXISTENCE` claim is never promoted: a documented absence is
 * evidence about where Brain looked, and filing it would put "nobody is asking"
 * into the portfolio as something to go and sell.
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
  fillOpportunitySignal,
  listOpportunities,
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
import { openIndustryRoundsByCandidate } from '../../repos/industry.ts';
import { getClaim, signalledClaims } from '../../repos/research.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { mechanismForSignal } from '../../domain/opportunitySignals.ts';
import { discoveryAllowed } from './lifecycle.ts';
import {
  ensureDiscoveryAuthority,
  resumeAuthorityParkedCandidates,
} from './discoveryAuthority.ts';
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
  /*
   * The second wave. The five above all ask *who has published a request*, in
   * five different places — which is one question wearing five hats, and it is
   * why discovery kept returning the same shape of opening. These five ask why
   * money is available at all, and each has a different answer: somebody cannot
   * get at information, a repeated job has never been packaged, a capability is
   * cheap here and expensive there, work is already sold but cannot be
   * delivered, and two openings are worth more together than apart.
   *
   * Every one of them still resolves to a *published* artefact with a URL and a
   * date, because the lane is `demand_signal` and the gate has not moved. A
   * bucket that invited a worker to reason about where money might be would be
   * asking it to invent an opening, which is the one thing this table exists to
   * stop.
   */
  {
    id: 'information-asymmetry',
    mechanism: 'INFORMATION_ASYMMETRY',
    title: 'Which facts people are visibly paying to obtain',
    question:
      'Where is somebody publicly paying, asking or complaining about the cost of getting at ' +
      'information that is public but fragmented, unindexed, paywalled, published only as ' +
      'scans, or scattered across jurisdictions — naming who wants it, what they said it is ' +
      'worth, and where the underlying records actually sit?',
  },
  {
    id: 'productized-service',
    mechanism: 'PRODUCTIZED_SERVICE',
    title: 'Which repeated job is still being bought as a bespoke project',
    question:
      'Which narrowly-defined task is being repeatedly commissioned as custom work — the same ' +
      'brief appearing again and again on boards, listings or agency pages — where the ' +
      'published prices, turnaround times and deliverables are close enough to be sold as one ' +
      'fixed-scope, fixed-price offer?',
  },
  {
    id: 'capability-arbitrage',
    mechanism: 'CAPABILITY_ARBITRAGE',
    title: 'Where the same deliverable has two published prices',
    question:
      'Where is the same deliverable published at materially different prices by different ' +
      'suppliers, regions, platforms or delivery methods — including work now automatable — ' +
      'naming both published prices, both sources, the dates, and anything published about ' +
      'licensing, rights or platform terms that decides whether the spread may lawfully be ' +
      'taken?',
  },
  {
    id: 'subcontracted-fulfilment',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    title: 'Who has already sold work they cannot currently deliver',
    question:
      'Which suppliers have published evidence of more sold work than they can deliver — a ' +
      'stated backlog, a waitlist, paused intake, a subcontractor or overflow request, a ' +
      'recruitment notice naming the bottleneck — and what do they say about how the extra ' +
      'capacity is engaged and paid?',
  },
  {
    id: 'jigsaw-combination',
    mechanism: 'JIGSAW_COMBINATION',
    title: 'Which two published openings are worth more together',
    question:
      'Which published opening supplies exactly what another published opening is missing — ' +
      'leads, data, fulfilment capacity, a licence, credibility or capital — naming both ' +
      'sources, what each side published, and what specifically one supplies to the other?',
  },
]);

const OPENED = 'CASH_DISCOVERY_OPENED';
const HARVESTED = 'CASH_OPPORTUNITY_HARVESTED';

/**
 * The lane the discovery profile declares for a published opening.
 *
 * It says what *kind* of evidence a claim is, and that turned out not to be
 * the question the harvest asks. `demand_signal` and `demand_absence` are the
 * same kind of evidence with opposite answers, and a claim in either can be a
 * dated published artefact — so the lane is what the gate judges coverage
 * against, and the `opportunity_signal` column is what decides whether
 * something is a piece of work. `OPENING_LANES` used to be here as a set with
 * one entry and a comment saying it decided that; it was read by nothing once
 * the signal arrived, and a constant that claims to be a rule while nothing
 * calls it is worse than no rule at all.
 */
export const SIGNAL_LANE = 'demand_signal';

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
  /** The mission that produced it, where one did. Null for a packet an
   *  administrator started, which has no mission and is no less authorized. */
  missionId: string | null;
}

/**
 * Turn what discovery found into pieces of the portfolio.
 *
 * ---------------------------------------------------------------------------
 * What it reads, and what it used to read
 * ---------------------------------------------------------------------------
 *
 * It reads **claims that say they are openings**, in this project, that cleared
 * the gate. Two things about that are corrections, and both were measured in
 * production rather than reasoned about.
 *
 * It used to decide "is this an opening" by comparing `evidence_lane` against
 * the literal `demand_signal`. Fragment planners name their own lanes, so the
 * two halves were never speaking one vocabulary: 82 claims carried seventeen
 * distinct lane ids and `demand_signal` appears zero times. Now a claim carries
 * a typed `opportunity_signal` from a closed set, validated on submission — see
 * `domain/opportunitySignals.ts` for why that is typed rather than matched.
 *
 * And it used to walk candidate → mission → orchestration, so a packet with no
 * mission row was invisible. Four production packets started by an
 * administrator hold 69 accepted claims that could never have been harvested,
 * however good they were. An authorized research orchestration in a cash
 * project *is* the provenance; a mission is one way of arriving at one.
 *
 * **Nothing about this promotes an old claim retroactively.** A claim with no
 * signal is not an opening, and every claim written before the column existed
 * has none. They stay exactly where they are, as archive evidence.
 *
 * ---------------------------------------------------------------------------
 * Not gated by the sprint's lifecycle
 * ---------------------------------------------------------------------------
 *
 * Deliberate, and unchanged. Filing what research already found is not new
 * discovery — the spending happened when it ran — and dropping results because
 * the sprint wound down would throw away work already paid for. Winding down
 * stops `openDiscovery`; it does not stop the answers arriving.
 */
export async function harvest(input: {
  projectId: string;
  limit?: number;
}): Promise<Harvested[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const limit = Math.max(1, input.limit ?? 20);

  /*
   * Which round each orchestration belongs to, where one does.
   *
   * A mission links a round's candidate to the orchestration it launched, and
   * that is how a bucket's own bookkeeping (`found`, and therefore whether the
   * bucket is worth asking again) stays correct. An orchestration with no
   * mission simply has no round, which is honest rather than a gap: nobody
   * asked a bucket for it.
   */
  const live = await liveRounds(input.projectId);
  /*
   * And which *subject* each live kernel scan is about.
   *
   * A scan round is the same ten mechanism questions with a scope at last, so
   * its openings belong to the subject it asked about. Read from the round
   * rather than derived from the opening's title, which would be a guess
   * wearing a foreign key — §25's defect, at the column that decides which
   * industry Brain believes something is in.
   */
  const kernelByCandidate = await openIndustryRoundsByCandidate(input.projectId);
  const missions = await listMissions({ projectId: input.projectId });
  const roundByOrchestration = new Map<
    string,
    { round: CashDiscoveryRound; bucket: SearchBucket; missionDone: boolean }
  >();
  const nodeByOrchestration = new Map<string, string>();
  const missionByOrchestration = new Map<string, string>();
  for (const mission of missions) {
    if (!mission.orchestrationId) continue;
    missionByOrchestration.set(mission.orchestrationId, mission.id);
    if (!mission.candidateId) continue;
    const entry = live.get(mission.candidateId);
    if (entry) {
      roundByOrchestration.set(mission.orchestrationId, {
        ...entry,
        missionDone: mission.state === 'DONE',
      });
    }
    const kernel = kernelByCandidate.get(mission.candidateId);
    if (kernel && kernel.purpose === 'SCAN' && kernel.nodeId) {
      nodeByOrchestration.set(mission.orchestrationId, kernel.nodeId);
    }
  }

  const signalled = await signalledClaims({ projectId: input.projectId, limit: limit * 4 });

  const out: Harvested[] = [];
  const foundPerRound = new Map<string, number>();

  for (const entry of signalled) {
    if (out.length >= limit) break;
    const { claim } = entry;
    const signal = claim.opportunitySignal;
    if (!signal) continue;
    if (!claim.sourceUrl) continue;
    /*
     * A documented absence is a finding, and it is not an opening.
     *
     * `NEGATIVE_EXISTENCE` is how "nothing published says anyone is asking"
     * is established at all, and filing one as an opportunity would put
     * *nobody is asking* into the portfolio as a piece of work.
     */
    if (claim.claimType === 'NEGATIVE_EXISTENCE') continue;

    const context = roundByOrchestration.get(entry.orchestrationId) ?? null;

    /*
     * One opportunity per supported opening, decided by the database.
     *
     * The read stays because it makes the common case cheap and gives the
     * loop something to skip; the unique index on `(project, source_claim_id)`
     * is what actually decides, so two ticks racing produce one piece of work
     * rather than two.
     */
    if (await opportunityForClaim(input.projectId, claim.id)) continue;

    const created = await createOpportunity({
      projectId: input.projectId,
      cashModeId: mode.id,
      ownerUserId: mode.ownerUserId,
      title: clamp(claim.claim, 160),
      // From the claim's own signal rather than from the bucket that asked.
      // One broad question turns up openings of several kinds, and filing all
      // of them under the bucket's heading is wrong for most of them.
      mechanism: mechanismForSignal(signal),
      // The signal itself as well as the mechanism it maps to. The mapping is
      // lossy on purpose and the tier turns on the signal — see `tier.ts`.
      opportunitySignal: signal,
      currency: mode.currency,
      source: claim.sourcePublisher ?? claim.sourceTitle ?? claim.sourceUrl,
      discoveredByCandidateId: context ? context.round.candidateId : null,
      // The subject whose scan found it, where a kernel scan did. Null where
      // the question was not about one — an un-scoped bucket, or a packet an
      // administrator started — which is honest rather than a gap.
      industryNodeId: nodeByOrchestration.get(entry.orchestrationId) ?? null,
      sourceClaimId: claim.id,
      // The rest of the chain, written here and never inferred later: which
      // packet established this, under which fragment's question, in which
      // round of which bucket.
      orchestrationId: entry.orchestrationId,
      fragmentId: entry.fragmentId,
      discoveryRoundId: context ? context.round.id : null,
      nextAction:
        'Establish who can approve payment and how to reach them. The source says somebody ' +
        'asked; it does not say who pays.',
    });
    if (!created) continue;

    /*
     * The signal, and only the signal.
     *
     * A published request is evidence that somebody asked for something. It
     * is not a payer, a price, an acceptance condition or a delivery path,
     * and writing any of those from it would be the favourable assumption the
     * card exists to refuse. They stay unknown, which is what makes them
     * appear as tasks — and as the questions the bounded validation assignment
     * then goes and answers.
     */
    const withSignal = await updateOpportunity(created.id, {
      buying_signal: clamp(claim.claim, 1_000),
      signal_observed_at: claim.sourceDate ?? claim.retrievedAt ?? null,
    });

    const missionId = missionByOrchestration.get(entry.orchestrationId) ?? null;
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: created.id,
      kind: HARVESTED,
      actorRef: 'BRAIN',
      summary: context
        ? `An opening was harvested from a claim in "${context.bucket.title}".`
        : 'An opening was harvested from an authorized research packet.',
      detail: {
        signal,
        bucketId: context ? context.bucket.id : null,
        claimId: claim.id,
        orchestrationId: entry.orchestrationId,
        fragmentId: entry.fragmentId,
        missionId,
        sourceUrl: claim.sourceUrl,
      },
    });

    if (context) {
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
    }
    out.push({ opportunity: withSignal ?? created, claimId: claim.id, missionId });
  }

  /*
   * A round is settled by its own bookkeeping, not by the loop ending.
   *
   * `found` decides whether the bucket is worth asking again, so a round whose
   * mission has finished has to record what it found — **including nothing**.
   * That is why this is outside the "did anything promote" path: a bucket that
   * documented an absence has answered its question, and leaving it OPEN would
   * stop it ever being asked again while looking like it was still running.
   *
   * Guarded on OPEN by `closeRound`, so two ticks reading one finished mission
   * settle it once. A round whose mission is still running is left alone,
   * because its claims have not all arrived.
   */
  if (out.length < limit) {
    for (const entry of roundByOrchestration.values()) {
      if (!entry.missionDone) continue;
      await closeRound({
        id: entry.round.id,
        to: 'HARVESTED',
        found: foundPerRound.get(entry.round.id) ?? 0,
      });
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
  /** True only on the tick that first wrote the discovery authorization. */
  authorized: boolean;
  /** Ideas that had parked for want of it and are back in the queue. */
  resumed: string[];
  /** Pieces whose kind of opening was read back from their own source claim. */
  signalled: string[];
}> {
  // One read answers both halves for the many projects that hold no sprint at
  // all, which is what makes this cheap enough to run for every project on
  // every tick.
  if (!(await getCashMode(projectId))) {
    return { opened: [], harvested: [], authorized: false, resumed: [], signalled: [] };
  }

  /*
   * First, the authorization that pressing Start already gave.
   *
   * Here rather than only at activation, because a hook fixes one entrance and
   * rows reach every entrance plus everything already stranded — the fifth
   * time this repository has needed that sentence. A sprint activated before
   * this existed is reconciled on the next tick with nobody pressing anything,
   * and the ten ideas it parked for want of a grant come back through the
   * ordinary judgment path rather than through a second Start action.
   *
   * Both are idempotent: the grant by a unique index, the resumption by being
   * guarded on the exact state it is answering.
   */
  const authorized = await ensureDiscoveryAuthority(projectId);
  const resumed = authorized ? await resumeAuthorityParkedCandidates({ projectId }) : [];

  /*
   * And the signal on anything promoted before the column existed.
   *
   * Here rather than only at promotion, for the fifth time in this file: a
   * hook fixes one entrance and rows reach every entrance plus everything
   * already written. It is guarded on the column still being null, so it fills
   * blanks and never overwrites, and a piece whose claim carries no signal is
   * left exactly as it is.
   */
  const signalled = await reconcileOpportunitySignals(projectId);

  return {
    opened: await openDiscovery({ projectId, limit: 1 }),
    harvested: await harvest({ projectId, limit: 10 }),
    authorized: authorized?.created ?? false,
    resumed: resumed.map((one) => one.candidateId),
    signalled,
  };
}

/**
 * Fill in the signal on pieces promoted before the column existed.
 *
 * Thirty-one production rows were promoted by a `harvest` that mapped the
 * claim's signal to a mechanism and threw the signal away. The mechanism
 * cannot be un-mapped — two signals share one — so the answer is read back
 * from each piece's own `source_claim_id`, which is exactly where `harvest`
 * got it.
 *
 * Three properties, and each of them is why this is a derivation on the tick
 * rather than an `UPDATE` inside a migration.
 *
 * **It never replaces a recorded value.** The write is guarded on the column
 * still being null, so a signal written at promotion always wins and a
 * recovery can only ever fill a blank. `lineageRecovery` at a new column.
 *
 * **It reaches what a migration could not.** A migration runs once; a piece
 * promoted a minute later by an instance still running the previous image
 * would have missed it, and nothing would ever have come back for it.
 *
 * **It writes nothing else.** No state moves, no attempt is charged, no work
 * is enqueued, and a piece whose claim is gone or carries no signal is left
 * exactly as it is — which reads as "nothing said what kind this is", and that
 * is an answer rather than a gap.
 */
export async function reconcileOpportunitySignals(projectId: string): Promise<string[]> {
  const out: string[] = [];
  for (const opportunity of await listOpportunities({ projectId })) {
    if (opportunity.opportunitySignal !== null) continue;
    if (!opportunity.sourceClaimId) continue;
    const claim = await getClaim(opportunity.sourceClaimId);
    const signal = claim?.opportunitySignal ?? null;
    if (!signal) continue;
    const filled = await fillOpportunitySignal(opportunity.id, signal);
    if (filled) out.push(opportunity.id);
  }
  return out;
}
