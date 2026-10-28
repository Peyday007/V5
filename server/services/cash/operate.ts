/**
 * The part where Brain does something about a need, rather than filing it.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `cash_opportunities.required_capabilities` was written and read by nothing,
 * so a piece could declare that collecting its money needs a payment processor
 * and reach `READY` against a Brain that has none and had never been asked.
 * `closeNeed` set a status and wrote an event: nothing resumed, because nothing
 * recorded what had been waiting. A person could answer the same need over and
 * over and never learn that their answer was recorded and ignored.
 *
 * Both are §24's sentence at a new altitude — a state that says "waiting for a
 * person" which that person cannot resolve is not waiting, it is stuck — and
 * the remedy is the one this repository has reached for every other time:
 * derive the condition from rows instead of hooking the moment it changed. A
 * hook fixes one entrance; rows reach every entrance plus everything already
 * stranded.
 *
 * ---------------------------------------------------------------------------
 * Three passes, and what each of them may not do
 * ---------------------------------------------------------------------------
 *
 * `reconcileCapabilityNeeds` raises one need per capability an opportunity
 * requires and this Brain does not verifiably have, and settles one whose
 * capability has since arrived or is no longer required. It reads the
 * capability at the moment it asks, never a cache: a fleet that lost its last
 * healthy Routine an hour ago must not still be reported as able to research.
 *
 * `runNeedContinuations` retries the transition a settled need was blocking,
 * exactly once, on the far side of a compare-and-swap on `continued_at`. It
 * never invents an action to justify the transition — `beginExecution` without
 * a `firstAction` advances only if something is already on the record, so a
 * resolved need can unblock a piece and cannot fabricate one.
 *
 * `startDependentWork` is what makes a need a *dependent work reference* rather
 * than a note: where the missing thing is a question rather than an
 * integration, Brain captures an idea for it, and from there the ordinary path
 * runs — the archive check first, the judgment, the compiler, the envelope, the
 * evidence gate, all three audit roles. It captures and never launches, because
 * launching is `nextLaunchable`'s and spending is the standing authority's.
 *
 * **None of it gates anything.** No pass here refuses an opportunity, charges
 * an attempt, or stops unrelated work. An open need is a valid execution state
 * and Brain carries on around it, which is exactly what the plan means.
 */
import { reconcileCashJobs, type JobReconciliation } from './jobPipeline.ts';
import { handOffReadyTests, type FactoryHandoffPass } from './factoryHandoff.ts';
import { advanceJourney, type JourneyTickReport } from './journey/tick.ts';
import {
  getOpportunity,
  listNeeds,
  listOpportunities,
  needsAwaitingContinuation,
  claimNeedContinuation,
  deferNeedContinuation,
  finishNeedContinuation,
  setNeedCandidate,
  replaceNeedCandidate,
  opportunitiesRequiring,
  opportunitiesTouchedSince,
  setNeedBlockerKeyIfUnset,
} from '../../repos/cashPortfolio.ts';
import { advanceWatermark, getWatermark } from '../../repos/cashReconsideration.ts';
import { parseBlockerKey } from '../../domain/types.ts';
import {
  recordDerivedReopenConditions,
  reconsiderAffected,
  type DerivedCondition,
  type ReconsiderPass,
} from './reconsider.ts';
import { projectStandings, recordStandingChanges, type StandingChange } from './standing.ts';
import { createCandidate, getCandidate } from '../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import {
  readAllCapabilities,
  readCapability,
  readingFrom,
  needForCapability,
  type CapabilityReading,
} from './capabilities.ts';
import { cardFact, cardFactsFor } from '../../repos/cashCardFacts.ts';
import { evidenceCard } from './card.ts';
import { cashEngineCard, NEED_RESEARCHABLE_ENGINE_FIELDS } from './engineCard.ts';
import { CAPTURE_INPUTS, cashTier } from './tier.ts';
import { questionKey } from './conditions.ts';
import { closeNeed, raiseNeed } from './needs.ts';
import { applyProposal, applyResearchAnswers, proposeTerms } from './answers.ts';
import { runValidations, whyNotDiving, type ValidationProgress } from './validation.ts';
import { enumeratePossibilities } from './monetization/enumerate.ts';
import { recordMovements } from './monetization/movement.ts';
import { composeLedger } from './monetization/ledger.ts';
import { runCommissions, type CommissionPass } from './monetization/commissionPass.ts';
import { recordWorkModelReclassification, type Reclassification } from './reclassify.ts';
import type { ResearchApplication } from './answers.ts';
import { actionKey, beginExecution, markReady } from './opportunities.ts';
import { checkCommercialAuthority } from './authority.ts';
import { commercialOperationsFor, sendCommercialEffect } from './effects.ts';
import { composeBuyerMessage } from './outreach.ts';
import { runInvoicing, type InvoicingPass } from './invoicing.ts';
import {
  alreadyContacted,
  applyEffectOutcome,
  reconcileConfirmedEffects,
  recoverAbandonedEffects,
  sendGate,
  type ReconciledEffect,
  prepare,
} from './perform.ts';
import type { ExternalOutcome } from '../effects/external.ts';
import { cashNow, getCashMode } from '../../repos/cashMode.ts';
import { describeNotWorthResearching, notWorthResearching } from './worthResearching.ts';
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';

/** Brain acting on its own account, never a person and never a worker. */
const BRAIN = 'BRAIN';

/**
 * The first commercial act on a piece that is ready, and what it needs.
 *
 * Named here rather than chosen per opportunity, because "which action is this"
 * is the thing the grant is asked about — deriving it from prose on the card
 * would be a model judgement deciding what a person authorized.
 */
const CONTACT_ACTION = 'CONTACT_BUYER';
const CONTACT_CAPABILITY = 'SEND_A_MESSAGE';

/**
 * The states worth asking a capability question about.
 *
 * A declined or archived piece is one the sprint stopped pursuing, and raising
 * a need for it would fill the review with remedies nobody wants applied.
 */
const LIVE_STATES = ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING'] as const;

/**
 * The key a capability need is raised under.
 *
 * Built from the opportunity and the capability, which are both server facts,
 * so the same missing capability raises one need however many ticks read it —
 * and so the pass that settles it can find the row by construction rather than
 * by parsing anything back out of it.
 */
function capabilityKey(opportunityId: string, capabilityId: string): string {
  return `capability:${opportunityId}:${capabilityId}`;
}

export interface CapabilityReconciliation {
  raised: string[];
  settled: string[];
  /** How many pieces this pass looked at. A pass over an unchanged portfolio looks at few. */
  examined?: number;
}

/** The watermark the capability-need pass reads its own position from. */
export const CAPABILITY_NEEDS_SOURCE = 'capability-needs';

/**
 * How far back the touched-pieces read reaches past the last position.
 *
 * A row committed a moment after the pass read the clock carries a timestamp
 * just before it; reading a little behind the watermark re-reads those rather
 * than missing them. Re-reading is free: raising is idempotent by request key
 * and settling only moves an open need.
 */
const TOUCHED_OVERLAP_MS = 5 * 60_000;

function capabilityMarker(
  readings: ReadonlyMap<string, CapabilityReading>,
  previous: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...previous };
  for (const reading of readings.values()) {
    // A reader that could not answer has not answered; its last value stands.
    if (reading.state === 'UNKNOWN') continue;
    out[reading.id] = reading.state;
  }
  return out;
}

function markerOf(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
}

