/**
 * The candidate paths an objective could take, each put to the same tests.
 *
 * Every path is a row some other part of Brain already wrote — an opening in
 * the Cash portfolio, a deal the dealflow kernel paired, an idea captured in a
 * conversation, a software change somebody asked for. Nothing here invents a
 * path, and nothing here stores one: the list and every test on it are read
 * from rows on each call.
 *
 * Each adapter answers the eight criteria in `domain/decision.ts` from the
 * machinery that already owns the answer, rather than re-deriving it:
 *
 *  - an opening's facts come from its engine card (`cashEngineCard`), which
 *    already says per field whether the answer is a gated claim, Brain's own
 *    proposal with its basis, a person's decision, or unknown;
 *  - how it would be paid comes from the monetization ledger's best-ranked
 *    possibility for it, and a possibility a person invalidated is a rejection
 *    with that person's words on it;
 *  - capital is compared with `cashPosition().deployableCents`, which is
 *    measured from the append-only money ledger;
 *  - production ability is `readCapability`, never a declaration;
 *  - authority is `checkCommercialAuthority` and `checkAuthority`, exactly as
 *    the routes that would act ask them.
 *
 * What a path's research step would be is decided by the machinery that runs
 * it: `whyNotDiving` says whether the bounded deep dive can take an opening,
 * and a dive that is spent or has nothing to ask about has **no** research
 * step, because a second search of sources that do not publish the answer is
 * not research (§15).
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { listCandidates } from '../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { listSoftwareRequests } from '../../repos/russellSoftware.ts';
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { cashEngineCard, derivedEconomics, type EngineCard } from '../cash/engineCard.ts';
import { evidenceCard } from '../cash/card.ts';
import { cashTier } from '../cash/tier.ts';
import { rank as rankPortfolio } from '../cash/portfolio.ts';
import { readCapabilities, readCapability } from '../cash/capabilities.ts';
import { checkCommercialAuthority } from '../cash/authority.ts';
import { whyNotDiving } from '../cash/validation.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { discoveryAuthority } from '../cash/discoveryAuthority.ts';
import { composeLedger, type LedgerEntry } from '../cash/monetization/ledger.ts';
import { dealflowView } from '../dealflow/view.ts';
import type {
  CandidatePath,
  CriterionAssessment,
  DecisionCriterion,
  EvidenceKind,
  PlannedStep,
} from '../../domain/decision.ts';
import type { CashOpportunity } from '../../domain/types.ts';
import type { ObjectiveContext } from './context.ts';

type Entry = EngineCard['entries'][number];

function kindOf(entry: Entry | undefined): EvidenceKind {
  if (!entry || entry.value === null) return 'UNKNOWN';
  if (entry.kind === 'FACT') return 'FACT';
  if (entry.kind === 'ESTIMATE') return 'ESTIMATE';
  if (entry.kind === 'DECISION') return 'DECISION';
  return 'UNKNOWN';
}

/** The weaker of two kinds: a conclusion is only as strong as its weakest input. */
function weakest(kinds: EvidenceKind[]): EvidenceKind {
  const order: EvidenceKind[] = ['UNKNOWN', 'ESTIMATE', 'DECISION', 'FACT', 'MEASURED'];
  return kinds.reduce<EvidenceKind>(
    (worst, kind) => (order.indexOf(kind) < order.indexOf(worst) ? kind : worst),
    'MEASURED',
  );
}

