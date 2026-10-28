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
import { TRIGGER_BUCKETS, triggersEnabled } from './triggers.ts';
import { FEED_SHORTLIST_BUCKET } from '../feeds/bucket.ts';
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import {
  createOpportunity,
  fillOpportunitySignal,
  listOpportunities,
  openingsWithSourceUrl,
  opportunityForClaim,
  updateOpportunity,
} from '../../repos/cashPortfolio.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import {
  closeRound,
  listRounds,
  openRound,
  openRoundsByCandidate,
} from '../../repos/cashDiscovery.ts';
import { openIndustryRoundsByCandidate } from '../../repos/industry.ts';
import { getClaim, signalledClaims } from '../../repos/research.ts';
import { getMissionByOrchestration } from '../../repos/russellMissions.ts';
import { missionsForRounds, type RoundMissions } from '../russell/roundMissions.ts';
import { mechanismForSignal } from '../../domain/opportunitySignals.ts';
import { discoveryAllowed } from './lifecycle.ts';
import { cashPosition } from './money.ts';
import { proveCapabilities } from './deliverables/capabilities.ts';
import { existingOpeningFor, markDuplicateOpenings, openingSourceKey } from './duplicates.ts';
import {
  ensureDiscoveryAuthority,
  resumeAuthorityParkedCandidates,
} from './discoveryAuthority.ts';
import { DELIVERABLE_KINDS, DELIVERABLE_LABEL, type DeliverableKind } from './deliverables/spec.ts';
import { deliverableCapabilityId } from './capabilities.ts';
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
  /**
   * For a play bucket, the deliverable its question is about. An opening
   * harvested from a round of it requires producing that kind, so Brain can
   * say from its own proof whether it delivers — see `PLAY_BUCKETS`.
   */
  deliverable?: DeliverableKind;
}

/**
 * Plays: a kind of business that pays for something Brain can make.
 *
 * The owner's correction (2026-10-21): fast cash comes from several plays at
 * once — a reachable group of buyers who already pay for a deliverable, sold
 * to them directly — not from one-off listings. Every bucket below asked
 * *who has published a request*, which is why discovery returned single
 * postings, solicitations and auctions. These ask the play question, one per
 * deliverable Brain proved it can produce, so the opening a round finds is
 * about that deliverable by construction and carries `PRODUCE_<KIND>` as its
 * required capability — which is how `deliveryReading` can say Brain does the
 * work, from the proof rather than from anybody's word.
 *
 * Still a *place to look*: every answer is a published, dated artefact through
 * the same gate. The question asks for the buyers, what they pay, how often,
 * and where they can be reached; it asks for no estimate.
 */
const PLAY_SUBJECT: Record<DeliverableKind, string> = {
  SPREADSHEET: 'custom spreadsheets, trackers, calculators or financial models',
  DOCUMENT: 'business documents such as proposals, policies, SOPs, reports or templates',
  PRESENTATION: 'presentations and pitch decks',
  DATASET: 'data cleaning, de-duplication, enrichment or list building',
  WEBSITE: 'simple websites and landing pages',
  CODE: 'small scripts, automations or integrations',
  GRAPHIC: 'logos, icons and other vector graphics',
  MODEL_3D: 'simple 3D models',
};

export const PLAY_BUCKETS: readonly SearchBucket[] = Object.freeze(
  DELIVERABLE_KINDS.map(
    (kind): SearchBucket => ({
      id: `play-${kind.toLowerCase().replace(/_/g, '-')}`,
      mechanism: 'PRODUCTIZED_SERVICE',
      deliverable: kind,
      title: `Who keeps paying for ${PLAY_SUBJECT[kind].split(',')[0]}`,
      question:
        `Which kinds of businesses or organisations pay, again and again, for ${PLAY_SUBJECT[kind]} — ` +
        'naming the kind of buyer, the published prices they pay (with the source), how often ' +
        'they buy, how fast they expect it delivered, and a published directory, association ' +
        'list or index where such buyers and their business email addresses can be found?',
    }),
  ),
);

/**
 * Quick plays: money available now that will not last (the owner, 2026-10-22:
 * "small exploits where we make money super fast; if it only lasts a month, so
 * be it"). Each asks *why money is available this month*, and every answer is
 * still a published, dated artefact through the same gate. First in the list,
 * because the window is the point. A bucket names the deliverable its answer
 * is mostly about, so an opening it finds requires producing that kind and
 * `deliveryReading` can say from Brain's own proof whether Brain does the work.
 */
const QUICK_WINDOW_ASK =
  'naming who must pay, the published price or budget, the date the window closes, and how ' +
  'fast a first payment could arrive for the work, goods or service delivered — and say how long ' +
  'the window lasts (a window of weeks is fine)?';