function readMarker(marker: string | null | undefined): Record<string, string> {
  if (!marker) return {};
  try {
    const parsed = JSON.parse(marker) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/**
 * Raise one need per capability a piece requires and this Brain does not
 * verifiably have; settle one whose capability arrived or is no longer
 * required.
 *
 * **It no longer rescans the portfolio.** The vocabulary is read once — by the
 * reconsideration pass, which hands its readings in, or here when called on its
 * own — and compared with the readings this pass last acted on. The pieces it
 * looks at are the ones that could have changed: those written since its last
 * position (created, edited, moved, or flagged for reconsideration), and those
 * requiring a capability whose reading changed. On its first pass, with no
 * position, it looks at everything once. Every need it raises carries the
 * shared `CAPABILITY:<id>` blocker key, so one indexed read finds every piece a
 * capability arriving unblocks.
 */
export async function reconcileCapabilityNeeds(
  projectId: string,
  context: { readings?: ReadonlyMap<string, CapabilityReading> } = {},
): Promise<CapabilityReconciliation> {
  const out: CapabilityReconciliation = { raised: [], settled: [] };
  // The real clock, never a caller's `now`: this is a position in the rows'
  // own timestamps, which are written by the real clock.
  const startedAt = new Date().toISOString();
  const readings = context.readings ?? (await readAllCapabilities());
  const watermark = await getWatermark(projectId, CAPABILITY_NEEDS_SOURCE);
  const previous = readMarker(watermark?.marker);
  const current = capabilityMarker(readings, previous);
  const changed = Object.keys(current).filter((id) => previous[id] !== current[id]);

  let pieces: CashOpportunity[];
  if (!watermark) {
    pieces = await listOpportunities({ projectId });
  } else {
    const since = new Date(Date.parse(watermark.through) - TOUCHED_OVERLAP_MS).toISOString();
    const byId = new Map<string, CashOpportunity>();
    for (const one of await opportunitiesTouchedSince(projectId, since)) byId.set(one.id, one);
    for (const one of await opportunitiesRequiring({
      projectId,
      capabilityIds: changed,
      states: [...LIVE_STATES],
    })) {
      byId.set(one.id, one);
    }
    pieces = [...byId.values()];
  }
  out.examined = pieces.length;

  if (pieces.length > 0) {
    const examined = new Set(pieces.map((one) => one.id));
    const open = await listNeeds({ projectId, states: ['OPEN'] });
    const byKey = new Map(
      open
        .filter((one) => one.requestKey?.startsWith('capability:') && examined.has(one.opportunityId ?? ''))
        .map((one) => [one.requestKey!, one]),
    );
    const wanted = new Set<string>();

    for (const opportunity of pieces) {
      if (!(LIVE_STATES as readonly string[]).includes(opportunity.state)) continue;
      // A second record of an opening asks nothing: its needs were withdrawn when
      // it was linked, and the survivor asks them.
      if (opportunity.duplicateOfId) continue;
      for (const capabilityId of opportunity.requiredCapabilities) {
        const key = capabilityKey(opportunity.id, capabilityId);
        wanted.add(key);
        const reading = readingFrom(readings, capabilityId);
        const existing = byKey.get(key);
        const blockerKey = parseBlockerKey(`CAPABILITY:${capabilityId}`);

        if (reading.state === 'PRESENT') {
          if (!existing) continue;
          const closed = await closeNeed({
            needId: existing.id,
            to: 'RESOLVED',
            resolution:
              `${reading.id} now reads PRESENT, so this is no longer blocked. Brain checked rather ` +
              'than assumed: the reading comes from the rows the capability is made of.',
            actorUserId: BRAIN,
            // Read this pass, once, for every piece: closing does not read it again.
            verifiedBy: 'BRAIN_READ_THE_ROW',
          });
          if (closed.ok) out.settled.push(existing.id);
          continue;
        }

        if (existing) {
          // A need raised before blocker keys existed is given its key, so the
          // fan-out finds it when the capability arrives.
          if (!existing.blockerKey && blockerKey) await setNeedBlockerKeyIfUnset(existing.id, blockerKey);
          continue;
        }
        const composed = needForCapability(reading, `Progress "${opportunity.title}"`);
        if (!composed) continue;
        const raised = await raiseNeed({
          projectId,
          opportunityId: opportunity.id,
          actorRef: BRAIN,
          ...composed,
          // What is waiting on it. A *state* rather than a free reference,
          // because a state is what a continuation can actually retry.
          blocksState: 'EXECUTING',
          requestKey: key,
          blockerKey,
        });
        if (raised.ok && raised.value.createdAt === raised.value.updatedAt) {
          out.raised.push(raised.value.id);
        }
      }
    }

    /*
     * A need for something no longer required is withdrawn, not left open.
     *
     * An opportunity whose card was corrected — the capability was never needed,
     * or the piece was declined — would otherwise keep a remedy in the review for
     * ever, and a review that accumulates answered questions is one people stop
     * reading. Withdrawn rather than resolved: nothing was set up. Only for the
     * pieces examined: a piece nobody touched still requires what it required.
     */
    for (const [key, need] of byKey) {
      if (wanted.has(key)) continue;
      const closed = await closeNeed({
        needId: need.id,
        to: 'WITHDRAWN',
        resolution:
          'Nothing requires this capability any more — the piece stopped needing it, or stopped ' +
          'being pursued. Nothing was set up, so this is withdrawn rather than resolved.',
        actorUserId: BRAIN,
      });
      if (closed.ok) out.settled.push(need.id);
    }
  }

  /*
   * The position moves last, guarded on the one read, so a pass that died
   * above is replayed in full by the next — every step here is idempotent.
   */
  await advanceWatermark({
    projectId,
    source: CAPABILITY_NEEDS_SOURCE,
    from: watermark?.through ?? null,
    through: startedAt,
    marker: markerOf(current),
    ...(watermark ? { fromMarker: watermark.marker } : {}),
  });
  return out;
}

export interface DiscoverableGap {
  needId: string;
  opportunityId: string;
  field: string;
}

/**
 * Turn the card's *facts* into Brain's work, and leave its decisions alone.
 *
 * `evidenceCard` says which is which, and the set moved. It used to be three
 * fields — the payer, the access route and the buying evidence — with the
 * price, the delivery path, who does the work, the cash dates, the economics
 * and the exposure all classified as the owner's calls. §30 had already
 * corrected the reasoning ("a commercial judgment is not permanently a
 * person's either") and the boolean had not moved with it, so production put
 * ninety-eight of those in front of somebody as decisions while Brain's own
 * screen said it was researching them.
 *
 * What a price, a fee, a settlement date, an eligibility rule or a delivery
 * requirement *is*, is a fact about the world. Brain raises a need and looks it
 * up. What is left for a person is what to offer and what counts as accepted —
 * `BRAIN_PROPOSES`, which Brain proposes and a person may overrule — and those
 * still never become needs, because a researched answer to "what should we
 * charge for this" is invented judgment wearing a citation.
 */
/** Price below exposure on the piece's own columns: the reading `jobEligibility` and the tier refuse on too. */
function losesMoneyOnItsFigures(opportunity: CashOpportunity): boolean {
  return (
    opportunity.priceCents !== null &&
    opportunity.peakFundingCents !== null &&
    opportunity.priceCents < opportunity.peakFundingCents
  );
}
const LOSES_MONEY =
  'Its published price does not cover its published capital exposure, so one sale loses money; ' +
  'nothing is readied or contacted for it.';

/**
 * Field research nobody could act on, withdrawn before it is launched.
 *
 * A `question:` need asks one card field about one opening. On an opening that
 * is not worth researching now (`worthResearching.ts`) — a marketplace listing,
 * a close inside the runway, capital the ledger does not hold — the answer
 * could not make it executable, and each launched need holds a research slot
 * that a workable opening is waiting for. Withdrawn rather than resolved:
 * nothing was established. It is raised again by itself if the opening becomes
 * worth researching, because the gap passes derive it from the card.
 */
export async function withdrawResearchNotWorthIt(projectId: string): Promise<string[]> {
  const out: string[] = [];
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  const byOpportunity = new Map<string, CashNeed[]>();
  for (const need of open) {
    if (!need.opportunityId || !need.requestKey?.startsWith('question:')) continue;
    byOpportunity.set(need.opportunityId, [...(byOpportunity.get(need.opportunityId) ?? []), need]);
  }
  if (byOpportunity.size === 0) return out;
  for (const opportunity of await listOpportunities({ projectId, states: ['DISCOVERED', 'EVIDENCE_CARD'] })) {
    const needs = byOpportunity.get(opportunity.id);
    if (!needs) continue;
    const reason = await notWorthResearching(opportunity, { now: cashNow() });
    if (!reason) continue;
    for (const need of needs) {
      const closed = await closeNeed({
        needId: need.id,
        to: 'WITHDRAWN',
        resolution: `Not researched: ${describeNotWorthResearching(reason)}. Nothing was established, so this is withdrawn rather than resolved.`,
        actorUserId: BRAIN,
      });
      if (closed.ok) out.push(need.id);
    }
  }
  return out;
}

export async function reconcileDiscoverableGaps(projectId: string): Promise<DiscoverableGap[]> {
  const out: DiscoverableGap[] = [];
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  const keys = new Set(open.map((one) => one.requestKey).filter((one): one is string => !!one));

  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    // A second record of an opening is researched through its survivor, never
    // again on its own (`duplicates.ts`).
    if (opportunity.duplicateOfId) continue;
    /*
     * Only for something Brain has a reason to spend on.
     *
     * Widening the researched set from three fields to seven made this reach
     * every blank on every record — and most records are signals, so a sprint
     * holding thirty-one published price lists would have raised two hundred
     * needs asking what to charge for somebody else's product. A need is
     * Brain's own work item; two hundred of them is the allowance spent
     * qualifying things that are not opportunities.
     *
     * The instrument that moves a **signal** is the bounded deep dive, which
     * asks the payer lane and is capped at two in flight. This is the fallback
     * for what the dive left blank, so it runs once there is a capture thesis
     * — a named payer and something to supply them — which is exactly the
     * point at which spending more on the piece is justified.
     */
    /*
     * Not while the opening's own deep dive is still asking.
     *
     * The dive asks every one of these questions about this exact opening, so
     * a need raised beside it researches the same thing twice — and each need
     * is a mission holding one of the grant's slots. Production, Cash Mode 1:
     * the "Access for" and "Payer for" missions of one opening held two of
     * six slots while that opening's dive ran in a third. What the dive leaves
     * blank is asked once it has settled, which is what this pass is for.
     */
    if (diveOwnsItsQuestions(opportunity)) continue;
    if (await notWorthResearching(opportunity, { now: cashNow() })) continue;
    const card = evidenceCard(opportunity);
    const engine = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) });
    /*
     * And not for an opening a published fact already rules out. Asking what
     * a closed RFP pays is the allowance spent on a question whose answer
     * cannot change the decision.
     */
    if (engine.disqualifiedBy) continue;
    const reading = cashTier({
      opportunity,
      card: engine,
      readiness: card.readiness,
    });
    /*
     * A signal is asked only the questions that could stop it being one.
     *
     * `captureMechanism` is composed from a payer, an offer and a route, so
     * those are the questions worth spending on while nothing says anybody
     * would pay us. Everything else on the card asks what a *decision* turns
     * on, and there is no decision to make about a published price list —
     * production held thirty-one of them, and asking all seven of each would
     * have been two hundred questions about what to charge for somebody
     * else's product.
     *
     * Skipping a signal *entirely* was the first version and was one bound too
     * many: it left the payer unasked, which is the single question that could
     * have moved the piece.
     */
    const asking =
      reading.tier === 'SIGNAL'
        ? card.fields.filter((one) => (CAPTURE_INPUTS as readonly string[]).includes(one.key))
        : card.fields;

    for (const field of asking) {
      if (!field.loadBearing || field.owner !== 'BRAIN_RESEARCH' || field.value !== null) continue;
      const key = questionKey(opportunity.id, field.key);
      if (keys.has(key)) continue;
      const raised = await raiseNeed({
        projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: `${field.label} for "${opportunity.title}"`,
        whyItMatters:
          `This card cannot be tested without it, and it is a fact about the world rather than ` +
          'a decision of yours — so Brain looks it up rather than asking you.',
        recommendedPath: field.task,
        setupEffort: 'One bounded look.',
        nextStep: field.task,
        completionCondition: `The ${field.label.toLowerCase()} is recorded on this card.`,
        blocksState: 'EXECUTING',
        requestKey: key,
        /*
         * `FIELD:<card field>`: what settles this is this piece's own card
         * answering, so the key is per field and the fact it watches is per
         * piece. Supplier, cost and customer facts are card fields too
         * (`fulfillment`, `price`/`directCosts`, `payer`), so a missing one is
         * `FIELD:<that field>` here — the market-wide SUPPLIER/COST/CUSTOMER
         * kinds stay NOT_DETECTED (domain/types.ts) until a row records one.
         */
        blockerKey: parseBlockerKey(`FIELD:${field.key}`),
      });
      if (!raised.ok) continue;
      keys.add(key);
      out.push({ needId: raised.value.id, opportunityId: opportunity.id, field: field.key });
    }
  }

  /*
   * And a gap that has since been filled is settled, by whoever filled it.
   *
   * Derived from the card rather than hooked to the moment somebody typed the
   * answer, so a blank filled by a person, by a worker's accepted claim or by
   * a harvest all reach it — and so do the needs already stranded.
   */
  for (const need of open) {
    if (!need.requestKey?.startsWith('question:') || !need.opportunityId) continue;
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    /*
     * Matched by rebuilding the key, never by slicing it apart.
     *
     * Brain wrote the key from the opportunity and the field, so asking which
     * field produces this key is reading its own row back. Parsing the suffix
     * out would work today and would be wrong the first time a field name
     * carried the separator — and a need that stopped matching would sit open
     * for ever against a card that had already answered it.
     */
    const answered = evidenceCard(opportunity).fields.find(
      (one) => questionKey(need.opportunityId!, one.key) === need.requestKey,
    );
    if (!answered || answered.value === null) continue;
    await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: `The ${answered.label.toLowerCase()} is now on the card, so this is answered.`,
      actorUserId: BRAIN,
    });
  }

  return out;
}