function clip(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function assess(
  criterion: DecisionCriterion,
  reading: CriterionAssessment['reading'],
  kind: EvidenceKind,
  statement: string,
  evidenceRef: string | null = null,
  task: string | null = null,
): CriterionAssessment {
  return { criterion, reading, kind, statement, evidenceRef, task };
}

/**
 * A criterion that needs several card answers: MET only when all of them are
 * answered, and otherwise UNKNOWN naming the first one that is not.
 */
function needsAll(
  criterion: DecisionCriterion,
  entries: (Entry | undefined)[],
  metStatement: (values: string[]) => string,
): CriterionAssessment {
  const missing = entries.find((one) => !one || one.value === null);
  if (missing) {
    return assess(
      criterion,
      'UNKNOWN',
      'UNKNOWN',
      `${missing.label} is not established.`,
      null,
      missing.task,
    );
  }
  const present = entries as Entry[];
  return assess(
    criterion,
    'MET',
    weakest(present.map(kindOf)),
    metStatement(present.map((one) => clip(one.value ?? '', 120))),
    present.find((one) => one.claimId)?.claimId ?? null,
  );
}

// ---------------------------------------------------------------------------
// Cash openings
// ---------------------------------------------------------------------------

/**
 * Which test each of Cash's own qualification questions belongs to.
 *
 * An opening qualifies here only when Cash's own standard says so — its tier
 * has reached QUALIFIED and its card is ready to test, which is exactly what
 * `markReady` requires. Every question that standard still has open is mapped
 * onto the test it bears on, so the brief and the Cash page can never disagree
 * about whether something is an opportunity. A `Record` over the keys either
 * reader can raise, so a key added later lands on REACH until somebody says
 * otherwise rather than silently counting as answered.
 */
const CRITERION_OF: Readonly<Record<string, DecisionCriterion>> = Object.freeze({
  buyingEvidence: 'DEMAND',
  captureMechanism: 'REACH',
  payer: 'REACH',
  access: 'REACH',
  phoneDependency: 'REACH',
  eligibility: 'REACH',
  fulfillment: 'PRODUCTION',
  fulfilmentModel: 'PRODUCTION',
  laborNeeds: 'PRODUCTION',
  acquisitionAccess: 'PRODUCTION',
  offer: 'DELIVERY',
  acceptance: 'DELIVERY',
  delivery: 'DELIVERY',
  price: 'COST',
  revenueRange: 'COST',
  directCosts: 'COST',
  requiredCapital: 'COST',
  exposure: 'COST',
  exitEvidence: 'COST',
  disqualifiers: 'COST',
  timeToFirstCash: 'TIME',
  cashDates: 'TIME',
  confidence: 'COST',
  recommendation: 'COST',
});

async function cashPaths(context: ObjectiveContext, now: string): Promise<CandidatePath[]> {
  const mode = await getCashMode(context.projectId);
  if (!mode) return [];
  const opportunities = (await listOpportunities({ projectId: context.projectId })).filter(
    (one) => one.state !== 'DECLINED' && one.state !== 'ARCHIVED' && one.duplicateOfId === null,
  );
  if (opportunities.length === 0) return [];

  const facts = new Map<string, Awaited<ReturnType<typeof cardFactsForProject>>>();
  for (const fact of await cardFactsForProject(context.projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }
  const ledger = await composeLedger({ projectId: context.projectId, now });
  const bySubject = new Map<string, LedgerEntry[]>();
  for (const entry of ledger.entries) {
    if (entry.subject?.kind !== 'OPPORTUNITY') continue;
    bySubject.set(entry.subject.id, [...(bySubject.get(entry.subject.id) ?? []), entry]);
  }

  const contact = await checkCommercialAuthority({ projectId: context.projectId, action: 'CONTACT_BUYER' });
  const messaging = await readCapability('SEND_A_MESSAGE');
  const researchOpen =
    (await discoveryAllowed(context.projectId)).allowed &&
    (await discoveryAuthority(context.projectId)) !== null;
  const executing = opportunities.filter(
    (one) => one.state === 'EXECUTING' || one.state === 'DELIVERING',
  ).length;

  /*
   * Cash's own portfolio order, read once: it breaks ties the eight tests
   * cannot, so two openings nothing here separates are ordered by the ranking
   * the plan already argued for (buying evidence and reach, time to cash,
   * contribution, capital, expiry) rather than by an identifier.
   */
  const tiers: Record<string, ReturnType<typeof cashTier>> = {};
  for (const opportunity of opportunities) {
    tiers[opportunity.id] = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] }),
      readiness: evidenceCard(opportunity).readiness,
    });
  }
  const ownerOrder = new Map(rankPortfolio(opportunities, tiers).map((one, index) => [one.id, index]));

  const out: CandidatePath[] = [];
  for (const opportunity of opportunities) {
    const card = cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] });
    const readiness = evidenceCard(opportunity).readiness;
    const tier = tiers[opportunity.id]!;
    const entry = (key: string): Entry | undefined => card.entries.find((one) => one.key === key);
    /** The first of several equivalent questions that has an answer, else the first. */
    const either = (...keys: string[]): Entry | undefined =>
      keys.map(entry).find((one) => one && one.value !== null) ?? entry(keys[0]!);
    const paths = (bySubject.get(opportunity.id) ?? []).slice().sort((a, b) => a.rank - b.rank);
    const best = paths.find((one) => one.status !== 'ARCHIVED' && one.status !== 'INVALIDATED') ?? null;

    const assessments: CriterionAssessment[] = [];

    // DEMAND — the published signal, dated, or it is not evidence (§30).
    const buying = entry('buyingEvidence');
    const judgedAway = paths.length > 0 && paths.every((one) => one.status === 'INVALIDATED');
    if (judgedAway) {
      const last = paths[0]!.judgments[paths[0]!.judgments.length - 1];
      assessments.push(
        assess(
          'DEMAND',
          'NOT_MET',
          'DECISION',
          `Every way of being paid for this was judged not to work${last ? `: ${clip(last.reason)}` : '.'}`,
          paths[0]!.path.id,
        ),
      );
    } else if (!buying || buying.value === null) {
      assessments.push(
        assess('DEMAND', 'UNKNOWN', 'UNKNOWN', 'No published buying signal is recorded.', null, buying?.task ?? null),
      );
    } else if (!opportunity.signalObservedAt) {
      assessments.push(
        assess(
          'DEMAND',
          'UNKNOWN',
          kindOf(buying),
          'A signal is recorded with no observation date, and an undated signal cannot be told apart from one remembered from months ago.',
          opportunity.sourceClaimId,
          'Establish when the signal was published or observed.',
        ),
      );
    } else {
      assessments.push(
        assess(
          'DEMAND',
          'MET',
          kindOf(buying),
          `Published and dated ${opportunity.signalObservedAt}: ${clip(buying.value)}`,
          buying.claimId ?? opportunity.sourceClaimId,
        ),
      );
    }

    // REACH — who pays *us*, and how a supplier gets to them. A market price is
    // not a payer; the capture thesis is what separates evidence from work.
    assessments.push(
      needsAll(
        'REACH',
        [entry('captureMechanism'), entry('payer'), entry('access')],
        ([capture, payer, access]) => `${payer} pays; reached through ${access}. ${capture}`,
      ),
    );

    // PRODUCTION — what it takes to do the work, read rather than declared.
    const required = await readCapabilities(opportunity.requiredCapabilities);
    const missingCapability = required.find((one) => one.state === 'MISSING');
    const unknownCapability = required.find((one) => one.state === 'UNKNOWN');
    const fulfilment = either('fulfillment', 'fulfilmentModel');
    if (!fulfilment || fulfilment.value === null) {
      assessments.push(
        assess(
          'PRODUCTION',
          'UNKNOWN',
          'UNKNOWN',
          'Who or what would produce the work is not established.',
          null,
          fulfilment?.task ?? 'Establish who fulfils the work and how.',
        ),
      );
    } else if (unknownCapability) {
      assessments.push(
        assess(
          'PRODUCTION',
          'UNKNOWN',
          'UNKNOWN',
          `It needs "${unknownCapability.id}", which this Brain has no definition of, so whether it can be done here is unknown.`,
          null,
          `Say what "${unknownCapability.id}" means, or remove it from the opening.`,
        ),
      );
    } else if (missingCapability) {
      assessments.push(
        assess(
          'PRODUCTION',
          'NEEDS_PERSON',
          'MEASURED',
          `It needs the ability to ${
            missingCapability.definition?.does ?? missingCapability.id
          }, which this Brain does not have. ${missingCapability.definition?.nextStep ?? ''}`.trim(),
          missingCapability.id,
        ),
      );
    } else {
      assessments.push(
        assess('PRODUCTION', 'MET', kindOf(fulfilment), `Fulfilled by ${clip(fulfilment.value)}`, fulfilment.claimId),
      );
    }

    // DELIVERY
    assessments.push(
      needsAll('DELIVERY', [entry('delivery')], ([delivery]) => `Delivered by ${delivery}.`),
    );

    // COST — the capital it needs up front against what may be committed now.
    const deployable = context.deployableCents;
    const exposure = either('exposure', 'requiredCapital');
    if (opportunity.peakFundingCents !== null && deployable !== null) {
      const figureKind = weakest([kindOf(exposure), 'MEASURED']);
      if (opportunity.peakFundingCents > deployable) {
        assessments.push(
          assess(
            'COST',
            'NOT_MET',
            exposure && exposure.value !== null ? figureKind : 'DECISION',
            `It needs ${money(opportunity.peakFundingCents, opportunity.currency)} committed before any money arrives, and ${money(
              Math.max(0, deployable),
              opportunity.currency,
            )} may be committed now (measured from the money ledger).`,
            exposure?.claimId ?? opportunity.id,
          ),
        );
      } else {
        assessments.push(
          assess(
            'COST',
            'MET',
            figureKind,
            `It needs ${money(opportunity.peakFundingCents, opportunity.currency)} up front, inside the ${money(
              deployable,
              opportunity.currency,
            )} that may be committed now.`,
            exposure?.claimId ?? null,
          ),
        );
      }
    } else if (best && best.status === 'WEAK') {
      assessments.push(
        assess('COST', 'NOT_MET', 'ESTIMATE', clip(best.statusBecause), best.path.id),
      );
    } else {
      assessments.push(
        needsAll(
          'COST',
          [entry('directCosts'), entry('revenueRange')],
          ([costs, revenue]) => `Costs: ${costs}. Revenue: ${revenue}.`,
        ),
      );
    }

    // TIME — whether the window is open, then how long to cash.
    const closesAt = opportunity.expiresAt ?? opportunity.deadline;
    const closed = closesAt !== null && Number.isFinite(Date.parse(closesAt)) && Date.parse(closesAt) < Date.parse(now);
    if (closed) {
      assessments.push(
        assess(
          'TIME',
          'NOT_MET',
          'MEASURED',
          `The opening closed on ${closesAt}${opportunity.expiryReason ? ` (${clip(opportunity.expiryReason, 100)})` : ''}.`,
          opportunity.id,
        ),
      );
    } else {
      assessments.push(
        needsAll(
          'TIME',
          [either('cashDates', 'timeToFirstCash')],
          ([when]) => `Cash expected: ${when}`,
        ),
      );
    }

    // CAPACITY — the concurrency a person authorized, against what is running.
    if (!contact.authority) {
      assessments.push(
        assess(
          'CAPACITY',
          'NEEDS_PERSON',
          'MEASURED',
          'No commercial grant exists, so no execution slot is authorized.',
          null,
        ),
      );
    } else if (executing >= contact.authority.maxConcurrent && opportunity.state !== 'EXECUTING') {
      assessments.push(
        assess(
          'CAPACITY',
          'NEEDS_PERSON',
          'MEASURED',
          `All ${contact.authority.maxConcurrent} authorized execution slots are in use.`,
          contact.authority.id,
        ),
      );
    } else {
      assessments.push(
        assess(
          'CAPACITY',
          'MET',
          'MEASURED',
          `${executing} of ${contact.authority.maxConcurrent} authorized execution slots are in use.`,
          contact.authority.id,
        ),
      );
    }

    // AUTHORITY — to take the first external step: reaching the buyer.
    assessments.push(
      contact.ok
        ? assess('AUTHORITY', 'MET', 'DECISION', 'A commercial grant permits contacting a buyer.', contact.authority?.id ?? null)
        : assess('AUTHORITY', 'NEEDS_PERSON', 'MEASURED', contact.reason, null),
    );

    /*
     * Cash's own standard, applied on top. A test read as MET above is put back
     * to UNKNOWN while the qualification standard or the card still has a
     * question open under it — named, with the task that answers it.
     */
    const open = [
      ...tier.toAdvance.map((one) => ({ key: one.key, label: one.label, task: one.task })),
      ...readiness.missing.map((key) => {
        const one = entry(key);
        return { key, label: one?.label ?? key, task: one?.task ?? null };
      }),
    ];
    for (const question of open) {
      const criterion = CRITERION_OF[question.key] ?? 'REACH';
      const index = assessments.findIndex((one) => one.criterion === criterion);
      const current = assessments[index];
      if (!current || current.reading !== 'MET') continue;
      assessments[index] = assess(
        criterion,
        'UNKNOWN',
        'UNKNOWN',
        `${question.label} is not established yet, and Cash's own standard needs it before this is an opportunity rather than evidence.`,
        null,
        question.task,
      );
    }

    // The execution step, once it qualifies.
    const payer = entry('payer')?.value ?? null;
    const access = entry('access')?.value ?? null;
    const offer = entry('offer')?.value ?? null;
    const price = entry('price')?.value ?? null;
    let executionStep: PlannedStep | null;
    if (opportunity.state === 'EXECUTING' || opportunity.state === 'DELIVERING') {
      executionStep = {
        kind: 'AWAIT_EXISTING',
        description: `Execution is already under way on "${opportunity.title}"; the step is to see it through.`,
        serves: null,
        authority: 'AUTHORIZED',
        boundary: null,
        prepared: null,
        existingWork: { kind: 'OPPORTUNITY', id: opportunity.id },
      };
    } else {
      const needs: string[] = [];
      if (!contact.ok) {
        needs.push(
          `Contacting a buyer needs a commercial grant that permits CONTACT_BUYER, and only a person can give one (Cash \u2192 What Brain may spend). Right now: ${contact.reason.replace(/\.$/, '')}.`,
        );
      }
      if (messaging.state !== 'PRESENT') {
        needs.push(
          'This Brain cannot send a message itself, so the prepared message is for a person to send, or for an integration to be connected first.',
        );
      }
      executionStep = {
        kind: 'COMMERCIAL_ACTION',
        description:
          `Contact ${payer ? clip(payer, 80) : 'the payer'}${access ? ` through ${clip(access, 80)}` : ''}` +
          `${offer ? ` offering ${clip(offer, 100)}` : ''}${price ? ` at ${clip(price, 40)}` : ''}.`,
        serves: 'AUTHORITY',
        authority: needs.length === 0 ? 'AUTHORIZED' : 'NEEDS_PERSON',
        boundary: needs.length === 0 ? null : needs.join(' '),
        prepared: {
          action: 'CONTACT_BUYER',
          opportunityId: opportunity.id,
          payer,
          channel: access,
          offer,
          price,
          acceptance: entry('acceptance')?.value ?? null,
          stopRule: opportunity.stopRule,
        },
        existingWork: null,
      };
    }

    // The research step, decided by the machinery that runs it.
    let researchStep: PlannedStep | null = null;
    const dive = await whyNotDiving(opportunity);
    if (dive.kind === 'ELIGIBLE') {
      researchStep = {
        kind: 'QUALIFY_OPENING',
        description: `Qualify "${clip(opportunity.title, 100)}" from published sources — who pays, what it pays, what it costs, how long it takes and what would rule it out — ahead of any other opening.`,
        serves: null,
        authority: researchOpen ? 'AUTHORIZED' : 'NEEDS_PERSON',
        boundary: researchOpen
          ? null
          : 'Research is not authorized on this sprint right now: it is wound down or has no research grant.',
        prepared: null,
        existingWork: null,
      };
    } else if (dive.kind === 'IN_FLIGHT' && opportunity.candidateId) {
      researchStep = {
        kind: 'AWAIT_EXISTING',
        description: `A deep dive on "${clip(opportunity.title, 100)}" is already running; the step is to read what it establishes.`,
        serves: null,
        authority: 'AUTHORIZED',
        boundary: null,
        prepared: null,
        existingWork: { kind: 'CANDIDATE', id: opportunity.candidateId },
      };
    } else if (dive.kind === 'AWAITING_PERSON' && opportunity.candidateId) {
      researchStep = {
        kind: 'AWAIT_EXISTING',
        description: `The deep dive on "${clip(opportunity.title, 100)}" stopped at a decision only a person can make.`,
        serves: null,
        authority: 'NEEDS_PERSON',
        boundary: 'Its research mission is waiting in Needs You; answering it resumes the same mission.',
        prepared: null,
        existingWork: { kind: 'CANDIDATE', id: opportunity.candidateId },
      };
    }

    const economicsEntries = ['revenueRange', 'directCosts', 'requiredCapital', 'timeToFirstCash', 'hours']
      .map((key) => entry(key))
      .filter((one): one is Entry => one !== undefined)
      .map((one) => ({
        label: one.label,
        value: one.value,
        kind: kindOf(one),
        basis: one.basis ?? (one.claimId ? `claim ${one.claimId}` : null),
      }));
    for (const figure of derivedEconomics(card)) {
      economicsEntries.push({
        label: figure.label,
        value: figure.value,
        kind: figure.value === null ? 'UNKNOWN' : 'ESTIMATE',
        basis: figure.withheld ?? figure.formula,
      });
    }

    out.push({
      ref: `CASH_OPPORTUNITY:${opportunity.id}`,
      source: 'CASH_OPPORTUNITY',
      title: clip(opportunity.title, 140),
      sourceRef: opportunity.sourceClaimId ?? opportunity.id,
      how: best ? `${best.method.label} — ${tier.tier.replace(/_/g, ' ').toLowerCase()}` : tier.summary,
      assessments,
      executionStep,
      researchStep,
      economics: economicsEntries,
      ownerRank: ownerOrder.get(opportunity.id) ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deals — read, never re-researched here. The dealflow kernel owns its questions.
// ---------------------------------------------------------------------------

async function dealPaths(context: ObjectiveContext): Promise<CandidatePath[]> {
  let view: Awaited<ReturnType<typeof dealflowView>>;
  try {
    view = await dealflowView(context.projectId);
  } catch {
    return [];
  }
  return view.deals
    .filter((deal) => deal.opportunityId === null)
    .map((deal) => {
      const assessments: CriterionAssessment[] = [];
      const outstanding = (text: string) => deal.outstanding.some((one) => one.toLowerCase().includes(text));
      assessments.push(
        assess('DEMAND', 'MET', 'FACT', `${deal.buyer} is a buyer of ${deal.equipmentClass} on a gated claim.`, deal.id),
      );
      assessments.push(
        outstanding('who decides')
          ? assess('REACH', 'UNKNOWN', 'UNKNOWN', 'Who decides the purchase is not established.', deal.id, 'Establish the decision-maker and how a supplier reaches them.')
          : assess('REACH', 'MET', 'FACT', `The decision-maker at ${deal.buyer} is established.`, deal.id),
      );
      assessments.push(
        assess('PRODUCTION', 'MET', 'FACT', `${deal.supplier} publishes the capability to supply it.`, deal.id),
      );
      assessments.push(
        outstanding('compliance')
          ? assess('DELIVERY', 'UNKNOWN', 'UNKNOWN', `The compliance envelope for ${deal.destination ?? 'the destination'} is not established.`, deal.id, 'Research the five compliance layers.')
          : assess('DELIVERY', 'MET', 'FACT', 'The compliance envelope is established.', deal.id),
      );
      assessments.push(
        deal.transactionValueCents === null
          ? assess('COST', 'UNKNOWN', 'UNKNOWN', 'The landed cost is withheld until every load-bearing line is published.', deal.id, 'Establish the landed cost.')
          : assess('COST', 'MET', 'FACT', `Landed cost ${money(deal.transactionValueCents, deal.currency ?? 'USD')}.`, deal.id),
      );
      assessments.push(
        deal.paidWhen
          ? assess('TIME', 'MET', 'FACT', deal.paidWhen, deal.id)
          : assess('TIME', 'UNKNOWN', 'UNKNOWN', 'No commercial structure is attested, so when money would arrive is unknown.', deal.id, 'Establish a structure this trade actually uses.'),
      );
      assessments.push(assess('CAPACITY', 'NOT_APPLICABLE', 'MEASURED', 'Capacity is asked once the deal is promoted into Cash.', null));
      assessments.push(assess('AUTHORITY', 'NOT_APPLICABLE', 'MEASURED', 'Pursuit is Cash Mode’s, under its grant, once the deal is promoted.', null));
      const live =
        view.live.find((one) => one.subject.toLowerCase().includes(deal.equipmentClass.toLowerCase())) ??
        null;
      const researchStep: PlannedStep | null = live
        ? {
            kind: 'AWAIT_EXISTING',
            description: `The dealflow kernel is already asking: ${live.purpose} — ${clip(live.subject, 100)}.`,
            serves: null,
            authority: 'AUTHORIZED',
            boundary: null,
            prepared: null,
            existingWork: { kind: 'CANDIDATE', id: live.candidateId },
          }
        : null;
      return {
        ref: `DEAL:${deal.id}`,
        source: 'DEAL' as const,
        title: clip(`${deal.buyer} ↔ ${deal.supplier} — ${deal.equipmentClass}${deal.destination ? ` into ${deal.destination}` : ''}`, 140),
        sourceRef: deal.id,
        how: deal.nextAction ? `next: ${clip(deal.nextAction, 120)}` : null,
        assessments,
        executionStep: null,
        researchStep,
        economics: [
          {
            label: 'What we would earn',
            value: null,
            kind: 'UNKNOWN' as const,
            basis: deal.ourRevenueNote,
          },
        ],
      };
    });
}

// ---------------------------------------------------------------------------
// Ideas and software requests — every project, including creative and technical.
// ---------------------------------------------------------------------------

async function ideaPaths(context: ObjectiveContext): Promise<CandidatePath[]> {
  // A Cash project's ideas are its own discovery buckets, deep dives and
  // commissions — machinery, not candidate paths — so they are not listed here.
  if (context.revenue) return [];
  const research = await checkAuthority({ projectId: context.projectId, workClass: 'RESEARCH' });
  const capacity = (await readCapability('RESEARCH_A_QUESTION')).state;
  const ideas = await listCandidates({
    projectId: context.projectId,
    states: ['CAPTURED', 'QUEUED', 'PARKED', 'REJECTED', 'PROBING', 'PROMOTED'],
    limit: 60,
  });
  const out: CandidatePath[] = [];
  for (const idea of ideas) {
    const mission = await latestMissionForCandidate(idea.id);
    const assessments: CriterionAssessment[] = [
      assess('DEMAND', 'NOT_APPLICABLE', 'MEASURED', 'This project is not judged by a buyer.', null),
      assess('REACH', 'NOT_APPLICABLE', 'MEASURED', 'There is nobody to reach for this idea.', null),
    ];
    if (idea.state === 'REJECTED') {
      assessments.push(
        assess('PRODUCTION', 'NOT_MET', 'FACT', clip(idea.reason ?? 'Russell rejected this idea against the archive.'), idea.id),
      );
    } else {
      assessments.push(
        capacity === 'PRESENT'
          ? assess('PRODUCTION', 'MET', 'MEASURED', 'A healthy execution surface can run the research.', null)
          : assess('PRODUCTION', capacity === 'MISSING' ? 'NEEDS_PERSON' : 'UNKNOWN', 'MEASURED', 'No healthy execution surface is available to run it.', null),
      );
    }
    assessments.push(assess('DELIVERY', 'NOT_APPLICABLE', 'MEASURED', 'The result is filed into this project.', null));
    assessments.push(assess('COST', 'MET', 'MEASURED', 'Research runs on the fixed subscription fleet; it spends nothing.', null));
    assessments.push(assess('TIME', 'NOT_APPLICABLE', 'MEASURED', 'No window is recorded for this idea.', null));
    assessments.push(
      mission && (mission.state === 'RUNNING' || mission.state === 'PLANNED' || mission.state === 'LAUNCHING')
        ? assess('CAPACITY', 'MET', 'MEASURED', 'Its mission is already running.', mission.id)
        : assess('CAPACITY', capacity === 'PRESENT' ? 'MET' : 'UNKNOWN', 'MEASURED', capacity === 'PRESENT' ? 'Research capacity is present.' : 'Research capacity is not established.', null),
    );
    assessments.push(
      research.ok
        ? assess('AUTHORITY', 'MET', 'DECISION', 'A standing research grant covers it.', research.goal?.id ?? null)
        : assess('AUTHORITY', 'NEEDS_PERSON', 'MEASURED', research.reason, null),
    );
    const running = mission && ['RUNNING', 'PLANNED', 'LAUNCHING', 'WAITING', 'NEEDS_HUMAN'].includes(mission.state);
    out.push({
      ref: `IDEA:${idea.id}`,
      source: 'IDEA',
      title: clip(idea.title, 140),
      sourceRef: idea.id,
      how: idea.priority ? `Russell ranked it ${idea.priority.toLowerCase().replace('_', ' ')}` : null,
      assessments,
      executionStep: running
        ? {
            kind: 'AWAIT_EXISTING',
            description: `Its mission is ${mission!.state.toLowerCase()}; the step is to read what it files.`,
            serves: null,
            authority: mission!.state === 'NEEDS_HUMAN' ? 'NEEDS_PERSON' : 'AUTHORIZED',
            boundary: mission!.state === 'NEEDS_HUMAN' ? 'Its mission is waiting in Needs You.' : null,
            prepared: null,
            existingWork: { kind: 'MISSION', id: mission!.id },
          }
        : {
            kind: 'AWAIT_EXISTING',
            description: `Russell launches "${clip(idea.title, 100)}" as a mission once it is judged, inside the standing grant.`,
            serves: null,
            authority: research.ok ? 'AUTHORIZED' : 'NEEDS_PERSON',
            boundary: research.ok ? null : research.reason,
            prepared: null,
            existingWork: { kind: 'CANDIDATE', id: idea.id },
          },
      researchStep: null,
      economics: [],
    });
  }

  for (const request of await listSoftwareRequests({ projectId: context.projectId })) {
    const declined = request.state === 'DECLINED';
    out.push({
      ref: `SOFTWARE_REQUEST:${request.id}`,
      source: 'SOFTWARE_REQUEST',
      title: clip(request.title, 140),
      sourceRef: request.id,
      how: clip(request.expectedOutcome, 140),
      assessments: [
        assess('DEMAND', 'NOT_APPLICABLE', 'MEASURED', 'A change somebody asked for.', null),
        assess('REACH', 'NOT_APPLICABLE', 'MEASURED', 'Not applicable to a code change.', null),
        declined
          ? assess('PRODUCTION', 'NOT_MET', 'DECISION', `Declined: ${clip(request.declineReason ?? 'a person declined it')}`, request.id)
          : assess('PRODUCTION', 'MET', 'MEASURED', 'The Software Factory builds, reviews and opens a pull request.', null),
        assess('DELIVERY', 'MET', 'MEASURED', 'Delivered as a reviewable pull request.', null),
        assess('COST', 'MET', 'MEASURED', 'Runs on the fixed subscription fleet.', null),
        assess('TIME', 'NOT_APPLICABLE', 'MEASURED', 'No deadline is recorded.', null),
        assess('CAPACITY', 'NOT_APPLICABLE', 'MEASURED', 'Decided by the factory when it runs.', null),
        request.state === 'AUTHORIZED'
          ? assess('AUTHORITY', 'MET', 'DECISION', 'A person authorized it.', request.id)
          : assess('AUTHORITY', 'NEEDS_PERSON', 'MEASURED', 'It is waiting for a person to authorize it in Needs You.', request.id),
      ],
      executionStep: {
        kind: request.state === 'AUTHORIZED' ? 'AWAIT_EXISTING' : 'SOFTWARE_REQUEST',
        description:
          request.state === 'AUTHORIZED'
            ? 'The factory campaign is running; the step is to review its pull request.'
            : `Authorize the software request "${clip(request.title, 100)}".`,
        serves: 'AUTHORITY',
        authority: request.state === 'AUTHORIZED' ? 'AUTHORIZED' : 'NEEDS_PERSON',
        boundary: request.state === 'AUTHORIZED' ? null : 'Authorizing a change to code is a person’s decision, made in Needs You.',
        prepared: null,
        existingWork: { kind: 'SOFTWARE_REQUEST', id: request.id },
      },
      researchStep: null,
      economics: [],
    });
  }
  return out;
}

/** Every candidate path this objective could take, from rows. */
export async function candidatePaths(
  context: ObjectiveContext,
  now: string = new Date().toISOString(),
): Promise<CandidatePath[]> {
  return [
    ...(await cashPaths(context, now)),
    ...(await dealPaths(context)),
    ...(await ideaPaths(context)),
  ];
}

export type { CashOpportunity };