export const QUICK_PLAY_BUCKETS: readonly SearchBucket[] = Object.freeze([
  {
    id: 'quick-new-rule',
    mechanism: 'TEMPORARY_EXPLOIT',
    deliverable: 'DOCUMENT',
    title: 'Which new rule forces businesses to buy something soon',
    question:
      'Which newly published rule, regulation, standard or platform policy forces a group of ' +
      'businesses to produce a document, filing, data set, notice or web change by a stated ' +
      `date — ${QUICK_WINDOW_ASK}`,
  },
  {
    id: 'quick-deadline-rush',
    mechanism: 'TEMPORARY_EXPLOIT',
    deliverable: 'SPREADSHEET',
    title: 'Which deadline has businesses rushing to get work done',
    question:
      'Which published deadline (a filing date, a renewal, a grant or program closing, a ' +
      'compliance date) has a group of businesses needing documents, data or spreadsheets ' +
      `prepared before it — ${QUICK_WINDOW_ASK}`,
  },
  {
    id: 'quick-event',
    mechanism: 'TEMPORARY_EXPLOIT',
    deliverable: 'DOCUMENT',
    title: 'Which upcoming event creates a burst of paid work',
    question:
      'Which upcoming, published event — a trade show, a season, a launch, a change of tax year, ' +
      'an election, a disaster recovery period — creates a burst of demand for paid work, goods or services ' +
      `from businesses, organisations or households — ${QUICK_WINDOW_ASK}`,
  },
  {
    id: 'quick-platform-change',
    mechanism: 'TEMPORARY_EXPLOIT',
    deliverable: 'DATASET',
    title: 'Which platform change leaves businesses needing help now',
    question:
      'Which published change by a widely used platform, marketplace or software vendor (a ' +
      'shutdown, a migration, a new requirement, a price change) leaves its business users ' +
      `needing data moved, documents redone or pages rebuilt soon — ${QUICK_WINDOW_ASK}`,
  },
  {
    id: 'quick-price-gap',
    mechanism: 'TEMPORARY_EXPLOIT',
    title: 'Which price gap is open right now and closing',
    question:
      'Where is the same product, service or deliverable published at two clearly different ' +
      'prices right now because of a temporary condition (a promotion, a shortage, a new entrant, ' +
      `a currency move), with buyers on the expensive side — ${QUICK_WINDOW_ASK}`,
  },
]);

/**
 * The third wave: the wider economy (the owner, 2026-10-28).
 *
 * Every bucket above but two was about work a business buys and Brain
 * delivers itself, and thirteen of them came first in the list — so discovery
 * concentrated on small B2B digital services. These ask about the other ways
 * money moves: between consumers and businesses, through a broker or a
 * matchmaker, through freight and storage, through somebody sourcing what a
 * buyer cannot find, through physical resale, and through running a function a
 * business hands off. They are starting examples rather than a closed list, and
 * the last one asks which ways nobody here has named yet.
 *
 * Researching one of these authorizes nothing: an opening it finds goes
 * through the same gate, the same tier and the same commercial grant as every
 * other, and acting on it still needs whatever licence, capital or capability
 * it names.
 */
export const BROAD_ECONOMY_BUCKETS: readonly SearchBucket[] = Object.freeze([
  {
    id: 'broad-brokerage',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Where buyers and sellers pay somebody to find each other',
    question:
      'In which markets — business or consumer, goods or services — do buyers and sellers pay a ' +
      'broker, agent or matchmaker a fee or commission to find each other, naming the market, ' +
      'which side pays, the published fee or commission, where the two sides currently look, and ' +
      'any licence or rule that decides who may arrange the match?',
  },
  {
    id: 'broad-logistics',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Where freight, delivery or storage demand is unmet or overpriced',
    question:
      'Where is published freight, delivery, moving or storage demand going unmet or paying well ' +
      'above normal right now — loads posted without carriers, lanes with published rate spikes, ' +
      'storage shortages, delivery backlogs — naming who needs it moved or stored, the published ' +
      'rate, the dates, and what licence, insurance or equipment decides who may arrange it?',
  },
  {
    id: 'broad-sourcing',
    mechanism: 'CAPABILITY_ARBITRAGE',
    title: 'Who cannot find a product, part or supply at the price they need',
    question:
      'Which businesses, institutions or households have published that they need a product ' +
      'sourced — a part, a material, a supply, a bulk quantity — faster or cheaper than they can ' +
      'find it, naming the buyer, the item, what they pay now, a published supplier price ' +
      'elsewhere, and what the sources say about minimum quantities, importing or terms?',
  },
  {
    id: 'broad-consumer-demand',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    title: 'Which consumer needs are published as unmet right now',
    question:
      'Which consumer needs are published as unmet or badly served right now — products sold ' +
      'out or back-ordered, services with long published waitlists, things many people are ' +
      'publicly asking where to find — naming the need, how widely it is asked (with the ' +
      'source), what people currently pay, and where those consumers gather or can be reached?',
  },
  {
    id: 'broad-physical-resale',
    mechanism: 'RESALE_OR_ASSET',
    title: 'Which physical goods sell for more in one market than another',
    question:
      'Which physical goods are published at a clearly higher price in one market, channel, ' +
      'region or season than they are offered at in another — liquidation and wholesale lots, ' +
      'regional gaps, out-of-season stock — naming both published prices, the quantities, the ' +
      'published costs of moving and reselling them, and any restriction on resale?',
  },
  {
    id: 'broad-delegated-operations',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    title: 'Which ongoing functions businesses pay an outside firm to run',
    question:
      'Which ongoing business functions — bookkeeping, scheduling, customer support, dispatch, ' +
      'collections, listings management, compliance tracking, procurement — do businesses ' +
      'publicly pay an outside firm to run month after month, naming the kind of business, the ' +
      'published monthly price, what the outside firm does, and what running it would require?',
  },
  {
    id: 'broad-referrals',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    title: 'Who publishes a price for a referral, a lead or a booked job',
    question:
      'Which trades, service businesses or sellers publish that they pay for referrals, ' +
      'qualified leads or booked appointments — a referral fee, a price per lead, a commission ' +
      'on a closed sale — naming the kind of business, the published price, how they say the ' +
      'leads are delivered, and any rule on who may supply them?',
  },
  {
    id: 'broad-other-mechanisms',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Which other ways of being paid between two parties exist right now',
    question:
      'Beyond direct sale, brokerage, matchmaking, subcontracting, logistics, sourcing, resale, ' +
      'arbitrage and running delegated operations, which other lawful ways are people and ' +
      'businesses currently being paid to move money, goods, information or work between two ' +
      'parties — naming one live, dated, published example of each, who pays whom, and how much?',
  },
]);