/**
 * How many engine-field questions may be open at once across a project.
 *
 * Each becomes a research mission holding one of the grant's slots, so this is
 * concurrency rather than a quota: the next pass raises more as these settle.
 */
export const MAX_OPEN_ENGINE_QUESTIONS = 12;

/**
 * The qualification questions only a deep dive used to ask, asked one at a
 * time once an opening's dives for this epoch are spent.
 *
 * Production, Cash Mode 1, 2026-10-20: 79 openings at CANDIDATE and none
 * QUALIFIED. The needs path above asks only the short card's column fields,
 * and the rest of the qualification set — eligibility, costs, capital, labour,
 * time to first cash, whether calling is required — has no column and was
 * answerable only by the bounded deep dive, two per change epoch. Twenty-six
 * openings had spent both and still had those blanks, so nothing could ever
 * ask again until the world changed: a bar with no way over it, which is a park
 * rather than a standard.
 *
 * The evidence bar does not move. Each question is one narrow need answered by
 * its own research mission through the same gate, and only a citable, sourced
 * claim lands on the card (`answers.ts`). `disqualifiers` is never asked here
 * (`NEED_RESEARCHABLE_ENGINE_FIELDS`).
 *
 * Ordered by what a person would want answered first: openings nearest to
 * qualifying, then the largest published contribution per sale, then the
 * smallest capital at risk. Unknown figures sort last, never first.
 */
