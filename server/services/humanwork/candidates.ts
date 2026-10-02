/**
 * Step 2: finding and qualifying capacity.
 *
 * A candidate is somebody who *could* do the work and the evidence for
 * believing so. It is never an agreement, and nothing here can make one: the
 * only way to an engaged person is through `engage.ts`, a person's decision on
 * concrete terms, and that person's own acceptance.
 *
 * Three relationships and deliberately no fourth. A team member is a row in
 * `users`; an existing relationship is one a person attests to, with their id
 * on it; a researched possibility came from a gated claim with a source. Brain
 * cannot invent anybody: every one of the three names where it came from, and
 * the schema's CHECKs refuse a row that does not.
 */
import { getUser } from '../../repos/identity.ts';
import { getClaim, getOrchestration } from '../../repos/research.ts';
import {
  addCandidate as insertCandidate,
  engagementsForCandidateIdentity,
  getCandidate,
  getOrder,
  listCosts,
  listDeliverables,
  listReviews,
  recordHumanWorkEvent,
  setAsideCandidate,
} from '../../repos/humanWork.ts';
import { competenceEvidence, rateBasis, stringList, type Checked } from './vocabulary.ts';
import type {
  HumanWorkCandidate,
  HumanWorkEngagement,
  HumanWorkRelationship,
  QuoteSource,
} from '../../domain/types.ts';

export async function addWorkCandidate(input: {
  orderId: string;
  relationship: HumanWorkRelationship;
  displayName?: string | null;
  kind?: 'PERSON' | 'ORGANIZATION';
  userId?: string | null;
  sourceClaimId?: string | null;
  competence?: unknown;
  location?: string | null;
  availability?: string | null;
  quoteCents?: number | null;
  quoteBasis?: string | null;
  quoteCurrency?: string | null;
  quoteSource?: QuoteSource | null;
  uncertainties?: unknown;
  contactChannel?: string | null;
  actorRef: string;
}): Promise<Checked<{ candidate: HumanWorkCandidate; created: boolean }>> {
  const order = await getOrder(input.orderId);
  if (!order) return { ok: false, reason: 'No work order with that id.' };
  if (order.state !== 'OPEN') return { ok: false, reason: 'That work is closed.' };

  let displayName = (input.displayName ?? '').trim();
  let userId: string | null = null;
  let sourceClaimId: string | null = null;
  let attestedBy: string | null = null;
  let contactChannel = (input.contactChannel ?? '').trim() || null;

  if (input.relationship === 'TEAM_MEMBER') {
    const user = input.userId ? await getUser(input.userId) : null;
    if (!user || user.kind !== 'PERSON' || user.disabled) {
      return { ok: false, reason: 'A team member must be an enabled person with an account on this Brain.' };
    }
    userId = user.id;
    displayName = displayName || user.displayName;
    // A team member is reachable inside Brain: an assignment appears on their
    // own page when they sign in. That is the one channel Brain holds.
    contactChannel = contactChannel ?? 'BRAIN_ASSIGNMENTS';
  } else if (input.relationship === 'RESEARCHED') {
    const claim = input.sourceClaimId ? await getClaim(input.sourceClaimId) : null;
    const orchestration = claim ? await getOrchestration(claim.orchestrationId) : null;
    if (!claim || !orchestration || orchestration.projectId !== order.projectId || !claim.sourceUrl) {
      return {
        ok: false,
        reason:
          'A researched possibility must come from a claim this project holds, with a source. ' +
          'Brain does not add people it cannot point to.',
      };
    }
    sourceClaimId = claim.id;
    if (!displayName) return { ok: false, reason: 'Name the person or organization the claim establishes.' };
  } else if (input.relationship === 'EXISTING_RELATIONSHIP') {
    attestedBy = input.actorRef;
    if (!displayName) return { ok: false, reason: 'Name the person or organization you already work with.' };
  } else {
    return { ok: false, reason: 'relationship must be TEAM_MEMBER, EXISTING_RELATIONSHIP or RESEARCHED.' };
  }

  const competence = competenceEvidence(input.competence);
  if (!competence.ok) return competence;
  const uncertainties = stringList(input.uncertainties, 'uncertainties');
  if (!uncertainties.ok) return uncertainties;

  let quoteCents: number | null = null;
  if (input.quoteCents !== undefined && input.quoteCents !== null) {
    if (!Number.isInteger(input.quoteCents) || input.quoteCents < 0) {
      return { ok: false, reason: 'quoteCents must be a whole, non-negative number.' };
    }
    if (!input.quoteSource) return { ok: false, reason: 'Say where the quote came from (quoteSource).' };
    quoteCents = input.quoteCents;
  }
  if (input.quoteSource === 'INTERNAL_NO_CHARGE' && quoteCents !== 0) {
    return { ok: false, reason: 'INTERNAL_NO_CHARGE is a quote of 0; say so.' };
  }

  const result = await insertCandidate({
    projectId: order.projectId,
    orderId: order.id,
    displayName,
    kind: input.kind === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON',
    relationship: input.relationship,
    userId,
    sourceClaimId,
    attestedBy,
    competence: competence.value,
    location: (input.location ?? '').trim() || null,
    availability: (input.availability ?? '').trim() || null,
    quoteCents,
    quoteBasis: rateBasis(input.quoteBasis),
    quoteCurrency: quoteCents === null ? null : (input.quoteCurrency ?? order.currency).toUpperCase(),
    quoteSource: quoteCents === null ? null : (input.quoteSource ?? null),
    uncertainties: uncertainties.value,
    contactChannel,
    createdBy: input.actorRef,
  });
  if (result.created) {
    await recordHumanWorkEvent({
      projectId: order.projectId,
      orderId: order.id,
      kind: 'CANDIDATE_ADDED',
      summary: `${displayName} recorded as a possibility (${input.relationship}); nobody has agreed to anything.`,
      detail: { candidateId: result.candidate.id, relationship: input.relationship },
      actor: 'PERSON',
      actorUserId: input.actorRef,
    });
  }
  return { ok: true, value: result };
}