export const SEARCH_BUCKETS: readonly SearchBucket[] = Object.freeze([
  ...QUICK_PLAY_BUCKETS,
  ...PLAY_BUCKETS,
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
  ...BROAD_ECONOMY_BUCKETS,
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
/**
 * Whether Brain's Claude workers open new broad discovery rounds.
 *
 * On by default. `BRAIN_CLAUDE_DISCOVERY=off` stops new rounds (search buckets
 * and triggers alike) so the Routines spend their capacity on deep dives,
 * qualification and research goals instead of bulk finding — bulk finding
 * moves to code feeds and the cheap lane. Rounds already open still finish and
 * are harvested; nothing already found is touched. Read per call, so turning it
 * back on needs no deploy.
 */
export function claudeDiscoveryEnabled(env = process.env): boolean {
  return env['BRAIN_CLAUDE_DISCOVERY']?.trim().toLowerCase() !== 'off';
}

export async function openDiscovery(input: {
  projectId: string;
  limit?: number;
  now?: string;
}): Promise<OpenedDiscovery[]> {
  if (!claudeDiscoveryEnabled()) return [];
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
  let frame: ExecutionFrame | null | undefined;
  for (const bucket of fairOrder([...SEARCH_BUCKETS, ...(triggersEnabled() ? TRIGGER_BUCKETS : [])], rounds)) {
    if (out.length >= limit) break;
    const history = byBucket.get(bucket.id) ?? [];
    const next = nextRoundFor(history, now);
    if (next === null) continue;
    const held = await heldExclusions({ projectId: input.projectId, bucket, history });
    if (frame === undefined) frame = await executionFrame(input.projectId, mode.currency);

    /*
     * The candidate and its round commit together, in one transaction.
     *
     * A round insert that loses its `ON CONFLICT DO NOTHING` race means
     * another pass already opened this exact bucket's round, and the
     * candidate this call just created would otherwise be left committed with
     * nothing pointing at it — not harmless, whatever `openRound`'s own
     * comment used to claim: the candidate is created SHARED with a project,
     * and Russell's tick judges and can launch any unjudged SHARED candidate,
     * orphan or not. Rolling both writes back together makes a lost race
     * exactly as if this call had never happened.
     */
    const round = await openBucketRound({
      projectId: input.projectId,
      mode,
      bucket,
      next,
      statement: questionFor(bucket, mode.objective, next, history, held, frame),
    });
    if (!round) continue;
    out.push({ bucketId: bucket.id, candidateId: round.candidateId, round: next });
  }
  return out;
}

/**
 * Open one round of one bucket: the candidate and its round in one
 * transaction, then the event. Null when another pass already opened it.
 */
async function openBucketRound(input: {
  projectId: string;
  mode: { id: string; objective: string };
  bucket: SearchBucket;
  next: number;
  statement: string;
}): Promise<CashDiscoveryRound | null> {
  const { bucket, next, mode } = input;
  let round: CashDiscoveryRound;
  try {
    round = await getDb().transaction(async (): Promise<CashDiscoveryRound> => {
      const candidate = await createCandidate({
        projectId: input.projectId,
        visibility: 'SHARED',
        conversationId: null,
        sourceMessageId: null,
        title: next === 1 ? bucket.title : `${bucket.title} (round ${next})`,
        statement: input.statement,
      });

      const result = await openRound({
        projectId: input.projectId,
        cashModeId: mode.id,
        bucketId: bucket.id,
        mechanism: bucket.mechanism,
        round: next,
        candidateId: candidate.id,
      });
      if (!result.created) throw new RoundNotOpened();
      return result.round;
    });
  } catch (error) {
    if (error instanceof RoundNotOpened) return null;
    throw error;
  }

  await recordCashEvent({
    projectId: input.projectId,
    kind: OPENED,
    actorRef: 'BRAIN',
    summary: `Discovery opened: ${bucket.title} (round ${next}).`,
    detail: {
      bucketId: bucket.id,
      mechanism: bucket.mechanism,
      candidateId: round.candidateId,
      cashModeId: mode.id,
      round: next,
      objective: mode.objective,
    },
  });
  return round;
}

/** A goal's own discovery question has this bucket id. */
export const GOAL_BUCKET_PREFIX = 'goal-';

/** The bucket a goal's own discovery rounds are filed under. */
export function goalBucket(goalId: string, title: string, question = ''): SearchBucket {
  return {
    id: `${GOAL_BUCKET_PREFIX}${goalId}`,
    // Not one mechanism: the question is open across all of them.
    mechanism: 'OTHER',
    title: `What else could reach: ${title}`.slice(0, 160),
    question,
  };
}

/**
 * Ask the world for what the goal is missing, when the openings Brain holds
 * cannot reach it however they are combined.
 *
 * Evaluating the same openings again teaches nothing, so the goal's own gap
 * becomes one discovery round through the machinery every bucket uses: the
 * candidate is judged, launched only inside the standing research grant, and
 * its findings go through the same gate and harvest. The question is open —
 * any market, mechanism or combination — and carries what the owner said they
 * have to work with. It is asked at most once a day, stops after three barren
 * rounds like any bucket, and authorizes nothing but reading.
 */
export async function openGoalDiscovery(input: {
  goal: { id: string; title: string };
  target: {
    projectId: string;
    remainingCents: number;
    currency: string;
    metricLabel: string;
    daysLeft: number | null;
    capitalCeilingCents: number | null;
    resources: string | null;
    capitalBeforeProofCents?: number | null;
    capitalPerWeekCents?: number | null;
  };
  bestReach: number | null;
  now?: string;
}): Promise<OpenedDiscovery | null> {
  if (!claudeDiscoveryEnabled()) return null;
  const gate = await discoveryAllowed(input.target.projectId);
  if (!gate.allowed || !gate.mode) return null;
  const mode = gate.mode;
  const now = input.now ?? new Date().toISOString();
  const t = input.target;
  if (t.daysLeft === null || t.daysLeft <= 0 || t.remainingCents <= 0) return null;

  const id = `${GOAL_BUCKET_PREFIX}${input.goal.id}`;
  const history = (await listRounds(t.projectId)).filter((one) => one.bucketId === id);
  const next = nextRoundFor(history, now);
  if (next === null) return null;

  const amount = `${t.currency} ${(t.remainingCents / 100).toFixed(0)}`;
  const held =
    input.bestReach === null
      ? 'Brain holds no opening far enough along to plan with.'
      : `Combined in every way Brain could, the openings it holds reach at most ${t.currency} ${Math.round(input.bestReach)} of it.`;
  const capital =
    t.capitalCeilingCents === null
      ? 'The owner has not said how much of their own capital this goal may use, so name what each opening needs up front.'
      : `The owner has said this goal may use up to ${t.currency} ${(t.capitalCeilingCents / 100).toFixed(0)} of capital, so name what each opening needs up front.`;
  const resources = t.resources ? `What the owner has to work with: ${t.resources}.` : 'The owner has not described other resources.';
  const pace =
    t.capitalBeforeProofCents != null || t.capitalPerWeekCents != null
      ? 'The owner wants money to come in step by step: ' +
        (t.capitalBeforeProofCents != null ? `no more than ${t.currency} ${(t.capitalBeforeProofCents / 100).toFixed(0)} tied up before the first payment arrives, ` : '') +
        (t.capitalPerWeekCents != null ? `no more than ${t.currency} ${(t.capitalPerWeekCents / 100).toFixed(0)} newly tied up a week, ` : '') +
        'so prefer ways that can be tried small and pay quickly and repeatedly, and say plainly when a way only pays after a competitive award or in one lump at the end.'
      : '';
  const bucket = goalBucket(
    input.goal.id,
    input.goal.title,
    `Which lawful ways — in any market, industry or mechanism, including ones not usually put together, ` +
      `and as one opening or several running at once — could bring this operation ${amount} more of ` +
      `${t.metricLabel} within ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'}? ${held} ${capital} ${resources} ${pace} ` +
      'For each, name who pays, roughly how much, when the money would settle, what it needs up front, ' +
      'and what it would need that the operation does not have yet?',
  );
  const frame = await executionFrame(t.projectId, mode.currency);
  const heldLines = await heldExclusions({ projectId: t.projectId, bucket, history });
  const round = await openBucketRound({
    projectId: t.projectId,
    mode,
    bucket,
    next,
    statement: questionFor(bucket, mode.objective, next, history, heldLines, frame),
  });
  return round ? { bucketId: id, candidateId: round.candidateId, round: next } : null;
}

/**
 * The order buckets are offered in: the least-asked mechanism first.
 *
 * `openDiscovery` opens one round a tick and every bucket is re-asked after its
 * cool-off, so whichever buckets come first in the list are the ones asked over
 * and over. Thirteen of the first thirteen were small digital-service plays,
 * which is how discovery concentrated on one kind of opening. A mechanism with
 * nine buckets now gets the same share of asking as a mechanism with one, a
 * bucket never asked comes before one asked again inside its mechanism, and
 * list order only breaks a tie. It changes which question is asked next and
 * nothing about whether any may be.
 */
export function fairOrder(buckets: readonly SearchBucket[], rounds: readonly CashDiscoveryRound[]): SearchBucket[] {
  const byMechanism = new Map<string, number>();
  const byBucket = new Map<string, number>();
  for (const round of rounds) {
    byMechanism.set(round.mechanism, (byMechanism.get(round.mechanism) ?? 0) + 1);
    byBucket.set(round.bucketId, (byBucket.get(round.bucketId) ?? 0) + 1);
  }
  // Greedy, so one pass that opens several rounds interleaves mechanisms too:
  // each pick counts as an asking of its mechanism before the next is chosen.
  const left = buckets.map((bucket, index) => ({ bucket, index }));
  const out: SearchBucket[] = [];
  while (left.length > 0) {
    let best = 0;
    for (let i = 1; i < left.length; i += 1) {
      const a = left[i]!;
      const b = left[best]!;
      const order =
        (byMechanism.get(a.bucket.mechanism) ?? 0) - (byMechanism.get(b.bucket.mechanism) ?? 0) ||
        (byBucket.get(a.bucket.id) ?? 0) - (byBucket.get(b.bucket.id) ?? 0) ||
        a.index - b.index;
      if (order < 0) best = i;
    }
    const [picked] = left.splice(best, 1);
    out.push(picked!.bucket);
    byMechanism.set(picked!.bucket.mechanism, (byMechanism.get(picked!.bucket.mechanism) ?? 0) + 1);
  }
  return out;
}

/**
 * A round insert lost its `ON CONFLICT DO NOTHING` race.
 *
 * Thrown to roll back the candidate created in the same transaction, never
 * caught outside `openDiscovery`'s own loop.
 */
class RoundNotOpened extends Error {}

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

  /*
   * Barren is "finished and found nothing", never "did not finish". An
   * ABANDONED round's research stopped — failed, cancelled, or parked at a
   * decision — so its zero is an absence of evidence rather than evidence of
   * absence. Production Cash Mode 1, 2026-10-18: nine of ten buckets had
   * stopped for ever on rounds whose sessions could not read the web at all,
   * which is a fact about a surface rather than about the market. Such a bucket
   * is asked again after the cool-off, which is what bounds it.
   */
  const recent = ordered.slice(-BARREN_ROUNDS);
  if (
    recent.length >= BARREN_ROUNDS &&
    recent.every((one) => one.state === 'HARVESTED' && one.found === 0)
  ) {
    return null;
  }

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
  held: HeldExclusions = { lines: [], omitted: 0 },
  frame: ExecutionFrame | null = null,
): string {
  const parts = [bucket.question, `This is for a short cash sprint whose goal is: ${objective}`];
  if (frame) parts.push(executionFrameSentence(frame));
  if (round > 1) {
    const found = history.reduce((total, one) => total + one.found, 0);
    parts.push(
      `Brain has asked this ${round - 1} time${round === 2 ? '' : 's'} before and filed ${found} ` +
        'opening' + (found === 1 ? '' : 's') + '. Report what has been published since, and say ' +
        'so plainly where nothing has.',
    );
  }
  if (held.lines.length > 0) {
    parts.push(
      'Brain already holds the openings listed below, so do not report them again as new ' +
        'openings. A different request published at the same address, or a materially new ' +
        'revision of one, is still new.' +
        held.lines.map((line) => `\n- already listed: ${line}`).join('') +
        (held.omitted > 0
          ? `\n- ${held.omitted} further held opening(s) are not listed here.`
          : ''),
    );
  }
  return parts.join(' ');
}

/**
 * What this operation can actually act on, read from rows when the round opens.
 *
 * Production, 2026-10-19: 312 openings, 248 of them evidence nobody could say
 * how we would be paid from, and the rest mostly closed solicitations, grants,
 * employment postings and resale needing capital the ledger does not hold.
 * Every bucket asked *where money is published* and none said what this
 * operation can do, so workers answered the question as asked. Telling them
 * the frame — what it delivers (the deliverable kinds Brain proved in this
 * process), how much of its own money it can commit (the ledger's deployable
 * figure), and that it is paid online — aims the search at openings that can
 * become collected cash, and asking for the payer and the route on each one is
 * asking for exactly the field (`captureMechanism`) that stalled 248 of them.
 *
 * It narrows what is worth reporting and widens nothing: the envelope, the
 * gate and the source classes are the compiler's. Its words are kept clear of
 * `CASH_FORBIDDEN_ACTIONS`, and a test holds them to it.
 */
export interface ExecutionFrame {
  /** Deliverable kinds proved in this process, as a person reads them. */
  delivers: string[];
  deployableCents: number;
  currency: string;
}

export function executionFrameSentence(frame: ExecutionFrame): string {
  const delivers = frame.delivers.length
    ? `research reports and these kinds of work: ${frame.delivers.join(', ')}`
    : 'research reports';
  const capital =
    frame.deployableCents > 0
      ? `it can commit about ${frame.currency} ${(frame.deployableCents / 100).toFixed(0)} of its own capital, so prefer openings needing less than that up front`
      : 'it holds no capital of its own to commit, so say for each opening how much money it needs up front and whether it is paid before any cost falls due';
  return (
    'Look across the whole economy, not only at work this operation can already do: business and ' +
    'consumer markets, goods and services, brokerage, matchmaking, subcontracting, logistics, ' +
    'sourcing, resale, arbitrage and running operations for others are all in scope, and these ' +
    'are examples rather than a limit. For context, today this operation runs online with AI ' +
    `workers and delivers ${delivers}; it holds no professional licence, certification, bonding, ` +
    'government vendor registration or local physical presence, and takes no employment or ' +
    `hourly positions; ${capital}; and it is paid online, through a checkout or invoice route a ` +
    'buyer already uses. That describes where it starts, not what is worth reporting. For each ' +
    'opening name who would pay this operation, roughly how much, how the money would reach it, ' +
    'the earliest it could arrive, and whether it could act on it now. An opening it could not ' +
    'act on today is still worth reporting when the money is real: name the one licence, ' +
    'registration, capability, partner or amount of capital it would need rather than leaving it ' +
    'out. Leave out job postings, hourly positions and anything already closed. Leave out individual ' +
    'project listings on freelance marketplaces: this operation does not take freelance work. ' +
    'A company publishing its ' +
    'own prices or fees is evidence of what that company charges, not of anybody paying this ' +
    'operation, so on its own it is not an opening. A kind of business that publicly and ' +
    'repeatedly pays for something this operation delivers, with a published place to find those ' +
    'businesses and their email addresses, is an opening, and the prices others charge them are ' +
    'its price evidence.'
  );
}

export async function executionFrame(projectId: string, currency: string): Promise<ExecutionFrame | null> {
  try {
    const [caps, position] = await Promise.all([proveCapabilities(), cashPosition({ projectId, currency })]);
    const delivers = DELIVERABLE_KINDS.filter((kind) => caps[kind]?.available).map((kind) => DELIVERABLE_LABEL[kind]);
    return { delivers, deployableCents: Math.max(0, position.deployableCents), currency };
  } catch {
    // A frame that cannot be read is left out, never guessed: the question still stands without it.
    return null;
  }
}

/** The held openings a bucket question names, bounded, and how many it left out. */
export interface HeldExclusions {
  lines: string[];
  omitted: number;
}

/** At most this many held openings are named in one question. */
export const MAX_HELD_EXCLUSIONS = 25;

/**
 * The openings this project already holds, as exclusions for the next round of
 * a bucket (RES-5).
 *
 * A later round said how many openings earlier ones filed and never which, so a
 * worker re-reported the same RFQ dozens of times. This names them — the
 * source key (`openingSourceKey`, the identity the duplicate check uses) and,
 * where it is safe, a short title.
 *
 * Bounded, and the bound says so rather than truncating silently: the openings
 * this bucket's own rounds filed come first, then other live openings of the
 * same mechanism, newest first; anything past `MAX_HELD_EXCLUSIONS` is counted
 * in the question as not listed.
 *
 * The question is compiled verbatim into the fragment, so two things a line may
 * not carry are refused per line rather than trusted: **a jurisdiction** — the
 * compiler reads states out of the question's prose, and a held title naming
 * Missouri would turn a national bucket into a Missouri one (§25's Westbrook
 * defect) — and **a phrase an approval envelope would read as Brain's own
 * action**, which would get the whole round refused. A line whose title trips
 * either falls back to its key alone; a key that trips either is counted, not
 * named.
 */
export async function heldExclusions(input: {
  projectId: string;
  bucket: SearchBucket;
  history: readonly CashDiscoveryRound[];
}): Promise<HeldExclusions> {
  const mine = new Set(input.history.map((one) => one.id));
  const held = (await openingsWithSourceUrl(input.projectId))
    .filter(({ opportunity }) => !opportunity.duplicateOfId && opportunity.state !== 'DECLINED')
    .filter(
      ({ opportunity }) =>
        (opportunity.discoveryRoundId !== null && mine.has(opportunity.discoveryRoundId)) ||
        opportunity.mechanism === input.bucket.mechanism,
    )
    .sort((a, b) => {
      const ownA = a.opportunity.discoveryRoundId && mine.has(a.opportunity.discoveryRoundId) ? 0 : 1;
      const ownB = b.opportunity.discoveryRoundId && mine.has(b.opportunity.discoveryRoundId) ? 0 : 1;
      if (ownA !== ownB) return ownA - ownB;
      return a.opportunity.createdAt < b.opportunity.createdAt ? 1 : -1;
    });

  const lines: string[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  for (const { opportunity, sourceUrl } of held) {
    const key = openingSourceKey(sourceUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= MAX_HELD_EXCLUSIONS) {
      omitted += 1;
      continue;
    }
    // Punctuation that ends a clause or joins two questions is removed from the
    // title: the fragment planner splits a question on ", and", and the action
    // screen reads clause by clause.
    const title = clamp(opportunity.title.replace(/[.,;:!?\u2014\u2013\n"]+/g, ' '), 80);
    const withTitle = `"${title}" at ${key}`;
    if (safeExclusion(withTitle)) lines.push(withTitle);
    else if (safeExclusion(key)) lines.push(key);
    else omitted += 1;
  }
  return { lines, omitted };
}

/** Neither a jurisdiction the compiler would read nor an action an envelope would refuse. */
export function safeExclusion(text: string): boolean {
  if (statesNamedIn(text).length > 0) return false;
  if (/\b(?:and also|as well as|in addition to)\b/i.test(text)) return false;
  const line = `already listed: ${text}`;
  return Object.values(APPROVAL_ENVELOPES).every(
    (envelope) => !describesOwnAction(line, envelope.forbiddenActions),
  );
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
  // Trigger buckets always resolve, so a round opened while triggers were on is
  // still harvested after they are switched off.
  const byId = new Map(
    [...SEARCH_BUCKETS, ...TRIGGER_BUCKETS, FEED_SHORTLIST_BUCKET].map((bucket) => [bucket.id, bucket]),
  );
  const out = new Map<string, { round: CashDiscoveryRound; bucket: SearchBucket }>();
  for (const [candidateId, round] of await openRoundsByCandidate(projectId)) {
    const bucket =
      byId.get(round.bucketId) ??
      (round.bucketId.startsWith(GOAL_BUCKET_PREFIX) ? goalBucket(round.bucketId.slice(GOAL_BUCKET_PREFIX.length), 'a goal') : undefined);
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
  /*
   * Read by the rounds' own candidate ids, never through `listMissions` — that
   * is the hundred most recently updated missions of the project, and a round
   * whose mission had fallen out of it was neither harvested against nor ever
   * closed (RES-2).
   */
  const roundMissions = await missionsForRounds([
    ...live.keys(),
    ...kernelByCandidate.keys(),
  ]);
  const roundByOrchestration = new Map<
    string,
    { round: CashDiscoveryRound; bucket: SearchBucket }
  >();
  const nodeByOrchestration = new Map<string, string>();
  for (const [candidateId, entry] of live) {
    for (const orchestrationId of roundMissions.get(candidateId)?.orchestrationIds ?? []) {
      roundByOrchestration.set(orchestrationId, entry);
    }
  }
  for (const [candidateId, kernel] of kernelByCandidate) {
    if (kernel.purpose !== 'SCAN' || !kernel.nodeId) continue;
    for (const orchestrationId of roundMissions.get(candidateId)?.orchestrationIds ?? []) {
      nodeByOrchestration.set(orchestrationId, kernel.nodeId);
    }
  }
  /** The mission behind an orchestration, by key, for the event's provenance. */
  const missionIdOf = new Map<string, string | null>();
  const missionFor = async (orchestrationId: string): Promise<string | null> => {
    if (!missionIdOf.has(orchestrationId)) {
      missionIdOf.set(orchestrationId, (await getMissionByOrchestration(orchestrationId))?.id ?? null);
    }
    return missionIdOf.get(orchestrationId) ?? null;
  };

  const signalled = await signalledClaims({ projectId: input.projectId, limit: limit * 4 });

  const out: Harvested[] = [];

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

    // A second claim about an opening already in the portfolio is filed as a
    // linked record of it, so the evidence keeps its row and nothing dives the
    // same request twice. See `duplicates.ts`.
    const twin = await existingOpeningFor({
      projectId: input.projectId,
      sourceUrl: claim.sourceUrl,
      signal,
      evidence: {
        claim: claim.claim,
        title: claim.sourceTitle,
        excerpt: claim.evidenceExcerpt,
        locator: claim.evidenceLocator,
      },
    });

    const created = await createOpportunity({
      duplicateOfId: twin ? twin.id : null,
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
      // A play round asked about one deliverable, so what it found needs that
      // deliverable produced — named here, never guessed from the claim's words.
      requiredCapabilities: context?.bucket.deliverable
        ? [deliverableCapabilityId(context.bucket.deliverable)]
        : [],
      // The deadline the source publishes, as the worker declared it. Null
      // when it states none, which `closedBy` reads as never closed, not open.
      expiresAt: claim.closesOn ?? null,
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

    const missionId = await missionFor(entry.orchestrationId);
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
    await closeEndedRounds({ projectId: input.projectId, live, roundMissions });
  }
  return out;
}

/**
 * Close every live round whose research has ended, so its bucket can be asked
 * again — and record what it found.
 *
 * DONE is `HARVESTED`. FAILED or CANCELLED is `ABANDONED`, and so is a mission
 * parked at a decision (`NEEDS_HUMAN`): that last one is this module's own
 * earlier correction and is kept — production Cash Mode 1 had all ten buckets
 * at round 1, every one parked, and broad discovery had stopped while every row
 * read as waiting. Closing the round ends nothing: the parked mission is left
 * exactly where it is, waiting for its person, and the bucket may be asked
 * again after its cool-off.
 *
 * An idea that never became a mission is left OPEN — answered by its own
 * resumption — except one the archive already answered (`REJECTED`), which is
 * a positive terminal row rather than an absence, and nothing will ever launch.
 *
 * The missions are read by the rounds' own candidate ids (RES-2). `found` is
 * counted from the openings that name this round, for both outcomes, because a
 * round's claims are harvested on the passes they are gated — routinely earlier
 * ones — and a tally of this pass would record a productive round as barren.
 * Guarded on OPEN by `closeRound`, so a second tick or a restart reading the
 * same ended mission closes nothing and writes no second event.
 */
async function closeEndedRounds(input: {
  projectId: string;
  live: Map<string, { round: CashDiscoveryRound; bucket: SearchBucket }>;
  roundMissions: Map<string, RoundMissions>;
}): Promise<string[]> {
  const closed: string[] = [];
  let opportunities: CashOpportunity[] | null = null;
  for (const [candidateId, entry] of input.live) {
    const missions = input.roundMissions.get(candidateId);
    const mission = missions?.latest ?? null;
    const to: 'HARVESTED' | 'ABANDONED' | null =
      missions?.outcome ?? (mission?.state === 'NEEDS_HUMAN' ? 'ABANDONED' : null);
    if (!to) continue;
    opportunities ??= await listOpportunities({ projectId: input.projectId });
    const found = opportunities.filter((one) => one.discoveryRoundId === entry.round.id).length;
    if (!(await closeRound({ id: entry.round.id, to, found }))) continue;
    closed.push(entry.round.id);
    if (to === 'HARVESTED') continue;
    const why = mission
      ? `its research is ${mission.state.toLowerCase()}`
      : 'the archive already answered it, so nothing launched';
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'CASH_DISCOVERY_ROUND_STOPPED',
      actorRef: 'BRAIN',
      summary:
        `Discovery round ${entry.round.round} of "${entry.bucket.title}" stopped without ` +
        `finishing (${why}), having filed ${found} ` +
        'opening(s). The bucket will be asked again after its cool-off.',
      detail: {
        roundId: entry.round.id,
        bucketId: entry.bucket.id,
        missionId: mission?.id ?? null,
        missionState: mission?.state ?? null,
        found,
      },
    });
  }
  return closed;
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
export async function runDiscovery(
  projectId: string,
  options: {
    /**
     * Whether the reconciliations over every opportunity run this tick. They
     * wait under database pressure; opening and harvesting never do.
     */
    sweep?: boolean;
  } = {},
): Promise<{
  opened: OpenedDiscovery[];
  harvested: Harvested[];
  /** True only on the tick that first wrote the discovery authorization. */
  authorized: boolean;
  /** Ideas that had parked for want of it and are back in the queue. */
  resumed: string[];
  /** Pieces whose kind of opening was read back from their own source claim. */
  signalled: string[];
  /** Reconciliations that threw this tick; opening and harvesting still ran. */
  failures: string[];
}> {
  // One read answers both halves for the many projects that hold no sprint at
  // all, which is what makes this cheap enough to run for every project on
  // every tick.
  if (!(await getCashMode(projectId))) {
    return { opened: [], harvested: [], authorized: false, resumed: [], signalled: [], failures: [] };
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
   * guarded on the exact state it is answering. `resumeAuthorityParkedCandidates`
   * is a Cash-Mode-specific caller of the one rule now — `../russell/
   * resumeParked.ts` resumes the identical kind of park for every project, on
   * the durable tick, so this call site is what keeps this project's own
   * `CASH_DISCOVERY_RESUMED` reporting exactly what it was rather than leaving
   * this project to the general sweep.
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
  /*
   * The two reconciliations below repair rows written before a column
   * existed. A failure in either is reported and does not stop the sprint
   * from asking new questions or filing what came back: they used to sit in
   * front of `openDiscovery`, so one of them throwing on every tick would
   * leave a sprint with no open round and nothing saying why.
   */
  const failures: string[] = [];
  const reconcile = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      failures.push(`${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      return fallback;
    }
  };
  const sweep = options.sweep ?? true;
  const signalled = sweep
    ? await reconcile('signals', () => reconcileOpportunitySignals(projectId), [] as string[])
    : [];

  // And the second records of one opening written before this existed.
  if (sweep) await reconcile('duplicates', () => markDuplicateOpenings(projectId), undefined);

  return {
    opened: await openDiscovery({ projectId, limit: 1 }),
    harvested: await harvest({ projectId, limit: 10 }),
    authorized: authorized?.created ?? false,
    resumed: resumed.map((one) => one.candidateId),
    signalled,
    failures,
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