export async function reconcileEngineGaps(projectId: string): Promise<DiscoverableGap[]> {
  const out: DiscoverableGap[] = [];
  const mode = await getCashMode(projectId);
  if (!mode || mode.state !== 'ACTIVE') return out;
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  const keys = new Set(open.map((one) => one.requestKey).filter((one): one is string => !!one));
  const engineKeys = new Set<string>(NEED_RESEARCHABLE_ENGINE_FIELDS);
  /*
   * A question answered some other way — a later dive, a person — is settled
   * from the card, so an open need never sits beside a filled field.
   */
  for (const need of open) {
    if (!need.opportunityId || !need.requestKey?.startsWith('question:')) continue;
    const field = need.requestKey.slice(need.requestKey.lastIndexOf(':') + 1);
    if (!engineKeys.has(field) || need.requestKey !== questionKey(need.opportunityId, field)) continue;
    const fact = await cardFact(need.opportunityId, field);
    if (!fact) continue;
    await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: `The ${field} is now on the card, so this is answered.`,
      actorUserId: BRAIN,
    });
    keys.delete(need.requestKey);
    need.state = 'RESOLVED';
  }
  let openEngine = open.filter(
    (one) =>
      one.state === 'OPEN' &&
      one.opportunityId &&
      one.requestKey?.startsWith('question:') &&
      engineKeys.has(one.requestKey.slice(one.requestKey.lastIndexOf(':') + 1)),
  ).length;
  if (openEngine >= MAX_OPEN_ENGINE_QUESTIONS) return out;

  const ranked: { opportunity: CashOpportunity; fields: string[]; contribution: number | null }[] = [];
  for (const opportunity of await listOpportunities({ projectId, states: ['DISCOVERED', 'EVIDENCE_CARD'] })) {
    if (opportunity.duplicateOfId) continue;
    if (diveOwnsItsQuestions(opportunity)) continue;
    if (await notWorthResearching(opportunity, { now: cashNow() })) continue;
    const engine = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) });
    if (engine.disqualifiedBy) continue;
    const reading = cashTier({ opportunity, card: engine, readiness: evidenceCard(opportunity).readiness });
    if (reading.tier !== 'CANDIDATE') continue;
    const fields = reading.toAdvance
      .map((one) => one.key as string)
      .filter((key) => engineKeys.has(key) && !keys.has(questionKey(opportunity.id, key)));
    if (fields.length === 0) continue;
    // Only once the deep dive cannot ask: a dive asks every one of these at once.
    if ((await whyNotDiving(opportunity)).kind !== 'EPOCH_SPENT') continue;
    const contribution =
      opportunity.priceCents !== null && opportunity.peakFundingCents !== null
        ? opportunity.priceCents - opportunity.peakFundingCents
        : null;
    // A published loss is not worth qualifying further.
    if (contribution !== null && contribution < 0) continue;
    ranked.push({ opportunity, fields, contribution });
  }
  ranked.sort(
    (a, b) =>
      a.fields.length - b.fields.length ||
      (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity) ||
      (a.opportunity.peakFundingCents ?? Infinity) - (b.opportunity.peakFundingCents ?? Infinity) ||
      (a.opportunity.createdAt < b.opportunity.createdAt ? -1 : 1),
  );

  for (const { opportunity, fields } of ranked) {
    const card = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) });
    for (const field of fields) {
      if (openEngine >= MAX_OPEN_ENGINE_QUESTIONS) return out;
      const entry = card.entries.find((one) => one.key === field);
      const key = questionKey(opportunity.id, field);
      const raised = await raiseNeed({
        projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: `${entry?.label ?? field} for "${opportunity.title}"`,
        whyItMatters:
          'This opening cannot be qualified without it, its deep dives for this epoch are spent, ' +
          'and it is a fact about the world — so Brain looks it up as one narrow question.',
        recommendedPath: entry?.task ?? `Establish the ${field} from published sources.`,
        setupEffort: 'One bounded look.',
        nextStep: entry?.task ?? `Establish the ${field} from published sources.`,
        completionCondition: `The ${field} is recorded on this card.`,
        blocksState: 'EXECUTING',
        requestKey: key,
        blockerKey: parseBlockerKey(`FIELD:${field}`),
      });
      if (!raised.ok) continue;
      keys.add(key);
      openEngine += 1;
      out.push({ needId: raised.value.id, opportunityId: opportunity.id, field });
    }
  }
  return out;
}

export interface Continuation {
  needId: string;
  /** What actually happened, which is not the same fact as that it ran. */
  note: string;
  resumed: boolean;
  /** True when it will be tried again: a wait rather than an answer. */
  retry: boolean;
}

export async function runNeedContinuations(
  projectId: string,
  now?: string,
): Promise<Continuation[]> {
  const out: Continuation[] = [];
  const at = now ?? new Date().toISOString();
  for (const need of await needsAwaitingContinuation(projectId, at)) {
    // Claim first. The effect belongs on the far side of the compare-and-swap,
    // because two ticks reading one resolved need must produce one resumption.
    if (!(await claimNeedContinuation(need.id, at))) continue;
    const result = await continueOne(need);
    if (result.retry) {
      /*
       * Not yet, rather than never.
       *
       * The claim used to be terminal and written *before* the attempt, so a
       * refusal that was only ever going to be temporary — no commercial grant
       * yet, no free execution slot, the piece still at EVIDENCE_CARD — spent
       * the one chance the need had. The ordinary path made that the common
       * case, because a card filled by research leaves a piece short of READY.
       */
      await deferNeedContinuation({
        id: need.id,
        note: result.note,
        attempts: need.continuationAttempts + 1,
        now: at,
      });
    } else {
      await finishNeedContinuation(need.id, result.note);
    }
    out.push({ needId: need.id, note: result.note, resumed: result.resumed, retry: result.retry });
  }
  return out;
}

async function continueOne(
  need: CashNeed,
): Promise<{ note: string; resumed: boolean; retry: boolean }> {
  if (need.state === 'WITHDRAWN') {
    return {
      note: 'Withdrawn, so there was nothing waiting to resume.',
      resumed: false,
      retry: false,
    };
  }
  if (!need.blocksState || !need.opportunityId) {
    return { note: 'Nothing was recorded as waiting on this.', resumed: false, retry: false };
  }
  const opportunity = await getOpportunity(need.opportunityId);
  if (!opportunity) {
    return { note: 'The piece it was blocking no longer exists.', resumed: false, retry: false };
  }
  if (need.blocksState !== 'EXECUTING') {
    return {
      note: `Nothing here knows how to resume a ${need.blocksState} transition.`,
      resumed: false,
      retry: false,
    };
  }
  if (TERMINAL_STATES.has(opportunity.state)) {
    return {
      note: `The piece is ${opportunity.state.toLowerCase()}, so nothing is waiting on this.`,
      resumed: false,
      retry: false,
    };
  }
  if (opportunity.state !== 'READY' && opportunity.state !== 'DISCOVERED' &&
      opportunity.state !== 'EVIDENCE_CARD') {
    return {
      note: `The piece is ${opportunity.state.toLowerCase()}, so the transition it was blocking ` +
        'has already happened.',
      resumed: false,
      retry: false,
    };
  }

  /*
   * Resume from where the piece actually is.
   *
   * A card answered by research leaves it at `EVIDENCE_CARD`, so resuming has
   * to carry it through `markReady` first — the transition the need was
   * genuinely blocking is downstream of one the need's answer just unblocked.
   * Retrying `beginExecution` alone against an EVIDENCE_CARD piece spent the
   * continuation on a state that was never going to accept it.
   */
  if (opportunity.state !== 'READY') {
    const ready = await markReady({ opportunityId: opportunity.id, actorRef: BRAIN });
    if (!ready.ok) {
      return {
        note: `Not ready yet: ${ready.reason}`,
        resumed: false,
        retry: true,
      };
    }
  }

  /*
   * Retried, never forced.
   *
   * No `firstAction`, so this advances the piece only if something is already
   * on the record. A resolved need can unblock work and can never manufacture
   * the evidence that work began — which is the whole of what the
   * `cash_actions` correction is for, and it would be undone by a continuation
   * that supplied its own action to get the transition through.
   */
  const resumed = await beginExecution({ opportunityId: opportunity.id, actorRef: BRAIN });
  if (resumed.ok) {
    return { note: `Resumed: ${resumed.message ?? 'executing'}.`, resumed: true, retry: false };
  }

  /*
   * A refusal that names a condition somebody is about to fix is a wait.
   *
   * §27 settled the same distinction for dispatch refusals: a refusal meaning
   * "setup is missing" is not a refusal meaning "this may not happen", and
   * treating them alike destroys the work. Waiting on a grant, a slot or an
   * action is the first kind; the piece having gone somewhere else is the
   * second.
   */
  return {
    note: `Tried to resume and could not: ${resumed.reason}`,
    resumed: false,
    retry: isTemporary(resumed.reason),
  };
}