export async function setAside(input: { candidateId: string; reason: string; actorRef: string }): Promise<Checked<true>> {
  const candidate = await getCandidate(input.candidateId);
  if (!candidate) return { ok: false, reason: 'No candidate with that id.' };
  if (!input.reason.trim()) return { ok: false, reason: 'Say why this candidate is set aside.' };
  if (!(await setAsideCandidate(candidate.id, input.reason.trim()))) {
    return { ok: false, reason: 'That candidate is already set aside.' };
  }
  await recordHumanWorkEvent({
    projectId: candidate.projectId,
    orderId: candidate.orderId,
    kind: 'CANDIDATE_SET_ASIDE',
    summary: `${candidate.displayName} set aside: ${input.reason.trim()}`,
    detail: { candidateId: candidate.id },
    actor: 'PERSON',
    actorUserId: input.actorRef,
  });
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Qualification — derived, never stored
// ---------------------------------------------------------------------------

export interface Reliability {
  /** Engagements with this person or source that reached a decision. */
  engagements: number;
  completed: number;
  /** Completed with no repair requested. */
  firstPass: number;
  /** Completed on or before the last scheduled due date. */
  onTime: number;
  /** Completed engagements whose schedule gave no date, so timeliness is unknown. */
  timelinessUnknown: number;
  declined: number;
  cancelled: number;
  repairRounds: number;
  paidCents: number;
  sentence: string;
}

export interface Qualification {
  candidateId: string;
  /** Evidence a reader can check — never a candidate's own claim. */
  evidenced: number;
  claimedOnly: number;
  availabilityKnown: boolean;
  quoteKnown: boolean;
  reachable: boolean;
  uncertainties: string[];
  reliability: Reliability;
  /** One sentence, the server's, on what is and is not established. */
  summary: string;
}

async function reliabilityOf(candidate: HumanWorkCandidate, excludeOrderId: string): Promise<Reliability> {
  const all = (
    await engagementsForCandidateIdentity({
      userId: candidate.userId,
      sourceClaimId: candidate.sourceClaimId,
      displayName: candidate.displayName,
    })
  ).filter((one) => one.orderId !== excludeOrderId);
  let completed = 0;
  let firstPass = 0;
  let onTime = 0;
  let timelinessUnknown = 0;
  let declined = 0;
  let cancelled = 0;
  let repairRounds = 0;
  let paidCents = 0;
  for (const engagement of all) {
    if (engagement.state === 'DECLINED_BY_WORKER') declined += 1;
    if (engagement.state === 'CANCELLED') cancelled += 1;
    for (const cost of await listCosts(engagement.id)) if (cost.kind === 'PAID') paidCents += cost.amountCents;
    if (engagement.state !== 'COMPLETED') continue;
    completed += 1;
    const deliverables = await listDeliverables(engagement.id);
    const reviews = await listReviews(engagement.id);
    const repairs = reviews.filter((review) => review.verdict === 'NOT_MET').length;
    repairRounds += Math.max(0, deliverables.length - 1);
    if (repairs === 0 && deliverables.length <= 1) firstPass += 1;
    const lastDue = latestDue(engagement);
    if (!lastDue || !engagement.completedAt) timelinessUnknown += 1;
    else if (engagement.completedAt <= endOfDay(lastDue)) onTime += 1;
  }
  const decided = all.filter((one) => !['PROPOSED', 'APPROVED'].includes(one.state)).length;
  const sentence =
    completed === 0
      ? decided === 0
        ? 'No earlier work with this person is on record, so nothing is known about their reliability here.'
        : `${decided} earlier engagement(s) on record and none completed.`
      : `${completed} completed engagement(s): ${firstPass} accepted first time, ${onTime} on time` +
        (timelinessUnknown ? `, ${timelinessUnknown} with no due date to judge against` : '') +
        (declined ? `; declined ${declined}` : '') +
        (cancelled ? `; ${cancelled} cancelled` : '') +
        '.';
  return {
    engagements: decided,
    completed,
    firstPass,
    onTime,
    timelinessUnknown,
    declined,
    cancelled,
    repairRounds,
    paidCents,
    sentence,
  };
}

function latestDue(engagement: HumanWorkEngagement): string | null {
  const dates = (engagement.terms.schedule ?? []).map((item) => item.due).filter((due): due is string => Boolean(due));
  return dates.sort().at(-1) ?? null;
}

function endOfDay(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.999Z` : date;
}

export async function qualify(candidate: HumanWorkCandidate): Promise<Qualification> {
  const evidenced = candidate.competence.filter((item) => item.basis !== 'CLAIMED_BY_CANDIDATE').length;
  const claimedOnly = candidate.competence.length - evidenced;
  const reliability = await reliabilityOf(candidate, candidate.orderId);
  const gaps: string[] = [];
  if (evidenced === 0) gaps.push('nothing checkable shows they can do this work');
  if (!candidate.availability) gaps.push('availability is unknown');
  if (candidate.quoteCents === null) gaps.push('no quote or rate is on record');
  if (!candidate.contactChannel) gaps.push('Brain has no way to reach them');
  const summary =
    gaps.length === 0
      ? `${candidate.displayName}: competence evidenced ${evidenced} way(s), availability and terms on record.`
      : `${candidate.displayName}: ${gaps.join('; ')}.`;
  return {
    candidateId: candidate.id,
    evidenced,
    claimedOnly,
    availabilityKnown: Boolean(candidate.availability),
    quoteKnown: candidate.quoteCents !== null,
    reachable: Boolean(candidate.contactChannel),
    uncertainties: candidate.uncertainties,
    reliability,
    summary,
  };
}