/** Opportunity states past which nothing is waiting on a need. */
const TERMINAL_STATES = new Set(['COLLECTED', 'DECLINED', 'ARCHIVED']);

/**
 * Is this refusal a condition that is expected to stop being true?
 *
 * Matched on the refusal's own shape rather than on a string a model wrote —
 * every one of these is composed by `beginExecution` from rows, and each names
 * something an authorized action resolves: granting the authority, finishing
 * something that occupies a slot, funding the account, or recording the first
 * action a person performed.
 */
export function isTemporary(reason: string): boolean {
  return (
    reason.includes('commercial authority') ||
    reason.includes('execution slots are taken') ||
    reason.includes('deployable') ||
    reason.includes('Nothing has happened on this yet')
  );
}

/**
 * Whether the opening's own deep dive is still asking its questions.
 *
 * The dive asks every card question about this exact opening, so fallback
 * research beside it buys the same answers twice and holds a mission slot to
 * do it. Parked at a person counts: answering that card resumes the dive.
 */
export function diveOwnsItsQuestions(opportunity: CashOpportunity): boolean {
  return (
    opportunity.validationState === 'PENDING' ||
    opportunity.validationState === 'RUNNING' ||
    opportunity.validationState === 'NEEDS_PERSON'
  );
}

export interface DependentWork {
  needId: string;
  candidateId: string;
}

/**
 * The question a need's research actually asks: the opening named, then the
 * one thing to establish.
 *
 * It used to be the need's `whyItMatters` and `nextStep` — *"This card cannot
 * be tested without it … Name the person or role who can approve payment."* —
 * and the compiler takes a candidate's statement as the question, so a worker
 * was asked who approves payment with no "it", no market and no opening.
 * Production, Cash Mode 1: workers refused these as unanswerable ("refers to
 * an unseen 'card', names no market") and the missions failed, each holding a
 * slot first. The opening is described in the same quoted shape the deep dive
 * uses, so nothing here is invented and the envelope reads it the same way.
 */
export function dependentQuestion(
  opportunity: CashOpportunity,
  need: Pick<CashNeed, 'nextStep'>,
): string {
  const signal = (opportunity.buyingSignal ?? opportunity.title).replace(/\s+/g, ' ').trim();
  const source = opportunity.source ? ` The source is ${opportunity.source}.` : '';
  const observed = opportunity.signalObservedAt
    ? ` It was published or observed on ${opportunity.signalObservedAt}.`
    : '';
  return (
    `${OPENING_NAMED} — "${signal}" — establish one thing from published ` +
    `sources: ${need.nextStep.trim()}${source}${observed}`
  ).trim();
}

/**
 * Turn the questions among the open needs into real work.
 *
 * Only where the missing thing is a *question* — an unrecognised capability is
 * something to describe, an absent integration is something to set up, and
 * neither is answered by research. Captured rather than launched: the archive
 * is asked first, the judgment decides, and the standing authority decides
 * whether anything may be spent. None of those is this function's to make.
 */
export async function startDependentWork(projectId: string): Promise<DependentWork[]> {
  if (!(await getCashMode(projectId))) return [];
  const out: DependentWork[] = [];
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (!need.opportunityId) continue;
    if (!need.requestKey?.startsWith('question:')) continue;
    /*
     * A need already asked is asked again only when its first question named
     * no opening and its research then failed — once, because the replacement
     * carries the new shape and never matches this again.
     */
    const previous = need.candidateId ? await askedWithoutTheOpening(need.candidateId) : null;
    if (need.candidateId && !previous) continue;
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    /*
     * The same two refusals the raising pass applies, at the launch.
     *
     * Raising was gated and launching was not, so a need raised before either
     * condition held still became a mission: production launched "Access for"
     * and "Payer for" an opening whose dive was parked, and "Payer for" a
     * closed RFP, into four of six slots. The need stays open; it is simply
     * not turned into work while the dive owns the question or the opening is
     * ruled out, and it launches by itself the tick that stops being true.
     */
    if (diveOwnsItsQuestions(opportunity)) continue;
    if (cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }).disqualifiedBy) {
      continue;
    }
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: need.blockedAction,
      statement: dependentQuestion(opportunity, need),
    });
    const pointed = previous
      ? await replaceNeedCandidate(need.id, previous, candidate.id)
      : await setNeedCandidate(need.id, candidate.id);
    if (!pointed) continue;
    out.push({ needId: need.id, candidateId: candidate.id });
  }
  return out;
}

/** The shape every `dependentQuestion` begins with. */
const OPENING_NAMED = 'For this specific opening';

/**
 * The idea id, when that idea asked a need's question without naming the
 * opening and its research ended without an answer; otherwise null.
 */
async function askedWithoutTheOpening(candidateId: string): Promise<string | null> {
  const candidate = await getCandidate(candidateId);
  if (!candidate || candidate.statement.startsWith(OPENING_NAMED)) return null;
  const mission = await latestMissionForCandidate(candidateId);
  const failed = mission
    ? mission.state === 'FAILED' || mission.state === 'CANCELLED'
    : candidate.state === 'PARKED';
  return failed ? candidateId : null;
}

export interface AutonomousStep {
  opportunityId: string;
  did: 'MARKED_READY' | 'BEGAN_EXECUTION';
  detail: string;
}

export interface WithheldStep {
  opportunityId: string;
  /** What stopped it, in the words a person could act on. */
  because: string;
}

export interface AuthorityAdvance {
  took: AutonomousStep[];
  withheld: WithheldStep[];
}

/**
 * The commercial decisions Brain takes on its own, inside the limits a person
 * set first.
 *
 * §30 used to reserve the offer, the price, the acceptance condition and who
 * fulfils the work to the owner permanently. `proposeTerms` corrected the first
 * half of that — Brain may now *form* a view. This is the second half: a view
 * nobody ever acts on is a form somebody fills in with extra steps, and an
 * operator with high autonomy is the agreed product.
 *
 * Two decisions, and both are bounded by something the person owns rather than
 * by this function's own judgement.
 *
 *   * **Declaring a piece ready to test.** The bound is the card: `markReady`
 *     refuses while a load-bearing field is unknown, and that gate is untouched
 *     — every field it checks got there as evidence somebody sourced, a
 *     recommendation carrying its basis and uncertainty, or a person's own
 *     answer. Brain pressing the button changes who presses it, never what the
 *     button checks.
 *   * **Beginning execution.** The bound is the standing commercial grant, and
 *     the check is the same `checkCommercialAuthority` an HTTP caller goes
 *     through — the action from a closed set, the grant read live, the ceilings
 *     spent by the same compare-and-swap. There is no path here that does not
 *     go through it, which is what stops this being a second set of rules.
 *
 * **It never manufactures a capability it does not have.** Contacting a buyer
 * needs `SEND_A_MESSAGE`, which reads MISSING on this Brain because no
 * integration of that kind exists; so what actually happens today is that the
 * pieces reach READY by themselves and stop there, with the need naming the
 * missing integration already on the record. That is the honest state, and it
 * is reported as withheld rather than as done — a run that said it had
 * contacted somebody would be the one lie this section could tell that costs
 * real money.
 */
/** How many buyers one pass may write to. See the loop below. */
export const MAX_CONTACTS_PER_PASS = 3;

export async function advanceWithinAuthority(projectId: string): Promise<AuthorityAdvance> {
  const out: AuthorityAdvance = { took: [], withheld: [] };
  const mode = await getCashMode(projectId);
  if (!mode) return out;
  let sentThisPass = 0;

  /*
   * Only while the sprint is running, and this is the one place in Cash Mode
   * where winding down stops something other than discovery.
   *
   * The rule is that the off switch ends new discovery and never a customer's
   * obligation, and every route here keeps working in all three states — a
   * person can still mark a piece ready and still execute one by hand while
   * winding down, because those are their decisions to take. What must not
   * happen is *Brain* starting a new obligation after somebody has said stop.
   * It is a skip rather than a refusal: no state moves, nothing is charged,
   * and it resumes by itself if the sprint is made active again.
   */
  if (mode.state !== 'ACTIVE') return out;

  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    // A second record of an opening is never readied or contacted on its own.
    if (opportunity.duplicateOfId) continue;
    // Asked before it is attempted: an incomplete card is the ordinary state of
    // a piece being worked on, and reporting every one of them as withheld
    // every tick would bury the ones that are actually stuck.
    if (!evidenceCard(opportunity).readiness.ready) continue;
    if (losesMoneyOnItsFigures(opportunity)) {
      out.withheld.push({ opportunityId: opportunity.id, because: LOSES_MONEY });
      continue;
    }
    const ready = await markReady({ opportunityId: opportunity.id, actorRef: BRAIN });
    if (ready.ok) {
      out.took.push({
        opportunityId: opportunity.id,
        did: 'MARKED_READY',
        detail: 'Every load-bearing field is answered, so this is ready to test.',
      });
    } else {
      out.withheld.push({ opportunityId: opportunity.id, because: ready.reason });
    }
  }

  for (const opportunity of await listOpportunities({ projectId, states: ['READY'] })) {
    if (opportunity.duplicateOfId) continue;
    // A piece whose own figures lose money is never contacted for, whoever marked it ready.
    if (losesMoneyOnItsFigures(opportunity)) {
      out.withheld.push({ opportunityId: opportunity.id, because: LOSES_MONEY });
      continue;
    }
    /*
     * Not after its published deadline. A piece marked ready before the date
     * passed would otherwise still get a buyer message after it — contacting
     * nobody creates no obligation, so stopping here stops no customer's work.
     */
    if (cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }).disqualifiedBy?.closed) {
      out.withheld.push({
        opportunityId: opportunity.id,
        because: `Its published closing date, ${opportunity.expiresAt}, has passed, so nobody is contacted.`,
      });
      continue;
    }
    // The person's decision first, because it is the authorization and the
    // other is an operational fact: deny-by-default asks whether this may
    // happen before it asks whether it could.
    const decision = await checkCommercialAuthority({ projectId, action: CONTACT_ACTION });
    if (!decision.ok) {
      out.withheld.push({
        opportunityId: opportunity.id,
        because:
          `Not authorized to ${CONTACT_ACTION}: ${decision.reason}. That is the one decision ` +
          'Brain cannot take for somebody, and nobody has been contacted.',
      });
      continue;
    }

    const reading = await readCapability(CONTACT_CAPABILITY);
    if (reading.state !== 'PRESENT') {
      out.withheld.push({
        opportunityId: opportunity.id,
        because:
          `Reaching the buyer needs ${reading.id}, which reads ${reading.state}. Brain has no ` +
          'integration of that kind, so nobody has been contacted and nothing here says one ' +
          'has. The need naming it is on the record.',
      });
      continue;
    }

    /*
     * And here is where Brain actually acts — through the machinery
     * invariants 25 and 26 require, never by writing the claim itself.
     *
     * `PRESENT` now means a real effect adapter is registered, so this is the
     * moment a messaging integration exists. What is recorded afterwards is
     * the provider's own answer: a receipt, or nothing. Unreachable on this
     * Brain today, because no adapter is registered — that is what the branch
     * above continues to report — but it is not dead code, and the
     * alternative to writing it here is a Brain that has the authorization
     * and still needs somebody to press a button the moment an integration
     * arrives.
     */
    /*
     * A buyer already reached is never reached again by the tick. This is
     * where a contact the provider confirmed lands when beginning execution
     * was refused at the moment it was recorded (`recordConfirmedEffect`):
     * the contact is history and the piece stayed READY. What is left is the
     * transition alone, retried from the action already on the record — never
     * a second send, which a fresh occurrence would otherwise be.
     */
    const contacted = await alreadyContacted(opportunity.id);
    if (contacted) {
      const began = await beginExecution({ opportunityId: opportunity.id, actorRef: BRAIN });
      if (began.ok) {
        out.took.push({
          opportunityId: opportunity.id,
          did: 'BEGAN_EXECUTION',
          detail: 'The buyer was already reached; execution began from that recorded contact.',
        });
      } else {
        out.withheld.push({
          opportunityId: opportunity.id,
          because: `The buyer was already reached, and beginning execution is refused: ${began.reason}`,
        });
      }
      continue;
    }

    /*
     * The message, composed from the card and nothing else. A card whose
     * published channel names no single address cannot be written to, and
     * that is a need with a remedy rather than a guess at an address.
     */
    const message = composeBuyerMessage(opportunity);
    if (!message.ok) {
      await raiseNeed({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: `Write to ${opportunity.payer ?? 'the payer'} about "${opportunity.title}"`,
        whyItMatters:
          `Brain may reach this buyer and has a messaging provider, but ${message.reason}. ` +
          'Brain does not invent an address or an offer to send.',
        recommendedPath:
          'Record the single email address the buyer published, or the offer and price, on the card.',
        setupEffort: 'A minute, if the address or offer is known.',
        nextStep: `Fill ${message.missing} on the card.`,
        completionCondition: 'The card names one published email address, an offer and a price.',
        blocksState: 'EXECUTING',
        requestKey: `contact-uncomposable:${opportunity.id}:${message.missing}`,
      });
      out.withheld.push({
        opportunityId: opportunity.id,
        because: `No message was sent: ${message.reason}. An open need names what is missing.`,
      });
      continue;
    }

    /*
     * A bound on how many buyers one pass may write to. Not a quota — the next
     * pass continues — but it is what stops a portfolio that reached READY all
     * at once becoming a burst of outbound mail nobody watched leave.
     */
    if (sentThisPass >= MAX_CONTACTS_PER_PASS) {
      out.withheld.push({
        opportunityId: opportunity.id,
        because: `${MAX_CONTACTS_PER_PASS} buyers were already written to this pass; this one waits for the next.`,
      });
      continue;
    }
    sentThisPass += 1;

    /*
     * The same gate a person's press reads: nothing under way, nothing that
     * happened and is not yet recorded, no unknown waiting on a person — and
     * the retry counted the same way, so a contact a person established did
     * not happen is retried under the key that person's own press would use,
     * never the spent first one.
     */
    const gate = await sendGate(opportunity, CONTACT_ACTION);
    if (!gate.ok) {
      out.withheld.push({ opportunityId: opportunity.id, because: gate.reason });
      continue;
    }
    const { occurrence, retry } = gate.value;
    // A new key exists only because an earlier attempt at this occurrence was
    // closed as not having happened — the provider refusing outright, or a
    // person establishing it. Trying again is that person's call; the tick
    // retrying a refusal would send into the same refusal on every pass.
    // And a same-key attempt the provider refused retryably is waiting on its
    // own backoff and a person, not on the tick sending into it again.
    const refusedHere = (await commercialOperationsFor(opportunity.projectId, opportunity.id)).some(
      (one) =>
        one.action === CONTACT_ACTION &&
        one.occurrence === occurrence &&
        one.retry === retry &&
        one.operation.state === 'RESERVED' &&
        one.operation.failureCategory !== null,
    );
    if (retry > 0 || refusedHere) {
      out.withheld.push({
        opportunityId: opportunity.id,
        because: refusedHere
          ? 'The provider refused reaching the buyer and said it may be retried. Brain tries again ' +
            'only when a person asks it to, from this piece.'
          : 'An earlier attempt to reach the buyer was closed as not having happened. Brain tries ' +
            'again only when a person asks it to, from this piece.',
      });
      continue;
    }

    /*
     * The same payload a person's "have Brain do it" sends (`perform.ts`
     * `prepare`): the exact offer text and its version, so the record of what
     * reached the buyer names the words that reached them. A card whose offer
     * cannot be drafted is not contacted at all.
     */
    const prepared = await prepare(CONTACT_ACTION, opportunity);
    if (!prepared.ok) {
      out.withheld.push({ opportunityId: opportunity.id, because: prepared.reason });
      continue;
    }
    let outcome: ExternalOutcome;
    try {
      outcome = await sendCommercialEffect({
        action: CONTACT_ACTION,
        occurrence,
        retry,
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        payload: prepared.value.payload,
        authorityId: decision.authority!.id,
        amountCents: null,
        stateAtSend: opportunity.state,
        subjectRef: prepared.value.subjectRef,
      });
    } catch (error) {
      out.withheld.push({
        opportunityId: opportunity.id,
        because:
          `Trying to reach ${opportunity.payer ?? 'the payer'} through ${CONTACT_CAPABILITY} ` +
          `failed: ${error instanceof Error ? error.message : String(error)}. Nothing here says ` +
          'anybody was contacted.',
      });
      continue;
    }

    /*
     * What the provider said becomes what the record says in one place
     * (`perform.ts`), shared with a person's own "have Brain do it" and with
     * a person settling an unknown — so the three cannot come to disagree.
     * UNCERTAIN raises a need naming the operation and records nothing;
     * FAILED keeps the provider's refusal on a need rather than only in this
     * report; a receipt is the only thing that begins execution.
     */
    const result = await applyEffectOutcome({
      opportunity,
      action: CONTACT_ACTION,
      occurrence,
      outcome,
      actorRef: BRAIN,
    });
    if (result.kind === 'RECORDED') {
      out.took.push({
        opportunityId: opportunity.id,
        did: 'BEGAN_EXECUTION',
        detail: result.message,
      });
    } else {
      out.withheld.push({
        opportunityId: opportunity.id,
        because:
          result.kind === 'PERFORMED_NOT_RECORDED'
            ? `The buyer was reached (reference ${result.receiptRef}) and recording it was refused: ${result.reason}`
            : result.reason,
      });
    }
  }

  return out;
}

/** One project's operating step, for the tick. */
export interface Proposed {
  opportunityId: string;
  fields: string[];
  withheld: string[];
}

/**
 * Brain's commercial view of every piece whose card it can form one about.
 *
 * The rule this replaces said the offer, the price, the acceptance condition
 * and who fulfils the work were permanently a person's — and it is right that a
 * researched answer to "what should we charge" is invented judgment wearing a
 * citation, and wrong that the conclusion is a prohibition. This is meant to be
 * an operator with high autonomy inside limits somebody set, and reserving
 * every commercial judgment to a human makes it a form to fill in.
 *
 * What keeps it honest is three things rather than a rule: every value lands as
 * a `RECOMMENDATION` and is rendered as one, a term with no stated uncertainty
 * cannot be written at all, and a field a person answered is never proposed
 * over. Nothing here touches what may be *spent* — that is the standing
 * commercial authority, and it is unchanged.
 */
export async function proposeCommercialTerms(projectId: string): Promise<Proposed[]> {
  const out: Proposed[] = [];
  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    const proposal = await proposeTerms(opportunity);
    if (proposal.terms.length === 0 && proposal.withheld.length === 0) continue;
    const fields = await applyProposal({ opportunity, proposal });
    if (fields.length === 0 && proposal.withheld.length === 0) continue;
    out.push({
      opportunityId: opportunity.id,
      fields,
      withheld: proposal.withheld.map((one) => one.field),
    });
  }
  return out;
}

/** One project's operating step, for the tick. */
export async function operate(
  projectId: string,
  now?: string,
): Promise<{
  /** Non-null exactly once per project, the pass that recorded the change. */
  reclassified: Reclassification | null;
  capabilities: CapabilityReconciliation;
  gaps: DiscoverableGap[];
  /** Field research withdrawn because no answer could make its opening executable now. */
  withdrawnResearch: string[];
  research: ResearchApplication;
  proposed: Proposed[];
  continuations: Continuation[];
  dependentWork: DependentWork[];
  validations: ValidationProgress;
  /** Confirmed effects whose record this pass finished. Empty when there were none. */
  effects: ReconciledEffect[];
  authority: AuthorityAdvance;
  monetization: MonetizationPass;
  /** Invoices issued, and the provider's payment and settlement answers read back (§54). */
  invoicing: InvoicingPass;
  /** The first-dollar journey advanced from rows; absent when Cash Mode is not active here. */
  journey?: JourneyTickReport;
  /** READY_TO_TEST openings handed to the Software Factory (`factoryHandoff.ts`). */
  factory?: FactoryHandoffPass;
  /** Qualified openings made execution jobs, and live jobs kept in step (`jobPipeline.ts`). */
  jobs?: JobReconciliation | { error: string };
  /** What changed and who it reconsidered (`reconsider.ts`); absent when Cash Mode is not active. */
  reconsideration?:
    | Omit<ReconsiderPass, 'readings'>
    | { error: string }
    | null;
  /** Reopen watches recorded on derived dead ends, and standing changes written. */
  standing?: { derived: DerivedCondition[]; changes: StandingChange[] } | { error: string } | { skipped: string };
}> {
  if (!(await getCashMode(projectId))) {
    return {
      reclassified: null,
      capabilities: { raised: [], settled: [] },
      gaps: [],
      withdrawnResearch: [],
      research: { applied: [], unanswered: [] },
      proposed: [],
      continuations: [],
      dependentWork: [],
      validations: { started: [], settled: [] },
      effects: [],
      authority: { took: [], withheld: [] },
      invoicing: { issued: [], uncertain: [], failed: [], withheld: [], paid: [], settled: [], voided: [] },
      monetization: {
        pathsAdded: [],
        figuresCarried: [],
        evidenced: [],
        moved: 0,
        evaluated: 0,
        commissions: { opened: [], recorded: [], settled: [], declined: [], openNow: 0 },
      },
    };
  }
  /*
   * The order is the order the effects depend on each other in: name what is
   * missing, take back what the research established, form a view on top of
   * it, answer what has become available, then start what research can settle.
   * Each pass is idempotent on its own, so a crash between two of them resumes
   * rather than repeating.
   */
  /*
   * First, and once ever: say on the record that the work model changed.
   *
   * Ahead of everything because it is a *reading* of the portfolio as it stands
   * before this pass touches anything, and because a person who had been
   * reading `1 to act on now, 40 waiting` deserves to find out from the history
   * rather than by noticing. It archives nothing and moves nothing — see
   * `reclassify.ts`.
   */
  const reclassified = await recordWorkModelReclassification(projectId);
  /*
   * Then what changed in the world since the last pass, and everyone waiting
   * on it (`reconsider.ts`). Before the capability path, because it reads the
   * capability vocabulary once and hands the readings on — the capability path
   * then reads nothing itself. A failure here is its own failure domain: the
   * capability path reads the vocabulary for itself and the rest still runs.
   */
  let reconsidered: ReconsiderPass | { error: string } | null = null;
  try {
    reconsidered = await reconsiderAffected(projectId, { now });
  } catch (error) {
    reconsidered = { error: error instanceof Error ? error.message.slice(0, 300) : 'failed' };
  }
  const capabilities = await reconcileCapabilityNeeds(
    projectId,
    reconsidered && 'readings' in reconsidered ? { readings: reconsidered.readings } : {},
  );
  const research = await applyResearchAnswers(projectId);
  const proposed = await proposeCommercialTerms(projectId);
  const withdrawnResearch = await withdrawResearchNotWorthIt(projectId);
  const gaps = [...(await reconcileDiscoverableGaps(projectId)), ...(await reconcileEngineGaps(projectId))];
  const continuations = await runNeedContinuations(projectId, now);
  const dependentWork = await startDependentWork(projectId);
  /*
   * And the bounded deep dive on each opening, which is where the commercial
   * questions actually get answered.
   *
   * After the needs path rather than instead of it: a need is raised for one
   * blank on one card and is answered by one narrow question, while a
   * validation qualifies a whole opening. They overlap in what they can fill,
   * and `mayReplace` decides which answer stands — by authority rather than by
   * whichever arrived last.
   */
  const validations = await runValidations(projectId);
  /*
   * Last, and that order is the point: a piece only becomes ready because the
   * research landed on its card and the proposal filled what the research could
   * not, both of which happened above. Asking first would ask about last tick's
   * card and defer every decision by one pass.
   */
  /*
   * Before Brain acts, it finishes writing down what it already did.
   *
   * A provider that confirmed an effect whose record never landed — a crash,
   * a write that failed, a grant revoked between the receipt and the record —
   * leaves a SUCCEEDED operation and no action. Recording it first is what
   * stops the pass below mistaking an unrecorded contact for an uncontacted
   * buyer. It sends nothing, and it runs in every sprint state, because
   * writing down history is not new discovery.
   */
  const recovered = await recoverAbandonedEffects(projectId);
  const effects = [...recovered, ...(await reconcileConfirmedEffects(projectId))];
  /*
   * Then the journey after the first action, from rows: ledger entries for
   * agreements, Brain's own fulfilment work read back, acceptance applied,
   * silence recorded, the state moved, and what finished deals taught. It
   * sends nothing.
   */
  const authority = await advanceWithinAuthority(projectId);
  /*
   * And a READY_TO_TEST opening whose test is software goes to the Factory,
   * under the standing grant's BUILD_A_TEST. After the readiness pass above,
   * because that is what moves a piece to READY in this same pass.
   */
  // Its own failure domain: a Factory that cannot be reached must not stop
  // invoicing, the journey or the ledger below; the next pass asks again.
  const factory = await handOffReadyTests(projectId).catch(
    (error: unknown): FactoryHandoffPass => ({
      handedOff: [],
      waiting: [{ opportunityId: '', reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' }],
    }),
  );
  /*
   * Invoices a person asked for, issued under QUOTE_AND_INVOICE while an
   * invoicing provider is usable, and the provider's answers about payment and
   * settlement read back into the ledger as two separate entries (§54). After
   * the contact pass because nothing here depends on it, and before the
   * journey because the journey reads money this may have just recorded.
   */
  const invoicing = await runInvoicing(projectId, now ? new Date(now) : new Date());
  const journey = await advanceJourney(projectId, now ? new Date(now) : new Date());
  /*
   * Then the jobs: every opening the passes above qualified, readied or took
   * into execution gets its one canonical execution job, and each live job
   * follows its opportunity's state. After the journey because the journey is
   * what moves an opportunity to DELIVERING or COLLECTED. Its own failure
   * domain: a job pass that cannot read must not stop the ledger below.
   */
  let jobs: JobReconciliation | { error: string };
  try {
    jobs = await reconcileCashJobs(projectId);
  } catch (error) {
    jobs = { error: error instanceof Error ? error.message.slice(0, 300) : 'failed' };
  }
  /*
   * And the possibility ledger, last, reading everything the passes above
   * wrote.
   *
   * Two halves with different jobs. The enumeration gives every live discovery
   * its complete space of monetization methods, idempotently, so a discovery
   * that arrived since the last pass stops being one answer to a question that
   * has dozens. The movement pass re-reads the derived ranking and records only
   * what actually moved, which is the one thing about a rank no derivation can
   * recover later.
   *
   * It is last for `advanceWithinAuthority`'s own reason: everything above it
   * changes what the ledger says, and asking first would rank last tick's
   * evidence. And it gates nothing — no pass here refuses a piece, charges an
   * attempt, starts work or spends anything.
   */
  const monetization = await runMonetizationLedger(projectId, now);
  /*
   * Last of all, the standing of every piece as the passes above left it: each
   * derived dead end is given the watch that could reopen it, and a standing
   * event is written for each piece whose standing changed — and only those.
   * Composed once and read by both. Its own failure domain, for the same reason
   * as the reconsideration pass.
   */
  let standing:
    | { derived: DerivedCondition[]; changes: StandingChange[] }
    | { error: string }
    | { skipped: string };
  try {
    if (!standingDue(projectId, now ? Date.parse(now) : Date.now(), triggeredThisTick(reconsidered))) {
      standing = { skipped: 'standing was composed recently; nothing triggered since' };
    } else {
    const standings = await projectStandings(projectId);
    const derived = await recordDerivedReopenConditions(projectId, standings);
    standing = { derived, changes: await recordStandingChanges(projectId, standings) };
    }
  } catch (error) {
    standing = { error: error instanceof Error ? error.message.slice(0, 300) : 'failed' };
  }
  return {
    reconsideration: reconsidered && 'readings' in reconsidered
      ? {
          changes: reconsidered.changes,
          triggered: reconsidered.triggered,
          watermarksMoved: reconsidered.watermarksMoved,
        }
      : reconsidered,
    standing,
    reclassified,
    capabilities,
    gaps,
    withdrawnResearch,
    research,
    proposed,
    continuations,
    dependentWork,
    validations,
    effects,
    authority,
    invoicing,
    monetization,
    journey,
    factory,
    jobs,
  };
}

export interface MonetizationPass {
  /** Possibilities added this pass. Empty on a pass over an unchanged project. */
  pathsAdded: string[];
  /** Paths that inherited a figure from the discovery their method stood for. */
  figuresCarried: string[];
  /** Possibilities a source named that the method table would not have produced. */
  evidenced: string[];
  /** Positions that changed. A ledger nothing moved in records nothing. */
  moved: number;
  evaluated: number;
  /** The questions Brain asked about a possibility this pass, and what came back. */
  commissions: CommissionPass;
}

async function runMonetizationLedger(
  projectId: string,
  now?: string,
): Promise<MonetizationPass> {
  const enumerated = await enumeratePossibilities(projectId);

  /*
   * Ask and settle *before* the positions are recorded, so a movement this
   * pass's own answer caused is the movement that gets written down.
   *
   * `recordMovements` appends a snapshot only where the derived position
   * differs from the last recorded one, and it is what makes "why did this
   * move" answerable at all. Running it first would record the ledger as it
   * was before the answer landed, and the movement the answer caused would be
   * attributed to whatever happened next — §33's *the evidence was right and
   * the sentence about it was wrong*, at a rank history.
   *
   * `runCommissions` composes nothing of its own: it takes the ledger read
   * here, so the snapshot the allocator decided against and the snapshot a
   * reader sees are one object rather than two that could disagree.
   */
  const at = now ?? new Date().toISOString();
  const ledger = await composeLedger({ projectId, now: at });
  const commissions = await runCommissions({ projectId, ledger, now: at });
  /*
   * Recompose only when the commissions wrote something the ledger reads.
   * Their only such write is a filed answer (a path fact); opening, settling
   * and abandoning touch `monetization_commissions`, which `composeLedger`
   * does not read. Composing an identical ledger twice a tick was measured
   * load and changed no movement.
   */
  const movements = await recordMovements({
    projectId,
    now: at,
    ledger: commissions.recorded.length === 0 ? ledger : undefined,
  });
  return {
    pathsAdded: enumerated.added.flatMap((one) => one.pathIds),
    figuresCarried: enumerated.carried.map((one) => one.pathId),
    evidenced: enumerated.evidenced,
    moved: movements.movements.length,
    evaluated: movements.evaluated,
    commissions,
  };
}

export type { CashOpportunity };

/**
 * The standing pass reads every opportunity in the project (one dive check per
 * piece), so on the 30-second Russell tick it is the one remaining full read of
 * the portfolio. Standing is history, not a control: nothing waits on it, and
 * a standing event written five minutes late describes the same change. So it
 * runs at most every `BRAIN_STANDING_INTERVAL_MS` per project (default five
 * minutes, §61), and at once on any tick whose reconsideration pass triggered
 * something, because that is exactly when standing moved.
 */
const standingRanAt = new Map<string, number>();

function standingDue(projectId: string, nowMs: number, triggered: boolean): boolean {
  const interval = Number(process.env['BRAIN_STANDING_INTERVAL_MS'] ?? 5 * 60_000);
  const last = standingRanAt.get(projectId);
  const due = triggered || !Number.isFinite(interval) || interval <= 0 || last === undefined ||
    nowMs - last >= interval || nowMs < last;
  if (due) standingRanAt.set(projectId, nowMs);
  return due;
}

function triggeredThisTick(reconsidered: unknown): boolean {
  if (!reconsidered || typeof reconsidered !== 'object' || !('triggered' in reconsidered)) return false;
  const triggered = (reconsidered as { triggered: unknown }).triggered;
  return Array.isArray(triggered) ? triggered.length > 0 : Boolean(triggered);
}

